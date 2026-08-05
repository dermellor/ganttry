import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activityRank,
  dedupeRoster,
  groupPresenceByItem,
  hueFor,
  initials,
  labelFor,
  type PresenceEntry,
} from './presenceModel';

const user = (email: string, extra: Partial<PresenceEntry> = {}): PresenceEntry => ({
  email,
  ...extra,
});

test('activityRank: editing > selected > merely connected', () => {
  assert.equal(activityRank(user('a@x')), 0);
  assert.equal(activityRank(user('a@x', { itemId: 'I-1' })), 1);
  assert.equal(activityRank(user('a@x', { itemId: 'I-1', editing: true })), 2);
  // `editing` without an item says nothing about where — treated as connected.
  assert.equal(activityRank(user('a@x', { editing: true })), 0);
});

test('dedupeRoster: one entry per email, keeping the newest announcement', () => {
  const roster = dedupeRoster([
    user('a@x', { itemId: 'I-1', at: 10 }),
    user('a@x', { itemId: 'I-2', editing: true, at: 30 }),
    user('a@x', { at: 20 }),
    user('b@x', { at: 5 }),
  ]);
  assert.deepEqual(
    roster.map((e) => [e.email, e.itemId, e.editing]),
    [
      ['a@x', 'I-2', true],
      ['b@x', null, false],
    ],
  );
});

// The regression that made a mark stick on "editiert gerade" forever: a channel
// roster keeps superseded metas, so the *stale* editing entry must lose to the
// fresher plain-selected one even though it says more.
test('dedupeRoster: a newer entry wins even when it says less than a stale one', () => {
  const roster = dedupeRoster([
    user('a@x', { itemId: 'I-1', editing: true, at: 100 }),
    user('a@x', { itemId: 'I-1', at: 200 }),
  ]);
  assert.deepEqual(
    roster.map((e) => [e.itemId, e.editing]),
    [['I-1', false]],
  );
  // …and the same set in the other arrival order resolves identically.
  const reversed = dedupeRoster([
    user('a@x', { itemId: 'I-1', at: 200 }),
    user('a@x', { itemId: 'I-1', editing: true, at: 100 }),
  ]);
  assert.deepEqual(
    reversed.map((e) => [e.itemId, e.editing]),
    [['I-1', false]],
  );
});

test('dedupeRoster: releasing an item is honoured, not outranked', () => {
  const roster = dedupeRoster([
    user('a@x', { itemId: 'I-1', at: 100 }),
    user('a@x', { itemId: null, at: 150 }),
  ]);
  assert.equal(roster[0].itemId, null);
});

test('dedupeRoster: a stamped entry beats an unstamped one, whatever it says', () => {
  const roster = dedupeRoster([
    user('a@x', { itemId: 'I-9', editing: true }),
    user('a@x', { itemId: null, at: 1 }),
  ]);
  assert.equal(roster[0].itemId, null);
});

test('dedupeRoster: without timestamps it falls back to the more specific entry', () => {
  const roster = dedupeRoster([user('a@x'), user('a@x', { itemId: 'I-1', editing: true })]);
  assert.deepEqual(
    roster.map((e) => [e.itemId, e.editing]),
    [['I-1', true]],
  );
});

test('dedupeRoster: normalises missing activity and drops entries without an email', () => {
  const roster = dedupeRoster([{ email: '' } as PresenceEntry, user('a@x', { name: 'A' })]);
  assert.deepEqual(roster, [
    { email: 'a@x', name: 'A', itemId: null, editing: false, at: undefined },
  ]);
});

test('dedupeRoster: an earlier entry is kept when nothing separates the two', () => {
  const roster = dedupeRoster([
    user('a@x', { itemId: 'I-1', at: 7 }),
    user('a@x', { itemId: 'I-9', at: 7 }),
  ]);
  assert.equal(roster[0].itemId, 'I-1');
});

test('groupPresenceByItem: buckets by item, dropping ourselves and the item-less', () => {
  const marks = groupPresenceByItem(
    [
      user('me@x', { itemId: 'I-1' }),
      user('a@x', { itemId: 'I-1' }),
      user('b@x', { itemId: 'I-2', editing: true }),
      user('c@x'),
    ],
    'me@x',
  );
  assert.deepEqual([...marks.keys()], ['I-1', 'I-2']);
  assert.deepEqual(
    marks.get('I-1')?.map((e) => e.email),
    ['a@x'],
  );
  assert.deepEqual(
    marks.get('I-2')?.map((e) => e.email),
    ['b@x'],
  );
});

test('groupPresenceByItem: editing users first, then a stable label order', () => {
  const marks = groupPresenceByItem(
    [
      user('zoe@x', { itemId: 'I-1' }),
      user('adam@x', { itemId: 'I-1' }),
      user('mid@x', { itemId: 'I-1', editing: true }),
    ],
    null,
  );
  assert.deepEqual(
    marks.get('I-1')?.map((e) => e.email),
    ['mid@x', 'adam@x', 'zoe@x'],
  );
});

test('groupPresenceByItem: without a known self identity nobody is filtered out', () => {
  const marks = groupPresenceByItem([user('a@x', { itemId: 'I-1' })], null);
  assert.equal(marks.get('I-1')?.length, 1);
});

test('initials: from the name, else the email local part', () => {
  assert.equal(initials(user('m@x', { name: 'Robin Fischer' })), 'MM');
  assert.equal(initials(user('m@x', { name: 'Prince' })), 'PR');
  assert.equal(initials(user('robin.fischer@x')), 'RF');
  assert.equal(initials(user('fischer@x')), 'FI');
});

test('hueFor: deterministic and in range', () => {
  assert.equal(hueFor('a@x'), hueFor('a@x'));
  assert.notEqual(hueFor('a@x'), hueFor('b@x'));
  for (const email of ['a@x', 'someone.else@example.com', '']) {
    const h = hueFor(email);
    assert.ok(h >= 0 && h < 360, `hue out of range for ${email}: ${h}`);
  }
});

test('labelFor: name plus email when known', () => {
  assert.equal(labelFor(user('m@x', { name: 'Robin' })), 'Robin (m@x)');
  assert.equal(labelFor(user('m@x')), 'm@x');
});
