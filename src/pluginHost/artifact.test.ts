import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { parseIntegrity, planFor, verifyIntegrity } from './artifact.ts';

const at = (kind: string, source?: string, integrity?: string) =>
  ({ id: 'p', artifact: { kind, ...(source ? { source } : {}), ...(integrity ? { integrity } : {}) } }) as any;

describe('planFor', () => {
  test('a built-in is not a download', () => {
    assert.deepEqual(planFor(at('builtin')), { action: 'builtin' });
  });

  test('an npm package is refused with the reason, not attempted', () => {
    // A browser has no registry lookup, no version solving and no node_modules.
    const plan = planFor(at('package', 'sprints@1.0.0'));
    assert.equal(plan.action, 'refuse');
    assert.match((plan as any).problem, /vendor it into the deploy or serve it at a URL/);
  });

  test('an artifact with no source cannot be fetched', () => {
    assert.equal(planFor(at('vendored')).action, 'refuse');
  });

  test('a remote artifact without a hash is refused even though install would have caught it', () => {
    // The registry is a table an operator can also write by hand; a row that
    // skipped the API must not skip the guarantee with it.
    const plan = planFor(at('url', 'https://example.com/p.js'));
    assert.equal(plan.action, 'refuse');
    assert.match((plan as any).problem, /not pinned to any version/);
  });

  test('a remote artifact with a hash is fetched, carrying the hash along', () => {
    const plan = planFor(at('url', 'https://example.com/p.js', 'sha384-abc'));
    assert.deepEqual(plan, { action: 'fetch', url: 'https://example.com/p.js', integrity: 'sha384-abc' });
  });

  test('a vendored artifact may go without a hash: the deploy serves its own bytes', () => {
    assert.deepEqual(planFor(at('vendored', '/plugins/sprints/index.js')), {
      action: 'fetch',
      url: '/plugins/sprints/index.js',
    });
  });
});

describe('parseIntegrity', () => {
  test('accepts the three SRI algorithms in the spelling <script integrity> uses', () => {
    assert.deepEqual(parseIntegrity('sha256-YWJj'), { algorithm: 'SHA-256', expected: 'YWJj' });
    assert.equal(parseIntegrity('sha384-YWJj')?.algorithm, 'SHA-384');
    assert.equal(parseIntegrity('sha512-YWJj')?.algorithm, 'SHA-512');
  });

  test('rejects anything else rather than guessing', () => {
    for (const bad of ['md5-YWJj', 'sha384', 'YWJj', 'sha384-not base64!', '']) {
      assert.equal(parseIntegrity(bad), null, bad);
    }
  });
});

describe('verifyIntegrity', () => {
  const bytes = new TextEncoder().encode('export const x = 1;\n').buffer as ArrayBuffer;

  async function hashOf(algorithm: 'SHA-256' | 'SHA-384'): Promise<string> {
    const digest = await crypto.subtle.digest(algorithm, bytes);
    return Buffer.from(new Uint8Array(digest)).toString('base64');
  }

  test('matching bytes pass', async () => {
    const value = `sha384-${await hashOf('SHA-384')}`;
    assert.deepEqual(await verifyIntegrity(bytes, value), { ok: true });
  });

  test('the algorithm named in the string is the one used', async () => {
    const value = `sha256-${await hashOf('SHA-256')}`;
    assert.equal((await verifyIntegrity(bytes, value)).ok, true);
  });

  test('changed bytes fail, and the message names both hashes', async () => {
    const value = `sha384-${await hashOf('SHA-384')}`;
    const tampered = new TextEncoder().encode('export const x = 2;\n').buffer as ArrayBuffer;
    const verdict = await verifyIntegrity(tampered, value);
    assert.equal(verdict.ok, false);
    assert.match(verdict.problem!, /does not match its pinned hash/);
  });

  test('an unparseable hash is a refusal, not a skipped check', async () => {
    // Treating a typo as "no hash given" is exactly the silently-unverified load
    // the field exists to prevent.
    const verdict = await verifyIntegrity(bytes, 'sha384-!!!');
    assert.equal(verdict.ok, false);
    assert.match(verdict.problem!, /not a recognised hash/);
  });
});
