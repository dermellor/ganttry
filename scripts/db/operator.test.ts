// Who may install a plugin. Small surface, tested directly, because it is the
// only thing standing between „signed in" and „may load third-party code into
// everybody's session".

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { isOperator, operatorRefusal, parseOperators } from './operator.ts';

describe('parseOperators', () => {
  test('splits, trims and lowercases', () => {
    assert.deepEqual(parseOperators(' Alice@Example.com , bob@example.com '), [
      'alice@example.com',
      'bob@example.com',
    ]);
  });

  test('unset, empty and comma-only all mean nobody', () => {
    for (const raw of [undefined, null, '', '   ', ',,']) {
      assert.deepEqual(parseOperators(raw), [], JSON.stringify(raw));
    }
  });
});

describe('isOperator', () => {
  const operators = ['alice@example.com'];

  test('a configured address passes, case-insensitively', () => {
    assert.equal(isOperator({ email: 'alice@example.com' }, operators), true);
    assert.equal(isOperator({ email: 'Alice@Example.com' }, operators), true);
  });

  test('a signed-in address that is not on the list does not', () => {
    // The point of the whole module: passing the auth gate says „works here", not
    // „runs the place".
    assert.equal(isOperator({ email: 'carol@example.com' }, operators), false);
  });

  test('the MCP token is operator access, because it is a server-side secret', () => {
    assert.equal(isOperator({ mcp: true }, []), true);
  });

  test('with no operators configured, nobody passes over HTTP', () => {
    // Fail-closed, like ALLOWED_EMAIL_DOMAINS: an unconfigured instance must not
    // hand installation to the first person who signs in.
    assert.equal(isOperator({ email: 'alice@example.com' }, []), false);
    assert.equal(isOperator({}, []), false);
    assert.equal(isOperator({ email: null }, []), false);
  });
});

describe('operatorRefusal', () => {
  test('an unconfigured instance is told which variable to set', () => {
    // „forbidden" alone sends an operator hunting for a bug in the plugin.
    assert.match(operatorRefusal([]), /PLUGIN_OPERATOR_EMAILS to allow it/);
  });

  test('a configured one is told it is a limited list', () => {
    assert.match(operatorRefusal(['alice@example.com']), /limited to this instance's operators/);
  });
});
