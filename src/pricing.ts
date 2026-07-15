// Pricing → Markdown serializer. The timeline (DB) is the source of truth for a
// product timeline's pricing model; `scripts/pricing-export.ts` pulls it via the
// API and writes the result of `pricingToMarkdown` into the vault as a generated
// document. Pure and deterministic (no Date / IO) so it's unit-testable and the
// caller stamps the date.

import type { Pricing, PricingFeature, PricingTier } from './types';

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
        lines.push(`| ${cell(f.name)} | ${[...marks, ...tail].join(' | ')} |`);
      }
    }
    lines.push('');

    // ---- Machine-readable block -----------------------------------------
    lines.push('## Rohdaten');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(pricing, null, 2));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}
