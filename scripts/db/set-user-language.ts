// Set, clear or report the interface language of the people on this instance.
//
// Migration `0025` already gives every person who was in the directory when it
// ran an explicit `de`, so an instance that was German before #153 keeps every
// existing user on German without anybody running anything. This script is for
// the three things that migration cannot do, because they are decisions rather
// than facts:
//
//   * check what the instance actually holds, before or after a deploy;
//   * put a person on a language (somebody who joined after the migration, or
//     who asked);
//   * clear a choice, which is not the same as picking a default — a cleared row
//     follows `TIMELINES_DEFAULT_LANGUAGE` again, and a stored one never does.
//
// **Deliberately generic and committed.** Nothing here names an instance: it
// reads whichever one the env cascade resolves, the same way every other script
// in this folder does. „Issues are public: never file instance-specific ones"
// (AGENTS.md) is the same reasoning one level over — a script that hardcoded a
// deployment's addresses would put them in a public repository forever.
//
//   npx tsx scripts/db/set-user-language.ts --report
//   npx tsx scripts/db/set-user-language.ts --all de
//   npx tsx scripts/db/set-user-language.ts somebody@example.com en
//   npx tsx scripts/db/set-user-language.ts somebody@example.com --clear
//
// `--all` is the one that touches everybody, so it prints what it would do and
// refuses without `--yes`. A language sweep over a live instance is not something
// to discover you have run.

import { envValue, hydrateProcessEnv } from './env.ts';
import { resolveRepoFromEnv, closeRepoFromEnv } from './repo-node.ts';
import { LOCALES, normalizeLocale, type Locale } from '../../src/i18n/locale.ts';

function usage(problem?: string): never {
  if (problem) console.error(`set-user-language: ${problem}\n`);
  console.error(
    [
      'Usage:',
      '  set-user-language.ts --report',
      '  set-user-language.ts --all <de|en> [--yes]',
      '  set-user-language.ts <email> <de|en>',
      '  set-user-language.ts <email> --clear',
      '',
      `Languages: ${LOCALES.join(', ')}`,
      'A cleared row follows TIMELINES_DEFAULT_LANGUAGE again; a stored one does not.',
    ].join('\n'),
  );
  process.exit(problem ? 2 : 0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) usage();

  // The whole cascade, not bare `process.env`: an operator's credentials live in
  // an instance profile, and reading only the process environment would report
  // „no database" on an instance that has one.
  hydrateProcessEnv();
  const repo = resolveRepoFromEnv();
  if (!repo) {
    // Loudly, and naming the variable: „nothing happened" and „I could not reach
    // the database" look identical in a terminal, and the first sends somebody
    // looking for a bug in the script.
    console.error('set-user-language: no database configured (TIMELINES_DATABASE_URL / TIMELINES_SUPABASE_URL).');
    process.exit(1);
  }

  const users = await repo.listUsers();

  if (args[0] === '--report') {
    if (!users.length) {
      console.log('set-user-language: the directory is empty — nobody has signed in on this instance.');
      return;
    }
    const rows = await Promise.all(
      users.map(async (u) => ({ email: u.email, language: await repo.getUserLanguage(u.email) })),
    );
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.language ?? '(not chosen)', (counts.get(r.language ?? '(not chosen)') ?? 0) + 1);
    for (const r of rows.sort((a, b) => a.email.localeCompare(b.email))) {
      console.log(`  ${r.language ?? '(not chosen)'}\t${r.email}`);
    }
    console.log('');
    for (const [lang, n] of [...counts].sort()) console.log(`  ${n}\t${lang}`);
    const fallback = normalizeLocale(envValue('TIMELINES_DEFAULT_LANGUAGE'));
    console.log(`\n  TIMELINES_DEFAULT_LANGUAGE: ${fallback ?? '(unset — the product default, English)'}`);
    return;
  }

  if (args[0] === '--all') {
    const language = normalizeLocale(args[1]);
    if (!language) usage(`"${args[1] ?? ''}" is not one of ${LOCALES.join(', ')}`);
    if (!args.includes('--yes')) {
      console.log(`Would set ${users.length} user(s) to "${language}". Re-run with --yes.`);
      return;
    }
    for (const u of users) await repo.setUserLanguage(u.email, language);
    console.log(`set-user-language: ${users.length} user(s) set to "${language}".`);
    return;
  }

  const email = args[0];
  if (!email.includes('@')) usage(`"${email}" is not an address`);
  const clearing = args.includes('--clear');
  let language: Locale | null = null;
  if (!clearing) {
    language = normalizeLocale(args[1]);
    if (!language) usage(`"${args[1] ?? ''}" is not one of ${LOCALES.join(', ')}`);
  }
  // Not refused for an address with no row: `setUserLanguage` upserts, and an
  // instance can legitimately want somebody's language set before their first
  // sign-in creates the row.
  await repo.setUserLanguage(email, language);
  console.log(`set-user-language: ${email} → ${language ?? '(cleared — follows the instance default)'}`);
}

main()
  .then(() => closeRepoFromEnv())
  .catch(async (err) => {
    console.error(`set-user-language: ${err instanceof Error ? err.message : String(err)}`);
    await closeRepoFromEnv().catch(() => {});
    process.exit(1);
  });
