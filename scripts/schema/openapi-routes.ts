// The route table behind openapi.yaml: paths, methods, status codes and headers.
//
// Hand-declared, because the dispatcher in scripts/db/api.ts is an if-chain with
// no per-route types to generate from. Every entry here mirrors what that file
// actually does — including which methods answer 405 and where a 400 comes from —
// so read it alongside handleTimelineApi when changing either.
//
// Payload schemas are NOT declared here; they are generated from src/types.ts and
// referenced as `#/components/schemas/<Type>`. Coverage of the sub-resources is
// enforced by openapi.test.ts against SUB_KINDS.

export type Ref = { $ref: string };
export type Schema = Ref | Record<string, unknown>;

export type Operation = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  summary: string;
  description?: string;
  /** Adds the If-Match header parameter and documents the 409. */
  optimisticLock?: boolean;
  requestBody?: Schema;
  responses: Record<string, { description: string; schema?: Schema }>;
};

export type RouteDef = {
  path: string;
  pathParams?: { name: string; description: string }[];
  /** Bypasses the auth gate on purpose; emits `security: []` for its operations. */
  public?: boolean;
  operations: Operation[];
};

const ref = (name: string): Ref => ({ $ref: `#/components/schemas/${name}` });
const ERROR = ref('Error');
const OK = ref('Ok');

/** Errors every handler can produce, so they are not restated per operation. */
const commonErrors = (extra?: Record<string, { description: string; schema?: Schema }>) => ({
  '400': { description: 'invalid_request — a required field is missing or a rule was violated (reversed item extent, overlapping phases).', schema: ERROR },
  '401': { description: 'session_expired — the auth gate rejected the request. The client sends the top window to the login.', schema: ERROR },
  '404': { description: 'not found — unknown timeline, unknown child id, or an unknown sub-resource.', schema: ERROR },
  '405': { description: 'method not allowed for this sub-resource.', schema: ERROR },
  '500': { description: 'server_error — includes the case where no database is configured, which fails loudly rather than serving stale content.', schema: ERROR },
  ...extra,
});

const CONFLICT = {
  '409': { description: 'version_conflict — the stored row version differs from If-Match. The client reloads that row instead of overwriting.', schema: ERROR },
};

const timelineId = [{ name: 'id', description: 'Timeline id. May contain slashes for a namespace, e.g. `acme/plan`; encode each segment.' }];

