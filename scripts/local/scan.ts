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

import type {
  ItemLink,
  ScanConfig,
  TimelineContainer,
  TimelineFile,
  TimelineFileItem,
} from '../../src/types';

/** The container file that carries a directory's timeline-level data. */
export const CONTAINER_FILE = 'timeline.json';

/**
 * How a directory is read. Identical to the `scan` block a container file may
 * carry, because the container is where a folder declares this for itself; a
 * caller's options are the fallback for a folder that does not
 * (`resolveScan` below decides).
 */
export type ScanOptions = ScanConfig;

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
async function readContainer(dir: string): Promise<Partial<TimelineContainer>> {
  const path = join(dir, CONTAINER_FILE);
  if (!existsSync(path)) return {};
  try {
    // Typed as „container plus maybe items" rather than as the container: the type
    // says a container has none, and this is the runtime that has to cope with a
    // hand-written file that does.
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<TimelineContainer> & {
      items?: unknown;
    };
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
  // An explicit frontmatter group wins. Derived from the folder only when the
  // note names none, so turning the option on cannot move a note that already
  // said where it belongs.
  if (typeof fm.group === 'string') item.group = fm.group;
  else if (opts.groupFromFolder) {
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    if (folder) item.group = folder;
  }
  if (typeof fm.icon === 'string') item.icon = fm.icon;
  if (typeof fm.status === 'string') item.status = fm.status as TimelineFileItem['status'];
  if (fm.type === 'point' || fm.type === 'range' || fm.type === 'background' || fm.type === 'box') {
    item.type = fm.type;
  }
  if (body.trim()) item.body = body;
  return item;
}

// ---------------------------------------------------------------------------
// wikilinks as relations
//
// A folder of notes already carries its structure, in the links the author wrote
// while writing. `linkEdges` reads those as relations so a graph has something to
// draw without anybody maintaining a second, parallel list of edges by hand — the
// list that would be wrong within a week.

const WIKILINK = /\[\[([^\]]+)\]\]/g;
const CODE_FENCE = /```[\s\S]*?```/g;

/**
 * Normalise a link target or a note title for matching.
 *
 * Obsidian is forgiving about the punctuation an author actually typed, and a
 * vault accumulates both spellings of every quote. Matching the raw strings makes
 * an edge silently vanish because the link says `Finn's` and the filename says
 * `Finn’s` — a missing line with no error anywhere, which is the worst shape a bug
 * can take in a picture.
 */
function normalizeLinkKey(value: string): string {
  return value
    .trim()
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e]/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Every wikilink target in a string, stripped of alias and anchor. */
function wikilinkTargets(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    // `[[Path/To/Note#Heading|Alias]]` → `Path/To/Note`
    const target = match[1].split('|')[0].split('#')[0].trim();
    if (target) out.push(target);
  }
  return out;
}

/** Wikilinks anywhere in a frontmatter value, however deeply nested. */
function wikilinksInValue(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    into.push(...wikilinkTargets(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) wikilinksInValue(entry, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) wikilinksInValue(entry, into);
  }
}

/**
 * Turn a wikilink target into the id of the item it names, or nothing.
 *
 * Two lookups, because a vault links both ways: by bare title (`[[Angebot von
 * Talheim]]`, how a note in the same vault is normally referenced) and by path
 * (`[[Fiction/Book/_Hints/Angebot|Angebot]]`, what Obsidian writes when the title
 * is ambiguous). The basename of a path is tried too, which is what makes a link
 * written from elsewhere in the vault still land.
 *
 * One resolver for both readers of links — the relations and the order file — so
 * that a link the graph draws an edge for and the same link in a table of contents
 * cannot disagree about which note they mean („Conventions → A rule lives in
 * exactly one place").
 */
