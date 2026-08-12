// Remote Zeitlines MCP server — Streamable HTTP (Web Standard) on a Netlify
// Function (Node runtime; the MCP SDK uses node: builtins). Exposes the timeline
// tools over HTTP so colleagues add it as a remote MCP by URL — no local server.
//
// Stage 1 auth: Bearer MCP_API_TOKEN (proves the transport). OAuth (per-user
// Google login) is layered on in a later stage — see mcp-oauth.
//
// Tools reuse the shared dispatcher (scripts/db/api.ts) against Postgres.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import type { Config } from '@netlify/functions';
import { getSql } from '../../scripts/db/sql.ts';
import { getServiceClient } from '../../scripts/db/client.ts';
import { resolveAdapter, resolveRepo, type DbConnections, type ApiRequest } from '../../scripts/db/api.ts';
import { MOVE_SEGMENT, handlePluginsApi, type PluginsApiRequest } from '../../scripts/db/plugin-api.ts';
import { resolveGroupPatch, resolveItemPatch, type ItemPatch } from '../../scripts/mcp/patch.ts';
import type { TimelineGroupDecl } from '../../scripts/db/timeline-repo.ts';
import type { TimelineFileItem } from '../../src/types.ts';

const ACCESS_TTL = 12 * 3600; // must match mcp-oauth.ts

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Verify an HMAC-signed token minted by mcp-oauth.ts (same AUTH_SECRET, same
// b64url(payload).b64url(sig) format). Returns the payload or null.
function verifySigned(token: string): Record<string, unknown> | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  let payload: Buffer;
  let sig: Buffer;
  try {
    payload = Buffer.from(token.slice(0, dot), 'base64url');
    sig = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
}

// Resolve the caller: a valid per-user OAuth access token → their email; the
// shared MCP_API_TOKEN → "mcp" (break-glass). Null if neither.
function authenticate(req: Request): string | null {
  const presented = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!presented) return null;
  const shared = process.env.MCP_API_TOKEN;
  if (shared && constantTimeEqual(presented, shared)) return 'mcp';
  const claims = verifySigned(presented);
  if (claims && claims.typ === 'access' && typeof claims.email === 'string') {
    if (typeof claims.iat === 'number' && Date.now() / 1000 - claims.iat > ACCESS_TTL) return null;
    return claims.email;
  }
  return null;
}

