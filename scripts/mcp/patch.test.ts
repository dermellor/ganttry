// The MCP `update_*` tools document a partial patch. What they write through is
// a whole-column replace, so these are the tests that keep the documented
// contract and the actual write from drifting apart again — the remote
// `update_item` promised a merge and silently dropped every metadata key the
// caller had not resent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMetadata, resolveGroupPatch, resolveItemPatch } from './patch.ts';

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
