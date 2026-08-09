// The API's HTTP layer, shaped around Fetch so every runtime can share it.
//
// `scripts/db/api.ts` already holds one implementation of the storage and
// locking semantics. What sat around it was duplicated: route matching, body
// reading, `If-Match` parsing, the `X-Source-Live` response header and the
// error-to-status mapping existed once in the Vite middleware and once in the
// `timelines-api` edge function, and had already drifted apart in small ways.
// A third copy for a self-hosted Node server (see `scripts/serve.ts`) would have
// made that three, which is what this module prevents — „a rule lives in exactly
// one place" (AGENTS.md), applied to the dispatcher's frame rather than only to
// the dispatcher.
//
// Request/Response are the interchange type because all three runtimes speak
// them: the edge functions natively, Node since 18, and the Vite middleware
// through a small adapter over `IncomingMessage`. Nothing here touches
// `node:*` or the DOM, so the module stays safe for the Deno edge bundle.
//
// What is deliberately NOT here: `/api/me` and the config.json override
// (runtime-specific identity and a dev-server-only concern), and the JIRA proxy,
// which needs credentials rather than a database.

import {
  handleUsersApi,
  liveOverride,
  parsePublicPluginPath,
  parseSourcePath,
  resolveAdapter,
  resolveRepo,
  type ApiRequest,
  type DbConnections,
} from './api.ts';
import { handlePluginsApi, handlePublicPluginApi } from './plugin-api.ts';
import { makeManifestSource } from './plugin-manifests.ts';
import { retiredPricingResponse } from './retired-pricing-route.ts';
import type { SourceLive } from '../../src/types';
import { isPublicPath } from '../admission.ts';
import {
  accessControlEnabled,
  capabilityForMethod,
  memberCan,
  normalizeMemberRole,
  roleAllows,
  type Capability,
  type MemberRole,
} from '../../src/access.ts';

/** What the runtime resolved before dispatching: connections plus who is asking. */
export type ApiContext = {
  conns: DbConnections;
  /** Attribution for `updated_by`; the runtime's own notion of the caller. */
  updatedBy?: string;
  /** Identity for the user directory. Absent for unauthenticated runtimes. */
  caller?: { email: string; name?: string | null };
  /**
   * Does membership decide what this caller may do (`TIMELINES_ACCESS_CONTROL`)?
   *
   * Off by default, and that is deliberate rather than timid: every existing
   * instance, every dev server and every self-hosted deployment predates the
   * member list, so switching this on by shipping it would refuse everybody the
   * moment the code lands. The operator turns it on once the list is populated
   * — see the rollout order in docs.
   */
  accessControl?: boolean;
  /**
   * The role a NON-human caller acts with, skipping the member lookup.
   *
   * The MCP service token authenticates a program, not a person, so there is no
   * membership row to find and „no row" would lock every automation out the
   * moment the switch flips. The runtime that recognises the token supplies the
   * role instead. Per-user MCP access is a membership like any other and does
   * not come through here.
   */
  serviceRole?: MemberRole;
  /**
   * `PLUGIN_OPERATOR_EMAILS`, already read from the runtime's own env.
   *
   * Who may install or uninstall a plugin instance-wide is a property of the
   * deployment rather than of a timeline, so it cannot come from the member
   * list. Empty means nobody, which is the right default: a fresh instance has
   * no plugin operator until somebody is named.
   */
  operators?: string[];
  /**
   * Did the caller present the service token rather than a session?
   *
   * It counts as operator access on purpose (see `isOperator`): the token is a
   * server-side secret only whoever configured the deployment holds.
   */
  serviceToken?: boolean;
  /**
   * `TIMELINES_DB_LIVE`, already read from the runtime's own env (`process.env`
   * / `Deno.env`) — pass it through `liveOverride`. Undefined leaves the mode to
   * `defaultLive`, which derives it from the configured backend.
   */
  live?: SourceLive;
};

/**
 * A single path segment of a source or item id.
 *
 * Dots are allowed because an item in a Markdown directory source is identified
 * by its file path, and file names carry dots. `.` and `..` are excluded
 * separately: those are the only two that mean something to the filesystem, and
 * excluding them by name is exact where a character blocklist is a guess.
 *
 * This is not the containment guard. That one lives in `scripts/local/file-repo.ts`
 * and works on the RESOLVED path, which is what catches the encodings a
 * character rule misses; this check only keeps obviously malformed ids out of
 * the dispatcher.
 */
