// Zeitlines MCP server (stdio).
//
// Lets Claude Code read and manipulate DB-backed timelines by talking to the
// live Zeitlines deploy. Every read/write goes through the site's
// /api/source(s) endpoints, which hit the timelines-api edge function backed by
// Supabase (Postgres) — so the DB stays the single source of truth and edits are
// immediately live.
//
// Auth: the auth gate is bypassed with an X-MCP-Token header; server-side the
// timelines-api function uses the Supabase service key to reach the DB.
//
// Config (read through the shared cascade in ../db/env.ts: process.env →
// <repo>/.env.local → files named by TIMELINES_ENV_FILE):
//   MCP_API_TOKEN      — required; must match the Netlify env var of the same name
//   TIMELINES_LIVE_URL — required; the deploy to target (e.g. https://<site>.netlify.app)
//
// Only DB-backed timelines are exposed. File-based sources are read-only on the
// live site and therefore not manipulable here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { TimelineFile, TimelineFileItem } from '../../src/types.js';
import { envSourcesHint, envValue } from '../db/env.js';
import { enforceExtentExclusivity, type TimelineGroupDecl } from '../db/timeline-repo.js';
import { appendItemTo, applyItemPatchTo, type ItemPatch } from './patch.js';
import { mcpPluginTools, splitChanges, toolResult } from './pluginTools.js';
import { NO_BUCKET, SAVED_VIEW_HELP, savedViewDimensions } from './savedViewTools.js';

// ---------- config / env ----------

const BASE_URL = envValue('TIMELINES_LIVE_URL').replace(/\/+$/, '');
const API_TOKEN = envValue('MCP_API_TOKEN');

// ---------- live-site client ----------

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  if (!API_TOKEN) {
    throw new Error(
      `MCP_API_TOKEN is not set. Add it to ${envSourcesHint()} (and the matching Netlify env var).`,
    );
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'X-MCP-Token': API_TOKEN,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = text ? ` — ${text.slice(0, 500)}` : '';
    throw new ApiError(
      `${init?.method ?? 'GET'} ${path} → ${res.status}${detail}`,
      res.status,
      text,
    );
  }
  return text ? JSON.parse(text) : null;
}

async function listSources(): Promise<Array<{ id: string; name?: string; description?: string }>> {
  const data = (await api('/api/sources')) as {
    sources?: Array<{ id: string; name?: string; description?: string }>;
  };
  return data.sources ?? [];
}

async function listUsers(): Promise<Array<{ email: string; name?: string }>> {
  const data = (await api('/api/users')) as { users?: Array<{ email: string; name?: string }> };
  return data.users ?? [];
}

// Encode each path segment but keep the "/" separators — timeline ids like
// "<namespace>/<name>" must stay real path segments (encodeURIComponent would turn
// the slash into %2F, which the /api/source/* route doesn't match → 404).
function encodeId(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/');
}

async function getTimeline(id: string): Promise<TimelineFile> {
  const data = (await api(`/api/source/${encodeId(id)}`)) as TimelineFile;
  if (!data || !Array.isArray(data.items)) {
    throw new Error(`Source "${id}" is not a sheet-backed timeline (no editable items returned).`);
  }
  return data;
}

async function putTimeline(id: string, file: TimelineFile): Promise<void> {
  await api(`/api/source/${encodeId(id)}`, {
    method: 'PUT',
    body: JSON.stringify(file),
  });
}

/** Patch timeline-level meta (name/description/groupBy/customFields) — no item touch. */
async function patchMeta(id: string, meta: Record<string, unknown>): Promise<void> {
  await api(`/api/source/${encodeId(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(meta),
  });
}

/**
 * Call a sub-resource endpoint (item, or a plugin's rows) on a timeline.
 *
 * `ifMatch` is a header rather than part of the body because that is where the
 * write path reads it: a lock counter inside the payload would be stored as data
 * on the next plugin that happens to declare a field of that name.
 */
async function apiSub(
  id: string,
  subPath: string,
  method: string,
  body?: unknown,
  ifMatch?: number,
): Promise<unknown> {
  return api(`/api/source/${encodeId(id)}/${subPath}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...(ifMatch != null ? { headers: { 'If-Match': String(ifMatch) } } : {}),
  });
}

