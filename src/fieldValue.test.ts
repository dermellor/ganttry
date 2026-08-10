import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFieldPick, writeListMeta } from './fieldValue';

// Opening an item's form commits it, so a key whose representation churns there
// turns every click into a diff — `"dependsOn": []` did exactly that.
test('writeListMeta: an already-empty array is left exactly as stored', () => {
  const meta: Record<string, unknown> = { dependsOn: [] };
  writeListMeta(meta, 'dependsOn', []);
  assert.deepEqual(meta, { dependsOn: [] });
});

test('writeListMeta: a list that had entries and lost them loses its key', () => {
  const meta: Record<string, unknown> = { dependsOn: ['S-1'] };
  writeListMeta(meta, 'dependsOn', []);
  assert.deepEqual(meta, {});
});

test('writeListMeta: an absent key stays absent', () => {
  const meta: Record<string, unknown> = {};
  writeListMeta(meta, 'tags', []);
  assert.equal('tags' in meta, false);
});

test('writeListMeta: entries are written as a copy', () => {
  const meta: Record<string, unknown> = {};
  const values = ['a', 'b'];
  writeListMeta(meta, 'tags', values);
  assert.deepEqual(meta.tags, ['a', 'b']);
  assert.notEqual(meta.tags, values); // stored array is not the caller's
});

test('applyFieldPick: single-select replaces whatever was there', () => {
  assert.deepEqual(applyFieldPick([], '3.0', false), { values: ['3.0'], stored: '3.0' });
  assert.deepEqual(applyFieldPick(['2.0'], '3.0', false), { values: ['3.0'], stored: '3.0' });
  // Stored as a scalar, not a one-element array — the shape the form's <select> writes.
  assert.equal(typeof applyFieldPick(['2.0'], '3.0', false).stored, 'string');
});

test('applyFieldPick: an empty value on a single-select clears the field', () => {
  // „kein Wert": the key must disappear, not hold an empty string.
  assert.deepEqual(applyFieldPick(['3.0'], '', false), { values: [], stored: undefined });
});

test('applyFieldPick: multi-select toggles membership and keeps order', () => {
  const added = applyFieldPick(['free'], 'scale', true);
  assert.deepEqual(added, { values: ['free', 'scale'], stored: ['free', 'scale'] });
  // New values append, like the form's chip editor.
  assert.deepEqual(applyFieldPick(['free', 'scale'], 'starter', true).values, [
    'free',
    'scale',
    'starter',
  ]);
  // Picking a value it already has removes it, leaving the rest in place.
  assert.deepEqual(applyFieldPick(['free', 'scale', 'starter'], 'scale', true).values, [
    'free',
    'starter',
  ]);
});

test('applyFieldPick: untoggling the last multi-select value drops the key', () => {
  // The regression this guards: an emptied field must vanish so the persist diff
  // sends an explicit null. A stored `[]` would leave the old value on reload.
  assert.deepEqual(applyFieldPick(['free'], 'free', true), { values: [], stored: undefined });
});

test('applyFieldPick: an empty value on a multi-select changes nothing', () => {
  // A multi-select has no „kein Wert" row, so this can only come from bad input —
  // it must not store a blank member.
  assert.deepEqual(applyFieldPick(['free'], '', true), { values: ['free'], stored: ['free'] });
  assert.deepEqual(applyFieldPick([], '', true), { values: [], stored: undefined });
});
