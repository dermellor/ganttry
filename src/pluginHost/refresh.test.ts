// The reload after a host-API write.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { refreshAfterHostWrite, setTimelineRefresh } from './refresh';

describe('refreshAfterHostWrite', () => {
  test('calls what the app registered', () => {
    let calls = 0;
    setTimelineRefresh(() => {
      calls += 1;
    });
    refreshAfterHostWrite();
    refreshAfterHostWrite();
    assert.equal(calls, 2);
    setTimelineRefresh(null);
  });

  test('before the app registers anything it is a no-op, not a crash', () => {
    // A plugin write during startup, and every test that touches the host API,
    // arrives here with no reload registered.
    setTimelineRefresh(null);
    assert.doesNotThrow(() => refreshAfterHostWrite());
  });

  test('a failing reload does not surface to the plugin as a failed write', () => {
    // The write is already durable when this runs. Letting the repaint's failure
    // propagate would tell a plugin its write failed when it did not, which is
    // the one wrong answer available here.
    const realError = console.error;
    const seen: unknown[] = [];
    console.error = (...args: unknown[]) => seen.push(args);
    try {
      setTimelineRefresh(() => {
        throw new Error('boom');
      });
      assert.doesNotThrow(() => refreshAfterHostWrite());
      assert.equal(seen.length, 1, 'and it is reported rather than swallowed');
    } finally {
      console.error = realError;
      setTimelineRefresh(null);
    }
  });
})
