import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exampleManifest } from './manifest';
import { exampleTools } from './tools';
import { validateManifest } from '../../pluginHost/manifest';

// TEMPLATE. Keep this file when you copy the folder; it is cheap and it catches
// the one failure that is not local to your plugin.
//
// `register()` validates a manifest and THROWS on a bad one, at module load. So a
// template whose manifest does not validate does not produce a plugin that fails
// to appear — it takes the whole app down, for everyone, on the first import. That
// is exactly what happened while the template still declared `id: 'example'` after
// ids became reverse-DNS: every copy of it inherited a manifest the host refuses.

test('the manifest validates, so a copy of this folder can be registered', () => {
  const result = validateManifest(exampleManifest);
  assert.equal(result.ok, true, result.ok ? '' : result.problems.join('\n'));
});

test('every declared tool has an implementation, and every implementation a declaration', () => {
  // The two live in different files and drift silently: a declared verb with no
  // handler is one an agent can see and cannot call, and a handler nobody declared
  // never becomes callable. `pluginTools()` reports both rather than guessing.
  const declared = new Set((exampleManifest.tools ?? []).map((t) => t.name));
  const implemented = new Set(Object.keys(exampleTools));
  assert.deepEqual([...declared].sort(), [...implemented].sort());
});

test('the catalogue entry is complete enough to publish', () => {
  // `plugins:catalogue:check` enforces this over the real plugins; asserting it
  // here means a copy starts from a shape that passes rather than from one that
  // fails on the day it ships.
  const entry = exampleManifest.catalogue;
  assert.ok(entry, 'a plugin without a catalogue entry cannot be published');
  assert.ok(entry.summary.trim().length > 0);
  assert.ok(entry.keywords.length > 0);
});
