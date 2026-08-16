// Where an item sits in the order its source declares, for the items that are in
// it and for the items that hang off one.
//
// A source can state an order its dates do not carry: a directory scan reads the
// folder's order file (`scan.orderFrom`, see scripts/local/scan.ts) and stamps a
// 1-based `metadata.sequence` on every item it names. Only the items the file
// names get one, which is the normal case rather than a gap — the file lists the
// spine of the material, and everything else is attached to a listed item by a
// link.
//
// So a position is derived here as well as read: an item without one takes the
// **lowest** position among the items that link to it. Lowest, because that is
// where it first becomes relevant; taking the highest would put a thing at the end
// of everything that ever mentions it again.
//
// One hop only. Following the derivation onwards, from a derived position to
// whatever that item links to, would let one listed item's position seep through
// an arbitrarily long chain of references and make the whole graph read as if it
// happened at once.
//
// DOM-free and free of client state, like linkEdges.ts, so the rule is unit
// testable and can serve anything server-side that needs it later.

import type { TimelineFileItem } from './types';

/** The metadata key a scan writes the position to. Mirrors `SEQUENCE_KEY` there. */
const SEQUENCE_KEY = 'sequence';

function positionOf(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const raw = (metadata as Record<string, unknown>)[SEQUENCE_KEY];
  const value = typeof raw === 'string' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The ids an item links to, however the source recorded them.
 *
 * `wikilinks` first because it is the richer record and a scan writes both; the
 * flat `dependsOn` is what a hand-written JSON source states and is read as the
 * same thing here. The reader's edge-direction selection is deliberately *not*
 * consulted: which items a note mentions is a fact about the note, while which way
 * an arrow points is a choice about the picture, and a position that flipped with
 * that choice would move the chain's head whenever somebody changed the arrows.
 */
function linkTargetsOf(item: TimelineFileItem): string[] {
  const meta = item.metadata as Record<string, unknown> | undefined;
  if (!meta) return [];
  const links = meta.wikilinks;
  if (Array.isArray(links)) {
    const out: string[] = [];
    for (const entry of links) {
      const target = (entry as Record<string, unknown> | null)?.target;
      if (typeof target === 'string' && target) out.push(target);
    }
    return out;
  }
  const deps = meta.dependsOn;
  if (Array.isArray(deps)) return deps.map(String).filter((s) => s.length > 0);
  if (typeof deps === 'string' && deps.trim()) return [deps.trim()];
  return [];
}

/**
 * Item id → its position in the source's declared order, stated or inherited.
 *
 * Empty for every source that declares no order at all, which is every JSON and
 * database timeline and every folder without an order file. Callers use that as
 * the signal to keep doing whatever they did before.
 */
export function sequencePositions(items: readonly TimelineFileItem[] | undefined): Map<string, number> {
  const stated = new Map<string, number>();
  for (const item of items ?? []) {
    const position = positionOf(item.metadata);
    if (item.id && position !== undefined) stated.set(item.id, position);
  }
  if (!stated.size) return stated;

  const out = new Map(stated);
  for (const item of items ?? []) {
    const from = item.id ? stated.get(item.id) : undefined;
    if (from === undefined) continue;
    for (const target of linkTargetsOf(item)) {
      // A listed item never inherits: it says where it sits, and being mentioned
      // by a later one does not move it.
      if (stated.has(target)) continue;
      const held = out.get(target);
      if (held === undefined || from < held) out.set(target, from);
    }
  }
  return out;
}
