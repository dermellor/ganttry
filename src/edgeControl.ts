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
// from, and the words appear once each, as the headings.
//
// **A field moves by being dragged into another section**, and that replaced a
// click that cycled the direction. The cycle was the same mistake in a new shape:
// a chip looks like a value rather than a control, so nothing said a click would
// do anything — let alone something different depending on where the chip already
// sat. Dragging is the one interaction whose meaning is the layout itself.
// Arrow keys do the same thing for anybody not using a pointer, since a drag has
// no keyboard equivalent of its own and „only reachable with a mouse" is how a
// control ends up unusable without any signal that it is.
//
// The rule itself is in linkEdges.ts (DOM-free, unit-tested) and the derivation
// runs in buildFromJson, so the timeline's arrows and the graph read one
// dependency map rather than each computing their own.

import { Chip, MenuSection } from './design-system';
import { viewAccessories } from './pluginHost/manifest';
import { isBuiltinViewMode } from './pluginHost/viewMode';
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

/** A field's own name is the vault author's word; only the body row is ours to name. */
function fieldLabel(field: string): string {
  return field === BODY_FIELD ? t('edges.body') : field;
}

/**
 * „<field>, <direction>". The chip shows only the field, and where it sits is the
 * other half of its value — which is exactly the half somebody arriving by
 * keyboard cannot see.
 */
function chipName(field: string, dir: EdgeDirection): string {
  return `${fieldLabel(field)}, ${t(`edges.${dir}`)}`;
}

function setDirection(field: string, dir: EdgeDirection): void {
  if (directionOf(state.edges, field) === dir) return;
  state.edges = { ...state.edges, [field]: dir };
  saveEdgeSelection();
  const fields = linkFieldsIn(state.activeSourceFile?.items);
  render(fields);
  els.edgeMenu.dataset.sig = signature(fields);
  // Focus follows the chip to its new section, so a keyboard user is not left on
  // a node that no longer exists and dropped back to the top of the panel.
  els.edgeMenu.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`)?.focus();
  updateToggleLabel(fields);
  // A full rebuild, not a filter pass: the dependency map is computed in
  // buildFromJson, so the edges only change once the build is redone.
  applyEdgeSelection();
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

/**
 * Drop the drag treatment from every node carrying one.
 *
 * By selector rather than by remembering what was marked: a drop rebuilds the
 * sections, so the nodes marked at `dragstart` are gone by the time this runs, and
 * a stale reference would leave the dashed outlines on the new ones forever.
 */
function clearDragMarks(): void {
  const marked = els.edgeMenu.querySelectorAll<HTMLElement>(
    '[data-dragging], [data-dropping], [data-droppable]',
  );
  for (const node of marked) {
    delete node.dataset.dragging;
    delete node.dataset.dropping;
    delete node.dataset.droppable;
  }
}

function signature(fields: string[]): string {
  return fields.map((f) => `${f}␟${directionOf(state.edges, f)}`).join('§');
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
              movable: true,
              movableLabel: chipName(field, dir),
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

  // Two conditions, and the second is the presentation's own answer rather than a
  // second opinion about it: `viewAccessories` is what main.ts asks on a view
  // switch, and it has to be asked again here because every repaint of a built-in
  // view lands in this function — reading only the fields would put the control
  // back into the list on the next render.
  //
  // A source that records no link origins has nothing to choose between: JSON and
  // database timelines state their dependencies outright, and a folder read
  // without `linkEdges` has none. The control says so by disappearing rather than
  // by opening an empty panel.
  //
  // The caption goes with the trigger. Hiding only the button left „Beziehungen"
  // standing alone in the bar of every JSON and database timeline, which reads as
  // a control that failed to load rather than as one that does not apply.
  const applies = isBuiltinViewMode(state.viewMode)
    ? viewAccessories(state.viewMode).edges
    : false;
  const offerable = applies && fields.length > 0;
  els.edgeControl.hidden = !offerable;
  els.edgeToggle.hidden = !offerable;
  if (!offerable) {
    closeMenu();
    return;
  }

  const sig = signature(fields);
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

  // The field being dragged, kept here as well as in the drag payload: Safari
  // withholds `dataTransfer.getData` outside the drop handler, so the highlight
  // that follows the pointer has nothing to read from the event itself.
  let dragging: string | null = null;

  els.edgeMenu.addEventListener('dragstart', (e) => {
    const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-field]');
    if (!chip) return;
    dragging = chip.dataset.field ?? '';
    e.dataTransfer?.setData('text/plain', dragging);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    chip.dataset.dragging = 'true';
    // Every section marked at once, including the one the chip is leaving. Marking
    // only what the pointer is over says nothing until the pointer has already
    // arrived — and where a chip *may* go is the question a drag opens, so the
    // answer has to be on screen before the first move.
    for (const section of els.edgeMenu.querySelectorAll<HTMLElement>('[data-direction]')) {
      section.dataset.droppable = 'true';
    }
  });

  els.edgeMenu.addEventListener('dragend', () => {
    dragging = null;
    clearDragMarks();
  });

  els.edgeMenu.addEventListener('dragover', (e) => {
    const section = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-direction]');
    if (!section || dragging === null) return;
    // Without this the browser refuses the drop, and a chip that springs back is
    // indistinguishable from one the panel would not accept.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    for (const other of els.edgeMenu.querySelectorAll<HTMLElement>('[data-dropping]')) {
      if (other !== section) delete other.dataset.dropping;
    }
    section.dataset.dropping = 'true';
  });

  els.edgeMenu.addEventListener('dragleave', (e) => {
    const section = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-direction]');
    // `relatedTarget` is where the pointer went; leaving for a child of the same
    // section is not leaving the section, and clearing on it makes the highlight
    // flicker across every chip inside.
    if (section && !section.contains(e.relatedTarget as Node)) delete section.dataset.dropping;
  });

  els.edgeMenu.addEventListener('drop', (e) => {
    const section = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-direction]');
    const dir = section?.dataset.direction;
    const field = dragging ?? e.dataTransfer?.getData('text/plain') ?? null;
    dragging = null;
    if (!section) return;
    e.preventDefault();
    // Before the move, not after: `setDirection` replaces these nodes, and
    // clearing afterwards would strip the marks off the freshly rendered
    // sections while `dragend` never reaches the ones that are gone.
    clearDragMarks();
    if (field === null || (dir !== 'in' && dir !== 'out' && dir !== 'off')) return;
    setDirection(field, dir);
  });

  // The keyboard path. A drag has no equivalent of its own, and the arrow keys are
  // what every reorderable list uses, so a focused chip moves to the neighbouring
  // section rather than needing a control of its own beside it.
  els.edgeMenu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-field]');
    if (!chip) return;
    const field = chip.dataset.field ?? '';
    const at = SECTIONS.indexOf(directionOf(state.edges, field));
    const next = SECTIONS[at + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    // Only once a move is actually possible: swallowing the key at either end
    // would trap the panel's scroll on the first and last section.
    e.preventDefault();
    setDirection(field, next);
  });

  document.addEventListener('click', (e) => {
    if (els.edgeMenu.hidden) return;
    const target = e.target as Node;
    // A move rebuilds the sections before this handler runs, so the node that was
    // clicked may already be detached — and a detached node is contained by
    // nothing, which reads as an outside click and closes the panel on the one
    // interaction it exists for. The filter panel never hit this because its
    // checkboxes are re-ticked in place rather than replaced.
    if (!target.isConnected) return;
    if (!els.edgeControl.contains(target)) closeMenu();
  });
}
