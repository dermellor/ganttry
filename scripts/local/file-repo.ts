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
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

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
export type FileRepoDirs = { root: string; scope?: string };

type Loaded = { file: TimelineFile; version: number; path: string };

// ---------------------------------------------------------------------------
// paths + io

/**
 * Resolve a timeline id to its file. Ids arrive from the URL, so a `..` segment
 * would otherwise read and OVERWRITE any file on disk that the process can
 * reach. Containment is checked on the resolved path rather than by inspecting
 * the id, because that also catches the encodings a hand-written blocklist
 * misses.
 */
function pathFor(dirs: FileRepoDirs, id: string): string {
  const root = resolve(dirs.root);
  const path = resolve(root, `${id}.json`);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new ValidationError(`id „${id}" resolves outside the data directory`);
  }
  return path;
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
  const path = pathFor(dirs, id);
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
      const path = pathFor(dirs, id);
      const existed = existsSync(path);
      const loaded: Loaded = existed
        ? await load(dirs, id)
        : { file: { items: [] }, version: 0, path };
      await save(loaded, file);
    },

    // ---- items ------------------------------------------------------------
    async addItem(id: string, item: TimelineFileItem): Promise<TimelineFileItem> {
      const loaded = await load(dirs, id);
      assertExtent(item);
      const { version: _v, ...rest } = item;
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
      const loaded = await load(dirs, id);
      assertVersion(loaded, expectedVersion, `„${id}"`);
      const idx = loaded.file.items.findIndex((it) => it.id === itemId);
      if (idx < 0) throw new NotFoundError(`item „${itemId}" not found in „${id}"`);
      const { version: _v, ...clean } = patch;
      const merged = { ...loaded.file.items[idx], ...clean };
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
      const loaded = await load(dirs, id);
      const items = loaded.file.items.filter((it) => it.id !== itemId);
      if (items.length === loaded.file.items.length) {
        throw new NotFoundError(`item „${itemId}" not found in „${id}"`);
      }
      await save(loaded, { ...loaded.file, items });
    },

    // ---- groups -----------------------------------------------------------
    async upsertGroup(id: string, group: TimelineGroupDecl): Promise<TimelineGroupDecl> {
      const loaded = await load(dirs, id);
      const groups = [...(loaded.file.groups ?? [])];
      const idx = groups.findIndex((g) => g.id === group.id);
      if (idx >= 0) groups[idx] = { ...groups[idx], ...group };
      else groups.push(group);
      await save(loaded, { ...loaded.file, groups });
      return group;
    },

    async deleteGroup(id: string, groupId: string): Promise<void> {
      const loaded = await load(dirs, id);
      const groups = (loaded.file.groups ?? []).filter((g) => g.id !== groupId);
      await save(loaded, { ...loaded.file, groups });
    },

    // ---- timeline-level meta / phases -------------------------------------
    async updatePhases(id: string, phases: TimelinePhase[]): Promise<void> {
      assertPhasesDisjoint(phases);
      const loaded = await load(dirs, id);
      await save(loaded, { ...loaded.file, phases });
    },

    async updateMeta(
      id: string,
      meta: { name?: string; description?: string; groupBy?: string; customFields?: CustomFieldDef[] },
    ): Promise<void> {
      const loaded = await load(dirs, id);
      const next = { ...loaded.file };
      // Only keys actually present in the patch are applied, so a PATCH that
      // carries `name` alone cannot blank out `description`.
      for (const key of ['name', 'description', 'groupBy', 'customFields'] as const) {
        if (key in meta && meta[key] !== undefined) (next as any)[key] = meta[key];
      }
      await save(loaded, next);
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
    return existsSync(pathFor(dirs, id));
  } catch {
    return false; // a traversing id is not a local timeline
  }
}