// Build a fresh server per request (stateless mode) so the function stays
// side-effect free across invocations.
function buildServer(updatedBy: string): McpServer {
  const server = new McpServer({ name: 'timelines', version: '1.0.0' });
  // Dual-adapter: postgres.js when TIMELINES_DATABASE_URL is set, else supabase-js.
  const conns: DbConnections = { sql: getSql(), supabase: getServiceClient() };

  const run = async (req: Omit<ApiRequest, 'updatedBy'>) => {
    if (!resolveRepo(conns)) {
      throw new Error(
        'Database not configured on the server (TIMELINES_DATABASE_URL, or TIMELINES_SUPABASE_URL + TIMELINES_SUPABASE_SERVICE_KEY).',
      );
    }
    const fullReq = { ...req, updatedBy } as ApiRequest;
    const result = await resolveAdapter(conns, fullReq.id).handle(fullReq);
    if (result.status >= 400) {
      const msg = (result.json as { error?: string; message?: string });
      throw new Error(msg.message || msg.error || `error ${result.status}`);
    }
    return result.json;
  };
  // The instance registry is not timeline-scoped, so it does not go through
  // `resolveAdapter` (which resolves a source). Presenting the MCP token already
  // proves operator access — it is a server-side secret — so `caller.mcp` is true
  // here; see scripts/db/operator.ts for why that equivalence is deliberate.
  const runPlugins = async (req: Omit<PluginsApiRequest, 'caller' | 'operators'>) => {
    const repo = resolveRepo(conns);
    if (!repo) throw new Error('Database not configured on the server.');
    const result = await handlePluginsApi(repo, { ...req, caller: { mcp: true }, operators: [] });
    if (result.status >= 400) {
      const msg = result.json as { error?: string; message?: string };
      throw new Error(msg.message || msg.error || `error ${result.status}`);
    }
    return result.json;
  };

  const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

  server.tool('list_timelines', 'List all DB-backed timelines (id, name, description).', {}, async () =>
    ok(await run({ method: 'GET', id: '' })),
  );
  server.tool('get_timeline', 'Get a full timeline (items + groups + phases) by id.', { id: z.string() }, async ({ id }) =>
    ok(await run({ method: 'GET', id })),
  );
  server.tool(
    'add_item',
    'Append an item to a timeline. Requires start and content.',
    { id: z.string(), item: z.record(z.any()) },
    async ({ id, item }) => ok(await run({ method: 'POST', id, sub: { kind: 'item' }, body: item })),
  );
  server.tool(
    'update_item',
    'Patch an item (only provided fields change; metadata is shallow-merged onto what the item ' +
      'already carries). Give a metadata key the value null to remove it, or metadata: null to clear ' +
      'the whole object.',
    { id: z.string(), itemId: z.string(), patch: z.record(z.any()) },
    async ({ id, itemId, patch }) => {
      // The endpoint replaces the metadata column, so the merge this tool
      // documents has to happen here, against the item's current value — see the
      // header of scripts/mcp/patch.ts for why it cannot move server-side. That
      // costs a read, and only on a patch that actually names metadata.
      let body = patch as Record<string, unknown>;
      if ('metadata' in patch) {
        const file = (await run({ method: 'GET', id })) as { items?: TimelineFileItem[] };
        const current = (file.items ?? []).find((i) => i.id === itemId);
        if (!current) throw new Error(`Item "${itemId}" not found in "${id}".`);
        body = resolveItemPatch(current, patch as ItemPatch) as Record<string, unknown>;
      }
      return ok(await run({ method: 'PATCH', id, sub: { kind: 'item', childId: itemId }, body }));
    },
  );
  server.tool('delete_item', 'Delete an item by id.', { id: z.string(), itemId: z.string() }, async ({ id, itemId }) =>
    ok(await run({ method: 'DELETE', id, sub: { kind: 'item', childId: itemId } })),
  );
  server.tool('add_group', 'Add or update a group.', { id: z.string(), group: z.record(z.any()) }, async ({ id, group }) =>
    ok(await run({ method: 'POST', id, sub: { kind: 'group' }, body: group })),
  );
  server.tool(
    'update_group',
    'Patch a group by id (only provided fields change; fields left out keep their value).',
    { id: z.string(), group: z.record(z.any()) },
    async ({ id, group }) => {
      // Groups are written through an upsert, which rewrites content,
      // nestedGroups and showNested from the body alone — so patching just
      // `content` used to drop a group's nesting. Fold the patch onto the current
      // group first so the upsert carries the untouched fields along.
      const groupId = (group as TimelineGroupDecl).id;
      if (!groupId) throw new Error('group needs id');
      const file = (await run({ method: 'GET', id })) as { groups?: TimelineGroupDecl[] };
      const current = (file.groups ?? []).find((g) => g.id === groupId);
      if (!current) throw new Error(`Group "${groupId}" not found in "${id}".`);
      const body = resolveGroupPatch(current, group as Partial<TimelineGroupDecl>);
      return ok(await run({ method: 'PATCH', id, sub: { kind: 'group' }, body }));
    },
  );
  server.tool('delete_group', 'Delete a group by id.', { id: z.string(), groupId: z.string() }, async ({ id, groupId }) =>
    ok(await run({ method: 'DELETE', id, sub: { kind: 'group', childId: groupId } })),
  );
  server.tool(
    'replace_timeline',
    'Replace a whole timeline (bulk). Body is the full { items, groups, phases } object.',
    { id: z.string(), file: z.record(z.any()) },
    async ({ id, file }) => ok(await run({ method: 'PUT', id, body: file })),
  );
  server.tool(
    'set_pricing',
    'BULK: replace a timeline\'s whole pricing model (features + tiers + highlights) in one ' +
      "call, and optionally set its type. Prefer the granular tools below (add_/update_/delete_feature, " +
      '…_tier, set_tier_value, …_highlight) for single edits — they touch one row and ' +
      "don't clobber concurrent edits. The version list is plugin config: set it with enable_plugin " +
      "({ versions, versionLabels }). Use this only to seed a new model or do a full rewrite. Set " +
      "type to 'product' to surface the matrix.",
    { id: z.string(), pricing: z.record(z.any()), type: z.string().optional() },
    async ({ id, pricing, type }) => {
      if (type !== undefined) await run({ method: 'PATCH', id, body: { type } });
      return ok(await run({ method: 'PUT', id, sub: { kind: 'pricing' }, body: { pricing } }));
    },
  );

  // ---- plugin lifecycle ----------------------------------------------------
  //
  // Two levels, and the tools keep them apart because conflating them is how a
  // plugin gets uninstalled when somebody meant to switch it off on one timeline.
  // `enable_plugin` / `disable_plugin` are per timeline and reversible;
  // `install_plugin` / `uninstall_plugin` are instance-wide and operator-only —
  // the MCP token is operator access, which is why they are reachable here at all.

  server.tool(
    'list_plugins',
    'List the plugins this instance has installed, with the host\'s verdict on each: whether it can be ' +
      'loaded, and if not, why (switched off, or a contract version this host does not satisfy).',
    {},
    async () => ok(await runPlugins({ method: 'GET' })),
  );
  server.tool(
    'enable_plugin',
    'Enable one plugin on ONE timeline, or replace its config. The plugin must already be installed on ' +
      'the instance. Config is validated against the plugin\'s declared configSchema, so a bad key fails ' +
      'here rather than inside a render. This does not touch other timelines.',
    { id: z.string(), pluginId: z.string(), config: z.record(z.any()).optional() },
    async ({ id, pluginId, config }) =>
      ok(await run({ method: 'PUT', id, sub: { kind: 'plugin', plugin: { pluginId } }, body: { config: config ?? {} } })),
  );
  server.tool(
    'disable_plugin',
    'Disable one plugin on ONE timeline. Everything it stored is KEPT, so enabling it again is lossless. ' +
      'To remove a plugin from the whole instance use uninstall_plugin.',
    { id: z.string(), pluginId: z.string() },
    async ({ id, pluginId }) =>
      ok(await run({ method: 'DELETE', id, sub: { kind: 'plugin', plugin: { pluginId } } })),
  );
  server.tool(
    'install_plugin',
    'Install a plugin on the INSTANCE, making it available to enable on timelines. Takes the plugin\'s ' +
      'manifest, which is validated against this host\'s contract version before anything is stored. ' +
      'artifact describes where the code comes from ({ kind: "builtin" | "url" | "package" | "vendored", ' +
      'source?, integrity? }); a url artifact must carry an integrity hash. capabilities is what you GRANT ' +
      'it — omit to grant exactly what the manifest declares.',
    {
      manifest: z.record(z.any()),
      artifact: z.record(z.any()).optional(),
      capabilities: z.array(z.string()).optional(),
    },
    async ({ manifest, artifact, capabilities }) =>
      ok(await runPlugins({ method: 'POST', body: { manifest, artifact, capabilities } })),
  );
  server.tool(
    'set_plugin_installed',
    'Switch a plugin on or off for the WHOLE instance without uninstalling it. Off means its code stops ' +
      'loading everywhere and its data becomes read-only; nothing is discarded.',
    { pluginId: z.string(), enabled: z.boolean() },
    async ({ pluginId, enabled }) => ok(await runPlugins({ method: 'PATCH', pluginId, body: { enabled } })),
  );
  server.tool(
    'uninstall_plugin',
    'Remove a plugin from the instance. Destructive and guarded: repeat the plugin id as `confirm`. ' +
      'purgeData defaults to false, which KEEPS every row the plugin owned so a reinstall finds them; ' +
      'passing true also deletes those rows and strips the item metadata keys the plugin declared, and ' +
      'that cannot be undone.',
    { pluginId: z.string(), confirm: z.string(), purgeData: z.boolean().optional() },
    async ({ pluginId, confirm, purgeData }) =>
      ok(
        await runPlugins({
          method: 'DELETE',
          pluginId,
          params: { confirm, purgeData: purgeData ? 'true' : 'false' },
        }),
      ),
  );

  // ---- plugin-owned rows: two tools for every plugin ----------------------
  //
  // Two generic tools, not two per plugin. The thirteen pricing tools below are
  // what one plugin costs when the surface is per plugin, and a plugin installed
  // at runtime could not add tools to a compiled server at all. What a caller may
  // write is not decided here: the dispatcher checks it against the plugin's
  // manifest, so an unknown plugin, an undeclared collection or a row that fails
  // its schema is refused the same way it is over HTTP.

  server.tool(
    'plugin_data_list',
    'List the rows a plugin stores on a timeline, in the collection\'s own order. ' +
      'Collections are declared in the plugin\'s manifest (product-roadmap: features, tiers, ' +
      'tier-values, highlights). Each row is { id, data, version } — send `version` back as ' +
      'expectedVersion when writing.',
    { id: z.string(), pluginId: z.string(), collection: z.string() },
    async ({ id, pluginId, collection }) =>
      ok(await run({ method: 'GET', id, sub: { kind: 'plugin', plugin: { pluginId, collection } } })),
  );
  server.tool(
    'plugin_data_write',
    'Write one row of a plugin collection. op="put" creates or replaces `data` wholesale; ' +
      'op="patch" merges into it (a null value removes that key); op="delete" removes the row ' +
      'and cascades to rows referencing it; op="move" repositions it in an ordered collection ' +
      '(pass after or before instead of data). rowId is required for patch, delete and move; ' +
      'for put it is derived from the key fields when the collection has them. Pass ' +
      'expectedVersion to make the write conditional — it fails rather than overwriting a ' +
      'change you did not see.',
    {
      id: z.string(),
      pluginId: z.string(),
      collection: z.string(),
      op: z.enum(['put', 'patch', 'delete', 'move']),
      rowId: z.string().optional(),
      data: z.record(z.any()).optional(),
      after: z.string().optional(),
      before: z.string().optional(),
      expectedVersion: z.number().optional(),
    },
    async ({ id, pluginId, collection, op, rowId, data, after, before, expectedVersion }) => {
      const plugin = { pluginId, collection, rowId };
      if (op === 'move') {
        if (!rowId) throw new Error('move needs rowId');
        return ok(
          await run({
            method: 'POST',
            id,
            sub: { kind: 'plugin', plugin: { pluginId, collection, rowId: MOVE_SEGMENT } },
            body: { id: rowId, after, before },
          }),
        );
      }
      if (op === 'delete') {
        if (!rowId) throw new Error('delete needs rowId');
        return ok(await run({ method: 'DELETE', id, sub: { kind: 'plugin', plugin } }));
      }
      if (!data) throw new Error(`${op} needs data`);
      if (op === 'patch') {
        if (!rowId) throw new Error('patch needs rowId');
        return ok(
          await run({ method: 'PATCH', id, sub: { kind: 'plugin', plugin }, body: { data }, ifMatch: expectedVersion }),
        );
      }
      return ok(
        await run({
          method: 'POST',
          id,
          sub: { kind: 'plugin', plugin: { pluginId, collection } },
          body: { id: rowId, data },
          ifMatch: expectedVersion,
        }),
      );
    },
  );

  // ---- granular pricing tools (one row per call; no whole-model dump) ------
  //
  // Thirteen tools for one plugin, which is the cost the two generic ones above
  // exist to stop paying. They stay until #17 moves product-roadmap onto the
  // generic store; removing them before its data has moved would take the MCP
  // path away from a model that still lives in the `pricing_*` tables.
  server.tool(
    'add_feature',
    'Add a pricing feature. Body: { id, name, group?, description?, version? (the version label it is ' +
      'available from — omit for pre-existing), nameByVersion? }.',
    { id: z.string(), feature: z.record(z.any()) },
    async ({ id, feature }) => ok(await run({ method: 'POST', id, sub: { kind: 'feature' }, body: feature })),
  );
  server.tool(
    'update_feature',
    'Patch a pricing feature by id (only provided fields change). Fields: name, group, description, ' +
      'version (available-from label), nameByVersion. Send null to clear an optional field.',
    { id: z.string(), featureId: z.string(), patch: z.record(z.any()) },
    async ({ id, featureId, patch }) =>
      ok(await run({ method: 'PATCH', id, sub: { kind: 'feature', childId: featureId }, body: patch })),
  );
  server.tool(
    'delete_feature',
    'Delete a pricing feature by id. Its matrix cells cascade away and it is stripped from highlights.',
    { id: z.string(), featureId: z.string() },
    async ({ id, featureId }) => ok(await run({ method: 'DELETE', id, sub: { kind: 'feature', childId: featureId } })),
  );
  server.tool(
    'add_tier',
    'Add a pricing tier. Body: { id, name, price, tagline?, useCase?, targetGroup?, values? } where ' +
      'values maps featureId → true | "verbatim string".',
    { id: z.string(), tier: z.record(z.any()) },
    async ({ id, tier }) => ok(await run({ method: 'POST', id, sub: { kind: 'tier' }, body: tier })),
  );
  server.tool(
    'update_tier',
    'Patch a pricing tier by id. Fields: name, price, tagline, useCase, targetGroup. To change a single ' +
      'matrix cell use set_tier_value instead (values passed here are applied cell-by-cell too).',
    { id: z.string(), tierId: z.string(), patch: z.record(z.any()) },
    async ({ id, tierId, patch }) =>
      ok(await run({ method: 'PATCH', id, sub: { kind: 'tier', childId: tierId }, body: patch })),
  );
  server.tool(
    'delete_tier',
    'Delete a pricing tier by id (its matrix cells cascade away).',
    { id: z.string(), tierId: z.string() },
    async ({ id, tierId }) => ok(await run({ method: 'DELETE', id, sub: { kind: 'tier', childId: tierId } })),
  );
  server.tool(
    'set_tier_value',
    'Set ONE matrix cell (tier × feature). value = true (✓) or a verbatim string ("3.000"). ' +
      'value = false / null clears the cell (–). This is the collision-free way to edit the matrix.',
    { id: z.string(), tierId: z.string(), featureId: z.string(), value: z.union([z.string(), z.boolean(), z.null()]) },
    async ({ id, tierId, featureId, value }) =>
      ok(await run({ method: 'PUT', id, sub: { kind: 'tier-value' }, body: { tierId, featureId, value } })),
  );
  server.tool(
    'add_highlight',
    'Add a card highlight. Body: { id, label, section?, icon?, featureIds: [], description?, labelByVersion? }.',
    { id: z.string(), highlight: z.record(z.any()) },
    async ({ id, highlight }) => ok(await run({ method: 'POST', id, sub: { kind: 'highlight' }, body: highlight })),
  );
  server.tool(
    'update_highlight',
    'Patch a card highlight by id. Fields: label, section, icon, featureIds, description, labelByVersion.',
    { id: z.string(), highlightId: z.string(), patch: z.record(z.any()) },
    async ({ id, highlightId, patch }) =>
      ok(await run({ method: 'PATCH', id, sub: { kind: 'highlight', childId: highlightId }, body: patch })),
  );
  server.tool(
    'delete_highlight',
    'Delete a card highlight by id.',
    { id: z.string(), highlightId: z.string() },
    async ({ id, highlightId }) => ok(await run({ method: 'DELETE', id, sub: { kind: 'highlight', childId: highlightId } })),
  );
  // No dedicated version tools live here: a plugin's version list is ordinary
  // plugin CONFIG, so it is set through the generic `enable_plugin` (PUT config),
  // the same route every plugin's config uses. A product-roadmap config carries
  // `versions` (stable ids) and `versionLabels` (id → display label); renaming a
  // version is a config write that changes only a label, leaving every id — and
  // so every reference to it — intact. Keeping this out of the MCP core is what
  // `check-plugin-isolation` enforces: a built-in plugin gets no tool a
  // third-party one could not. See the plugin's own README for the recipe.
  return server;
}

export default async function handler(req: Request): Promise<Response> {
  const identity = authenticate(req);
  if (!identity) {
    // Point the MCP client at our Protected Resource Metadata so it starts the
    // OAuth flow (per-user Google login).
    const origin = new URL(req.url).origin;
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  const server = buildServer(identity); // updated_by = user email (or "mcp")
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }); // stateless
  await server.connect(transport);
  return transport.handleRequest(req);
}

export const config: Config = { path: '/mcp' };
