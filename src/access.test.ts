import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DEFAULT_ROLE,
  MEMBER_ROLES,
  MEMBER_STATUSES,
  capabilityForMethod,
  decideSignIn,
  isActiveMember,
  maySignIn,
  memberCan,
  needsBootstrapPromotion,
  normalizeMemberRole,
  normalizeMemberStatus,
  roleAllows,
  wouldOrphanInstance,
  type Capability,
  type MemberRole,
  type MemberStatus,
} from './access.ts';

// The whole grant table, spelled out rather than derived. A test that rebuilds
// the rule from the same data structure the code uses passes whatever that
// structure says, including the day somebody widens it by accident.
const EXPECTED: Record<MemberRole, Record<Capability, boolean>> = {
  admin: { read: true, write: true, manage: true },
  editor: { read: true, write: true, manage: false },
  viewer: { read: true, write: false, manage: false },
};

test('every role carries exactly the capabilities it is meant to', () => {
  for (const role of MEMBER_ROLES) {
    for (const capability of ['read', 'write', 'manage'] as const) {
      assert.equal(
        roleAllows(role, capability),
        EXPECTED[role][capability],
        `${role} → ${capability}`,
      );
    }
  }
});

test('only an active membership counts, in every role', () => {
  for (const role of MEMBER_ROLES) {
    for (const status of MEMBER_STATUSES) {
      const member = { role, status };
      const active = status === 'active';
      assert.equal(isActiveMember(member), active, `${role}/${status}`);
      for (const capability of ['read', 'write', 'manage'] as const) {
        assert.equal(
          memberCan(member, capability),
          active && EXPECTED[role][capability],
          `${role}/${status} → ${capability}`,
        );
      }
    }
  }
});

test('an invited member may sign in but may do nothing yet', () => {
  const invited = { role: 'admin' as const, status: 'invited' as const };
  // Both halves matter: refusing the sign-in makes an invitation impossible to
  // accept, and granting the capability hands access to anybody an admin has
  // merely typed into the dialog.
  assert.equal(maySignIn(invited), true);
  assert.equal(memberCan(invited, 'read'), false);
  assert.equal(memberCan(invited, 'manage'), false);
});

test('suspended and removed are refused at the door as well as inside', () => {
  for (const status of ['suspended', 'removed'] as const) {
    const member = { role: 'admin' as const, status };
    assert.equal(maySignIn(member), false, `${status} may not sign in`);
    assert.equal(memberCan(member, 'read'), false, `${status} may not read`);
  }
});

test('no membership at all is a plain false, never a throw', () => {
  for (const absent of [null, undefined]) {
    assert.equal(memberCan(absent, 'read'), false);
    assert.equal(isActiveMember(absent), false);
    assert.equal(maySignIn(absent), false);
  }
});

test('read-only methods need read, everything else needs write', () => {
  for (const m of ['GET', 'get', 'HEAD', 'OPTIONS']) {
    assert.equal(capabilityForMethod(m), 'read', m);
  }
  for (const m of ['POST', 'PATCH', 'PUT', 'DELETE', 'patch']) {
    assert.equal(capabilityForMethod(m), 'write', m);
  }
});

test('manage never falls out of a method', () => {
  // `manage` is named at the user-management call sites on purpose: a PATCH on
  // an item and a PATCH on a member are the same verb with different stakes.
  const derived = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].map(capabilityForMethod);
  assert.equal(derived.includes('manage'), false);
});

test('normalizing accepts our values case-insensitively and rejects the rest', () => {
  assert.equal(normalizeMemberRole('ADMIN'), 'admin');
  assert.equal(normalizeMemberRole('  editor '), 'editor');
  assert.equal(normalizeMemberStatus('Invited'), 'invited');
  for (const junk of ['owner', 'member', '', 'super-admin', 42, null, undefined, {}]) {
    assert.equal(normalizeMemberRole(junk), undefined, `role ${String(junk)}`);
  }
  for (const junk of ['pending', 'deleted', 'banned', 7, null]) {
    assert.equal(normalizeMemberStatus(junk), undefined, `status ${String(junk)}`);
  }
});

test('the default role matches what migration 0016 gives existing rows', () => {
  // If these drift, applying 0016 stops being the no-op its comment promises.
  assert.equal(DEFAULT_ROLE, 'editor');
});

test('an instance is orphaned when no active admin would be left', () => {
  const admin = { role: 'admin' as const, status: 'active' as const };
  const editor = { role: 'editor' as const, status: 'active' as const };

  assert.equal(wouldOrphanInstance([]), true, 'nobody left');
  assert.equal(wouldOrphanInstance([editor]), true, 'an editor cannot invite');
  assert.equal(wouldOrphanInstance([admin]), false, 'one active admin is enough');
  assert.equal(
    wouldOrphanInstance([{ role: 'admin', status: 'suspended' }]),
    true,
    'a suspended admin cannot act, so it does not count',
  );
  assert.equal(
    wouldOrphanInstance([{ role: 'admin', status: 'invited' }]),
    true,
    'an admin who has never signed in cannot act either',
  );
});

