// Netlify Edge Function — Sheets API proxy.
//
// Handles GET/PUT /api/source/<id> for sheet-backed sources.
// Uses the logged-in user's Google tokens (stored in session cookie)
// to read/write sheets directly, giving per-user attribution.
//
// For non-sheet sources or when sheets are disabled, falls through to
// the static file (read-only).
//
// Required env vars: SHEETS_ENABLED=true, SHEETS_CONFIG (JSON array)

import type { Context, Config } from '@netlify/edge-functions';
import {
  readSession,
  getValidAccessToken,
  sign,
  cookieString,
  COOKIE_NAME,
  SESSION_MAX_AGE,
  type SessionPayload,
} from './_shared/session.ts';
import {
  rowsToTimelineFile,
  timelineFileToRows,
  type TimelineFile,
} from '../../scripts/sheets/transform.ts';

type SheetConfig = {
  id: string;
  name?: string;
  description?: string;
  spreadsheetId: string;
  itemsSheet?: string;
  groupsSheet?: string;
  groupBy?: string;
};

function loadSheetConfigs(): SheetConfig[] {
  const raw = Deno.env.get('SHEETS_CONFIG');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

async function sheetsGet(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string,
): Promise<string[][]> {
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(sheetName)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sheets GET ${sheetName} failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return (data.values ?? []).map((row: unknown[]) =>
    row.map((v) => (v == null ? '' : String(v))),
  );
}

async function sheetsClear(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string,
): Promise<void> {
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(sheetName)}:clear`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sheets CLEAR ${sheetName} failed (${res.status}): ${text}`);
  }
}

async function sheetsWrite(
  spreadsheetId: string,
  sheetName: string,
  rows: string[][],
  accessToken: string,
): Promise<void> {
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ range: `${sheetName}!A1`, majorDimension: 'ROWS', values: rows }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sheets WRITE ${sheetName} failed (${res.status}): ${text}`);
  }
}

async function ensureSheetTab(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string,
): Promise<void> {
  const metaUrl = `${SHEETS_API}/${spreadsheetId}?fields=sheets.properties.title`;
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaRes.ok) return;
  const meta = await metaRes.json();
  const exists = (meta.sheets ?? []).some(
    (s: { properties?: { title?: string } }) => s.properties?.title === sheetName,
  );
  if (exists) return;

  await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    }),
  });
}

function jsonResponse(data: unknown, status = 200, extraHeaders?: Headers): Response {
  const headers = extraHeaders ?? new Headers();
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { status, headers });
}

export default async function handler(req: Request, _ctx: Context): Promise<Response | void> {
  if (Deno.env.get('SHEETS_ENABLED') !== 'true') return;
  if (Deno.env.get('AUTH_REQUIRED') !== 'true') return;

  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/source\/([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)$/);
  if (!match) return;

  const sourceId = match[1];
  const configs = loadSheetConfigs();
  const cfg = configs.find((s) => s.id === sourceId);
  if (!cfg) return; // not a sheet source — fall through to static

  if (req.method !== 'GET' && req.method !== 'PUT') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  const session = await readSession(req);
  if (!session) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  if (!session.google_access_token) {
    return jsonResponse(
      { error: 'no_sheets_token', message: 'Re-login required to access sheets' },
      403,
    );
  }

  let accessToken: string;
  let updatedSession: SessionPayload | null = null;
  try {
    const result = await getValidAccessToken(session);
    accessToken = result.accessToken;
    updatedSession = result.updatedSession;
  } catch (err) {
    return jsonResponse(
      { error: 'token_refresh_failed', message: String(err) },
      403,
    );
  }

  const responseHeaders = new Headers();
  if (updatedSession) {
    const newCookie = await sign(updatedSession);
    responseHeaders.append('Set-Cookie', cookieString(COOKIE_NAME, newCookie, SESSION_MAX_AGE));
  }

  const itemsSheet = cfg.itemsSheet ?? 'Items';
  const groupsSheet = cfg.groupsSheet ?? 'Groups';

  if (req.method === 'GET') {
    try {
      const itemRows = await sheetsGet(cfg.spreadsheetId, itemsSheet, accessToken);

      let groupRows: string[][] | null = null;
      try {
        groupRows = await sheetsGet(cfg.spreadsheetId, groupsSheet, accessToken);
      } catch {
        // Groups tab is optional
      }

      const file = rowsToTimelineFile(itemRows, groupRows, {
        name: cfg.name,
        description: cfg.description,
        groupBy: cfg.groupBy,
      });
      return jsonResponse(file, 200, responseHeaders);
    } catch (err) {
      return jsonResponse(
        { error: 'sheets_read_failed', message: String(err) },
        502,
        responseHeaders,
      );
    }
  }

  // PUT
  let body: TimelineFile;
  try {
    body = await req.json();
    if (!body || !Array.isArray(body.items)) {
      return jsonResponse({ error: 'expected object with "items" array' }, 400, responseHeaders);
    }
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400, responseHeaders);
  }

  try {
    const { itemRows, groupRows } = timelineFileToRows(body);

    await ensureSheetTab(cfg.spreadsheetId, itemsSheet, accessToken);
    await sheetsClear(cfg.spreadsheetId, itemsSheet, accessToken);
    await sheetsWrite(cfg.spreadsheetId, itemsSheet, itemRows, accessToken);

    if (groupRows) {
      await ensureSheetTab(cfg.spreadsheetId, groupsSheet, accessToken);
      await sheetsClear(cfg.spreadsheetId, groupsSheet, accessToken);
      await sheetsWrite(cfg.spreadsheetId, groupsSheet, groupRows, accessToken);
    }

    return jsonResponse({ ok: true }, 200, responseHeaders);
  } catch (err) {
    return jsonResponse(
      { error: 'sheets_write_failed', message: String(err) },
      502,
      responseHeaders,
    );
  }
}

export const config: Config = {
  path: '/api/source/*',
};
