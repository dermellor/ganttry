// What a plugin's data calls actually put on the wire.
//
// This is the part of the host API that decides which rows a plugin can reach,
// so it is tested rather than read: the plugin id is bound at construction, the
// lock counter must be a header, and every part has to be encoded exactly once
// or a scoped id and a composite row id both break.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { collectionPath, createDataApi } from './dataApi';

type Call = { url: string; init?: RequestInit };

function harness(pluginId = 'com.example.sprints', body: unknown = {}) {
  const calls: Call[] = [];
  const api = createDataApi(pluginId, {
    sourceId: () => 'wt/plan',
    json: async () => body,
    fetch: (async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      return {} as Response;
    }) as unknown as typeof fetch,
  });
  return { api, calls };
}

describe('collectionPath', () => {
  test('a scoped plugin id survives as one segment', () => {
    assert.equal(
      collectionPath('plan', '@acme/sprints', 'entries'),
      '/api/source/plan/plugin/%40acme%2Fsprints/entries',
    );
  });

  test('the timeline id keeps its slashes, because it is a path', () => {
    assert.equal(collectionPath('acme/plan', 'com.example.sprints', 'entries'), '/api/source/acme/plan/plugin/com.example.sprints/entries');
  });
});

describe('createDataApi', () => {
  test('the plugin id is bound, so a collection name cannot reach another plugin', async () => {
    const { api, calls } = harness('com.example.sprints', { rows: [] });
    await api.list('entries');
    assert.equal(calls[0].url, '/api/source/wt/plan/plugin/com.example.sprints/entries');
    // There is no argument that could have named a different plugin: the only
    // string the caller supplies is the collection, and it is encoded.
    await api.list('../../other/plugin/product-roadmap/tiers');
    assert.ok(calls[1].url.startsWith('/api/source/wt/plan/plugin/com.example.sprints/'));
    assert.ok(!calls[1].url.includes('product-roadmap/tiers'), 'the traversal is encoded away');
  });

  test('a version becomes If-Match and never part of the stored data', async () => {
    const { api, calls } = harness();
    await api.put('entries', { id: 'e1', data: { label: 'Sprint 1' }, version: 7 });
    const init = calls[0].init!;
    assert.equal((init.headers as Record<string, string>)['If-Match'], '7');
    assert.deepEqual(JSON.parse(String(init.body)), { id: 'e1', data: { label: 'Sprint 1' } });
  });

  test('no version means no If-Match, rather than a header with "undefined" in it', async () => {
    const { api, calls } = harness();
    await api.put('entries', { id: 'e1', data: {} });
    assert.ok(!('If-Match' in (calls[0].init!.headers as Record<string, string>)));
  });

  test('a composite row id is encoded, so it arrives as one segment', async () => {
    const { api, calls } = harness();
    await api.remove('tier-values', 'pro:calls');
    assert.equal(calls[0].url, '/api/source/wt/plan/plugin/com.example.sprints/tier-values/pro%3Acalls');
    assert.equal(calls[0].init!.method, 'DELETE');
  });

  test('move posts the anchor and returns the order the host decided', async () => {
    const { api, calls } = harness('com.example.sprints', { order: ['b', 'a'] });
    const order = await api.move('entries', 'b', { before: 'a' });
    assert.equal(calls[0].url, '/api/source/wt/plan/plugin/com.example.sprints/entries/move');
    assert.deepEqual(JSON.parse(String(calls[0].init!.body)), { id: 'b', before: 'a' });
    assert.deepEqual(order, ['b', 'a'], 'the host owns the order; the caller adopts it');
  });

  test('a host answering nothing useful yields empty rather than undefined', async () => {
    const { api } = harness('com.example.sprints', null);
    assert.deepEqual(await api.list('entries'), []);
    assert.deepEqual(await api.move('entries', 'a', { after: 'b' }), []);
  });
});
