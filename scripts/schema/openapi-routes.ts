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

/** The two names that address a plugin's storage, shared by its three paths. */
const pluginPath = [
  { name: 'pluginId', description: 'Plugin id, percent-encoded (a scoped id such as `@acme/sprints` therefore arrives as `%40acme%2Fsprints`).' },
  { name: 'collection', description: 'A collection id the plugin declares in its manifest.' },
];

/**
 * The plugin routes' own refusals, on top of the common ones. Both are 404/403
 * rather than 400 because the host fails closed: it will not invent a collection
 * for a plugin, and it will not store data for one that never asked to.
 */
const pluginErrors = () => ({
  ...commonErrors(),
  '403': { description: 'capability_missing — the plugin did not declare `data:own`.', schema: ERROR },
  '404': { description: 'unknown_plugin / unknown_collection — the instance has no such plugin installed, or its manifest declares no such collection.', schema: ERROR },
});

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
        description: '`content` is required; `start` is optional, and a date-less item shows only in the list view. `end` and `duration` are mutually exclusive, and `end` must lie after `start`.',
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
        description: 'Max item version, item count and max updated_at across items plus the timeline row, and the same pair (`pv`/`pn`) over the plugin-owned rows. A client in `poll` mode compares it and does a full reload when it moves. Does not cover the pricing tables, which move onto the generic store in issue #17.',
        responses: { '200': { description: 'The current watermark.', schema: ref('Watermark') }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/public/plugin/{pluginId}/{timelineId}',
    pathParams: [
      { name: 'pluginId', description: 'Plugin id, percent-encoded.' },
      { name: 'timelineId', description: 'Timeline id. May contain slashes; it is the whole remaining path.' },
    ],
    public: true,
    operations: [
      {
        method: 'GET',
        summary: "A plugin's published collections, without authentication",
        description: 'The generic replacement for a per-plugin public endpoint. Three gates must all pass: the instance has the plugin installed and switched on, the plugin was granted `public:read` and declares `publicRead` collections, and THIS timeline consented (`public` on its plugin entry, off by default). Every failure answers 404 — one status for all of them, because the endpoint is reachable by anyone and distinguishing „no such timeline" from „exists but is not published" would turn it into a probe for which timelines exist.\n\nNarrow with `?collection=<id>`; an undeclared collection answers 404. A query parameter rather than a path segment because a timeline id may contain slashes, which would make a trailing segment ambiguous.\n\nThe host always removes `version`, `updatedAt` and `updatedBy` from every row, whatever the plugin declared — `updatedBy` is an e-mail address. A `fields` projection in the manifest narrows further, as an allowlist.\n\nCacheable (`max-age=300`) and `Access-Control-Allow-Origin: *`, the same contract the pricing endpoint offers.',
        responses: {
          '200': { description: 'The published collections.', schema: { type: 'object', required: ['id', 'plugin', 'collections'], properties: { id: { type: 'string' }, name: { type: 'string' }, plugin: { type: 'string' }, config: { type: 'object' }, collections: { type: 'object', additionalProperties: { type: 'array', items: { type: 'object', required: ['id', 'data'], properties: { id: { type: 'string' }, data: { type: 'object' } } } } } } } },
          '404': { description: 'not found — unknown plugin, switched off, nothing declared public, or this timeline has not consented. Deliberately indistinguishable.', schema: ERROR },
          '405': { description: 'method not allowed — this endpoint is read-only.', schema: ERROR },
          '503': { description: 'db_not_configured.', schema: ERROR },
        },
      },
    ],
  },
  {
    path: '/api/plugins',
    operations: [
      {
        method: 'GET',
        summary: "The instance's installed plugins",
        description: 'Each with the host\'s verdict: `loadable`, and a `problem` sentence when it is not (switched off instance-wide, or a contract version this host does not satisfy). Readable by anyone past the auth gate — it is what the interface shows. On an instance with no registry the plugins the build shipped with are listed, because that is its truthful installed set.',
        responses: {
          '200': { description: 'The registry.', schema: { type: 'object', required: ['plugins'], properties: { plugins: { type: 'array', items: ref('PluginStatus') } } } },
          ...commonErrors(),
        },
      },
      {
        method: 'POST',
        summary: 'Install a plugin on the instance',
        description: 'Operator-only. Body is `{ manifest, artifact?, capabilities? }`. The manifest is validated against this host\'s contract version before anything is stored, so an incompatible artifact is refused here rather than at every boot. A non-builtin artifact must name a source, and a `url` one must carry an integrity hash — without it the pinned version names whatever that URL serves today. `capabilities` is what you GRANT; granting less than the manifest declares is refused rather than silently narrowed.',
        requestBody: { type: 'object', required: ['manifest'], properties: { manifest: { type: 'object' }, artifact: { type: 'object', properties: { kind: { type: 'string', enum: ['builtin', 'url', 'package', 'vendored'] }, source: { type: 'string' }, integrity: { type: 'string' } } }, capabilities: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' } } },
        responses: {
          '201': { description: 'The installed plugin with its status.', schema: ref('PluginStatus') },
          '403': { description: 'forbidden — the caller is not an operator of this instance.', schema: ERROR },
          ...commonErrors(),
        },
      },
    ],
  },
  {
    path: '/api/plugins/{pluginId}',
    pathParams: [{ name: 'pluginId', description: 'Plugin id, percent-encoded.' }],
    operations: [
      {
        method: 'PATCH',
        summary: 'Switch a plugin on or off for the whole instance',
        description: 'Operator-only. Body is `{ enabled }`. Off stops the code loading everywhere and makes the plugin\'s data read-only; nothing is discarded, so switching back on is lossless.',
        requestBody: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
        responses: {
          '200': { description: 'The new state.', schema: OK },
          '403': { description: 'forbidden — the caller is not an operator of this instance.', schema: ERROR },
          ...commonErrors(),
        },
      },
      {
        method: 'DELETE',
        summary: 'Uninstall a plugin from the instance',
        description: 'Operator-only and guarded: repeat the plugin id as `?confirm=<pluginId>`, because this is the one operation that can delete data nothing else recovers. `?purgeData=true` also deletes every row the plugin owned and strips the item metadata keys it declared; the default keeps them, so an uninstall meant as „stop running this" cannot silently discard a model.',
        responses: {
          '200': { description: 'Uninstalled, saying whether the data went with it.', schema: OK },
          ...commonErrors({
            '400': { description: 'confirmation_required — the `confirm` parameter did not repeat the plugin id.', schema: ERROR },
          }),
          '403': { description: 'forbidden — the caller is not an operator of this instance.', schema: ERROR },
        },
      },
    ],
  },
  {
    path: '/api/source/{id}/plugin/{pluginId}',
    pathParams: [...timelineId, { name: 'pluginId', description: 'Plugin id, percent-encoded (a scoped id such as `@acme/sprints` arrives as `%40acme%2Fsprints`).' }],
    operations: [
      {
        method: 'GET',
        summary: 'Is this plugin enabled on this timeline',
        description: 'Reports whether the instance has it installed, whether it is switched on instance-wide, whether this timeline enables it, and with what config.',
        responses: {
          '200': { description: 'The state on this timeline.', schema: { type: 'object', properties: { pluginId: { type: 'string' }, installed: { type: 'boolean' }, instanceEnabled: { type: 'boolean' }, enabled: { type: 'boolean' }, config: { type: 'object' } } } },
          ...commonErrors(),
        },
      },
      {
        method: 'PUT',
        summary: 'Enable a plugin on this timeline, or reconfigure it',
        description: 'The granular path that previously only existed as SQL or a bulk `replace_timeline` — and a bulk write is what loses a concurrent edit. Body is `{ config }` (a bare bag is accepted too). The config is validated against the plugin\'s declared `configSchema`, so a bad key fails here rather than inside a render. The plugin must be installed on the instance first.',
        requestBody: { type: 'object', properties: { config: { type: 'object' } } },
        responses: {
          '200': { description: 'Enabled, with the stored config.', schema: OK },
          '403': { description: 'plugin_disabled — the plugin is switched off for this instance.', schema: ERROR },
          ...commonErrors(),
        },
      },
      {
        method: 'DELETE',
        summary: 'Disable a plugin on this timeline',
        description: 'Keeps every row the plugin owns, so enabling it again is lossless — the destructive operation is the instance-level uninstall. Disabling something already off is not an error: both calls describe the same state.',
        responses: { '200': { description: 'Disabled.', schema: OK }, ...commonErrors() },
      },
    ],
  },
  {
    path: '/api/source/{id}/plugin/{pluginId}/{collection}',
    pathParams: [...timelineId, ...pluginPath],
    operations: [
      {
        method: 'GET',
        summary: "List a plugin collection's rows",
        description: 'In the collection\'s order. The same rows also travel inside `GET /api/source/{id}` under `pluginData`, so a client that already loaded the timeline does not need this call.',
        responses: {
          '200': { description: 'The rows.', schema: { type: 'object', required: ['rows'], properties: { rows: { type: 'array', items: ref('PluginDataRow') } } } },
          ...pluginErrors(),
        },
      },
      {
        method: 'POST',
        summary: 'Create or replace a row',
        description: 'Body is `{ data, id? }`. `data` is validated against the collection\'s declared JSON Schema and its references must resolve. `id` is ignored for a collection with `keyFields` — there the row id is derived from the key values, so writing the same coordinates twice updates one row. An existing row keeps its position.',
        optimisticLock: true,
        requestBody: { type: 'object', required: ['data'], properties: { id: { type: 'string' }, data: { type: 'object' } } },
        responses: { '201': { description: 'The stored row.', schema: ref('PluginDataRow') }, ...pluginErrors(), ...CONFLICT },
      },
    ],
  },
  {
    path: '/api/source/{id}/plugin/{pluginId}/{collection}/move',
    pathParams: [...timelineId, ...pluginPath],
    operations: [
      {
        method: 'POST',
        summary: 'Reposition a row',
        description: 'Body is `{ id, after? , before? }`. Only for a collection declared `ordered`; anything else answers 400. Renumbers server-side and returns the new order. This shadows no row: a row whose id is `move` is still addressed by PATCH and DELETE on this path.',
        requestBody: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, after: { type: 'string' }, before: { type: 'string' } } },
        responses: {
          '200': { description: 'The new order.', schema: { type: 'object', properties: { ok: { type: 'boolean' }, order: { type: 'array', items: { type: 'string' } } } } },
          ...pluginErrors(),
        },
      },
    ],
  },
  {
    path: '/api/source/{id}/plugin/{pluginId}/{collection}/{rowId}',
    pathParams: [...timelineId, ...pluginPath, { name: 'rowId', description: 'Row id, percent-encoded. For a collection with `keyFields` this is the derived composite key.' }],
    operations: [
      {
        method: 'PATCH',
        summary: "Merge into a row's data",
        description: 'Body is `{ data }`, shallow-merged into the stored object; a `null` value removes its key. The MERGED result is validated, not the patch. A field that forms the row\'s identity cannot be patched — that would silently make it a different row — and answers 400.',
        optimisticLock: true,
        requestBody: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } },
        responses: { '200': { description: 'The stored row.', schema: ref('PluginDataRow') }, ...pluginErrors(), ...CONFLICT },
      },
      {
        method: 'DELETE',
        summary: 'Delete a row and its cascade',
        description: 'Rows referencing this one through a declared reference go with it (`onDelete: cascade`, the default) and are listed in the response. A reference declared `restrict` blocks the delete with 409 instead, and nothing is removed.',
        responses: {
          '200': { description: 'Deleted, with what the cascade took.', schema: { type: 'object', properties: { ok: { type: 'boolean' }, cascaded: { type: 'array', items: { type: 'object', properties: { collection: { type: 'string' }, rowIds: { type: 'array', items: { type: 'string' } } } } } } } },
          '409': { description: 'reference_restrict — a reference declared `restrict` still points at this row.', schema: ERROR },
          ...pluginErrors(),
        },
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
