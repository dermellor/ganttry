// TimelineKind registration seam.
//
// A "kind" is a timeline flavour that contributes extra views/renderers on top
// of the generic timeline+list core (the first is 'product-roadmap' = the
// pricing matrix/cards). The core stays free of any kind-specific import:
//
//   - `matches` / `viewModes` are lightweight, synchronous data checks — they
//     pull in NO kind code, so the generic bundle never statically reaches the
//     kind's modules.
//   - `load()` is a dynamic import(); Rollup emits everything reachable from it
//     as a separate chunk. It runs only when a matching timeline enters the
//     kind's view, so a generic build never downloads the kind's code.
//
// Adding a further kind is a new entry here plus a src/kinds/<name>/ folder — no
// change to the generic core.

import type { TimelineFile } from '../types';
import { PRODUCT_ROADMAP_PLUGIN, hasPlugin } from '../plugins';

// Extra header view modes a kind adds beyond the generic 'timeline' / 'list'.
export type ExtraViewMode = 'pricing';

// The lazily-loaded surface a kind exposes to the core.
export interface KindModule {
  /** Render the kind's custom view into its host section (reads app state). */
  renderView(): void;
}

export interface KindDescriptor {
  id: 'product-roadmap';
  /** Cheap predicate — decides button visibility + mode validity. No kind imports. */
  matches(file: TimelineFile | null | undefined): boolean;
  /** Extra view modes this kind contributes. */
  viewModes: ExtraViewMode[];
  /** Dynamic import of the kind's module — the only edge into its chunk. */
  load(): Promise<KindModule>;
}

const KINDS: KindDescriptor[] = [
  {
    id: 'product-roadmap',
    // Enabled by the product-roadmap plugin registration (a data row), plus a
    // populated pricing model. Still a cheap sync check that pulls in no pricing
    // code, so the generic bundle never reaches the kind's chunk.
    matches: (f) =>
      hasPlugin(f, PRODUCT_ROADMAP_PLUGIN) &&
      !!f?.pricing &&
      (f.pricing.tiers.length > 0 || f.pricing.features.length > 0),
    viewModes: ['pricing'],
    load: () => import('./product-roadmap/index'),
  },
];

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