const ID_SEGMENT = /^[a-zA-Z0-9_.-]+$/;
const isIdSegment = (s: string): boolean => s !== '.' && s !== '..' && ID_SEGMENT.test(s);

function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // The data API is never cached, by the CDN or the browser: a stale
      // timeline is indistinguishable from a live one (AGENTS.md → „No fallback
      // data, ever"). The public pricing endpoint sets its own policy below.
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

const hasDb = (c: DbConnections): boolean => Boolean(c.sql || c.supabase);

/** The request's JSON body, or undefined for a bodyless method / empty body. */
async function readBody(req: Request, method: string): Promise<unknown> {
  if (method === 'GET' || method === 'DELETE') return undefined;
  const raw = await req.text();
  return raw.trim() ? JSON.parse(raw) : undefined;
}

/**
 * Is this one of ours at all?
 *
 * Needed as its own question because authorization has to run after „yes" and
 * before anything else. Checking it inside the individual route branches would
 * put a `403` in front of `/api/me` and `/api/jira/search`, which this module
 * does not own and answers `null` for so the caller can fall through.
 *
 * The public pricing route is deliberately absent: it is answered before this is
 * ever consulted.
 */
function isOurs(path: string): boolean {
  return (
    path === '/api/plugins' ||
    path.startsWith('/api/plugins/') ||
    path === '/api/users' ||
    path === '/api/sources' ||
    path === '/api/source' ||
    path.startsWith('/api/source/')
  );
}

// Re-exported so the runtimes keep reaching it through this module; the parser
// itself lives with the rules, because the auth gate needs it too and must not
// import a module that pulls in both database drivers.
export { accessControlEnabled };

/** The service role a runtime should use for its token caller, defaulting to editor. */
export function serviceRoleFrom(raw: string | undefined | null): MemberRole {
  // Defaulting to `editor` keeps every existing automation working unchanged the
  // day the switch is turned on. An operator who wants a read-only agent says so.
  return normalizeMemberRole(raw) ?? 'editor';
}

/**
 * May this caller do this? Answers a `Response` to send, or null to proceed.
 *
 * The check lives here, once, rather than in the eleven branches of the
 * dispatcher below: a per-branch check is eleven chances to forget one, and the
 * one forgotten is a write path.
 */
function requiredCapability(path: string, method: string): Capability {
  const base = capabilityForMethod(method);
  // Managing people is its own stake: a PATCH on a timeline item and a PATCH on
  // a membership are the same verb with very different consequences. Reading the
  // directory stays a plain read, because the owner picker needs it.
  if (path === '/api/users' && base !== 'read') return 'manage';
  return base;
}

async function authorize(path: string, method: string, ctx: ApiContext): Promise<Response | null> {
  if (!ctx.accessControl) return null;

  const capability: Capability = requiredCapability(path, method);
  // `message` rather than `detail`: the client's `apiJson` surfaces that field
  // (src/editor.ts), so the user reads the reason instead of the word
  // „forbidden". It also does NOT redirect on 403 — only 401 means „log in
  // again" — so a refusal has to explain itself where it lands.
  const deny = (message: string) => json({ error: 'forbidden', capability, message }, 403);

  // A program acting under a service token: no person, no membership row.
  if (ctx.serviceRole) {
    return roleAllows(ctx.serviceRole, capability)
      ? null
      : deny(`this token acts as ${ctx.serviceRole}, which may not ${capability}`);
  }

  const email = ctx.caller?.email?.trim();
  if (!email) return deny('no identity on this request');

  // Membership lives in the database, so a deployment serving only files has
  // nowhere to look it up. Refusing loudly beats both alternatives: denying
  // everybody would brick such an instance with no explanation, and ignoring the
  // switch would leave an operator believing they had turned something on.
  const repo = resolveRepo(ctx.conns);
  if (!repo) {
    return json(
      {
        error: 'access_control_without_database',
        message:
          'TIMELINES_ACCESS_CONTROL is on, but no database is configured to hold the member list.',
      },
      503,
    );
  }

  const member = await repo.getMember(email);
  // One message for „not a member" and „wrong role" on purpose: the difference
  // is only interesting to somebody probing which addresses exist.
  return memberCan(member, capability) ? null : deny(`${email} may not ${capability} here`);
}

