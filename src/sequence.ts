// Where an item sits in the order a *view* declares, for the items that are in
// it and for the items that hang off one.
//
// A timeline can carry an order its dates do not: one of its notes is a table of
// contents, an agenda, a running order, and the wikilinks in it — read top to
// bottom — are the order the material is meant to be read in. A saved view names
// that note (`SavedView.orderFrom`) and this module turns it into positions.
//
// **The view names it and not the folder**, which is the one thing worth reading
// this file's history for. The order used to be declared once per directory and
// stamped onto every item by the scan, and that could only ever draw one picture:
// the same notes are read for the plan and for the chain of reveals, and those
// want different spines. An order is a way of looking at the material, so it sits
// where the other ways of looking sit.
//
// **Resolved here rather than by the scan**, which is what the move costs and
// buys. It costs a dependency on the link records (`metadata.wikilinks`, so
// `scan.linkEdges`), and that is not a new one: the derivation below has always
// needed them, and the only thing reading these positions is the relation graph,
// which is a picture of links. It buys a reader that can try another order
// without the source being scanned again.
//
// Only the items the order note names get a position, which is the normal case
// rather than a gap — the note lists the spine of the material, and everything
// else is attached to a listed item by a link.
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
import { t } from './i18n';

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
  if (Array.isArray(meta.wikilinks)) {
    // Every field, unlike `orderedIds` below: what a note *mentions* is the whole
    // record, while what a note *lists* is what its own prose puts in a row.
    return linksOf(item).map((l) => l.target);
  }
  const deps = meta.dependsOn;
  if (Array.isArray(deps)) return deps.map(String).filter((s) => s.length > 0);
  if (typeof deps === 'string' && deps.trim()) return [deps.trim()];
  return [];
}

/**
 * The ids one note lists, in the order it lists them: this timeline's spine, as
 * the item named by `SavedView.orderFrom` writes it down.
 *
 * **Body links only** (`field === null`). A frontmatter key is the note's
 * bookkeeping and a link under one is a relation somebody declared, while the
 * order is what the *document* says — the same reading the scan took when it read
 * an order file and skipped its frontmatter. Fenced code is already gone by the
 * time the links are recorded, being quotation rather than reference.
 *
 * First mention wins, so a note listed again further down keeps the position it
 * first had rather than being pushed to the end by a cross-reference. A link out
 * of the folder resolves to nothing and was never recorded, so it takes no
 * position with it and leaves no gap that would read as a deleted item.
 *
 * Empty when the note is not in this timeline, or carries no body links at all —
 * both of which mean the same thing to a reader looking at an unsorted graph, and
 * neither of which is worth telling apart here.
 */
export function orderedIds(
  items: readonly TimelineFileItem[] | undefined,
  orderFrom: string | null | undefined,
): string[] {
  if (!orderFrom) return [];
  const source = (items ?? []).find((item) => item.id === orderFrom);
  if (!source) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const link of linksOf(source)) {
    if (link.field !== null || !link.target || seen.has(link.target)) continue;
    seen.add(link.target);
    out.push(link.target);
  }
  return out;
}

function linksOf(item: TimelineFileItem): { field: string | null; target: string }[] {
  const raw = (item.metadata as Record<string, unknown> | undefined)?.wikilinks;
  if (!Array.isArray(raw)) return [];
  const out: { field: string | null; target: string }[] = [];
  for (const entry of raw) {
    const link = entry as Record<string, unknown> | null;
    const target = link?.target;
    if (typeof target !== 'string' || !target) continue;
    out.push({ field: typeof link?.field === 'string' ? link.field : null, target });
  }
  return out;
}

/**
 * Item id → its position in the order a view declares, stated or inherited.
 *
 * `order` is the id list `orderedIds` produced; positions are 1-based so „has a
 * position" stays distinguishable from „is first" for any caller that treats the
 * value as a number.
 *
 * Empty for every view that declares no order, which is every view saved before
 * this existed and every timeline that is not a folder of notes. Callers use that
 * as the signal to keep doing whatever they did before.
 */
export function sequencePositions(
  items: readonly TimelineFileItem[] | undefined,
  order: readonly string[] = [],
): Map<string, number> {
  const present = new Set<string>();
  for (const item of items ?? []) if (item.id) present.add(item.id);
  const stated = new Map<string, number>();
  for (const id of order) {
    // An id the timeline does not carry takes no position with it, for the reason
    // a link out of the folder never did: a gap in the numbering reads as an item
    // somebody deleted.
    if (!present.has(id) || stated.has(id)) continue;
    stated.set(id, stated.size + 1);
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

// ---------------------------------------------------------------------------
// what a reader may choose

/**
 * How many body links a note needs before it is offered as an order.
 *
 * Two is the smallest number that can state an order at all, and it is what keeps
 * the list readable: on the vault this was built against, 24 of 324 notes clear
 * it while every plausible candidate — the index, the plot pillars, the exported
 * manuscript — sits at the top once they are sorted by link count. A list of all
 * 324 would be a list nobody scrolls, and one built by guessing at names („starts
 * with an underscore") would be a rule about one vault's habits.
 */
const MIN_LINKS = 2;

/** Body links only, which is what `orderedIds` counts. See there for why. */
function bodyLinkCount(item: TimelineFileItem): number {
  return orderedIds([item], item.id).length;
}

/**
 * The notes that could state an order, the longest list first.
 *
 * By link count rather than by name, because „which of these is the table of
 * contents" is answered by how much of the timeline each one lists — and an
 * alphabetical list puts that answer wherever the author's naming happens to put
 * it. The stored choice is offered even when it clears no threshold, for the
 * reason the graph settings offer a group nothing declares: a `<select>` reports
 * its first option for a value it does not have, so a note whose links were
 * removed would silently read as „Keine" and be saved as that.
 */
export function orderChoices(
  items: readonly TimelineFileItem[] | undefined,
  stored: string,
): { value: string; label: string }[] {
  const candidates = (items ?? [])
    .map((item) => ({ item, links: bodyLinkCount(item) }))
    .filter(({ item, links }) => !!item.id && links >= MIN_LINKS)
    .sort((a, b) => b.links - a.links);

  const out = [{ value: '', label: t('order.none') }];
  const add = (id: string, label: string) => {
    if (out.some((c) => c.value === id)) return;
    out.push({ value: id, label: label || id });
  };
  for (const { item } of candidates) add(item.id!, item.content);
  if (stored) {
    const held = (items ?? []).find((i) => i.id === stored);
    add(stored, held?.content ?? stored);
  }
  return out;
}
