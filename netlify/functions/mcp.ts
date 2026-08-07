// Remote Ganttry MCP server — Streamable HTTP (Web Standard) on a Netlify
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
    'Patch an item (only provided fields; metadata is merged).',
    { id: z.string(), itemId: z.string(), patch: z.record(z.any()) },
    async ({ id, itemId, patch }) =>
      ok(await run({ method: 'PATCH', id, sub: { kind: 'item', childId: itemId }, body: patch })),
  );
  server.tool('delete_item', 'Delete an item by id.', { id: z.string(), itemId: z.string() }, async ({ id, itemId }) =>
    ok(await run({ method: 'DELETE', id, sub: { kind: 'item', childId: itemId } })),
  );
  server.tool('add_group', 'Add or update a group.', { id: z.string(), group: z.record(z.any()) }, async ({ id, group }) =>
    ok(await run({ method: 'POST', id, sub: { kind: 'group' }, body: group })),
  );
  server.tool(
    'update_group',
    'Update a group (upsert by id).',
    { id: z.string(), group: z.record(z.any()) },
    async ({ id, group }) => ok(await run({ method: 'PATCH', id, sub: { kind: 'group' }, body: group })),
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
    'BULK: replace a timeline\'s whole pricing model (features + tiers + highlights + versions) in one ' +
      "call, and optionally set its type. Prefer the granular tools below (add_/update_/delete_feature, " +
      '…_tier, set_tier_value, …_highlight, set_versions) for single edits — they touch one row and ' +
      "don't clobber concurrent edits. Use this only to seed a new model or do a full rewrite. Set " +
      "type to 'product' to surface the matrix.",
    { id: z.string(), pricing: z.record(z.any()), type: z.string().optional() },
    async ({ id, pricing, type }) => {
      if (type !== undefined) await run({ method: 'PATCH', id, body: { type } });
      return ok(await run({ method: 'PUT', id, sub: { kind: 'pricing' }, body: { pricing } }));
    },
  );

  // ---- granular pricing tools (one row per call; no whole-model dump) ------
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
  server.tool(
    'set_versions',
    'Replace the ordered list of pricing version labels (e.g. ["1.0","2.0","3.0"]). Drives the matrix ' +
      "version switcher and features' available-from ordering.",
    { id: z.string(), versions: z.array(z.string()) },
    async ({ id, versions }) => ok(await run({ method: 'PUT', id, sub: { kind: 'pversion' }, body: { versions } })),
  );
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
