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
  body?: string;
  metadata?: Record<string, unknown>;
};

export type TimelineFile = {
  name?: string;
  description?: string;
  groupBy?: string;
  items: TimelineFileItem[];
  groups?: { id: string; content: string }[];
};

export type Config = {
  notesDir: string;
  defaultView: string;
  dateFields: string[];
  filenameDatePatterns: string[];
  views: View[];
};
