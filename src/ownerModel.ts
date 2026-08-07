// Pure model behind the Owner field: what a stored value means, and which users
// a query matches. DOM-free and cache-free on purpose — the loader, the module
// cache and the renderers sit on top in users.ts, the same split presenceModel.ts
// has under presence.ts, and the rules here are unit-tested in ownerModel.test.ts.

import type { DirectoryUser } from './types';

/** Case-insensitive address → user index (addresses are not case-sensitive). */
export function indexUsers(users: DirectoryUser[]): Map<string, DirectoryUser> {
  return new Map(users.map((u) => [u.email.toLowerCase(), u]));
}

/**
 * What a stored `metadata.owner` value means for display. `known` separates a
 * resolved user from a legacy free-text value, which the renderers show
 * differently (a marked plain label instead of an avatar) rather than dropping:
 * Owner was free text before it linked users, so real data carries values like
 * "Strategy Team", and file-based sources have no directory at all.
 */
export type ResolvedOwner = {
  raw: string;
  label: string;
  known: boolean;
  user?: DirectoryUser;
};

export function resolveOwnerIn(
  byEmail: Map<string, DirectoryUser>,
  raw: string,
): ResolvedOwner | null {
  const value = raw.trim();
  if (!value) return null;
  const user = byEmail.get(value.toLowerCase());
  if (user) return { raw: value, label: displayName(user), known: true, user };
  return { raw: value, label: value, known: false };
}

/** Preferred display name: the stored name, else the address' local part. */
export function displayName(u: DirectoryUser): string {
  const name = u.name?.trim();
  if (name) return name;
  return u.email.split('@')[0] || u.email;
}

/**
 * Directory search for the owner picker: matches name or address, case-
 * insensitively. An empty query returns the head of the (already ordered)
 * directory, so focusing the field shows who is available instead of an empty
 * dropdown.
 */
export function matchUsers(users: DirectoryUser[], query: string, limit = 8): DirectoryUser[] {
  const needle = query.trim().toLowerCase();
  const hits = needle
    ? users.filter(
        (u) => u.email.toLowerCase().includes(needle) || (u.name ?? '').toLowerCase().includes(needle),
      )
    : users;
  return hits.slice(0, limit);
}
