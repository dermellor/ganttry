import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupByChoices,
  timelineMetaDraft,
  timelineMetaPatch,
  timelineName,
} from './timelineMeta';
import type { TimelineFile, View } from './types';
import { setLocale } from './i18n';
// The wording below is German, so these tests ask for German. The module reads
// the language from `src/i18n` module state rather than taking it as an argument
// (it renders, it does not validate), so the request is a `setLocale` here — the
// same move `fieldDefs.test.ts` makes with its `locale` parameter, and for the
// same reason: what is pinned is the rule, and the wording is only how it is
// observed. Without this the assertions would follow `DEFAULT_LOCALE` and break
// the day the product default changes.
setLocale('de');


const view = (name: string): View => ({
  id: 'src:x',
  name,
  source: { kind: 'db', id: 'x' },
});

const file = (over: Partial<TimelineFile> = {}): TimelineFile => ({ items: [], ...over });

// The name exists twice: the source's own and the one the build wrote into
// config.json. For a database timeline the second is a deploy-time snapshot, so
// these tests pin which one wins where.

test('the open timeline’s name comes from its source', () => {
  assert.equal(timelineName(view('Alter Name'), file({ name: 'Neuer Name' })), 'Neuer Name');
});

test('without a name in the source the built one stands', () => {
  assert.equal(timelineName(view('Gebaut'), file()), 'Gebaut');
  assert.equal(timelineName(view('Gebaut'), file({ name: '   ' })), 'Gebaut');
});

test('no view and no file is the empty string, not a crash', () => {
  assert.equal(timelineName(null, null), '');
});

test('the draft shows the stored default grouping, not the one in force', () => {
  const draft = timelineMetaDraft(view('X'), file({ groupBy: 'tag', description: 'Hallo' }));
  assert.deepEqual(draft, { name: 'X', description: 'Hallo', groupBy: 'tag' });
});

test('an unchanged draft sends nothing at all', () => {
  const current = { name: 'X', description: 'a', groupBy: 'tag' };
  assert.equal(timelineMetaPatch(current, { ...current }), null);
  // Whitespace is not a change either: trimming happens on both sides.
  assert.equal(timelineMetaPatch(current, { ...current, name: ' X ' }), null);
});

test('only changed keys are sent', () => {
  const current = { name: 'X', description: 'a', groupBy: '' };
  assert.deepEqual(timelineMetaPatch(current, { ...current, description: 'b' }), {
    description: 'b',
  });
});

test('a cleared field goes as an explicit null, because an absent key means leave it', () => {
  const current = { name: 'X', description: 'a', groupBy: 'tag' };
  assert.deepEqual(timelineMetaPatch(current, { ...current, description: '' }), {
    description: null,
  });
  assert.deepEqual(timelineMetaPatch(current, { ...current, groupBy: '' }), { groupBy: null });
});

test('an emptied name is a no-op rather than a clear', () => {
  // A timeline with no name shows as its id, so „" would replace a readable label
  // with a slug — never what somebody clearing the field meant.
  const current = { name: 'X', description: '', groupBy: '' };
  assert.equal(timelineMetaPatch(current, { ...current, name: '' }), null);
});

test('the grouping choices come from the timeline, not from the active build', () => {
  const choices = groupByChoices(
    file({ customFields: [{ key: 'tier', label: 'Tier', type: 'select', options: [] }] }),
  );
  assert.deepEqual(choices.map((c) => c.value), ['', 'tag', 'status', 'type', 'cf:tier']);
  assert.equal(choices[0].label, 'Gruppe (Standard)');
  assert.equal(choices.at(-1)?.label, 'Tier');
});

test('a custom field with a group is qualified, so two „Version" stay tellable apart', () => {
  const choices = groupByChoices(
    file({ customFields: [{ key: 'v', label: 'Version', type: 'select', options: [], group: 'Produkt' }] }),
  );
  assert.equal(choices.at(-1)?.label, 'Produkt · Version');
});
