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
