// The filter selection as one hash parameter: `f=status:Open,Done;cf%3Atier:Free`.
//
// The extent of a presentation is „private per person, shared by copying the link"
// (docs/information-architecture.md), and that was true for the visible window and
// false for the filter: the window travelled as `from`/`to`, the selection travelled
// not at all. `m=1` used to be the one exception, and folding „nur Meilensteine" into
// the type dimension took it with it.
//
// Three things decided the format, in this order:
//
//   1. **It has to carry several dimensions with several values each.** Hence two
//      separators, `;` between dimensions and `,` between values, with `:` between a
//      dimension and its own.
//   2. **A shared link must not be frightening.** A base64 blob would round-trip
//      perfectly and tell the person pasting it nothing. Dimension keys and values
//      stay legible for the ASCII names that make up almost all of them.
//   3. **A value may contain any of the separators.** Each key and value is therefore
//      percent-encoded on its own (`encodeURIComponent` escapes `:`, `,` and `;`), and
//      the separators are the only literal ones in the parameter. That is also why
//      this parameter is read out of the RAW hash rather than through
//      `URLSearchParams`: that decodes percent-escapes before anything can split on
//      the separators, so a value containing a comma would arrive as two values.
//
// DOM-free, like `filterRule.ts` beside it, so the round trip is unit-testable
// without a browser.

import { activeFilterDims, type FilterSelection } from './filterRule';

/** The hash key. Short, because it sits in every shared link that narrows anything. */
export const FILTER_PARAM = 'f';

/**
 * The selection as a parameter value, already percent-encoded — ready to be written
 * into the hash verbatim rather than encoded a second time.
 *
 * Dimensions keep the selection's own order, which is the order they were narrowed
 * in: it makes a link diffable against the one somebody sent before.
 */
export function encodeFilterSelection(filters: FilterSelection): string {
  return activeFilterDims(filters)
    .map((dim) => {
      const values = filters[dim].map((v) => encodeURIComponent(v)).join(',');
      return `${encodeURIComponent(dim)}:${values}`;
    })
    .join(';');
}

/**
 * Read a parameter value back. Anything unparseable is skipped rather than thrown:
 * a hand-edited or truncated link has to open the timeline, and the pieces that do
 * parse are still what the sender meant.
 *
 * A dimension the receiving timeline does not have survives this step and is dropped
 * on the first paint by `pruneFilters`, per dimension — the same pruning the panel
 * applies to a stored selection. Deciding it here would need the build.
 */
export function decodeFilterSelection(raw: string | null | undefined): FilterSelection {
  if (!raw) return {};
  const out: FilterSelection = {};
  for (const part of raw.split(';')) {
    const at = part.indexOf(':');
    if (at <= 0) continue;
    const dim = decodeComponent(part.slice(0, at));
    if (!dim) continue;
    const values = part
      .slice(at + 1)
      .split(',')
      .map(decodeComponent)
      .filter((v) => v !== '');
    if (!values.length) continue;
    // A repeated dimension unions rather than replaces: within one dimension the
    // values are OR-ed anyway, so `status:Open;status:Done` most plausibly means
    // both — and „the last one wins" would silently drop half of a hand-typed link.
    const kept = out[dim] ?? [];
    for (const value of values) if (!kept.includes(value)) kept.push(value);
    out[dim] = kept;
  }
  return out;
}

/**
 * `decodeURIComponent` that answers „" on a malformed escape instead of throwing.
 * A truncated link (`%2`) is the realistic case, and it must not take the whole
 * selection with it.
 */
function decodeComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}
