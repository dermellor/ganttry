// Netlify Edge Function — Google OAuth gate.
//
// Google proves the address; what decides whether it may in depends on one
// switch (see `admit`):
//   - TIMELINES_ACCESS_CONTROL off — the ALLOWED_EMAIL_DOMAINS list decides, the
//     original behaviour. Empty means nobody, which is fail-closed on purpose.
//   - on — the member list decides and the domain is not consulted, because an
//     invited person may sit on any domain.
//
// Sessions are signed JWT-style cookies (HMAC-SHA256), no external auth service.
//
// Required runtime env vars (set in Netlify dashboard):
//   AUTH_REQUIRED            — "true" to enable the gate (any other value = pass through)
//   GOOGLE_CLIENT_ID         — OAuth client (web application type)
//   GOOGLE_CLIENT_SECRET     — OAuth client secret
//   AUTH_SECRET              — random 32+ byte string, used to sign cookies
//   ALLOWED_EMAIL_DOMAINS    — allowed sign-in domains while access control is off
//   TIMELINES_ACCESS_CONTROL — "true" to let the member list decide instead
//   TIMELINES_BOOTSTRAP_ADMIN — the address that becomes the first admin

import type { Context, Config } from '@netlify/edge-functions';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.110.0';
import { accessControlEnabled, decideSignIn, needsBootstrapPromotion } from '../../src/access.ts';
import {
  getMember,
  inviteMember,
  setMemberStatus,
  touchUser,
} from '../../scripts/db/timeline-repo-supabase.ts';
import {
  COOKIE_NAME,
  STATE_COOKIE,
  SESSION_MAX_AGE,
  SESSION_RENEW_THRESHOLD,
  STATE_MAX_AGE,
  type SessionPayload,
  type StatePayload,
  sign,
  verify,
  parseCookies,
  cookieString,
  readSession,
  firstAllowedDomain,
  isAllowedDomain,
  allowedDomains,
  mustEnv,
  nowSec,
  escapeHtml,
  hasValidMcpToken,
} from './_shared/session.ts';

/**
 * The member list's client, built once per isolate and only when it is needed.
 *
 * Only `admit()` touches the database, and only on the callback, so the ordinary
 * request path never constructs this. Null when the instance has no Supabase
 * configured, which `admit` turns into a refusal rather than a pass.
 */
let dbHandle: SupabaseClient | null | undefined;
function memberDb(): SupabaseClient | null {
  if (dbHandle !== undefined) return dbHandle;
  const url = Deno.env.get('TIMELINES_SUPABASE_URL');
  const key = Deno.env.get('TIMELINES_SUPABASE_SERVICE_KEY');
  dbHandle = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return dbHandle;
}

export default async function handler(req: Request, ctx: Context): Promise<Response | void> {
  if (Deno.env.get('AUTH_REQUIRED') !== 'true') {
    return; // gate disabled — pass through
  }

  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/auth/login') return handleLogin(url);
  if (path === '/auth/callback') return handleCallback(req, url);
  if (path === '/auth/logout') return handleLogout(url);
  if (path === '/auth/error') return errorPage(url.searchParams.get('reason') ?? 'unknown');

  // Headless MCP client: a valid X-MCP-Token passes the gate without a Google
  // login. Downstream functions (timelines-api) use the service identity for data.
  if (hasValidMcpToken(req)) return;

  const session = await readSession(req);
  if (!session) {
    // A fetch() from the loaded SPA (an /api/* call) can't follow a 302 to
    // Google's login across origins — the redirect just produces a diffuse
    // failure and the edit silently vanishes. Answer those with a machine-
    // readable 401 so the client can surface "session expired" and send the
    // top window to the login. Full-page navigations still get the redirect.
    if (isApiPath(path)) {
      return new Response(JSON.stringify({ error: 'session_expired' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          // Let the client find the login without hardcoding the path.
          'WWW-Authenticate': 'Session',
        },
      });
    }
    const target = `${url.pathname}${url.search}`;
    const loginUrl = new URL('/auth/login', url.origin);
    loginUrl.searchParams.set('redirect', target);
    return Response.redirect(loginUrl.toString(), 302);
  }

  // Sliding renewal: once the session is in the second half of its life,
  // re-issue the cookie with a fresh expiry on the way out. An actively used
  // session is therefore continually topped up and never expires from under
  // the user. Off the hot path — most requests skip straight to pass-through.
  if (session.exp - nowSec() < SESSION_RENEW_THRESHOLD) {
    const res = await ctx.next();
    const renewed = await sign({
      ...session,
      exp: nowSec() + SESSION_MAX_AGE,
    } satisfies SessionPayload);
    res.headers.append('Set-Cookie', cookieString(COOKIE_NAME, renewed, SESSION_MAX_AGE));
    return res;
  }

  return; // pass through to the static asset / function
}

/** Paths the SPA calls via fetch() — must fail loud (401), never redirect. */
function isApiPath(path: string): boolean {
  return path.startsWith('/api/');
}

