import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  graphGroupChoices,
  groupByChoices,
  groupOrderChoices,
  isScannedSource,
  orderFileFindsNothing,
  timelineMetaDraft,
  timelineMetaPatch,
  timelineName,
  type TimelineMetaDraft,
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

/** A draft with everything unset, so a test names only the field it is about. */
const draft = (over: Partial<TimelineMetaDraft> = {}): TimelineMetaDraft => ({
  name: 'X',
  description: '',
  groupBy: '',
  groupOrder: '',
  bandRootGroup: '',
  referenceGroup: '',
  orderFrom: '',
  ...over,
});

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
  const current = timelineMetaDraft(view('X'), file({ groupBy: 'tag', description: 'Hallo' }));
  assert.deepEqual(current, draft({ description: 'Hallo', groupBy: 'tag' }));
});

test('a groupBy stored as the default dimension shows as the default option', () => {
  // `"groupBy": "group"` says the same as no key at all, and only the empty option
  // exists for it. Unnormalized it matched no option, so the select rendered blank
  // and the next save of any other field cleared the key.
  const current = timelineMetaDraft(view('X'), file({ groupBy: 'group' }));
  assert.equal(current.groupBy, '');
  assert.equal(timelineMetaPatch(current, { ...current }), null);
});

test('the draft flattens the graph settings, empty meaning „not set"', () => {
  const current = timelineMetaDraft(
    view('X'),
    file({ groupOrder: 'declared', graph: { referenceGroup: '_Scenes' } }),
  );
  assert.deepEqual(current, draft({ groupOrder: 'declared', referenceGroup: '_Scenes' }));
});

test('an unchanged draft sends nothing at all', () => {
  const current = draft({ description: 'a', groupBy: 'tag', bandRootGroup: '_Plan' });
  assert.equal(timelineMetaPatch(current, { ...current }), null);
  // Whitespace is not a change either: trimming happens on both sides.
  assert.equal(timelineMetaPatch(current, { ...current, name: ' X ' }), null);
});

test('only changed keys are sent', () => {
  const current = draft({ description: 'a' });
  assert.deepEqual(timelineMetaPatch(current, { ...current, description: 'b' }), {
    description: 'b',
  });
});

test('a cleared field goes as an explicit null, because an absent key means leave it', () => {
  const current = draft({ description: 'a', groupBy: 'tag', groupOrder: 'declared' });
  assert.deepEqual(timelineMetaPatch(current, { ...current, description: '' }), {
    description: null,
  });
  assert.deepEqual(timelineMetaPatch(current, { ...current, groupBy: '' }), { groupBy: null });
  assert.deepEqual(timelineMetaPatch(current, { ...current, groupOrder: '' }), {
    groupOrder: null,
  });
});

test('an emptied name is a no-op rather than a clear', () => {
  // A timeline with no name shows as its id, so „" would replace a readable label
  // with a slug — never what somebody clearing the field meant.
  const current = draft();
  assert.equal(timelineMetaPatch(current, { ...current, name: '' }), null);
});

// `graph` is replaced whole on every path that writes it, so one changed control
// has to carry the other's stored value with it. Sending only the changed half
// would clear the other one on every save.
test('changing one graph setting sends both', () => {
  const current = draft({ bandRootGroup: '_Plan', referenceGroup: '_Scenes' });
  assert.deepEqual(timelineMetaPatch(current, { ...current, referenceGroup: '_Hints' }), {
    graph: { bandRootGroup: '_Plan', referenceGroup: '_Hints' },
  });
});

test('clearing the last graph setting clears the whole key', () => {
  // An empty object would read as „configured, to nothing" in the file and in the
  // column both.
  const current = draft({ referenceGroup: '_Scenes' });
  assert.deepEqual(timelineMetaPatch(current, { ...current, referenceGroup: '' }), {
    graph: null,
  });
});

test('a graph setting left alone sends no graph key at all', () => {
  const current = draft({ referenceGroup: '_Scenes' });
  assert.deepEqual(timelineMetaPatch(current, { ...current, description: 'b' }), {
    description: 'b',
  });
});

// ── scan.orderFrom ─────────────────────────────────────────────────────────
// The setting only exists on a source that is read by scanning a folder, and the
// PRESENCE of the scan block is what says so — a folder that has named no file
// still carries an empty one, and that is the folder somebody is here to fix.

test('a scanned folder is told from a timeline that is not one', () => {
  assert.equal(isScannedSource(file({ scan: {} })), true);
  assert.equal(isScannedSource(file()), false);
  assert.equal(isScannedSource(null), false);
});

test('the draft reads the order file out of the scan block', () => {
  const current = timelineMetaDraft(view('X'), file({ scan: { orderFrom: '_Index.md' } }));
  assert.deepEqual(current, draft({ orderFrom: '_Index.md' }));
});

