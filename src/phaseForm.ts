// Phase ribbon editing: drag/resize persistence (handlePhaseEdit) and the phase
// edit form shown in the detail panel.

import { escapeHtml } from './buildItems';
import { TIMELINE_ICONS } from './icons';
import { isoDateOnly } from './editor';
import type { PhaseEdit } from './phaseBand';
import { state, els, setStatus } from './state';
import { rebuildAndApply } from './render';
import { schedulePersist } from './persistence';
import { hideDetail } from './detailPanel';

export function handlePhaseEdit(edit: PhaseEdit): void {
  const phase = state.activeSourceFile?.phases?.[edit.srcIndex];
  if (!phase) return;
  // Persist as explicit start/end and drop any `duration` so the written range
  // is unambiguous (mirrors how item moves are stored).
  phase.start = isoDateOnly(edit.start);
  phase.end = isoDateOnly(edit.end);
  delete phase.duration;
  rebuildAndApply();
  schedulePersist();
  if (state.activeFormPhaseIndex === edit.srcIndex) showPhaseForm(edit.srcIndex);
}

export function showPhaseFormByIndex(srcIndex: number): void {
  showPhaseForm(srcIndex);
}

export function showPhaseForm(srcIndex: number): void {
  const phase = state.activeSourceFile?.phases?.[srcIndex];
  if (!phase) return;
  // Opening a phase form supersedes any open item form.
  state.activeFormItemId = null;
  state.activeFormPhaseIndex = srcIndex;
  state.timeline?.setSelection([]);
  state.selectedItemId = null;

  els.detailTitle.textContent = phase.label || '(unbenannte Phase)';
  els.detailMeta.innerHTML = '';

  const iconOptions =
    `<option value=""${!phase.icon ? ' selected' : ''}>— kein Icon —</option>` +
    TIMELINE_ICONS.map(
      ({ key, label }) => `<option value="${key}"${phase.icon === key ? ' selected' : ''}>${label}</option>`,
    ).join('');

  els.detailBody.classList.add('detail-form');
  els.detailBody.innerHTML = `
    <form class="item-form phase-form" data-index="${srcIndex}">
      <div class="field full">
        <label for="p-label">Titel</label>
        <input id="p-label" name="label" value="${escapeHtml(phase.label ?? '')}" />
      </div>
      <div class="field">
        <label for="p-start">Start</label>
        <input id="p-start" name="start" type="date" value="${isoDateOnly(phase.start)}" />
      </div>
      <div class="field">
        <label for="p-end">Ende</label>
        <input id="p-end" name="end" type="date" value="${isoDateOnly(phase.end ?? '')}" />
      </div>
      <div class="field">
        <label for="p-duration">Dauer</label>
        <input id="p-duration" name="duration" value="${escapeHtml(typeof phase.duration === 'string' ? phase.duration : phase.duration != null ? String(phase.duration) : '')}" placeholder="leer = Ende nutzen" />
      </div>
      <div class="field">
        <label for="p-icon">Icon</label>
        <select id="p-icon" name="icon">${iconOptions}</select>
      </div>
      <div class="field">
        <label for="p-color">Farbe</label>
        <input id="p-color" name="color" value="${escapeHtml(phase.color ?? '')}" placeholder="#2f0d5b" />
      </div>
      <div class="field">
        <label for="p-id">ID <small>(read-only)</small></label>
        <input id="p-id" name="id" value="${escapeHtml(phase.id ?? '')}" readonly />
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
    savePhaseFromForm(srcIndex, form);
  });
  form.querySelector<HTMLButtonElement>('[data-action="delete"]')!.addEventListener('click', () => {
    deletePhase(srcIndex);
  });

  els.detail.hidden = false;
  setTimeout(() => state.timeline?.redraw(), 0);
}

function savePhaseFromForm(srcIndex: number, form: HTMLFormElement): void {
  const phase = state.activeSourceFile?.phases?.[srcIndex];
  if (!phase) return;
  const fd = new FormData(form);
  const get = (name: string) => String(fd.get(name) ?? '').trim();

  phase.label = get('label') || phase.label;
  const startVal = get('start');
  if (startVal) phase.start = startVal;

  const endVal = get('end');
  const durVal = get('duration');
  // Duration wins over end (same precedence as items); at least one is needed
  // for the phase to render, so keep whatever the user supplied.
  if (durVal) {
    phase.duration = durVal;
    delete phase.end;
  } else if (endVal) {
    phase.end = endVal;
    delete phase.duration;
  } else {
    delete phase.duration;
    delete phase.end;
  }

  const iconVal = get('icon');
  if (iconVal) phase.icon = iconVal;
  else delete phase.icon;

  const colorVal = get('color');
  if (colorVal) phase.color = colorVal;
  else delete phase.color;

  rebuildAndApply();
  schedulePersist();
  setStatus(`Phase „${phase.label}" aktualisiert`);
  showPhaseForm(srcIndex);
}

function deletePhase(srcIndex: number): void {
  const phase = state.activeSourceFile?.phases?.[srcIndex];
  if (!phase) return;
  if (!confirm(`Phase „${phase.label}" wirklich löschen?`)) return;
  state.activeSourceFile!.phases!.splice(srcIndex, 1);
  state.activeFormPhaseIndex = null;
  rebuildAndApply();
  schedulePersist();
  hideDetail();
}
