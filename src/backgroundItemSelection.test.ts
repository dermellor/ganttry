import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachBackgroundItemSelection,
  backgroundIdFromTarget,
  isStoredBackground,
} from './backgroundItemSelection';

function classes(...names: string[]) {
  const set = new Set(names);
  return { contains: (name: string) => set.has(name) } as DOMTokenList;
}

test('stored backgrounds are interactive, generated phase tints are not', () => {
  assert.equal(isStoredBackground({ classList: classes('vis-item', 'vis-background') }), true);
  assert.equal(isStoredBackground({ classList: classes('vis-item', 'vis-background', 'phase-bg') }), false);
  assert.equal(isStoredBackground({ classList: classes('vis-item', 'vis-range') }), false);
});

test('backgroundIdFromTarget resolves an activation inside the marked box', () => {
  const box = { dataset: { backgroundItemId: 'clone::vacation' } };
  const child = { closest: (selector: string) => (selector === '[data-background-item-id]' ? box : null) };
  assert.equal(backgroundIdFromTarget(child as unknown as EventTarget), 'clone::vacation');
  assert.equal(backgroundIdFromTarget(null), null);
});

test('attachBackgroundItemSelection marks and activates a mounted stored background', async () => {
  const names = new Set(['vis-item', 'vis-background']);
  const attrs = new Map<string, string>();
  const box = {
    classList: {
      contains: (name: string) => names.has(name),
      add: (name: string) => names.add(name),
      remove: (name: string) => names.delete(name),
    },
    dataset: {} as Record<string, string>,
    tabIndex: -1,
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    removeAttribute: (name: string) => attrs.delete(name),
    hasAttribute: (name: string) => attrs.has(name),
  };
  const listeners = new Map<string, (event: any) => void>();
  const container = {
    addEventListener: (name: string, cb: (event: any) => void) => listeners.set(name, cb),
  };
  const timeline = {
    itemSet: { items: { vacation: { dom: { box }, data: { content: 'Urlaub' } } } },
    on: () => {},
  };
  const selected: string[] = [];

  attachBackgroundItemSelection(
    timeline as any,
    container as any,
    (id) => selected.push(id),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(box.dataset.backgroundItemId, 'vacation');
  assert.equal(names.has('interactive-background'), true);
  assert.equal(box.tabIndex, 0);
  assert.equal(attrs.get('role'), 'button');
  assert.equal(attrs.get('aria-label'), 'Urlaub bearbeiten');

  const target = { closest: () => box };
  listeners.get('pointerdown')?.({ target, clientX: 10, clientY: 10 });
  listeners.get('click')?.({
    target,
    clientX: 30,
    clientY: 10,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  assert.deepEqual(selected, [], 'panning from a background must not open it');

  const event = {
    key: 'Enter',
    target,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
  listeners.get('keydown')?.(event);
  assert.deepEqual(selected, ['vacation']);
});