/** The two item writes, with the extent rule this server's repo layer supplies. */
const applyItemPatch = (file: TimelineFile, itemId: string, patch: ItemPatch): void =>
  applyItemPatchTo(file, itemId, patch);
const appendItem = (file: TimelineFile, item: TimelineFileItem): void =>
  appendItemTo(file, item, enforceExtentExclusivity);

/** Read-modify-write helper: fetch, mutate in memory, push back. Returns the new file. */
async function mutate(
  id: string,
  fn: (file: TimelineFile) => void,
): Promise<TimelineFile> {
  const file = await getTimeline(id);
  fn(file);
  await putTimeline(id, file);
  return file;
}

// ---------- zod shapes ----------

const itemFields = {
  id: z.string().optional().describe('Stable item id (needed for dependsOn references and edits).'),
  start: z
    .string()
    .optional()
    .describe(
      'Start date, YYYY-MM-DD (or ISO datetime if precision matters). Optional — an item may have no date yet (shown only in the list view, hidden from the timeline until a start is set).',
    ),
  end: z
    .string()
    .optional()
    .describe(
      'End date, YYYY-MM-DD. Mutually exclusive with duration — set one, not both. If both are given, end wins and duration is dropped.',
    ),
  duration: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      'Length, e.g. "7d", "2w", "90m", ISO "P7D", or milliseconds as number. Mutually exclusive with end (set one, not both). To switch an end-based item to a duration, send duration alone — the stored end is cleared.',
    ),
  content: z.string().describe('Item title shown on the bar.'),
  group: z.string().optional().describe('Group id this item belongs to.'),
  type: z.enum(['point', 'range', 'background', 'box']).optional(),
  className: z.string().optional(),
  icon: z
    .string()
    .optional()
    .describe(
      'Semantic icon key (brand resolves the glyph): milestone, launch, done, warning, blocked, review, deadline, meeting, idea, research, design, build, bug, release, decision, goal, info, note.',
    ),
  status: z
    .enum(['Open', 'Doing', 'Done'])
    .optional()
    .describe('Built-in item status: Open, Doing, or Done. Defaults to Open when omitted.'),
  body: z.string().optional().describe('Markdown shown in the detail panel.'),
  metadata: z
    .record(z.unknown())
    // Nullable so `update_item` can clear the object outright, which is the same
    // contract the remote server offers — the two expose one tool name and must
    // not accept different things under it.
    .nullable()
    .optional()
    .describe(
      'Free-form extras, e.g. { "owner": "robin@example.com", "dependsOn": ["S-1"] }. ' +
        '`parent` holds the id of the item this one is part of ("S-1"), at most one — the ' +
        'parent then renders as a summary bar above its children and can fold them away. ' +
        'A link to the item itself, to an unknown id, or one that would close a cycle is ' +
        'dropped when the timeline is built. ' +
        '`owner` links a user and holds their e-mail from list_users — a free-text name ' +
        'is still stored but shows as unlinked. Custom-field ' +
        'values also live here under the field key (string for text/select, string[] for ' +
        'multi-select), e.g. { "risk": ["Technisch"] } — see the timeline\'s customFields. ' +
        'Plugin-contributed fields store ids, not labels — the ids of the plugin\'s own rows rather ' +
        'than the labels shown for them.',
    ),
} as const;

const customFieldOption = z.object({
  value: z.string().describe('Stored option value.'),
  label: z.string().optional().describe('Display label (defaults to value).'),
  color: z.string().optional().describe('Pill colour, hex e.g. "#315DFF".'),
});

