import { accessControlEnabled } from '../../../src/access.ts';

export const COOKIE_NAME = 'tl_session';
export const STATE_COOKIE = 'tl_oauth_state';
// Base session lifetime. The session is not a fixed one-shot token: the auth
// gate re-issues the cookie with a fresh expiry once a request lands in the
// second half of this window (see auth.ts → sliding renewal), so an actively
// used session effectively never expires. The 30-day base only bites after a
// genuine stretch of inactivity.
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30d
// Renew the cookie once less than this much life remains (half the lifetime) —
// keeps re-signing off the hot path while guaranteeing an active user is always
// topped up well before expiry.
export const SESSION_RENEW_THRESHOLD = SESSION_MAX_AGE / 2;
export const STATE_MAX_AGE = 10 * 60; // 10m

export type SessionPayload = {
  email: string;
  sub: string;
  name?: string;
  exp: number;
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
  if (!payload.email) return null;
  // The domain is only an access rule while membership is not.
  //
  // With TIMELINES_ACCESS_CONTROL on, an invited person may sit on any domain —
  // that is the point of inviting them — so testing the list here would refuse
  // exactly the people the invitation was for. It stays in force while the
  // switch is off, because then it is the ONLY thing standing between a signed
  // cookie and the data.
  //
  // Read the order carefully before changing it: emptying ALLOWED_EMAIL_DOMAINS
  // while this still tested it would invalidate every session at once.
  if (!accessControlEnabled(Deno.env.get('TIMELINES_ACCESS_CONTROL')) && !isAllowedDomain(payload.email)) {
    return null;
  }
  if (payload.exp < nowSec()) return null;
  return payload;
}

// ---------- domain checks ----------

// Allowed sign-in domains come from ALLOWED_EMAIL_DOMAINS (comma-separated). The
// code default is empty — fail-closed: with AUTH_REQUIRED=true and no domains
// configured, nobody passes the gate. Set the env var to your own domain(s).
export function allowedDomains(): string[] {
  const raw = Deno.env.get('ALLOWED_EMAIL_DOMAINS') ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// First allowed domain — used as the Google `hd` login hint. Empty when no
// domains are configured (the hint is then omitted).
export function firstAllowedDomain(): string {
  return allowedDomains()[0] ?? '';
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

// ---------- MCP service-token bypass ----------
//
// Allows a headless client (the Zeitlines MCP server) to pass the auth gate and
// read/write sheet sources without an interactive Google login. The request
// carries `X-MCP-Token: <MCP_API_TOKEN>`; sheet access then uses a stored
// service refresh token instead of a per-user session token.

export const MCP_TOKEN_HEADER = 'x-mcp-token';

/** Constant-time string comparison — avoids leaking token length/prefix via timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare against a fixed-length digest so lengths never short-circuit.
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** True when the request presents a valid MCP token (and one is configured). */
export function hasValidMcpToken(req: Request): boolean {
  const configured = Deno.env.get('MCP_API_TOKEN');
  if (!configured) return false;
  const presented = req.headers.get(MCP_TOKEN_HEADER);
  if (!presented) return false;
  return constantTimeEqual(presented, configured);
}

