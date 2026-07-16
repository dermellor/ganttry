// Pricing → Markdown serializer. The timeline (DB) is the source of truth for a
// product timeline's pricing model; `scripts/pricing-export.ts` pulls it via the
// API and writes the result of `pricingToMarkdown` into the vault as a generated
// document. Pure and deterministic (no Date / IO) so it's unit-testable and the
// caller stamps the date.

import { statusOrDefault, type StatusKey } from './status';
import {
  PRICING_FEATURE_META_KEY,
  PRICING_ITEM_VERSION_META_KEY,
  type Pricing,
  type PricingFeature,
  type PricingHighlight,
  type PricingTier,
  type TimelineFileItem,
} from './types';

export type PricingDoc = {
  timelineId: string;
  name?: string;
  type?: string;
  pricing: Pricing;
};

// Escape a value for use inside a Markdown table cell.
function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

// Cumulative version filter (shared by the app matrix + potential export use):
// a feature is visible when no version is selected ("Alle"), when the feature has
// no version (available from the start), or when its version comes at or before
// the selected one in the ordered `versions` list. Unknown versions never hide.
export function featureVisibleForVersion(
  feature: PricingFeature,
  versions: string[],
  selected: string | null,
): boolean {
  if (!selected) return true;
  if (!feature.version) return true;
  const selIdx = versions.indexOf(selected);
  const fIdx = versions.indexOf(feature.version);
  if (selIdx < 0 || fIdx < 0) return true;
  return fIdx <= selIdx;
}

// The version a "New" badge is judged against: the selected switcher version, or
// (when "Alle" is selected) the newest declared version — so "New" always points
// at the latest release until the user pins an older one.
export function referenceVersion(versions: string[], selected: string | null): string | undefined {
  return selected ?? versions[versions.length - 1];
}

// A feature is "New" only once the user pins the switcher to the exact version it
// was introduced at — "Alle" never shows a badge (it's the cumulative "everything"
// view, not a claim about what's newest). The very first declared version is the
// baseline release: nothing is "new" relative to it (there's no prior version to
// compare against), so it never badges even when a feature is explicitly tagged
// with that version instead of left unversioned.
export function isNewFeature(feature: PricingFeature, versions: string[], selected: string | null): boolean {
  if (!selected || selected === versions[0]) return false;
  return feature.version === selected;
}

// Resolve a version-scoped text override cumulatively: the latest override at or
// before the effective version wins, falling back to `base`. "Alle" (selected =
// null) resolves against the newest declared version, i.e. the fully-evolved
// text. Shared by feature names (`nameByVersion`) and highlight labels
// (`labelByVersion`) — same cumulative semantics as `feature.version`.
export function resolveVersionedText(
  base: string,
  overrides: Record<string, string> | undefined,
  versions: string[],
  selected: string | null,
): string {
  if (!overrides || !Object.keys(overrides).length) return base;
  const effective = referenceVersion(versions, selected);
  if (!effective) return base;
  const idx = versions.indexOf(effective);
  if (idx < 0) return base;
  let resolved = base;
  for (let i = 0; i <= idx; i++) {
    const ov = overrides[versions[i]];
    if (ov) resolved = ov;
  }
  return resolved;
}

/** Display name of a feature at the selected version (see `resolveVersionedText`). */
export function resolveFeatureName(feature: PricingFeature, versions: string[], selected: string | null): string {
  return resolveVersionedText(feature.name, feature.nameByVersion, versions, selected);
}

/** Card label of a highlight at the selected version (see `resolveVersionedText`). */
export function resolveHighlightLabel(
  highlight: PricingHighlight,
  versions: string[],
  selected: string | null,
): string {
  return resolveVersionedText(highlight.label, highlight.labelByVersion, versions, selected);
}

// ---- work indicator (pure helpers, shared with the matrix view) ------------

// Aggregate work state for a feature row, derived from its linked items' status.
export type WorkState = 'doing' | 'done' | 'open' | 'none';

