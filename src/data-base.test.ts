import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_BASE, dataUrl } from './data-base';

// The module reads import.meta.env at load time, and the test runner supplies no
// Vite env, so DATA_BASE is the default here. That default is the contract for a
// single-instance setup, so pinning it is the point.
test('DATA_BASE: falls back to /data without VITE_DATA_BASE', () => {
  assert.equal(DATA_BASE, '/data');
});

test('dataUrl: joins a plain path onto the base', () => {
  assert.equal(dataUrl('config.json'), '/data/config.json');
  assert.equal(dataUrl('sources/launch-roadmap.json'), '/data/sources/launch-roadmap.json');
});

test('dataUrl: a leading slash in the argument does not double up', () => {
  // Callers write both forms; a '//' would still resolve but shows up in network
  // logs and in any string comparison against the URL.
  assert.equal(dataUrl('/config.json'), '/data/config.json');
  assert.equal(dataUrl('///config.json'), '/data/config.json');
});

test('dataUrl: an id keeps its namespace separator', () => {
  // Source ids carry a '/' for the data/<subdir>/ namespace, and that slash is
  // part of the id rather than a path separator to normalise away.
  assert.equal(dataUrl('sources/acme/roadmap.json'), '/data/sources/acme/roadmap.json');
});
