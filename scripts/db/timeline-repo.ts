// Data-access layer for Supabase-backed timelines.
//
// Runtime-agnostic: every function takes a supabase-js client, so the same code
// serves the Node Vite middleware, the import script, and the Deno edge function.
// Client creation (env cascade vs. Deno.env) lives in the callers.
//
// Item-level writes with an optimistic `version` check replace the old
// whole-sheet rewrite — concurrent edits on different items no longer clobber.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CustomFieldDef, TimelineFile, TimelineFileItem, TimelinePhase } from '../../src/types';

export type TimelineGroupDecl = {
  id: string;
  content: string;
  nestedGroups?: string[];
  showNested?: boolean;
};

export type TimelineMeta = { id: string; name?: string; description?: string };

export class ConflictError extends Error {
  constructor(message = 'version conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}
export class NotFoundError extends Error {
  constructor(message = 'not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

const ITEM_SELECT =
  'id, start, "end", duration, content, "group", type, title, body, icon, class_name, metadata, version, sort, created_at, created_by, updated_at, updated_by';

// ---- row <-> object mapping ------------------------------------------------

function rowToItem(row: Record<string, any>): TimelineFileItem {
  const item: TimelineFileItem = {
    id: row.id,
    content: row.content,
  };
  // `start` is optional now — a date-less item shows only in the list view.
  if (row.start != null) item.start = row.start;
  if (row.end != null) item.end = row.end;
  if (row.duration != null) item.duration = row.duration;
  if (row.group != null) item.group = row.group;
  if (row.type != null) item.type = row.type;
  if (row.title != null) item.title = row.title;
  if (row.body != null) item.body = row.body;
  if (row.icon != null) item.icon = row.icon;
  if (row.class_name != null) item.className = row.class_name;
  if (row.metadata && Object.keys(row.metadata).length > 0) item.metadata = row.metadata;
  if (row.version != null) item.version = row.version;
  // Server-managed audit fields (read-only; surfaced in the viewer's detail panel).
  if (row.created_at != null) item.createdAt = row.created_at;
  if (row.created_by != null) item.createdBy = row.created_by;
  if (row.updated_at != null) item.updatedAt = row.updated_at;
  if (row.updated_by != null) item.updatedBy = row.updated_by;
  return item;
}

/**
 * DB invariant: an item's extent is expressed by EITHER `end` OR `duration`,
 * never both. When both are present `end` wins — mirroring the render precedence
 * in `buildItems`. A row carrying both is the bug that silently shrank
 * `end`-based bars to a stale `duration` on the next edit. Callers assembling a
 * full item/row funnel through here; partial patches clear the counterpart
 * inline (see `updateItem`).
 */
export function enforceExtentExclusivity<T extends { end?: unknown; duration?: unknown }>(o: T): T {
  if (o.end != null) (o as { duration?: unknown }).duration = null;
  return o;
}

// Columns for insert/update. `sort` and `version` are managed here / by trigger.
function itemToRow(timelineId: string, item: TimelineFileItem, sort?: number): Record<string, any> {
  enforceExtentExclusivity(item);
  const row: Record<string, any> = {
    timeline_id: timelineId,
    id: item.id,
    start: item.start ?? null,
    end: item.end ?? null,
    duration: item.duration != null ? String(item.duration) : null,
    content: item.content,
    group: item.group ?? null,
    type: item.type ?? null,
    title: item.title ?? null,
    body: item.body ?? null,
    icon: item.icon ?? null,
    class_name: item.className ?? null,
    metadata: item.metadata ?? {},
  };
  if (sort != null) row.sort = sort;
  return row;
}

function rowToGroup(row: Record<string, any>): TimelineGroupDecl {
  const g: TimelineGroupDecl = { id: row.id, content: row.content ?? row.id };
  if (Array.isArray(row.nested_groups) && row.nested_groups.length) g.nestedGroups = row.nested_groups;
  if (row.show_nested != null) g.showNested = row.show_nested;
  return g;
}

function groupToRow(timelineId: string, g: TimelineGroupDecl, sort?: number): Record<string, any> {
  const row: Record<string, any> = {
    timeline_id: timelineId,
    id: g.id,
    content: g.content ?? null,
    nested_groups: g.nestedGroups ?? null,
    show_nested: g.showNested ?? null,
  };
  if (sort != null) row.sort = sort;
  return row;
}

// ---- reads -----------------------------------------------------------------

export async function listTimelines(db: SupabaseClient): Promise<TimelineMeta[]> {
  const { data, error } = await db.from('timelines').select('id, name, description').order('id');
  if (error) throw new Error(`listTimelines: ${error.message}`);
  return (data ?? []).map((r) => ({ id: r.id, name: r.name ?? undefined, description: r.description ?? undefined }));
}

export async function getTimeline(db: SupabaseClient, id: string): Promise<TimelineFile | null> {
  const { data: tl, error: tlErr } = await db
    .from('timelines')
    .select('id, name, description, group_by, phases, custom_fields')
    .eq('id', id)
    .maybeSingle();
  if (tlErr) throw new Error(`getTimeline: ${tlErr.message}`);
  if (!tl) return null;

  const { data: itemRows, error: itemErr } = await db
    .from('timeline_items')
    .select(ITEM_SELECT)
    .eq('timeline_id', id)
    .order('sort', { ascending: true, nullsFirst: true });
  if (itemErr) throw new Error(`getTimeline items: ${itemErr.message}`);

  const { data: groupRows, error: grpErr } = await db
    .from('timeline_groups')
    .select('id, content, nested_groups, show_nested, sort')
    .eq('timeline_id', id)
    .order('sort', { ascending: true, nullsFirst: true });
  if (grpErr) throw new Error(`getTimeline groups: ${grpErr.message}`);

  const file: TimelineFile = { items: (itemRows ?? []).map(rowToItem) };
  if (tl.name != null) file.name = tl.name;
  if (tl.description != null) file.description = tl.description;
  if (tl.group_by != null) file.groupBy = tl.group_by;
  if (Array.isArray(tl.phases) && tl.phases.length) file.phases = tl.phases as TimelinePhase[];
  if (Array.isArray(tl.custom_fields) && tl.custom_fields.length)
    file.customFields = tl.custom_fields as CustomFieldDef[];
  if (groupRows && groupRows.length) file.groups = groupRows.map(rowToGroup);
  return file;
}

// ---- whole-timeline replace (import, MCP bulk, PUT fallback) ---------------

export async function replaceTimeline(db: SupabaseClient, id: string, file: TimelineFile): Promise<void> {
  const { error: upErr } = await db.from('timelines').upsert({
    id,
    name: file.name ?? null,
    description: file.description ?? null,
    group_by: file.groupBy ?? null,
    phases: file.phases ?? [],
    custom_fields: file.customFields ?? [],
    updated_at: new Date().toISOString(),
  });
  if (upErr) throw new Error(`replaceTimeline meta: ${upErr.message}`);

  // Clear children, then re-insert (cascade-free explicit wipe keeps it simple).
  const del1 = await db.from('timeline_items').delete().eq('timeline_id', id);
  if (del1.error) throw new Error(`replaceTimeline clear items: ${del1.error.message}`);
  const del2 = await db.from('timeline_groups').delete().eq('timeline_id', id);
  if (del2.error) throw new Error(`replaceTimeline clear groups: ${del2.error.message}`);

  const itemRows = file.items
    // `start` is optional: a list-created item can exist without a date yet.
    .filter((it) => it.id && it.content)
    .map((it, i) => itemToRow(id, it, i));
  if (itemRows.length) {
    const ins = await db.from('timeline_items').insert(itemRows);
    if (ins.error) throw new Error(`replaceTimeline insert items: ${ins.error.message}`);
  }

  const groupRows = (file.groups ?? []).map((g, i) => groupToRow(id, g, i));
  if (groupRows.length) {
    const ins = await db.from('timeline_groups').insert(groupRows);
    if (ins.error) throw new Error(`replaceTimeline insert groups: ${ins.error.message}`);
  }
}

// ---- item-level writes (the concurrency fix) -------------------------------

async function nextSort(db: SupabaseClient, timelineId: string): Promise<number> {
  const { data } = await db
    .from('timeline_items')
    .select('sort')
    .eq('timeline_id', timelineId)
    .order('sort', { ascending: false, nullsFirst: false })
    .limit(1);
  const top = data?.[0]?.sort;
  return typeof top === 'number' ? top + 1 : 0;
}

/** Insert a new item. Fails if the id already exists. */
export async function addItem(
  db: SupabaseClient,
  timelineId: string,
  item: TimelineFileItem,
  updatedBy?: string,
): Promise<TimelineFileItem> {
  const row = itemToRow(timelineId, item, await nextSort(db, timelineId));
  if (updatedBy) {
    row.updated_by = updatedBy;
    row.created_by = updatedBy; // attribute the creation to the same actor
  }
  const { data, error } = await db.from('timeline_items').insert(row).select(ITEM_SELECT).single();
  if (error) throw new Error(`addItem: ${error.message}`);
  return rowToItem(data);
}

/**
 * Patch an existing item. When `expectedVersion` is given, the update only
 * applies if the stored version still matches — otherwise ConflictError, so a
 * concurrent editor's change is never silently overwritten.
 */
export async function updateItem(
  db: SupabaseClient,
  timelineId: string,
  itemId: string,
  patch: Partial<TimelineFileItem>,
  expectedVersion?: number,
  updatedBy?: string,
): Promise<TimelineFileItem> {
  // Build the column patch from provided fields only.
  const full = itemToRow(timelineId, { ...(patch as TimelineFileItem), id: itemId } as TimelineFileItem);
  const set: Record<string, any> = {};
  const map: Record<keyof TimelineFileItem | string, string> = {
    start: 'start', end: 'end', duration: 'duration', content: 'content', group: 'group',
    type: 'type', title: 'title', body: 'body', icon: 'icon', className: 'class_name', metadata: 'metadata',
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) set[col] = full[col];
  }
  // Keep the extent columns mutually exclusive across a *partial* patch: setting
  // one clears the stored other (end wins when both are asserted), so a row can
  // never keep both. This also lets a caller switch an end-based item to
  // duration by sending `duration` alone (the stale `end` column is cleared).
  if (set.end != null) set.duration = null;
  else if (set.duration != null) set.end = null;
  if (updatedBy) set.updated_by = updatedBy;
  if (Object.keys(set).length === 0) {
    const cur = await getItem(db, timelineId, itemId);
    if (!cur) throw new NotFoundError();
    return cur;
  }

  let q = db.from('timeline_items').update(set).eq('timeline_id', timelineId).eq('id', itemId);
  if (expectedVersion != null) q = q.eq('version', expectedVersion);
  const { data, error } = await q.select(ITEM_SELECT);
  if (error) throw new Error(`updateItem: ${error.message}`);
  if (!data || data.length === 0) {
    // Either the row is gone or the version moved on.
    const exists = await getItem(db, timelineId, itemId);
    if (!exists) throw new NotFoundError();
    throw new ConflictError(`item ${itemId} changed since version ${expectedVersion}`);
  }
  return rowToItem(data[0]);
}

export async function getItem(
  db: SupabaseClient,
  timelineId: string,
  itemId: string,
): Promise<TimelineFileItem | null> {
  const { data, error } = await db
    .from('timeline_items')
    .select(ITEM_SELECT)
    .eq('timeline_id', timelineId)
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw new Error(`getItem: ${error.message}`);
  return data ? rowToItem(data) : null;
}

export async function deleteItem(db: SupabaseClient, timelineId: string, itemId: string): Promise<void> {
  const { error } = await db.from('timeline_items').delete().eq('timeline_id', timelineId).eq('id', itemId);
  if (error) throw new Error(`deleteItem: ${error.message}`);
}

// ---- group writes ----------------------------------------------------------

export async function upsertGroup(
  db: SupabaseClient,
  timelineId: string,
  group: TimelineGroupDecl,
): Promise<TimelineGroupDecl> {
  const { data, error } = await db
    .from('timeline_groups')
    .upsert(groupToRow(timelineId, group))
    .select('id, content, nested_groups, show_nested, sort')
    .single();
  if (error) throw new Error(`upsertGroup: ${error.message}`);
  return rowToGroup(data);
}

export async function deleteGroup(db: SupabaseClient, timelineId: string, groupId: string): Promise<void> {
  const { error } = await db.from('timeline_groups').delete().eq('timeline_id', timelineId).eq('id', groupId);
  if (error) throw new Error(`deleteGroup: ${error.message}`);
}

// ---- timeline-level meta / phases ------------------------------------------

export async function updatePhases(db: SupabaseClient, id: string, phases: TimelinePhase[]): Promise<void> {
  const { error } = await db
    .from('timelines')
    .update({ phases: phases ?? [], updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`updatePhases: ${error.message}`);
}

export async function updateMeta(
  db: SupabaseClient,
  id: string,
  meta: { name?: string; description?: string; groupBy?: string; customFields?: CustomFieldDef[] },
): Promise<void> {
  const set: Record<string, any> = { updated_at: new Date().toISOString() };
  if ('name' in meta) set.name = meta.name ?? null;
  if ('description' in meta) set.description = meta.description ?? null;
  if ('groupBy' in meta) set.group_by = meta.groupBy ?? null;
  // Custom-field definitions are patched as a unit (like phases). Absent key =
  // leave untouched, so a plain name/description edit never clears them.
  if ('customFields' in meta) set.custom_fields = meta.customFields ?? [];
  const { error } = await db.from('timelines').update(set).eq('id', id);
  if (error) throw new Error(`updateMeta: ${error.message}`);
}
