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

import type { MemberRole, MemberStatus } from '../../src/access';
import type {
  CustomFieldDef,
  DirectoryUser,
  Member,
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

/**
 * What creating or re-sending an invitation needs.
 *
 * The token arrives already hashed, and that split is deliberate: hashing in the
 * repo would mean two implementations of it, one per driver, and the plain token
 * only exists in the request that generates it. `null` for both token fields is
 * how an admin adds somebody without a link to hand over.
 */
export type MemberInvite = {
  email: string;
  role: MemberRole;
  /** Address of the inviting admin, stored for the audit trail. */
  invitedBy?: string | null;
  /** SHA-256 of the invitation token; never the token itself. */
  tokenHash?: string | null;
  /** ISO timestamp after which the invitation is refused at sign-in. */
  expiresAt?: string | null;
};

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
/**
 * A request this repo understands but does not implement. → HTTP 501.
 *
 * Distinct from ValidationError (the caller is wrong) and from a 500 (we are
 * broken): the caller and the request are both fine, this backing store just
 * cannot do it. The local file repo answers this for the pricing sub-resources.
 * Returning a silent success instead would let the interface report
 * „Gespeichert" for a write that never happened, which is the failure mode the
 * extent-error handling in „Standalone JSON timelines" (docs/data-model.md)
 * exists to prevent.
 */
export class NotSupportedError extends Error {
  constructor(message = 'not supported by this source') {
    super(message);
    this.name = 'NotSupportedError';
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

  // user directory (`app_users`) — not timeline-scoped, like listTimelines()
  /** The whole directory, ordered for a picker (named users first, then by name). */
  listUsers(): Promise<DirectoryUser[]>;
  /**
   * Register a caller in the directory: insert them, refresh `last_seen_at`, and
   * fill in a `name` once one is known. Never clears a stored name with an empty
   * one — an identity source that only knows the address must not erase what a
   * previous visit already learned.
   */
  touchUser(email: string, name?: string | null): Promise<void>;

  // membership (`app_users`, migration 0016) — the same rows the directory
  // serves, read through the columns that say what a person may do. Nothing
  // enforces these yet; the dispatcher starts consulting them behind
  // TIMELINES_ACCESS_CONTROL in a later step.
  /**
   * One membership by address, or null when the address is not a member.
   *
   * Null is the ordinary answer for a stranger rather than an error, which is
   * what lets the enforcement path treat "no row" and "wrong role" the same way.
   */
  getMember(email: string): Promise<Member | null>;
  /** Every membership, `removed` ones included, ordered like the directory. */
  listMembers(): Promise<Member[]>;
  /**
   * Create or re-invite a membership.
   *
   * Re-inviting an address that already has a row updates it in place instead of
   * failing: an admin who invites somebody twice means "send it again", and an
   * error there would leave them unable to fix a bounced invitation. An `active`
   * membership is never downgraded to `invited` by this — accepting is one-way.
   */
  inviteMember(input: MemberInvite): Promise<Member>;
  /** Change what an existing member may do. Throws NotFoundError for a stranger. */
  updateMemberRole(email: string, role: MemberRole): Promise<Member>;
  /** Move a membership through its lifecycle. Throws NotFoundError for a stranger. */
  setMemberStatus(email: string, status: MemberStatus): Promise<Member>;

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
