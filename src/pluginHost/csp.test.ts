import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { buildCsp, originOf, parseOrigins } from './csp.ts';

/** Pull one directive's value out of the policy string. */
function directive(policy: string, name: string): string {
  const found = policy.split('; ').find((d) => d.startsWith(`${name} `));
  assert.ok(found, `${name} missing from: ${policy}`);
  return found!.slice(name.length + 1);
}

describe('buildCsp: closed by default', () => {
  const policy = buildCsp();

  test('with nothing configured the page may only talk to itself', () => {
    assert.equal(directive(policy, 'connect-src'), "'self'");
    assert.equal(directive(policy, 'default-src'), "'self'");
  });

  test('the two ways around connect-src are closed too', () => {
    // A form posting elsewhere, or an image URL carrying data, is exfiltration
    // with extra steps.
    assert.equal(directive(policy, 'form-action'), "'self'");
    assert.equal(directive(policy, 'img-src'), "'self' data:");
  });

  test('nothing may be framed, and nothing may frame us', () => {
    assert.equal(directive(policy, 'frame-src'), "'none'");
    assert.equal(directive(policy, 'frame-ancestors'), "'none'");
    assert.equal(directive(policy, 'object-src'), "'none'");
  });

  test('blob: is allowed for scripts, because the loader executes verified bytes', () => {
    // Importing the URL a second time instead would leave a window in which the
    // server may answer differently, making the hash check decorative.
    assert.match(directive(policy, 'script-src'), /'self' blob:/);
  });
});

describe('buildCsp: what an operator can widen', () => {
  test('a plugin origin reaches script-src and connect-src, and nothing else', () => {
    const policy = buildCsp({ pluginOrigins: ['https://plugins.example.com/some/path'] });
    assert.match(directive(policy, 'script-src'), /https:\/\/plugins\.example\.com/);
    assert.match(directive(policy, 'connect-src'), /https:\/\/plugins\.example\.com/);
    // Only the origin is taken: a path in a CSP source is matched as a prefix and
    // would quietly allow more or less than the operator meant.
    assert.ok(!policy.includes('/some/path'));
    assert.equal(directive(policy, 'form-action'), "'self'");
  });

  test('the realtime socket is listed separately from the https origin', () => {
    // connect-src matches the scheme, so an https:// entry does not cover the
    // wss:// socket Supabase Realtime opens to the same host.
    const connect = directive(buildCsp({ supabaseUrl: 'https://abc.supabase.co' }), 'connect-src');
    assert.match(connect, /https:\/\/abc\.supabase\.co/);
    assert.match(connect, /wss:\/\/abc\.supabase\.co/);
  });

  test('a http origin gets a ws socket, not a wss one', () => {
    const connect = directive(buildCsp({ supabaseUrl: 'http://localhost:54321' }), 'connect-src');
    assert.match(connect, /ws:\/\/localhost:54321/);
    assert.ok(!connect.includes('wss://localhost'));
  });

  test('the JIRA origin is allowed to be talked to but not to ship code', () => {
    const policy = buildCsp({ jiraUrl: 'https://acme.atlassian.net/rest/api/3' });
    assert.match(directive(policy, 'connect-src'), /https:\/\/acme\.atlassian\.net/);
    assert.ok(!directive(policy, 'script-src').includes('atlassian'));
  });

  test('duplicates collapse rather than repeating in the header', () => {
    const policy = buildCsp({
      supabaseUrl: 'https://abc.supabase.co',
      pluginOrigins: ['https://abc.supabase.co', 'https://abc.supabase.co/x'],
    });
    const occurrences = directive(policy, 'connect-src').split('https://abc.supabase.co').length - 1;
    assert.equal(occurrences, 1);
  });

  test('an unparseable origin is dropped instead of corrupting the header', () => {
    // A typo in an env var must not produce a policy the browser rejects wholesale,
    // which would leave the page with no protection at all.
    const policy = buildCsp({ pluginOrigins: ['not a url', ''], supabaseUrl: 'nonsense' });
    assert.equal(directive(policy, 'connect-src'), "'self'");
    assert.equal(directive(policy, 'script-src'), "'self' blob:");
  });
});

describe('originOf / parseOrigins', () => {
  test('a URL reduces to its origin', () => {
    assert.equal(originOf('https://example.com:8443/a/b?c=1'), 'https://example.com:8443');
  });

  test('anything that is not a URL is null', () => {
    for (const bad of [undefined, '', '   ', 'example.com', 'not a url']) {
      assert.equal(originOf(bad), null, String(bad));
    }
  });

  test('the allowlist splits, trims and drops empties', () => {
    assert.deepEqual(parseOrigins(' https://a.example , https://b.example ,, '), [
      'https://a.example',
      'https://b.example',
    ]);
    assert.deepEqual(parseOrigins(undefined), []);
  });
});
