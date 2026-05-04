import { defineConfig, type Plugin } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCES_DIR = resolve(__dirname, 'data');
const ID_RE = /^[a-zA-Z0-9_-]+$/;

function timelinesApi(): Plugin {
  return {
    name: 'timelines-api',
    configureServer(server) {
      server.middlewares.use('/api/source', async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'PUT') return next();

        const path = (req.url ?? '').replace(/^\//, '').replace(/\?.*$/, '').replace(/\/$/, '');
        const id = path;
        if (!id || !ID_RE.test(id)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `invalid id "${id}"` }));
          return;
        }

        const filePath = resolve(SOURCES_DIR, `${id}.json`);

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
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch (err) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'invalid JSON', detail: String(err) }));
          return;
        }
        if (!json || typeof json !== 'object' || !Array.isArray((json as any).items)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'expected object with "items" array' }));
          return;
        }
        await mkdir(SOURCES_DIR, { recursive: true });
        await writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
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
