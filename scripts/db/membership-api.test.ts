// The invitation lifecycle, end to end through the dispatcher.
//
// Against a real Postgres rather than a fake repo, because the interesting parts
// are exactly the ones a fake would paper over: that re-inviting does not
// downgrade an accepted membership, that accepting clears the token, and that
// the last-admin guard sees the whole table. It SKIPS without a database, like
// its migration sibling — see the header there for why and how to run it.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { handleUsersApi } from './api.ts';
import { makePostgresRepo } from './timeline-repo.ts';
import { applyMigrations, freshTestDatabase, skipWithoutDatabase } from './test-database.ts';
import type { Member } from '../../src/types';

const ADMIN = { email: 'admin@example.test' };

test('membership management', { skip: skipWithoutDatabase() }, async (t) => {
  const sql = await freshTestDatabase('membership_api');
  const repo = makePostgresRepo(sql);

  const reset = async () => {
    await sql.unsafe('drop schema if exists public cascade; create schema public;');
    await applyMigrations(sql);
    // Every case needs somebody who may manage, and an instance that already has
    // an admin — which is also what makes the last-admin guard observable.
    await repo.inviteMember({ email: ADMIN.email, role: 'admin' });
    await repo.setMemberStatus(ADMIN.email, 'active');
  };

  const call = (method: string, body: unknown) =>
    handleUsersApi(repo, { method, caller: ADMIN, body });

  try {
    await t.test('inviting returns the token once, and stores only its hash', async () => {
      await reset();
      const res = await call('POST', { email: 'Guest@Example.test', role: 'viewer' });
      assert.equal(res.status, 201);
      const { member, inviteToken } = res.json as { member: Member; inviteToken: string };
      assert.equal(member.email, 'guest@example.test', 'the address is normalised');
      assert.equal(member.role, 'viewer');
      assert.equal(member.status, 'invited');
      assert.equal(member.invitedBy, ADMIN.email);
      assert.ok(inviteToken.length > 20, 'a token is handed back');
      assert.ok(member.inviteExpiresAt, 'and it expires');

      const [row] = await sql`select invite_token_hash from app_users where email = 'guest@example.test'`;
      assert.notEqual(row.invite_token_hash, inviteToken, 'the plain token is never stored');
      assert.match(row.invite_token_hash, /^[0-9a-f]{64}$/, 'a sha-256 hex digest is');

      // The listing must not leak it either.
      const list = (await call('GET', undefined)).json as { users: unknown[] };
      assert.equal(JSON.stringify(list).includes(inviteToken), false);
    });

    await t.test('an address without an @ is refused before anything is written', async () => {
      await reset();
      const res = await call('POST', { email: 'not-an-address' });
      assert.equal(res.status, 400);
      assert.equal((await repo.listMembers()).length, 1, 'nothing was created');
    });

    await t.test('an unknown role is refused rather than silently defaulted', async () => {
      await reset();
      await call('POST', { email: 'guest@example.test', role: 'viewer' });
      const res = await call('PATCH', { email: 'guest@example.test', role: 'owner' });
      assert.equal(res.status, 400);
      assert.equal((await repo.getMember('guest@example.test'))?.role, 'viewer', 'unchanged');
    });

    await t.test('re-inviting corrects the role without downgrading an accepted member', async () => {
      await reset();
      await call('POST', { email: 'guest@example.test', role: 'viewer' });
      await repo.setMemberStatus('guest@example.test', 'active');

      const res = await call('POST', { email: 'guest@example.test', role: 'editor' });
      assert.equal(res.status, 201);
      const { member } = res.json as { member: Member };
      assert.equal(member.role, 'editor', 'the correction lands');
      assert.equal(member.status, 'active', 'accepting is one-way');
    });

    await t.test('resending is only for somebody who has not accepted', async () => {
      await reset();
      await call('POST', { email: 'guest@example.test', role: 'editor' });

      const again = await call('PATCH', { email: 'guest@example.test', resend: true });
      assert.equal(again.status, 200);
      const second = (again.json as { inviteToken: string }).inviteToken;
      assert.ok(second, 'a fresh token');

      await repo.setMemberStatus('guest@example.test', 'active');
      const pointless = await call('PATCH', { email: 'guest@example.test', resend: true });
      assert.equal(pointless.status, 409);
      assert.equal((pointless.json as any).error, 'nothing_to_resend');
    });

    await t.test('the last active admin cannot be demoted, suspended or removed', async () => {
      await reset();
      for (const change of [{ role: 'editor' }, { status: 'suspended' }, { status: 'removed' }]) {
        const res = await call('PATCH', { email: ADMIN.email, ...change });
        assert.equal(res.status, 409, JSON.stringify(change));
        assert.equal((res.json as any).error, 'last_admin');
      }
      const still = await repo.getMember(ADMIN.email);
      assert.equal(still?.role, 'admin');
      assert.equal(still?.status, 'active');
    });

    await t.test('with a second admin in place the first one may step down', async () => {
      await reset();
      await call('POST', { email: 'second@example.test', role: 'admin' });
      // Still invited, so not yet an ACTIVE admin: the guard has to hold.
      assert.equal((await call('PATCH', { email: ADMIN.email, role: 'editor' })).status, 409);

      await repo.setMemberStatus('second@example.test', 'active');
      assert.equal((await call('PATCH', { email: ADMIN.email, role: 'editor' })).status, 200);
    });

    await t.test('a stranger cannot be patched into existence', async () => {
      await reset();
      const res = await call('PATCH', { email: 'ghost@example.test', role: 'admin' });
      assert.equal(res.status, 404);
    });

    await t.test('removing is a status, and the address stays resolvable', async () => {
      await reset();
      await call('POST', { email: 'guest@example.test', role: 'editor' });
      const res = await call('PATCH', { email: 'guest@example.test', status: 'removed' });
      assert.equal(res.status, 200);
      // Still there, so an item whose owner is this address still resolves to a
      // name rather than to nothing.
      assert.equal((await repo.getMember('guest@example.test'))?.status, 'removed');
    });

    await t.test('an unsupported method is refused', async () => {
      await reset();
      assert.equal((await call('DELETE', { email: 'guest@example.test' })).status, 405);
    });
  } finally {
    await sql.end();
  }
});
