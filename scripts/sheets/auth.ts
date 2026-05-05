import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { OAuth2Client } from 'google-auth-library';

const ROOT = process.cwd();
const TOKEN_PATH = join(ROOT, '.scripts', 'google-token.json');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

type WebClient = {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
};

type ClientSecretFile = { web?: WebClient; installed?: WebClient };

function expandHome(p: string): string {
  if (p.startsWith('~')) return join(homedir(), p.slice(1));
  return p;
}

async function loadClientSecret(): Promise<WebClient> {
  const explicit = process.env.TIMELINES_GOOGLE_CLIENT_SECRET;
  const candidates = [
    explicit ? expandHome(explicit) : null,
    join(ROOT, '.scripts', 'client_secret.json'),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as ClientSecretFile;
    const web = parsed.web ?? parsed.installed;
    if (!web?.client_id || !web?.client_secret) {
      throw new Error(`OAuth client secret at ${path} is missing client_id/client_secret`);
    }
    return web;
  }

  throw new Error(
    'No Google OAuth client secret found. Set TIMELINES_GOOGLE_CLIENT_SECRET=/path/to/client_secret.json or place it at .scripts/client_secret.json',
  );
}

async function loadToken(): Promise<Record<string, unknown> | null> {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(await readFile(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function saveToken(token: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2));
}

const AUTH_LOOPBACK_PORT = 3129;

async function runConsentFlow(secret: WebClient): Promise<OAuth2Client> {
  const port = AUTH_LOOPBACK_PORT;
  const redirectUri = `http://localhost:${port}`;
  const client = new OAuth2Client({
    clientId: secret.client_id,
    clientSecret: secret.client_secret,
    redirectUri,
  });

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    redirect_uri: redirectUri,
  });

  console.log('\n[sheets] Google authorization needed.');
  console.log('[sheets] Opening browser. If it does not open, paste this URL:\n');
  console.log(`  ${url}\n`);

  // Try to open the browser; non-fatal if it fails
  const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const { spawn } = await import('node:child_process');
    spawn(open, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* fall through to manual paste */
  }

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
        const code = reqUrl.searchParams.get('code');
        const err = reqUrl.searchParams.get('error');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (err) {
          res.end(`<h1>Authorization failed</h1><p>${err}</p>`);
          server.close();
          reject(new Error(err));
          return;
        }
        if (!code) {
          res.statusCode = 400;
          res.end('Missing code');
          return;
        }
        res.end('<h1>Authorized.</h1><p>Du kannst dieses Fenster schließen.</p>');
        server.close();
        resolve(code);
      } catch (e) {
        server.close();
        reject(e);
      }
    });
    server.on('error', reject);
    server.listen(port);
  });

  const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
  client.setCredentials(tokens);
  await saveToken(tokens as Record<string, unknown>);
  console.log('[sheets] Token saved to .scripts/google-token.json\n');
  return client;
}

async function pickFreeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('failed to allocate port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

let cachedClient: OAuth2Client | null = null;

export async function getOAuthClient(opts: { interactive?: boolean } = {}): Promise<OAuth2Client> {
  if (cachedClient) return cachedClient;
  const secret = await loadClientSecret();
  const client = new OAuth2Client(secret.client_id, secret.client_secret);

  const token = await loadToken();
  if (token) {
    client.setCredentials(token);
    client.on('tokens', async (newTokens) => {
      const merged = { ...token, ...newTokens };
      try {
        await saveToken(merged);
      } catch (err) {
        console.warn('[sheets] failed to persist refreshed token:', err);
      }
    });
    cachedClient = client;
    return client;
  }

  if (!opts.interactive) {
    throw new Error(
      'No Google token cached. Run `npm run sheets:auth` once to authorize.',
    );
  }

  const authorized = await runConsentFlow(secret);
  cachedClient = authorized;
  return authorized;
}

export async function ensureAuthorized(): Promise<void> {
  await getOAuthClient({ interactive: true });
}

if (process.argv[1]?.endsWith('auth.ts') || process.argv[1]?.endsWith('auth.js')) {
  ensureAuthorized()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[sheets] auth failed:', err);
      process.exit(1);
    });
}
