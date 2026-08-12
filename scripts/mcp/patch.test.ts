// The MCP `update_*` tools document a partial patch. What they write through is
// a whole-column replace, so these are the tests that keep the documented
// contract and the actual write from drifting apart again — the remote
// `update_item` promised a merge and silently dropped every metadata key the
// caller had not resent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendItemTo,
  applyItemPatchTo,
  mergeMetadata,
  resolveGroupPatch,
  resolveItemPatch,
} from './patch.ts';
import type { TimelineFileItem } from '../../src/types.ts';

test('mergeMetadata: patching one key leaves the others standing', () => {
  // The reported data loss, in its smallest form: an item tagged "Release" got
  // patched with a parent and came back carrying only the parent.
  const merged = mergeMetadata({ tags: ['Release'] }, { parent: 'D-12' });
  assert.deepEqual(merged, { tags: ['Release'], parent: 'D-12' });
});

test('mergeMetadata: a provided key wins over the stored one', () => {
  assert.deepEqual(mergeMetadata({ owner: 'a@b.c' }, { owner: 'd@e.f' }), { owner: 'd@e.f' });
});

test('mergeMetadata: null removes its key rather than storing a null', () => {
  const merged = mergeMetadata({ tags: ['Release'], owner: 'a@b.c' }, { owner: null });
  assert.deepEqual(merged, { tags: ['Release'] });
  assert.equal('owner' in merged, false);
});

test('mergeMetadata: the merge is shallow — a nested object is replaced whole', () => {
  // Documented as shallow on the tool. A deep merge would make a nested key
  // unremovable, and no consumer nests metadata today.
  const merged = mergeMetadata({ jira: { key: 'X-1', url: 'u' } }, { jira: { key: 'X-2' } });
  assert.deepEqual(merged, { jira: { key: 'X-2' } });
});

test('mergeMetadata: does not mutate the item it was given', () => {
  const current = { tags: ['Release'] };
  mergeMetadata(current, { parent: 'D-12', tags: null });
  assert.deepEqual(current, { tags: ['Release'] });
});

test('mergeMetadata: an item with no metadata yet takes the patch as-is', () => {
  assert.deepEqual(mergeMetadata(undefined, { parent: 'D-12' }), { parent: 'D-12' });
});

test('resolveItemPatch: merges metadata and passes every other field through', () => {
  const item = { id: 'i1', content: 'Ship', metadata: { tags: ['Release'] } };
  const out = resolveItemPatch(item, { content: 'Ship it', metadata: { parent: 'D-12' } });
  assert.deepEqual(out, { content: 'Ship it', metadata: { tags: ['Release'], parent: 'D-12' } });
});

test('resolveItemPatch: a patch that never mentions metadata leaves it alone', () => {
  // The key must stay absent: the endpoint only touches a column the patch names,
  // so adding `metadata` here would rewrite it on every unrelated edit.
  const item = { metadata: { tags: ['Release'] } };
  const out = resolveItemPatch(item, { content: 'Ship' });
  assert.deepEqual(out, { content: 'Ship' });
  assert.equal('metadata' in out, false);
});

test('resolveItemPatch: metadata null clears the whole object', () => {
  const out = resolveItemPatch({ metadata: { tags: ['Release'] } }, { metadata: null });
  assert.deepEqual(out, { metadata: {} });
});

test('resolveItemPatch: an empty metadata object is a no-op, not a clear', () => {
  // `{}` and `null` have to stay distinguishable, otherwise "merge nothing" would
  // wipe the item — the same class of bug this file exists for.
  const out = resolveItemPatch({ metadata: { tags: ['Release'] } }, { metadata: {} });
  assert.deepEqual(out, { metadata: { tags: ['Release'] } });
});

test('resolveGroupPatch: patching content keeps the nesting configuration', () => {
  // The group upsert rewrites content, nestedGroups and showNested from the body
  // alone, so an unmentioned field has to be carried along explicitly.
  const current = { id: 'g1', content: 'Team A', nestedGroups: ['g2', 'g3'], showNested: true };
  const out = resolveGroupPatch(current, { content: 'Team B' });
  assert.deepEqual(out, { id: 'g1', content: 'Team B', nestedGroups: ['g2', 'g3'], showNested: true });
});

test('resolveGroupPatch: an explicitly provided field still wins', () => {
  const current = { id: 'g1', content: 'Team A', nestedGroups: ['g2'] };
  const out = resolveGroupPatch(current, { nestedGroups: [] });
  assert.deepEqual(out, { id: 'g1', content: 'Team A', nestedGroups: [] });
});

// The two writes a plugin's tool produces, applied to the file the server pushes
// back. They live in patch.ts rather than in a server module because both servers
// connect a transport at import: a plain function over a file is the only shape of
// this logic that can be tested at all, which is why it was extracted.

const aFile = (items: TimelineFileItem[]) => ({ items: items.map((i) => ({ ...i })) });

test('applyItemPatchTo: a patch merges metadata and drops the object once empty', () => {
  const f = aFile([{ id: 'a', content: 'Frist', metadata: { owner: 'r@example.com', tags: ['X'] } }]);
  applyItemPatchTo(f, 'a', { metadata: { owner: null, tags: null } });
  // `{}` is never written: it is not the shape a read returns, so a round trip
  // through a tool would otherwise add a key to the file.
  assert.equal('metadata' in f.items[0], false);
});

test('applyItemPatchTo: end and duration never both survive', () => {
  const f = aFile([{ id: 'a', content: 'Phase', start: '2026-03-02', duration: '2w' }]);
  applyItemPatchTo(f, 'a', { end: '2026-03-20' });
  assert.deepEqual(f.items[0], { id: 'a', content: 'Phase', start: '2026-03-02', end: '2026-03-20' });

  applyItemPatchTo(f, 'a', { duration: '3w' });
  assert.deepEqual(f.items[0], { id: 'a', content: 'Phase', start: '2026-03-02', duration: '3w' });
});

test('applyItemPatchTo: an unknown item is a refusal, not a silent no-op', () => {
  // A tool's plan is applied whole or not at all, so this has to throw — a skipped
  // change would leave the timeline in a state the domain rule never described.
  assert.throws(() => applyItemPatchTo(aFile([]), 'nope', { start: '2026-03-02' }), /not found/);
});

test('appendItemTo: a duplicate id is refused and the extent rule is applied', () => {
  const seen: TimelineFileItem[] = [];
  const enforce = (item: TimelineFileItem) => {
    seen.push(item);
    delete item.duration;
  };
  const f = aFile([{ id: 'a', content: 'Da' }]);

  assert.throws(() => appendItemTo(f, { id: 'a', content: 'Nochmal' }, enforce), /already exists/);

  appendItemTo(f, { id: 'b', content: 'Neu', start: '2026-03-02', end: '2026-03-09', duration: '1w' }, enforce);
  assert.equal(seen.length, 1);
  assert.deepEqual(f.items[1], { id: 'b', content: 'Neu', start: '2026-03-02', end: '2026-03-09' });
});

test('appendItemTo: a null metadata is dropped rather than stored', () => {
  const f = aFile([]);
  appendItemTo(f, { content: 'Neu', metadata: null } as unknown as TimelineFileItem, () => {});
  assert.equal('metadata' in f.items[0], false);
});
