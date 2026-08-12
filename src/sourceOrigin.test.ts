import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceOriginBadge } from './sourceOrigin';

// The badge beside the open timeline's name. These tests pin the wording, because
// the wording is the whole feature: „nur lesend" is what explains every affordance
// the viewer does not offer on this source.

test('a live database source names its origin and how it stays current', () => {
  const realtime = sourceOriginBadge('db', true, 'realtime');
  assert.equal(realtime.label, 'Datenbank');
  assert.equal(realtime.tone, 'neutral');
  assert.match(realtime.title, /sofort/);

  assert.match(sourceOriginBadge('db', true, 'poll').title, /Abruf/);
  assert.match(sourceOriginBadge('db', true, 'none').title, /Neuladen/);
});

test('read-only is in the label, not only in the tooltip', () => {
  // A reader who never hovers still has to learn why nothing can be dragged.
  const ro = sourceOriginBadge('local', false, 'none');
  assert.equal(ro.label, 'Lokal · nur lesend');
  assert.equal(ro.tone, 'muted');
  assert.match(ro.title, /Statische Kopie/);
});

test('a local source is not called a file', () => {
  // It is a JSON file or a directory of Markdown notes, and the client is not told
  // which — a label naming one of them is wrong half the time.
  assert.equal(sourceOriginBadge('local', true, 'none').label, 'Lokal');
  assert.doesNotMatch(sourceOriginBadge('local', true, 'none').label, /Datei/);
});

test('an editable database source and a read-only one differ visibly', () => {
  const a = sourceOriginBadge('db', true, 'realtime');
  const b = sourceOriginBadge('db', false, 'realtime');
  assert.notEqual(a.label, b.label);
  assert.notEqual(a.tone, b.tone);
});
