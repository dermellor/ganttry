import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { decodeFilterSelection, encodeFilterSelection } from './filterParam';
import { NO_BUCKET } from './listGrouping';

test('one dimension with one value stays readable', () => {
  assert.equal(encodeFilterSelection({ status: ['Open'] }), 'status:Open');
});

test('several values are comma-separated, several dimensions semicolon-separated', () => {
  assert.equal(
    encodeFilterSelection({ status: ['Open', 'Done'], owner: ['Ana'] }),
    'status:Open,Done;owner:Ana',
  );
});

test('a dimension key carrying a colon is encoded, so it cannot be split wrongly', () => {
  const encoded = encodeFilterSelection({ 'cf:tier': ['Free'] });
  assert.equal(encoded, 'cf%3Atier:Free');
  assert.deepEqual(decodeFilterSelection(encoded), { 'cf:tier': ['Free'] });
});

test('an empty selection encodes to nothing, so a plain link stays plain', () => {
  assert.equal(encodeFilterSelection({}), '');
  assert.equal(encodeFilterSelection({ status: [] }), '');
});

test('a value containing every separator survives the round trip', () => {
  const filters = { status: ['a,b', 'c;d', 'e:f', 'g\\h'] };
  assert.deepEqual(decodeFilterSelection(encodeFilterSelection(filters)), filters);
});

test('a value containing percent and plus survives, which URLSearchParams would not', () => {
  // `+` is the one that makes this parameter read out of the raw hash: through
  // URLSearchParams it would arrive as a space.
  const filters = { note: ['100%', 'a+b', ' leading space'] };
  assert.deepEqual(decodeFilterSelection(encodeFilterSelection(filters)), filters);
});

test('non-ASCII values survive', () => {
  const filters = { group: ['Phase 1 — Discovery'], 'cf:größe': ['groß'] };
  assert.deepEqual(decodeFilterSelection(encodeFilterSelection(filters)), filters);
});

test('the „Ohne …" bucket travels as itself', () => {
  // No prettier token: any readable one (`*`, `-`) would collide with a real value
  // of that name, and the sentinel already carries a leading space nothing else has.
  const filters = { owner: [NO_BUCKET, 'Ana'] };
  assert.deepEqual(decodeFilterSelection(encodeFilterSelection(filters)), filters);
});

test('dimension order is the selection\'s own, so two links are comparable', () => {
  assert.equal(
    encodeFilterSelection({ owner: ['Ana'], status: ['Open'] }),
    'owner:Ana;status:Open',
  );
});

test('an absent or empty parameter reads as no selection', () => {
  assert.deepEqual(decodeFilterSelection(null), {});
  assert.deepEqual(decodeFilterSelection(undefined), {});
  assert.deepEqual(decodeFilterSelection(''), {});
});

test('a repeated dimension unions instead of replacing', () => {
  assert.deepEqual(decodeFilterSelection('status:Open;status:Done,Open'), {
    status: ['Open', 'Done'],
  });
});

test('a malformed segment is skipped and takes nothing with it', () => {
  // No colon, an empty key, an empty value list, a truncated escape: each drops
  // itself, and the well-formed dimension beside it still arrives.
  assert.deepEqual(decodeFilterSelection('status:Open;garbage;:x;owner:;note:%2'), {
    status: ['Open'],
  });
});

test('a truncated escape inside a value list drops only that value', () => {
  assert.deepEqual(decodeFilterSelection('status:Open,%E0%A4%A'), { status: ['Open'] });
});
