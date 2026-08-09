import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { envSourcesHint, envValue, hydrateProcessEnv } from './scripts/db/env';
import { basicAuthHeader, buildPickerUrl, parsePickerResponse } from './scripts/jira/picker';
import { getSql, getSqlForSource } from './scripts/db/sql';
import { getServiceClient } from './scripts/db/client';
import { handleUsersApi, resolveAdapter, resolveRepo, parseSourcePath, type DbConnections, type ApiRequest } from './scripts/db/api';
import { hasLocalTimeline, isLocalWritable, makeFileRepo } from './scripts/local/file-repo';
import { handlePluginsApi } from './scripts/db/plugin-api';
import { parseOperators } from './scripts/db/operator';

// Runs while Vite loads this config, before it resolves `import.meta.env`.
// Vite reads VITE_* from repo-local .env files and from process.env only, so
// this is what lets an instance profile outside the repo supply them.
hydrateProcessEnv();

// Where this instance's build output lives. `scripts/build-data.ts` writes to
// public/<TIMELINES_DATA_DIR>/; the client needs the matching URL prefix, and
// deriving it here keeps the two from drifting apart. Default '/data'.
const DATA_DIR = (envValue('TIMELINES_DATA_DIR') || 'data').replace(/^\/+|\/+$/g, '');
process.env.VITE_DATA_BASE ??= `/${DATA_DIR}`;

// The port is the environment's business, not the project's (see AGENTS.md), so
// it comes from the cascade and an instance profile can carry its own.
const PORT = Number(envValue('TIMELINES_PORT')) || 3120;

// Additive dual-adapter: prefer native postgres.js (TIMELINES_DATABASE_URL),
// else supabase-js (TIMELINES_SUPABASE_URL + SERVICE_KEY). Both factories cache,
// so calling them per request is cheap. Neither configured → the "no DB" path.
// `sqlFor` adds per-source routing on the postgres.js path (a source's namespace
// picks its own TIMELINES_DATABASE_URL_<NS>, else the default); no-op unless
// such a named var is set, so single-DB setups are unaffected.
// The dev server is a process WITH a filesystem, so it is the runtime that can
// serve local file sources editable. `data/` anchors the ids (always relative to
// it, so they match across environments and against a DB timeline id);
// TIMELINES_SOURCES_SUBDIR bounds the scan the same way build-data.ts does.
const localDirs = {
  root: resolve(__dirname, 'data'),
  scope: resolve(__dirname, 'data', (process.env.TIMELINES_SOURCES_SUBDIR ?? '').replace(/^\/+|\/+$/g, '')),
};
const localSource = { has: (id: string) => hasLocalTimeline(localDirs, id), repo: makeFileRepo(localDirs) };

const dbConns = (): DbConnections => ({
  sql: getSql(),
  supabase: getServiceClient(),
  sqlFor: getSqlForSource,
  local: localSource,
});
const hasDb = (c: DbConnections): boolean => Boolean(c.sql || c.supabase);

/**
 * A single path segment of a source or item id.
 *
 * Dots are allowed because an item in a Markdown directory source is identified
 * by its file path, and file names carry dots. `.` and `..` are excluded
 * separately: those are the only two that mean something to the filesystem, and
 * excluding them by name is exact where a character blocklist is a guess.
 *
 * This is not the containment guard. That one lives in `scripts/local/file-repo.ts`
 * and works on the RESOLVED path, which is what catches the encodings a
 * character rule misses; this check only keeps obviously malformed ids out of
 * the dispatcher.
 */
const ID_SEGMENT = /^[a-zA-Z0-9_.-]+$/;
const isIdSegment = (s: string): boolean => s !== '.' && s !== '..' && ID_SEGMENT.test(s);

type JiraCreds = { baseUrl: string; email: string; apiToken: string };

// Credentials come from the shared cascade in scripts/db/env.ts (process.env →
// .env.local → TIMELINES_ENV_FILE), the same one the DB client and the MCP
// server use.
let jiraCredsCache: JiraCreds | null | undefined;
function loadJiraCreds(): JiraCreds | null {
  if (jiraCredsCache !== undefined) return jiraCredsCache;
  const baseUrl = envValue('JIRA_BASE_URL');
  const email = envValue('JIRA_EMAIL');
  const apiToken = envValue('JIRA_API_TOKEN');
  jiraCredsCache = baseUrl && email && apiToken ? { baseUrl, email, apiToken } : null;
  return jiraCredsCache;
}

