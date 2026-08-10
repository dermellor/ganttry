// Editor for a single matrix cell (tier × feature) in the pricing view.
//
// A cell carries two dimensions — the value and, optionally, the version it
// becomes available at — and the value itself has three shapes (included, a
// free-form string, not included). A click-through cycle can't express that, so
// the cell opens a small popover that states all of it at once.
//
// Writes go through PUT …/tier-value, which is deliberately unlocked: a cell is a
// single atomic value, so two people editing different cells never collide (see
// apiSetTierValue). That also means there is no rowVersion to adopt back — on
// success we mirror the write into the in-memory model and repaint.

import {
  Button,
  el,
  Field,
  FormActions,
  Select,
  Text,
  TextInput,
  type Child,
} from '../../pluginHost/api';
import { state, setStatus } from '../../state';
import { apiSetTierValue } from '../../editor';
import { ensureLayer, positionLayer } from './popover';
import type { PricingTier } from '../../types';

const LAYER_ID = 'pm-cell-editor';

type Mode = 'on' | 'value' | 'off';

// Which of the three shapes the stored value has. An empty string counts as off:
// it renders as a dash either way, and the server treats falsy as "clear".
function modeOf(value: string | boolean | undefined): Mode {
  if (value === true) return 'on';
  if (typeof value === 'string' && value.trim()) return 'value';
  return 'off';
}

// Open editors are torn down through this, so only one is ever live and the
// document-level listeners never accumulate across cells.
let closeActive: (() => void) | null = null;

/** Close the cell editor if one is open. Safe to call unconditionally. */
export function closeCellEditor(): void {
  closeActive?.();
}

export function openCellEditor(anchor: HTMLElement, tierId: string, featureId: string): void {
  const pricing = state.activeSourceFile?.pricing;
  const sourceId = state.activeSourceId;
  const tier = pricing?.tiers.find((t) => t.id === tierId);
  const feature = pricing?.features.find((f) => f.id === featureId);
  if (!pricing || !tier || !feature || !sourceId) return;

  closeCellEditor();

  const versions = pricing.versions ?? [];
  const current = tier.values?.[featureId];
  const mode = modeOf(current);
  const valueText = typeof current === 'string' ? current : '';
  const availableFrom = tier.valueVersions?.[featureId] ?? '';

  const layer = ensureLayer(LAYER_ID, 'pm-cell-editor', 'dialog');
  const radio = (m: Mode, label: Child) =>
    el('label', { class: 'pm-ce-choice' }, [
      el('input', { type: 'radio', name: 'pm-ce-mode', value: m, checked: m === mode }),
      label,
    ]);

  layer.replaceChildren(
    el('form', { class: 'pm-ce-form' }, [
      Text({ as: 'p', text: `${tier.name} · ${feature.name}`, className: 'pm-ce-head' }),
      el('div', { class: 'pm-ce-choices' }, [
        radio('on', [el('span', { class: 'pm-check', 'aria-hidden': 'true' }, '✓'), ' Enthalten']),
        radio('value', 'Wert'),
        radio('off', [el('span', { class: 'pm-dash', 'aria-hidden': 'true' }, '–'), ' Nicht enthalten']),
      ]),
      Field({
        label: 'Wert',
        className: 'pm-ce-value-field',
        control: TextInput({ className: 'pm-ce-value', value: valueText, placeholder: 'z.B. 3.000' }),
      }),
      // „ab Version" only gates an included cell, so it is offered but never
      // forced; clearing a cell drops the gate with it (see submit).
      versions.length
        ? Field({
            label: 'ab Version',
            control: Select({
              className: 'pm-ce-version',
              options: [
                { value: '', label: '— von Anfang an —', selected: !availableFrom },
                ...versions.map((v) => ({ value: v, label: v, selected: v === availableFrom })),
              ],
            }),
          })
        : null,
      FormActions({
        className: 'pm-ce-actions',
        children: [
          Button({ label: 'Speichern', type: 'submit' }),
          Button({ label: 'Abbrechen', variant: 'outline', attrs: { 'data-action': 'cancel' } }),
        ],
      }),
    ]),
  );
  layer.hidden = false;
  positionLayer(layer, anchor);

  const form = layer.querySelector('form') as HTMLFormElement;
  const valueInput = layer.querySelector<HTMLInputElement>('.pm-ce-value')!;
  const valueField = layer.querySelector<HTMLElement>('.pm-ce-value-field')!;
  const versionSelect = layer.querySelector<HTMLSelectElement>('.pm-ce-version');
  const modeInputs = [...layer.querySelectorAll<HTMLInputElement>('input[name="pm-ce-mode"]')];
  const selectedMode = (): Mode => (modeInputs.find((i) => i.checked)?.value as Mode) ?? 'off';

  // The value input and the version gate only apply to a cell that is actually
  // included, so they follow the chosen mode instead of sitting there inert.
  const syncMode = () => {
    const m = selectedMode();
    valueField.hidden = m !== 'value';
    if (versionSelect) versionSelect.disabled = m === 'off';
  };
  syncMode();
  modeInputs.forEach((i) =>
    i.addEventListener('change', () => {
      syncMode();
      if (selectedMode() === 'value') valueInput.focus();
      positionLayer(layer, anchor);
    }),
  );

  const close = () => {
    layer.hidden = true;
    layer.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    closeActive = null;
  };
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      anchor.focus();
    }
  }
  // Capture phase: the matrix's own cell listener would otherwise reopen the
  // editor for the cell being clicked through to.
  function onOutside(e: Event) {
    if (!layer.contains(e.target as Node)) close();
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  closeActive = close;

  form.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.addEventListener('click', () => {
    close();
    anchor.focus();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const m = selectedMode();
    const text = valueInput.value.trim();
    // A "Wert" with nothing typed is the same cell state as "not included" — it
    // renders as a dash and the server clears on a falsy value, so don't pretend
    // the two differ.
    const value: string | boolean | null = m === 'on' ? true : m === 'value' && text ? text : null;
    const from = value === null ? null : versionSelect?.value.trim() || null;
    close();
    void saveCell(sourceId, tier, featureId, value, from);
  });

  (modeInputs.find((i) => i.checked) ?? modeInputs[0])?.focus();
}

async function saveCell(
  sourceId: string,
  tier: PricingTier,
  featureId: string,
  value: string | boolean | null,
  availableFrom: string | null,
): Promise<void> {
  // Imported lazily to keep the module graph acyclic: pricingMatrix.ts owns the
  // cell click that opens this editor.
  const { repaintPricingView } = await import('./pricingMatrix');
  try {
    await apiSetTierValue(sourceId, tier.id, featureId, value, availableFrom);
  } catch (err) {
    setStatus(`Zelle speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Mirror the authoritative write into the in-memory model. Clearing drops the
  // version gate with the value — server-side the whole cell row is deleted, so
  // leaving a stale gate behind would resurrect it on the next write.
  tier.values = tier.values ?? {};
  if (value === null) {
    delete tier.values[featureId];
    if (tier.valueVersions) delete tier.valueVersions[featureId];
  } else {
    tier.values[featureId] = value;
    if (availableFrom) {
      tier.valueVersions = tier.valueVersions ?? {};
      tier.valueVersions[featureId] = availableFrom;
    } else if (tier.valueVersions) {
      delete tier.valueVersions[featureId];
    }
  }

  repaintPricingView();
  setStatus(value === null ? 'Zelle geleert' : 'Zelle gespeichert');
}
