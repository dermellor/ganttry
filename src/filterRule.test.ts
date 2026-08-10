import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeFilterDims,
  filterSelectionFromPair,
  filterValueCount,
  isFilterSelectionActive,
  passesFilters,
  pruneFilters,
  withFilterValues,
} from './filterRule';
import { NO_BUCKET, type SectionContext } from './listGrouping';
import type { TimelineItem } from './buildItems';
import type { CustomFieldDef } from './types';

// The filter holds a selection per dimension: AND across dimensions, OR within
// one. These tests pin the combination the single-dimension shape could not
// express, and the pruning that a timeline changing under its own filter needs.

const TIER: CustomFieldDef = {
  key: 'tier',
  label: 'Tier',
  type: 'multi-select',
  options: [{ value: 'Free' }, { value: 'Scale' }],
};

const GROUPS = [
  { id: 'g1', content: 'Alpha' },
  { id: 'g2', content: 'Beta' },
];

function item(id: string, extra: Partial<TimelineItem> = {}): TimelineItem {
  return { id, start: '2026-01-01', content: id, label: id, title: '', type: 'range', ...extra };
}

function ctx(meta: Record<string, Record<string, unknown>> = {}): SectionContext {
  return { groups: GROUPS, customFields: [TIER], metaOf: (id) => meta[id] };
}

test('an empty selection restricts nothing', () => {
  assert.equal(isFilterSelectionActive({}), false);
  assert.equal(isFilterSelectionActive({ status: [] }), false);
  assert.deepEqual(activeFilterDims({ status: [], tag: ['x'] }), ['tag']);
  assert.equal(passesFilters(item('a'), {}, ctx()), true);
});

test('values within one dimension are OR', () => {
  const filters = { status: ['Open', 'Doing'] };
  assert.equal(passesFilters(item('a', { status: 'Doing' }), filters, ctx()), true);
  assert.equal(passesFilters(item('b', { status: 'Done' }), filters, ctx()), false);
});

test('dimensions are AND, which is what the single-dimension shape could not do', () => {
  const filters = { status: ['Open'], 'cf:tier': ['Free'] };
  const c = ctx({ a: { tier: ['Free'] }, b: { tier: ['Scale'] } });
  assert.equal(passesFilters(item('a', { status: 'Open' }), filters, c), true);
  // Right tier, wrong status.
  assert.equal(passesFilters(item('b', { status: 'Open' }), filters, c), false);
  // Right status, no tier at all.
  assert.equal(passesFilters(item('c', { status: 'Open' }), filters, c), false);
});

test('an item without a value passes only via the Ohne bucket, per dimension', () => {
  const c = ctx();
  assert.equal(passesFilters(item('a'), { status: [NO_BUCKET] }, c), true);
  assert.equal(passesFilters(item('a', { status: 'Open' }), { status: [NO_BUCKET] }, c), false);
  // The bucket in one dimension does not excuse a miss in another.
  assert.equal(
    passesFilters(item('a', { group: 'g1' }), { status: [NO_BUCKET], group: ['g2'] }, c),
    false,
  );
});

test('a multi-valued item passes when any of its values is selected', () => {
  const c = ctx({ a: { tier: ['Free', 'Scale'] } });
  assert.equal(passesFilters(item('a'), { 'cf:tier': ['Scale'] }, c), true);
});

test('pruning drops a vanished dimension and keeps the others', () => {
  const pruned = pruneFilters(
    { status: ['Open'], 'cf:gone': ['x'] },
    ['status', 'group'],
    (dim) => (dim === 'status' ? ['Open', 'Done'] : []),
  );
  assert.deepEqual(pruned, { status: ['Open'] });
});

test('pruning drops a vanished value and keeps the dimension', () => {
  const pruned = pruneFilters({ status: ['Open', 'Gone'] }, ['status'], () => ['Open']);
  assert.deepEqual(pruned, { status: ['Open'] });
});

test('a dimension whose last value vanished loses its key', () => {
  const pruned = pruneFilters({ status: ['Gone'] }, ['status'], () => ['Open']);
  assert.deepEqual(pruned, {});
});

test('pruning nothing returns the same object, so callers can persist on identity', () => {
  const filters = { status: ['Open'] };
  assert.equal(pruneFilters(filters, ['status'], () => ['Open']), filters);
});

test('setting a dimension to no values removes it', () => {
  assert.deepEqual(withFilterValues({ status: ['Open'], tag: ['x'] }, 'status', []), { tag: ['x'] });
  assert.deepEqual(withFilterValues({}, 'status', ['Open']), { status: ['Open'] });
});

test('the stored single-dimension pair is read as a selection', () => {
  assert.deepEqual(filterSelectionFromPair('status', ['Open']), { status: ['Open'] });
  assert.deepEqual(filterSelectionFromPair('status', []), {});
  assert.deepEqual(filterSelectionFromPair('', ['Open']), {});
  assert.deepEqual(filterSelectionFromPair(undefined, undefined), {});
});

test('the value count is what the toolbar label reports', () => {
  assert.equal(filterValueCount({ status: ['Open', 'Done'], tag: ['x'] }), 3);
  assert.equal(filterValueCount({ status: [] }), 0);
});
