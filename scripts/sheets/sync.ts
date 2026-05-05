import { google, sheets_v4 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { getOAuthClient } from './auth.js';
import {
  rowsToTimelineFile,
  timelineFileToRows,
  ITEM_COLUMNS,
  GROUP_COLUMNS,
  type TimelineFile,
} from './transform.js';

export type SheetSourceConfig = {
  id: string;
  name?: string;
  description?: string;
  spreadsheetId: string;
  itemsSheet?: string;
  groupsSheet?: string;
  groupBy?: string;
};

export type { TimelineFile };

let sheetsApi: sheets_v4.Sheets | null = null;

async function getSheets(client?: OAuth2Client): Promise<sheets_v4.Sheets> {
  if (sheetsApi) return sheetsApi;
  const auth = client ?? (await getOAuthClient({ interactive: false }));
  sheetsApi = google.sheets({ version: 'v4', auth });
  return sheetsApi;
}

async function readRange(
  spreadsheetId: string,
  sheetName: string,
): Promise<string[][]> {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetName,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  return (res.data.values ?? []).map((row) => row.map((v) => (v == null ? '' : String(v))));
}

export async function pullSheet(cfg: SheetSourceConfig): Promise<TimelineFile> {
  const itemsSheet = cfg.itemsSheet ?? 'Items';
  const groupsSheet = cfg.groupsSheet ?? 'Groups';

  const itemRows = await readRange(cfg.spreadsheetId, itemsSheet);

  let groupRows: string[][] | null = null;
  try {
    groupRows = await readRange(cfg.spreadsheetId, groupsSheet);
  } catch (err: any) {
    if (err?.code !== 400 && !/parse range/i.test(String(err?.message))) {
      throw err;
    }
  }

  return rowsToTimelineFile(itemRows, groupRows, {
    name: cfg.name,
    description: cfg.description,
    groupBy: cfg.groupBy,
  });
}

async function clearAndWrite(
  spreadsheetId: string,
  sheetName: string,
  rows: string[][],
): Promise<void> {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: sheetName,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
}

async function ensureSheetExists(
  spreadsheetId: string,
  sheetName: string,
): Promise<void> {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(title))',
  });
  const exists = (meta.data.sheets ?? []).some(
    (s) => s.properties?.title === sheetName,
  );
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    },
  });
}

export async function pushSheet(cfg: SheetSourceConfig, file: TimelineFile): Promise<void> {
  const itemsSheet = cfg.itemsSheet ?? 'Items';
  const groupsSheet = cfg.groupsSheet ?? 'Groups';

  const { itemRows, groupRows } = timelineFileToRows(file);

  await ensureSheetExists(cfg.spreadsheetId, itemsSheet);
  await clearAndWrite(cfg.spreadsheetId, itemsSheet, itemRows);

  if (groupRows) {
    await ensureSheetExists(cfg.spreadsheetId, groupsSheet);
    await clearAndWrite(cfg.spreadsheetId, groupsSheet, groupRows);
  }
}
