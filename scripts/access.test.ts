import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAccess, isPublicPath, parseDomains, type AccessConfig } from './access.ts';

const GATED: AccessConfig = { identityHeader: 'x-forwarded-email' };

test('no identity header configured: the server is open, by the operator\'s choice', () => {
  assert.deepEqual(decideAccess('/api/sources', undefined, {}), { allow: true });
  assert.deepEqual(decideAccess('/api/source/plan/item/a1', undefined, {}), { allow: true });
});

test('a configured gate refuses a request that carries no identity', () => {
  // The point of the whole arrangement: an origin reached directly, bypassing
  // the proxy, must not be editable. Fail closed.
  const d = decideAccess('/api/source/plan', undefined, GATED);
  assert.equal(d.allow, false);
  assert.equal((d as any).status, 401);
  // The refusal names the header, so a misconfigured proxy is diagnosable from
  // the response instead of from the source.
  assert.match((d as any).detail, /x-forwarded-email/);
});

test('an empty or whitespace header value counts as no identity', () => {
  for (const value of ['', '   ']) {
    assert.equal(decideAccess('/api/sources', value, GATED).allow, false);
  }
});

test('an identity passes, and is normalised for attribution', () => {
  const d = decideAccess('/api/sources', '  Anna@Example.COM ', GATED);
  assert.deepEqual(d, { allow: true, email: 'anna@example.com' });
});

test('the public pricing route stays reachable without an identity', () => {
  // Public by contract (security: [] in openapi.yaml) and fetched by external
  // pages that have no session; gating it would break the one integration the
  // API explicitly promises.
  assert.deepEqual(decideAccess('/api/pricing/acme', undefined, GATED), { allow: true });
  assert.deepEqual(decideAccess('/api/pricing', undefined, GATED), { allow: true });
});

test('a domain allow-list is matched exactly, not by suffix', () => {
  const config: AccessConfig = { ...GATED, allowedDomains: ['example.com'] };
  assert.equal(decideAccess('/api/sources', 'a@example.com', config).allow, true);
  // The trap a suffix test walks into.
  const evil = decideAccess('/api/sources', 'a@evil-example.com', config);
  assert.equal(evil.allow, false);
  assert.equal((evil as any).status, 403);
  // A subdomain is a different domain unless it is listed too.
  assert.equal(decideAccess('/api/sources', 'a@mail.example.com', config).allow, false);
});

test('an empty allow-list means any domain the proxy vouched for', () => {
  const config: AccessConfig = { ...GATED, allowedDomains: [] };
  assert.equal(decideAccess('/api/sources', 'a@anywhere.test', config).allow, true);
});

test('an address without a domain cannot satisfy an allow-list', () => {
  const config: AccessConfig = { ...GATED, allowedDomains: ['example.com'] };
  assert.equal(decideAccess('/api/sources', 'notanemail', config).allow, false);
});

test('parseDomains tolerates spacing, case and a leading @', () => {
  assert.deepEqual(parseDomains(' Example.com , @other.test ,, '), ['example.com', 'other.test']);
  assert.deepEqual(parseDomains(undefined), []);
  assert.deepEqual(parseDomains(''), []);
});

test('isPublicPath does not match a path that merely starts the same way', () => {
  assert.equal(isPublicPath('/api/pricing-secrets'), false);
  assert.equal(isPublicPath('/api/source/pricing'), false);
});
