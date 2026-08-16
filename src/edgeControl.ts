// The toolbar "Beziehungen" control: one popover with a row per link field the
// active timeline carries, each set to off, incoming or outgoing.
//
// It exists because a directory scan cannot know what a link field means. The
// scanner records where each wikilink came from (`metadata.wikilinks`) and stops
// there; this is where a reader says that `Revelations:` lists what leads *to* a
// note while a link in the note's text leads onwards from it. Until this control
// existed both pointed the same way, which reversed half the graph without
// reporting anything — explanatory links added to a note's body restored the very
// edges that had just been deleted from its frontmatter.
//
// The rule itself is in linkEdges.ts (DOM-free, unit-tested) and the derivation
// runs in buildFromJson, so the timeline's arrows and the graph read one
// dependency map rather than each computing their own.

import { MenuSection, SegmentedControl } from './design-system';
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

const DIRECTIONS: EdgeDirection[] = ['off', 'in', 'out'];

/** A field's own name is the vault author's word; only the body row is ours to name. */
function fieldLabel(field: string): string {
  return field === BODY_FIELD ? t('edges.body') : field;
}

function updateToggleLabel(fields: string[]): void {
  const changed = fields.filter((f) => directionOf(state.edges, f) !== DEFAULT_EDGE_DIRECTION);
  const drawn = fields.length - changed.filter((f) => directionOf(state.edges, f) === 'off').length;
  els.edgeToggle.textContent =
    changed.length === 0 ? t('edges.all') : t('edges.count', { count: drawn });
  // A narrowed or reversed selection is worth seeing without opening the panel:
  // it explains a picture that would otherwise look like missing relations.
  els.edgeToggle.dataset.active = changed.length > 0 ? 'true' : 'false';
}

function closeMenu(): void {
  els.edgeMenu.hidden = true;
  els.edgeToggle.setAttribute('aria-expanded', 'false');
}

/**
 * Reflect the active timeline's link fields into the panel. Rebuilt only when the
 * set of fields changes (keyed by a signature), so a repaint does not close the
 * panel under the pointer of anyone using it — the same arrangement the filter
 * control uses, and for the same reason.
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

  const sig = fields.join('␟');
  if (els.edgeMenu.dataset.sig !== sig) {
    els.edgeMenu.replaceChildren(
      ...fields.map((field) =>
        MenuSection({
          attrs: { 'data-field': field },
          children: [
            SegmentedControl({
              label: fieldLabel(field),
              segments: DIRECTIONS.map((dir) => ({
                value: dir,
                label: t(`edges.${dir}`),
                selected: directionOf(state.edges, field) === dir,
              })),
            }),
          ],
        }),
      ),
    );
    els.edgeMenu.dataset.sig = sig;
  } else {
    // Same fields, a different selection (a stored one just loaded, or a saved
    // view applied): re-press the segments without touching the DOM structure.
    for (const section of els.edgeMenu.querySelectorAll<HTMLElement>('[data-field]')) {
      const field = section.dataset.field ?? '';
      for (const seg of section.querySelectorAll<HTMLButtonElement>('.ds-Segment')) {
        seg.setAttribute('aria-pressed', String(seg.dataset.value === directionOf(state.edges, field)));
      }
    }
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
    const seg = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.ds-Segment');
    const section = seg?.closest<HTMLElement>('[data-field]');
    if (!seg || !section) return;
    const field = section.dataset.field ?? '';
    const dir = seg.dataset.value;
    if (dir !== 'off' && dir !== 'in' && dir !== 'out') return;
    state.edges = { ...state.edges, [field]: dir };
    saveEdgeSelection();
    for (const other of section.querySelectorAll<HTMLButtonElement>('.ds-Segment')) {
      other.setAttribute('aria-pressed', String(other === seg));
    }
    updateToggleLabel(linkFieldsIn(state.activeSourceFile?.items));
    // A full rebuild, not a filter pass: the dependency map is computed in
    // buildFromJson, so the edges only change once the build is redone.
    applyEdgeSelection();
  });

  document.addEventListener('click', (e) => {
    if (els.edgeMenu.hidden) return;
    if (!els.edgeControl.contains(e.target as Node)) closeMenu();
  });
}
