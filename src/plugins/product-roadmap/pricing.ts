// Pricing → Markdown serializer. The timeline (DB) is the source of truth for a
// product timeline's pricing model; `scripts/pricing-export.ts` pulls it via the
// API and writes the result of `pricingToMarkdown` into the vault as a generated
// document. Pure and deterministic (no Date / IO) so it's unit-testable and the
// caller stamps the date.

import { statusOrDefault, type StatusKey } from '../../pluginHost/api';
import { PRICING_FEATURE_META_KEY, PRICING_ITEM_VERSION_META_KEY } from './plugin';
import { t } from './messages';
import {
  type TimelineFileItem,
} from '../../types';
import {
  type Pricing,
  type PricingFeature,
  type PricingHighlight,
  type PricingTier,
} from './types';

export type PricingDoc = {
  timelineId: string;
  name?: string;
  pricing: Pricing;
};

// Escape a value for use inside a Markdown table cell.
function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

// Display label for a version id, falling back to the id itself when no label is
// declared. Every place that PRINTS a version (the switcher, the "ab <version>"
// chips, the version dropdowns, the exported matrix) goes through here; the
// comparison/ordering helpers below never do, because they operate on ids. The
// fallback is deliberate: a re-keyed timeline whose config lost a label still
// renders something addressable rather than an empty chip (issue #110).
export function versionLabel(labels: Record<string, string> | undefined, id: string): string {
  const label = labels?.[id];
  return label != null && label !== '' ? label : id;
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

// Per-cell version gate (tier×feature), the cell-level analog of
// `featureVisibleForVersion`: a matrix cell counts as included when no version is
// selected ("Alle" → show the end state), when the cell carries no
// `availableFrom` (included from the start), or when its `availableFrom` comes at
// or before the selected version in the ordered list. Unknown versions never
// gate. `availableFrom` comes from `PricingTier.valueVersions[featureId]`.
export function cellActiveForVersion(
  availableFrom: string | undefined,
  versions: string[],
  selected: string | null,
): boolean {
  if (!selected) return true;
  if (!availableFrom) return true;
  const selIdx = versions.indexOf(selected);
  const aIdx = versions.indexOf(availableFrom);
  if (selIdx < 0 || aIdx < 0) return true;
  return aIdx <= selIdx;
}

// The version a "New" badge is judged against: the selected switcher version, or
// (when "Alle" is selected) the newest declared version — so "New" always points
// at the latest release until the user pins an older one.
export function referenceVersion(versions: string[], selected: string | null): string | undefined {
  return selected ?? versions[versions.length - 1];
}

// A feature is "New" once the user pins the switcher to the exact version it was
// introduced at — including the very first (baseline) version: a feature
// explicitly tagged with a version was introduced in that release (as opposed to
// pre-existing/unversioned features, which existed before and never badge).
// "Alle" never shows a badge (it's the cumulative "everything" view, not a claim
// about what's newest; there the "ab <version>" chip carries that info instead).
export function isNewFeature(feature: PricingFeature, versions: string[], selected: string | null): boolean {
  if (!selected) return false;
  return !!feature.version && feature.version === selected;
}

// A feature is "Modified" for the pinned version when it is NOT new there (it
// existed in an earlier version) AND that version brought a change to it. A
// change is signalled by EITHER roadmap work targeting that version (an item
// links to the feature with featureVersion == selection) OR a version-scoped
// description for that version (descriptionByVersion[selected]) — the latter lets
// a documented-but-untracked change badge as Modified even without any work item.
// Mutually exclusive with "New" (a newly-introduced feature badges as New, not
// Modified). Like New, it needs a pinned version ("Alle" → none).
export function isModifiedFeature(
  feature: PricingFeature,
  items: TimelineFileItem[],
  versions: string[],
  selected: string | null,
): boolean {
  if (!selected) return false; // "Alle" → no badge
  if (feature.version === selected) return false; // introduced here → "New", not modified
  // The feature must PREDATE the selected version: either pre-existing (no
  // version = existed before the first tracked version) or introduced in an
  // earlier tracked version. (This is what lets a pre-existing feature badge as
  // "Modified" even at the baseline version.)
  const predates =
    !feature.version ||
    (versions.indexOf(feature.version) >= 0 && versions.indexOf(feature.version) < versions.indexOf(selected));
  if (!predates) return false;
  const hasVersionDescription = !!feature.descriptionByVersion?.[selected]?.trim();
  return hasVersionDescription || itemsForFeature(feature.id, items, selected).length > 0;
}

// A feature needs a work warning when the pinned version marks it as New OR
// Modified but no roadmap item targets it there — i.e. it shipped on the price
// list (freshly introduced, or documented as changed via a version description)
// without any tracked work behind it. A Modified feature that is modified BY a
// work item never warns (it has one by definition); only a description-only
// change trips the warning. Like New/Modified, this needs a pinned version
// ("Alle" → none, since neither badge fires there).
export function needsWorkWarning(
  feature: PricingFeature,
  items: TimelineFileItem[],
  versions: string[],
  selected: string | null,
): boolean {
  const flagged =
    isNewFeature(feature, versions, selected) || isModifiedFeature(feature, items, versions, selected);
  if (!flagged) return false;
  return itemsForFeature(feature.id, items, selected).length === 0;
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

/** One version-scoped description note, resolved for display. */
export type FeatureDescriptionNote = { version: string; text: string };

/** Structured, display-ready description of a feature (see `resolveFeatureDescriptionParts`). */
export type FeatureDescriptionParts = {
  /** The base `description`, trimmed; undefined when absent/blank. */
  base?: string;
  /** Version-scoped notes in declared version order (blank entries dropped). */
  notes: FeatureDescriptionNote[];
};

/**
 * Structured, additive description of a feature (changelog-style): the base
 * `description` plus every non-blank `descriptionByVersion` note, ordered by the
 * declared `versions` (falling back to the object's own key order when no
 * versions are declared). Consumers render this however they like — the styled
 * matrix tooltip lays base + notes out underneath each other.
 */
export function resolveFeatureDescriptionParts(
  feature: PricingFeature,
  versions: string[],
): FeatureDescriptionParts {
  const base = feature.description?.trim() || undefined;
  const notes: FeatureDescriptionNote[] = [];
  const raw = feature.descriptionByVersion;
  if (raw) {
    const order = versions.length ? versions : Object.keys(raw);
    for (const v of order) {
      const text = raw[v]?.trim();
      if (text) notes.push({ version: v, text });
    }
  }
  return { base, notes };
}

/**
 * Flat text form of {@link resolveFeatureDescriptionParts}: the base description
 * first, then each note as its own "ab <version>: <text>" line. Returns '' when
 * the feature carries no description at all. Kept for non-HTML consumers (tests,
 * plain-text contexts).
 */
export function resolveFeatureDescription(
  feature: PricingFeature,
  versions: string[],
  labels?: Record<string, string>,
): string {
  const { base, notes } = resolveFeatureDescriptionParts(feature, versions);
  const lines: string[] = [];
  if (base) lines.push(base);
  // `n.version` is a version id; the note prints its label (id fallback built in).
  for (const n of notes) lines.push(`ab ${versionLabel(labels, n.version)}: ${n.text}`);
  return lines.join('\n');
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
  // The version at which the highlight first became available for this tier: the
  // earliest version among its included, version-carrying features. `undefined`
  // when any included feature is pre-existing (no version → available from the
  // start) or none carry a version. Drives the "ab <version>" chip in "Alle" mode.
  introducedVersion?: string;
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
  let hasPreexisting = false;
  let earliestIdx = Infinity;
  let introducedVersion: string | undefined;
  const vals: string[] = [];
  for (const fid of highlight.featureIds) {
    const feat = byId.get(fid);
    if (!feat) continue;
    if (selected && !featureVisibleForVersion(feat, versions, selected)) continue;
    // Per-cell gate: a feature can arrive in *this tier* only from a later
    // version than it was introduced globally (valueVersions[fid]). When pinned
    // before that version the cell isn't included here yet.
    const af = tier.valueVersions?.[fid];
    if (selected && !cellActiveForVersion(af, versions, selected)) continue;
    // Effective introduction version for this tier: the cell gate wins over the
    // feature's own introduction version.
    const effVersion = af ?? feat.version;
    const cellIsNew = !!selected && !!effVersion && effVersion === selected;
    const v = tier.values?.[fid];
    let contributes = false;
    if (v === true) {
      included = true;
      contributes = true;
    } else if (typeof v === 'string' && v.trim()) {
      included = true;
      contributes = true;
      vals.push(v.trim());
    }
    if (!contributes) continue;
    if (isNewFeature(feat, versions, selected) || cellIsNew) isNew = true;
    // Track when the highlight first became available for this tier: pre-existing
    // (no effective version) features win — they mean it was always there, so no
    // "ab" chip. Otherwise keep the earliest effective version among the
    // contributing features.
    if (!effVersion) {
      hasPreexisting = true;
    } else {
      const idx = versions.indexOf(effVersion);
      const rank = idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
      if (rank < earliestIdx) {
        earliestIdx = rank;
        introducedVersion = effVersion;
      }
    }
  }
  if (hasPreexisting) introducedVersion = undefined;
  return { included, value: vals.join(', '), isNew, introducedVersion };
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
/**
 * Derive a readable id from a display name, uniquified against `taken`. Pricing
 * ids are slugs rather than opaque handles so the model stays legible in SQL and
 * MCP output; features and tiers share this so the two can't drift into different
 * id styles. `fallback` covers a name that slugifies to nothing (e.g. "✓").
 */
export function slugId(name: string, taken: Iterable<string>, fallback: string): string {
  const umlauts: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
  const base =
    name
      .toLowerCase()
      .replace(/[äöüß]/g, (c) => umlauts[c] ?? c)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** One ordered version entry: a display label and, for an EXISTING version being
 *  kept or renamed, its stable id. */
export type VersionEntry = { label: string; id?: string };

/**
 * Turn an ordered list of `{label, id?}` entries into the plugin config a version
 * carries: `versions` (ordered ids) and `versionLabels` (id → label). Used by the
 * label→id migration, and available to any caller building a version config for
 * `enable_plugin` rather than hand-assembling the two structures.
 *
 * An entry that brings its own `id` keeps it — that is the whole point of the
 * split (issue #110): a rename is the same id with a new label, so every
 * `featureVersion` / feature `version` / `valueVersions` / `*ByVersion` key still
 * resolves. An entry without an id is a new version and gets a slug of its label
 * (via `slugId`), uniquified against the ids already assigned so two versions
 * never collide, with `v` as the fallback for a label that slugifies to nothing.
 */
export function versionConfigFromEntries(
  entries: VersionEntry[],
): { versions: string[]; versionLabels: Record<string, string> } {
  const versions: string[] = [];
  const versionLabels: Record<string, string> = {};
  for (const entry of entries) {
    const id = entry.id?.trim() || slugId(entry.label, versions, 'v');
    versions.push(id);
    versionLabels[id] = entry.label;
  }
  return { versions, versionLabels };
}

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
  const labels = pricing.versionLabels;
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
      t('export.note'),
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
    const header = ['Feature', ...tiers.map((t) => cell(t.name)), ...(withVersions ? [t('version.from')] : [])];
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
        const tail = withVersions ? [f.version ? cell(versionLabel(labels, f.version)) : ''] : [];
        lines.push(`| ${cell(resolveFeatureName(f, versions, null))} | ${[...marks, ...tail].join(' | ')} |`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
