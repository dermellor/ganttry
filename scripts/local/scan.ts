// Turn a directory of Markdown files into a `TimelineFile`.
//
// This is the second shape a local source can have (see
// [`docs/local-sources.md`](../../docs/local-sources.md)): a JSON file is a
// timeline with its items inline, a directory is a timeline with one file per
// item. Both produce the same `TimelineFile`, which is what lets everything
// downstream — the build, the adapter, the client — stay unaware of which one it
// is dealing with.
//
// Two callers need this and neither may reimplement it („Conventions → A rule
// lives in exactly one place"): `build-data.ts` materializes the result for a
// static build, and the local adapter produces it per request so an edit does
// not need a rebuild.

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import matter from 'gray-matter';

import type { TimelineFile, TimelineFileItem } from '../../src/types';

/** The container file that carries a directory's timeline-level data. */
export const CONTAINER_FILE = 'timeline.json';

export type ScanOptions = {
  /** Frontmatter keys tried in order for an item's start. */
  dateFields?: string[];
  /** Regexes tried against the filename when no frontmatter date is found. */
  filenameDatePatterns?: string[];
};

const DEFAULT_DATE_FIELDS = ['date', 'scheduled', 'created'];
const DEFAULT_FILENAME_PATTERNS = ['^(\\d{4})-(\\d{2})-(\\d{2})', '^(\\d{4})(\\d{2})(\\d{2})'];

/**
 * Where an item's start came from, recorded on every item.
 *
 * It is what makes a later write path possible at all: „the user just dragged
 * this bar, which frontmatter key do I patch?" has no answer unless the read
 * path wrote the answer down. `__filename__` marks a date that came from the
 * filename and therefore has no key yet — writing one promotes it, because the
 * cascade tries frontmatter before the filename.
 */
export const DATE_SOURCE_KEY = 'dateSource';
export const FILENAME_DATE_SOURCE = '__filename__';

// ---------------------------------------------------------------------------
// dates
//
// Moved here from build-data.ts rather than copied: the scanner is now the only
// thing that extracts a date out of a Markdown file.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A frontmatter date as the timeline file format writes it.
 *
 * **A day stays a day.** `date: 2026-04-15` becomes the string `"2026-04-15"`,
 * not an instant. Converting it to a timestamp picks a timezone the note never
 * stated, and the old notes pipeline did exactly that: the 15th came out as
 * `2026-04-14T22:00:00.000Z` in summer time, which is the same moment but reads
 * as the wrong day everywhere it is displayed as text, and a write path would
 * put that timestamp back into a file that used to say `2026-04-15`.
 *
 * It also makes a Markdown item and a JSON item carry the same shape, which is
 * the point of both becoming a `TimelineFile`.
 *
 * A value that genuinely carries a time keeps it.
 */
function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  // YAML parses an unquoted `2026-04-15` into a Date at UTC midnight, so a
  // zero UTC time-of-day is how a date-only value arrives here.
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 &&
      value.getUTCMilliseconds() === 0
      ? value.toISOString().slice(0, 10)
      : value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    if (DATE_ONLY.test(s)) return s;
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function pickDate(fm: Record<string, unknown>, fields: string[]): { iso: string; field: string } | null {
  for (const field of fields) {
    const iso = toIsoDate(fm[field]);
    if (iso) return { iso, field };
  }
  return null;
}

