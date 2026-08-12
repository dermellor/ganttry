import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceOriginBadge } from './sourceOrigin';
import { switcherGroups } from './switcherRows';
import type { View } from './types';

// The badge beside the open timeline's name. These tests pin the wording, because
// the wording is the whole feature: „nur lesend" is what explains every affordance
// the viewer does not offer on this source.

test('an editable source shows no badge and still knows where it writes to', () => {
  const db = sourceOriginBadge('db', true, 'realtime');
  assert.equal(db.shown, false);
  assert.match(db.title, /sofort/);

  assert.match(sourceOriginBadge('db', true, 'poll').title, /Abruf/);
  assert.match(sourceOriginBadge('db', true, 'none').title, /Neuladen/);
  assert.match(sourceOriginBadge('local', true, 'none').title, /dorthin geschrieben/);
});

test('read-only is in the label, not only in the tooltip', () => {
  // A reader who never hovers still has to learn why nothing can be dragged.
  const ro = sourceOriginBadge('local', false, 'none');
  assert.equal(ro.shown, true);
  assert.equal(ro.label, 'Nur lesend');
  assert.equal(ro.tone, 'muted');
  assert.match(ro.title, /Statische Kopie/);

  assert.match(sourceOriginBadge('db', false, 'realtime').title, /nicht bearbeitbar/);
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
    for (const kind of ['db', 'local'] as const) {
      const { label } = sourceOriginBadge(kind, editable, 'none');
      if (label) assert.ok(!headings.includes(label), `„${label}" ist eine Switcher-Überschrift`);
    }
  }
});
