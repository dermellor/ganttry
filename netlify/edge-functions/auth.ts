// Netlify Edge Function — Google OAuth gate.
//
// Mirrors the sales-cockpit pattern: only addresses on the configured email
// domains (default Acme.de, Acme.com) get past the gate. Sessions are
// signed JWT-style cookies (HMAC-SHA256), no external auth service required.
//
// Required runtime env vars (set in Netlify dashboard):
//   AUTH_REQUIRED          — "true" to enable the gate (any other value = pass through)
//   GOOGLE_CLIENT_ID       — OAuth client (web application type)
//   GOOGLE_CLIENT_SECRET   — OAuth client secret
//   AUTH_SECRET            — random 32+ byte string, used to sign cookies
//   ALLOWED_EMAIL_DOMAINS  — comma-separated, default "Acme.de,Acme.com"

import type { Context, Config } from '@netlify/edge-functions';

const COOKIE_NAME = 'tl_session';
const STATE_COOKIE = 'tl_oauth_state';
const SESSION_MAX_AGE = 24 * 60 * 60; // 24h
const STATE_MAX_AGE = 10 * 60; // 10m

type SessionPayload = {
  email: string;
  sub: string;
  name?: string;
  exp: number;
};

type StatePayload = {
  state: string;
  redirect: string;
  exp: number;
};

export default async function handler(req: Request, _ctx: Context): Promise<Response | void> {
  if (Deno.env.get('AUTH_REQUIRED') !== 'true') {
    return; // gate disabled — pass through
  }

  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/auth/login') return handleLogin(url);
  if (path === '/auth/callback') return handleCallback(req, url);
  if (path === '/auth/logout') return handleLogout(url);
  if (path === '/auth/error') return errorPage(url.searchParams.get('reason') ?? 'unknown');

  const session = await readSession(req);
  if (!session) {
    const target = `${url.pathname}${url.search}`;
    const loginUrl = new URL('/auth/login', url.origin);
    loginUrl.searchParams.set('redirect', target);
    return Response.redirect(loginUrl.toString(), 302);
  }
  return; // pass through to the static asset / function
}

export const config: Config = {
  path: '/*',
  excludedPath: ['/favicon.ico', '/robots.txt'],
};

// ---------- OAuth flow ----------

async function handleLogin(url: URL): Promise<Response> {
  const clientId = mustEnv('GOOGLE_CLIENT_ID');
  const redirectParam = url.searchParams.get('redirect');
  const safeRedirect =
    redirectParam && redirectParam.startsWith('/') && !redirectParam.startsWith('//')
      ? redirectParam
      : '/';

  const state = crypto.randomUUID();
  const stateCookieValue = await sign({
    state,
    redirect: safeRedirect,
    exp: nowSec() + STATE_MAX_AGE,
  } satisfies StatePayload);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    hd: firstAllowedDomain(),
    access_type: 'online',
  });

  const headers = new Headers({
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  });
  headers.append(
    'Set-Cookie',
    cookieString(STATE_COOKIE, stateCookieValue, STATE_MAX_AGE),
  );
  return new Response(null, { status: 302, headers });
}

