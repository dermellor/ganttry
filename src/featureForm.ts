// Feature edit form for the pricing matrix: Stammdaten of a single
// PricingFeature (name, group, description, version), shown in the same
// detail drawer as items (itemForm.ts) and phases (phaseForm.ts). The pricing
// model is persisted as a unit (see persistence.ts), so saving here just
// mutates the in-memory feature and defers to schedulePersist() — same
// pattern as phases.

import { escapeHtml } from './buildItems';
import type { PricingFeature } from './types';
import { state, els, setStatus, withPreservedZoom } from './state';
import { schedulePersist } from './persistence';
import { hideDetail } from './detailPanel';
import { renderPricingView } from './pricingMatrix';

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
      <textarea class="version-desc-text" rows="2" placeholder="Was kam in dieser Version dazu?">${escapeHtml(text)}</textarea>
      <button type="button" class="vdesc-remove" data-action="remove-vdesc" aria-label="Versionsbeschreibung entfernen" title="Entfernen">×</button>
    </div>`;
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

  els.detailTitle.textContent = feature.name || '(unbenanntes Feature)';
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
        <textarea id="ft-description" name="description" rows="3">${escapeHtml(feature.description ?? '')}</textarea>
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

  // Dynamic version-description rows: "+" appends a row defaulting to the first
  // version not yet used; the per-row "×" removes it.
  const vdescList = form.querySelector<HTMLElement>('.version-desc-list');
  if (vdescList) {
    form.querySelector<HTMLButtonElement>('[data-action="add-vdesc"]')?.addEventListener('click', () => {
      const used = new Set(
        [...vdescList.querySelectorAll<HTMLSelectElement>('.version-desc-select')].map((s) => s.value),
      );
      const next = versions.find((v) => !used.has(v)) ?? versions[0];
      vdescList.insertAdjacentHTML('beforeend', vdescRowHtml(versions, next, ''));
      vdescList.querySelector<HTMLTextAreaElement>('.version-desc-row:last-child .version-desc-text')?.focus();
    });
    vdescList.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-action="remove-vdesc"]');
      if (btn) btn.closest('.version-desc-row')?.remove();
    });
  }

  withPreservedZoom(() => {
    els.detail.hidden = false;
  });
}

function saveFeatureFromForm(featureId: string, form: HTMLFormElement): void {
  const feature = findFeature(featureId);
  if (!feature) return;
  const fd = new FormData(form);
  const get = (name: string) => String(fd.get(name) ?? '').trim();

  feature.name = get('name') || feature.name;

  const group = get('group');
  if (group) feature.group = group;
  else delete feature.group;

  const version = get('version');
  if (version) feature.version = version;
  else delete feature.version;

  const description = get('description');
  if (description) feature.description = description;
  else delete feature.description;

  // Collect per-version description notes straight off the dynamic rows. Keyed by
  // version → a later row wins if two rows pick the same version. Empty text is
  // skipped; no rows → drop the field entirely.
  const notes: Record<string, string> = {};
  for (const row of form.querySelectorAll<HTMLElement>('.version-desc-row')) {
    const v = row.querySelector<HTMLSelectElement>('.version-desc-select')?.value.trim();
    const text = row.querySelector<HTMLTextAreaElement>('.version-desc-text')?.value.trim();
    if (v && text) notes[v] = text;
  }
  if (Object.keys(notes).length) feature.descriptionByVersion = notes;
  else delete feature.descriptionByVersion;

  renderPricingView();
  schedulePersist();
  setStatus(`Feature „${feature.name}" aktualisiert`);
  showFeatureForm(featureId);
}

function deleteFeature(featureId: string): void {
  const pricing = state.activeSourceFile?.pricing;
  const feature = pricing && findFeature(featureId);
  if (!pricing || !feature) return;
  if (!confirm(`Feature „${feature.name}" wirklich löschen?`)) return;

  pricing.features = pricing.features.filter((f) => f.id !== featureId);
  // Drop dangling references so tiers/highlights don't keep pointing at a
  // feature that no longer exists.
  for (const tier of pricing.tiers) {
    if (tier.values && featureId in tier.values) delete tier.values[featureId];
  }
  for (const highlight of pricing.highlights ?? []) {
    highlight.featureIds = highlight.featureIds.filter((id) => id !== featureId);
  }

  state.activeFormFeatureId = null;
  renderPricingView();
  schedulePersist();
  hideDetail();
}
