// Timelines MCP server (stdio).
//
// Lets Claude Code read and manipulate sheet-backed timelines by talking to the
// live Acme Timelines deploy. Every read/write goes through the site's
// /api/source(s) endpoints, which proxy the underlying Google Sheet — so the
// sheet stays the single source of truth and edits are immediately live.
//
// Auth: the auth gate is bypassed with an X-MCP-Token header; server-side the
// sheets-api function uses a stored service refresh token to reach Google.
//
// Config (env, with fallback to ~/_AGENTS/.env then <repo>/.env.local):
//   MCP_API_TOKEN      — required; must match the Netlify env var of the same name
//   TIMELINES_LIVE_URL — optional; default https://example-timelines.netlify.app
//
// Only Google-Sheets-backed timelines are exposed. File-based sources are
// read-only on the live site and therefore not manipulable here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TimelineFile, TimelineFileItem } from '../../src/types.js';
import { enforceExtentExclusivity, type TimelineGroupDecl } from '../db/timeline-repo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------- config / env ----------

/** Minimal .env parser — mirrors vite.config.ts. process.env always wins. */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[m[1]] = value;
    }
  } catch {
    /* file may not exist — fine */
  }
  return out;
}

const fromFiles = {
  ...parseEnvFile(resolve(homedir(), '_AGENTS/.env')),
  ...parseEnvFile(resolve(REPO_ROOT, '.env.local')),
};
const pick = (k: string): string => process.env[k] ?? fromFiles[k] ?? '';

const BASE_URL = (pick('TIMELINES_LIVE_URL') || 'https://example-timelines.netlify.app').replace(
  /\/+$/,
  '',
);
const API_TOKEN = pick('MCP_API_TOKEN');

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
      'MCP_API_TOKEN is not set. Add it to ~/_AGENTS/.env (and the matching Netlify env var).',
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

// Encode each path segment but keep the "/" separators — timeline ids like
// "acme/<name>" must stay real path segments (encodeURIComponent would turn
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
  title: z.string().optional().describe('Tooltip text.'),
  type: z.enum(['point', 'range', 'background', 'box']).optional(),
  className: z.string().optional(),
  icon: z
    .string()
    .optional()
    .describe(
      'Semantic icon key (brand resolves the glyph): milestone, launch, done, warning, blocked, review, deadline, meeting, idea, research, design, build, bug, release, decision, goal, info, note.',
    ),
  body: z.string().optional().describe('Markdown shown in the detail panel.'),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe(
      'Free-form extras, e.g. { "owner": "Product Lead", "dependsOn": ["S-1"] }. Custom-field ' +
        'values also live here under the field key (string for text/select, string[] for ' +
        'multi-select), e.g. { "tier": ["Free", "Scale"] } — see the timeline\'s customFields.',
    ),
} as const;

const customFieldOption = z.object({
  value: z.string().describe('Stored option value.'),
  label: z.string().optional().describe('Display label (defaults to value).'),
  color: z.string().optional().describe('Pill colour, hex e.g. "#315DFF".'),
});

const customFieldDef = z.object({
  key: z.string().describe('metadata key the value is stored under, e.g. "tier".'),
  label: z.string().describe('Field label shown in the editor, e.g. "Tier".'),
  type: z.enum(['text', 'select', 'multi-select']),
  options: z
    .array(customFieldOption)
    .optional()
    .describe('Allowed choices for select / multi-select. Ignored for text.'),
});

const pricingFeature = z.object({
  id: z.string().describe('Stable feature id, referenced by tiers and item metadata.'),
  name: z.string().describe('Feature display name.'),
  group: z.string().optional().describe('Grouping label for the matrix rows, e.g. "Funktionen".'),
  description: z.string().optional(),
});

const pricingTier = z.object({
  id: z.string().describe('Stable tier id.'),
  name: z.string().describe('Tier name, e.g. "Medium".'),
  price: z.string().describe('Free-form price string, e.g. "74,95 €/Monat" or "ab 449,95 €".'),
  values: z
    .record(z.union([z.string(), z.boolean()]))
    .describe(
      'Per-tier feature values keyed by feature id: true = included (✓), false/omitted = not ' +
        'included (–), string = shown verbatim ("3.000", "unbegrenzt (RAG)"). Lets one feature ' +
        'differ per tier instead of a boolean row per value.',
    ),
});

const pricing = z.object({
  features: z.array(pricingFeature),
  tiers: z.array(pricingTier),
});

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
      'List all Google-Sheets-backed timelines available on the live site (id, name, description). Only these are editable via this server.',
    inputSchema: {},
  },
  async () => ok(await listSources()),
);

server.registerTool(
  'get_timeline',
  {
    title: 'Get timeline',
    description:
      'Fetch a full timeline (name, description, items, groups) by id, as it currently is in the Google Sheet.',
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
      type: z.string().optional().describe("Timeline kind. 'product' unlocks the pricing model."),
      items: z.array(z.object(itemFields)),
      groups: z.array(z.object(groupFields)).optional(),
      customFields: z.array(customFieldDef).optional().describe('Per-timeline custom-field definitions.'),
      pricing: pricing.optional().describe('Pricing model (features + tiers) for product timelines.'),
    },
  },
  async ({ id, ...file }) => {
    await putTimeline(id, file as TimelineFile);
    return ok({ ok: true, id, items: file.items.length });
  },
);

server.registerTool(
  'set_pricing',
  {
    title: 'Set pricing model',
    description:
      "Set a timeline's pricing model (features + tiers) and optionally its type. Patched as a " +
      'unit (like set_custom_fields); items are untouched. Set type to "product" to surface the ' +
      'pricing matrix in the viewer. Pass an empty features/tiers array to clear. Item→feature ' +
      'links live per item in metadata.featureIds (string[]) — set via add_item / update_item. ' +
      'Note: for the AI-Agents timeline the pricing model is normally authored in Preismodell.md ' +
      'and synced automatically; use this tool for other product timelines or ad-hoc fixes.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      type: z.string().optional().describe("Timeline kind, usually 'product'."),
      pricing: pricing.describe('The full new pricing model.'),
    },
  },
  async ({ id, type, pricing: pricingModel }) => {
    const meta: Record<string, unknown> = { pricing: pricingModel };
    if (type !== undefined) meta.type = type;
    await patchMeta(id, meta);
    return ok({ ok: true, id, type, features: pricingModel.features.length, tiers: pricingModel.tiers.length });
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the MCP channel).
  console.error(`[timelines-mcp] connected — base ${BASE_URL}${API_TOKEN ? '' : ' (no MCP_API_TOKEN!)'}`);
}

main().catch((err) => {
  console.error('[timelines-mcp] fatal:', err);
  process.exit(1);
});