const pluginRef = z.object({
  id: z.string().describe('Plugin id, as listed by the instance\'s installed plugins.'),
  config: z.record(z.any()).optional().describe('Plugin-owned config bag, e.g. { versions: [...] }.'),
});

const customFieldDef = z.object({
  key: z.string().describe('metadata key the value is stored under, e.g. "tier".'),
  label: z.string().describe('Field label shown in the editor, e.g. "Tier".'),
  type: z.enum(['text', 'select', 'multi-select']),
  options: z
    .array(customFieldOption)
    .optional()
    .describe('Allowed choices for select / multi-select. Ignored for text.'),
  contextMenu: z
    .boolean()
    .optional()
    .describe(
      'Also settable from an item\'s right-click menu, where the field appears as a submenu of ' +
        'its options. Off by default. Ignored for text (a menu can only offer fixed choices).',
    ),
});

// The rows a plugin owns, exactly as the host stores them. There is deliberately
// no per-plugin shape here: what a row may contain is declared in the plugin's
// manifest and checked server-side, and a second copy in zod would give two
// answers to one question — the copy in this file being the one nobody updates.
const pluginDataRow = z.object({
  id: z.string().describe('Row id. For a collection with declared key fields the host derives it.'),
  data: z.record(z.unknown()).describe("The row payload, shaped by the plugin's declaration."),
  version: z.number().optional().describe('The host\'s lock counter. Read-only; send it as ifMatch on a patch.'),
});

const pluginData = z
  .record(z.record(z.array(pluginDataRow)))
  .describe('pluginId → collection id → rows.');

const groupFields = {
  id: z.string().describe('Group id.'),
  content: z.string().describe('Display name.'),
  nestedGroups: z.array(z.string()).optional().describe('Child group ids.'),
  showNested: z.boolean().optional(),
  color: z
    .string()
    .optional()
    .describe(
      'Any CSS colour, honoured by the graph presentation. Unset falls back to the positional ' +
        'lane palette. Set it when the group means a KIND of thing rather than a track — a hint ' +
        'green, an antagonist red — because which kind is which colour is the author\'s call.',
    ),
} as const;

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

// ---------- server ----------

const server = new McpServer({ name: 'timelines', version: '0.1.0' });

server.registerTool(
  'list_timelines',
  {
    title: 'List timelines',
    description:
      'List all DB-backed timelines available on the live site (id, name, description). Only these are editable via this server.',
    inputSchema: {},
  },
  async () => ok(await listSources()),
);

server.registerTool(
  'list_users',
  {
    title: 'List users',
    description:
      'List the users an item\'s Owner can be linked to (email, name). `metadata.owner` stores one of these emails — call this before setting an owner instead of writing a free-text name, which no longer resolves to a person.',
    inputSchema: {},
  },
  async () => ok(await listUsers()),
);

server.registerTool(
  'get_timeline',
  {
    title: 'Get timeline',
    description:
      'Fetch a full timeline (name, description, items, groups) by id, as it currently is in the DB.',
    inputSchema: { id: z.string().describe('Timeline id from list_timelines.') },
  },
  async ({ id }) => ok(await getTimeline(id)),
);

server.registerTool(
  'replace_timeline',
  {
    title: 'Replace timeline',
    description:
      'Overwrite an entire timeline. The provided object replaces items and groups wholesale (the sheet is cleared and rewritten). Use for bulk edits; prefer the granular item/group tools for single changes.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      plugins: z
        .array(pluginRef)
        .optional()
        .describe(
          'Plugins enabled on the timeline, each with its config. A plugin that has rows in ' +
            '`pluginData` is enabled by that alone, so this is only needed to enable one without data ' +
            'or to set its config.',
        ),
      items: z.array(z.object(itemFields)),
      groups: z.array(z.object(groupFields)).optional(),
      customFields: z.array(customFieldDef).optional().describe('Per-timeline custom-field definitions.'),
      pluginData: pluginData
        .optional()
        .describe(
          'Every enabled plugin\'s rows, keyed by plugin id then collection id. This is the bulk way to ' +
            'seed a plugin\'s data — it replaces the rows wholesale, so read them first if you mean to ' +
            'add to them. For single edits prefer write_plugin_data, which touches one row and will not ' +
            'clobber a concurrent browser edit.',
        ),
    },
  },
  async ({ id, ...file }) => {
    await putTimeline(id, file as TimelineFile);
    return ok({ ok: true, id, items: file.items.length });
  },
);

