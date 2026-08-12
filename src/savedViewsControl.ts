// The „Ansicht" control: apply a saved combination of presentation, grouping and
// filter, or make one out of what is on screen.
//
// It sits at the head of the group it is a shortcut over. „Gruppieren" sets one
// value, „Filter" narrows an extent, and this applies a named bundle of both (plus,
// when the view states one, the presentation) in a single click — so it reads left
// to right as „this whole look, then the parts of it".
//
// The word is deliberate. „Ansicht" became free when the presentation switch was
// renamed to „Darstellung" (see „Darstellungen" in docs/editing.md), and it is what
// comparable products call this in German. In the code it stays `SavedView`,
// because `View` is already the timeline document — the collision is in the
// vocabulary, not in the types.
//
// The rules — who may see one, who may change it, has the current state drifted —
// are in src/savedViews.ts, shared with the server. This module only draws them.

import { Button, MenuItem, MenuSection, Separator, TextInput, el } from './design-system';
import { els, state, saveViewPrefs, setStatus, syncUrl } from './state';
import { apiCreateSavedView, apiDeleteSavedView, apiUpdateSavedView } from './editor';
import {
  canEditSavedView,
  canPublishSavedView,
  savedViewMatches,
  sortSavedViews,
  visibilityOf,
  type SavedViewCaller,
} from './savedViews';
import type { SavedView } from './types';
import { renderListView } from './listView';
import { applyGrouping } from './render';
import type { ViewMode } from './pluginHost/viewMode';

/** Set by `setupSavedViewsControl`: switching presentation belongs to main.ts. */
let applyMode: ((mode: ViewMode) => void) | null = null;

/**
 * What this browser's user may do, as far as the interface can tell.
 *
 * An affordance rather than the permission — every route enforces for itself, and
 * `currentRole` is null on an instance with access control off, which is exactly
 * the instance where everybody past the gate may write anyway. So „no role" reads
 * as „allowed", the same way the server reads it (see `callerOf` in
 * scripts/db/api.ts). Hiding the wrong thing here costs a 403 with a message; the
 * server never trusts what was on screen.
 */
export function currentCaller(): SavedViewCaller {
  const role = state.currentRole;
  return {
    email: state.currentUser?.email ?? null,
    canWrite: role == null || role === 'editor' || role === 'admin',
    canManage: role == null || role === 'admin',
  };
}

/** The saved views of the open timeline, already filtered by the server. */
function views(): SavedView[] {
  return sortSavedViews(state.activeSourceFile?.savedViews ?? []);
}

function activeView(): SavedView | undefined {
  return views().find((v) => v.id === state.activeSavedViewId);
}

/**
 * Can a write reach a server at all?
 *
 * Not „may this person edit items": a `viewer` keeps saved views of their own, and
 * the source being read-only is a different statement again. What decides it is
 * whether this timeline is served by an API — a static local deploy has no
 * endpoint, so its materialized shared views are readable and nothing more.
 */
function writable(): boolean {
  return !!state.activeSourceId && state.activeSourceEditable;
}

/** Has the display drifted away from the applied view? */
function drifted(view: SavedView): boolean {
  return !savedViewMatches(view, {
    mode: state.viewMode,
    groupBy: state.groupBy,
    filters: state.filters,
  });
}

function closeMenu(): void {
  els.savedViewsMenu.hidden = true;
  els.savedViewsToggle.setAttribute('aria-expanded', 'false');
  // A half-typed name does not survive the panel: reopening it should offer the
  // list, not a field somebody left behind three clicks ago.
  naming = null;
}

/**
 * Apply one, in the order that repaints once: the values first, the presentation
 * second, the repaint last.
 *
 * Setting the mode through main.ts's own `applyViewMode` rather than reproducing
 * it is what keeps a plugin view working here — that function resolves the mode
 * against the plugins this timeline has, hides the accessories the presentation
 * does not declare and lazy-loads its chunk. A copy of it in this module would be
 * the second place that has to learn about the next presentation.
 */
export function applySavedView(view: SavedView): void {
  if (view.groupBy) state.groupBy = view.groupBy;
  // Assigned unconditionally, unlike the two beside it: an absent `filters` is the
  // empty selection rather than „leave the filter alone" (see `savedViewMatches`),
  // so applying a view somebody saved without a narrowing has to clear one.
  state.filters = { ...(view.filters ?? {}) };
  state.activeSavedViewId = view.id;
  if (view.mode && view.mode !== state.viewMode && applyMode) applyMode(view.mode as ViewMode);
  else saveViewPrefs();
  if (state.viewMode === 'list') renderListView();
  else applyGrouping();
  // After the mode, not before: `applyViewMode` writes the hash from `state`, and
  // it runs before `activeSavedViewId` has been read back into it. Without this the
  // link is missing exactly the parameter the applied view is about — which reads
  // as "sharing does not work" rather than as a missing call.
  syncUrl();
  syncSavedViewsControl();
}

/** Everything the current display would be stored as. */
function currentAsView(name: string): Record<string, unknown> {
  return {
    name,
    mode: state.viewMode,
    groupBy: state.groupBy,
    filters: state.filters,
  };
}

