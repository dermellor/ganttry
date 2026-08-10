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
 * The role a NON-human caller acts with, from `MCP_TOKEN_ROLE`.
 *
 * Defaulting to `editor` keeps every existing automation working unchanged the
 * day the switch is turned on. An operator who wants a read-only agent says so.
 *
 * It lives here rather than in the HTTP layer because two callers need the same
 * answer and neither may import the other's dependencies: the dispatcher (which
 * pulls in both database drivers) and the settings registry (which is read in
 * the browser). „Editor unless stated" is a rule, and a rule lives in one place —
 * a second reading is how the page ends up claiming a role the API does not use.
 */
export function serviceRoleFrom(raw: string | undefined | null): MemberRole {
  return normalizeMemberRole(raw) ?? 'editor';
}

/**
 * `TIMELINES_ACCESS_CONTROL`, parsed once so no runtime invents its own reading.
 *
 * Only the exact string `true` enables it. Anything else — unset, `false`, `1`,
 * `yes`, a typo — leaves it off, because a switch that silently interprets is a
 * switch nobody can reason about, and the safe reading of „I do not understand
 * this value" is „behave as before" rather than „refuse everybody".
 *
 * It lives here rather than in the HTTP layer because the auth gate needs the
 * same answer, and importing that module would drag both database drivers into
 * an edge function that runs on every single request.
 */
export function accessControlEnabled(raw: string | undefined | null): boolean {
  return raw === 'true';
}

/**
 * Does the bootstrap address need to be made an admin before this sign-in counts?
 *
 * The variable is the instance's master key, so it has to hold whatever state the
 * row is in — not only „no row yet". An instance that has been running has every
 * past editor in `app_users` already (migration `0015` backfilled them from edit
 * attribution, `0016` made them active editors), so the owner's own address
 * almost certainly exists. Firing only on a missing row would let them sign in as
 * an editor into an instance with no admin at all: nobody can invite, nobody can
 * restore, and the only way out is SQL. That is precisely the lockout the
 * variable exists to prevent.
 *
 * It also covers a suspended or removed master key, which is the other moment
 * somebody reaches for it.
 *
 * Returns false when the address is not the bootstrap one, when none is
 * configured, or when the row is already an active admin — so the common case
 * costs nothing but a comparison.
 */
export function needsBootstrapPromotion(
  member: MemberLike | null | undefined,
  email: string,
  bootstrapAddress: string | undefined | null,
): boolean {
  const bootstrap = (bootstrapAddress ?? '').trim().toLowerCase();
  if (!bootstrap || bootstrap !== email.trim().toLowerCase()) return false;
  return !member || member.role !== 'admin' || member.status !== 'active';
}

/** Why a sign-in was refused. Each maps to its own line on the gate's error page. */
export type SignInRefusal =
  | 'not_a_member'
  | 'membership_suspended'
  | 'membership_removed'
  | 'invitation_expired';

export type SignInVerdict =
  | { allow: true; /** Flip `invited` → `active`: this sign-in IS the acceptance. */ accept: boolean }
  | { allow: false; reason: SignInRefusal };

/** What the gate needs to decide a sign-in: the lifecycle, plus the invitation's clock. */
export type SignInCandidate = { status: MemberStatus; inviteExpiresAt?: string | null };

/**
 * May this address complete a sign-in, and does doing so accept an invitation?
 *
 * Pure, and separate from the OAuth plumbing, because these five outcomes are
 * the whole policy and they deserve a test each rather than a walk through a
 * redirect flow. The identity provider has already proved the address by the
 * time this is asked; all that is left is what our own records say.
 *
 * An expiry is only consulted for an `invited` row. An active member carries
 * none (accepting clears it), and treating a leftover value as binding would
 * lock out somebody who joined months ago.
 */
export function decideSignIn(member: SignInCandidate | null | undefined, nowMs: number): SignInVerdict {
  if (!member) return { allow: false, reason: 'not_a_member' };
  if (member.status === 'suspended') return { allow: false, reason: 'membership_suspended' };
  if (member.status === 'removed') return { allow: false, reason: 'membership_removed' };
  if (member.status === 'active') return { allow: true, accept: false };

  // invited: the only state where the clock matters.
  const expiry = member.inviteExpiresAt ? Date.parse(member.inviteExpiresAt) : NaN;
  // An unparseable or absent expiry does NOT expire the invitation. An invite
  // created without one is open-ended by choice, and refusing on „I cannot read
  // this date" would turn a storage quirk into a lockout.
  if (Number.isFinite(expiry) && expiry <= nowMs) {
    return { allow: false, reason: 'invitation_expired' };
  }
  return { allow: true, accept: true };
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