// `scan` is MERGED by the store, unlike `graph`: the form holds one of its five
// keys, so sending the block whole would clear the four it never showed.
test('a changed order file sends the one key, not the whole block', () => {
  const current = draft({ orderFrom: '_Index.md' });
  assert.deepEqual(timelineMetaPatch(current, { ...current, orderFrom: '_Ablauf.md' }), {
    scan: { orderFrom: '_Ablauf.md' },
  });
});

test('a cleared order file deletes the key rather than storing an empty name', () => {
  const current = draft({ orderFrom: '_Index.md' });
  assert.deepEqual(timelineMetaPatch(current, { ...current, orderFrom: '' }), {
    scan: { orderFrom: null },
  });
});

test('a source that is not scanned never sends a scan key', () => {
  // The form draws no control there, so the draft carries '' on both sides — and
  // a `scan` key would reach a store that refuses one (both DB drivers, and the
  // file repo for a JSON source).
  const current = timelineMetaDraft(view('X'), file({ description: 'a' }));
  assert.deepEqual(timelineMetaPatch(current, { ...current, name: 'Y' }), { name: 'Y' });
});

test('an order file that positions nothing is reported, one that works is not', () => {
  const named = { scan: { orderFrom: '_Index.md' } };
  // Missing file, or no wikilink that resolves: one symptom, one statement.
  assert.equal(orderFileFindsNothing(file({ ...named, items: [{ id: 'a', content: 'A' }] })), true);
  assert.equal(
    orderFileFindsNothing(
      file({ ...named, items: [{ id: 'a', content: 'A', metadata: { sequence: 1 } }] }),
    ),
    false,
  );
  // An item that only INHERITS a position counts: the question is whether the
  // order file did anything at all, not how much of the folder it reached.
  assert.equal(
    orderFileFindsNothing(
      file({
        ...named,
        items: [
          { id: 'a', content: 'A', metadata: { sequence: 1, dependsOn: ['b'] } },
          { id: 'b', content: 'B' },
        ],
      }),
    ),
    false,
  );
  // Nothing to warn about where no file is named.
  assert.equal(orderFileFindsNothing(file({ scan: {}, items: [{ id: 'a', content: 'A' }] })), false);
});

test('the grouping choices come from the timeline, not from the active build', () => {
  const choices = groupByChoices(
    file({ customFields: [{ key: 'tier', label: 'Tier', type: 'select', options: [] }] }),
  );
  assert.deepEqual(choices.map((c) => c.value), ['', 'tag', 'status', 'type', 'cf:tier']);
  assert.equal(choices[0].label, 'Gruppe (Standard)');
  assert.equal(choices.at(-1)?.label, 'Tier');
});

test('the ordering choices mark the alphabetical one as the default it is', () => {
  const choices = groupOrderChoices();
  assert.deepEqual(choices.map((c) => c.value), ['', 'declared']);
  assert.equal(choices[0].label, 'Alphabetisch (Standard)');
});

test('a graph setting offers the declared groups by their own labels', () => {
  const choices = graphGroupChoices(
    file({ groups: [{ id: '_Scenes', content: 'Szenen' }, { id: '_Plan', content: '' }] }),
    [],
    '_Scenes',
    '_ungrouped',
  );
  assert.deepEqual(choices.map((c) => c.value), ['', '_Scenes', '_Plan']);
  assert.equal(choices[0].label, 'Keine');
  assert.equal(choices[1].label, 'Szenen');
  // No content declared: the id is the only name there is, and it beats an empty
  // option nobody can tell apart from „Keine".
  assert.equal(choices[2].label, '_Plan');
});

test('the groups a timeline never declared are offered too', () => {
  // The shipped examples name their groups on the items only. Offering `groups[]`
  // alone left both controls with nothing but „Keine" on exactly those timelines.
  const choices = graphGroupChoices(
    file({ groups: [{ id: 'a', content: 'A' }] }),
    [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: '_ungrouped', label: '—' }],
    '',
    '_ungrouped',
  );
  assert.deepEqual(choices.map((c) => c.value), ['', 'a', 'b']);
  // The absence of a value is not a value: nothing should head a band with it.
  assert.equal(choices.some((c) => c.value === '_ungrouped'), false);
});

test('a stored group that neither declares nor contains is still offered', () => {
  // A select reports its first option when its value matches none, so dropping the
  // stored value here would show „Keine" and then really clear it on the next save
  // of any other field.
  const choices = graphGroupChoices(file(), [], '_Scenes', '_ungrouped');
  assert.deepEqual(choices.map((c) => c.value), ['', '_Scenes']);
});

test('a custom field with a group is qualified, so two „Version" stay tellable apart', () => {
  const choices = groupByChoices(
    file({ customFields: [{ key: 'v', label: 'Version', type: 'select', options: [], group: 'Produkt' }] }),
  );
  assert.equal(choices.at(-1)?.label, 'Produkt · Version');
});
