// The „Ansicht" control: apply a saved combination of presentation, grouping and
// filter, or make one out of what is on screen.
//
// It sits at the head of the group it is a shortcut over. „Gruppieren" sets one
// value, „Filter" narrows an extent, and this applies a named bundle of both (plus,
// when the view states one, the presentation) in a single click — so it reads left
// to right as „this whole look, then the parts of it".
//
// **It is a mark rather than a labelled control, and that is a space decision made
// against measurement.** With a plugin contributing a control of its own, the bar
// wraps onto a second row below ~1000px as it is; a third „LABEL [Wert ▾]" pair
// pushed that to ~1200px, which is a 13" window. Resting, this is one 30px box; it
// grows the applied view's name and the caret only while a view is applied — see
// `setTrigger`. The cost is honest and was accepted with the shape: a mark says
// less about what it opens than a caption does, and „Ansicht" is a word the panel
// has to carry instead.
//
// The word is deliberate. „Ansicht" became free when the presentation switch was
// renamed to „Darstellung" (see „Darstellungen" in docs/editing.md), and it is what
// comparable products call this in German. In the code it stays `SavedView`,
// because `View` is already the timeline document — the collision is in the
// vocabulary, not in the types.
//
// The rules — who may see one, who may change it, has the current state drifted —
// are in src/savedViews.ts, shared with the server. This module only draws them.

import {
  Button,
  Checkbox,
  Dialog,
  el,
  Field,
  FormActions,
  FormGrid,
  Icon,
  IconButton,
  MenuItem,
  MenuSection,
  Separator,
  TextInput,
} from './design-system';
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
  naming = false;
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
  // The two above are set BEFORE the switch, and the switch is told to keep them
  // (`keepPrefs` in main.ts): perspective and extent are stored per presentation,
  // so entering one normally loads its own pair — which here would overwrite the
  // view's with whatever was last left in that presentation, and apply everything
  // about the view except the two values it is mostly about.
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
 * Is a name for a NEW view being typed?
 *
 * A field in the panel rather than `window.prompt`, which is what this started as.
 * A native dialog is suppressed outright in an embedded browser — the call
 * returns null and the action silently does nothing — and naming a view is the
 * primary flow here, not a corner like the body editor's link URL. It is also
 * what the design system asks for: interface is built from the components.
 *
 * Only for creating. Renaming an existing one is a property of that view and
 * lives in its dialog, next to its visibility — see `openViewDialog`.
 */
let naming = false;

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
 * The name field for a new view, plus the two ways out of it.
 *
 * Enter commits and Escape cancels, because a one-field form in a popover is a
 * keyboard interaction before it is a button one — and the button is there anyway
 * for whoever reaches for the pointer.
 */
