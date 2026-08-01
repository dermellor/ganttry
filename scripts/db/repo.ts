// Storage seam shared by both data-access drivers.
//
// `TimelineRepo` is the driver-agnostic interface every storage method is
// exposed through, with the DB client ALREADY BOUND (no leading client param).
// Two implementations satisfy it behind one seam:
//   - makePostgresRepo(sql)   — native postgres.js (opt-in, self-hosters)
//     ([`./timeline-repo.ts`](./timeline-repo.ts))
//   - makeSupabaseRepo(db)    — supabase-js / PostgREST (the Netlify default)
//     ([`./timeline-repo-supabase.ts`](./timeline-repo-supabase.ts))
// The runtime glue picks one by env and hands it to `handleTimelineApi`.
//
// This module is deliberately driver-free (only `import type` from src/types +
// plain classes), so importing it never pulls postgres.js OR supabase-js into a
// bundle — the Deno edge bundle stays clean, the drivers arrive only through the
// callers that construct a concrete handle.

import type {
  CustomFieldDef,
  Pricing,
  PricingFeature,
  PricingHighlight,
  PricingTier,
  TimelineFile,
  TimelineFileItem,
  TimelinePhase,
  Watermark,
} from '../../src/types';

export type TimelineGroupDecl = {
  id: string;
  content: string;
  nestedGroups?: string[];
  showNested?: boolean;
};

export type TimelineMeta = { id: string; name?: string; description?: string; groupBy?: string };

export type PublicPricing = { id: string; name?: string; pricing: Pricing };

// Error classes are shared (not re-defined per driver) so `instanceof` in the
// dispatcher's catch block works regardless of which driver threw — two
// definitions would make a Supabase-thrown ConflictError miss the Postgres
// `instanceof` and surface as a 500 instead of a 409.
export class ConflictError extends Error {
  constructor(message = 'version conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}
export class NotFoundError extends Error {
  constructor(message = 'not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}
/** A write that violates a data invariant (e.g. overlapping phases). → HTTP 400. */
export class ValidationError extends Error {
  constructor(message = 'invalid request') {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Every storage operation with the DB client already bound. The two driver
 * factories return an object satisfying this; `handleTimelineApi` dispatches
 * through it and never sees the underlying client. Pure helpers (row mappers,
 * `reorderIds`, `stripRowVersions`, `enforceExtentExclusivity`,
 * `assemblePricing`) stay as standalone functions in the impl modules — they are
 * DB-shape utilities, not part of the request-serving surface.
 */
export interface TimelineRepo {
  // reads
  listTimelines(): Promise<TimelineMeta[]>;
  getTimeline(id: string): Promise<TimelineFile | null>;
  getWatermark(id: string): Promise<Watermark>;
  getPublicPricing(id: string): Promise<PublicPricing | null>;

  // whole-timeline
  replaceTimeline(id: string, file: TimelineFile): Promise<void>;

  // items
  addItem(timelineId: string, item: TimelineFileItem, updatedBy?: string): Promise<TimelineFileItem>;
  updateItem(
    timelineId: string,
    itemId: string,
    patch: Partial<TimelineFileItem>,
    expectedVersion?: number,
    updatedBy?: string,
  ): Promise<TimelineFileItem>;
  getItem(timelineId: string, itemId: string): Promise<TimelineFileItem | null>;
  deleteItem(timelineId: string, itemId: string): Promise<void>;

  // groups
  upsertGroup(timelineId: string, group: TimelineGroupDecl): Promise<TimelineGroupDecl>;
  deleteGroup(timelineId: string, groupId: string): Promise<void>;

  // timeline-level meta / phases
  updatePhases(id: string, phases: TimelinePhase[]): Promise<void>;
  updateMeta(
    id: string,
    meta: {
      name?: string;
      description?: string;
      groupBy?: string;
      customFields?: CustomFieldDef[];
    },
  ): Promise<void>;

  // pricing — features
  addFeature(timelineId: string, feature: PricingFeature, updatedBy?: string): Promise<PricingFeature>;
  updateFeature(
    timelineId: string,
    featureId: string,
    patch: Partial<PricingFeature>,
    expectedVersion?: number,
    updatedBy?: string,
  ): Promise<PricingFeature>;
  deleteFeature(timelineId: string, featureId: string): Promise<void>;
  moveFeature(
    timelineId: string,
    featureId: string,
    anchor: { after?: string; before?: string },
    updatedBy?: string,
  ): Promise<string[]>;

  // pricing — tiers + matrix cells
  addTier(timelineId: string, tier: PricingTier, updatedBy?: string): Promise<PricingTier>;
  updateTier(
    timelineId: string,
    tierId: string,
    patch: Partial<PricingTier>,
    expectedVersion?: number,
    updatedBy?: string,
  ): Promise<PricingTier>;
  deleteTier(timelineId: string, tierId: string): Promise<void>;
  setTierValue(
    timelineId: string,
    tierId: string,
    featureId: string,
    value: string | boolean | null | undefined,
    updatedBy?: string,
    availableFrom?: string | null,
  ): Promise<void>;
  clearTierValue(timelineId: string, tierId: string, featureId: string): Promise<void>;

  // pricing — highlights + versions + bulk
  addHighlight(timelineId: string, highlight: PricingHighlight, updatedBy?: string): Promise<PricingHighlight>;
  updateHighlight(
    timelineId: string,
    highlightId: string,
    patch: Partial<PricingHighlight>,
    expectedVersion?: number,
    updatedBy?: string,
  ): Promise<PricingHighlight>;
  deleteHighlight(timelineId: string, highlightId: string): Promise<void>;
  updateVersions(id: string, versions: string[]): Promise<void>;
  replacePricing(id: string, pricing: Pricing): Promise<void>;
}