// ---------- plugin data (generic, no plugin named here) ----------
//
// These three replace thirteen hand-written tools for one plugin's entities. That
// is the point of #17: a tool per plugin entity means this file has to be edited
// before anybody can author a third-party plugin's data, which was a privilege
// exactly one plugin had and nobody else could get.
//
// What a collection is called and what a row may contain comes from the plugin's
// manifest, so the schema here is deliberately `record(unknown)` — validation
// happens server-side against the declaration, and duplicating it in zod would
// give two answers to one question.

server.registerTool(
  'read_plugin_data',
  {
    title: 'Read a plugin\'s rows',
    description:
      'Read the rows one plugin owns on a timeline. Omit `collection` for every collection at once. ' +
      'Which collections exist is declared by the plugin\'s manifest. Each row is ' +
      '{ id, data, version, updatedAt, updatedBy } — `version` is the lock counter to send back as ' +
      '`ifMatch` on a patch, not anything the plugin stored.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      pluginId: z.string().describe('Plugin id.'),
      collection: z.string().optional().describe('One declared collection; omit for all of them.'),
    },
  },
  async ({ id, pluginId, collection }) => {
    if (collection) {
      return ok(await apiSub(id, `plugin/${encodeId(pluginId)}/${encodeId(collection)}`, 'GET'));
    }
    // Every collection at once comes off the timeline payload, which already
    // carries `pluginData` for exactly this reason. `…/plugin/<id>` without a
    // collection is a different question — whether the plugin is on here — and
    // answering rows there would make one path mean two things.
    const file = await getTimeline(id);
    return ok({ rows: file.pluginData?.[pluginId] ?? {} });
  },
);

server.registerTool(
  'write_plugin_data',
  {
    title: 'Write a plugin\'s rows',
    description:
      'Create, patch, delete or reorder ONE row of one plugin collection. Four operations because they ' +
      'are four HTTP verbs on the same resource, not four resources:\n' +
      '- `put`: create or replace the row `rowId` with `data`.\n' +
      '- `patch`: merge `data` into the stored row; a key sent as null is removed. Send `ifMatch` (the ' +
      'row\'s `version` from read_plugin_data) to fail loudly instead of overwriting a concurrent edit.\n' +
      '- `delete`: remove the row. Rows referencing it follow the manifest\'s declared cascade — they are ' +
      'deleted, unlinked, or the delete is refused with 409, whichever the plugin declared.\n' +
      '- `move`: reposition it after OR before `anchor` (ordered collections only); returns the new id order.\n' +
      'The row shape is checked against the collection\'s declaration server-side, so an unknown collection ' +
      'or a dangling reference is refused rather than stored.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      pluginId: z.string().describe('Plugin id.'),
      collection: z.string().describe('A collection the plugin\'s manifest declares.'),
      op: z.enum(['put', 'patch', 'delete', 'move']).describe('What to do with the row.'),
      rowId: z
        .string()
        .optional()
        .describe(
          'The row id. Required for patch / delete / move. For `put` it may be omitted when the ' +
            'collection declares key fields — the host derives the id from them.',
        ),
      data: z.record(z.unknown()).optional().describe('The row payload for put / patch.'),
      ifMatch: z.number().optional().describe('The row version a patch expects; a mismatch answers 409.'),
      after: z.string().optional().describe('move: place the row immediately AFTER this row id.'),
      before: z.string().optional().describe('move: place the row immediately BEFORE this row id.'),
    },
  },
  async ({ id, pluginId, collection, op, rowId, data, ifMatch, after, before }) => {
    const base = `plugin/${encodeId(pluginId)}/${encodeId(collection)}`;
    if (op === 'move') {
      if (!rowId) throw new Error('move needs rowId');
      return ok(await apiSub(id, `${base}/move`, 'POST', { id: rowId, after, before }));
    }
    if (op === 'delete') {
      if (!rowId) throw new Error('delete needs rowId');
      return ok(await apiSub(id, `${base}/${encodeId(rowId)}`, 'DELETE'));
    }
    if (op === 'patch') {
      if (!rowId) throw new Error('patch needs rowId');
      return ok(await apiSub(id, `${base}/${encodeId(rowId)}`, 'PATCH', { data: data ?? {} }, ifMatch));
    }
    return ok(await apiSub(id, base, 'POST', { ...(rowId ? { id: rowId } : {}), data: data ?? {} }));
  },
);

