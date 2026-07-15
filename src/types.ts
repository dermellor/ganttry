import type { StatusKey } from './status';

export type Note = {
  id: string;
  path: string;
  filename: string;
  folder: string;
  title: string;
  start: string | null;
  end: string | null;
  dateSource: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
};

export type NotesData = {
  generatedAt: string;
  count: number;
  notes: Note[];
};

export type FilterClause = {
  filenameContains?: string;
  folder?: string | string[];
  status?: string | string[];
  categories?: string | string[];
  tags?: string | string[];
  draft?: boolean;
  has?: string | string[];
  anyOf?: FilterClause[];
  allOf?: FilterClause[];
  not?: FilterClause;
};

export type ViewSource = { type: 'json'; id: string };

export type View = {
  id: string;
  name: string;
  description?: string;
  filter: FilterClause;
  dateFields?: string[];
  groupBy?: string;
  colorBy?: string;
  source?: ViewSource;
};

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
  icon?: string;
  status?: StatusKey; // built-in item status (Open/Doing/Done); defaults to Open
  body?: string;
  metadata?: Record<string, unknown>;
  version?: number; // DB row version for optimistic locking (server-managed)
  // Server-managed audit fields (read-only). ISO timestamps + attribution.
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
};

export type TimelinePhase = {
  id?: string;
  label: string;
  start: string;
  end?: string;
  duration?: string | number;
  color?: string;
  icon?: string;
};

// Per-timeline custom fields. The *definitions* are timeline-level config
// (stored on the timeline row, like `phases`); a field's *value* lives per item
// in `metadata[key]` — a string for `text`/`select`, a string[] for
// `multi-select`. Configuration is backend-side for now (no in-app editor for
// the definitions); they're seeded via the DB / MCP `set_custom_fields`.
export type CustomFieldType = 'text' | 'select' | 'multi-select';

export type CustomFieldOption = {
  value: string;
  label?: string;
  // Optional pill colour (hex), used for select / multi-select chips.
  color?: string;
};

export type CustomFieldDef = {
  key: string;
  label: string;
  type: CustomFieldType;
  // Allowed choices for `select` / `multi-select`. Ignored for `text`.
  options?: CustomFieldOption[];
};

export type TimelineFile = {
  name?: string;
  description?: string;
  groupBy?: string;
  phases?: TimelinePhase[];
  customFields?: CustomFieldDef[];
  items: TimelineFileItem[];
  groups?: {
    id: string;
    content: string;
    nestedGroups?: string[];
    showNested?: boolean;
  }[];
};

export type Config = {
  notesDir: string;
  defaultView: string;
  dateFields: string[];
  filenameDatePatterns: string[];
  views: View[];
};
