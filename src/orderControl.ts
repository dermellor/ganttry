// The toolbar „Reihenfolge" control: which of this timeline's notes states the
// order its material is read in.
//
// A folder of notes carries no order of its own — the filesystem sorts by name,
// the scan sorts by date, and a folder whose notes have no dates has neither. But
// a folder that *has* an order almost always already writes it down, as a table
// of contents, an agenda, a running order. That note is an item like any other,
// and the wikilinks in its body, read top to bottom, are the order. This control
// names it; `src/sequence.ts` turns it into positions.
//
// **It sits in the bar and is saved with the view**, beside „Beziehungen" and for
// the same reason. The order used to be declared once per folder and stamped onto
// every item by the scan, which could only ever draw one picture: the same notes
// are read for the plan and for the chain of reveals, and those want different
// spines. An order is a way of looking at the material, so it belongs with the
// other ways of looking, in the thing that stores them.
//
// **The choices are items, not filenames.** A filename could name something that
// is not in this timeline, and nothing here could tell until the source had been
// scanned again — so somebody correcting a typo would be waiting on a round trip
// to find out whether they had. An item id is a handle the reader can resolve
// with what it already holds.

import { setSelectOptions } from './design-system';
import { els, state, saveOrderFrom } from './state';
import { orderChoices } from './sequence';

/**
 * Rebuild the choices and show the stored one.
 *
 * Hidden where nothing could be chosen, exactly as the edge control hides itself:
 * a JSON or database timeline records no link origins, and a folder read without
 * `linkEdges` has none either — so the panel would open on „Keine" and nothing
 * else. „Keine" alone means the list is empty, since it is always the first entry.
 */
export function syncOrderControl(): void {
  const sel = els.orderFrom;
  if (!sel) return;
  const choices = orderChoices(state.activeSourceFile?.items, state.orderFrom);
  const offerable = choices.length > 1;
  if (els.orderControl) els.orderControl.hidden = !offerable;
  if (!offerable) return;
  setSelectOptions(sel, choices);
  sel.value = state.orderFrom;
}

let wired = false;

export function setupOrderControl(onChange: () => void): void {
  if (wired) return;
  wired = true;
  els.orderFrom?.addEventListener('change', () => {
    state.orderFrom = els.orderFrom!.value;
    saveOrderFrom();
    onChange();
  });
}
