import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dirtyMigrationFiles,
  parseMigrationName,
  splitAtBreaking,
  validateMigrationNames,
} from './migration-rules.ts';

test('parseMigrationName accepts the established shape', () => {
  assert.deepEqual(parseMigrationName('0015_app_users.sql'), { num: 15, slug: 'app_users', breaking: false });
  assert.deepEqual(parseMigrationName('0000_prereq_roles.sql'), { num: 0, slug: 'prereq_roles', breaking: false });
});

test('parseMigrationName rejects anything that would sort unpredictably', () => {
  assert.equal(parseMigrationName('16_app_users.sql'), null, 'three digits sort after 0100');
  assert.equal(parseMigrationName('0016_AppUsers.sql'), null, 'case makes ordering platform-dependent');
  assert.equal(parseMigrationName('0016-app-users.sql'), null);
  assert.equal(parseMigrationName('notes.md'), null);
});

test('a *_breaking suffix is recognised as destructive', () => {
  assert.equal(parseMigrationName('0016_drop_item_title_breaking.sql')?.breaking, true);
  assert.equal(parseMigrationName('0016_add_item_title.sql')?.breaking, false);
});

test('the committed set is well-formed', () => {
  // Regression guard for the real filenames: a rename that breaks the convention
  // should fail here rather than at apply time.
  const problems = validateMigrationNames([
    '0000_prereq_roles.sql',
    '0001_init.sql',
    '0014_drop_item_title.sql',
    '0015_app_users.sql',
  ]);
  assert.deepEqual(problems, []);
});

test('a duplicate number is reported, because filename order is apply order', () => {
  const problems = validateMigrationNames(['0016_alpha.sql', '0016_beta.sql']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /0016 used 2×/);
  assert.match(problems[0], /renumber/);
});

test('gaps are allowed: a reverted migration leaves one, and renumbering renames history', () => {
  assert.deepEqual(validateMigrationNames(['0001_init.sql', '0005_later.sql']), []);
});

test('a malformed name is reported per file', () => {
  const problems = validateMigrationNames(['0001_init.sql', 'oops.sql']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^oops\.sql/);
});

test('splitAtBreaking stops before the breaking file, keeping the additive prefix', () => {
  const { additive, breaking } = splitAtBreaking(['0016_a.sql', '0017_b.sql', '0018_c_breaking.sql', '0019_d.sql']);
  assert.deepEqual(additive, ['0016_a.sql', '0017_b.sql']);
  assert.equal(breaking, '0018_c_breaking.sql');
});

test('splitAtBreaking passes a purely additive set through', () => {
  const { additive, breaking } = splitAtBreaking(['0016_a.sql', '0017_b.sql']);
  assert.deepEqual(additive, ['0016_a.sql', '0017_b.sql']);
  assert.equal(breaking, null);
});

test('splitAtBreaking yields nothing to apply when the breaking file is first', () => {
  const { additive, breaking } = splitAtBreaking(['0018_c_breaking.sql', '0019_d.sql']);
  assert.deepEqual(additive, []);
  assert.equal(breaking, '0018_c_breaking.sql');
});

test('dirtyMigrationFiles reads porcelain output, including untracked files', () => {
  const porcelain = ' M supabase/migrations/0015_app_users.sql\n?? supabase/migrations/0016_new.sql\n';
  assert.deepEqual(dirtyMigrationFiles(porcelain), [
    'supabase/migrations/0015_app_users.sql',
    'supabase/migrations/0016_new.sql',
  ]);
});

test('dirtyMigrationFiles ignores non-SQL noise and empty output', () => {
  assert.deepEqual(dirtyMigrationFiles(''), []);
  assert.deepEqual(dirtyMigrationFiles('?? supabase/migrations/README.md\n'), []);
});