test('the value lists and the union types cannot drift apart', () => {
  // Assigning each list to its union type is the compile-time half; the runtime
  // half is that nothing else sneaked in.
  const roles: readonly MemberRole[] = MEMBER_ROLES;
  const statuses: readonly MemberStatus[] = MEMBER_STATUSES;
  assert.deepEqual([...roles], ['admin', 'editor', 'viewer']);
  assert.deepEqual([...statuses], ['invited', 'active', 'suspended', 'removed']);
});

// ---- sign-in decision -------------------------------------------------------

const HOUR = 3600_000;
const NOW = Date.parse('2026-08-09T12:00:00Z');

test('a stranger is refused at the door', () => {
  for (const absent of [null, undefined]) {
    assert.deepEqual(decideSignIn(absent, NOW), { allow: false, reason: 'not_a_member' });
  }
});

test('an active member signs in without accepting anything', () => {
  assert.deepEqual(decideSignIn({ status: 'active' }, NOW), { allow: true, accept: false });
});

test('an invited member signs in, and that sign-in is the acceptance', () => {
  assert.deepEqual(
    decideSignIn({ status: 'invited', inviteExpiresAt: new Date(NOW + HOUR).toISOString() }, NOW),
    { allow: true, accept: true },
  );
});

test('an expired invitation is refused with its own reason', () => {
  assert.deepEqual(
    decideSignIn({ status: 'invited', inviteExpiresAt: new Date(NOW - 1).toISOString() }, NOW),
    { allow: false, reason: 'invitation_expired' },
  );
});

test('an invitation without a readable expiry is open-ended, not expired', () => {
  // Refusing on „I cannot read this date" would turn a storage quirk into a
  // lockout, and an invite created without an expiry is open by choice.
  for (const expiry of [undefined, null, '', 'not-a-date']) {
    assert.deepEqual(
      decideSignIn({ status: 'invited', inviteExpiresAt: expiry }, NOW),
      { allow: true, accept: true },
      String(expiry),
    );
  }
});

test('suspended and removed each refuse with their own reason', () => {
  assert.deepEqual(decideSignIn({ status: 'suspended' }, NOW), {
    allow: false,
    reason: 'membership_suspended',
  });
  assert.deepEqual(decideSignIn({ status: 'removed' }, NOW), {
    allow: false,
    reason: 'membership_removed',
  });
});

test('an expiry left on an active row never refuses them', () => {
  // Accepting clears it, but a row that skipped that path (a hand-written SQL
  // fix, an older invite) must not lock somebody out months later.
  assert.deepEqual(
    decideSignIn({ status: 'active', inviteExpiresAt: new Date(NOW - 99 * HOUR).toISOString() }, NOW),
    { allow: true, accept: false },
  );
});

// ---- the bootstrap master key -----------------------------------------------

test('the bootstrap address is promoted from whatever state its row is in', () => {
  const BOOT = 'owner@example.test';
  // The case that matters on an instance that has been running: the address is
  // already in the directory as an active editor, because 0015 backfilled it
  // from edit attribution. Firing only on a missing row would sign the owner in
  // as an editor into an instance with no admin at all.
  assert.equal(needsBootstrapPromotion({ role: 'editor', status: 'active' }, BOOT, BOOT), true);
  assert.equal(needsBootstrapPromotion(null, BOOT, BOOT), true, 'and a missing row too');
  assert.equal(needsBootstrapPromotion({ role: 'admin', status: 'suspended' }, BOOT, BOOT), true);
  assert.equal(needsBootstrapPromotion({ role: 'admin', status: 'removed' }, BOOT, BOOT), true);
});

test('an active admin is left alone, and so is everybody else', () => {
  const BOOT = 'owner@example.test';
  assert.equal(needsBootstrapPromotion({ role: 'admin', status: 'active' }, BOOT, BOOT), false);
  // Somebody who is not the bootstrap address is never promoted, whatever they are.
  assert.equal(needsBootstrapPromotion(null, 'someone@example.test', BOOT), false);
  assert.equal(
    needsBootstrapPromotion({ role: 'viewer', status: 'active' }, 'someone@example.test', BOOT),
    false,
  );
});

test('no bootstrap address configured promotes nobody', () => {
  for (const unset of [undefined, null, '', '   ']) {
    assert.equal(needsBootstrapPromotion(null, 'anyone@example.test', unset), false, String(unset));
  }
});

test('the bootstrap comparison ignores case and surrounding space', () => {
  assert.equal(needsBootstrapPromotion(null, 'Owner@Example.test', '  owner@example.test '), true);
});
