export type TimelineFileItem = {
  id?: string;
  start: string;
  end?: string;
  duration?: string | number;
  content: string;
  group?: string;
  title?: string;
  type?: 'point' | 'range' | 'background' | 'box';
  className?: string;
  body?: string;
  metadata?: Record<string, unknown>;
};

export type TimelineGroupDecl = {
  id: string;
  content: string;
  nestedGroups?: string[];
  showNested?: boolean;
};

export type TimelineFile = {
  name?: string;
  description?: string;
  groupBy?: string;
  items: TimelineFileItem[];
  groups?: TimelineGroupDecl[];
};

export const ITEM_COLUMNS = [
  'id',
  'start',
  'end',
  'duration',
  'content',
  'group',
  'type',
  'title',
  'body',
  'dependsOn',
  'owner',
  'className',
  'metadata',
] as const;

export type ItemColumn = (typeof ITEM_COLUMNS)[number];

export const GROUP_COLUMNS = ['id', 'content', 'nestedGroups', 'showNested'] as const;

export type GroupColumn = (typeof GROUP_COLUMNS)[number];

export function indexHeaders<T extends string>(
  headers: string[],
  known: readonly T[],
): Map<T, number> {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const out = new Map<T, number>();
  for (const col of known) {
    const idx = norm.indexOf(col.toLowerCase());
    if (idx !== -1) out.set(col, idx);
  }
  return out;
}

function readCell(row: string[], idx: number | undefined): string {
  if (idx == null) return '';
  return (row[idx] ?? '').toString();
}

function parseDependsOn(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseMetadata(raw: string): Record<string, unknown> {
  const s = raw.trim();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

function parseShowNested(raw: string): boolean | undefined {
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'true' || s === '1' || s === 'yes' || s === 'ja') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'nein') return false;
  return undefined;
}

export function rowToItem(row: string[], idx: Map<ItemColumn, number>): TimelineFileItem | null {
  const start = readCell(row, idx.get('start')).trim();
  const content = readCell(row, idx.get('content')).trim();
  if (!start || !content) return null;

  const item: TimelineFileItem = { start, content };

  const id = readCell(row, idx.get('id')).trim();
  if (id) item.id = id;

  const end = readCell(row, idx.get('end')).trim();
  if (end) item.end = end;

  const duration = readCell(row, idx.get('duration')).trim();
  if (duration) item.duration = duration;

  const group = readCell(row, idx.get('group')).trim();
  if (group) item.group = group;

  const type = readCell(row, idx.get('type')).trim();
  if (type === 'point' || type === 'range' || type === 'background' || type === 'box') {
    item.type = type;
  }

  const title = readCell(row, idx.get('title')).trim();
  if (title) item.title = title;

  const body = readCell(row, idx.get('body'));
  if (body.trim()) item.body = body;

  const className = readCell(row, idx.get('className')).trim();
  if (className) item.className = className;

  const meta: Record<string, unknown> = {};
  Object.assign(meta, parseMetadata(readCell(row, idx.get('metadata'))));

  const owner = readCell(row, idx.get('owner')).trim();
  if (owner) meta.owner = owner;

  const deps = parseDependsOn(readCell(row, idx.get('dependsOn')));
  if (deps.length) meta.dependsOn = deps;

  if (Object.keys(meta).length > 0) item.metadata = meta;

  return item;
}

export function rowToGroup(row: string[], idx: Map<GroupColumn, number>): TimelineGroupDecl | null {
  const id = readCell(row, idx.get('id')).trim();
  const content = readCell(row, idx.get('content')).trim();
  if (!id) return null;
  const group: TimelineGroupDecl = { id, content: content || id };

  const nested = readCell(row, idx.get('nestedGroups'));
  const nestedIds = parseDependsOn(nested);
  if (nestedIds.length) group.nestedGroups = nestedIds;

  const showNested = parseShowNested(readCell(row, idx.get('showNested')));
  if (showNested != null) group.showNested = showNested;

  return group;
}

export function itemToRow(item: TimelineFileItem): string[] {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const dependsOn = Array.isArray(meta.dependsOn)
    ? (meta.dependsOn as unknown[]).map(String).join(', ')
    : '';
  const owner = typeof meta.owner === 'string' ? meta.owner : '';
  const otherMeta = Object.fromEntries(
    Object.entries(meta).filter(([k]) => k !== 'dependsOn' && k !== 'owner'),
  );
  const metaJson = Object.keys(otherMeta).length ? JSON.stringify(otherMeta) : '';

  const cell = (v: string | number | undefined): string =>
    v == null ? '' : typeof v === 'number' ? String(v) : v;

  return [
    cell(item.id),
    cell(item.start),
    cell(item.end),
    cell(item.duration),
    cell(item.content),
    cell(item.group),
    cell(item.type),
    cell(item.title),
    cell(item.body),
    dependsOn,
    owner,
    cell(item.className),
    metaJson,
  ];
}

export function groupToRow(group: TimelineGroupDecl): string[] {
  return [
    group.id,
    group.content,
    Array.isArray(group.nestedGroups) ? group.nestedGroups.join(', ') : '',
    group.showNested == null ? '' : group.showNested ? 'true' : 'false',
  ];
}

export function rowsToTimelineFile(
  itemRows: string[][],
  groupRows: string[][] | null,
  meta?: { name?: string; description?: string; groupBy?: string },
): TimelineFile {
  if (itemRows.length === 0) {
    throw new Error('Items sheet is empty (need at least a header row)');
  }
  const itemIdx = indexHeaders(itemRows[0], ITEM_COLUMNS);
  if (!itemIdx.has('start') || !itemIdx.has('content')) {
    throw new Error('Items sheet is missing required columns "start" and/or "content"');
  }
  const items: TimelineFileItem[] = [];
  for (let i = 1; i < itemRows.length; i++) {
    const it = rowToItem(itemRows[i], itemIdx);
    if (it) items.push(it);
  }

  let groups: TimelineGroupDecl[] | undefined;
  if (groupRows && groupRows.length > 1) {
    const groupIdx = indexHeaders(groupRows[0], GROUP_COLUMNS);
    const out: TimelineGroupDecl[] = [];
    for (let i = 1; i < groupRows.length; i++) {
      const g = rowToGroup(groupRows[i], groupIdx);
      if (g) out.push(g);
    }
    if (out.length > 0) groups = out;
  }

  const file: TimelineFile = { items };
  if (meta?.name) file.name = meta.name;
  if (meta?.description) file.description = meta.description;
  if (meta?.groupBy) file.groupBy = meta.groupBy;
  if (groups) file.groups = groups;
  return file;
}

export function timelineFileToRows(file: TimelineFile): {
  itemRows: string[][];
  groupRows: string[][] | null;
} {
  const itemHeader = [...ITEM_COLUMNS] as string[];
  const itemRows = [itemHeader, ...file.items.map(itemToRow)];

  let groupRows: string[][] | null = null;
  if (file.groups && file.groups.length > 0) {
    const groupHeader = [...GROUP_COLUMNS] as string[];
    groupRows = [groupHeader, ...file.groups.map(groupToRow)];
  }

  return { itemRows, groupRows };
}
