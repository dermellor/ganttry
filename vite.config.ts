import { defineConfig, type Plugin } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { pushSheet } from './scripts/sheets/sync';

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
