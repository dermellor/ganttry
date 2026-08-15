// Feature edit form for the pricing matrix: Stammdaten of a single
// PricingFeature (name, group, description, version), shown in the same
// detail drawer as items (itemForm.ts) and phases (phaseForm.ts). Unlike the
// old whole-model persist, saving here writes the ONE edited feature row
// through the granular PATCH endpoint (optimistic-locked on rowVersion), so a
// concurrent edit elsewhere in the model is never clobbered.

import {
  Button,
  ConflictError,
  createMarkdownEditor,
  el,
  Field,
  FormActions,
  IconButton,
  Select,
  TextArea,
  TextInput,
} from '../../pluginHost/api';
import type { PricingFeature } from './types';
import { apiAddFeature, apiUpdateFeature, apiDeleteFeature, apiMoveFeature } from './api';
import { applyRow, dropRow, dropRowsWhere, orderRows, patchRows } from './store';
import { PRICING_COLLECTIONS } from './manifest';
import { slugId, versionLabel } from './pricing';
import { file, hostApi, status } from './host';
import { repaintPricingView } from './pricingMatrix';
import { currentPricing } from './compose';

import { t } from './messages';
function findFeature(featureId: string): PricingFeature | undefined {
  return currentPricing(file())?.features.find((f) => f.id === featureId);
}

// One row of the version-description editor: a version <select>, the note text,
// and a remove button. Rows are added/removed dynamically via the "+ " button,
// so they carry no `name` — save reads them straight off the DOM (see
// saveFeatureFromForm).
function vdescRow(
  versions: string[],
  labels: Record<string, string> | undefined,
  selectedVersion: string,
  text: string,
): HTMLElement {
  return el('div', { class: 'version-desc-row' }, [
    Select({
      className: 'version-desc-select',
      block: false,
      attrs: { 'aria-label': 'Version' },
      // value is the version id (what save writes as a descriptionByVersion key);
      // only the label shown to the user resolves through versionLabel.
      options: versions.map((v) => ({
        value: v,
        label: `ab ${versionLabel(labels, v)}`,
        selected: v === selectedVersion,
      })),
    }),
    el('div', { class: 'version-desc-editor', 'data-role': 'vdesc-editor' }),
    TextArea({ className: 'version-desc-text', value: text, attrs: { hidden: true } }),
    IconButton({
      icon: '×',
      ariaLabel: t('version.remove'),
      variant: 'outline',
      attrs: { 'data-action': 'remove-vdesc' },
    }),
  ]);
}

