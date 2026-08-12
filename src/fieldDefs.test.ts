import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fieldKeysInUse,
  formatFieldOptions,
  keyEditable,
  moveFieldDef,
  normalizeFieldDef,
  parseFieldOptions,
  selectRowsFor,
  validateFieldDefs,
} from './fieldDefs';
import type { CustomFieldDef, TimelineFileItem } from './types';

// The rules that keep an edit to a field definition from destroying data. Two of
// them carry the weight: a key that items already use may not be renamed (the values
// would be orphaned), and a key a plugin contributes may not be stored (the
// contributed definition wins, so the stored one would never appear).

const def = (over: Partial<CustomFieldDef> = {}): CustomFieldDef => ({
  key: 'tier',
  label: 'Tier',
  type: 'select',
  options: [{ value: 'Free' }],
  ...over,
});

const item = (metadata?: Record<string, unknown>): TimelineFileItem => ({
  content: 'x',
  ...(metadata ? { metadata } : {}),
});

test('a valid set has no problems', () => {
  assert.deepEqual(validateFieldDefs([def(), def({ key: 'note', label: 'Notiz', type: 'text' })]), []);
});

test('every problem is reported, not just the first', () => {
  const problems = validateFieldDefs([
    def({ key: '', label: '' }),
    def({ key: 'a b' }),
  ]);
  assert.equal(problems.length >= 3, true);
  assert.deepEqual([...new Set(problems.map((p) => p.index))], [0, 1]);
});

test('a duplicate key names the field it collides with', () => {
  const problems = validateFieldDefs([def(), def({ label: 'Zweites' })]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].index, 1);
  assert.match(problems[0].message, /schon vergeben \(Feld 1\)/);
});

test('a key with its own control in the form is refused', () => {
  const problems = validateFieldDefs([def({ key: 'owner', type: 'text', options: undefined })]);
  assert.match(problems[0].message, /eigenes Feld/);
});

test('a key a plugin contributes is refused rather than silently ignored', () => {
  // mergeFieldDefs lets the contributed definition win, so a stored one on the same
  // key would never appear — an edit that looks like it did not take.
  const problems = validateFieldDefs([def({ key: 'version' })], ['version']);
  assert.match(problems[0].message, /von einem Plugin/);
});

test('a choice without values cannot choose', () => {
  const problems = validateFieldDefs([def({ options: [] })]);
  assert.match(problems[0].message, /ohne Werte/);
  // A text field needs none.
  assert.deepEqual(validateFieldDefs([def({ type: 'text', options: [] })]), []);
});

test('a key is in use only while a value is actually stored', () => {
  const items = [
    item({ tier: 'Free' }),
    item({ empty: '', emptyList: [], nothing: null }),
    item(),
  ];
  const used = fieldKeysInUse(items);
  assert.deepEqual([...used], ['tier']);
  // Clearing the last value has to make the key renameable again, or a field can
  // never be corrected after one accidental entry.
  assert.equal(keyEditable('tier', used), false);
  assert.equal(keyEditable('empty', used), true);
  assert.equal(keyEditable('brandnew', used), true);
});

test('options round-trip through the textarea unchanged', () => {
  const text = 'Free\nScale = Skalierung\nEnterprise = Konzern #ff0066';
  const options = parseFieldOptions(text);
  assert.deepEqual(options, [
    { value: 'Free' },
    { value: 'Scale', label: 'Skalierung' },
    { value: 'Enterprise', label: 'Konzern', color: '#ff0066' },
  ]);
  assert.equal(formatFieldOptions(options), text);
});

test('an unparseable line is kept as a plain value rather than dropped', () => {
  // Losing a line somebody typed is worse than keeping it verbatim.
  assert.deepEqual(parseFieldOptions('  Weird  \n\n'), [{ value: 'Weird' }]);
});

test('normalizing drops what does not belong in the file', () => {
  assert.deepEqual(
    normalizeFieldDef({ key: ' tier ', label: ' Tier ', type: 'text', options: [{ value: 'x' }], contextMenu: true, group: '  ', width: 'half' }),
    { key: 'tier', label: 'Tier', type: 'text' },
  );
  assert.deepEqual(
    normalizeFieldDef(def({ contextMenu: true, group: 'Produkt', width: 'full' })),
    { key: 'tier', label: 'Tier', type: 'select', options: [{ value: 'Free' }], contextMenu: true, group: 'Produkt', width: 'full' },
  );
});

test('a stored value the definition dropped keeps a row of its own', () => {
  // Without it the select shows the empty row, and leaving the panel commits that
  // empty over the stored value: one removed option cleared the field on every item
  // that carried it. This was reproduced against the real form before the fix.
  const rows = selectRowsFor({ options: [{ value: 'Scale' }] }, 'Free');
  assert.deepEqual(rows, [
    { value: '', label: '— —', selected: false },
    { value: 'Scale', label: 'Scale', selected: false },
    { value: 'Free', label: 'Free (nicht in der Liste)', selected: true },
  ]);
});

test('a declared value gets no extra row, and no value selects the empty one', () => {
  const declared = selectRowsFor({ options: [{ value: 'Free', label: 'Gratis' }] }, 'Free');
  assert.deepEqual(declared, [
    { value: '', label: '— —', selected: false },
    { value: 'Free', label: 'Gratis', selected: true },
  ]);

  const empty = selectRowsFor({ options: [{ value: 'Free' }] }, '');
  assert.equal(empty.length, 2);
  assert.equal(empty[0].selected, true);
});

test('moving is clamped at both ends', () => {
  const list = ['a', 'b', 'c'];
  assert.deepEqual(moveFieldDef(list, 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(moveFieldDef(list, 2, 1), ['a', 'b', 'c']);
  assert.deepEqual(moveFieldDef(list, 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moveFieldDef(list, 2, -1), ['a', 'c', 'b']);
  // The input is never mutated: the caller holds the draft.
  assert.deepEqual(list, ['a', 'b', 'c']);
});
