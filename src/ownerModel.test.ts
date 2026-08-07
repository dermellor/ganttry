import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { displayName, indexUsers, matchUsers, resolveOwnerIn } from './ownerModel';
import type { DirectoryUser } from './types';

const USERS: DirectoryUser[] = [
  { email: 'robin@example.com', name: 'Robin Fischer' },
  { email: 'ada@example.com', name: 'Ada Lovelace' },
  { email: 'ops@example.com' }, // backfilled from edit attribution: address only
];
const IDX = indexUsers(USERS);

test('resolveOwnerIn: a known address resolves to its user', () => {
  const owner = resolveOwnerIn(IDX, 'ada@example.com');
  assert.equal(owner?.known, true);
  assert.equal(owner?.label, 'Ada Lovelace');
  assert.equal(owner?.user?.email, 'ada@example.com');
});

test('resolveOwnerIn: addresses are matched case-insensitively', () => {
  assert.equal(resolveOwnerIn(IDX, 'Ada@Example.com')?.user?.email, 'ada@example.com');
});

test('resolveOwnerIn: surrounding whitespace does not prevent a match', () => {
  const owner = resolveOwnerIn(IDX, '  ada@example.com  ');
  assert.equal(owner?.known, true);
  // The trimmed value is what the raw is reported as, so a re-save cannot
  // persist the padding back.
  assert.equal(owner?.raw, 'ada@example.com');
});

test('resolveOwnerIn: a legacy free-text value stays visible, marked unknown', () => {
  const owner = resolveOwnerIn(IDX, 'Strategy Team');
  assert.equal(owner?.known, false);
  assert.equal(owner?.label, 'Strategy Team');
  assert.equal(owner?.user, undefined);
});

test('resolveOwnerIn: empty / whitespace-only means no owner at all', () => {
  assert.equal(resolveOwnerIn(IDX, ''), null);
  assert.equal(resolveOwnerIn(IDX, '   '), null);
});

test('displayName: falls back to the address local part when no name is stored', () => {
  assert.equal(displayName({ email: 'ops@example.com' }), 'ops');
  assert.equal(displayName({ email: 'ops@example.com', name: '  ' }), 'ops');
  assert.equal(displayName({ email: 'ops@example.com', name: 'Ops Team' }), 'Ops Team');
});

test('matchUsers: an empty query offers the directory as ordered', () => {
  assert.deepEqual(
    matchUsers(USERS, '').map((u) => u.email),
    ['robin@example.com', 'ada@example.com', 'ops@example.com'],
  );
});

test('matchUsers: matches on name and on address, case-insensitively', () => {
  assert.deepEqual(matchUsers(USERS, 'lovel').map((u) => u.email), ['ada@example.com']);
  assert.deepEqual(matchUsers(USERS, 'ROBIN@').map((u) => u.email), ['robin@example.com']);
  // A name-less row is still findable by its address.
  assert.deepEqual(matchUsers(USERS, 'ops').map((u) => u.email), ['ops@example.com']);
});

test('matchUsers: no match yields nothing (the picker must not invent a user)', () => {
  assert.deepEqual(matchUsers(USERS, 'nobody'), []);
});

test('matchUsers: honours the limit', () => {
  assert.equal(matchUsers(USERS, '', 2).length, 2);
});
