import type { TimelineFile, TimelineFileItem } from './types';

export async function loadSourceFromApi(id: string): Promise<TimelineFile> {
  const res = await fetch(`/api/source/${id}`);
  if (!res.ok) throw new Error(`Load failed (${res.status})`);
  return res.json();
}

export async function saveSourceToApi(id: string, file: TimelineFile): Promise<void> {
  const res = await fetch(`/api/source/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(file, null, 2),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Save failed (${res.status})`);
  }
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

export function isoDateOnly(value: Date | string | number | null | undefined): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return new Date(value).toISOString().slice(0, 10);
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return '';
}

export function findItemIndex(file: TimelineFile, id: string): number {
  return file.items.findIndex((it) => it.id === id);
}

export function parseDependsOn(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
