// Timelines MCP server (stdio).
//
// Lets Claude Code read and manipulate DB-backed timelines by talking to the
// live Acme Timelines deploy. Every read/write goes through the site's
// /api/source(s) endpoints, which hit the timelines-api edge function backed by
// Supabase (Postgres) — so the DB stays the single source of truth and edits are
// immediately live.
//
// Auth: the auth gate is bypassed with an X-MCP-Token header; server-side the
// timelines-api function uses the Supabase service key to reach the DB.
//
// Config (env, with fallback to ~/_AGENTS/.env then <repo>/.env.local):
//   MCP_API_TOKEN      — required; must match the Netlify env var of the same name
//   TIMELINES_LIVE_URL — required; the deploy to target (e.g. https://<site>.netlify.app)
//
// Only DB-backed timelines are exposed. File-based sources are read-only on the
// live site and therefore not manipulable here.

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

const BASE_URL = pick('TIMELINES_LIVE_URL').replace(/\/+$/, '');
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

/** Call a sub-resource endpoint (item/feature/tier/…) on a timeline. */
async function apiSub(
  id: string,
  subPath: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  return api(`/api/source/${encodeId(id)}/${subPath}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  status: z
    .enum(['Open', 'Doing', 'Done'])
    .optional()
    .describe('Built-in item status: Open, Doing, or Done. Defaults to Open when omitted.'),
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
  version: z
    .string()
    .optional()
    .describe('Version this feature is available from (one of pricing.versions). Absent = from the start.'),
  nameByVersion: z
    .record(z.string())
    .optional()
    .describe(
      'Version-scoped display-name overrides, keyed by a pricing.versions entry. Resolved cumulatively ' +
        '(latest override at or before the selected version wins, falling back to name) — lets a feature ' +
        'rename itself across versions, e.g. {"3.0": "Termine vereinbaren und ändern"}.',
    ),
  descriptionByVersion: z
    .record(z.string())
    .optional()
    .describe(
      'Additive, version-scoped description notes on top of `description`, keyed by a pricing.versions ' +
        'entry. Unlike nameByVersion these are NOT cumulative overrides — the base description stays and ' +
        'each note shows as its own "ab <version>: …" line, e.g. {"2.0": "Jetzt mit Slot-Filling"}.',
    ),
});

const pricingHighlight = z.object({
  id: z.string().describe('Stable highlight id.'),
  label: z.string().describe('Curated label shown on the pricing card.'),
  section: z.string().optional().describe('Card section this bullet belongs to, e.g. "Inkludiert".'),
  icon: z.string().optional().describe('Optional semantic icon key (brand-resolved).'),
  featureIds: z.array(z.string()).describe('Raw feature ids this tile summarizes.'),
  description: z.string().optional(),
  labelByVersion: z
    .record(z.string())
    .optional()
    .describe('Version-scoped label overrides, same semantics as pricingFeature.nameByVersion.'),
});

const pricingTier = z.object({
  id: z.string().describe('Stable tier id.'),
  name: z.string().describe('Tier name, e.g. "Medium".'),
  tagline: z.string().optional().describe('Short segment line, e.g. "Micro · 1–5 Anrufe/Tag".'),
  useCase: z.string().optional().describe('One-line positioning / primary use case (card sub-headline).'),
  targetGroup: z.string().optional().describe('Target-group description, shown as a "Zielgruppe" block.'),
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
  highlights: z
    .array(pricingHighlight)
    .optional()
    .describe('Curated card-view tiles bundling one or more features under a simplified label.'),
  versions: z
    .array(z.string())
    .optional()
    .describe('Ordered version labels (e.g. ["1.0","2.0","3.0"]); defines feature-version ordering + the matrix switcher.'),
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
      'List all DB-backed timelines available on the live site (id, name, description). Only these are editable via this server.',
    inputSchema: {},
  },
  async () => ok(await listSources()),
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
    title: 'Set pricing model (bulk)',
    description:
      "BULK replace of a timeline's whole pricing model (features + tiers + highlights + versions) in " +
      'one call, plus optionally its type. Prefer the granular tools (add_/update_/delete_feature, ' +
      '…_tier, set_tier_value, …_highlight, set_versions) for single edits — each touches one row and ' +
      "won't clobber concurrent browser/MCP edits. Use this only to seed a new model or fully rewrite " +
      'one. Set type to "product" to surface the matrix. Item→feature links live per item in ' +
      'metadata.featureIds (set via add_item / update_item).',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      type: z.string().optional().describe("Timeline kind, usually 'product'."),
      pricing: pricing.describe('The full new pricing model.'),
    },
  },
  async ({ id, type, pricing: pricingModel }) => {
    if (type !== undefined) await patchMeta(id, { type });
    await apiSub(id, 'pricing', 'PUT', { pricing: pricingModel });
    return ok({
      ok: true,
      id,
      type,
      features: pricingModel.features.length,
      tiers: pricingModel.tiers.length,
      highlights: pricingModel.highlights?.length ?? 0,
    });
  },
);

// ---------- granular pricing tools (one row per call) ----------

server.registerTool(
  'add_feature',
  {
    title: 'Add pricing feature',
    description:
      'Add a single pricing feature. `version` = the version label the feature is available from ' +
      '(omit for pre-existing features that predate versioning).',
    inputSchema: { id: z.string().describe('Timeline id.'), feature: pricingFeature },
  },
  async ({ id, feature }) => ok(await apiSub(id, 'feature', 'POST', feature)),
);

server.registerTool(
  'update_feature',
  {
    title: 'Update pricing feature',
    description:
      'Patch a feature by id (only provided fields change). Send an explicit null to clear an optional ' +
      'field (group / version / description).',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      featureId: z.string().describe('Id of the feature to patch.'),
      patch: pricingFeature.partial(),
    },
  },
  async ({ id, featureId, patch }) => ok(await apiSub(id, `feature/${encodeId(featureId)}`, 'PATCH', patch)),
);

server.registerTool(
  'delete_feature',
  {
    title: 'Delete pricing feature',
    description: 'Delete a feature by id. Its matrix cells cascade away and it is stripped from highlights.',
    inputSchema: { id: z.string().describe('Timeline id.'), featureId: z.string() },
  },
  async ({ id, featureId }) => ok(await apiSub(id, `feature/${encodeId(featureId)}`, 'DELETE')),
);

server.registerTool(
  'move_feature',
  {
    title: 'Reorder a pricing feature',
    description:
      'Reposition a feature in the matrix row order by placing it immediately after OR before another ' +
      'feature. Provide exactly one anchor (after / before); `after` wins if both are sent. The server ' +
      'renumbers the sort order and returns the new ordered id list. (add_feature always appends to the ' +
      'group end — use this to place it precisely afterwards.) A feature keeps its `group`; to change the ' +
      'group, patch it via update_feature.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      featureId: z.string().describe('Id of the feature to move.'),
      after: z.string().optional().describe('Place featureId immediately AFTER this feature id.'),
      before: z.string().optional().describe('Place featureId immediately BEFORE this feature id.'),
    },
  },
  async ({ id, featureId, after, before }) =>
    ok(await apiSub(id, 'feature-move', 'POST', { featureId, after, before })),
);

server.registerTool(
  'add_tier',
  {
    title: 'Add pricing tier',
    description: 'Add a single pricing tier. `values` maps featureId → true | "verbatim string".',
    inputSchema: { id: z.string().describe('Timeline id.'), tier: pricingTier },
  },
  async ({ id, tier }) => ok(await apiSub(id, 'tier', 'POST', tier)),
);

server.registerTool(
  'update_tier',
  {
    title: 'Update pricing tier',
    description:
      'Patch a tier by id (name / price / tagline / useCase / targetGroup). To set a single matrix ' +
      'cell prefer set_tier_value; `values` passed here are applied cell-by-cell.',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      tierId: z.string().describe('Id of the tier to patch.'),
      patch: pricingTier.partial(),
    },
  },
  async ({ id, tierId, patch }) => ok(await apiSub(id, `tier/${encodeId(tierId)}`, 'PATCH', patch)),
);

server.registerTool(
  'delete_tier',
  {
    title: 'Delete pricing tier',
    description: 'Delete a tier by id (its matrix cells cascade away).',
    inputSchema: { id: z.string().describe('Timeline id.'), tierId: z.string() },
  },
  async ({ id, tierId }) => ok(await apiSub(id, `tier/${encodeId(tierId)}`, 'DELETE')),
);

server.registerTool(
  'set_tier_value',
  {
    title: 'Set matrix cell',
    description:
      'Set ONE matrix cell (tier × feature). value = true (✓) or a verbatim string ("3.000"); ' +
      'value = false / null clears the cell (–). The collision-free way to edit the matrix. ' +
      'availableFrom (optional) = a version label (one of the timeline\'s pricing versions) from ' +
      'which this cell counts as included; before it the cell renders as "–" even when value is set. ' +
      'Omit / null = available from the start. Use it to model "included in tier X now, in tier Y only from v4".',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      tierId: z.string(),
      featureId: z.string(),
      value: z.union([z.string(), z.boolean(), z.null()]),
      availableFrom: z.string().nullish().describe('Version label the cell is available from (e.g. "4.0"); omit = from the start.'),
    },
  },
  async ({ id, tierId, featureId, value, availableFrom }) =>
    ok(await apiSub(id, 'tier-value', 'PUT', { tierId, featureId, value, availableFrom })),
);

server.registerTool(
  'add_highlight',
  {
    title: 'Add card highlight',
    description: 'Add a curated card highlight bundling one or more feature ids.',
    inputSchema: { id: z.string().describe('Timeline id.'), highlight: pricingHighlight },
  },
  async ({ id, highlight }) => ok(await apiSub(id, 'highlight', 'POST', highlight)),
);

server.registerTool(
  'update_highlight',
  {
    title: 'Update card highlight',
    description: 'Patch a highlight by id (label / section / icon / featureIds / description / labelByVersion).',
    inputSchema: {
      id: z.string().describe('Timeline id.'),
      highlightId: z.string(),
      patch: pricingHighlight.partial(),
    },
  },
  async ({ id, highlightId, patch }) => ok(await apiSub(id, `highlight/${encodeId(highlightId)}`, 'PATCH', patch)),
);

server.registerTool(
  'delete_highlight',
  {
    title: 'Delete card highlight',
    description: 'Delete a highlight by id.',
    inputSchema: { id: z.string().describe('Timeline id.'), highlightId: z.string() },
  },
  async ({ id, highlightId }) => ok(await apiSub(id, `highlight/${encodeId(highlightId)}`, 'DELETE')),
);

server.registerTool(
  'set_versions',
  {
    title: 'Set pricing versions',
    description:
      'Replace the ordered list of pricing version labels (e.g. ["1.0","2.0","3.0"]) — drives the ' +
      "matrix version switcher and features' available-from ordering.",
    inputSchema: { id: z.string().describe('Timeline id.'), versions: z.array(z.string()) },
  },
  async ({ id, versions }) => ok(await apiSub(id, 'pversion', 'PUT', { versions })),
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
        '(e.g. https://<site>.netlify.app) via env, ~/_AGENTS/.env, .env.local, ' +
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