/**
 * `GET /api/public/plugin/<pluginId>/<timelineId>` — a plugin's published rows.
 *
 * The generic replacement for a per-plugin public endpoint: any installed plugin
 * can publish, and none of them needs a route of its own. The three gates and
 * the projection live in `handlePublicPluginApi`, above the repo, so every
 * runtime enforces them identically.
 *
 * Every answer carries the public headers, errors included. A consumer is a page
 * on another origin, and a CORS-less 404 reaches it as an opaque network failure
 * rather than as „nothing published under that id".
 */
async function handlePublicPlugin(pathname: string, search: URLSearchParams, ctx: ApiContext): Promise<Response> {
  const pub = (data: unknown, status: number, cache: string) =>
    json(data, status, { 'Cache-Control': cache, 'Access-Control-Allow-Origin': '*' });

  const parsed = parsePublicPluginPath(pathname);
  if (!parsed) return pub({ error: 'not found' }, 404, 'no-store');
  // A local-file instance publishes too, so the file repo counts as a backend
  // here — `resolveRepo` alone would answer 503 on a checkout without a database.
  const repo = resolveRepo(ctx.conns) ?? ctx.conns.local?.repo;
  if (!repo) return pub({ error: 'db_not_configured' }, 503, 'no-store');
  try {
    const result = await handlePublicPluginApi(repo, makeManifestSource(repo), {
      method: 'GET',
      pluginId: parsed.pluginId,
      timelineId: parsed.timelineId,
      collection: search.get('collection') ?? undefined,
    });
    // Cacheable only on a hit: consumers fetch at build time, so briefly stale is
    // fine, but caching a miss would outlive the moment a timeline is published.
    return pub(
      result.json,
      result.status,
      result.status === 200 ? 'public, max-age=300, s-maxage=300' : 'no-store',
    );
  } catch (err) {
    return pub({ error: 'server_error', message: String(err) }, 500, 'no-store');
  }
}

/**
 * Serve one API request, or answer `null` when the path is none of ours so the
 * caller can fall through to its own routes (static files, the dev server's
 * middleware chain, the edge function's pass-through).
 *
 * Auth is the caller's business and has to happen *before* this: the edge
 * function checks the session cookie or the MCP token, the dev server trusts
 * localhost, and a self-hosted server puts its own gate in front (#32).
 */
