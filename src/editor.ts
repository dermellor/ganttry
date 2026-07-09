import type { TimelineFile, TimelineFileItem, TimelinePhase } from './types';

export type LoadResult = { file: TimelineFile; editable: boolean };

/** Thrown when an item PATCH is rejected because it changed server-side (409). */
export class ConflictError extends Error {
  constructor(message = 'version conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}

async function apiJson(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) throw new ConflictError((data as any).message || 'version conflict');
  if (!res.ok) throw new Error((data as any).error || `HTTP ${res.status}`);
  return data;
}

/** Create a new item; returns the stored item (with version). */
export async function apiAddItem(sourceId: string, item: TimelineFileItem): Promise<TimelineFileItem> {
  return apiJson(
    await fetch(`/api/source/${sourceId}/item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    }),
  );
}

/** Patch an item with optimistic locking. Throws ConflictError on stale version. */
export async function apiUpdateItem(
  sourceId: string,
  itemId: string,
  // Values may be `null` to explicitly clear a column (an omitted key leaves the
  // stored value untouched), so this is wider than Partial<TimelineFileItem>.
  patch: Record<string, unknown>,
  version?: number,
): Promise<TimelineFileItem> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (version != null) headers['If-Match'] = String(version);
  return apiJson(
    await fetch(`/api/source/${sourceId}/item/${itemId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    }),
  );
}

export async function apiDeleteItem(sourceId: string, itemId: string): Promise<void> {
  await apiJson(await fetch(`/api/source/${sourceId}/item/${itemId}`, { method: 'DELETE' }));
}

export async function apiPutPhases(sourceId: string, phases: TimelinePhase[]): Promise<void> {
  await apiJson(
    await fetch(`/api/source/${sourceId}/phases`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phases }),
    }),
  );
}

export async function loadSource(id: string): Promise<LoadResult> {
  // The timeline is served only from the DB via the API. There is deliberately
  // NO static /data/sources fallback: a stale committed snapshot is visually
  // indistinguishable from live data, and it was repeatedly mistaken for the
  // real thing (e.g. a DB outage, or an id mismatch that 404s). Any failure to
  // read from the DB now surfaces loudly instead of silently showing old data.
  const apiRes = await fetch(`/api/source/${id}`).catch(() => null);
  if (apiRes && apiRes.ok) {
    return { file: await apiRes.json(), editable: true };
  }
  const reason = apiRes ? `HTTP ${apiRes.status}` : 'keine Verbindung zur API';
  throw new Error(
    `Timeline „${id}“ konnte nicht aus der DB geladen werden (${reason}). ` +
      `Kein statischer Fallback – veraltete Daten werden bewusst nicht angezeigt.`,
  );
}

export function ensureItemIds(file: TimelineFile): boolean {
  let changed = false;
  const used = new Set(file.items.map((i) => i.id).filter(Boolean) as string[]);
  let counter = 1;
  for (const item of file.items) {
    if (item.id) continue;
    let candidate = `i${counter}`;
    while (used.has(candidate)) {
      counter += 1;
      candidate = `i${counter}`;
    }
    item.id = candidate;
    used.add(candidate);
    changed = true;
  }
  return changed;
}

export function generateNewId(file: TimelineFile, prefix = 'i'): string {
  const used = new Set(file.items.map((i) => i.id).filter(Boolean) as string[]);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

// Date ⇄ calendar-day conversion lives in one place — see src/date.ts. Re-export
// so existing `import { isoDateOnly } from './editor'` call sites keep working.
export { isoDateOnly } from './date';

export function findItemIndex(file: TimelineFile, id: string): number {
  return file.items.findIndex((it) => it.id === id);
}

export function parseDependsOn(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
