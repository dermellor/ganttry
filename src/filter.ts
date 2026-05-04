import type { FilterClause, Note } from './types';

function asArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

function intersects(a: string[], b: string[]): boolean {
  if (b.length === 0) return true;
  const set = new Set(a.map((s) => s.toLowerCase()));
  return b.some((x) => set.has(x.toLowerCase()));
}

function getFm(note: Note, key: string): unknown {
  return (note.frontmatter as Record<string, unknown>)[key];
}

export function matches(note: Note, clause: FilterClause): boolean {
  if (!clause) return true;

  if (clause.filenameContains) {
    const needle = clause.filenameContains.toLowerCase();
    if (!note.filename.toLowerCase().includes(needle)) return false;
  }

  if (clause.folder) {
    const folders = asArray(clause.folder);
    if (folders.length && !folders.some((f) => note.folder === f || note.folder.startsWith(`${f}/`))) {
      return false;
    }
  }

  if (clause.status) {
    const wanted = asArray(clause.status);
    const have = asArray(getFm(note, 'status'));
    if (!intersects(have, wanted)) return false;
  }

  if (clause.categories) {
    const wanted = asArray(clause.categories);
    const have = asArray(getFm(note, 'categories'));
    if (!intersects(have, wanted)) return false;
  }

  if (clause.tags) {
    const wanted = asArray(clause.tags);
    const have = asArray(getFm(note, 'tags'));
    if (!intersects(have, wanted)) return false;
  }

  if (typeof clause.draft === 'boolean') {
    if (Boolean(getFm(note, 'draft')) !== clause.draft) return false;
  }

  if (clause.has) {
    const keys = asArray(clause.has);
    if (!keys.every((k) => getFm(note, k) != null && getFm(note, k) !== '')) return false;
  }

  if (clause.allOf) {
    if (!clause.allOf.every((c) => matches(note, c))) return false;
  }

  if (clause.anyOf) {
    if (!clause.anyOf.some((c) => matches(note, c))) return false;
  }

  if (clause.not) {
    if (matches(note, clause.not)) return false;
  }

  return true;
}

export function resolveGroupBy(note: Note, expr: string | undefined): string | null {
  if (!expr) return null;
  const m = expr.match(/^([a-zA-Z_][\w-]*)(?:\[(\d+)\])?$/);
  if (!m) return null;
  const key = m[1];
  const idx = m[2] != null ? parseInt(m[2], 10) : null;
  let value: unknown;
  if (key === 'folder') value = note.folder;
  else if (key === 'filename') value = note.filename;
  else value = getFm(note, key);
  if (Array.isArray(value)) {
    if (idx != null) value = value[idx];
    else value = value[0];
  }
  if (value == null || value === '') return null;
  return String(value);
}
