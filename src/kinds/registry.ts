// TimelineKind registration seam.
//
// A "kind" is a timeline flavour that contributes extra views/renderers and
// extra item fields on top of the generic timeline+list core (the first is
// 'product-roadmap' = the pricing matrix/cards). The core stays free of any
// kind-specific import:
//
//   - `matches` / `viewModes` / `fields` are lightweight, synchronous data
//     checks — they pull in NO kind *view* code, so the generic bundle never
//     statically reaches the kind's renderers.
//   - `load()` is a dynamic import(); Rollup emits everything reachable from it
//     as a separate chunk. It runs only when a matching timeline enters the
//     kind's view, so a generic build never downloads the kind's code.
//
// Adding a further kind is a new entry here plus a src/kinds/<name>/ folder — no
// change to the generic core.

import type { CustomFieldDef, TimelineFile } from '../types';
import { PRODUCT_ROADMAP_PLUGIN, hasPlugin } from '../plugins';
import { productRoadmapFields } from './product-roadmap/fields';

// Extra header view modes a kind adds beyond the generic 'timeline' / 'list'.
export type ExtraViewMode = 'pricing';

// The lazily-loaded surface a kind exposes to the core.
export interface KindModule {
  /** Render the kind's custom view into its host section (reads app state). */
  renderView(): void;
}

export interface KindDescriptor {
  id: 'product-roadmap';
  /** Display name — the item form's section heading for this kind's fields. */
  label: string;
  /** Cheap predicate — decides button visibility + mode validity. No kind imports. */
  matches(file: TimelineFile | null | undefined): boolean;
  /** Extra view modes this kind contributes. */
  viewModes: ExtraViewMode[];
  /**
   * Extra item fields this kind contributes, derived from the timeline's own
   * data. Synchronous and data-only (no view imports), gated internally on the
   * plugin being enabled — so it stays independent of `matches`, which also
   * demands a populated pricing model before offering the *view*.
   */
  fields(file: TimelineFile | null | undefined): CustomFieldDef[];
  /** Dynamic import of the kind's module — the only edge into its chunk. */
  load(): Promise<KindModule>;
}

const KINDS: KindDescriptor[] = [
  {
    id: 'product-roadmap',
    label: 'Produkt',
    // Enabled by the product-roadmap plugin registration (a data row), plus a
    // populated pricing model. Still a cheap sync check that pulls in no pricing
    // code, so the generic bundle never reaches the kind's chunk.
    matches: (f) =>
      hasPlugin(f, PRODUCT_ROADMAP_PLUGIN) &&
      !!f?.pricing &&
      (f.pricing.tiers.length > 0 || f.pricing.features.length > 0),
    viewModes: ['pricing'],
    fields: productRoadmapFields,
    load: () => import('./product-roadmap/index'),
  },
];

/**
 * Every enabled kind's contributed fields, each stamped with its kind's label so
 * the form can section them under a plugin heading. The single seam the generic
 * custom-field machinery (customFields.ts) reads plugin fields through: it knows
 * nothing about which kinds exist or what they contribute.
 *
 * A def that already declares its own `group` keeps it, so a kind can file
 * fields under a sub-heading of its own choosing.
 */
export function pluginFieldDefs(file: TimelineFile | null | undefined): CustomFieldDef[] {
  const out: CustomFieldDef[] = [];
  for (const kind of KINDS) {
    for (const def of kind.fields(file)) {
      out.push(def.group ? def : { ...def, group: kind.label });
    }
  }
  return out;
}

/**
 * The timeline's stored field definitions merged with the contributed ones, one
 * definition per metadata key. A contributed field **wins** over a stored one
 * with the same key: it is derived from the live model, so it cannot drift, which
 * is the whole reason it exists. Two defs on one key would otherwise render two
 * controls writing the same `metadata[key]` — and share one multi-select state
 * bucket, since that is keyed by the field key.
 *
 * This makes cleaning up a superseded stored definition a tidy-up rather than a
 * fix: `tier` was such a hand-seeded copy of the pricing tiers.
 */
export function mergeFieldDefs(
  stored: CustomFieldDef[],
  contributed: CustomFieldDef[],
): CustomFieldDef[] {
  const shadowed = new Set(contributed.map((d) => d.key));
  return [...stored.filter((d) => !shadowed.has(d.key)), ...contributed];
}

/** The kind matching the active timeline, or null for a generic timeline. */
export function activeKind(file: TimelineFile | null | undefined): KindDescriptor | null {
  return KINDS.find((k) => k.matches(file)) ?? null;
}

// Loaded-module cache so the synchronous repaint paths (render.ts) can call the
// view once it has been entered, without re-importing.
let loaded: { id: string; mod: KindModule } | null = null;

/** Import (and cache) a kind's module. Call before rendering its view. */
export async function ensureKindLoaded(desc: KindDescriptor): Promise<KindModule> {
  if (loaded && loaded.id === desc.id) return loaded.mod;
  const mod = await desc.load();
  loaded = { id: desc.id, mod };
  return mod;
}

/** The currently-loaded kind module, or null if none has been entered yet. */
export function loadedKindView(): KindModule | null {
  return loaded?.mod ?? null;
}