export async function handleApiRequest(req: Request, ctx: ApiContext): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method || 'GET';

  // Answered before any authorization, and `isPublicPath` is the same predicate
  // the self-hosted gate admits them by (scripts/admission.ts). Two spellings of
  // „this route is public" is how one of them later stops being true.
  if (isPublicPath(path)) {
    if (method !== 'GET') return json({ error: 'method not allowed' }, 405);
    if (path.startsWith('/api/pricing')) return retiredPricingResponse(path);
    return handlePublicPlugin(path, url.searchParams, ctx);
  }

  // Ours, and only now: everything below may refuse, and a refusal must never
  // reach a path this module does not own (see `isOurs`).
  if (!isOurs(path)) return null;
  const denied = await authorize(path, method, ctx);
  if (denied) return denied;

  if (path === '/api/users') {
    if (method !== 'GET' && method !== 'POST' && method !== 'PATCH') {
      return json({ error: 'method not allowed' }, 405);
    }
    const repo = resolveRepo(ctx.conns);
    // Without a DB there is no directory. 200 with an empty list rather than an
    // error: that is the truth for a checkout without credentials, and no source
    // is editable there anyway, so the owner picker having nothing to offer is
    // correct rather than a failure. A write has nowhere to go and says so.
    if (!repo) {
      if (method === 'GET') return json({ users: [] });
      return json({ error: 'db_not_configured', message: 'Membership needs a database.' }, 503);
    }
    const result = await handleUsersApi(repo, { method, caller: ctx.caller, body: await readBody(req, method) });
    return json(result.json, result.status);
  }

  // The instance's install registry — a sibling of /api/sources rather than
  // something under a timeline: which plugins this deployment has is not a
  // property of any one of them.
  if (path === '/api/plugins' || path.startsWith('/api/plugins/')) {
    const repo = resolveRepo(ctx.conns) ?? ctx.conns.local?.repo;
    // No backend, no registry. An empty list rather than an error: that is the
    // truth for a checkout without credentials, and the panel then says „nothing
    // installed" instead of showing a failure the reader cannot act on.
    if (!repo) {
      if (method === 'GET') return json({ plugins: [] });
      return json({ error: 'db_not_configured', message: 'The install registry needs a backend.' }, 503);
    }
    const pluginId = path.slice('/api/plugins'.length).replace(/^\/+|\/+$/g, '');
    const result = await handlePluginsApi(repo, {
      method,
      pluginId: pluginId ? decodeURIComponent(pluginId) : undefined,
      body: await readBody(req, method),
      params: Object.fromEntries(url.searchParams),
      caller: { email: ctx.caller?.email ?? null, mcp: ctx.serviceToken },
      operators: ctx.operators ?? [],
    });
    return json(result.json, result.status);
  }

  if (path === '/api/sources') {
    if (method !== 'GET') return json({ error: 'method not allowed' }, 405);
    // Answerable from the filesystem even with no DB: the local timelines ARE
    // sources, and returning [] would hide them.
    if (!hasDb(ctx.conns) && !ctx.conns.local) return json({ sources: [] });
    try {
      const result = await resolveAdapter(ctx.conns, '').handle({ method: 'GET', id: '' });
      return json(result.json, result.status);
    } catch (err) {
      return json({ error: 'server_error', message: String(err) }, 500);
    }
  }

  // Whatever is left is a source path: `isOurs` above admitted only these four
  // shapes and the two collection routes have returned. The former re-check here
  // is gone rather than kept „for safety" — a condition that can no longer be
  // true reads as a live guard and outlives the reason it was written.

  const parsed = parseSourcePath(path.replace(/^\/api\/source/, ''));
  if (!parsed) return json({ error: 'invalid path' }, 400);

  // The `/plugin/…` parts are deliberately exempt, and the exemption is not a
  // hole: none of them ever becomes a path, and each is checked against something
  // stricter than a charset — the plugin id and the collection against the
  // installed manifest (an allowlist), the row id by the store that holds it. A
  // charset rule would meanwhile reject legitimate values: a scoped plugin id
  // carries `@` and `/`, and a composite row id carries `:` and percent escapes.
  const segs = [
    ...parsed.id.split('/'),
    ...(parsed.sub?.plugin ? [] : [parsed.sub?.childId]),
  ].filter(Boolean) as string[];
  if (!segs.every(isIdSegment)) return json({ error: `invalid id "${parsed.id}"` }, 400);

  // A local file answers for its own id whether or not a DB exists, so the
  // "no DB" refusal must not intercept it — that gate predates local sources and
  // would otherwise 404 every JSON timeline on a checkout without credentials,
  // which is the common contributor setup.
  if (!hasDb(ctx.conns) && !ctx.conns.local?.has(parsed.id)) {
    // 404 on GET (nothing to read), 503 on a write. The client surfaces either
    // loudly; there is no static content fallback.
    if (method === 'GET') return json({ error: 'db_not_configured' }, 404);
    return json(
      {
        error: 'db_not_configured',
        detail: 'Set TIMELINES_DATABASE_URL, or TIMELINES_SUPABASE_URL + TIMELINES_SUPABASE_SERVICE_KEY.',
      },
      503,
    );
  }

  let body: unknown;
  if (method !== 'GET' && method !== 'DELETE') {
    try {
      body = await readBody(req, method);
    } catch (err) {
      return json({ error: 'invalid JSON', detail: String(err) }, 400);
    }
  }

  const ifMatchHeader = req.headers.get('if-match');
  const ifMatch = ifMatchHeader ? parseInt(ifMatchHeader, 10) : undefined;

  const apiReq: ApiRequest = {
    method,
    id: parsed.id,
    sub: parsed.sub,
    body,
    ifMatch: Number.isFinite(ifMatch as number) ? (ifMatch as number) : undefined,
    updatedBy: ctx.updatedBy,
  };

  try {
    const adapter = resolveAdapter(ctx.conns, apiReq.id, ctx.live);
    const result = await adapter.handle(apiReq);
    // Tell the client which live-update impl applies (read by loadSource).
    return json(result.json, result.status, { 'X-Source-Live': adapter.capabilities.live });
  } catch (err) {
    return json({ error: 'server_error', message: String(err) }, 500);
  }
}

export { liveOverride };
