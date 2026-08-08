import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envFilePaths, instanceFilePath } from './env.ts';

const HOME = '/home/tester';

test('envFilePaths: empty spec yields no paths', () => {
  assert.deepEqual(envFilePaths('', HOME), []);
  assert.deepEqual(envFilePaths('   ', HOME), []);
});

test('envFilePaths: expands a leading ~/ against the given home', () => {
  assert.deepEqual(envFilePaths('~/secrets/.env', HOME), ['/home/tester/secrets/.env']);
});

test('envFilePaths: a bare ~ is the home directory itself', () => {
  assert.deepEqual(envFilePaths('~', HOME), [HOME]);
});

test('envFilePaths: absolute paths pass through', () => {
  assert.deepEqual(envFilePaths('/etc/ganttry/.env', HOME), ['/etc/ganttry/.env']);
});

test('envFilePaths: splits on ":" and keeps order', () => {
  assert.deepEqual(envFilePaths('/a/.env:~/b/.env:/c/.env', HOME), [
    '/a/.env',
    '/home/tester/b/.env',
    '/c/.env',
  ]);
});

test('envFilePaths: trims whitespace and drops blank entries', () => {
  assert.deepEqual(envFilePaths(' /a/.env : : ~/b/.env ', HOME), ['/a/.env', '/home/tester/b/.env']);
});

test('envFilePaths: a "~" inside a path is not expanded', () => {
  // Only a leading '~/' is a home reference; '~' elsewhere is a literal character.
  assert.deepEqual(envFilePaths('/opt/a~b/.env', HOME), ['/opt/a~b/.env']);
});

test('instanceFilePath: a name resolves under the default profile directory', () => {
  assert.equal(
    instanceFilePath('acme', undefined, HOME),
    '/home/tester/.config/ganttry/instances/acme.env',
  );
});

test('instanceFilePath: an explicit directory wins, with ~/ expansion', () => {
  assert.equal(instanceFilePath('acme', '~/profiles', HOME), '/home/tester/profiles/acme.env');
  assert.equal(instanceFilePath('acme', '/etc/ganttry', HOME), '/etc/ganttry/acme.env');
});

test('instanceFilePath: a blank directory falls back to the default', () => {
  assert.equal(
    instanceFilePath('acme', '  ', HOME),
    '/home/tester/.config/ganttry/instances/acme.env',
  );
});

test('instanceFilePath: surrounding whitespace in the name is trimmed', () => {
  assert.equal(
    instanceFilePath('  acme  ', undefined, HOME),
    '/home/tester/.config/ganttry/instances/acme.env',
  );
});

test('instanceFilePath: no name means no profile', () => {
  assert.equal(instanceFilePath('', undefined, HOME), null);
  assert.equal(instanceFilePath('   ', undefined, HOME), null);
});

test('instanceFilePath: a name cannot escape the profile directory', () => {
  // The name addresses a file, so anything with a separator or a leading dot
  // is rejected outright rather than normalised into a path outside the dir.
  for (const bad of ['../secrets', 'a/b', '/etc/passwd', '.hidden', '~', 'a b']) {
    assert.equal(instanceFilePath(bad, undefined, HOME), null, `expected null for ${bad}`);
  }
});
