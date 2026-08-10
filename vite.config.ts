import { defineConfig, type Plugin } from 'vite';
import { resolve, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import { envSourcesHint, envValue, hydrateProcessEnv } from './scripts/db/env';
import { basicAuthHeader, buildPickerUrl, parsePickerResponse } from './scripts/jira/picker';
import { getSql, getSqlForSource } from './scripts/db/sql';
import { getServiceClient } from './scripts/db/client';
import { type DbConnections } from './scripts/db/api';
import { accessControlEnabled, handleApiRequest, liveOverride } from './scripts/db/http';
import { resolveRepo } from './scripts/db/api';
import { toRequest, writeResponse } from './scripts/node-http';
import { hasLocalTimeline, isLocalWritable, makeFileRepo } from './scripts/local/file-repo';
import { parseOperators } from './scripts/db/operator';
import { buildCsp, parseOrigins } from './src/pluginHost/csp';

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
  // The same directory the raw-artifact middleware serves from and the build
  // registers from. Without it `GET /api/plugins` answers `[]` and shadows what
  // the build registered, because the client prefers the live answer.
  pluginsDir: resolve(envValue('TIMELINES_PLUGINS_DIR') || resolve(__dirname, 'plugins')),
};
const localSource = { has: (id: string) => hasLocalTimeline(localDirs, id), repo: makeFileRepo(localDirs) };

const dbConns = (): DbConnections => ({
  sql: getSql(),
  supabase: getServiceClient(),
  sqlFor: getSqlForSource,
  local: localSource,
});

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

      // Mirrors the edge function's /api/me, role included: without that, the
      // membership screen could never be opened locally, and „works in
      // production only" is how a feature stops being verifiable before deploy.
      server.middlewares.use('/api/me', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        const me = devIdentity(req);
        if (!accessControlEnabled(process.env.TIMELINES_ACCESS_CONTROL)) return send(res, 200, me);
        const repo = resolveRepo(dbConns());
        if (!repo) return send(res, 200, me);
        try {
          const member = await repo.getMember(me.email);
          return send(res, 200, member ? { ...me, role: member.role, status: member.status } : me);
        } catch {
          // The identity matters more than the affordance hints, and every route
          // enforces for itself regardless of what this answers.
          return send(res, 200, me);
        }
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
            // Per source, not blanket: a local view only becomes editable if its
            // id still resolves to something this process can reach and write
            // (`isLocalWritable`). A stamped-but-unresolvable source flipped to
            // editable offers „+ Eintrag" and drag handles that end in an error.
            if (view?.source?.kind === 'local') {
              view.source.editable = isLocalWritable(localDirs, view.source.id);
            }
          }
          send(res, 200, built);
        } catch {
          next(); // not built yet — let the static handler produce its own 404
        }
      });

      // /plugins/<id>/<file> — vendored plugin artifacts, served RAW.
      //
      // Its own middleware rather than letting the static handler do it, because
      // Vite appends an inline source map to any `.js` it serves. That makes the
      // dev server's bytes differ from the deploy's, and a pinned artifact then
      // fails its integrity check locally while being fine in production — a
      // dev/prod divergence that pinning is what surfaced. Serving from the SOURCE
      // directory also means editing a plugin and reloading is enough, with no
      // build step in between.
      server.middlewares.use('/plugins', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        const rel = decodeURIComponent((req.url ?? '').replace(/\?.*$/, '')).replace(/^\/+/, '');
        if (!rel) return next();
        const base = resolve(envValue('TIMELINES_PLUGINS_DIR') || resolve(__dirname, 'plugins'));
        const file = resolve(base, rel);
        // Containment on the RESOLVED path: the URL is attacker-controlled, and a
        // `..` segment would otherwise serve any file this process can read.
        if (file !== base && !file.startsWith(base + sep)) {
          res.statusCode = 403;
          return res.end('forbidden');
        }
        try {
          const bytes = await readFile(file);
          res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          res.end(bytes);
        } catch {
          next(); // not a vendored artifact — let the static handler try
        }
      });

      // Everything else under /api/ is the shared HTTP layer: /api/sources,
      // /api/users, /api/plugins, the public plugin read and the /api/source
      // CRUD tree. Routing, optimistic locking, the X-Source-Live header and the
      // error mapping used to be written out here AND in the timelines-api edge
      // function, two copies that had already drifted; they now live once in
      // scripts/db/http.ts and this middleware is the Node adapter in front of
      // it.
      //
      // Mounted globally rather than on '/api': connect strips the mount path
      // from `req.url`, so a prefixed mount would hand the handler '/sources'
      // and every route would miss.
      server.middlewares.use(async (req, res, next) => {
        if (!(req.url ?? '').startsWith('/api/')) return next();
        const out = await handleApiRequest(await toRequest(req), {
          conns: dbConns(),
          // Local dev has no auth session; attribute edits as "local" so they're
          // distinguishable from colleague (Netlify/Google) and MCP edits in the
          // item audit panel. A `dev_user` cookie overrides it (see /api/me).
          //
          // Email only, no name: the dev identity has none, and `/api/me` reports
          // the address *as* the name so the presence badge has something to
          // label with. Registering that would store "alice@example.com" as
          // Alice's display name; without it she shows as "alice".
          updatedBy: devIdentity(req).email,
          caller: { email: devIdentity(req).email },
          // Off unless a developer asks for it, and then it consults the same
          // member list as everything else — which is the point: trying the role
          // model out locally must exercise the real path, not a dev-only
          // shortcut that lets every check pass.
          accessControl: accessControlEnabled(process.env.TIMELINES_ACCESS_CONTROL),
          // A checkout on somebody's laptop IS its own plugin operator: demanding
          // a configured allowlist here would make installing a plugin
          // untestable without one, and there is nobody else on this port.
          operators: parseOperators(envValue('PLUGIN_OPERATOR_EMAILS')),
          // The same list the CSP below is built from, so „installed" and
          // „fetchable" cannot disagree.
          pluginOrigins: parseOrigins(envValue('PLUGIN_ALLOWED_ORIGINS')),
          serviceToken: true,
          live: liveOverride(process.env.TIMELINES_DB_LIVE),
        });
        if (!out) return next(); // not one of its routes (e.g. /api/me, /api/jira)
        await writeResponse(res, out);
      });
    },
  };
}

// The same policy the deploy ships (scripts/build-data.ts writes it to
// `public/_headers`). Set here too, because a CSP that only exists in production
// is a CSP nobody finds out they broke until after a deploy — and the thing it
// most often breaks is a plugin, which is exactly what this repo is now building.
const CSP = buildCsp({
  supabaseUrl: envValue('VITE_SUPABASE_URL') || undefined,
  jiraUrl: envValue('VITE_JIRA_BASE_URL') || undefined,
  pluginOrigins: parseOrigins(envValue('PLUGIN_ALLOWED_ORIGINS')),
});

export default defineConfig({
  build: {
    rollupOptions: {
      // Two entries. The design-system playground is a page of its own rather
      // than a route in the app: the app has no router, and a separate entry is
      // what keeps the playground's specimen code out of the app's bundle —
      // asserted by scripts/ci/check-bundle-split.sh rather than assumed.
      input: {
        index: resolve(__dirname, 'index.html'),
        playground: resolve(__dirname, 'playground.html'),
      },
    },
  },
  server: {
    port: PORT,
    strictPort: true,
    headers: { 'Content-Security-Policy': CSP },
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