server.registerTool(
  'configure_plugin',
  {
    title: 'Enable, configure or disable a plugin on a timeline',
    description:
      'Turn a plugin on for one timeline and set its config, or turn it off. `config` is validated ' +
      "against the plugin's declared configSchema. `public` opts the timeline's rows " +
      'into the public read route and is only accepted from a plugin that declares publicRead ' +
      'collections. `enabled: false` removes the registration; the rows stay until the plugin is ' +
      'uninstalled instance-wide.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      pluginId: z.string().describe('Plugin id.'),
      enabled: z.boolean().optional().describe('false turns the plugin off for this timeline. Default: on.'),
      config: z.record(z.unknown()).optional().describe("The plugin's config bag."),
      public: z.boolean().optional().describe('Publish this timeline\'s rows of that plugin.'),
    },
  },
  async ({ id, pluginId, enabled, config, public: isPublic }) => {
    const sub = `plugin/${encodeId(pluginId)}`;
    if (enabled === false) return ok(await apiSub(id, sub, 'DELETE'));
    return ok(
      await apiSub(id, sub, 'PUT', {
        config: config ?? {},
        ...(isPublic === undefined ? {} : { public: isPublic }),
      }),
    );
  },
);

server.registerTool(
  'set_layout',
  {
    title: 'Set layout settings',
    description:
      'How a timeline is laid out, beyond its items. `groupOrder` decides whether the groups[] ' +
      'order is honoured ("declared") or the ids are sorted alphabetically ("alpha", the default ' +
      'and what every timeline shipped with) — set "declared" when group ids carry meaning and ' +
      'cannot be renumbered. `graph` configures the relation graph: `bandRootGroup` names the ' +
      'group whose items become band headings (each claims what it reaches and leaves the ' +
      'columns), `referenceGroup` names the group listed ON the nodes it references instead of ' +
      'drawn as edges to them. Both name a group id from describe_view_dimensions. Only the keys ' +
      'you send change; send null to clear one.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      groupOrder: z
        .enum(['alpha', 'declared'])
        .nullable()
        .optional()
        .describe('Group ordering rule. Null resets to the alphabetical default.'),
      graph: z
        .object({
          bandRootGroup: z.string().optional().describe('Group supplying band roots.'),
          referenceGroup: z.string().optional().describe('Group shown as references on a node.'),
        })
        .nullable()
        .optional()
        .describe('Replaced as a unit, not merged. Null clears it.'),
    },
  },
  async ({ id, ...patch }) => {
    // Only the keys actually sent are forwarded: `updateMeta` treats a present key
    // as „change this", so passing undefined through would clear what the caller
    // never mentioned.
    const meta: Record<string, unknown> = {};
    if ('groupOrder' in patch) meta.groupOrder = patch.groupOrder ?? null;
    if ('graph' in patch) meta.graph = patch.graph ?? null;
    await patchMeta(id, meta);
    return ok({ ok: true, id, ...meta });
  },
);

