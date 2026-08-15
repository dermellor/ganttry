// Tier (matrix column) edit form: Stammdaten of a single PricingTier, shown in
// the same detail drawer as items, phases and features. Saving writes the ONE
// edited tier row through the granular PATCH endpoint (optimistic-locked on
// rowVersion), so a concurrent edit elsewhere in the model is never clobbered.
//
// The tier's *cells* are not edited here — those are per-cell writes off the
// matrix itself (cellEditor.ts), which keeps two people editing different cells
// of the same column from colliding.

import { Button, ConflictError, el, Field, FormActions, TextArea, TextInput } from '../../pluginHost/viewApi';
import type { PricingTier } from './types';
import { apiAddTier, apiUpdateTier, apiDeleteTier } from './api';
import { applyRow, dropRow, dropRowsWhere } from './store';
import { PRICING_COLLECTIONS } from './manifest';
import { file, hostApi, status } from './host';
import { repaintPricingView } from './pricingMatrix';
import { slugId } from './pricing';
import { currentPricing } from './compose';

function findTier(tierId: string): PricingTier | undefined {
  return currentPricing(file())?.tiers.find((t) => t.id === tierId);
}

export function showTierForm(tierId: string): void {
  const tier = findTier(tierId);
  if (!tier) return;

  const form = el('form', { class: 'ds-FormGrid tier-form', 'data-id': tierId }, [
    Field({
      label: 'Name',
      htmlFor: 'tr-name',
      full: true,
      control: TextInput({ id: 'tr-name', name: 'name', value: tier.name ?? '' }),
    }),
    Field({
      label: 'Preis',
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

  // The host owns the drawer, records that a plugin form is open and hands over a
  // container. Wiring follows on the element we still hold.
  hostApi().panel?.open({
    title: tier.name || '(unbenannter Tarif)',
    render: (container) => container.replaceChildren(form),
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void saveTierFromForm(tierId, form);
  });
  form.querySelector<HTMLButtonElement>('[data-action="delete"]')!.addEventListener('click', () => {
    void deleteTier(tierId);
  });
}

async function saveTierFromForm(tierId: string, form: HTMLFormElement): Promise<void> {
  const tier = findTier(tierId);
  if (!tier) return;
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
    const saved = await apiUpdateTier(tierId, patch, tier.rowVersion);
    // Replace the stored ROW rather than merging into the composed model, which
    // is recomposed on every read (see ./store.ts). The cells are untouched by
    // design — they are their own rows, so a rename cannot disturb a column.
    applyRow(file(), PRICING_COLLECTIONS.tiers, saved);
    repaintPricingView();
    status(`Tarif „${patch.name ?? tier.name}" aktualisiert`);
    showTierForm(tierId);
  } catch (err) {
    if (err instanceof ConflictError) {
      // The row moved under us. The host's reload brings the new one in;
      // repainting from the stale snapshot would show the value we failed to write
      // as if it had been saved.
      status('Tarif wurde extern geändert — lade neu…');
      return;
    }
    status(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function deleteTier(tierId: string): Promise<void> {
  const pricing = currentPricing(file());
  const tier = pricing && findTier(tierId);
  if (!pricing || !tier) return;
  // A tier owns a whole column of cells, so say so — this is not a one-field undo.
  const cellCount = Object.keys(tier.values ?? {}).length;
  const extra = cellCount ? ` Damit verschwinden auch ${cellCount} Matrix-Werte.` : '';
  if (!confirm(`Tarif „${tier.name}" wirklich löschen?${extra}`)) return;

  try {
    await apiDeleteTier(tierId);
  } catch (err) {
    status(`Löschen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // The host applied the declared cascade and took the column's cells with the
  // tier; mirror both so the matrix repaints without a reload.
  dropRow(file(), PRICING_COLLECTIONS.tiers, tierId);
  dropRowsWhere(file(), PRICING_COLLECTIONS.tierValues, (d) => d.tierId === tierId);
  repaintPricingView();
  hostApi().panel?.close();
  status(`Tarif „${tier.name}" gelöscht`);
}

/**
 * Create a tier and open its form. The row is written immediately (rather than
 * the form saving a draft) so the new column exists server-side before the user
 * starts filling cells — the same "create then edit" flow items use.
 */
export async function addTier(): Promise<void> {
  const pricing = currentPricing(file());
  if (!pricing) return;

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
    const saved = await apiAddTier({ id, name, price: '', values: {} });
    applyRow(file(), PRICING_COLLECTIONS.tiers, saved);
    repaintPricingView();
    showTierForm(saved.id);
    status(`Tarif „${name}" angelegt`);
  } catch (err) {
    status(`Tarif anlegen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
}
