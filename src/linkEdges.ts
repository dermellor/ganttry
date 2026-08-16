// Which of a note's wikilinks become dependency edges, and which way they point.
//
// A directory scan records every wikilink with the frontmatter key it sat under
// (`metadata.wikilinks`, see scripts/local/scan.ts). It records no opinion about
// what a key *means*, because that is not a property of the folder: „Revelations:
// lists what leads to me" and „a link in this sentence leads onwards from me" are
// opposite directions, and the same vault holds both.
//
// This module is where the opinion lives, as a selection the reader sets. It is
// DOM-free and free of client state so the derivation is unit-testable and so the
// same rule serves the client and anything server-side that needs it later
// („Conventions → A rule lives in exactly one place").

import type { TimelineFileItem } from './types';

/**
 * What one link field does. `in` is what the scanner has always produced on
 * `dependsOn` — the linked note leads to this one — and stays the default, so a
 * timeline nobody has configured draws exactly the edges it drew before.
 */
export type EdgeDirection = 'off' | 'in' | 'out';

/** A direction per link field. An absent field falls back to the default. */
export type EdgeSelection = Record<string, EdgeDirection>;

/**
 * The key standing for a link written in the note's body rather than in a
 * frontmatter field. The empty string, because that is the one key YAML cannot
 * meaningfully give a field, so it can never collide with a real one.
 */
export const BODY_FIELD = '';

export const DEFAULT_EDGE_DIRECTION: EdgeDirection = 'in';

const DIRECTIONS = new Set<string>(['off', 'in', 'out']);

export function isEdgeDirection(value: unknown): value is EdgeDirection {
  return typeof value === 'string' && DIRECTIONS.has(value);
}

/** Keep only well-formed entries. A malformed one reads as absent, never as an error. */
export function sanitizeEdgeSelection(raw: unknown): EdgeSelection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: EdgeSelection = {};
  for (const [field, dir] of Object.entries(raw as Record<string, unknown>)) {
    if (isEdgeDirection(dir)) out[field] = dir;
  }
  return out;
}

/** One recorded link, as `metadata.wikilinks` stores it. */
type StoredLink = { field: string | null; target: string };

function linksOf(metadata: unknown): StoredLink[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as Record<string, unknown>).wikilinks;
  if (!Array.isArray(raw)) return [];
  const out: StoredLink[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const target = typeof rec.target === 'string' ? rec.target : '';
    if (!target) continue;
    out.push({ field: typeof rec.field === 'string' ? rec.field : null, target });
  }
  return out;
}

/** Whether any item carries recorded links at all — false for every JSON and DB source. */
export function hasLinkFields(items: readonly TimelineFileItem[] | undefined): boolean {
  return (items ?? []).some((item) => linksOf(item.metadata).length > 0);
}

/**
 * The link fields present in the data, in the order a reader meets them: by first
 * appearance, with the body last because it is not a field anybody wrote.
 *
 * Discovered rather than declared, like the grouping dimension's values: which
 * keys a vault uses is a fact about the vault, and a hard-coded list would be
 * wrong for the first folder that spells one differently.
 */
export function linkFieldsIn(items: readonly TimelineFileItem[] | undefined): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  let body = false;
  for (const item of items ?? []) {
    for (const link of linksOf(item.metadata)) {
      if (link.field === null) {
        body = true;
        continue;
      }
      if (seen.has(link.field)) continue;
      seen.add(link.field);
      fields.push(link.field);
    }
  }
  if (body) fields.push(BODY_FIELD);
  return fields;
}

export function directionOf(selection: EdgeSelection, field: string): EdgeDirection {
  return selection[field] ?? DEFAULT_EDGE_DIRECTION;
}

/** True when the selection says the same thing as no selection at all. */
export function isDefaultEdgeSelection(selection: EdgeSelection): boolean {
  return Object.values(selection).every((dir) => dir === DEFAULT_EDGE_DIRECTION);
}

/**
 * The dependency map the recorded links produce under one selection: item id →
 * the ids it depends on, which is what `metadata.dependsOn` states directly for
 * every other kind of source.
 *
 * `out` is why this takes the whole item list rather than one item's metadata: an
 * outgoing link is an edge recorded on the *linked* item, so a note's own field
 * settings change some other note's dependencies. Deriving per item would silently
 * drop exactly the direction this feature exists to make possible.
 */
export function dependenciesFromLinks(
  items: readonly TimelineFileItem[] | undefined,
  selection: EdgeSelection,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    if (from === to) return;
    const list = out.get(to) ?? [];
    if (list.includes(from)) return;
    list.push(from);
    out.set(to, list);
  };
  for (const item of items ?? []) {
    const id = item.id;
    if (!id) continue;
    for (const link of linksOf(item.metadata)) {
      const dir = directionOf(selection, link.field ?? BODY_FIELD);
      // `in`: the linked note leads to this one, so this one depends on it.
      if (dir === 'in') add(link.target, id);
      // `out`: this note leads to the linked one, so the linked one depends on it.
      else if (dir === 'out') add(id, link.target);
    }
  }
  return out;
}