server.registerTool(
  'set_custom_fields',
  {
    title: 'Set custom fields',
    description:
      'Replace a timeline\'s custom-field definitions (patched as a unit; items are untouched). ' +
      'Pass an empty array to clear them. Field values are set per item via metadata under each ' +
      'field\'s key (see add_item / update_item). Example field: ' +
      '{ "key": "tier", "label": "Tier", "type": "multi-select", "options": [{ "value": "Free" }, { "value": "Enterprise" }] }.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      customFields: z.array(customFieldDef).describe('The full new list of custom-field definitions.'),
    },
  },
  async ({ id, customFields }) => {
    await patchMeta(id, { customFields });
    return ok({ ok: true, id, customFields });
  },
);

server.registerTool(
  'add_item',
  {
    title: 'Add item',
    description:
      'Append a new item to a timeline. Requires content; start is optional (a dateless item shows only in the list view). Provide an explicit id if the item is a dependency target.',
    inputSchema: { id: z.string().describe('Timeline id.'), item: z.object(itemFields) },
  },
  async ({ id, item }) => {
    const file = await mutate(id, (f) => appendItem(f, item as TimelineFileItem));
    return ok({ ok: true, id, itemId: item.id, items: file.items.length });
  },
);

server.registerTool(
  'update_item',
  {
    title: 'Update item',
    description:
      'Patch fields of an existing item, matched by itemId. Only provided fields change; metadata is ' +
      'shallow-merged onto what the item already carries. Give a metadata key the value null to remove ' +
      'it, or metadata: null to clear the whole object.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      itemId: z.string().describe('Id of the item to update.'),
      patch: z.object(itemFields).partial(),
    },
  },
  async ({ id, itemId, patch }) => {
    await mutate(id, (f) => applyItemPatch(f, itemId, patch));
    return ok({ ok: true, id, itemId, updated: true });
  },
);

server.registerTool(
  'delete_item',
  {
    title: 'Delete item',
    description: 'Remove an item from a timeline, matched by itemId.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      itemId: z.string().describe('Id of the item to remove.'),
    },
  },
  async ({ id, itemId }) => {
    let removed = 0;
    await mutate(id, (f) => {
      const before = f.items.length;
      f.items = f.items.filter((i) => i.id !== itemId);
      removed = before - f.items.length;
      if (removed === 0) throw new Error(`Item "${itemId}" not found in "${id}".`);
    });
    return ok({ ok: true, id, itemId, removed });
  },
);

server.registerTool(
  'add_group',
  {
    title: 'Add group',
    description: 'Add a group (track/row) to a timeline. Group ids sort alphanumerically — use a numeric prefix like "1-strategy" to lock row order.',
    inputSchema: { id: z.string().describe('Timeline id.'), group: z.object(groupFields) },
  },
  async ({ id, group }) => {
    await mutate(id, (f) => {
      f.groups = f.groups ?? [];
      if (f.groups.some((g) => g.id === group.id)) {
        throw new Error(`Group "${group.id}" already exists in "${id}".`);
      }
      f.groups.push(group as TimelineGroupDecl);
    });
    return ok({ ok: true, id, groupId: group.id });
  },
);

server.registerTool(
  'update_group',
  {
    title: 'Update group',
    description: 'Patch fields of an existing group, matched by groupId.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      groupId: z.string().describe('Id of the group to update.'),
      patch: z.object(groupFields).partial(),
    },
  },
  async ({ id, groupId, patch }) => {
    await mutate(id, (f) => {
      const g = (f.groups ?? []).find((x) => x.id === groupId);
      if (!g) throw new Error(`Group "${groupId}" not found in "${id}".`);
      Object.assign(g, patch);
    });
    return ok({ ok: true, id, groupId });
  },
);

server.registerTool(
  'delete_group',
  {
    title: 'Delete group',
    description:
      'Remove a group from a timeline. Items referencing it keep their group value but will render ungrouped.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      groupId: z.string().describe('Id of the group to remove.'),
    },
  },
  async ({ id, groupId }) => {
    let removed = 0;
    await mutate(id, (f) => {
      const before = (f.groups ?? []).length;
      f.groups = (f.groups ?? []).filter((g) => g.id !== groupId);
      removed = before - f.groups.length;
      if (removed === 0) throw new Error(`Group "${groupId}" not found in "${id}".`);
    });
    return ok({ ok: true, id, groupId, removed });
  },
);

