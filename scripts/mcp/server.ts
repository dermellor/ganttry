// Ganttry MCP server (stdio).
//
// Lets Claude Code read and manipulate DB-backed timelines by talking to the
// live Ganttry deploy. Every read/write goes through the site's
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
    .optional()
    .describe(
      'Free-form extras, e.g. { "owner": "robin@example.com", "dependsOn": ["S-1"] }. ' +
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
    const file = await mutate(id, (f) => {
      if (item.id && f.items.some((i) => i.id === item.id)) {
        throw new Error(`Item id "${item.id}" already exists in "${id}".`);
      }
      // Extent fields are mutually exclusive (end wins); never store both.
      enforceExtentExclusivity(item);
      f.items.push(item as TimelineFileItem);
    });
    return ok({ ok: true, id, itemId: item.id, items: file.items.length });
  },
);

server.registerTool(
  'update_item',
  {
    title: 'Update item',
    description:
      'Patch fields of an existing item, matched by itemId. Only provided fields change; metadata is shallow-merged. Pass metadata:null keys to remove them.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      itemId: z.string().describe('Id of the item to update.'),
      patch: z.object(itemFields).partial(),
    },
  },
  async ({ id, itemId, patch }) => {
    let found = false;
    await mutate(id, (f) => {
      const it = f.items.find((i) => i.id === itemId);
      if (!it) throw new Error(`Item "${itemId}" not found in "${id}".`);
      found = true;
      const { metadata, ...rest } = patch;
      Object.assign(it, rest);
      if (metadata) it.metadata = { ...(it.metadata ?? {}), ...metadata };
      // Extent fields are mutually exclusive: whichever the patch set wins and
      // clears the counterpart, so switching end↔duration never leaves both.
      if (rest.end != null) delete it.duration;
      else if (rest.duration != null) delete it.end;
    });
    return ok({ ok: true, id, itemId, updated: found });
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
}

main().catch((err) => {
  console.error('[timelines-mcp] fatal:', err);
  process.exit(1);
});
