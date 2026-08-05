// Feature edit form for the pricing matrix: Stammdaten of a single
// PricingFeature (name, group, description, version), shown in the same
// detail drawer as items (itemForm.ts) and phases (phaseForm.ts). Unlike the
// old whole-model persist, saving here writes the ONE edited feature row
// through the granular PATCH endpoint (optimistic-locked on rowVersion), so a
// concurrent edit elsewhere in the model is never clobbered.

import { escapeHtml } from '../../buildItems';
import { createMarkdownEditor } from '../../wysiwyg';
import type { PricingFeature } from '../../types';
import { state, els, setStatus } from '../../state';
import { apiUpdateFeature, apiDeleteFeature, ConflictError } from '../../editor';
import { hideDetail, setDetailTitle } from '../../detailPanel';
import { renderPricingView } from './pricingMatrix';
import { renderTimeline } from '../../render';

function findFeature(featureId: string): PricingFeature | undefined {
  return state.activeSourceFile?.pricing?.features.find((f) => f.id === featureId);
}

// One row of the version-description editor: a version <select>, the note text,
// and a remove button. Rows are added/removed dynamically via the "+ " button,
// so they carry no `name` — save reads them straight off the DOM (see
// saveFeatureFromForm).
function versionSelectOptions(versions: string[], selected: string): string {
  return versions
    .map((v) => `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>ab ${escapeHtml(v)}</option>`)
    .join('');
}

function vdescRowHtml(versions: string[], selectedVersion: string, text: string): string {
  return `
    <div class="version-desc-row" data-vdesc-row>
      <select class="version-desc-select" aria-label="Version">${versionSelectOptions(versions, selectedVersion)}</select>
      <div class="version-desc-editor" data-role="vdesc-editor"></div>
      <textarea class="version-desc-text" hidden>${escapeHtml(text)}</textarea>
      <button type="button" class="vdesc-remove" data-action="remove-vdesc" aria-label="Versionsbeschreibung entfernen" title="Entfernen">×</button>
    </div>`;
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
  for (const f of state.activeSourceFile?.pricing?.features ?? []) {
    const g = f.group?.trim();
    if (g) out.add(g);
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'de'));
}