// ---------- saved views ----------
//
// The one surface here that writes something a PERSON sees rather than something
// the timeline holds: a saved view is a named combination of presentation,
// grouping and filter, and `owner` decides whose list it lands in. That is why
// these tools take an owner at all — "set up the views for the new team member" is
// the case they exist for, and it needs the row to belong to them rather than to
// the token.
//
// Owning a saved view grants nothing, which is what makes writing another person's
// address here ordinary rather than impersonation: it is the same statement
// `metadata.owner` already makes about an item.

const savedViewFields = {
  name: z.string().optional().describe('What the view is called. Required when creating one.'),
  mode: z
    .string()
    .optional()
    .describe(
      'Presentation to open in: "timeline", "list", "graph", or "plugin:<pluginId>:<viewId>". ' +
        'Leave it out and applying the view keeps whatever presentation is showing.',
    ),
  groupBy: z
    .string()
    .optional()
    .describe('Grouping dimension, e.g. "group", "status", "cf:tier" — a key from describe_view_dimensions.'),
  filters: z
    .record(z.array(z.string()))
    .optional()
    .describe(
      'Selected values per dimension, e.g. { "status": ["Open"], "cf:tier": ["Pro"] }. AND across ' +
        'dimensions, OR within one; an empty object narrows nothing. Values come from ' +
        'describe_view_dimensions.',
    ),
  edges: z
    .record(z.enum(['off', 'in', 'out']))
    .optional()
    .describe(
      'Directory sources only: which wikilink fields become dependencies, keyed by the frontmatter ' +
        'field name with "" for the note body, e.g. { "Blocks": "in", "": "off" }. "in" means the ' +
        'linked note leads to this one and is the default for a field left out, "out" the reverse. ' +
        'Field names come from the items\' metadata.wikilinks; a source without those ignores this.',
    ),
  orderFrom: z
    .string()
    .optional()
    .describe(
      'Directory sources only: the id of the ITEM whose body wikilinks, read top to bottom, are the ' +
        'order this view puts the timeline in — a table of contents, an agenda, a running order, ' +
        'which in a folder of notes is a note like any other. The graph starts its chain at the ' +
        'earliest item the order places. Links under a frontmatter key do not count; only the ' +
        "note's own prose does. A source that records no wikilinks ignores this.",
    ),
  owner: z
    .string()
    .optional()
    .describe('E-mail of the person this view is for, from list_users. Defaults to the calling identity.'),
  visibility: z
    .enum(['private', 'instance'])
    .optional()
    .describe('"instance" shows it to every member of the deployment; "private" (the default) to its owner alone.'),
};

server.registerTool(
  'describe_view_dimensions',
  {
    title: 'Describe view dimensions',
    description:
      'The grouping dimensions and filter values a timeline actually offers, as `groupBy` keys and ' +
      '`filters` values for the saved-view tools. Call this before writing a filter: the keys ' +
      '(`group`, `tag`, `status`, `type`, `cf:<field>`) and their values are properties of this ' +
      'timeline, and one that does not exist narrows nothing rather than failing. ' +
      `The value "${NO_BUCKET}" is the "Ohne …" bucket: items with no value for that dimension.`,
    inputSchema: { id: z.string().describe('Timeline id from list_timelines.') },
  },
  async ({ id }) => ok({ id, dimensions: savedViewDimensions(await getTimeline(id)) }),
);

server.registerTool(
  'list_saved_views',
  {
    title: 'List saved views',
    description: `The saved views on a timeline that this identity may see. ${SAVED_VIEW_HELP}`,
    inputSchema: { id: z.string().describe('Timeline id.') },
  },
  async ({ id }) => ok(await api(`/api/source/${encodeId(id)}/saved-view`)),
);