/** Feature ids an item is assigned to (tolerates scalar or array in metadata). */
export function readItemFeatureIds(meta: unknown): string[] {
  const v = (meta as Record<string, unknown> | undefined)?.[PRICING_FEATURE_META_KEY];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

/** The pricing version an item's work targets, or undefined. */
export function itemVersion(it: TimelineFileItem): string | undefined {
  const v = it.metadata?.[PRICING_ITEM_VERSION_META_KEY];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Items linked to a feature, filtered by the selected version: exact match on the
 * item's targeted version, or all items when `selected` is null ("Alle").
 */
export function itemsForFeature(
  featureId: string,
  items: TimelineFileItem[],
  selected: string | null,
): TimelineFileItem[] {
  return items.filter(
    (it) =>
      readItemFeatureIds(it.metadata).includes(featureId) &&
      (!selected || itemVersion(it) === selected),
  );
}

// Items linked to ANY of the given feature ids (deduped, version-filtered) —
// used for a highlight tile that bundles several features on the card view.
export function itemsForFeatures(
  featureIds: string[],
  items: TimelineFileItem[],
  selected: string | null,
): TimelineFileItem[] {
  const seen = new Set<string>();
  const out: TimelineFileItem[] = [];
  for (const fid of featureIds) {
    for (const it of itemsForFeature(fid, items, selected)) {
      const key = it.id ?? `${it.content}:${it.start ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

/**
 * Aggregate = the status the contained items hold by *majority*. Ties are broken
 * by priority Doing > Open > Done (an in-progress signal wins over pending, which
 * wins over completed). Empty → 'none'.
 */
export function aggregateWorkState(items: TimelineFileItem[]): WorkState {
  if (!items.length) return 'none';
  const counts: Record<StatusKey, number> = { Open: 0, Doing: 0, Done: 0 };
  for (const it of items) counts[statusOrDefault(it.status)]++;
  // Tie-break order: the first with a strictly greater count wins, so on equal
  // counts the earlier entry (Doing, then Open, then Done) is kept.
  const order: StatusKey[] = ['Doing', 'Open', 'Done'];
  let best: StatusKey = order[0];
  for (const k of order) if (counts[k] > counts[best]) best = k;
  return best.toLowerCase() as WorkState;
}

// ---- card view (highlight tiles per tier) ----------------------------------

export type ResolvedHighlight = {
  // Whether the tier includes this highlight at all (≥1 of its features present).
  included: boolean;
  // Joined string value(s) for value-features (e.g. "3.000"); empty for a purely
  // boolean highlight. Drives "Label: value" vs a plain checkmark on the card,
  // and — together with `included` — the "Alles aus <prev>" inheritance diff.
  value: string;
  // True when at least one of the highlight's included features is "New" at the
  // reference version (see `isNewFeature`) — drives the "Neu" badge on the card.
  isNew: boolean;
};

/**
 * Resolve a highlight for one tier: whether the tier includes it, its value, and
 * whether it's "New". A boolean feature (value === true) counts as included with
 * no value; a string value contributes to `value`. Version-aware. Pure — shared
 * by the card view.
 */
export function resolveHighlight(
  highlight: PricingHighlight,
  tier: PricingTier,
  features: PricingFeature[],
  versions: string[],
  selected: string | null,
): ResolvedHighlight {
  const byId = new Map(features.map((f) => [f.id, f]));
  let included = false;
  let isNew = false;
  const vals: string[] = [];
  for (const fid of highlight.featureIds) {
    const feat = byId.get(fid);
    if (!feat) continue;
    if (selected && !featureVisibleForVersion(feat, versions, selected)) continue;
    const v = tier.values?.[fid];
    if (v === true) {
      included = true;
      if (isNewFeature(feat, versions, selected)) isNew = true;
    } else if (typeof v === 'string' && v.trim()) {
      included = true;
      vals.push(v.trim());
      if (isNewFeature(feat, versions, selected)) isNew = true;
    }
  }
  return { included, value: vals.join(', '), isNew };
}

// Render one tier's value for a feature as Markdown cell content:
// true → ✓, false/absent → '' (blank), string → the text.
function markdownCell(tier: PricingTier, featureId: string): string {
  const v = tier.values?.[featureId];
  if (v === true) return '✓';
  if (v === false || v == null || v === '') return '';
  return cell(String(v));
}

// Features grouped by their `group` label, preserving first-seen order for both
// groups and features. Ungrouped features collect under an empty-string key,
// rendered last without a header. Shared by the Markdown serializer and the
// in-app matrix (src/pricingMatrix.ts) so grouping stays consistent.
export function groupFeatures(features: PricingFeature[]): { group: string; features: PricingFeature[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, PricingFeature[]>();
  for (const f of features) {
    const g = f.group?.trim() || '';
    if (!byGroup.has(g)) {
      byGroup.set(g, []);
      order.push(g);
    }
    byGroup.get(g)!.push(f);
  }
  // Named groups first (in first-seen order), the ungrouped bucket last.
  order.sort((a, b) => (a === '' ? 1 : b === '' ? -1 : 0));
  return order.map((group) => ({ group, features: byGroup.get(group)! }));
}

/**
 * Render a product timeline's pricing model as a generated Markdown document:
 * a "do not edit" banner, a feature×tier matrix, and a machine-readable JSON
 * block for potential round-tripping. `updated` is injected by the caller.
 */
export function pricingToMarkdown(doc: PricingDoc, opts: { updated: string }): string {
  const { timelineId, name, pricing } = doc;
  const tiers = pricing.tiers ?? [];
  const features = pricing.features ?? [];
  const versions = pricing.versions ?? [];
  const title = (name?.trim() || timelineId) + ' – Preismodell';

  const lines: string[] = [];
  lines.push('---');
  lines.push('generated: true');
  lines.push('source: timelines');
  lines.push(`timeline: ${timelineId}`);
  lines.push(`updated: ${opts.updated}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${title}`);
  lines.push('');
  lines.push('> [!warning] Automatisch generiert');
  lines.push(
    `> Diese Datei wird aus der Timeline \`${timelineId}\` erzeugt (\`npm run export:pricing\`). ` +
      'Änderungen von Hand gehen beim nächsten Export verloren. Quelle der Wahrheit ist die Timeline.',
  );
  lines.push('');

  if (!tiers.length && !features.length) {
    lines.push('_Kein Preismodell in der Timeline hinterlegt._');
    lines.push('');
  } else {
    // ---- Feature matrix --------------------------------------------------
    // When versions are declared, add a trailing "Ab Version" column so the
    // static doc still carries the availability info the app shows via the switcher.
    const withVersions = (pricing.versions?.length ?? 0) > 0;
    lines.push('## Feature-Matrix');
    lines.push('');
    const header = ['Feature', ...tiers.map((t) => cell(t.name)), ...(withVersions ? ['Ab Version'] : [])];
    const align = ['---', ...tiers.map(() => ':--:'), ...(withVersions ? [':--:'] : [])];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${align.join(' | ')} |`);
    // Price row directly under the header.
    const priceCells = [...tiers.map((t) => cell(t.price)), ...(withVersions ? [''] : [])];
    lines.push(`| **Preis** | ${priceCells.join(' | ')} |`);
    for (const { group, features: fs } of groupFeatures(features)) {
      if (group) {
        const emptyCells = [...tiers.map(() => ''), ...(withVersions ? [''] : [])];
        lines.push(`| **${cell(group)}** | ${emptyCells.join(' | ')} |`);
      }
      for (const f of fs) {
        const marks = tiers.map((t) => markdownCell(t, f.id));
        const tail = withVersions ? [f.version ? cell(f.version) : ''] : [];
        lines.push(`| ${cell(resolveFeatureName(f, versions, null))} | ${[...marks, ...tail].join(' | ')} |`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
