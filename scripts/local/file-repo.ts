// A `TimelineRepo` over a single JSON file per timeline.
//
// This is the write path for `kind: 'local'` sources (see
// [`docs/local-sources.md`](../../docs/local-sources.md)). It exists so that a
// JSON file the user owns is editable in the interface, instead of being
// read-only for the sole reason that it is not Postgres. Whether it is reachable
// at all is decided by the runtime: a process with filesystem access serves it,
// a static deploy does not (see „The proposal" there).
//
// Implementing the SAME `TimelineRepo` seam as the two DB drivers is the whole
// trick: `handleTimelineApi` then dispatches every sub-resource, every status
// code and both shared validations (item extent, phase overlap) through this
// repo without knowing it writes files. A parallel dispatcher would have been a
// second copy of those rules, and „Conventions → A rule lives in exactly one
// place" (AGENTS.md) is what that would have broken.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import {
  CONTAINER_FILE,
  DATE_SOURCE_KEY,
  FILENAME_DATE_SOURCE,
  directoryVersion,
  isTimelineDirectory,
  scanDirectory,
  timelineDirectories,
  type ScanOptions,
} from './scan.ts';
import { patchFrontmatter, setBody, type Patch } from './frontmatter.ts';
import { describePhaseOverlap, findPhaseOverlap } from '../../src/phaseOverlap.ts';
import { describeReversedExtent, findReversedExtent, hasReversedExtent } from '../../src/itemExtent.ts';
import {
  ConflictError,
  NotFoundError,
  NotSupportedError,
  ValidationError,
  type PublicPricing,
  type TimelineGroupDecl,
  type TimelineMeta,
  type TimelineRepo,
} from '../db/repo.ts';
import type {
  CustomFieldDef,
  DirectoryUser,
  TimelineContainer,
  TimelineFile,
  TimelineFileItem,
  TimelinePhase,
  Watermark,
} from '../../src/types';

/**
 * Where a repo reads from. `root` anchors the ids (always relative to `data/`,
 * so an id is identical across environments and matches a DB timeline id),
 * `scope` bounds the scan (`data/<subdir>` on a scoped instance). They differ
 * exactly when TIMELINES_SOURCES_SUBDIR is set; `build-data.ts` derives its two
 * paths the same way and for the same reason.
 */
export type FileRepoDirs = { root: string; scope?: string; scanOptions?: ScanOptions };

type Loaded = { file: TimelineFile; version: number; path: string; isDir?: boolean };

// ---------------------------------------------------------------------------
// paths + io

/**
 * Resolve a timeline id to its file. Ids arrive from the URL, so a `..` segment
 * would otherwise read and OVERWRITE any file on disk that the process can
 * reach. Containment is checked on the resolved path rather than by inspecting
 * the id, because that also catches the encodings a hand-written blocklist
 * misses.
 */
function contained(root: string, path: string, id: string): string {
  if (path !== root && !path.startsWith(root + sep)) {
    throw new ValidationError(`id „${id}" resolves outside the data directory`);
  }
  return path;
}

function pathFor(dirs: FileRepoDirs, id: string): string {
  const root = resolve(dirs.root);
  return contained(root, resolve(root, `${id}.json`), id);
}

/**
 * The two shapes a local source can have. A directory wins when it holds a
 * container file, because that marker is what distinguishes „a timeline made of
 * Markdown files" from „some folder that happens to sit under data/".
 */
type Target = { kind: 'file' | 'dir'; path: string };

function targetFor(dirs: FileRepoDirs, id: string): Target {
  const root = resolve(dirs.root);
  const asDir = contained(root, resolve(root, id), id);
  if (isTimelineDirectory(asDir)) return { kind: 'dir', path: asDir };
  return { kind: 'file', path: contained(root, resolve(root, `${id}.json`), id) };
}