async function write(action: () => Promise<unknown>, done: string): Promise<void> {
  try {
    await action();
    setStatus(done);
  } catch (e) {
    // The server's own message, not a generic failure: a refusal here says „this
    // needs write access" or „this belongs to somebody else", and both are things
    // the reader can act on.
    setStatus(`Ansicht: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Replace the loaded timeline's list without a reload, so the picker follows. */
function upsertLocal(view: SavedView): void {
  const file = state.activeSourceFile;
  if (!file) return;
  const rest = (file.savedViews ?? []).filter((v) => v.id !== view.id);
  file.savedViews = [...rest, view];
}

function removeLocal(viewId: string): void {
  const file = state.activeSourceFile;
  if (!file?.savedViews) return;
  file.savedViews = file.savedViews.filter((v) => v.id !== viewId);
}

/**
 * Which name is being typed, if any: `create` for a new view, `rename` for the
 * active one.
 *
 * A field in the panel rather than `window.prompt`, which is what this started as.
 * A native dialog is suppressed outright in an embedded browser — the call
 * returns null and the action silently does nothing — and naming a view is the
 * primary flow here, not a corner like the body editor's link URL. It is also
 * what the design system asks for: interface is built from the components.
 */
let naming: 'create' | 'rename' | null = null;

async function saveAsNew(name: string): Promise<void> {
  const sourceId = state.activeSourceId;
  if (!sourceId) return;
  await write(async () => {
    const stored = (await apiCreateSavedView(sourceId, currentAsView(name))) as SavedView;
    upsertLocal(stored);
    state.activeSavedViewId = stored.id;
    syncUrl();
    syncSavedViewsControl();
  }, `Ansicht „${name}" gespeichert.`);
}

/**
 * The name field, plus the two ways out of it.
 *
 * Enter commits and Escape cancels, because a one-field form in a popover is a
 * keyboard interaction before it is a button one — and the button is there anyway
 * for whoever reaches for the pointer.
 */
function nameForm(kind: 'create' | 'rename', current?: SavedView): HTMLElement {
  const input = TextInput({
    value: kind === 'rename' ? (current?.name ?? '') : '',
    placeholder: 'Name der Ansicht',
    attrs: { 'aria-label': kind === 'rename' ? 'Neuer Name' : 'Name der neuen Ansicht' },
  });
  const commit = () => {
    const name = input.value.trim();
    if (!name) return;
    naming = null;
    closeMenu();
    if (kind === 'create') void saveAsNew(name);
    else void updateActive({ name }, `Ansicht heißt jetzt „${name}".`);
  };
  const cancel = () => {
    naming = null;
    syncSavedViewsControl();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      // Stopped here rather than left to bubble: Escape in the field means „drop
      // the name", not „close the panel I am typing in".
      e.stopPropagation();
      cancel();
    }
  });
  const save = Button({ label: 'Speichern', variant: 'primary', size: 'sm', on: { click: commit } });
  // Focused after the caller has mounted it, since an element outside the document
  // cannot take focus.
  queueMicrotask(() => input.focus());
  return el('div', { class: 'saved-view-name' }, [input, save]);
}

async function updateActive(patch: Record<string, unknown>, done: string): Promise<void> {
  const sourceId = state.activeSourceId;
  const view = activeView();
  if (!sourceId || !view) return;
  await write(async () => {
    const stored = (await apiUpdateSavedView(sourceId, view.id, patch, view.version)) as SavedView;
    upsertLocal(stored);
    syncSavedViewsControl();
  }, done);
}

async function deleteActive(): Promise<void> {
  const sourceId = state.activeSourceId;
  const view = activeView();
  if (!sourceId || !view) return;
  if (!confirm(`Ansicht „${view.name}" wirklich löschen?`)) return;
  await write(async () => {
    await apiDeleteSavedView(sourceId, view.id);
    removeLocal(view.id);
    state.activeSavedViewId = null;
    // The hash goes with it: a link left naming a deleted view is one that opens
    // the timeline and quietly does nothing, which reads as the link being broken.
    syncUrl();
    syncSavedViewsControl();
  }, `Ansicht „${view.name}" gelöscht.`);
}

/** The row for one saved view: its name, whether it is shared, whether it is on. */
function viewRow(view: SavedView): HTMLButtonElement {
  return MenuItem({
    label: view.name,
    checked: view.id === state.activeSavedViewId,
    // „geteilt" rather than an icon: the list is read as text, and this is the one
    // fact about a view that changes who else is affected by editing it.
    detail: visibilityOf(view) === 'instance' ? 'geteilt' : undefined,
    on: {
      click: () => {
        closeMenu();
        applySavedView(view);
      },
    },
  });
}

/**
 * Rebuild the panel and the trigger's label.
 *
 * Rebuilt wholesale on every sync, unlike the filter panel next door: that one
 * holds checkboxes somebody is in the middle of ticking, so replacing its DOM
 * would close it under the pointer. This one is a list of commands, and every
 * command closes the menu anyway.
 */
