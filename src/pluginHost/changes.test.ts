// The change signal, and the two ways it is easy to get wrong.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { notifyTimelineChanged, onTimelineChanged, resetTimelineChangeListeners } from './changes';

describe('onTimelineChanged', () => {
  test('every listener is called, and unsubscribing stops one of them', () => {
    resetTimelineChangeListeners();
    const seen: string[] = [];
    const off = onTimelineChanged(() => seen.push('a'));
    onTimelineChanged(() => seen.push('b'));

    notifyTimelineChanged();
    assert.deepEqual(seen, ['a', 'b']);

    off();
    notifyTimelineChanged();
    assert.deepEqual(seen, ['a', 'b', 'b']);
  });

  test('a listener that unsubscribes itself does not make the next one be skipped', () => {
    // A view tearing down while being notified is ordinary, and mutating the set
    // mid-iteration would drop whoever came after it — silently, and only
    // sometimes, which is the worst shape a bug can have.
    resetTimelineChangeListeners();
    const seen: string[] = [];
    const off = onTimelineChanged(() => {
      seen.push('first');
      off();
    });
    onTimelineChanged(() => seen.push('second'));

    notifyTimelineChanged();
    assert.deepEqual(seen, ['first', 'second']);
  });

  test('a listener that throws costs nobody else their update', () => {
    // This runs at the end of the render path: one badly behaved plugin must not
    // take the view down with it.
    resetTimelineChangeListeners();
    const seen: string[] = [];
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      onTimelineChanged(() => {
        throw new Error('boom');
      });
      onTimelineChanged(() => seen.push('survivor'));
      notifyTimelineChanged();
    } finally {
      console.error = realError;
    }
    assert.deepEqual(seen, ['survivor']);
    assert.equal(errors.length, 1, 'and it is reported rather than swallowed');
  });
});
