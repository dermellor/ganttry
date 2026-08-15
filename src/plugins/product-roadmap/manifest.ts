// What this plugin declares about itself.
//
// It is also the yardstick for the contract: `product-roadmap` is the most
// demanding plugin that exists here (four kinds of rows, a composite key, two
// cascades, ordering, item links and a public endpoint), so anything it cannot
// declare is a gap in the manifest rather than a licence for it to stay special.
// See <https://github.com/dermellor/zeitlines/issues/17>.
//
// The `collections`, `references` and `publicRead` sections describe what the
// `pricing_*` tables and the `pricing-api` edge function do today. They are
// declared now and enforced by the generic store (#12) and the generic public
// route (#20); until then they are documentation that the validator keeps honest.

import type { PluginManifest } from '../../pluginHost/api';

export const PRICING_COLLECTIONS = {
  features: 'features',
  tiers: 'tiers',
  tierValues: 'tier-values',
  highlights: 'highlights',
} as const;

export const productRoadmapManifest: PluginManifest = {
  id: 'dev.zeitlines.product-roadmap',
  // The literal here is the **fallback**, not the label: the host looks
  // `manifest.name` up in this plugin's catalogue first (see `manifestText` in
  // src/pluginHost/messages.ts), which is what makes the control in the bar follow
  // the reader. English, because that is what a plugin shipping no catalogue at
  // all should fall back to — the product's default language.
  name: 'Product',
  version: '1.0.0',
  apiVersion: '^1',
  capabilities: ['items:read', 'fields', 'views', 'data:own', 'public:read'],

  // What the generated catalogue renders (PLUGINS.md). The keywords are the words
  // a reader searches with rather than the ones the code uses: nobody looks for
  // „tier values", and „Produkt" is the label in a German interface, not a term
  // anybody types into a search.
  catalogue: {
    summary:
      'Keeps a pricing matrix and the roadmap that fills it in one timeline, so the pricing page and the plan cannot drift apart.',
    domain: 'product',
    keywords: ['pricing matrix', 'pricing page', 'product roadmap', 'feature comparison', 'tiers', 'release planning'],
    example: 'src:example-produkt-roadmap',
  },

  views: [
    {
      id: 'pricing',
      // The fallback for `manifest.view.pricing`; see the note on `name` above.
      label: 'Pricing',
      // Declares nothing: the matrix renders tiers against features, so neither
      // the item grouping nor the item filter has anything to act on here. Before
      // views declared their accessories this was the boolean `toolbar: false`,
      // and the host had to decide all-or-nothing for every plugin view.
      icon:
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="3" y="4" width="18" height="16" rx="2" />' +
        '<line x1="3" y1="9" x2="21" y2="9" />' +
        '<line x1="11" y1="9" x2="11" y2="20" />' +
        '</svg>',
    },
  ],
  // Before view modes were addressable this view answered to a bare `pricing`.
  // Dropping the mapping resets every stored preference and breaks every shared
  // deep link, so it stays for as long as such links plausibly exist.
  legacyModeIds: { pricing: 'pricing' },

  configSchema: {
    type: 'object',
    properties: {
      // Ordered list of stable version IDs. Everything references a version by ID
      // (see `Pricing.versions` in ./types.ts); the label is separate so a rename
      // touches nothing else (issue #110).
      versions: { type: 'array', items: { type: 'string' } },
      // Display label per version ID. `additionalProperties: {type: string}` is the
      // JSON-Schema way to say „a string-valued map with arbitrary keys" — the keys
      // are version ids, which are data, not a fixed set.
      versionLabels: { type: 'object', additionalProperties: { type: 'string' } },
    },
    additionalProperties: false,
  },

  collections: [
    { id: PRICING_COLLECTIONS.features, ordered: true },
    { id: PRICING_COLLECTIONS.tiers, ordered: true },
    // A matrix cell has no id of its own: it *is* the pair. Declaring the key
    // fields is what lets the host give it a stable row id and lock it per cell,
    // the way `pricing_tier_values`' composite primary key does today.
    { id: PRICING_COLLECTIONS.tierValues, keyFields: ['tierId', 'featureId'] },
    { id: PRICING_COLLECTIONS.highlights, ordered: true },
  ],
  // The two foreign keys on `pricing_tier_values`: deleting a tier or a feature
  // takes its cells with it. Without this the host cannot know that, and orphaned
  // cells would reappear the moment a row id is reused.
  references: [
    { from: PRICING_COLLECTIONS.tierValues, field: 'tierId', to: PRICING_COLLECTIONS.tiers, onDelete: 'cascade' },
    { from: PRICING_COLLECTIONS.tierValues, field: 'featureId', to: PRICING_COLLECTIONS.features, onDelete: 'cascade' },
    // The third relation, and the one Postgres never enforced: a highlight
    // bundles a LIST of feature ids. `deleteFeature` strips a deleted id out of
    // every highlight by hand today (timeline-repo.ts), which is the loop this
    // declaration replaces. `unlink` rather than `cascade` because the tile is
    // the point: losing one of five features must not delete it.
    {
      from: PRICING_COLLECTIONS.highlights,
      field: 'featureIds',
      to: PRICING_COLLECTIONS.features,
      array: true,
      onDelete: 'unlink',
    },
  ],

  // Item metadata this plugin owns (see ./plugin.ts for why the keys are what
  // they are). Declared so uninstalling can clean them off items instead of
  // leaving them behind in the raw metadata box.
  metadataKeys: ['featureIds', 'featureVersion', 'tier'],

  // What `GET /api/pricing/<id>` serves today: the model, never roadmap items.
  // The host strips internal columns (version, updated_by) generically, so the
  // hand-written `stripRowVersions` goes away with #20.
  publicRead: {
    collections: [
      PRICING_COLLECTIONS.features,
      PRICING_COLLECTIONS.tiers,
      // The cells belong in the public payload: today they arrive folded into
      // each tier's `values`, which is assembly, not a second source.
      PRICING_COLLECTIONS.tierValues,
      PRICING_COLLECTIONS.highlights,
    ],
  },
};
