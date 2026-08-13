// Where local sources live, and whether this runtime may write to them.
//
// Both answers were computed in two places — `scripts/build-data.ts` for the
// static build and `vite.config.ts` for the dev server — from the same two
// variables, with the same two comments explaining the same reasoning. That is
// the duplication „a rule lives in exactly one place" (AGENTS.md) is about: the
// build registering a source the adapter then cannot resolve is a 404 with no
// explanation anywhere.

import { resolve } from 'node:path';

import { envValue } from '../db/env.ts';

export type LocalRoots = {
  /**
   * Anchors the ids. A source's id is its path relative to this directory, so
   * the same source has the same id in the build, in the adapter and in a URL —
   * and can collide with a DB timeline id on purpose, which is how a file
   * shadows a database timeline.
   */
  root: string;
  /**
   * Bounds the scan. Equal to `root` unless the instance is scoped to a
   * subfolder, in which case ids keep the prefix while discovery does not leave
   * the subfolder.
   */
  scope: string;
};

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * The directory local sources are discovered under.
 *
 * `data/` inside the checkout by default. `TIMELINES_LOCAL_ROOT` moves it
 * anywhere on disk, which is what lets a source be a folder the user already
 * owns — an Obsidian vault, a notes directory — instead of a copy of one inside
 * the repository. A copy would be the thing this project refuses everywhere
 * else: indistinguishable from the original and silently stale (see „No fallback
 * data, ever", AGENTS.md).
 *
 * A relative value resolves against the checkout, so `TIMELINES_LOCAL_ROOT=data`
 * is the default spelled out.
 */
export function localRoots(): LocalRoots {
  const configured = envValue('TIMELINES_LOCAL_ROOT').trim();
  const root = configured ? resolve(REPO_ROOT, expandHome(configured)) : resolve(REPO_ROOT, 'data');
  const subdir = envValue('TIMELINES_SOURCES_SUBDIR').replace(/^\/+|\/+$/g, '');
  return { root, scope: subdir ? resolve(root, subdir) : root };
}

/**
 * Is this runtime allowed to write to local sources?
 *
 * Editability is a property of the runtime rather than of the file format
 * („The proposal", docs/local-sources.md), and a process that *can* write is not
 * always one that *should*. Pointing an instance at a directory the user owns for
 * other reasons — a vault they write prose in — is the case: the timeline is
 * worth reading there, and an accidental drag must not rewrite a note's
 * frontmatter. `TIMELINES_LOCAL_READONLY` says so once, for the whole instance,
 * rather than per source.
 */
export function localReadOnly(): boolean {
  const raw = envValue('TIMELINES_LOCAL_READONLY').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** `~` is a shell feature, and an env file is not a shell. */
function expandHome(path: string): string {
  if (path === '~') return process.env.HOME ?? path;
  if (path.startsWith('~/')) return `${process.env.HOME ?? '~'}${path.slice(1)}`;
  return path;
}
