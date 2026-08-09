// Tier (matrix column) edit form: Stammdaten of a single PricingTier, shown in
// the same detail drawer as items, phases and features. Saving writes the ONE
// edited tier row through the granular PATCH endpoint (optimistic-locked on
// rowVersion), so a concurrent edit elsewhere in the model is never clobbered.
//
// The tier's *cells* are not edited here — those are per-cell writes off the
// matrix itself (cellEditor.ts), which keeps two people editing different cells
// of the same column from colliding.

import { Button, el, Field, FormActions, TextArea, TextInput } from '../../pluginHost/api';
import type { PricingTier } from '../../types';
import { state, els, setStatus, clearFormSlots } from '../../state';
import { apiAddTier, apiUpdateTier, apiDeleteTier, ConflictError } from '../../editor';
import { hideDetail, setDetailTitle } from '../../detailPanel';
import { repaintPricingView } from './pricingMatrix';
import { slugId } from './pricing';
import { renderTimeline } from '../../render';

function findTier(tierId: string): PricingTier | undefined {
  return state.activeSourceFile?.pricing?.tiers.find((t) => t.id === tierId);
}

export function showTierForm(tierId: string): void {
  const tier = findTier(tierId);
  if (!tier) return;
  clearFormSlots();
  state.activeFormTierId = tierId;

  setDetailTitle(tier.name || '(unbenannter Tarif)');
  els.detailMeta.replaceChildren();

  const form = el('form', { class: 'ds-FormGrid tier-form', 'data-id': tierId }, [
    Field({
      label: 'Name',
      htmlFor: 'tr-name',
      full: true,
      control: TextInput({ id: 'tr-name', name: 'name', value: tier.name ?? '' }),
    }),
    Field({
      label: 'Preis',
      hint: '(Freitext, inkl. Währung)',
      htmlFor: 'tr-price',
      full: true,
      control: TextInput({
        id: 'tr-price',
        name: 'price',
        value: tier.price ?? '',
        placeholder: 'z.B. ab 449,95 €/Monat',
      }),
    }),
    Field({
      label: 'Tagline',
      hint: '(Segment, unter dem Namen)',
      htmlFor: 'tr-tagline',
      full: true,
      control: TextInput({
        id: 'tr-tagline',
        name: 'tagline',
        value: tier.tagline ?? '',
        placeholder: 'z.B. Micro · 1–5 Anrufe/Tag',
      }),
    }),
    Field({
      label: 'Use Case',
      hint: '(Sub-Headline der Karte)',
      htmlFor: 'tr-usecase',
      full: true,
      control: TextInput({
        id: 'tr-usecase',
        name: 'useCase',
        value: tier.useCase ?? '',
        placeholder: 'z.B. Verpasste Anrufe auffangen',
      }),
    }),
    Field({
      label: 'Zielgruppe',
      htmlFor: 'tr-target',
      full: true,
      control: TextArea({ id: 'tr-target', name: 'targetGroup', rows: 2, value: tier.targetGroup ?? '' }),
    }),
    Field({
      label: 'ID',
      hint: '(read-only)',
      htmlFor: 'tr-id',
      control: TextInput({ id: 'tr-id', name: 'id', value: tierId, readonly: true }),
    }),
    FormActions({
      children: [
        Button({ label: 'Speichern', type: 'submit' }),
        Button({ label: 'Löschen', variant: 'danger', attrs: { 'data-action': 'delete' } }),
      ],
    }),
  ]);

  els.detailBody.replaceChildren(form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void saveTierFromForm(tierId, form);
  });
  form.querySelector<HTMLButtonElement>('[data-action="delete"]')!.addEventListener('click', () => {
    void deleteTier(tierId);
  });

  // Pricing view has no timeline behind the overlay, so just show the panel.
  els.detail.hidden = false;
}

async function saveTierFromForm(tierId: string, form: HTMLFormElement): Promise<void> {
  const tier = findTier(tierId);
  const sourceId = state.activeSourceId;
  if (!tier || !sourceId) return;
  const fd = new FormData(form);
  const get = (name: string) => String(fd.get(name) ?? '').trim();

  // name/price are required columns, so they fall back to the stored value rather
  // than being cleared; the optionals are cleared with an explicit null so the
  // server resets the column (an omitted key would leave the old value intact and
  // it'd reappear on reload).
  const patch: Partial<PricingTier> = {
    name: get('name') || tier.name,
    price: get('price') || tier.price,
    tagline: get('tagline') || null,
    useCase: get('useCase') || null,
    targetGroup: get('targetGroup') || null,
  } as Partial<PricingTier>;

  try {
    const saved = await apiUpdateTier(sourceId, tierId, patch, tier.rowVersion);
    // Adopt the authoritative row, resetting the clearable optionals first so a
    // cleared field doesn't linger. The response re-reads the cell rows too
    // (updateTier in timeline-repo.ts), so `values`/`valueVersions` come back
    // whole and need no preserving.
    Object.assign(tier, { tagline: undefined, useCase: undefined, targetGroup: undefined }, saved);
    repaintPricingView();
    setStatus(`Tarif „${tier.name}" aktualisiert`);
    showTierForm(tierId);
  } catch (err) {
    if (err instanceof ConflictError) {
      setStatus('Tarif wurde extern geändert — lade neu…');
      if (state.activeView) await renderTimeline(state.activeView);
      return;
    }
    setStatus(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function deleteTier(tierId: string): Promise<void> {
  const pricing = state.activeSourceFile?.pricing;
  const sourceId = state.activeSourceId;
  const tier = pricing && findTier(tierId);
  if (!pricing || !tier || !sourceId) return;
  // A tier owns a whole column of cells, so say so — this is not a one-field undo.
  const cellCount = Object.keys(tier.values ?? {}).length;
  const extra = cellCount ? ` Damit verschwinden auch ${cellCount} Matrix-Werte.` : '';
  if (!confirm(`Tarif „${tier.name}" wirklich löschen?${extra}`)) return;

  try {
    await apiDeleteTier(sourceId, tierId);
  } catch (err) {
    setStatus(`Löschen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Server-side the cell rows cascade away; mirror that in memory for an
  // immediate repaint.
  pricing.tiers = pricing.tiers.filter((t) => t.id !== tierId);
  state.activeFormTierId = null;
  repaintPricingView();
  hideDetail();
  setStatus(`Tarif „${tier.name}" gelöscht`);
}

/**
 * Create a tier and open its form. The row is written immediately (rather than
 * the form saving a draft) so the new column exists server-side before the user
 * starts filling cells — the same "create then edit" flow items use.
 */
export async function addTier(): Promise<void> {
  const pricing = state.activeSourceFile?.pricing;
  const sourceId = state.activeSourceId;
  if (!pricing || !sourceId) return;

  const name = prompt('Name des neuen Tarifs?')?.trim();
  if (!name) return;

  const id = slugId(
    name,
    pricing.tiers.map((t) => t.id),
    'tarif',
  );
  try {
    // A new column starts empty: no price, no cells. Both are filled from the UI
    // afterwards — the form for the price, the matrix cells one click each.
    const saved = await apiAddTier(sourceId, { id, name, price: '', values: {} });
    pricing.tiers.push(saved);
    repaintPricingView();
    showTierForm(saved.id ?? id);
    setStatus(`Tarif „${name}" angelegt`);
  } catch (err) {
    setStatus(`Tarif anlegen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
}