function linkResolver(items: TimelineFileItem[]): (raw: string) => string | undefined {
  const byTitle = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const item of items) {
    const id = item.id!;
    const path = String((item.metadata as Record<string, unknown>)?.path ?? id);
    const stem = path.replace(/\.md$/i, '');
    byPath.set(normalizeLinkKey(stem), id);
    // First writer wins for a title, so an ambiguous title resolves to the same
    // item on every scan rather than to whichever file the walk reached last.
    const title = stem.includes('/') ? stem.slice(stem.lastIndexOf('/') + 1) : stem;
    if (!byTitle.has(normalizeLinkKey(title))) byTitle.set(normalizeLinkKey(title), id);
  }
  return (raw: string): string | undefined => {
    const key = normalizeLinkKey(raw.replace(/\.md$/i, ''));
    const byFullPath = byPath.get(key);
    if (byFullPath) return byFullPath;
    const base = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
    return byTitle.get(base);
  };
}

/**
 * Resolve every note's wikilinks to item ids and record them twice: flattened on
 * `metadata.dependsOn`, and one entry per link with its frontmatter key on
 * `metadata.wikilinks`.
 *
 * `dependsOn` and not a key of its own: it is the relation the rest of the app
 * already understands — the Gantt arrows and the graph both read it — and a second
 * edge key would have to be taught to each of them.
 *
 * `wikilinks` beside it because `dependsOn` cannot say where a link came from, and
 * that is what decides its direction: a frontmatter key meaning „these lead to me"
 * points the opposite way from a link written mid-sentence, and flattening both
 * onto one key with one direction silently reverses half of them. The scanner
 * still records no opinion about which is which — it keeps the field name so that
 * whoever draws the edges can have one.
 */
function linkItems(items: TimelineFileItem[], bodies: Map<string, string>): void {
  const resolveTarget = linkResolver(items);

  for (const item of items) {
    // Per top-level frontmatter key rather than over the whole object at once,
    // because the key is the half `dependsOn` throws away. Nested values still
    // report the key they hang under: „which field links this" is a statement
    // about the field, and a sub-key of one is not a field of its own.
    const found: { field: string | null; raw: string }[] = [];
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    for (const [field, value] of Object.entries(meta)) {
      const raw: string[] = [];
      wikilinksInValue(value, raw);
      for (const link of raw) found.push({ field, raw: link });
    }
    const body = bodies.get(item.id!);
    // Fenced code is quoted text, not a reference: a snippet showing `[[Foo]]`
    // would otherwise become an edge.
    if (body) {
      for (const link of wikilinkTargets(body.replace(CODE_FENCE, ''))) {
        found.push({ field: null, raw: link });
      }
    }

    const seen = new Set<string>();
    const seenPerField = new Set<string>();
    const targets: string[] = [];
    const links: ItemLink[] = [];
    for (const { field, raw } of found) {
      const id = resolveTarget(raw);
      // A link to something outside this folder resolves to nothing and is
      // dropped rather than recorded: a dangling id would draw an edge to a node
      // that does not exist, and every consumer would have to filter it again.
      if (!id || id === item.id) continue;
      // One entry per field per target: a field naming the same note twice is one
      // relation, while two fields naming it are two — that second case is the
      // whole point of keeping the field, so deduplicating by target alone would
      // throw the answer away again.
      const pair = `${field ?? ''}␟${id}`;
      if (!seenPerField.has(pair)) {
        seenPerField.add(pair);
        links.push({ field, target: id });
      }
      if (seen.has(id)) continue;
      seen.add(id);
      targets.push(id);
    }
    if (targets.length) {
      meta.dependsOn = targets;
      meta.wikilinks = links;
    }
  }
}

// ---------------------------------------------------------------------------
// the order file
//
// A folder of notes carries no order of its own. `orderFrom` names a file in it
// whose wikilinks, read top to bottom, are that order — the table of contents a
// folder that has an order almost always already keeps by hand.

/** The metadata key the order file writes: the item's 1-based position. */
export const SEQUENCE_KEY = 'sequence';

/**
 * Stamp `metadata.sequence` on every item the order file names, in the order it
 * names them.
 *
 * Deliberately blind to markdown structure: every wikilink in the document
 * counts, whatever list depth or heading it sits on. A vault's nesting means
 * something to its author and nothing to a scanner, so reading it would be
 * guessing — while „where in the file the author wrote this link" is a fact.
 * The side effect is the useful one: a heading that names a note (`## [[Part]]`)
 * lands just ahead of the notes listed under it, which is where a container of
 * them belongs.
 *
 * The first mention wins, so a note listed again later keeps the position it
 * first had rather than being pushed to the end by a cross-reference.
 *
 * Frontmatter is skipped because it is the editor's bookkeeping rather than the
 * document, and fenced code because it is quotation — the same reading `linkItems`
 * takes of a note's body.
 */
