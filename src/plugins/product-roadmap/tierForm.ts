// Tier (matrix column) edit form: Stammdaten of a single PricingTier, shown in
// the same detail drawer as items, phases and features. Saving writes the ONE
// edited tier row through the granular PATCH endpoint (optimistic-locked on
// rowVersion), so a concurrent edit elsewhere in the model is never clobbered.
//
// The tier's *cells* are not edited here — those are per-cell writes off the
// matrix itself (cellEditor.ts), which keeps two people editing different cells
// of the same column from colliding.

import { escapeHtml } from '../../buildItems';
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
  els.detailMeta.innerHTML = '';

  els.detailBody.classList.add('detail-form');
  els.detailBody.innerHTML = `
    <form class="item-form tier-form" data-id="${escapeHtml(tierId)}">
      <div class="field full">
        <label for="tr-name">Name</label>
        <input id="tr-name" name="name" value="${escapeHtml(tier.name ?? '')}" />
      </div>
      <div class="field full">
        <label for="tr-price">Preis <small>(Freitext, inkl. Währung)</small></label>
        <input id="tr-price" name="price" value="${escapeHtml(tier.price ?? '')}" placeholder="z.B. ab 449,95 €/Monat" />
      </div>
      <div class="field full">
        <label for="tr-tagline">Tagline <small>(Segment, unter dem Namen)</small></label>
        <input id="tr-tagline" name="tagline" value="${escapeHtml(tier.tagline ?? '')}" placeholder="z.B. Micro · 1–5 Anrufe/Tag" />
      </div>
      <div class="field full">
        <label for="tr-usecase">Use Case <small>(Sub-Headline der Karte)</small></label>
        <input id="tr-usecase" name="useCase" value="${escapeHtml(tier.useCase ?? '')}" placeholder="z.B. Verpasste Anrufe auffangen" />
      </div>
      <div class="field full">
        <label for="tr-target">Zielgruppe</label>
        <textarea id="tr-target" name="targetGroup" rows="2">${escapeHtml(tier.targetGroup ?? '')}</textarea>
      </div>
      <div class="field">
        <label for="tr-id">ID <small>(read-only)</small></label>
        <input id="tr-id" name="id" value="${escapeHtml(tierId)}" readonly />
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