function idFor(dirs: FileRepoDirs, path: string): string {
  const rel = relative(resolve(dirs.root), path).replace(/\\/g, '/');
  return rel.slice(0, -extname(rel).length);
}

/**
 * The stand-in for the DB's per-row version: the file's mtime in whole
 * milliseconds, raised to stay strictly increasing across writes.
 *
 * mtime alone is not enough. Two writes inside one millisecond report the same
 * value, and then a client holding the first version passes an `If-Match` that
 * should have failed — it overwrites a change it never saw. This is not
 * hypothetical: the repo's own tests hit it on the first run.
 *
 * So each issued version is remembered per path and the next one is forced past
 * it. Nudging the file's mtime instead (via `utimes`) was tried first and is the
 * more fragile mechanism: it depends on the filesystem storing what it is given,
 * and it fights whatever else writes the file.
 *
 * The state is per process, which is the right scope: it exists to order OUR
 * writes. A restart falls back to the plain mtime, and clients reload anyway.
 * The one case it cannot see is an external write landing at an mtime below a
 * version we already issued — possible only within the few milliseconds we ever
 * run ahead of the clock.
 */
const issued = new Map<string, number>();

function versionOf(path: string, mtimeMs: number): number {
  return Math.max(Math.floor(mtimeMs), issued.get(path) ?? 0);
}

function nextVersion(path: string, mtimeMs: number, previous: number): number {
  const version = Math.max(Math.floor(mtimeMs), previous + 1);
  issued.set(path, version);
  return version;
}

