import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envFilePaths } from './env.ts';

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
