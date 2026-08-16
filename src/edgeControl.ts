// The toolbar "Beziehungen" control: the link fields the active timeline carries,
// grouped under the direction they draw in.
//
// It exists because a directory scan cannot know what a link field means. The
// scanner records where each wikilink came from (`metadata.wikilinks`) and stops
// there; this is where a reader says that `Revelations:` lists what leads *to* a
// note while a link in the note's text leads onwards from it. Until this control
// existed both pointed the same way, which reversed half the graph without
// reporting anything — explanatory links added to a note's body restored the very
// edges that had just been deleted from its frontmatter.
//
// **Grouped rather than a row of switches**, which is what it was first: with a
// control per field the panel repeated „Aus / Eingehend / Ausgehend" once per row,
// thirteen times on the vault this was built against, and the three options
// started at a different x on every row because the field name sat inside the
// control. Sections turn the same state into a picture of what the graph is built
// from, and the words appear once each, as the headings. What it costs is that
// setting a field is a click that *moves* it: the direction cycles, and the
// heading it lands under is the confirmation.
//
// The rule itself is in linkEdges.ts (DOM-free, unit-tested) and the derivation
// runs in buildFromJson, so the timeline's arrows and the graph read one
// dependency map rather than each computing their own.

import { Chip, MenuSection } from './design-system';
import { state, els, saveEdgeSelection } from './state';
import { applyEdgeSelection } from './render';
import {
  directionOf,
  linkFieldsIn,
  BODY_FIELD,
  DEFAULT_EDGE_DIRECTION,
  type EdgeDirection,
} from './linkEdges';

import { t } from './i18n';

/**
 * The order the sections appear in, and the order a click cycles through.
 *
 * Drawing directions first and `off` last, so the two sections that produce a
 * picture sit together at the top and the discarded fields collect at the bottom.
 */
const SECTIONS: EdgeDirection[] = ['in', 'out', 'off'];

const NEXT: Record<EdgeDirection, EdgeDirection> = { in: 'out', out: 'off', off: 'in' };

/** A field's own name is the vault author's word; only the body row is ours to name. */
function fieldLabel(field: string): string {
  return field === BODY_FIELD ? t('edges.body') : field;
}

function updateToggleLabel(fields: string[]): void {
  const drawn = fields.filter((f) => directionOf(state.edges, f) !== 'off');
  const changed = fields.some((f) => directionOf(state.edges, f) !== DEFAULT_EDGE_DIRECTION);
  els.edgeToggle.textContent =
    changed ? t('edges.count', { count: drawn.length }) : t('edges.all');
  // A narrowed or reversed selection is worth seeing without opening the panel:
  // it explains a picture that would otherwise look like missing relations.
  els.edgeToggle.dataset.active = changed ? 'true' : 'false';
}

function closeMenu(): void {
  els.edgeMenu.hidden = true;
  els.edgeToggle.setAttribute('aria-expanded', 'false');
}

function render(fields: string[]): void {
  els.edgeMenu.replaceChildren(
    ...SECTIONS.map((dir) =>
      MenuSection({
        label: t(`edges.${dir}`),
        attrs: { 'data-direction': dir },
        wrap: true,
        children: fields
          .filter((field) => directionOf(state.edges, field) === dir)
          .map((field) =>
            Chip({
              label: fieldLabel(field),
              action: true,
              attrs: { 'data-field': field },
            }),
          ),
      }),
    ),
  );
}

/**
 * Reflect the active timeline's link fields into the panel.
 *
 * Rebuilt whenever the fields or the selection change — unlike the filter panel,
 * whose checkboxes can be re-ticked in place, a chip's section *is* its value, so
 * there is nothing to update without moving it. Keyed by both, so a repaint that
 * changes neither leaves the panel alone rather than replacing it under the
 * pointer of anyone using it.
 */
export function syncEdgeControl(): void {
  if (!els.edgeMenu) return;
  const fields = linkFieldsIn(state.activeSourceFile?.items);

  // A source that records no link origins has nothing to choose between: JSON and
  // database timelines state their dependencies outright, and a folder read
  // without `linkEdges` has none. The control says so by disappearing rather than
  // by opening an empty panel.
  const offerable = fields.length > 0;
  els.edgeToggle.hidden = !offerable;
  if (!offerable) {
    closeMenu();
    return;
  }

  const sig = fields.map((f) => `${f}␟${directionOf(state.edges, f)}`).join('§');
  if (els.edgeMenu.dataset.sig !== sig) {
    render(fields);
    els.edgeMenu.dataset.sig = sig;
  }
  updateToggleLabel(fields);
}

let wired = false;

export function setupEdgeControl(): void {
  if (wired) return;
  wired = true;

  els.edgeToggle.addEventListener('click', () => {
    const open = els.edgeMenu.hidden;
    els.edgeMenu.hidden = !open;
    els.edgeToggle.setAttribute('aria-expanded', String(open));
  });

  els.edgeMenu.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-field]');
    if (!chip) return;
    const field = chip.dataset.field ?? '';
    state.edges = { ...state.edges, [field]: NEXT[directionOf(state.edges, field)] };
    saveEdgeSelection();
    const fields = linkFieldsIn(state.activeSourceFile?.items);
    render(fields);
    els.edgeMenu.dataset.sig = fields.map((f) => `${f}␟${directionOf(state.edges, f)}`).join('§');
    // Focus follows the chip to its new section, so a keyboard user is not
    // returned to the top of the panel by their own click.
    els.edgeMenu.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`)?.focus();
    updateToggleLabel(fields);
    // A full rebuild, not a filter pass: the dependency map is computed in
    // buildFromJson, so the edges only change once the build is redone.
    applyEdgeSelection();
  });

  document.addEventListener('click', (e) => {
    if (els.edgeMenu.hidden) return;
    const target = e.target as Node;
    // A chip click rebuilds the sections before this handler runs, so the node
    // that was clicked is already detached — and a detached node is contained by
    // nothing, which reads as an outside click and closed the panel on the one
    // interaction it exists for. The filter panel never hit this because its
    // checkboxes are re-ticked in place rather than replaced.
    if (!target.isConnected) return;
    if (!els.edgeControl.contains(target)) closeMenu();
  });
}