server.registerTool(
  'create_saved_view',
  {
    title: 'Create saved view',
    description: `Store a new saved view on a timeline. ${SAVED_VIEW_HELP}`,
    inputSchema: { id: z.string().describe('Timeline id.'), ...savedViewFields },
  },
  async ({ id, ...view }) =>
    ok(
      await api(`/api/source/${encodeId(id)}/saved-view`, {
        method: 'POST',
        body: JSON.stringify(view),
      }),
    ),
);

server.registerTool(
  'update_saved_view',
  {
    title: 'Update saved view',
    description:
      'Patch one saved view: only the fields given change. Send null for `mode`, `groupBy` or ' +
      '`filters` to clear one. The id is fixed — every link carrying `sv=<id>` depends on it.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      viewId: z.string().describe('Saved view id from list_saved_views.'),
      ...savedViewFields,
    },
  },
  async ({ id, viewId, ...patch }) =>
    ok(
      await api(`/api/source/${encodeId(id)}/saved-view/${encodeURIComponent(viewId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    ),
);

server.registerTool(
  'delete_saved_view',
  {
    title: 'Delete saved view',
    description:
      'Remove a saved view. A shared one disappears for everybody, so check `visibility` before ' +
      'deleting somebody else\'s.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      viewId: z.string().describe('Saved view id from list_saved_views.'),
    },
  },
  async ({ id, viewId }) =>
    ok(
      await api(`/api/source/${encodeId(id)}/saved-view/${encodeURIComponent(viewId)}`, {
        method: 'DELETE',
      }),
    ),
);

// ---------- tools contributed by plugins ----------

// One registration per declared verb, so a plugin's domain rule is a tool an
// agent picks like any other. The list is assembled from the registered plugins
// rather than written here: a core file that spelled out one plugin's verbs would
// be the privilege no third-party plugin can have (see #10).
const contributed = mcpPluginTools();
for (const tool of contributed.tools) {
  server.registerTool(
    tool.decl.name,
    {
      title: tool.decl.title,
      description: tool.decl.description,
      inputSchema: tool.shape,
    },
    async ({ id, ...args }) => {
      // Fetch once and plan against exactly the file that gets written back. A
      // second read between planning and writing would let the rule compute from
      // dates that are no longer there.
      const file = await getTimeline(id as string);
      const plan = tool.plan(file, args as Record<string, unknown>);
      const { updates, adds } = splitChanges(plan);
      for (const { itemId, patch } of updates) applyItemPatch(file, itemId, patch as ItemPatch);
      for (const item of adds) appendItem(file, item as TimelineFileItem);
      if (updates.length || adds.length) await putTimeline(id as string, file);
      return ok(toolResult(plan, { updated: updates.length, added: adds.length }));
    },
  );
}

// ---------- boot ----------

async function main(): Promise<void> {
  if (!BASE_URL) {
    console.error(
      '[timelines-mcp] TIMELINES_LIVE_URL is not set. Point it at your deploy ' +
        `(e.g. https://<site>.netlify.app) via ${envSourcesHint()}, ` +
        'or the MCP server config.',
    );
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the MCP channel).
  console.error(`[timelines-mcp] connected — base ${BASE_URL}${API_TOKEN ? '' : ' (no MCP_API_TOKEN!)'}`);
  if (contributed.tools.length) {
    console.error(`[timelines-mcp] plugin tools: ${contributed.tools.map((t) => t.decl.name).join(', ')}`);
  }
  // A verb that is declared and not callable has to be said out loud. Silence
  // makes it indistinguishable from a plugin that was never installed, which is
  // the wrong thing to go looking for.
  for (const p of contributed.problems) {
    console.error(`[timelines-mcp] plugin tool unavailable — ${p.pluginId}: ${p.problem}`);
  }
}

main().catch((err) => {
  console.error('[timelines-mcp] fatal:', err);
  process.exit(1);
});
