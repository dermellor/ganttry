// Remote Timelines MCP server — Streamable HTTP (Web Standard) on a Netlify
// Function (Node runtime; the MCP SDK uses node: builtins). Exposes the timeline
// tools over HTTP so colleagues add it as a remote MCP by URL — no local server.
//
// Stage 1 auth: Bearer MCP_API_TOKEN (proves the transport). OAuth (per-user
// Google login) is layered on in a later stage — see mcp-oauth.
//
// Tools reuse the shared dispatcher (scripts/db/api.ts) against Supabase.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import type { Config } from '@netlify/functions';
import { getServiceClient } from '../../scripts/db/client.ts';
import { handleTimelineApi, type ApiRequest } from '../../scripts/db/api.ts';

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
  const db = getServiceClient();

  const run = async (req: Omit<ApiRequest, 'updatedBy'>) => {
    if (!db) throw new Error('Supabase not configured on the server.');
    const result = await handleTimelineApi(db, { ...req, updatedBy });
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