// Mount the shared Markdown WYSIWYG editor over a hidden <textarea>, keeping the
// textarea's value in sync (Markdown) so the existing form/save pipeline reads it
// unchanged — same integration as the item Body field (itemForm.ts).
function wireMarkdownField(mount: HTMLElement, textarea: HTMLTextAreaElement): void {
  const editor = createMarkdownEditor(textarea.value, () => {
    textarea.value = editor.getMarkdown();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  mount.appendChild(editor.el);
}

// Wire the WYSIWYG editor for a single version-description row (used for both the
// seeded rows and rows added later via the "+" button).
function wireVdescRow(row: HTMLElement): void {
  const mount = row.querySelector<HTMLElement>('[data-role="vdesc-editor"]');
  const textarea = row.querySelector<HTMLTextAreaElement>('.version-desc-text');
  if (mount && textarea) wireMarkdownField(mount, textarea);
}

// Distinct group labels already used by other features, offered as a
// datalist so a typo doesn't silently create a second matrix section.
function existingGroups(): string[] {
  const out = new Set<string>();
  for (const f of currentPricing(file())?.features ?? []) {
    const g = f.group?.trim();
    if (g) out.add(g);
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'de'));
}

export function showFeatureForm(featureId: string): void {
  const feature = findFeature(featureId);
  if (!feature) return;

  const pricing = currentPricing(file());
  const versions = pricing.versions ?? [];
  const versionLabels = pricing.versionLabels;

  // Additive, per-version description notes as a dynamic list: add a row via the
  // "+" button, link it to a version, type the note. Existing notes are seeded as
  // rows in declared version order. Only shown when the timeline has versions
  // (there's nothing to link a note to otherwise).
  const versionDescField = versions.length
    ? Field({
        label: 'Versionsbeschreibungen',
        full: true,
        className: 'version-desc-field',
        control: [
          el(
            'div',
            { class: 'version-desc-list' },
            versions
              .filter((v) => feature.descriptionByVersion?.[v]?.trim())
              .map((v) => vdescRow(versions, versionLabels, v, feature.descriptionByVersion![v])),
          ),
          Button({
            label: t('version.add'),
            variant: 'dashed',
            className: 'vdesc-add',
            attrs: { 'data-action': 'add-vdesc' },
          }),
        ],
      })
    : null;

  const form = el('form', { class: 'ds-FormGrid feature-form', 'data-id': featureId }, [
    Field({
      label: 'Name',
      htmlFor: 'ft-name',
      full: true,
      control: TextInput({ id: 'ft-name', name: 'name', value: feature.name ?? '' }),
    }),
    Field({
      label: 'Gruppe',
      htmlFor: 'ft-group',
      control: [
        TextInput({
          id: 'ft-group',
          name: 'group',
          value: feature.group ?? '',
          attrs: { list: 'ft-group-options' },
        }),
        // Distinct group labels already in use, so a typo does not silently
        // create a second matrix section.
        el(
          'datalist',
          { id: 'ft-group-options' },
          existingGroups().map((g) => el('option', { value: g })),
        ),
      ],
    }),
    Field({
      label: t('version.from'),
      htmlFor: 'ft-version',
      control: Select({
        id: 'ft-version',
        name: 'version',
        options: [
          { value: '', label: t('version.fromStart'), selected: !feature.version },
          ...versions.map((v) => ({ value: v, label: versionLabel(versionLabels, v), selected: feature.version === v })),
        ],
      }),
    }),
    Field({
      label: 'Beschreibung',
      htmlFor: 'ft-description',
      full: true,
      control: [
        el('div', { 'data-role': 'desc-editor' }),
        TextArea({
          id: 'ft-description',
          name: 'description',
          value: feature.description ?? '',
          attrs: { hidden: true },
        }),
      ],
    }),
    versionDescField,
    Field({
      label: 'ID',
      hint: '(read-only)',
      htmlFor: 'ft-id',
      control: TextInput({ id: 'ft-id', name: 'id', value: featureId, readonly: true }),
    }),
    FormActions({
      children: [
        Button({ label: 'Speichern', type: 'submit' }),
        Button({ label: t('delete'), variant: 'danger', attrs: { 'data-action': 'delete' } }),
      ],
    }),
  ]);

  // The host owns the drawer: it clears whatever was in it, records that a plugin
  // form is open (which stops background persistence writing underneath it) and
  // hands over a container. Wiring happens after, on the element we still hold.
  hostApi().panel?.open({
    title: feature.name || '(unbenanntes Feature)',
    render: (container) => container.replaceChildren(form),
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveFeatureFromForm(featureId, form);
  });
  form.querySelector<HTMLButtonElement>('[data-action="delete"]')!.addEventListener('click', () => {
    deleteFeature(featureId);
  });

  // Beschreibung: same Markdown WYSIWYG editor as the item Body field.
  const descMount = form.querySelector<HTMLElement>('[data-role="desc-editor"]');
  const descTextarea = form.querySelector<HTMLTextAreaElement>('#ft-description');
  if (descMount && descTextarea) wireMarkdownField(descMount, descTextarea);

  // Dynamic version-description rows: "+" appends a row defaulting to the first
  // version not yet used; the per-row "×" removes it.
  const vdescList = form.querySelector<HTMLElement>('.version-desc-list');
  if (vdescList) {
    // Seeded rows get their WYSIWYG editor mounted up front.
    vdescList.querySelectorAll<HTMLElement>('.version-desc-row').forEach(wireVdescRow);
    form.querySelector<HTMLButtonElement>('[data-action="add-vdesc"]')?.addEventListener('click', () => {
      const used = new Set(
        [...vdescList.querySelectorAll<HTMLSelectElement>('.version-desc-select')].map((s) => s.value),
      );
      const next = versions.find((v) => !used.has(v)) ?? versions[0];
      const row = vdescRow(versions, versionLabels, next, '');
      vdescList.appendChild(row);
      wireVdescRow(row);
      row.querySelector<HTMLElement>('.version-desc-editor .wysiwyg-surface')?.focus();
    });
    vdescList.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-action="remove-vdesc"]');
      if (btn) btn.closest('.version-desc-row')?.remove();
    });
  }
}