export function syncSavedViewsControl(): void {
  if (!els.savedViewsMenu) return;
  // A repaint must not pull the field out from under somebody halfway through a
  // name. The filter panel next door guards its DOM the same way, for the same
  // reason — there it is a checkbox under the pointer.
  //
  // Keyed on the input itself, not on „focus is somewhere in the panel": the click
  // that OPENS the field leaves focus on the menu row it came from, and the wider
  // test therefore skipped the very render that was supposed to draw the field.
  const typing = els.savedViewsMenu.querySelector('.saved-view-name input');
  if (naming && typing && typing === document.activeElement) return;
  const all = views();
  const active = activeView();
  const caller = currentCaller();
  const canSave = writable();

  // Nothing saved and nothing savable — a static local timeline that carries no
  // shared views — leaves the control with neither a list nor an action, so it
  // says so by disappearing rather than by opening an empty panel. Same rule the
  // filter follows when a timeline offers no dimension.
  const offerable = all.length > 0 || canSave;
  els.savedViewsControl.hidden = !offerable;
  if (!offerable) {
    closeMenu();
    return;
  }

  const isDrifted = !!active && drifted(active);
  els.savedViewsToggle.textContent = active
    ? `${active.name}${isDrifted ? ' *' : ''}`
    : 'Keine Ansicht';
  // The asterisk says „what you see is no longer what this view stores", which is
  // the difference between „I am looking at Q3" and „I started from Q3". Without
  // it, saving over a view is a guess about what is in it.
  els.savedViewsToggle.title = isDrifted
    ? `„${active!.name}" mit ungespeicherten Änderungen`
    : '';

  const children: Element[] = [];
  if (all.length) {
    children.push(MenuSection({ label: 'Ansichten', children: all.map(viewRow) }));
  }
  if (active) {
    children.push(
      MenuItem({
        label: 'Ansicht verlassen',
        none: true,
        on: {
          click: () => {
            closeMenu();
            state.activeSavedViewId = null;
            syncUrl();
            syncSavedViewsControl();
          },
        },
      }),
    );
  }

  const actions: Element[] = [];
  if (canSave) {
    actions.push(
      MenuItem({
        label: 'Aktuelle Einstellung speichern…',
        on: {
          click: () => {
            naming = 'create';
            syncSavedViewsControl();
          },
        },
      }),
    );
  }
  if (active && canSave && canEditSavedView(active, caller)) {
    if (isDrifted) {
      actions.push(
        MenuItem({
          label: `„${active.name}" aktualisieren`,
          on: {
            click: () => {
              closeMenu();
              void updateActive(currentAsView(active.name), `Ansicht „${active.name}" aktualisiert.`);
            },
          },
        }),
      );
    }
    actions.push(
      MenuItem({
        label: 'Umbenennen…',
        on: {
          click: () => {
            naming = 'rename';
            syncSavedViewsControl();
          },
        },
      }),
    );
    if (canPublishSavedView(caller)) {
      const shared = visibilityOf(active) === 'instance';
      actions.push(
        MenuItem({
          label: shared ? 'Nicht mehr teilen' : 'Mit allen teilen',
          on: {
            click: () => {
              closeMenu();
              void updateActive(
                { visibility: shared ? 'private' : 'instance' },
                shared ? 'Ansicht ist wieder privat.' : 'Ansicht ist für alle sichtbar.',
              );
            },
          },
        }),
      );
    }
    actions.push(
      MenuItem({
        label: 'Löschen',
        danger: true,
        on: {
          click: () => {
            closeMenu();
            void deleteActive();
          },
        },
      }),
    );
  }
  if (actions.length) {
    if (children.length) children.push(Separator({}));
    children.push(MenuSection({ children: actions }));
  }
  if (naming) {
    children.push(Separator({}));
    children.push(nameForm(naming, active));
  }
  els.savedViewsMenu.replaceChildren(...children);
}

let wired = false;

export function setupSavedViewsControl(onMode: (mode: ViewMode) => void): void {
  applyMode = onMode;
  if (wired) return;
  wired = true;

  els.savedViewsToggle.addEventListener('click', () => {
    const open = els.savedViewsMenu.hidden;
    if (!open) {
      closeMenu();
      return;
    }
    naming = null;
    syncSavedViewsControl();
    els.savedViewsMenu.hidden = false;
    els.savedViewsToggle.setAttribute('aria-expanded', 'true');
  });

  // Dismissal on an outside click, tested against the event's PATH rather than
  // against `contains(e.target)`.
  //
  // A row in this panel rebuilds the panel (picking „speichern…" swaps the list
  // for a name field), so by the time this listener runs the clicked button has
  // already been replaced and is no longer a descendant of anything. `contains`
  // then reads that as a click outside and closes the panel the click just
  // opened a field in. The path is captured at dispatch and still names the
  // control.
  document.addEventListener('click', (e) => {
    if (els.savedViewsMenu.hidden) return;
    const path = e.composedPath();
    const inside = path.length
      ? path.includes(els.savedViewsControl)
      : els.savedViewsControl.contains(e.target as Node);
    if (!inside) closeMenu();
  });
}
