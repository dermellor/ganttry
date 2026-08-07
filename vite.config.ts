import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { envSourcesHint, envValue } from './scripts/db/env';
import { basicAuthHeader, buildPickerUrl, parsePickerResponse } from './scripts/jira/picker';
import { getSql, getSqlForSource } from './scripts/db/sql';
import { getServiceClient } from './scripts/db/client';
import { handleUsersApi, resolveAdapter, resolveRepo, parseSourcePath, type DbConnections, type ApiRequest } from './scripts/db/api';

// Additive dual-adapter: prefer native postgres.js (TIMELINES_DATABASE_URL),
// else supabase-js (TIMELINES_SUPABASE_URL + SERVICE_KEY). Both factories cache,
// so calling them per request is cheap. Neither configured → the "no DB" path.
// `sqlFor` adds per-source routing on the postgres.js path (a source's namespace
// picks its own TIMELINES_DATABASE_URL_<NS>, else the default); no-op unless
// such a named var is set, so single-DB setups are unaffected.
const dbConns = (): DbConnections => ({ sql: getSql(), supabase: getServiceClient(), sqlFor: getSqlForSource });
const hasDb = (c: DbConnections): boolean => Boolean(c.sql || c.supabase);

const ID_SEGMENT = /^[a-zA-Z0-9_-]+$/;

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

      // GET /api/sources — list timelines
      server.middlewares.use('/api/sources', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        const conns = dbConns();
        if (!hasDb(conns)) return send(res, 200, { sources: [] });
        try {
          const result = await resolveAdapter(conns, '').handle({ method: 'GET', id: '' });
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

        // Validate id + childId segments.
        const segs = [...parsed.id.split('/'), parsed.sub?.childId].filter(Boolean) as string[];
        if (!segs.every((s) => ID_SEGMENT.test(s))) {
          return send(res, 400, { error: `invalid id "${parsed.id}"` });
        }

        const conns = dbConns();
        if (!hasDb(conns)) {
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
    port: 3120,
    strictPort: true,
  },
  plugins: [timelinesApi()],
});
