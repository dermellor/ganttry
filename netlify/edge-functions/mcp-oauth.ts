// MCP OAuth 2.1 authorization server for the remote MCP (/mcp), federating
// identity to Google (Acme domain). Lets Claude Code authenticate each
// colleague individually via browser login — no shared token.
//
// Flow (per the MCP Authorization spec):
//   /mcp 401 → WWW-Authenticate points here
//   GET /.well-known/oauth-protected-resource   → resource + authorization_servers
//   GET /.well-known/oauth-authorization-server  → endpoint metadata
//   POST /mcp-oauth/register                     → dynamic client registration (PKCE, public)
//   GET  /mcp-oauth/authorize                    → validate + redirect to Google (hd=Acme.de)
//   GET  /mcp-oauth/google-callback              → verify Google identity → our auth code
//   POST /mcp-oauth/token                        → verify PKCE → issue access token (opaque, HMAC-signed)
//
// Tokens (client_id, state, auth code, access token) are stateless HMAC-signed
// blobs (scripts share the AUTH_SECRET). The /mcp Function verifies the access
// token with the same secret (node:crypto). Google needs the redirect URI
// `${origin}/mcp-oauth/google-callback` whitelisted in the Cloud Console.

import type { Context, Config } from '@netlify/edge-functions';
import { sign, verify, nowSec, mustEnv, isAllowedDomain, firstAllowedDomain } from './_shared/session.ts';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

