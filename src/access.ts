// Who may do what — the single source of truth for the membership rules.
//
// Pure, DOM-free and dependency-free on purpose, because four places have to
// agree on the same answer: the Netlify edge function, the self-hosted Node
// server, the Vite dev middleware and the browser (which hides what the caller
// cannot do). Restating the table in any of them is how one copy ends up fixed
// and the others do not — the same reasoning as `src/status.ts` and
// `src/itemExtent.ts`.
//
// This module knows nothing about routes or HTTP beyond a method name. Mapping a
// *request* to a capability needs the sub-resource list from `scripts/db/api.ts`,
// which imports both database drivers; pulling that in here would drag them into
// the browser bundle. So the dispatcher names the capability at its call site and
// this module answers only whether a role has it.

/** Instance-wide role. Deliberately not per timeline (see migration 0016). */
export type MemberRole = 'admin' | 'editor' | 'viewer';

/**
 * Lifecycle of one membership.
 *
 *   (—) --invite--> invited --first sign-in--> active <--> suspended
 *                      \                          \           /
 *                       `--------- removed <-------`---------`
 */
export type MemberStatus = 'invited' | 'active' | 'suspended' | 'removed';

/** What an operation needs, rather than what it is. */
export type Capability = 'read' | 'write' | 'manage';

export const MEMBER_ROLES: readonly MemberRole[] = ['admin', 'editor', 'viewer'];
export const MEMBER_STATUSES: readonly MemberStatus[] = ['invited', 'active', 'suspended', 'removed'];

/**
 * The role an invitation gets when none is stated, and the role every row the
 * 0016 migration touches comes out with. Changing it changes what applying that
 * migration means for an existing instance, so the two have to move together.
 */
export const DEFAULT_ROLE: MemberRole = 'editor';

const GRANTS: Record<MemberRole, readonly Capability[]> = {
  admin: ['read', 'write', 'manage'],
  editor: ['read', 'write'],
  viewer: ['read'],
};

/** The membership the rules operate on: the identity plus its two verdicts. */
export type MemberLike = { role: MemberRole; status: MemberStatus };

/** Does this role carry this capability, ignoring the membership's status? */
export function roleAllows(role: MemberRole, capability: Capability): boolean {
  return GRANTS[role]?.includes(capability) ?? false;
}

/**
 * Does the membership count at all right now?
 *
 * Only `active`. An `invited` row is a promise rather than access: it lets its
 * holder through the sign-in door (see `maySignIn`), and the sign-in is what
 * turns it active. Letting `invited` count here would hand full access to
 * anybody an admin has merely typed into the invite dialog.
 */
export function isActiveMember(member: MemberLike | null | undefined): boolean {
  return member?.status === 'active';
}

/**
 * May this membership complete a sign-in?
 *
 * Wider than `isActiveMember` by exactly one state, because accepting an
 * invitation *is* the first sign-in: refusing `invited` at the door would make
 * every invitation impossible to accept. `suspended` and `removed` are refused
 * here, so revoking access ends the next sign-in as well as the current session.
 */
export function maySignIn(member: MemberLike | null | undefined): boolean {
  return member?.status === 'invited' || member?.status === 'active';
}

/**
 * The whole question in one call: may this caller do this?
 *
 * Absent membership answers false rather than throwing. A missing row is the
 * normal case for a stranger, and an exception would tempt callers into a
 * try/catch that swallows the real errors too.
 */
export function memberCan(member: MemberLike | null | undefined, capability: Capability): boolean {
  if (!member || !isActiveMember(member)) return false;
  return roleAllows(member.role, capability);
}

/**
 * What an HTTP method needs before anything else is considered.
 *
 * Read-only methods need `read`; everything else needs `write`. `manage` never
 * comes from a method — the user-management routes state it explicitly, because
 * a `PATCH` on a timeline item and a `PATCH` on a member are the same verb with
 * very different stakes.
 */
export function capabilityForMethod(method: string): Capability {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ? 'read' : 'write';
}

/** A stored/incoming role, or undefined when it is not one of ours. */
export function normalizeMemberRole(value: unknown): MemberRole | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return MEMBER_ROLES.find((r) => r === v);
}

/** A stored/incoming status, or undefined when it is not one of ours. */
export function normalizeMemberStatus(value: unknown): MemberStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return MEMBER_STATUSES.find((s) => s === v);
}

/**
 * Would removing or demoting this member leave the instance with no admin?
 *
 * An instance without an admin cannot invite anybody, cannot restore anybody,
 * and is only recoverable through the bootstrap environment variable. Cheaper to
 * refuse than to explain afterwards, so the write paths call this before
 * applying a role or status change.
 *
 * `others` is every OTHER membership; the caller excludes the row being changed.
 */
export function wouldOrphanInstance(others: readonly MemberLike[]): boolean {
  return !others.some((m) => m.role === 'admin' && m.status === 'active');
}
