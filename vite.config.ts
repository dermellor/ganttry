import { defineConfig, type Plugin } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { pushSheet } from './scripts/sheets/sync';
import { basicAuthHeader, buildPickerUrl, parsePickerResponse } from './scripts/jira/picker';

const SOURCES_SUBDIR = (process.env.TIMELINES_SOURCES_SUBDIR ?? '').replace(/^\/+|\/+$/g, '');
const SOURCES_DIR = SOURCES_SUBDIR
  ? resolve(__dirname, 'data', SOURCES_SUBDIR)
  : resolve(__dirname, 'data');
const CONFIG_PATH = resolve(__dirname, 'timelines.config.json');
const ID_SEGMENT = /^[a-zA-Z0-9_-]+$/;

type SheetConfig = {
  id: string;
  spreadsheetId: string;
  itemsSheet?: string;
  groupsSheet?: string;
  name?: string;
  description?: string;
  groupBy?: string;
};

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

async function loadSheetConfigs(): Promise<SheetConfig[]> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw) as { sheets?: SheetConfig[] };
    return cfg.sheets ?? [];
  } catch {
    return [];
  }
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

      server.middlewares.use('/api/source', async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'PUT') return next();

        const path = (req.url ?? '').replace(/^\//, '').replace(/\?.*$/, '').replace(/\/$/, '');
        const id = path;
        const segments = id ? id.split('/') : [];
        const idValid = segments.length > 0 && segments.every((s) => ID_SEGMENT.test(s));
        if (!idValid) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `invalid id "${id}"` }));
          return;
        }

        const filePath = resolve(SOURCES_DIR, `${id}.json`);
        if (filePath !== `${SOURCES_DIR}${sep}${id}.json` && !filePath.startsWith(SOURCES_DIR + sep)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'path traversal rejected' }));
          return;
        }

        if (req.method === 'GET') {
          if (!existsSync(filePath)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not found' }));
            return;
          }
          const content = await readFile(filePath, 'utf8');
          res.setHeader('Content-Type', 'application/json');
          res.end(content);
          return;
        }

        // PUT
        let body = '';
        for await (const chunk of req) body += chunk;
        let json: any;
        try {
          json = JSON.parse(body);
        } catch (err) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'invalid JSON', detail: String(err) }));
          return;
        }
        if (!json || typeof json !== 'object' || !Array.isArray(json.items)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'expected object with "items" array' }));
          return;
        }

        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`);

        const sheets = await loadSheetConfigs();
        const sheetCfg = sheets.find((s) => s.id === id);
        if (sheetCfg) {
          try {
            await pushSheet(sheetCfg, json);
          } catch (err) {
            console.warn(`[timelines-api] sheet write-back failed for "${id}":`, err);
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: true,
                sheetWriteBack: 'failed',
                error: err instanceof Error ? err.message : String(err),
              }),
            );
            return;
          }
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            ok: true,
            sheetWriteBack: sheetCfg ? 'ok' : undefined,
          }),
        );
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