function timelinesApi(): Plugin {
  return {
    name: 'timelines-api',
    configureServer(server) {
      server.middlewares.use('/api/jira/search', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        res.setHeader('Content-Type', 'application/json');

        const creds = loadJiraCreds();
        if (!creds) {
          res.statusCode = 503;
          res.end(
            JSON.stringify({
              error: 'jira_not_configured',
              detail: `Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN (in ${envSourcesHint()}).`,
            }),
          );
          return;
        }

        const query = new URL(req.url ?? '', 'http://localhost').searchParams.get('q')?.trim() ?? '';
        if (!query) {
          res.end(JSON.stringify({ issues: [] }));
          return;
        }

        try {
          const upstream = await fetch(buildPickerUrl(creds.baseUrl, query), {
            headers: {
              Authorization: basicAuthHeader(creds.email, creds.apiToken),
              Accept: 'application/json',
            },
          });
          if (!upstream.ok) {
            res.statusCode = 502;
            res.end(
              JSON.stringify({ error: 'jira_request_failed', status: upstream.status }),
            );
            return;
          }
          const data = await upstream.json();
          res.end(JSON.stringify({ issues: parsePickerResponse(data) }));
        } catch (err) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: 'jira_request_failed', detail: String(err) }));
        }
      });

      const send = (res: any, status: number, json: unknown) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(json));
      };

      const readBody = async (req: any): Promise<unknown> => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        if (!raw.trim()) return undefined;
        return JSON.parse(raw);
      };

      // GET /api/me — current user for the header presence badge. Local dev has
      // no auth session, so everyone is the single "local" identity (matches the
      // updatedBy attribution the write path uses in dev).
      //
      // A `dev_user` cookie overrides that identity. Presence — and especially
      // the per-item marks, which hide our own activity — is otherwise
      // untestable on one machine: every tab would be the same "local" user and
      // therefore invisible to itself. Set it per tab and reload:
      //   document.cookie = 'dev_user=alice'; location.reload()
      // Dev-server only; the deployed site derives the identity from the signed
      // session cookie (netlify/edge-functions/me.ts).
      const devIdentity = (req: any): { email: string; name: string } => {
        const cookie = /(?:^|;\s*)dev_user=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
        const email = cookie ? decodeURIComponent(cookie) : 'local';
        return { email, name: email };
      };

      server.middlewares.use('/api/me', (req, res, next) => {
        if (req.method !== 'GET') return next();
        send(res, 200, devIdentity(req));
      });

      // GET /api/users — the user directory an item's Owner links to. Serving it
      // also registers the caller (see handleUsersApi), which locally means the
      // `dev_user` identity — but only when it is address-shaped, so the default
      // "local" never lands in the (live) directory. Getting a test person in:
      //   document.cookie = 'dev_user=alice@example.com'; location.reload()
      //
      // Without a DB there is no directory. It answers 200 with an empty list
      // rather than failing: the owner picker then has nothing to offer, which is
      // the truth for a notes-only checkout, and no source is editable anyway.
      server.middlewares.use('/api/users', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        const repo = resolveRepo(dbConns());
        if (!repo) return send(res, 200, { users: [] });
        // Email only, no name: the dev identity has none, and `/api/me` reports
        // the address *as* the name so the presence badge has something to label
        // with. Registering that would store "alice@example.com" as Alice's
        // display name; without it she shows as "alice" (the local part).
        const result = await handleUsersApi(repo, {
          method: 'GET',
          caller: { email: devIdentity(req).email },
        });
        send(res, result.status, result.json);
      });

      // GET /<data dir>/config.json — the built viewer config, with one field
      // corrected for THIS runtime: local sources are editable here, because
      // this process has a filesystem and serves /api/source/<id> writes.
      //
      // The path is derived from DATA_DIR rather than hardcoded to `/data`,
      // because it is per-instance (`public/data-<instance>/`) and the client
      // asks for the matching prefix. Hardcoding it means the override silently
      // never fires on any instance that sets TIMELINES_DATA_DIR, and its local
      // sources stay read-only for no visible reason.
      //
      // The build stamps `editable: false` (right for a static deploy) and the
      // runtime that can do better says so, exactly as the DB adapter declares
      // its own `live` mode through X-Source-Live. That is a server stating its
      // capability, not the client probing for one — the client still routes on
      // a single value it is given, so there is no „try the API, fall back to
      // the file" guess (AGENTS.md → „No fallback data, ever").
      //
      // Doing it here rather than at build time is what survives `npm run build`
      // being run in the same checkout: both commands write the same config
      // file, so a build would otherwise turn the running dev server read-only
      // without a word.
      server.middlewares.use(`/${DATA_DIR}/config.json`, async (req, res, next) => {
        if (req.method !== 'GET') return next();
        try {
          const built = JSON.parse(await readFile(resolve(__dirname, 'public', DATA_DIR, 'config.json'), 'utf8'));
          for (const view of built.views ?? []) {
            // Per source, not blanket: a Markdown directory is served here but
            // is not writable yet, and claiming otherwise offers edits that 501.
            if (view?.source?.kind === 'local') {
              view.source.editable = isLocalWritable(localDirs, view.source.id);
            }
          }
          send(res, 200, built);
        } catch {
          next(); // not built yet — let the static handler produce its own 404
        }
      });

      // GET /api/sources — list timelines
      server.middlewares.use('/api/sources', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        const conns = dbConns();
        // Without a DB the collection is still answerable from the filesystem:
        // the local timelines ARE sources, and returning [] would hide them.
        if (!hasDb(conns) && !conns.local) return send(res, 200, { sources: [] });
        try {
          const result = await resolveAdapter(conns, '').handle({ method: 'GET', id: '' });
          send(res, result.status, result.json);
        } catch (err) {
          send(res, 500, { error: 'server_error', message: String(err) });
        }
      });

      // /api/plugins[/<pluginId>] — the instance's install registry.
      //
      // Instance-level, so it is a sibling of /api/sources rather than something
      // under a timeline: which plugins this deployment has is not a property of
      // any one timeline. Reads are open past the auth gate (the interface shows
      // them); writes are operator-only, and locally the dev identity is treated
      // as one — a checkout on somebody's laptop IS its operator, and demanding a
      // configured allowlist there would make the flow untestable without one.
      server.middlewares.use('/api/plugins', async (req, res, next) => {
        const method = req.method ?? 'GET';
        const conns = dbConns();
        const repo = resolveRepo(conns) ?? conns.local?.repo;
        if (!repo) return send(res, 200, { plugins: [] });
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pluginId = url.pathname.replace(/^\/+|\/+$/g, '') || undefined;
        let body: unknown;
        if (method !== 'GET' && method !== 'DELETE') {
          try {
            body = await readBody(req);
          } catch (err) {
            return send(res, 400, { error: 'invalid JSON', detail: String(err) });
          }
        }
        try {
          const result = await handlePluginsApi(repo, {
            method,
            pluginId: pluginId ? decodeURIComponent(pluginId) : undefined,
            body,
            params: Object.fromEntries(url.searchParams),
            caller: { email: 'local', mcp: true },
            operators: parseOperators(envValue('PLUGIN_OPERATOR_EMAILS')),
          });
          send(res, result.status, result.json);
        } catch (err) {
          send(res, 500, { error: 'server_error', message: String(err) });
        }
      });

      // GET /api/pricing/<id> — PUBLIC pricing model (mirror of the edge fn).
      server.middlewares.use('/api/pricing', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        const repo = resolveRepo(dbConns());
        if (!repo) return send(res, 503, { error: 'db_not_configured' });
        const id = (req.url ?? '').replace(/\?.*$/, '').replace(/^\/+|\/+$/g, '');
        if (!id) return send(res, 400, { error: 'id required' });
        try {
          const pricing = await repo.getPublicPricing(decodeURIComponent(id));
          if (pricing) send(res, 200, pricing);
          else send(res, 404, { error: 'not found' });
        } catch (err) {
          send(res, 500, { error: 'server_error', message: String(err) });
        }
      });

      // /api/source/<id>[/item|group|phases[/<childId>]] — DB-backed CRUD
      server.middlewares.use('/api/source', async (req, res, next) => {
        const method = req.method ?? 'GET';
        const rawPath = (req.url ?? '').replace(/\?.*$/, '');
        const parsed = parseSourcePath(rawPath);
        if (!parsed) return send(res, 400, { error: 'invalid path' });

        // Validate id + childId segments. The `/plugin/…` parts are deliberately
        // exempt, and the exemption is not a hole: none of them ever becomes a
        // path, and each is checked against something stricter than a charset —
        // the plugin id and the collection against the installed manifest (an
        // allowlist), the row id by the store that holds it. A charset rule would
        // meanwhile reject legitimate values: a scoped plugin id carries `@` and
        // `/`, and a composite row id carries `:` and percent escapes.
        const segs = [
          ...parsed.id.split('/'),
          ...(parsed.sub?.plugin ? [] : [parsed.sub?.childId]),
        ].filter(Boolean) as string[];
        if (!segs.every(isIdSegment)) {
          return send(res, 400, { error: `invalid id "${parsed.id}"` });
        }

        const conns = dbConns();
        // A local file answers for its own id whether or not a DB exists, so the
        // "no DB" refusal below must not intercept it — that gate predates local
        // sources and would otherwise 404 every JSON timeline on a checkout
        // without credentials, which is the common contributor setup.
        if (!hasDb(conns) && !conns.local?.has(parsed.id)) {
          // No DB configured: 404 on GET (nothing to read). The client surfaces
          // the error loudly — there is no static content fallback. Writes 503.
          if (method === 'GET') return send(res, 404, { error: 'db_not_configured' });
          return send(res, 503, {
            error: 'db_not_configured',
            detail: 'Set TIMELINES_DATABASE_URL, or TIMELINES_SUPABASE_URL + TIMELINES_SUPABASE_SERVICE_KEY.',
          });
        }

        let body: unknown;
        if (method !== 'GET' && method !== 'DELETE') {
          try {
            body = await readBody(req);
          } catch (err) {
            return send(res, 400, { error: 'invalid JSON', detail: String(err) });
          }
        }

        const ifMatchHeader = req.headers['if-match'];
        const ifMatch = ifMatchHeader ? parseInt(String(ifMatchHeader), 10) : undefined;

        const apiReq: ApiRequest = {
          method,
          id: parsed.id,
          sub: parsed.sub,
          body,
          ifMatch: Number.isFinite(ifMatch as number) ? (ifMatch as number) : undefined,
          // Local dev has no auth session; attribute edits as "local" so they're
          // distinguishable from colleague (Netlify/Google) and MCP edits in the
          // item audit panel. Production/MCP set updatedBy in their own runtimes.
          updatedBy: 'local',
        };

        try {
          // TIMELINES_DB_LIVE=poll makes DB sources advertise polling instead of
          // Supabase Realtime (for a Postgres without Realtime enabled).
          const live = process.env.TIMELINES_DB_LIVE === 'poll' ? 'poll' : 'realtime';
          const adapter = resolveAdapter(conns, apiReq.id, live);
          // Tell the client which live-update impl to use (read by loadSource).
          res.setHeader('X-Source-Live', adapter.capabilities.live);
          const result = await adapter.handle(apiReq);
          // A GET 404 (source not in the DB) surfaces as a loud client error —
          // no static content fallback (see AGENTS.md „keine Notfall-Daten").
          send(res, result.status, result.json);
        } catch (err) {
          send(res, 500, { error: 'server_error', message: String(err) });
        }
      });
    },
  };
}

export default defineConfig({
  server: {
    port: PORT,
    strictPort: true,
    watch: {
      // Worktrees live inside the checkout (`.claude/worktrees/<name>`), so the
      // dev server's watcher reaches into them and reloads the page whenever
      // another branch's working copy changes — down to its built `dist/`. That
      // is another branch's code, never what this server serves, so the reload
      // is always noise and makes a preview look like it moved on its own.
      ignored: ['**/.claude/worktrees/**'],
    },
  },
  plugins: [timelinesApi()],
});
