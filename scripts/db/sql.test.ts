import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceNamespace, connectionEnvKey, timelineInScope } from './sql.ts';

test('sourceNamespace: first path segment, or null for a bare id', () => {
  assert.equal(sourceNamespace('warehouse/plan'), 'warehouse');
  assert.equal(sourceNamespace('acme/roadmap'), 'acme');
  assert.equal(sourceNamespace('a/b/c'), 'a');
  assert.equal(sourceNamespace('bare-id'), null);
  assert.equal(sourceNamespace('/leading'), null); // no namespace before the slash
});

test('connectionEnvKey: TIMELINES_DATABASE_URL_<NS>, upper-cased and sanitised', () => {
  assert.equal(connectionEnvKey('warehouse'), 'TIMELINES_DATABASE_URL_WAREHOUSE');
  assert.equal(connectionEnvKey('my-warehouse'), 'TIMELINES_DATABASE_URL_MY_WAREHOUSE');
  assert.equal(connectionEnvKey('acme'), 'TIMELINES_DATABASE_URL_ACME');
  assert.equal(connectionEnvKey('a.b c'), 'TIMELINES_DATABASE_URL_A_B_C');
});

test('timelineInScope: empty subdir scopes to everything', () => {
  assert.equal(timelineInScope('acme/roadmap', ''), true);
  assert.equal(timelineInScope('bare-id', ''), true);
});

test('timelineInScope: a subdir scopes to its namespace prefix', () => {
  assert.equal(timelineInScope('acme/roadmap', 'acme'), true);
  assert.equal(timelineInScope('acme/sub/plan', 'acme'), true);
  assert.equal(timelineInScope('acme', 'acme'), true); // bare id equal to the subdir
  assert.equal(timelineInScope('acme-corp/roadmap', 'acme'), false); // prefix must end at a slash
  assert.equal(timelineInScope('other/roadmap', 'acme'), false);
  assert.equal(timelineInScope('bare-id', 'acme'), false);
});