async function saveFeatureFromForm(featureId: string, form: HTMLFormElement): Promise<void> {
  const feature = findFeature(featureId);
  if (!feature) return;
  const fd = new FormData(form);
  const get = (name: string) => String(fd.get(name) ?? '').trim();

  // Build the patch: name always, the optionals cleared with explicit null when
  // emptied so the server resets the column (an omitted key would leave the old
  // value intact and it'd reappear on reload).
  // Collect the per-version description notes off the dynamic rows (PR #22 UI).
  // Keyed by version → a later row wins on a duplicate; empty text is skipped.
  const notes: Record<string, string> = {};
  for (const row of form.querySelectorAll<HTMLElement>('.version-desc-row')) {
    const v = row.querySelector<HTMLSelectElement>('.version-desc-select')?.value.trim();
    const text = row.querySelector<HTMLTextAreaElement>('.version-desc-text')?.value.trim();
    if (v && text) notes[v] = text;
  }

  // Build the patch: name always; the optionals cleared with an explicit null
  // when emptied so the server resets the column (an omitted key would leave the
  // old value intact and it'd reappear on reload). Version notes: no rows → null.
  const patch: Partial<PricingFeature> = {
    name: get('name') || feature.name,
    group: get('group') || null,
    version: get('version') || null,
    description: get('description') || null,
    descriptionByVersion: Object.keys(notes).length ? notes : null,
  } as Partial<PricingFeature>;

  try {
    const saved = await apiUpdateFeature(featureId, patch, feature.rowVersion);
    // Adopt the stored ROW, not a merge into the composed model: the model is
    // recomposed on every read, so merging into it updates a copy that is thrown
    // away (see ./store.ts). Replacing the row also clears an emptied field
    // without a reset dance — the server already dropped the key.
    applyRow(file(), PRICING_COLLECTIONS.features, saved);
    repaintPricingView();
    status(`Feature „${patch.name ?? feature.name}" aktualisiert`);
    showFeatureForm(featureId);
  } catch (err) {
    if (err instanceof ConflictError) {
      // The row moved under us. The host's own reload is what brings the new one
      // in; repainting from the stale snapshot would show the value we failed to
      // write as if it had been saved.
      status(t('refusal.feature.conflict'));
      return;
    }
    status(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function deleteFeature(featureId: string): Promise<void> {
  const pricing = currentPricing(file());
  const feature = pricing && findFeature(featureId);
  if (!pricing || !feature) return;
  if (!confirm(`Feature „${feature.name}" wirklich löschen?`)) return;

  try {
    await apiDeleteFeature(featureId);
  } catch (err) {
    status(`Löschen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // The host applied the manifest's declared cascade: the cells go with the
  // feature, and the id is unlinked from every highlight that listed it. Mirror
  // the same three effects on the rows so the matrix repaints without a reload.
  dropRow(file(), PRICING_COLLECTIONS.features, featureId);
  dropRowsWhere(file(), PRICING_COLLECTIONS.tierValues, (d) => d.featureId === featureId);
  patchRows(file(), PRICING_COLLECTIONS.highlights, (d) => ({
    ...d,
    featureIds: ((d.featureIds as string[] | undefined) ?? []).filter((id) => id !== featureId),
  }));

  repaintPricingView();
  hostApi().panel?.close();
}

/**
 * Create a feature and open its form. The row is written immediately (rather than
 * the form saving a draft) so it exists server-side before the user starts filling
 * cells for it — the same "create then edit" flow items and tiers use.
 *
 * `group` pre-fills the matrix section, so the per-section button lands the row in
 * that section while the toolbar button leaves it ungrouped (the form's group
 * field, with its datalist of existing groups, is how it moves afterwards).
 *
 * The server appends the row at the end of the global sort order, which — because
 * the matrix re-groups by label — is exactly the end of its own section.
 */
export async function addFeature(group?: string): Promise<void> {
  const pricing = currentPricing(file());
  if (!pricing) return;

  const name = prompt(t('feature.namePrompt'))?.trim();
  if (!name) return;

  const id = slugId(
    name,
    pricing.features.map((f) => f.id),
    'feature',
  );
  try {
    const saved = await apiAddFeature({ id, name, ...(group ? { group } : {}) });
    applyRow(file(), PRICING_COLLECTIONS.features, saved);
    repaintPricingView();
    showFeatureForm(saved.id);
    status(`Feature „${name}" angelegt`);
  } catch (err) {
    status(`Feature anlegen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Reposition a feature relative to one anchor feature. The caller (the matrix)
 * picks the anchor from what is actually on screen — its visible neighbour inside
 * the same section — so the row moves one step in the direction the user asked for
 * regardless of how the global sort order interleaves groups.
 */
export async function moveFeature(featureId: string, anchor: { after?: string; before?: string }): Promise<void> {
  const pricing = currentPricing(file());
  if (!pricing) return;

  try {
    const order = await apiMoveFeature(featureId, anchor);
    // Adopt the host's resulting order rather than replaying the move locally —
    // it owns the position and renumbers.
    orderRows(file(), PRICING_COLLECTIONS.features, order);
    repaintPricingView();
  } catch (err) {
    status(`Umsortieren fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
}
