// Netlify Edge Function — Google OAuth gate.
//
// Mirrors the sales-cockpit pattern: only addresses on the configured email
// domains (default Acme.de, Acme.com) get past the gate. Sessions are
// signed JWT-style cookies (HMAC-SHA256), no external auth service required.
//
// When SHEETS_ENABLED=true (Netlify env), the OAuth flow also requests the
// Google Sheets scope and stores the user's access/refresh tokens in the
// session cookie, enabling per-user read/write to configured sheets.
//
// Required runtime env vars (set in Netlify dashboard):
//   AUTH_REQUIRED          — "true" to enable the gate (any other value = pass through)
//   GOOGLE_CLIENT_ID       — OAuth client (web application type)
//   GOOGLE_CLIENT_SECRET   — OAuth client secret
//   AUTH_SECRET            — random 32+ byte string, used to sign cookies
//   ALLOWED_EMAIL_DOMAINS  — comma-separated, default "Acme.de,Acme.com"
//
// Optional:
//   SHEETS_ENABLED         — "true" to include Sheets scope in OAuth

import type { Context, Config } from '@netlify/edge-functions';
import {
  COOKIE_NAME,
  STATE_COOKIE,
  SESSION_MAX_AGE,
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

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function sheetsEnabled(): boolean {
  return Deno.env.get('SHEETS_ENABLED') === 'true';
}

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

  // Headless MCP client: a valid X-MCP-Token passes the gate without a Google
  // login. Downstream functions (sheets-api) use the service identity for data.
  if (hasValidMcpToken(req)) return;

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

  const scopes = ['openid', 'email', 'profile'];
  if (sheetsEnabled()) scopes.push(SHEETS_SCOPE);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    prompt: sheetsEnabled() ? 'consent' : 'select_account',
    hd: firstAllowedDomain(),
    access_type: sheetsEnabled() ? 'offline' : 'online',
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
  if (!isAllowedDomain(email)) {
    return redirectToError(url, 'domain_not_allowed');
  }

  const sessionPayload: SessionPayload = {
    email,
    sub: user.sub ?? email,
    name: user.name,
    exp: nowSec() + SESSION_MAX_AGE,
  };

  if (sheetsEnabled() && tokens.access_token) {
    sessionPayload.google_access_token = tokens.access_token;
    if (tokens.refresh_token) {
      sessionPayload.google_refresh_token = tokens.refresh_token;
    }
    if (tokens.expires_in) {
      sessionPayload.google_token_expiry = nowSec() + tokens.expires_in;
    }
  }

  const session = await sign(sessionPayload);

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
