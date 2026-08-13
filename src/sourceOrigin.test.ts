import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceOriginBadge } from './sourceOrigin';
import { switcherGroups } from './switcherRows';
import type { View } from './types';

// The badge beside the open timeline's name. These tests pin the wording, because
// the wording is the whole feature: „Nur lesend" is what names every affordance the
// viewer does not offer on this source.

test('an editable source shows no badge', () => {
  const badge = sourceOriginBadge(true);
  assert.equal(badge.shown, false);
  assert.equal(badge.label, '');
});

test('read-only is a label, and the badge carries nothing else', () => {
  // A reader who never hovers still has to learn why nothing can be dragged, so it
  // is a label and not a tooltip. It used to carry a sentence per source kind on
  // top of that — see „Interface text" in AGENTS.md.
  const ro = sourceOriginBadge(false);
  assert.equal(ro.shown, true);
  assert.equal(ro.label, 'Nur lesend');
  assert.equal(ro.tone, 'muted');
  assert.deepEqual(Object.keys(ro).sort(), ['label', 'shown', 'tone']);
});

test('the badge no longer repeats the switcher group it sits under', () => {
  // The pill used to read „Datenbank" while the switcher put the same word above
  // the row for this very timeline. Whichever way either wording moves, they must
  // not land on the same string again.
  const views = [
    { id: 'a', name: 'Roadmap', source: { kind: 'db' } },
    { id: 'b', name: 'Beispiel', source: { kind: 'local' } },
  ] as unknown as View[];
  const headings = switcherGroups(views, '', 'a').map((g) => g.label);

  for (const editable of [true, false]) {
    const { label } = sourceOriginBadge(editable);
    if (label) assert.ok(!headings.includes(label), `„${label}" ist eine Switcher-Überschrift`);
  }
});
