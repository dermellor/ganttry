// Guardrails on the migration set itself, as pure functions over filenames.
//
// Each one is here because of a failure that is cheap to prevent at the name and
// expensive to untangle afterwards. No filesystem, no database: the runner and the
// boot check both apply these, and ./migration-rules.test.ts covers them directly.

/** `0015_app_users.sql` → its parts. Null for anything not shaped like a migration. */
export function parseMigrationName(file: string): { num: number; slug: string; breaking: boolean } | null {
  const m = file.match(/^(\d{4})_([a-z0-9_]+)\.sql$/);
  if (!m) return null;
  return { num: Number(m[1]), slug: m[2], breaking: m[2].endsWith('_breaking') };
}

/**
 * Filename order IS apply order, so an ambiguous set silently picks an order
 * nobody intended. Two branches that each grab `0016_` merge cleanly in git and
 * then apply in alphabetical order of their slugs — which is not what either
 * author had in mind, and the mistake only shows up as a migration failing
 * against a table its predecessor was supposed to create.
 *
 * Gaps are allowed on purpose: a reverted migration leaves one, and renumbering
 * to close it would rename a file that other databases already record as applied,
 * which reads as "pending" to them forever.
 *
 * Returns human-readable problems; empty means the set is well-formed.
 */
export function validateMigrationNames(files: string[]): string[] {
  const problems: string[] = [];
  const byNum = new Map<number, string[]>();

  for (const file of files) {
    const parsed = parseMigrationName(file);
    if (!parsed) {
      problems.push(`${file}: name must be NNNN_lower_snake_case.sql`);
      continue;
    }
    byNum.set(parsed.num, [...(byNum.get(parsed.num) ?? []), file]);
  }

  for (const [num, names] of [...byNum].sort((a, b) => a[0] - b[0])) {
    if (names.length > 1) {
      problems.push(
        `number ${String(num).padStart(4, '0')} used ${names.length}× (${names.join(', ')}): ` +
          'filename order is apply order, so a duplicate number leaves it ambiguous — renumber the newer file',
      );
    }
  }

  return problems;
}

/**
 * A destructive migration is applied on its own, never swept along with others.
 *
 * A `*_breaking.sql` drops or rewrites something the *running* code may still
 * read, so it has to be sequenced by hand against a deploy: apply the additive
 * ones, ship the code that stopped using the old shape, then apply the breaking
 * one. Sweeping it up with the additive files takes the old shape away from code
 * that is still live, which is an outage rather than a migration.
 *
 * Returns the additive prefix and the breaking file that stopped the run.
 */
export function splitAtBreaking(pending: string[]): { additive: string[]; breaking: string | null } {
  const i = pending.findIndex((f) => parseMigrationName(f)?.breaking);
  if (i === -1) return { additive: pending, breaking: null };
  return { additive: pending.slice(0, i), breaking: pending[i] };
}

/**
 * Whether `git status --porcelain` output for the migrations directory means
 * "do not apply". Applying an uncommitted migration gives this database a schema
 * nobody else can reproduce, and editing the file afterwards leaves a checksum
 * that no longer matches what ran — a drift warning that then never goes away.
 *
 * Takes the porcelain text rather than shelling out, so the rule is testable.
 */
export function dirtyMigrationFiles(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // Porcelain lines are `XY path`; the path is what we want to report.
    .map((l) => l.replace(/^\S+\s+/, ''))
    .filter((p) => p.endsWith('.sql'));
}