function nameForm(): HTMLElement {
  const input = TextInput({
    placeholder: 'Name der Ansicht',
    attrs: { 'aria-label': 'Name der neuen Ansicht' },
  });
  const commit = () => {
    const name = input.value.trim();
    if (!name) return;
    naming = false;
    closeMenu();
    void saveAsNew(name);
  };
  const cancel = () => {
    naming = false;
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

// Both take the view they act on rather than reading the active one: the dialog
// hangs off a ROW, and the row is often not the applied view. „Aktualisieren" in
// the panel passes the active one explicitly for the same reason.

async function updateView(
  view: SavedView,
  patch: Record<string, unknown>,
  done: string,
): Promise<void> {
  const sourceId = state.activeSourceId;
  if (!sourceId) return;
  await write(async () => {
    const stored = (await apiUpdateSavedView(sourceId, view.id, patch, view.version)) as SavedView;
    upsertLocal(stored);
    syncSavedViewsControl();
  }, done);
}

async function deleteView(view: SavedView): Promise<void> {
  const sourceId = state.activeSourceId;
  if (!sourceId) return;
  await write(async () => {
    await apiDeleteSavedView(sourceId, view.id);
    removeLocal(view.id);
    // Only when the deleted one was the applied one. Deleting somebody else's row
    // from the list must not silently drop the view the user is looking at.
    if (state.activeSavedViewId === view.id) {
      state.activeSavedViewId = null;
      // The hash goes with it: a link left naming a deleted view is one that opens
      // the timeline and quietly does nothing, which reads as the link being broken.
      syncUrl();
    }
    syncSavedViewsControl();
  }, `Ansicht „${view.name}" gelöscht.`);
}

/**
 * Everything that is a property of ONE saved view, in a dialog of its own.
 *
 * It replaces three rows that used to sit in the panel („Umbenennen…",
 * „Teilen", „Löschen"). Those rows had a flaw the panel could not fix: they acted
 * on whichever view happened to be *applied*, so administering a view meant
 * entering it first, and the panel grew a row per property as more of them
 * arrived. Hanging the properties off the row they belong to gets both back — the
 * list stays a list, and the next property (a description, an owner, a default)
 * is a field here rather than a fourth row there.
 *
 * A `Dialog` rather than a second popover: a popover over a popover has no sane
 * dismissal order, and this asks for a decision rather than offering a choice
 * (see the component's own note). The native `<dialog>` brings the focus trap and
 * Escape with it, which a hand-rolled one reliably gets wrong.
 *
 * Nothing is written until „Speichern": a name being typed is not a rename, and a
 * visibility toggle that published on click would put a half-named view in front
 * of the instance.
 */
function openViewDialog(view: SavedView): void {
  const caller = currentCaller();
  const mayPublish = canPublishSavedView(caller);
  const name = TextInput({
    value: view.name,
    id: 'saved-view-name',
    attrs: { 'aria-label': 'Name der Ansicht' },
  });
  const shared = Checkbox({
    label: 'Für alle Mitglieder dieser Instanz sichtbar',
    checked: visibilityOf(view) === 'instance',
    disabled: !mayPublish,
  });
  const sharedBox = shared.querySelector('input') as HTMLInputElement;

  const dialog = Dialog({
    title: view.name,
    ariaLabel: `Einstellungen der Ansicht „${view.name}"`,
    closeLabel: 'Ansicht-Einstellungen schließen',
    onClose: () => dialog.close(),
  });
  // Removed on close rather than kept around: the dialog is built from the view as
  // it is now, and a hidden stale copy is the thing that later shows yesterday's
  // name. `close` fires for Escape and the backdrop too, so this is the one hook.
  dialog.addEventListener('close', () => dialog.remove());

  const save = Button({
    label: 'Speichern',
    variant: 'primary',
    on: {
      click: () => {
        const next = name.value.trim();
        if (!next) return;
        const patch: Record<string, unknown> = {};
        if (next !== view.name) patch.name = next;
        const wantShared = sharedBox.checked;
        if (wantShared !== (visibilityOf(view) === 'instance')) {
          patch.visibility = wantShared ? 'instance' : 'private';
        }
        dialog.close();
        // Nothing changed is not an error and not a write: the same rule
        // `timelineMetaPatch` follows, and for the same reason — an empty PATCH
        // would still bump the row's version and re-attribute it.
        if (!Object.keys(patch).length) return;
        void updateView(view, patch, `Ansicht „${next}" gespeichert.`);
      },
    },
  });
  const remove = Button({
    label: 'Löschen',
    variant: 'danger',
    on: {
      click: () => {
        if (!confirm(`Ansicht „${view.name}" wirklich löschen?`)) return;
        dialog.close();
        void deleteView(view);
      },
    },
  });

  dialog.append(
    FormGrid({
      children: [
        Field({ label: 'Name', htmlFor: 'saved-view-name', full: true, control: name }),
        Field({
          label: 'Sichtbarkeit',
          full: true,
          // Shown disabled rather than hidden, and without a note saying why: the
          // control's own state is the statement (see „Interface text" in AGENTS.md).
          control: shared,
        }),
      ],
    }),
    FormActions({ children: [save, remove] }),
  );

  document.body.append(dialog);
  dialog.showModal();
  name.focus();
  name.select();
}

/**
 * The trigger's two shapes: a bare mark, and the mark plus the applied view's name.
 *
 * The mark alone is the resting state because this bar has no room for a third
 * labelled control — it already wraps on a 13" window once a plugin contributes
 * one of its own. A name appears only while a view is applied, which is the state
 * where the name is the information rather than a caption repeating the obvious.
 *
 * `data-icon-only` is kept in step with the label, because the variant hangs the
 * caret off its absence: a mark with a caret beside it reads as a control with a
 * missing value.
 *
 * The accessible name is set in both shapes, and it CONTAINS the visible one when
 * there is a visible one — an `aria-label` that replaces the text on screen leaves
 * a keyboard user and a sighted user talking about different buttons.
 */
function setTrigger(active: SavedView | undefined, isDrifted: boolean): void {
  const toggle = els.savedViewsToggle;
  const mark = el('span', { class: 'ds-Button-icon', 'aria-hidden': 'true' }, [
    Icon({ name: 'view', chrome: true, size: 'sm', standalone: true }),
  ]);
  if (!active) {
    toggle.replaceChildren(mark);
    toggle.dataset.iconOnly = 'true';
    toggle.setAttribute('aria-label', 'Gespeicherte Ansichten');
    toggle.title = 'Gespeicherte Ansichten';
    return;
  }
  // The asterisk says „what you see is no longer what this view stores", which is
  // the difference between „I am looking at Q3" and „I started from Q3". Without
  // it, saving over a view is a guess about what is in it.
  const label = `${active.name}${isDrifted ? ' *' : ''}`;
  toggle.replaceChildren(mark, el('span', { class: 'ds-Button-label' }, label));
  delete toggle.dataset.iconOnly;
  toggle.setAttribute('aria-label', `Gespeicherte Ansichten: ${label}`);
  toggle.title = isDrifted ? `„${active.name}" mit ungespeicherten Änderungen` : active.name;
}

/**
 * One saved view: the row that applies it, and the gear that administers it.
 *
 * Two buttons side by side rather than one row with two behaviours, because they
 * are two different verbs — „show me this" and „change this" — and a row that does
 * one thing at its left end and another at its right is the shape people click
 * wrong. The gear is a real sibling rather than a child of the row: a button
 * inside a button is invalid markup, and it is what would make the whole row
 * ambiguous to a screen reader.
 *
 * A view this caller may not change carries no gear at all. The dialog would have
 * nothing but disabled fields, and offering it is a promise the API then refuses.
 */
function viewRow(view: SavedView): HTMLElement {
  const row = MenuItem({
    label: view.name,
    checked: view.id === state.activeSavedViewId,
    // „geteilt" rather than an icon: the list is read as text, and this is the one
    // fact about a view that changes who else is affected by editing it.
    detail: visibilityOf(view) === 'instance' ? 'geteilt' : undefined,
    className: 'saved-view-apply',
    on: {
      click: () => {
        closeMenu();
        applySavedView(view);
      },
    },
  });
  if (!writable() || !canEditSavedView(view, currentCaller())) return row;
  const gear = IconButton({
    // The chrome gear token, the same mark the way into any settings area carries.
    // Filled rather than stroked, because at 16px a stroked cog's teeth close up
    // and detached ones read as a sun — see the note on `--ui-icon-gear`.
    icon: Icon({ name: 'gear', chrome: true, size: 'sm', standalone: true }),
    ariaLabel: `Einstellungen der Ansicht „${view.name}"`,
    boxSize: 'sm',
    // The component's own „quiet until you are on the row" treatment, the same one
    // the list's per-group „+ Eintrag" uses: five views should read as five names,
    // not as a column of gears. It stays at 0.55 rather than 0, so it is visible to
    // somebody who never hovers and reachable by keyboard either way.
    reveal: true,
    on: {
      click: () => {
        // The panel goes first: a dialog says „nothing else until this is dealt
        // with", and a popover left open underneath it contradicts that.
        closeMenu();
        openViewDialog(view);
      },
    },
  });
  return el('div', { class: 'saved-view-row' }, [row, gear]);
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
  setTrigger(active, isDrifted);

  const children: Element[] = [];
  // The caption the trigger gave up when it became a mark. With views it heads the
  // list; with none it heads the actions, so a panel opened from an unlabelled
  // 30px box still says what it is about before anything is read.
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

  // Two actions, and both are about the CURRENT DISPLAY rather than about a stored
  // view: capture it as a new one, or write it over the one that is applied.
  // Everything that is a property of a stored view — its name, who may see it,
  // whether it should exist at all — hangs off that view's own row (see
  // `openViewDialog`), so this list does not grow a row per property.
  const actions: Element[] = [];
  if (canSave) {
    actions.push(
      MenuItem({
        label: 'Aktuelle Einstellung speichern…',
        on: {
          click: () => {
            naming = true;
            syncSavedViewsControl();
          },
        },
      }),
    );
  }
  // Only while it has drifted, and that is what keeps it out of the dialog: it is
  // not „edit this view", it is „the thing I have on screen replaces it", which is
  // the one action worth reaching in a click while working.
  if (active && isDrifted && canSave && canEditSavedView(active, caller)) {
    actions.push(
      MenuItem({
        label: `„${active.name}" aktualisieren`,
        on: {
          click: () => {
            closeMenu();
            void updateView(active, currentAsView(active.name), `Ansicht „${active.name}" aktualisiert.`);
          },
        },
      }),
    );
  }
  if (actions.length) {
    if (children.length) children.push(Separator({}));
    children.push(MenuSection({ label: all.length ? undefined : 'Ansichten', children: actions }));
  }
  if (naming) {
    children.push(Separator({}));
    children.push(nameForm());
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
    naming = false;
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