export function showFeatureForm(featureId: string): void {
  const feature = findFeature(featureId);
  if (!feature) return;
  // Opening a feature form supersedes any open item/phase form.
  state.activeFormItemId = null;
  state.activeFormPhaseIndex = null;
  state.activeFormFeatureId = featureId;

  setDetailTitle(feature.name || '(unbenanntes Feature)');
  els.detailMeta.innerHTML = '';

  const versions = state.activeSourceFile?.pricing?.versions ?? [];
  const versionOptions =
    `<option value=""${!feature.version ? ' selected' : ''}>— von Anfang an —</option>` +
    versions
      .map(
        (v) =>
          `<option value="${escapeHtml(v)}"${feature.version === v ? ' selected' : ''}>${escapeHtml(v)}</option>`,
      )
      .join('');

  const groupOptionsList = existingGroups()
    .map((g) => `<option value="${escapeHtml(g)}"></option>`)
    .join('');

  // Additive, per-version description notes as a dynamic list: add a row via the
  // "+" button, link it to a version, type the note. Existing notes are seeded as
  // rows in declared version order. Only shown when the timeline has versions
  // (there's nothing to link a note to otherwise).
  const existingRows = versions.length
    ? versions
        .filter((v) => feature.descriptionByVersion?.[v]?.trim())
        .map((v) => vdescRowHtml(versions, v, feature.descriptionByVersion![v]))
        .join('')
    : '';
  const versionDescFields = versions.length
    ? `
      <div class="field full version-desc-field">
        <label>Versionsbeschreibungen <small>(zusätzlich, je Version)</small></label>
        <div class="version-desc-list">${existingRows}</div>
        <button type="button" class="vdesc-add" data-action="add-vdesc">+ Versionsbeschreibung</button>
      </div>`
    : '';

  els.detailBody.classList.add('detail-form');
  els.detailBody.innerHTML = `
    <form class="item-form feature-form" data-id="${escapeHtml(featureId)}">
      <div class="field full">
        <label for="ft-name">Name</label>
        <input id="ft-name" name="name" value="${escapeHtml(feature.name ?? '')}" />
      </div>
      <div class="field">
        <label for="ft-group">Gruppe <small>(Matrix-Abschnitt)</small></label>
        <input id="ft-group" name="group" list="ft-group-options" value="${escapeHtml(feature.group ?? '')}" />
        <datalist id="ft-group-options">${groupOptionsList}</datalist>
      </div>
      <div class="field">
        <label for="ft-version">Ab Version</label>
        <select id="ft-version" name="version">${versionOptions}</select>
      </div>
      <div class="field full">
        <label for="ft-description">Beschreibung</label>
        <div data-role="desc-editor"></div>
        <textarea id="ft-description" name="description" hidden>${escapeHtml(feature.description ?? '')}</textarea>
      </div>
      ${versionDescFields}
      <div class="field">
        <label for="ft-id">ID <small>(read-only)</small></label>
        <input id="ft-id" name="id" value="${escapeHtml(featureId)}" readonly />
      </div>
      <div class="form-actions">
        <button type="submit" class="btn-primary">Speichern</button>
        <button type="button" class="btn-danger" data-action="delete">Löschen</button>
      </div>
    </form>
  `;

  const form = els.detailBody.querySelector('form') as HTMLFormElement;
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
      vdescList.insertAdjacentHTML('beforeend', vdescRowHtml(versions, next, ''));
      const row = vdescList.querySelector<HTMLElement>('.version-desc-row:last-child');
      if (row) {
        wireVdescRow(row);
        row.querySelector<HTMLElement>('.version-desc-editor .wysiwyg-surface')?.focus();
      }
    });
    vdescList.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-action="remove-vdesc"]');
      if (btn) btn.closest('.version-desc-row')?.remove();
    });
  }

  // Pricing view has no timeline behind the overlay, so just show the panel.
  els.detail.hidden = false;
}

async function saveFeatureFromForm(featureId: string, form: HTMLFormElement): Promise<void> {
  const feature = findFeature(featureId);
  const sourceId = state.activeSourceId;
  if (!feature || !sourceId) return;
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
    const saved = await apiUpdateFeature(sourceId, featureId, patch, feature.rowVersion);
    // Adopt the authoritative row back into the in-memory model (reset the
    // clearable optionals first so a cleared field doesn't linger).
    Object.assign(
      feature,
      { group: undefined, version: undefined, description: undefined, descriptionByVersion: undefined },
      saved,
    );
    renderPricingView();
    setStatus(`Feature „${feature.name}" aktualisiert`);
    showFeatureForm(featureId);
  } catch (err) {
    if (err instanceof ConflictError) {
      setStatus('Feature wurde extern geändert — lade neu…');
      if (state.activeView) await renderTimeline(state.activeView);
      return;
    }
    setStatus(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function deleteFeature(featureId: string): Promise<void> {
  const pricing = state.activeSourceFile?.pricing;
  const sourceId = state.activeSourceId;
  const feature = pricing && findFeature(featureId);
  if (!pricing || !feature || !sourceId) return;
  if (!confirm(`Feature „${feature.name}" wirklich löschen?`)) return;

  try {
    await apiDeleteFeature(sourceId, featureId);
  } catch (err) {
    setStatus(`Löschen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Server-side the value rows cascade away and the id is stripped from
  // highlights; mirror that in memory for an immediate repaint.
  pricing.features = pricing.features.filter((f) => f.id !== featureId);
  for (const tier of pricing.tiers) {
    if (tier.values && featureId in tier.values) delete tier.values[featureId];
  }
  for (const highlight of pricing.highlights ?? []) {
    highlight.featureIds = highlight.featureIds.filter((id) => id !== featureId);
  }

  state.activeFormFeatureId = null;
  renderPricingView();
  hideDetail();
}