async function sequenceItems(
  dir: string,
  orderFrom: string,
  items: TimelineFileItem[],
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(dir, orderFrom), 'utf8');
  } catch {
    // A named-but-missing order file leaves every item unpositioned rather than
    // failing the scan: the folder still has notes, and they are still worth
    // showing without the order they were going to be shown in.
    return;
  }
  let body: string;
  try {
    body = matter(raw).content;
  } catch {
    body = raw;
  }
  const resolveTarget = linkResolver(items);
  const byId = new Map(items.map((item) => [item.id!, item]));
  let position = 0;
  const placed = new Set<string>();
  for (const link of wikilinkTargets(body.replace(CODE_FENCE, ''))) {
    const id = resolveTarget(link);
    // A link out of the folder names nothing here and takes no position with it:
    // counting it would leave gaps that read as items somebody deleted.
    if (!id || placed.has(id)) continue;
    const item = byId.get(id);
    if (!item) continue;
    placed.add(id);
    position += 1;
    (item.metadata ??= {})[SEQUENCE_KEY] = position;
  }
}

/**
 * The effective scan settings: what the folder declares wins over what the caller
 * passed. The folder is the more specific statement, and it travels with the data.
 */
function resolveScan(container: Partial<TimelineContainer>, opts: ScanOptions): Required<ScanOptions> {
  const declared = container.scan ?? {};
  return {
    // `??` and not `||`: an empty array is the meaningful „this folder has no item
    // dates" setting, and `||` would quietly replace it with the defaults.
    dateFields: declared.dateFields ?? opts.dateFields ?? DEFAULT_DATE_FIELDS,
    filenameDatePatterns:
      declared.filenameDatePatterns ?? opts.filenameDatePatterns ?? DEFAULT_FILENAME_PATTERNS,
    groupFromFolder: declared.groupFromFolder ?? opts.groupFromFolder ?? false,
    linkEdges: declared.linkEdges ?? opts.linkEdges ?? false,
    // The empty string is „no order file", so that `Required<ScanOptions>` stays a
    // shape without nulls in it like the other four settings.
    orderFrom: declared.orderFrom ?? opts.orderFrom ?? '',
  };
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
  const container = await readContainer(dir);
  const resolved = resolveScan(container, opts);
  const items: TimelineFileItem[] = [];
  // Bodies are kept aside for the linking pass rather than re-read from disk: the
  // pass needs every note's links *after* every note is known, and reading 250
  // files twice to save one map is the wrong trade.
  const bodies = new Map<string, string>();

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
    if (item) {
      items.push(item);
      if (resolved.linkEdges) bodies.set(item.id!, parsed.content);
    }
  }

  // After the walk, because a link can point at a note the walk has not reached
  // yet: resolving as we go would make an edge depend on directory order.
  if (resolved.linkEdges) linkItems(items, bodies);
  // Independent of `linkEdges`: an order file states where an item sits, not what
  // it relates to, and a folder can want the one without the other.
  if (resolved.orderFrom) await sequenceItems(dir, resolved.orderFrom, items);

  items.sort((a, b) => {
    // Date-less items last, then by start, then by id — a stable order so a
    // rescan does not reshuffle the list view under the reader.
    if (!a.start && !b.start) return a.id! < b.id! ? -1 : 1;
    if (!a.start) return 1;
    if (!b.start) return -1;
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    return a.id! < b.id! ? -1 : 1;
  });

  // `scan` stays behind: it says how this directory was *read*, which is spent by
  // the time there are items. Shipping it would put reading config into the client's
  // TimelineFile, where the generated schema does not allow it.
  const { scan: _scan, ...timeline } = container;
  return { name: basename(dir), ...timeline, items };
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