async function load(dirs: FileRepoDirs, id: string): Promise<Loaded> {
  const target = targetFor(dirs, id);
  if (target.kind === 'dir') {
    // The directory IS the timeline: its Markdown files are the items, its
    // container file everything above item level. One scan per request, so an
    // edit made in an editor shows on the next reload without a rebuild.
    const file = await scanDirectory(target.path, dirs.scanOptions);
    const mtime = await directoryVersion(target.path);
    return { file, version: versionOf(target.path, mtime), path: target.path, isDir: true };
  }
  const path = target.path;
  let raw: string;
  let mtimeMs: number;
  try {
    const st = await stat(path);
    mtimeMs = st.mtimeMs;
    raw = await readFile(path, 'utf8');
  } catch {
    throw new NotFoundError(`timeline „${id}" not found`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // A 500 here would read as „the server is broken" when the file is simply
    // malformed, which is the user's to fix and needs to say so.
    throw new ValidationError(`„${id}" is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  const file = parsed as TimelineFile;
  if (!file || typeof file !== 'object' || !Array.isArray(file.items)) {
    throw new ValidationError(`„${id}" has no "items" array`);
  }
  return { file, version: versionOf(path, mtimeMs), path };
}

/** Load for a write. Kept separate from `load` so the intent reads at the call site. */
async function loadForWrite(dirs: FileRepoDirs, id: string): Promise<Loaded> {
  return load(dirs, id);
}

/**
 * Drop keys that carry no value.
 *
 * The viewer always sends a FULL item patch (`buildItemPatch`), so every field
 * the user left empty arrives as an explicit `null`. A column takes that as
 * NULL and nothing shows; a JSON file would keep it verbatim, and the file then
 * carries `"duration": null, "type": null, "metadata": null` — noise in a
 * hand-written file, and invalid against `schema/timeline.schema.json`, whose
 * `duration` is string|number. The file's own way of saying „unset" is the
 * absent key, so that is what a null becomes here.
 *
 * Only the item's own keys are considered. `metadata` is the user's object and
 * its contents are none of our business.
 */
function withoutEmpty<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out as T;
}

async function save(loaded: Loaded, file: TimelineFile): Promise<number> {
  const clean: TimelineFile = {
    ...file,
    items: file.items.map(({ version, ...rest }) => withoutEmpty(rest)),
  };
  const tmp = `${loaded.path}.${process.pid}.tmp`;
  await mkdir(dirname(loaded.path), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  await rename(tmp, loaded.path);

  const st = await stat(loaded.path);
  return nextVersion(loaded.path, st.mtimeMs, loaded.version);
}

/**
 * Refuse a write whose caller read an older state of the file.
 *
 * The version is the file's mtime, so this locks the WHOLE document rather than
 * one row. That is the accurate granularity here: any concurrent write rewrites
 * the same file, so a per-item check would pass while the neighbouring item the
 * caller also saw had already changed underneath them.
 */
function assertVersion(loaded: Loaded, expected: number | undefined, what: string): void {
  if (expected == null) return;
  if (expected !== loaded.version) {
    throw new ConflictError(`${what} changed on disk (expected ${expected}, found ${loaded.version})`);
  }
}

/** Stamp the file's version onto every item, the way the DB stamps a row version. */
function withVersions(file: TimelineFile, version: number): TimelineFile {
  return { ...file, items: file.items.map((it) => ({ ...it, version })) };
}

// ---------------------------------------------------------------------------
// validation, shared with the client and both DB drivers

function assertExtent(item: { start?: unknown; end?: unknown }): void {
  if (hasReversedExtent(item)) throw new ValidationError(describeReversedExtent(item.start, item.end));
}

function assertExtentsOrdered(items: TimelineFileItem[] | undefined): void {
  const bad = findReversedExtent(items ?? []);
  if (bad) throw new ValidationError(describeReversedExtent(bad.start, bad.end));
}

function assertPhasesDisjoint(phases: TimelinePhase[] | undefined): void {
  const clash = findPhaseOverlap(phases ?? []);
  if (clash) throw new ValidationError(describePhaseOverlap(clash.a, clash.b));
}

/** Mint an id that no current item holds. */
function mintItemId(file: TimelineFile): string {
  const taken = new Set(file.items.map((it) => it.id).filter(Boolean) as string[]);
  for (let n = file.items.length + 1; ; n++) {
    const candidate = `i-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function* walkJson(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJson(full);
    } else if (entry.isFile() && extname(entry.name) === '.json') {
      yield full;
    }
  }
}


// ---------------------------------------------------------------------------
// directory sources: writing back into the notes
//
// An item here is a Markdown file, so a write is a frontmatter patch on that one
// file (see `./frontmatter.ts` for why it is surgical rather than a re-serialize).

/** Keys the scanner puts on `metadata` that describe the file, not the note. */
const SYNTHETIC_META = new Set(['path', 'filename', DATE_SOURCE_KEY]);

/** Frontmatter keys this module owns, and therefore never writes twice. */
const MAPPED_KEYS = new Set(['title', 'end', 'end_date', 'until', 'duration', 'group', 'icon', 'status', 'type']);

/** Where a scanned item's file lives, relative to the source directory. */
function notePathOf(item: TimelineFileItem): string | null {
  const rel = item.metadata?.path;
  return typeof rel === 'string' && rel ? rel : null;
}

/**
 * The frontmatter key an item's start is written back to.
 *
 * The scanner recorded which key it read (`dateSource`). A date that came from
 * the filename has no key yet, so an explicit one is written: the cascade tries
 * frontmatter before the filename, so from then on the note states its own date
 * instead of depending on what it is called. That promotion is the reason the
 * read path bothers to record the provenance at all.
 */
function startKeyFor(stored: TimelineFileItem, dateFields: string[]): string {
  const recorded = stored.metadata?.[DATE_SOURCE_KEY];
  if (typeof recorded === 'string' && recorded && recorded !== FILENAME_DATE_SOURCE) return recorded;
  return dateFields[0] ?? 'date';
}

/**
 * Turn an item patch into a frontmatter patch.
 *
 * Only keys the caller actually sent are considered, so a patch that carries
 * `end` alone cannot blank a title. `metadata` is diffed against what is stored
 * so a removed custom key becomes a removed line, and the synthetic keys the
 * scanner added are never written back into the user's file.
 */
function frontmatterPatchFor(
  patch: Partial<TimelineFileItem>,
  stored: TimelineFileItem,
  dateFields: string[],
): Patch {
  const out: Patch = {};
  if ('content' in patch) out.title = patch.content;
  if ('start' in patch) out[startKeyFor(stored, dateFields)] = patch.start ?? null;
  if ('end' in patch) out.end = patch.end ?? null;
  if ('duration' in patch) out.duration = patch.duration ?? null;
  if ('group' in patch) out.group = patch.group ?? null;
  if ('icon' in patch) out.icon = patch.icon ?? null;
  if ('status' in patch) out.status = patch.status ?? null;
  if ('type' in patch) out.type = patch.type ?? null;

  if ('metadata' in patch) {
    const next = (patch.metadata ?? {}) as Record<string, unknown>;
    const prev = (stored.metadata ?? {}) as Record<string, unknown>;
    const owned = (k: string) => !SYNTHETIC_META.has(k) && !MAPPED_KEYS.has(k) && !(k in out);
    for (const [k, v] of Object.entries(next)) {
      if (owned(k) && v !== prev[k]) out[k] = v;
    }
    for (const k of Object.keys(prev)) {
      if (owned(k) && !(k in next)) out[k] = null;
    }
  }
  return out;
}

/** A filename for a new note: the title, made safe, with a counter on collision. */
function noteFilenameFor(dir: string, title: string): string {
  const base =
    title
      .toLowerCase()
      .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c] ?? c)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'eintrag';
  let candidate = `${base}.md`;
  for (let n = 2; existsSync(join(dir, candidate)); n++) candidate = `${base}-${n}.md`;
  return candidate;
}

/**
 * Delete a note by moving it to `<root>/.trash/`.
 *
 * Never `unlink`. This is a file the tool did not create and cannot recreate,
 * and the scan already skips dot-directories, so a trashed note disappears from
 * the timeline without disappearing from the disk. `.trash` is also Obsidian's
 * own convention, so a vault user finds it where they expect.
 */
async function trashNote(dir: string, rel: string): Promise<void> {
  const from = join(dir, rel);
  const to = join(dir, '.trash', rel);
  await mkdir(dirname(to), { recursive: true });
  let target = to;
  for (let n = 2; existsSync(target); n++) {
    target = join(dirname(to), `${basename(to, extname(to))}-${n}${extname(to)}`);
  }
  await rename(from, target);
}

/** Write the directory's container file, creating it when it is missing. */
async function writeContainer(dir: string, container: TimelineContainer): Promise<void> {
  const path = join(dir, CONTAINER_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(container, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

/** The container half of a scanned file: everything except the items. */
function containerOf(file: TimelineFile): TimelineContainer {
  const { items: _items, ...rest } = file;
  return rest;
}

/**
 * Write a timeline-level change (groups, phases, meta) to whichever document
 * holds it: the JSON file itself, or the directory's container.
 *
 * The items are deliberately not part of a container write — in a directory they
 * live in their own files, and folding the scanned copy back in would give the
 * timeline two places that claim to define them.
 */
async function persist(loaded: Loaded, file: TimelineFile): Promise<number> {
  if (!loaded.isDir) return save(loaded, file);
  await writeContainer(loaded.path, containerOf(file));
  return nextVersion(loaded.path, await directoryVersion(loaded.path), loaded.version);
}

// ---------------------------------------------------------------------------

/**
 * A `TimelineRepo` backed by `<root>/<id>.json`.
 *
 * The plugin sub-resources (pricing features, tiers, cells, highlights,
 * versions) throw `NotSupportedError` → `501`. They are deliberately out of
 * scope for the first cut, and answering 501 says so; returning a silent success
 * would let the interface report „Gespeichert" for a write that never happened.
 */
export function makeFileRepo(dirs: FileRepoDirs): TimelineRepo {
  const unsupported = (what: string) => {
    throw new NotSupportedError(`the local file source does not support ${what} yet`);
  };

  return {
    // ---- reads ------------------------------------------------------------
    async listTimelines(): Promise<TimelineMeta[]> {
      const scope = dirs.scope ?? dirs.root;
      if (!existsSync(scope)) return [];
      const out: TimelineMeta[] = [];
      for (const dir of await timelineDirectories(scope)) {
        const id = relative(resolve(dirs.root), dir).replace(/\\/g, '/');
        let container: Partial<TimelineFile> = {};
        try {
          container = JSON.parse(await readFile(join(dir, CONTAINER_FILE), 'utf8'));
        } catch {
          /* a malformed container still leaves a listable directory */
        }
        out.push({ id, name: container.name || id, description: container.description, groupBy: container.groupBy });
      }
      for await (const path of walkJson(scope)) {
        let file: TimelineFile;
        try {
          file = JSON.parse(await readFile(path, 'utf8')) as TimelineFile;
        } catch {
          continue; // a malformed file must not take the whole listing down
        }
        if (!Array.isArray(file?.items)) continue;
        const id = idFor(dirs, path);
        out.push({ id, name: file.name || id, description: file.description, groupBy: file.groupBy });
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : 1));
    },

    async getTimeline(id: string): Promise<TimelineFile | null> {
      try {
        const loaded = await load(dirs, id);
        return withVersions(loaded.file, loaded.version);
      } catch (e) {
        if (e instanceof NotFoundError) return null;
        throw e;
      }
    },

    async getWatermark(id: string): Promise<Watermark> {
      const loaded = await load(dirs, id);
      return { v: loaded.version, n: loaded.file.items.length, t: new Date(loaded.version).toISOString() };
    },

    async getPublicPricing(id: string): Promise<PublicPricing | null> {
      const file = await this.getTimeline(id);
      if (!file?.pricing) return null;
      return { id, name: file.name, pricing: file.pricing };
    },

    // The user directory is a DB concept (`app_users`). A local file carries no
    // such thing, and an empty directory is the truthful answer: the owner
    // picker then offers nothing rather than showing stale names.
    async listUsers(): Promise<DirectoryUser[]> {
      return [];
    },
    async touchUser(): Promise<void> {
      /* nothing to record */
    },

    // ---- whole timeline ---------------------------------------------------
    async replaceTimeline(id: string, file: TimelineFile): Promise<void> {
      assertExtentsOrdered(file.items);
      assertPhasesDisjoint(file.phases);
      const target = targetFor(dirs, id);
      if (target.kind === 'dir') {
        // Replacing a directory wholesale would mean rewriting or deleting every
        // note in it from one request. That is a destructive operation on files
        // the tool does not own, and no interaction asks for it — the viewer
        // edits item by item. The bulk path stays available for JSON sources.
        throw new NotSupportedError(
          `„${id}" is a Markdown directory: replacing it wholesale is refused; edit its items individually`,
        );
      }
      const loaded: Loaded = existsSync(target.path)
        ? await loadForWrite(dirs, id)
        : { file: { items: [] }, version: 0, path: target.path };
      await save(loaded, file);
    },

    // ---- items ------------------------------------------------------------
    async addItem(id: string, item: TimelineFileItem): Promise<TimelineFileItem> {
      const loaded = await loadForWrite(dirs, id);
      assertExtent(item);
      const { version: _v, ...rest } = item;

      if (loaded.isDir) {
        // A new item is a new note. Its id is its path, so the filename decides
        // it — derived from the title rather than minted, because a file called
        // `i-7.md` in somebody's vault is the tool leaving litter behind.
        const dateFields = dirs.scanOptions?.dateFields ?? ['date'];
        const file = noteFilenameFor(loaded.path, rest.content);
        const front = frontmatterPatchFor(
          { ...rest, metadata: {} },
          { content: rest.content, metadata: {} },
          dateFields,
        );
        const text = patchFrontmatter(rest.body ? `\n${rest.body}\n` : '\n', front);
        await writeFile(join(loaded.path, file), text, 'utf8');
        const version = nextVersion(loaded.path, await directoryVersion(loaded.path), loaded.version);
        return { ...rest, id: file.slice(0, -extname(file).length), version };
      }

      const added: TimelineFileItem = { ...rest, id: item.id || mintItemId(loaded.file) };
      const next = { ...loaded.file, items: [...loaded.file.items, added] };
      const version = await save(loaded, next);
      return { ...added, version };
    },

    async updateItem(
      id: string,
      itemId: string,
      patch: Partial<TimelineFileItem>,
      expectedVersion?: number,
    ): Promise<TimelineFileItem> {
      const loaded = await loadForWrite(dirs, id);
      assertVersion(loaded, expectedVersion, `„${id}"`);
      const idx = loaded.file.items.findIndex((it) => it.id === itemId);
      if (idx < 0) throw new NotFoundError(`item „${itemId}" not found in „${id}"`);
      const { version: _v, ...clean } = patch;
      const merged = { ...loaded.file.items[idx], ...clean };

      if (loaded.isDir) {
        assertExtent(merged);
        const stored = loaded.file.items[idx];
        const rel = notePathOf(stored);
        if (!rel) throw new NotFoundError(`item „${itemId}" has no file behind it`);
        const notePath = join(loaded.path, rel);
        let text = await readFile(notePath, 'utf8');
        const dateFields = dirs.scanOptions?.dateFields ?? ['date'];
        text = patchFrontmatter(text, frontmatterPatchFor(clean, stored, dateFields));
        // The body is prose, not a field. The viewer sends a full patch, so it
        // arrives on every edit whether or not it changed — rewriting it anyway
        // costs the file its exact spacing (the blank line under the block, for
        // one), which is a diff the user never asked for. Only an actual change
        // touches it.
        const storedBody = stored.body ?? '';
        if ('body' in clean && (clean.body ?? '') !== storedBody) text = setBody(text, clean.body ?? '');
        await writeFile(notePath, text, 'utf8');
        const version = nextVersion(loaded.path, await directoryVersion(loaded.path), loaded.version);
        return { ...merged, version };
      }
      // A partial patch can reverse the extent while carrying only one of the
      // two dates, so the check runs against the MERGED item — the same reason
      // `updateItem` reads the stored counterpart in the DB drivers.
      assertExtent(merged);
      const items = [...loaded.file.items];
      // A null in the patch clears the field, and clearing a field in a file
      // means removing the key. Stripping here (not only on the way to disk)
      // keeps what the client gets back identical to what was stored.
      items[idx] = withoutEmpty(merged);
      const version = await save(loaded, { ...loaded.file, items });
      return { ...items[idx], version };
    },

    async getItem(id: string, itemId: string): Promise<TimelineFileItem | null> {
      const loaded = await load(dirs, id);
      const found = loaded.file.items.find((it) => it.id === itemId);
      return found ? { ...found, version: loaded.version } : null;
    },

    async deleteItem(id: string, itemId: string): Promise<void> {
      const loaded = await loadForWrite(dirs, id);

      if (loaded.isDir) {
        const stored = loaded.file.items.find((it) => it.id === itemId);
        const rel = stored ? notePathOf(stored) : null;
        if (!rel) throw new NotFoundError(`item „${itemId}" not found in „${id}"`);
        await trashNote(loaded.path, rel);
        nextVersion(loaded.path, await directoryVersion(loaded.path), loaded.version);
        return;
      }

      const items = loaded.file.items.filter((it) => it.id !== itemId);
      if (items.length === loaded.file.items.length) {
        throw new NotFoundError(`item „${itemId}" not found in „${id}"`);
      }
      await save(loaded, { ...loaded.file, items });
    },

    // ---- groups -----------------------------------------------------------
    async upsertGroup(id: string, group: TimelineGroupDecl): Promise<TimelineGroupDecl> {
      const loaded = await loadForWrite(dirs, id);
      const groups = [...(loaded.file.groups ?? [])];
      const idx = groups.findIndex((g) => g.id === group.id);
      if (idx >= 0) groups[idx] = { ...groups[idx], ...group };
      else groups.push(group);
      await persist(loaded, { ...loaded.file, groups });
      return group;
    },

    async deleteGroup(id: string, groupId: string): Promise<void> {
      const loaded = await loadForWrite(dirs, id);
      const groups = (loaded.file.groups ?? []).filter((g) => g.id !== groupId);
      await persist(loaded, { ...loaded.file, groups });
    },

    // ---- timeline-level meta / phases -------------------------------------
    async updatePhases(id: string, phases: TimelinePhase[]): Promise<void> {
      assertPhasesDisjoint(phases);
      const loaded = await loadForWrite(dirs, id);
      await persist(loaded, { ...loaded.file, phases });
    },

    async updateMeta(
      id: string,
      meta: { name?: string; description?: string; groupBy?: string; customFields?: CustomFieldDef[] },
    ): Promise<void> {
      const loaded = await loadForWrite(dirs, id);
      const next = { ...loaded.file };
      // Only keys actually present in the patch are applied, so a PATCH that
      // carries `name` alone cannot blank out `description`.
      for (const key of ['name', 'description', 'groupBy', 'customFields'] as const) {
        if (key in meta && meta[key] !== undefined) (next as any)[key] = meta[key];
      }
      await persist(loaded, next);
    },

    // ---- pricing (plugin surface, first cut: 501) --------------------------
    async addFeature() {
      return unsupported('adding pricing features');
    },
    async updateFeature() {
      return unsupported('editing pricing features');
    },
    async deleteFeature() {
      return unsupported('deleting pricing features');
    },
    async moveFeature() {
      return unsupported('reordering pricing features');
    },
    async addTier() {
      return unsupported('adding pricing tiers');
    },
    async updateTier() {
      return unsupported('editing pricing tiers');
    },
    async deleteTier() {
      return unsupported('deleting pricing tiers');
    },
    async setTierValue() {
      return unsupported('editing pricing cells');
    },
    async clearTierValue() {
      return unsupported('clearing pricing cells');
    },
    async addHighlight() {
      return unsupported('adding pricing highlights');
    },
    async updateHighlight() {
      return unsupported('editing pricing highlights');
    },
    async deleteHighlight() {
      return unsupported('deleting pricing highlights');
    },
    async updateVersions() {
      return unsupported('editing pricing versions');
    },
    async replacePricing() {
      return unsupported('replacing the pricing model');
    },
  } as TimelineRepo;
}

/** Does this id resolve to a readable local timeline file? */
export function hasLocalTimeline(dirs: FileRepoDirs, id: string): boolean {
  try {
    const target = targetFor(dirs, id);
    return target.kind === 'dir' || existsSync(target.path);
  } catch {
    return false; // a traversing id is not a local timeline
  }
}

/**
 * Can this source be written to by a runtime that has a filesystem?
 *
 * Separate from `hasLocalTimeline` because the two answers differ: a directory
 * source is served but not yet writable. The dev server stamps `editable` from
 * this rather than from „is it local at all", otherwise the interface offers
 * „+ Eintrag" and drag handles on a Markdown timeline and every one of them
 * ends in a 501 — an edit that looks available and then is not is worse than
 * one that was never offered.
 */
export function isLocalWritable(dirs: FileRepoDirs, id: string): boolean {
  try {
    const target = targetFor(dirs, id);
    return target.kind === 'dir' || existsSync(target.path);
  } catch {
    return false;
  }
}