const CODE_TTL = 300; // auth code: 5 min
const ACCESS_TTL = 12 * 3600; // access token: 12 h
const REFRESH_TTL = 30 * 24 * 3600; // refresh token: 30 d (slides with use)

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function htmlError(msg: string): Response {
  return new Response(`<!doctype html><meta charset=utf-8><h1>Login fehlgeschlagen</h1><p>${msg}</p>`, {
    status: 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function sha256b64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default async function handler(req: Request, _ctx: Context): Promise<Response | void> {
  const url = new URL(req.url);
  const origin = url.origin;
  const path = url.pathname;

  // ---- discovery metadata -------------------------------------------------
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
    return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
  }
  if (path === '/.well-known/oauth-authorization-server') {
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/mcp-oauth/authorize`,
      token_endpoint: `${origin}/mcp-oauth/token`,
      registration_endpoint: `${origin}/mcp-oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['openid', 'email', 'profile'],
    });
  }

  // ---- dynamic client registration (RFC 7591, public client) --------------
  if (path === '/mcp-oauth/register' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { redirect_uris?: unknown; client_name?: unknown };
    const redirect_uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
    if (redirect_uris.length === 0) return json({ error: 'invalid_client_metadata' }, 400);
    const client_id = await sign({ typ: 'client', redirect_uris, iat: nowSec() });
    return json(
      {
        client_id,
        redirect_uris,
        token_endpoint_auth_method: 'none',
        // Must include 'refresh_token' — a spec-compliant client reads the
        // per-client grant_types and won't attempt silent refresh unless it's
        // listed here, forcing a full re-login every ACCESS_TTL (12 h).
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    );
  }

  // ---- authorization endpoint --------------------------------------------
  if (path === '/mcp-oauth/authorize' && req.method === 'GET') {
    const q = url.searchParams;
    const client = (await verify(q.get('client_id') ?? '')) as { typ?: string; redirect_uris?: string[] } | null;
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!client || client.typ !== 'client' || !client.redirect_uris?.includes(redirectUri)) {
      return htmlError('Ungültige client_id oder redirect_uri.');
    }
    const codeChallenge = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256' || !codeChallenge) {
      return htmlError('PKCE (S256) erforderlich.');
    }
    const state = await sign({
      typ: 'state',
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      client_state: q.get('state') ?? '',
      resource: q.get('resource') ?? '',
      iat: nowSec(),
    });
    const g = new URL(GOOGLE_AUTH);
    g.searchParams.set('client_id', mustEnv('GOOGLE_CLIENT_ID'));
    g.searchParams.set('redirect_uri', `${origin}/mcp-oauth/google-callback`);
    g.searchParams.set('response_type', 'code');
    g.searchParams.set('scope', 'openid email profile');
    g.searchParams.set('hd', firstAllowedDomain());
    g.searchParams.set('prompt', 'select_account');
    g.searchParams.set('state', state);
    return Response.redirect(g.toString(), 302);
  }

  // ---- Google callback → our auth code -----------------------------------
  if (path === '/mcp-oauth/google-callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const st = (await verify(url.searchParams.get('state') ?? '')) as
      | { typ?: string; redirect_uri: string; code_challenge: string; client_state: string; resource: string }
      | null;
    if (!code || !st || st.typ !== 'state') return htmlError('Ungültiger Auth-Status.');

    const tokenRes = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: mustEnv('GOOGLE_CLIENT_ID'),
        client_secret: mustEnv('GOOGLE_CLIENT_SECRET'),
        code,
        redirect_uri: `${origin}/mcp-oauth/google-callback`,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) return htmlError('Google-Token-Austausch fehlgeschlagen.');
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) return htmlError('Kein Google-Access-Token.');

    const uiRes = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!uiRes.ok) return htmlError('Google-Userinfo fehlgeschlagen.');
    const { email } = (await uiRes.json()) as { email?: string };
    if (!email || !isAllowedDomain(email)) {
      return htmlError('Diese E-Mail-Domain ist nicht freigegeben.');
    }

    const authCode = await sign({
      typ: 'code',
      email,
      redirect_uri: st.redirect_uri,
      code_challenge: st.code_challenge,
      resource: st.resource,
      iat: nowSec(),
    });
    const back = new URL(st.redirect_uri);
    back.searchParams.set('code', authCode);
    if (st.client_state) back.searchParams.set('state', st.client_state);
    return Response.redirect(back.toString(), 302);
  }

  // ---- token endpoint -----------------------------------------------------
  if (path === '/mcp-oauth/token' && req.method === 'POST') {
    const form = new URLSearchParams(await req.text());
    const grant = form.get('grant_type');

    // Silent renewal: exchange a refresh token for a fresh access token. The
    // refresh token is re-issued (sliding 30-day window), so an actively-used
    // login never expires.
    if (grant === 'refresh_token') {
      const rt = (await verify(form.get('refresh_token') ?? '')) as
        | { typ?: string; email: string; resource?: string; iat: number }
        | null;
      if (!rt || rt.typ !== 'refresh') return json({ error: 'invalid_grant' }, 400);
      if (nowSec() - rt.iat > REFRESH_TTL) {
        return json({ error: 'invalid_grant', error_description: 'refresh token expired' }, 400);
      }
      const access_token = await sign({ typ: 'access', email: rt.email, resource: rt.resource, iat: nowSec() });
      const refresh_token = await sign({ typ: 'refresh', email: rt.email, resource: rt.resource, iat: nowSec() });
      return json({ access_token, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token });
    }

    if (grant !== 'authorization_code') return json({ error: 'unsupported_grant_type' }, 400);
    const c = (await verify(form.get('code') ?? '')) as
      | { typ?: string; email: string; redirect_uri: string; code_challenge: string; resource: string; iat: number }
      | null;
    if (!c || c.typ !== 'code') return json({ error: 'invalid_grant' }, 400);
    if (nowSec() - c.iat > CODE_TTL) return json({ error: 'invalid_grant', error_description: 'code expired' }, 400);
    if (c.redirect_uri !== (form.get('redirect_uri') ?? '')) {
      return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
    }
    const verifier = form.get('code_verifier') ?? '';
    if (!verifier || (await sha256b64url(verifier)) !== c.code_challenge) {
      return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
    }
    const access_token = await sign({ typ: 'access', email: c.email, resource: c.resource, iat: nowSec() });
    const refresh_token = await sign({ typ: 'refresh', email: c.email, resource: c.resource, iat: nowSec() });
    return json({ access_token, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token });
  }

  return; // not our route
}

export const config: Config = {
  path: [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/mcp-oauth/register',
    '/mcp-oauth/authorize',
    '/mcp-oauth/google-callback',
    '/mcp-oauth/token',
  ],
};
