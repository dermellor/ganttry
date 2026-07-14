import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { basicAuthHeader, buildPickerUrl, parsePickerResponse } from './scripts/jira/picker';
import { getServiceClient } from './scripts/db/client';
import { handleTimelineApi, parseSourcePath, type ApiRequest } from './scripts/db/api';

const ID_SEGMENT = /^[a-zA-Z0-9_-]+$/;

// Minimal .env parser — only what's needed to surface JIRA credentials that
// live in ~/_AGENTS/.env (cross-project keys) or a local .env.local without
// pulling in a dotenv dependency. process.env always wins.
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[m[1]] = value;
    }
  } catch {
    /* file may not exist — fine */
  }
  return out;
}

type JiraCreds = { baseUrl: string; email: string; apiToken: string };

let jiraCredsCache: JiraCreds | null | undefined;
function loadJiraCreds(): JiraCreds | null {
  if (jiraCredsCache !== undefined) return jiraCredsCache;
  const fromFiles = {
    ...parseEnvFile(resolve(homedir(), '_AGENTS/.env')),
    ...parseEnvFile(resolve(__dirname, '.env.local')),
  };
  const pick = (k: string) => process.env[k] ?? fromFiles[k] ?? '';
  const baseUrl = pick('JIRA_BASE_URL');
  const email = pick('JIRA_EMAIL');
  const apiToken = pick('JIRA_API_TOKEN');
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
              detail: 'Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN (in ~/_AGENTS/.env or .env.local).',
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
      server.middlewares.use('/api/me', (req, res, next) => {
        if (req.method !== 'GET') return next();
        send(res, 200, { email: 'local', name: 'local' });
      });

      // GET /api/sources — list timelines
      server.middlewares.use('/api/sources', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        const db = getServiceClient();
        if (!db) return send(res, 200, { sources: [] });
        try {
          const result = await handleTimelineApi(db, { method: 'GET', id: '' });
          send(res, result.status, result.json);
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

        const db = getServiceClient();
        if (!db) {
          // No DB configured: 404 on GET (nothing to read). The client surfaces
          // the error loudly — there is no static content fallback. Writes 503.
          if (method === 'GET') return send(res, 404, { error: 'db_not_configured' });
          return send(res, 503, {
            error: 'db_not_configured',
            detail: 'Set TIMELINES_SUPABASE_URL and TIMELINES_SUPABASE_SERVICE_KEY.',
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
          const result = await handleTimelineApi(db, apiReq);
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