export const ROUTES: RouteDef[] = [
  {
    path: '/api/sources',
    operations: [
      {
        method: 'GET',
        summary: 'List the DB-backed timelines',
        description: 'The discovery endpoint. Lists from the default connection, which is why a default must be configured even when per-source connections are in use.',
        responses: {
          '200': { description: 'The timelines this deployment can serve.', schema: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } } } } },
          ...commonErrors(),
        },
      },
    ],
  },
  {
    path: '/api/source/{id}',
    pathParams: timelineId,
    operations: [
      {
        method: 'GET',
        summary: 'Read a timeline in full',
        description: 'Items, groups, phases, custom fields, enabled plugins and — for a product timeline — the assembled pricing model. The response carries `X-Source-Live` (`realtime`, `poll` or `none`), which tells the client how to watch for other people\'s changes.',
        responses: { '200': { description: 'The timeline.', schema: ref('TimelineFile') }, ...commonErrors() },
      },
      {
        method: 'PUT',
        summary: 'Replace a timeline wholesale',
        description: 'Bulk write, used for seeding and imports. Requires an object with an `items` array. Prefer the per-item endpoints for edits: this one replaces everything and therefore loses concurrent changes.',
        requestBody: ref('TimelineFile'),
        responses: { '200': { description: 'The stored timeline.', schema: ref('TimelineFile') }, ...commonErrors() },
      },
      {
        method: 'PATCH',
        summary: 'Update timeline metadata',
        description: 'Name, description, groupBy, phases, customFields, plugins. Touches only the keys present in the body.',
        requestBody: ref('TimelineFile'),
        responses: { '200': { description: 'The updated timeline.', schema: ref('TimelineFile') }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/source/{id}/item',
    pathParams: timelineId,
    operations: [
      {
        method: 'POST',
        summary: 'Append an item',
        description: '`content` is required; `start` is optional, and a date-less item shows only in the list view. `id` is optional too — omit it and the server assigns the next free `i<n>` for this timeline, the same scheme the viewer uses. `end` and `duration` are mutually exclusive, and `end` must lie after `start`.',
        requestBody: ref('TimelineFileItem'),
        responses: { '201': { description: 'The created item, including its server-assigned version.', schema: ref('TimelineFileItem') }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/source/{id}/item/{itemId}',
    pathParams: [...timelineId, { name: 'itemId', description: 'Item id within the timeline.' }],
    operations: [
      {
        method: 'PATCH',
        summary: 'Update one item',
        description: 'Touches a column **only when its key is present in the body**. Clearing an optional field therefore requires an explicit `null`; omitting it leaves the stored value in place, which reappears on the next load.',
        optimisticLock: true,
        requestBody: ref('TimelineFileItem'),
        responses: { '200': { description: 'The updated item.', schema: ref('TimelineFileItem') }, ...commonErrors(CONFLICT) },
      },
      {
        method: 'DELETE',
        summary: 'Delete one item',
        responses: { '200': { description: 'Deleted.', schema: OK }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/source/{id}/group',
    pathParams: timelineId,
    operations: [
      {
        method: 'POST',
        summary: 'Add or update a group',
        description: 'The group `id` travels in the body. PATCH and PUT are accepted here as well and behave identically.',
        requestBody: { type: 'object', required: ['id', 'content'], properties: { id: { type: 'string' }, content: { type: 'string' }, nestedGroups: { type: 'array', items: { type: 'string' } }, showNested: { type: 'boolean' }, sort: { type: 'number' } } },
        responses: { '200': { description: 'The stored group.', schema: { type: 'object' } }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/source/{id}/group/{groupId}',
    pathParams: [...timelineId, { name: 'groupId', description: 'Group id within the timeline.' }],
    operations: [
      { method: 'DELETE', summary: 'Delete a group', responses: { '200': { description: 'Deleted.', schema: OK }, ...commonErrors() } },
    ],
  },
  {
    path: '/api/source/{id}/phases',
    pathParams: timelineId,
    operations: [
      {
        method: 'PUT',
        summary: 'Replace the phase ribbon',
        description: 'Phases must not overlap in time; touching boundaries and gaps are fine. An overlapping write is rejected with 400 from any client.',
        requestBody: { type: 'array', items: ref('TimelinePhase') },
        responses: { '200': { description: 'Stored.', schema: OK }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/source/{id}/watermark',
    pathParams: timelineId,
    operations: [
      {
        method: 'GET',
        summary: 'Cheap change marker for polling',
        description: 'Max item version, item count and max updated_at across items plus the timeline row. A client in `poll` mode compares it and does a full reload when it moves. Does not cover the pricing tables.',
        responses: { '200': { description: 'The current watermark.', schema: ref('Watermark') }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/source/{id}/pricing',
    pathParams: timelineId,
    operations: [
      {
        method: 'PUT',
        summary: 'Replace the pricing model wholesale',
        description: 'Bulk seed. Enables the product-roadmap plugin automatically. For edits prefer the granular feature/tier/tier-value/highlight endpoints, which do not clobber concurrent changes.',
        requestBody: ref('Pricing'),
        responses: { '200': { description: 'Stored.', schema: OK }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/source/{id}/feature',
    pathParams: timelineId,
    operations: [
      {
        method: 'POST',
        summary: 'Add a pricing feature',
        description: 'Appends to the end of its group. Use feature-move to position it.',
        requestBody: ref('PricingFeature'),
        responses: { '201': { description: 'The created feature.', schema: ref('PricingFeature') }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/source/{id}/feature/{featureId}',
    pathParams: [...timelineId, { name: 'featureId', description: 'Feature id.' }],
    operations: [
      {
        method: 'PATCH',
        summary: 'Update a pricing feature',
        description: "The lock version comes **only** from If-Match here, never from `body.version`: on a feature, `version` is the domain field 'available from'.",
        optimisticLock: true,
        requestBody: ref('PricingFeature'),
        responses: { '200': { description: 'The updated feature.', schema: ref('PricingFeature') }, ...commonErrors(CONFLICT) },
      },
      { method: 'DELETE', summary: 'Delete a pricing feature', responses: { '200': { description: 'Deleted.', schema: OK }, ...commonErrors() } },
    ],
  },
  {
    path: '/api/source/{id}/feature-move',
    pathParams: timelineId,
    operations: [
      {
        method: 'POST',
        summary: 'Reorder a feature',
        description: 'Exactly one anchor; `after` wins if both are given. The server renumbers `sort` and returns the resulting order, which the client adopts rather than replaying the move locally. PUT behaves identically.',
        requestBody: { type: 'object', required: ['featureId'], properties: { featureId: { type: 'string' }, after: { type: 'string' }, before: { type: 'string' } } },
        responses: { '200': { description: 'The new order.', schema: { type: 'object' } }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/source/{id}/tier',
    pathParams: timelineId,
    operations: [
      { method: 'POST', summary: 'Add a tier', requestBody: ref('PricingTier'), responses: { '201': { description: 'The created tier.', schema: ref('PricingTier') }, ...commonErrors() } },
    ],
  },
  {
    path: '/api/source/{id}/tier/{tierId}',
    pathParams: [...timelineId, { name: 'tierId', description: 'Tier id.' }],
    operations: [
      {
        method: 'PATCH',
        summary: 'Update a tier',
        description: 'Touches no matrix cells: the response re-reads and returns them in full, so the column values survive.',
        optimisticLock: true,
        requestBody: ref('PricingTier'),
        responses: { '200': { description: 'The updated tier, cells included.', schema: ref('PricingTier') }, ...commonErrors(CONFLICT) },
      },
      { method: 'DELETE', summary: 'Delete a tier', responses: { '200': { description: 'Deleted.', schema: OK }, ...commonErrors() } },
    ],
  },
  {
    path: '/api/source/{id}/tier-value',
    pathParams: timelineId,
    operations: [
      {
        method: 'PUT',
        summary: 'Set one matrix cell',
        description: 'A cell is atomic, so there is no locking here and two people can edit different cells freely. A falsy `value` deletes the cell. `availableFrom` gates when the cell counts as included; `value` stays the end state. POST behaves identically.',
        requestBody: { type: 'object', required: ['tierId', 'featureId'], properties: { tierId: { type: 'string' }, featureId: { type: 'string' }, value: { oneOf: [{ type: 'boolean' }, { type: 'string' }, { type: 'null' }] }, availableFrom: { type: 'string', description: 'Version label from which the cell applies.' } } },
        responses: { '200': { description: 'Stored.', schema: OK }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/source/{id}/highlight',
    pathParams: timelineId,
    operations: [
      { method: 'POST', summary: 'Add a card highlight', requestBody: ref('PricingHighlight'), responses: { '201': { description: 'The created highlight.', schema: ref('PricingHighlight') }, ...commonErrors() } },
    ],
  },
  {
    path: '/api/source/{id}/highlight/{highlightId}',
    pathParams: [...timelineId, { name: 'highlightId', description: 'Highlight id.' }],
    operations: [
      { method: 'PATCH', summary: 'Update a card highlight', optimisticLock: true, requestBody: ref('PricingHighlight'), responses: { '200': { description: 'The updated highlight.', schema: ref('PricingHighlight') }, ...commonErrors(CONFLICT) } },
      { method: 'DELETE', summary: 'Delete a card highlight', responses: { '200': { description: 'Deleted.', schema: OK }, ...commonErrors() } },
    ],
  },
  {
    path: '/api/source/{id}/pversion',
    pathParams: timelineId,
    operations: [
      {
        method: 'PUT',
        summary: 'Replace the ordered version list',
        description: 'Writes only the plugin config and migrates **no** references. Renaming a version therefore orphans every gate that named it, which is why there is no version editor in the UI.',
        requestBody: { type: 'array', items: { type: 'string' } },
        responses: { '200': { description: 'Stored.', schema: OK }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/users',
    operations: [
      {
        method: 'GET',
        summary: 'List the assignable users',
        description: 'The directory an item owner links to, ordered for a picker. Serving this also registers the caller, which is how the directory fills itself.',
        responses: { '200': { description: 'The directory.', schema: { type: 'object', required: ['users'], properties: { users: { type: 'array', items: ref('DirectoryUser') } } } }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/me',
    operations: [
      {
        method: 'GET',
        summary: 'Who the caller is',
        description: 'Reads the session behind the auth gate; the cookie is HttpOnly, so the client cannot determine this itself. Without a gate it answers a placeholder identity.',
        responses: { '200': { description: 'The current identity.', schema: { type: 'object', properties: { email: { type: 'string' }, name: { type: 'string' } } } }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/pricing/{id}',
    pathParams: timelineId,
    public: true,
    operations: [
      {
        method: 'GET',
        summary: 'Public pricing model',
        description: '**Deliberately unauthenticated**, for external pages. Serves only the pricing model, never roadmap items, and strips the internal `rowVersion` from every entity.',
        responses: { '200': { description: 'The pricing model, without lock versions.', schema: ref('Pricing') }, '404': { description: 'Unknown timeline, or not a product timeline.', schema: ERROR }, '500': { description: 'server_error.', schema: ERROR } },
      },
    ],
  },
];
