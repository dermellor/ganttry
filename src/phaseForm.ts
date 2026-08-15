// Phase ribbon editing: drag/resize persistence (handlePhaseEdit) and the phase
// edit form shown in the detail panel.

import { Button, el, Field, FormActions, Select, TextInput } from './design-system';
import { timelineIcons } from './icons';
import { isoDateOnly } from './editor';
import type { PhaseEdit } from './phaseBand';
import { describePhaseOverlap, findPhaseOverlap } from './phaseOverlap';
import type { TimelinePhase } from './types';
import { state, els, setStatus, revealBesidePanel, clearFormSlots } from './state';
import { parseLocalDay, durationToMs } from './date';
import { rebuildAndApply } from './render';
import { publishSelfPresence, schedulePersist } from './persistence';
import { hideDetail, setDetailTitle } from './detailPanel';

import { locale, t } from './i18n';
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
  // Opening a phase form supersedes any other open form.
  clearFormSlots();
  state.activeFormPhaseIndex = srcIndex;
  state.timeline?.setSelection([]);
  state.selectedItemId = null;
  // We just gave up the item we occupied — release its presence mark.
  publishSelfPresence();

  setDetailTitle(phase.label || t('phase.unnamed'));
  els.detailMeta.replaceChildren();

  const durationValue =
    typeof phase.duration === 'string' ? phase.duration : phase.duration != null ? String(phase.duration) : '';

  const form = el('form', { class: 'ds-FormGrid item-form phase-form', 'data-index': srcIndex }, [
    Field({
      label: t('form.title'),
      htmlFor: 'p-label',
      full: true,
      control: TextInput({ id: 'p-label', name: 'label', value: phase.label ?? '' }),
    }),
    Field({
      label: t('form.start'),
      htmlFor: 'p-start',
      control: TextInput({ id: 'p-start', name: 'start', type: 'date', value: isoDateOnly(phase.start) }),
    }),
    Field({
      label: t('form.end'),
      htmlFor: 'p-end',
      control: TextInput({ id: 'p-end', name: 'end', type: 'date', value: isoDateOnly(phase.end ?? '') }),
    }),
    Field({
      label: t('form.duration'),
      htmlFor: 'p-duration',
      control: TextInput({
        id: 'p-duration',
        name: 'duration',
        value: durationValue,
        placeholder: t('form.endEmpty'),
      }),
    }),
    Field({
      label: t('form.icon'),
      htmlFor: 'p-icon',
      control: Select({
        id: 'p-icon',
        name: 'icon',
        options: [
          { value: '', label: t('form.noIcon.option'), selected: !phase.icon },
          ...timelineIcons().map(({ key, label }) => ({
            value: key,
            label,
            selected: phase.icon === key,
          })),
        ],
      }),
    }),
    Field({
      label: t('form.color'),
      htmlFor: 'p-color',
      control: TextInput({ id: 'p-color', name: 'color', value: phase.color ?? '', placeholder: '#2f0d5b' }),
    }),
    Field({
      label: t('form.id'),
      hint: t('form.readOnly'),
      htmlFor: 'p-id',
      control: TextInput({ id: 'p-id', name: 'id', value: phase.id ?? '', readonly: true }),
    }),
    FormActions({
      children: [
        Button({ label: t('form.save'), type: 'submit' }),
        Button({ label: t('form.delete'), variant: 'danger', attrs: { 'data-action': 'delete' } }),
      ],
    }),
  ]);

  els.detailBody.replaceChildren(form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    savePhaseFromForm(srcIndex, form);
  });
  form.querySelector<HTMLButtonElement>('[data-action="delete"]')!.addEventListener('click', () => {
    deletePhase(srcIndex);
  });

  els.detail.hidden = false;
  // The overlay panel can cover a phase pinned to the right; pan it clear if the
  // whole phase would sit behind the panel.
  if (phase.start) {
    const startMs = parseLocalDay(phase.start).getTime();
    let endMs: number | undefined;
    if (phase.end) endMs = parseLocalDay(phase.end).getTime();
    else if (phase.duration != null) {
      const d = durationToMs(phase.duration);
      if (d) endMs = startMs + d;
    }
    revealBesidePanel(startMs, endMs);
  }
}

function savePhaseFromForm(srcIndex: number, form: HTMLFormElement): void {
  const phase = state.activeSourceFile?.phases?.[srcIndex];
  if (!phase) return;
  const fd = new FormData(form);
  const get = (name: string) => String(fd.get(name) ?? '').trim();

  const endVal = get('end');
  const durVal = get('duration');
  // Build the edited phase as a trial first, so we can reject an overlap before
  // mutating live state. Duration wins over end (same precedence as items).
  const trial: TimelinePhase = { ...phase };
  trial.label = get('label') || phase.label;
  const startVal = get('start');
  if (startVal) trial.start = startVal;
  if (durVal) {
    trial.duration = durVal;
    delete trial.end;
  } else if (endVal) {
    trial.end = endVal;
    delete trial.duration;
  } else {
    delete trial.duration;
    delete trial.end;
  }

  // Phases must not overlap (mirrors the server-side reject). Check the whole
  // set with the edit applied; block the save and keep the form open on a clash.
  const candidate = (state.activeSourceFile!.phases ?? []).map((p, i) => (i === srcIndex ? trial : p));
  const clash = findPhaseOverlap(candidate);
  if (clash) {
    setStatus(describePhaseOverlap(clash.a, clash.b, locale()));
    return;
  }

  phase.label = trial.label;
  phase.start = trial.start;
  if ('duration' in trial) phase.duration = trial.duration;
  else delete phase.duration;
  if ('end' in trial) phase.end = trial.end;
  else delete phase.end;

  const iconVal = get('icon');
  if (iconVal) phase.icon = iconVal;
  else delete phase.icon;

  const colorVal = get('color');
  if (colorVal) phase.color = colorVal;
  else delete phase.color;

  rebuildAndApply();
  schedulePersist();
  setStatus(t('phase.updated', { label: phase.label ?? '' }));
  showPhaseForm(srcIndex);
}

function deletePhase(srcIndex: number): void {
  const phase = state.activeSourceFile?.phases?.[srcIndex];
  if (!phase) return;
  if (!confirm(t('phase.delete.confirm', { label: phase.label ?? '' }))) return;
  state.activeSourceFile!.phases!.splice(srcIndex, 1);
  state.activeFormPhaseIndex = null;
  rebuildAndApply();
  schedulePersist();
  hideDetail();
}
