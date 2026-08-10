import assert from 'node:assert/strict';
import test from 'node:test';
import { itemPresenceTreatment } from './itemPresenceTreatment';

function classes(...names: string[]): Pick<DOMTokenList, 'contains'> {
  const present = new Set(names);
  return { contains: (name: string) => present.has(name) };
}

test('ordinary timeline items keep the avatar and presence ring', () => {
  assert.equal(itemPresenceTreatment(classes('vis-item', 'vis-range')), 'ring');
});

test('a stored background title gets only the avatar', () => {
  assert.equal(
    itemPresenceTreatment(classes('vis-item', 'vis-range', 'background-item-label')),
    'avatar-only',
  );
});

test('the full-height background tint gets no duplicate presence decoration', () => {
  assert.equal(
    itemPresenceTreatment(classes('vis-item', 'vis-background', 'interactive-background')),
    'none',
  );
});