export const config: Config = {
  path: '/*',
  // /mcp and the MCP-OAuth endpoints carry their own auth — keep the Google
  // session gate off them so the remote MCP client isn't redirected.
  excludedPath: [
    '/favicon.ico',
    '/robots.txt',
    // Retired, and still excluded so a stale consumer gets the 410 that names
    // its successor rather than a login redirect it cannot follow.
    '/api/pricing/*',
    // The generic public read. ONE exclusion for every plugin that ever publishes,
    // rather than a line per plugin: the alternative is an auth-gate edit as part
    // of installing a plugin, which is an edit nobody remembers to reverse on
    // uninstall. What may actually be served is decided per plugin and per
    // timeline behind this path (docs/plugin-public-read.md).
    '/api/public/*',
    '/mcp',
    '/mcp-oauth/*',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
  ],
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
    access_type: 'online',
  });
  // Domain hint only while the domain is what decides. With the member list in
  // charge, `hd` would hide exactly the accounts an invitation was sent to: it
  // restricts Google's account chooser, so an invited person outside the
  // configured domain could not even offer their address.
  const hint = accessControlEnabled(Deno.env.get('TIMELINES_ACCESS_CONTROL')) ? '' : firstAllowedDomain();
  if (hint) params.set('hd', hint);

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
  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
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

  const admitted = await admit(email, user.name ?? null);
  if (!admitted.allow) return redirectToError(url, admitted.reason);

  const sessionPayload: SessionPayload = {
    email,
    sub: user.sub ?? email,
    name: user.name,
    exp: nowSec() + SESSION_MAX_AGE,
  };

  const session = await sign(sessionPayload);

  const headers = new Headers({
    Location: `${url.origin}${statePayload.redirect}`,
  });
  headers.append('Set-Cookie', cookieString(COOKIE_NAME, session, SESSION_MAX_AGE));
  headers.append('Set-Cookie', cookieString(STATE_COOKIE, '', 0));
  return new Response(null, { status: 302, headers });
}

/**
 * May this proven address in, and record it if this is an acceptance.
 *
 * Two regimes, chosen by the same switch the API layer uses:
 *
 * - **Off** — the domain allow-list decides, exactly as before the member list
 *   existed. Shipping the membership check unconditionally would refuse every
 *   user of every existing instance the moment this deploys, because none of
 *   them has a populated member list yet.
 * - **On** — the member list decides, and the domain is no longer consulted.
 *   An invited person may sit on any domain; that is what inviting them means.
 *
 * The lookup happens here and nowhere else on the request path: this is the one
 * moment a session is minted, so page loads keep costing a signature check.
 */
async function admit(
  email: string,
  name: string | null,
): Promise<{ allow: true } | { allow: false; reason: string }> {
  if (!accessControlEnabled(Deno.env.get('TIMELINES_ACCESS_CONTROL'))) {
    return isAllowedDomain(email) ? { allow: true } : { allow: false, reason: 'domain_not_allowed' };
  }

  const db = memberDb();
  if (!db) {
    // The switch is on and there is nothing to ask. Refusing is the only honest
    // answer: letting everybody in would make the switch a lie, and it is the
    // operator's own misconfiguration rather than the visitor's problem.
    return { allow: false, reason: 'membership_unavailable' };
  }

  let member = await getMember(db, email);

  // The bootstrap address is how an instance gets its first admin. Without it a
  // fresh member list has nobody who can invite, and the instance is closed to
  // everyone including its owner.
  // The master key holds whatever state its row is in, including „already an
  // editor" — see `needsBootstrapPromotion` for why „create if missing" would
  // have locked every existing instance out of its own administration.
  if (needsBootstrapPromotion(member, email, Deno.env.get('TIMELINES_BOOTSTRAP_ADMIN'))) {
    await inviteMember(db, { email, role: 'admin' });
    await setMemberStatus(db, email, 'active');
    member = await getMember(db, email);
  }

  const verdict = decideSignIn(member, Date.now());
  if (!verdict.allow) return { allow: false, reason: verdict.reason };

  // Accepting is the first successful sign-in, so it is recorded here rather
  // than by opening the invitation link — somebody who was invited gets in with
  // their address whether or not they ever clicked it.
  if (verdict.accept) await setMemberStatus(db, email, 'active');
  // Keep the display name fresh while we have it; `touchUser` never clears one.
  if (name) await touchUser(db, email, name);
  return { allow: true };
}

function handleLogout(url: URL): Response {
  const headers = new Headers({ Location: `${url.origin}/auth/login` });
  headers.append('Set-Cookie', cookieString(COOKIE_NAME, '', 0));
  return new Response(null, { status: 302, headers });
}

/**
 * One sentence per refusal, because „Reason: not_a_member" tells a visitor
 * nothing about what to do next, and the whole point of a closed instance is
 * that somebody has to let them in.
 */
const REFUSAL_TEXT: Record<string, string> = {
  not_a_member: 'This address has not been invited to this instance. Ask an administrator for an invitation.',
  membership_suspended: 'This membership is suspended. Ask an administrator to restore it.',
  membership_removed: 'This membership was removed. Ask an administrator for a new invitation.',
  invitation_expired: 'This invitation has expired. Ask an administrator to send a new one.',
  membership_unavailable: 'The member list is unreachable, so nobody can be let in right now. This is a server configuration problem.',
};

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
<p>${escapeHtml(REFUSAL_TEXT[reason] ?? (allowed ? `This timeline is restricted to ${allowed} addresses.` : 'This timeline is not open to this address.'))}</p>
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
