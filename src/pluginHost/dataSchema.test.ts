import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { unsupportedKeywords, validateRow } from './dataSchema.ts';

describe('unsupportedKeywords', () => {
  test('a schema using only the implemented subset is accepted', () => {
    assert.deepEqual(
      unsupportedKeywords({
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          kind: { enum: ['a', 'b'] },
          tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          weight: { type: 'number', minimum: 0, maximum: 1 },
        },
      }),
      [],
    );
  });

  test('an unimplemented keyword is reported instead of silently skipped', () => {
    // This is the point of the whole module: an author who writes `allOf` must
    // learn at load time that it would not be applied, not believe it was.
    const problems = unsupportedKeywords({ type: 'object', allOf: [{ type: 'object' }] });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /allOf/);
  });

  test('it reaches into nested properties and array items', () => {
    const problems = unsupportedKeywords({
      type: 'object',
      properties: { inner: { type: 'array', items: { type: 'string', format: 'email' } } },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /\.inner\[\]: unsupported keyword "format"/);
  });

  test('an unknown type name is reported', () => {
    assert.match(unsupportedKeywords({ type: 'date' })[0], /unknown type/);
  });
});

describe('validateRow: types', () => {
  test('no schema means no constraint', () => {
    assert.deepEqual(validateRow(undefined, { anything: true }), []);
  });

  test('a type mismatch stops there rather than piling on', () => {
    const problems = validateRow({ type: 'object', required: ['a', 'b'] }, 'not an object');
    assert.equal(problems.length, 1, 'the required check would be noise on a value of the wrong type');
    assert.match(problems[0], /expected object, got string/);
  });

  test('an integer satisfies number, a fractional number does not satisfy integer', () => {
    assert.deepEqual(validateRow({ type: 'number' }, 3), []);
    assert.equal(validateRow({ type: 'integer' }, 3.5).length, 1);
  });

  test('nullable is a type array, and null is its own type', () => {
    assert.deepEqual(validateRow({ type: ['string', 'null'] }, null), []);
    assert.equal(validateRow({ type: 'string' }, null).length, 1);
  });
});

describe('validateRow: objects', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1 }, note: { type: 'string' } },
  };

  test('a valid row passes', () => {
    assert.deepEqual(validateRow(schema, { name: 'Pro', note: 'x' }), []);
  });

  test('every problem is reported, not just the first', () => {
    const problems = validateRow(schema, { note: 5, extra: true });
    assert.equal(problems.length, 3, 'missing name, wrong note type, unknown property');
  });

  test('additionalProperties false rejects an unknown key by name', () => {
    assert.match(validateRow(schema, { name: 'Pro', typo: 1 })[0], /unknown property "typo"/);
  });

  test('additionalProperties as a schema applies to every extra key', () => {
    const bag = { type: 'object', additionalProperties: { type: 'string' } };
    assert.deepEqual(validateRow(bag, { a: 'x', b: 'y' }), []);
    assert.match(validateRow(bag, { a: 1 })[0], /row\.a: expected string/);
  });
});

describe('validateRow: strings, numbers and arrays', () => {
  test('minLength, maxLength and pattern', () => {
    assert.equal(validateRow({ type: 'string', minLength: 2 }, 'a').length, 1);
    assert.equal(validateRow({ type: 'string', maxLength: 2 }, 'abc').length, 1);
    assert.equal(validateRow({ type: 'string', pattern: '^v\\d+$' }, 'v2').length, 0);
    assert.equal(validateRow({ type: 'string', pattern: '^v\\d+$' }, 'x').length, 1);
  });

  test('an invalid pattern is reported rather than thrown', () => {
    // A bad regex in a manifest must not take the request down with a 500.
    const problems = validateRow({ type: 'string', pattern: '(' }, 'x');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not a valid regular expression/);
  });

  test('minimum and maximum', () => {
    assert.equal(validateRow({ type: 'number', minimum: 0 }, -1).length, 1);
    assert.equal(validateRow({ type: 'number', maximum: 10 }, 11).length, 1);
  });

  test('items applies per entry and reports the index', () => {
    const problems = validateRow({ type: 'array', items: { type: 'string' } }, ['a', 2]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /row\[1\]/);
  });

  test('uniqueItems compares structurally, not by reference', () => {
    const schema = { type: 'array', uniqueItems: true };
    assert.equal(validateRow(schema, [{ a: 1 }, { a: 1 }]).length, 1);
    assert.equal(validateRow(schema, [{ a: 1 }, { a: 2 }]).length, 0);
  });

  test('enum and const compare structurally too, so key order cannot fail a match', () => {
    assert.deepEqual(validateRow({ const: { a: 1, b: 2 } }, { b: 2, a: 1 }), []);
    assert.equal(validateRow({ enum: ['a', 'b'] }, 'c').length, 1);
  });
});