async function handleCallback(req: Request, url: URL): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errParam = url.searchParams.get('error');
  if (errParam) return redirectToError(url, errParam);
  if (!code || !state) return redirectToError(url, 'missing_code_or_state');

  const cookies = parseCookies(req.headers.get('cookie'));
  const stateCookie = cookies[STATE_COOKIE];
  if (!stateCookie) return redirectToError(url, 'state_cookie_missing');
  const statePayload = (await verify(stateCookie)) as StatePayload | null;
  if (!statePayload || statePayload.state !== state || statePayload.exp < nowSec()) {
    return redirectToError(url, 'state_mismatch');
  }

  const clientId = mustEnv('GOOGLE_CLIENT_ID');
  const clientSecret = mustEnv('GOOGLE_CLIENT_SECRET');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    return redirectToError(url, `token_exchange_failed_${tokenRes.status}`);
  }
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) return redirectToError(url, 'no_access_token');

  const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) return redirectToError(url, `userinfo_failed_${userRes.status}`);
  const user = (await userRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    hd?: string;
  };

  const email = (user.email ?? '').toLowerCase();
  if (!email || !user.email_verified) {
    return redirectToError(url, 'email_unverified');
  }
  if (!isAllowedDomain(email)) {
    return redirectToError(url, 'domain_not_allowed');
  }

  const session = await sign({
    email,
    sub: user.sub ?? email,
    name: user.name,
    exp: nowSec() + SESSION_MAX_AGE,
  } satisfies SessionPayload);

  const headers = new Headers({
    Location: `${url.origin}${statePayload.redirect}`,
  });
  headers.append('Set-Cookie', cookieString(COOKIE_NAME, session, SESSION_MAX_AGE));
  headers.append('Set-Cookie', cookieString(STATE_COOKIE, '', 0));
  return new Response(null, { status: 302, headers });
}

function handleLogout(url: URL): Response {
  const headers = new Headers({ Location: `${url.origin}/auth/login` });
  headers.append('Set-Cookie', cookieString(COOKIE_NAME, '', 0));
  return new Response(null, { status: 302, headers });
}

function errorPage(reason: string): Response {
  const allowed = allowedDomains().map((d) => `@${d}`).join(' or ');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Login failed</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  code { background: #f3f3f3; padding: 0.1em 0.4em; border-radius: 4px; }
  a.btn { display: inline-block; margin-top: 1rem; background: #1a1a1a; color: #fff; padding: 0.6rem 1.1rem; border-radius: 6px; text-decoration: none; }
</style>
</head><body>
<h1>Login failed</h1>
<p>This timeline is restricted to ${escapeHtml(allowed)} addresses.</p>
<p>Reason: <code>${escapeHtml(reason)}</code></p>
<a class="btn" href="/auth/login">Try again</a>
</body></html>`;
  return new Response(html, {
    status: 403,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function redirectToError(url: URL, reason: string): Response {
  const target = new URL('/auth/error', url.origin);
  target.searchParams.set('reason', reason);
  const headers = new Headers({ Location: target.toString() });
  headers.append('Set-Cookie', cookieString(STATE_COOKIE, '', 0));
  return new Response(null, { status: 302, headers });
}

// ---------- session helpers ----------

async function readSession(req: Request): Promise<SessionPayload | null> {
  const cookies = parseCookies(req.headers.get('cookie'));
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const payload = (await verify(raw)) as SessionPayload | null;
  if (!payload) return null;
  if (!payload.email || !isAllowedDomain(payload.email)) return null;
  if (payload.exp < nowSec()) return null;
  return payload;
}

// ---------- crypto / encoding ----------

let cachedKey: Promise<CryptoKey> | null = null;
function getKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    const secret = mustEnv('AUTH_SECRET');
    cachedKey = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
  }
  return cachedKey;
}

async function sign(payload: object): Promise<string> {
  const json = JSON.stringify(payload);
  const data = new TextEncoder().encode(json);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await getKey(), data));
  return `${b64urlEncode(data)}.${b64urlEncode(sig)}`;
}

async function verify(token: string): Promise<unknown | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const payload = b64urlDecode(payloadB64);
  const sig = b64urlDecode(sigB64);
  if (!payload || !sig) return null;
  const ok = await crypto.subtle.verify('HMAC', await getKey(), sig, payload);
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
}

function b64urlEncode(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ---------- misc ----------

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function cookieString(name: string, value: string, maxAge: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  return parts.join('; ');
}

function allowedDomains(): string[] {
  const raw = Deno.env.get('ALLOWED_EMAIL_DOMAINS') ?? 'Acme.de,Acme.com';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function firstAllowedDomain(): string {
  return allowedDomains()[0] ?? 'Acme.de';
}

function isAllowedDomain(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains().includes(domain);
}

function mustEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
