export const COOKIE_NAME = 'tl_session';
export const STATE_COOKIE = 'tl_oauth_state';
export const SESSION_MAX_AGE = 24 * 60 * 60; // 24h
export const STATE_MAX_AGE = 10 * 60; // 10m

export type SessionPayload = {
  email: string;
  sub: string;
  name?: string;
  exp: number;
  // Google tokens for Sheets API (added when SHEETS_ENABLED)
  google_access_token?: string;
  google_refresh_token?: string;
  google_token_expiry?: number; // epoch seconds
};

export type StatePayload = {
  state: string;
  redirect: string;
  exp: number;
};

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

export async function sign(payload: object): Promise<string> {
  const json = JSON.stringify(payload);
  const data = new TextEncoder().encode(json);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await getKey(), data));
  return `${b64urlEncode(data)}.${b64urlEncode(sig)}`;
}

export async function verify(token: string): Promise<unknown | null> {
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

// ---------- cookies ----------

export function parseCookies(header: string | null): Record<string, string> {
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

export function cookieString(name: string, value: string, maxAge: number): string {
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

// ---------- session read ----------

export async function readSession(req: Request): Promise<SessionPayload | null> {
  const cookies = parseCookies(req.headers.get('cookie'));
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const payload = (await verify(raw)) as SessionPayload | null;
  if (!payload) return null;
  if (!payload.email || !isAllowedDomain(payload.email)) return null;
  if (payload.exp < nowSec()) return null;
  return payload;
}

// ---------- domain checks ----------

export function allowedDomains(): string[] {
  const raw = Deno.env.get('ALLOWED_EMAIL_DOMAINS') ?? 'Acme.de,Acme.com';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function firstAllowedDomain(): string {
  return allowedDomains()[0] ?? 'Acme.de';
}

export function isAllowedDomain(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains().includes(domain);
}

// ---------- misc ----------

export function mustEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

// ---------- Google token refresh ----------

export async function refreshGoogleToken(
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number } | null> {
  const clientId = mustEnv('GOOGLE_CLIENT_ID');
  const clientSecret = mustEnv('GOOGLE_CLIENT_SECRET');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function getValidAccessToken(
  session: SessionPayload,
): Promise<{
  accessToken: string;
  updatedSession: SessionPayload | null;
}> {
  if (!session.google_access_token || !session.google_refresh_token) {
    throw new Error('Session has no Google tokens — re-login required');
  }

  const buffer = 60; // refresh 60s before expiry
  if (session.google_token_expiry && session.google_token_expiry > nowSec() + buffer) {
    return { accessToken: session.google_access_token, updatedSession: null };
  }

  const result = await refreshGoogleToken(session.google_refresh_token);
  if (!result) {
    throw new Error('Google token refresh failed — re-login required');
  }

  const updatedSession: SessionPayload = {
    ...session,
    google_access_token: result.access_token,
    google_token_expiry: nowSec() + result.expires_in,
  };
  return { accessToken: result.access_token, updatedSession };
}
