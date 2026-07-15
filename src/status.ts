// Built-in item status — a first-class field on every item, mirroring `icon`.
//
// Unlike a per-timeline custom field, `status` is a fixed, universal concept:
// exactly three states, the same for every timeline, defaulting to `Open`. It is
// stored as its own column on `timeline_items` (NOT NULL DEFAULT 'Open'), so it
// round-trips through the DB, the editor, exports and the MCP tools unchanged.
//
// This module is the single source of truth for the value set + default and is
// pure (no DOM), so both the client form and the server data-access layer import
// it — see `src/itemForm.ts` and `scripts/db/timeline-repo.ts`.

export type StatusKey = 'Open' | 'Doing' | 'Done';

// key -> label for the editor dropdown. Labels intentionally match the values
// (the user's chosen vocabulary is English: Open / Doing / Done).
export const ITEM_STATUSES: { key: StatusKey; label: string }[] = [
  { key: 'Open', label: 'Open' },
  { key: 'Doing', label: 'Doing' },
  { key: 'Done', label: 'Done' },
];

// The status every item carries unless explicitly changed.
export const DEFAULT_STATUS: StatusKey = 'Open';

const STATUS_KEYS = new Set<string>(ITEM_STATUSES.map((s) => s.key));

// Accepts a stored/incoming status value and returns a valid key or undefined.
// Case-insensitive on input, but always returns the canonical capitalised key.
export function normalizeStatus(value: unknown): StatusKey | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  for (const { key } of ITEM_STATUSES) {
    if (key.toLowerCase() === v) return key;
  }
  return undefined;
}

// Never-undefined variant: falls back to the default for missing/invalid input.
// Used wherever a column/render needs a concrete status (the field is mandatory).
export function statusOrDefault(value: unknown): StatusKey {
  return normalizeStatus(value) ?? DEFAULT_STATUS;
}
