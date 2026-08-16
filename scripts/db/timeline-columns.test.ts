import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { groupToRow, rowToGroup } from './timeline-repo.ts';

// Two rules about columns, pulling in opposite directions, and both learned the
// hard way within a day of each other:
//
//   READS are tolerant. A named column list fails outright when one of its columns
//   has not been migrated yet, so a schema lag becomes a 500 on the main read path.
//   That took the production timeline down on 2026-08-13 for a setting nobody had
//   used, because the deploy carried code that selected `timelines.group_order`
//   while the migration adding it had only been applied locally.
//
//   WRITES are strict. Every column a row mapper produces has to be named, because
//   a write that silently drops a value loses the setting the user just asked for —
//   and #137 was exactly that: fields added to the mapper while one of three
//   hand-written column lists stayed behind.
//
// Neither can be left to discipline. Both are source assertions rather than
// convention, for the same reason as the OpenAPI drift test and
// check-plugin-isolation: CI has no database on purpose, so nothing else here can
// notice.

const SOURCE = readFileSync(join(import.meta.dirname, 'timeline-repo.ts'), 'utf8');
const SUPABASE = readFileSync(join(import.meta.dirname, 'timeline-repo-supabase.ts'), 'utf8');

/** The column names `groupToRow` actually produces, which is the authority. */
const groupColumns = Object.keys(groupToRow('t', { id: 'g', content: 'G', color: '#fff' }, 0));

test('groupToRow and rowToGroup agree about every column', () => {
  const decl = { id: 'g', content: 'Gruppe', nestedGroups: ['a'], showNested: true, color: '#198754' };
  const round = rowToGroup(groupToRow('t', decl, 0));
  assert.deepEqual(round, decl, 'a field the row mapper drops is a field the DB never sees');
});

test('the timeline read is tolerant of a column that has not been migrated', () => {
  const pg = sliceAround(SOURCE, 'from timelines where id =');
  assert.ok(
    /select \*/.test(pg),
    'timeline-repo.ts getTimeline names columns; an unmigrated one would 500 the whole read',
  );
  const supa = sliceAround(SUPABASE, ".from('timelines')\n    .select(");
  assert.ok(
    /\.select\('\*'\)/.test(supa),
    'timeline-repo-supabase.ts getTimeline names columns; same failure through PostgREST',
  );
});

// The rule, stated precisely, because „never name columns" is too blunt: `*` is the
// wrong answer for a picker over every timeline or a watermark polled on an interval,
// where it would turn a cheap query into an expensive one.
//
// It is the reads that ASSEMBLE A TimelineFile that must be tolerant. Those are what
// a page load depends on, so an unmigrated column there is an outage rather than a
// missing feature. Narrow reads of long-standing columns elsewhere are fine: the only
// migration that could break one REMOVES a column, and those are named `*_breaking`
// and read by a human first.
//
// Scoped to `getTimeline` rather than to the tables, which is the lesson of writing
// this: asserting over every read of `timelines` produced an exemption list that grew
// by one entry per run — a list that long is a rule nobody can state.
test('getTimeline names no columns, in either driver', () => {
  for (const [driver, source] of [['postgres', SOURCE], ['supabase', SUPABASE]] as const) {
    const body = functionBody(source, 'getTimeline');
    const named = [
      // postgres: `select a, b from …`
      ...(body.match(/select\s+(?!\*)[a-z_]+\s*,/gi) ?? []),
      // supabase: `.select('a, b')`
      ...(body.match(/\.select\('(?!\*')[^']*'\)/g) ?? []),
      // …and the same list hidden behind a constant. `ITEM_SELECT` was exactly that:
      // a named projection reached through an identifier, which the two patterns above
      // cannot see. A guard bypassable by indirection is a guard that rots.
      ...(body.match(/\.select\([A-Z][A-Z_]*\)/g) ?? []),
      ...(body.match(/sql\.unsafe\([A-Z][A-Z_]*\)/g) ?? []),
    ];
    assert.deepEqual(
      named,
      [],
      `${driver} getTimeline names columns (${named.join(' / ')}); an unmigrated one fails the whole read`,
    );
  }
});

/** A function's body, from its declaration to the next top-level `export`. */
function functionBody(source: string, name: string): string {
  const at = source.indexOf(`export async function ${name}(`);
  assert.ok(at > 0, `no ${name} in this driver`);
  const next = source.indexOf('\nexport ', at + 10);
  return source.slice(at, next > 0 ? next : source.length);
}

test('every WRITE to timeline_groups names every mapped column', () => {
  const writes = [
    { what: 'upsertGroup', text: sliceAround(SOURCE, 'insert into timeline_groups ${sql(row') },
    { what: 'replaceTimeline insert', text: sliceAround(SOURCE, 'insert into timeline_groups ${sql(\n') },
  ];
  for (const { what, text } of writes) {
    for (const column of groupColumns) {
      // Two are legitimately absent, and the reasons differ:
      //   timeline_id  named separately as the key, not part of the patched set.
      //   sort         conditional in the mapper on purpose — `upsertGroup` leaves the
      //                existing order alone, so renaming a group cannot reshuffle it.
      if (column === 'timeline_id' || column === 'sort') continue;
      assert.ok(
        text.includes(column),
        `${what} does not mention "${column}" — the mapper produces it, so it is dropped silently`,
      );
    }
  }
});

// The third shape of the same failure. `scan` is a `TimelineMetaPatch` key with no
// column behind it, because a database timeline is not read by scanning a folder.
// Silently dropping it would answer `200` for a setting that was never stored —
// which is #137 again, one key later. Both drivers therefore refuse it, and this
// is a source assertion for the reason the two above are: CI has no database.
test('both drivers refuse a scan patch instead of dropping it', () => {
  for (const { what, text } of [
    { what: 'timeline-repo.ts', text: SOURCE },
    { what: 'timeline-repo-supabase.ts', text: SUPABASE },
  ]) {
    const at = text.indexOf('export async function updateMeta');
    assert.ok(at > 0, `${what} has no updateMeta`);
    const body = text.slice(at, at + 1800);
    assert.match(
      body,
      /if \('scan' in meta\) throw new NotSupportedError/,
      `${what} accepts a scan patch it has nowhere to put`,
    );
  }
});

test('replaceTimeline writes every timelines column the file carries', () => {
  const at = SOURCE.indexOf('export async function replaceTimeline');
  const body = SOURCE.slice(at, at + 2600);
  for (const column of ['group_by', 'group_order', 'graph', 'phases', 'custom_fields']) {
    assert.ok(body.includes(column), `replaceTimeline does not write "${column}"`);
  }
});

/** The statement a marker sits in: from the marker back to the previous `sql`/`from`. */
function sliceAround(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.ok(at > 0, `marker not found: ${marker}`);
  return source.slice(Math.max(0, at - 200), at + 400);
}