function dateFromFilename(filename: string, patterns: string[]): string | null {
  const stem = basename(filename, extname(filename));
  for (const p of patterns) {
    const m = stem.match(new RegExp(p));
    if (m?.[1] && m[2] && m[3]) {
      const day = `${m[1]}-${m[2]}-${m[3]}`;
      // Validated by round-trip rather than by regex: `2026-02-31` matches the
      // pattern and is not a date.
      const d = new Date(`${day}T00:00:00Z`);
      if (!isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day) return day;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

async function* walkMarkdown(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Dot-directories are the tool's own business, not the user's content:
    // `.trash` (Obsidian's recycle bin), `.git`, `.obsidian`. Scanning them
    // resurrects deleted notes as items, which reads as data coming back.
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(full);
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') yield full;
  }
}

/** Read the directory's container file, if it has one. */
async function readContainer(dir: string): Promise<Partial<TimelineFile>> {
  const path = join(dir, CONTAINER_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<TimelineFile>;
    // `items` in a container file is ignored rather than merged: the directory's
    // Markdown files ARE the items, and honouring both would make the same
    // timeline say two different things depending on which half you read.
    const { items: _ignored, ...rest } = parsed;
    return rest;
  } catch {
    // A malformed container costs the timeline its groups and phases, not its
    // items. Failing the whole scan would make one typo hide every note.
    return {};
  }
}

/**
 * One Markdown file as an item.
 *
 * Everything the frontmatter carries stays on `metadata`, including the keys
 * consumed here. Dropping them would make the item a lossy copy of the file, and
 * a later write path could not put back what it never saw.
 */
function itemFromNote(
  rel: string,
  fm: Record<string, unknown>,
  body: string,
  opts: Required<ScanOptions>,
): TimelineFileItem | null {
  const filename = basename(rel);
  const fmDate = pickDate(fm, opts.dateFields);
  let start = fmDate?.iso ?? null;
  let dateSource = fmDate?.field ?? null;
  if (!start) {
    const fromName = dateFromFilename(filename, opts.filenameDatePatterns);
    if (fromName) {
      start = fromName;
      dateSource = FILENAME_DATE_SOURCE;
    }
  }

  const title =
    (typeof fm.title === 'string' && fm.title.trim()) || basename(rel, extname(rel));
  if (!title) return null;

  const end = pickDate(fm, ['end', 'end_date', 'until'])?.iso;
  const item: TimelineFileItem = {
    // An explicit frontmatter id wins over the path so that a rename does not
    // break a `dependsOn` pointing at this note. Otherwise the path without its
    // extension is the handle: `.md` carries no information (every item here is
    // a Markdown file) and it only makes the id noisier in a URL.
    id: typeof fm.id === 'string' && fm.id.trim() ? fm.id.trim() : rel.slice(0, -extname(rel).length),
    content: title,
    metadata: { ...fm, path: rel, filename, [DATE_SOURCE_KEY]: dateSource },
  };
  // A date-less note is kept: it shows in the list view and the timeline view
  // filters it out on its own. Skipping it here would make notes silently
  // disappear from a source that is supposed to show the directory.
  if (start) item.start = start;
  if (end) item.end = end;
  if (typeof fm.duration === 'string' || typeof fm.duration === 'number') item.duration = fm.duration;
  if (typeof fm.group === 'string') item.group = fm.group;
  if (typeof fm.icon === 'string') item.icon = fm.icon;
  if (typeof fm.status === 'string') item.status = fm.status as TimelineFileItem['status'];
  if (fm.type === 'point' || fm.type === 'range' || fm.type === 'background' || fm.type === 'box') {
    item.type = fm.type;
  }
  if (body.trim()) item.body = body;
  return item;
}

/** Is this directory a local timeline source? */
export function isTimelineDirectory(dir: string): boolean {
  return existsSync(join(dir, CONTAINER_FILE));
}

/**
 * Every timeline directory under `root`, deepest-first-safe: a directory that
 * declares itself a timeline is not descended into, so a container file nested
 * inside another timeline's folder cannot split one timeline into two.
 */
export async function timelineDirectories(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (isTimelineDirectory(full)) found.push(full);
      else await visit(full);
    }
  }
  await visit(root);
  return found.sort();
}

/**
 * Scan a directory into a `TimelineFile`. Items come from the Markdown files,
 * everything above item level from the optional container file.
 */
export async function scanDirectory(dir: string, opts: ScanOptions = {}): Promise<TimelineFile> {
  const resolved: Required<ScanOptions> = {
    dateFields: opts.dateFields ?? DEFAULT_DATE_FIELDS,
    filenameDatePatterns: opts.filenameDatePatterns ?? DEFAULT_FILENAME_PATTERNS,
  };
  const container = await readContainer(dir);
  const items: TimelineFileItem[] = [];

  for await (const path of walkMarkdown(dir)) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch {
      continue; // one unparseable file must not take the directory down
    }
    const rel = relative(dir, path).replace(/\\/g, '/');
    const item = itemFromNote(rel, (parsed.data ?? {}) as Record<string, unknown>, parsed.content, resolved);
    if (item) items.push(item);
  }

  items.sort((a, b) => {
    // Date-less items last, then by start, then by id — a stable order so a
    // rescan does not reshuffle the list view under the reader.
    if (!a.start && !b.start) return a.id! < b.id! ? -1 : 1;
    if (!a.start) return 1;
    if (!b.start) return -1;
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    return a.id! < b.id! ? -1 : 1;
  });

  return { name: basename(dir), ...container, items };
}

/** Newest mtime across the directory: the watermark for a directory source. */
export async function directoryVersion(dir: string): Promise<number> {
  let newest = 0;
  const container = join(dir, CONTAINER_FILE);
  if (existsSync(container)) {
    newest = Math.max(newest, (await stat(container)).mtimeMs);
  }
  for await (const path of walkMarkdown(dir)) {
    try {
      newest = Math.max(newest, (await stat(path)).mtimeMs);
    } catch {
      /* vanished mid-scan */
    }
  }
  return Math.floor(newest);
}
