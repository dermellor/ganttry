// A production server for a self-hosted deployment: serves the built `dist/`
// and the API from one Node process.
//
// Why this exists: the `/api/*` layer used to live only in the Vite dev-server
// middleware and in the Netlify edge functions. So anyone self-hosting with
// their own Postgres had no supported way to run an editable deployment — the
// README's quickstart ended at `npm run dev`, which is a development server, not
// something to leave running. Read-only file sources deploy to any static host;
// anything editable was effectively Netlify-only.
//
// It is deliberately thin. The routing, locking and error semantics come from
// `scripts/db/http.ts`, the same module the other two runtimes use, so this file
// only has to do what is genuinely its own: open the DB handles, translate
// between `node:http` and Fetch, and serve static files.
//
// NOT in here, on purpose:
//   - Authentication. There is no gate; put one in front (see #32) or keep the
//     port private. The server says so on startup rather than pretending.
//   - TLS. A reverse proxy does that better than a bespoke option would.
//   - The JIRA proxy and the dev-only config.json override, which belong to the
//     dev server.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { toRequest, writeResponse } from './node-http.ts';
import { decideAccess, parseDomains, type AccessConfig } from './admission.ts';
import { envValue, hydrateProcessEnv } from './db/env.ts';
import { getSql, getSqlForSource } from './db/sql.ts';
import { getServiceClient } from './db/client.ts';
import {
  accessControlEnabled,
  handleApiRequest,
  liveOverride,
  type ApiContext,
} from './db/http.ts';
import type { DbConnections } from './db/api.ts';

hydrateProcessEnv();

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = resolve(envValue('TIMELINES_DIST_DIR') || join(ROOT, 'dist'));
const PORT = Number(envValue('TIMELINES_SERVE_PORT') || envValue('TIMELINES_PORT')) || 3120;
const HOST = envValue('TIMELINES_SERVE_HOST') || '127.0.0.1';

/**
 * The access policy, read once. Naming a header both switches the gate on and
 * says which header carries the identity — a header is only trustworthy if
 * something upstream strips it from client requests, and this process cannot
 * verify that, so it stays an explicit statement by the operator rather than a
 * sniff for a well-known name.
 *
 * The decision itself is in `./admission.ts`, pure and unit-tested.
 */
const ACCESS: AccessConfig = {
  identityHeader: envValue('TIMELINES_TRUSTED_IDENTITY_HEADER')?.toLowerCase() || undefined,
  allowedDomains: parseDomains(envValue('TIMELINES_ALLOWED_EMAIL_DOMAINS')),
};

function identityOf(req: IncomingMessage): string | undefined {
  if (!ACCESS.identityHeader) return undefined;
  const raw = req.headers[ACCESS.identityHeader];
  return Array.isArray(raw) ? raw[0] : raw;
}

const dbConns = (): DbConnections => ({
  sql: getSql(),
  supabase: getServiceClient(),
  sqlFor: getSqlForSource,
  // No `local`: this process serves a *built* site, where local sources were
  // already materialised into static JSON by `build:data` and are read-only —
  // the same answer a static deploy gives (see docs/local-sources.md).
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve a URL path to a file inside `dist/`, or null if it escapes.
 *
 * The containment check compares the *resolved* path, which is what catches the
 * encodings a character blocklist misses — the same reasoning as the guard in
 * `scripts/local/file-repo.ts`.
 */
function resolveStatic(pathname: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return null;
    }
  })();
  if (decoded == null || decoded.includes('\0')) return null;
  const candidate = resolve(join(DIST, normalize(decoded)));
  if (candidate !== DIST && !candidate.startsWith(DIST + sep)) return null;
  return candidate;
}

async function sendFile(res: ServerResponse, file: string, status = 200): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    res.writeHead(status, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(info.size),
      // The entry document must never be cached: it names the hashed asset files,
      // so a stale copy pins a browser to a previous deploy. Hashed assets under
      // /assets/ can be cached hard for the same reason.
      'Cache-Control': file.endsWith('.html')
        ? 'no-cache'
        : file.includes(`${sep}assets${sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
    });
    createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (url.pathname.startsWith('/api/')) {
        const access = decideAccess(url.pathname, identityOf(req), ACCESS);
        if (!access.allow) {
          res.writeHead(access.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return void res.end(JSON.stringify({ error: access.error, detail: access.detail }));
        }
        const email = access.email;
        const ctx: ApiContext = {
          conns: dbConns(),
          caller: email ? { email } : undefined,
          // Without a gate there is no identity to attribute to, and inventing
          // one per request would make the audit panel lie. One honest label for
          // "this deployment does not know who edits".
          updatedBy: email ?? 'self-hosted',
          // Admission (above) asked whether a trusted identity is present at
          // all; this asks what that identity may do. Both are opt-in, and
          // turning this one on without an identity header refuses everything,
          // which is the honest outcome of asking for roles without a caller.
          accessControl: accessControlEnabled(envValue('TIMELINES_ACCESS_CONTROL')),
          live: liveOverride(envValue('TIMELINES_DB_LIVE')),
        };
        const out = await handleApiRequest(await toRequest(req), ctx);
        if (out) return void (await writeResponse(res, out));
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ error: 'not found' }));
      }

      // Static files are served ungated on purpose, even with the gate on. The
      // built bundle carries no timeline data — every read goes through the API,
      // which just refused — so all an ungated visitor gets is an empty shell
      // that immediately errors. Gating it would also break the redirect dance
      // of some proxies, which fetch assets before a session exists.
      const file = resolveStatic(url.pathname);
      if (!file) {
        res.writeHead(400);
        return void res.end('bad request');
      }
      if (await sendFile(res, file)) return;
      // A directory URL, then the SPA fallback: the viewer keeps its state in the
      // hash, but a deep link to a sub-path must still boot the app rather than
      // 404 (and a real missing asset shows up as a failed fetch, not as HTML,
      // because only non-file paths get here).
      if (await sendFile(res, join(file, 'index.html'))) return;
      if (await sendFile(res, join(DIST, 'index.html'))) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (err) {
      console.error('[serve]', err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'server_error' }));
    }
  })();
});

server.listen(PORT, HOST, () => {
  const conns = dbConns();
  console.log(`[serve] http://${HOST}:${PORT} — serving ${DIST}`);
  console.log(
    conns.sql
      ? '[serve] database: postgres.js (TIMELINES_DATABASE_URL)'
      : conns.supabase
        ? '[serve] database: supabase-js (TIMELINES_SUPABASE_URL)'
        : '[serve] database: none configured — DB timelines will fail loudly, static sources still serve',
  );
  // Said every time on purpose. An unauthenticated editable deployment is a
  // decision, and it should not be one somebody makes by not reading a document.
  if (ACCESS.identityHeader) {
    const domains = ACCESS.allowedDomains?.length ? ACCESS.allowedDomains.join(', ') : 'any';
    console.log(
      `[serve] access: gated on ${ACCESS.identityHeader} (domains: ${domains}) — your proxy MUST strip that header from client requests`,
    );
  } else {
    console.log(
      '[serve] access: OPEN — every visitor can edit, and every edit is attributed to "self-hosted".',
    );
    console.log(
      '[serve]         Set TIMELINES_TRUSTED_IDENTITY_HEADER behind an authenticating proxy, or keep this port private.',
    );
  }
});
