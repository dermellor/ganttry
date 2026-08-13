import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { groupToRow, rowToGroup } from './timeline-repo.ts';

// Every bug #137 was about had the same shape: a field added to `TimelineFile` and
// to a row mapper, while one of the hand-written column lists around it was not
// touched. Nothing failed — the write dropped the value, or the read never asked for
// it, and the setting looked supported while doing nothing.
//
// Three of those slipped through in one sitting while fixing exactly that class of
// bug: `getTimeline`'s select, `upsertGroup`'s insert/update/returning, and
// `replaceTimeline`'s group insert. So the guard is a source assertion rather than a
// convention — the same reasoning as the OpenAPI drift test and
// check-plugin-isolation, both of which read source instead of trusting discipline.
//
// It cannot run against a database: CI has none, deliberately (a contributor after
// `git clone` has none either). What it can do is compare what the mappers produce
// against what the statements name.

const SOURCE = readFileSync(join(import.meta.dirname, 'timeline-repo.ts'), 'utf8');

/** The column names `groupToRow` actually produces, which is the authority. */
const groupColumns = Object.keys(groupToRow('t', { id: 'g', content: 'G', color: '#fff' }, 0));

test('groupToRow and rowToGroup agree about every column', () => {
  const decl = { id: 'g', content: 'Gruppe', nestedGroups: ['a'], showNested: true, color: '#198754' };
  const round = rowToGroup(groupToRow('t', decl, 0));
  assert.deepEqual(round, decl, 'a field the row mapper drops is a field the DB never sees');
});

test('every statement touching timeline_groups names every mapped column', () => {
  // The three call sites, by the text that makes each identifiable.
  const statements = [
    { what: 'getTimeline select', text: sliceAround('from timeline_groups') },
    { what: 'upsertGroup', text: sliceAround('insert into timeline_groups ${sql(row') },
    { what: 'replaceTimeline insert', text: sliceAround('insert into timeline_groups ${sql(\n') },
  ];
  for (const { what, text } of statements) {
    for (const column of groupColumns) {
      // Two are legitimately not in every statement, and the reasons differ:
      //   timeline_id  written, never selected back onto the group.
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

test('getTimeline selects every timelines column the file carries', () => {
  const select = sliceAround('from timelines where id =');
  // `graph` and `group_order` were read from a row that never contained them: the
  // mapper checked `tl.group_order` while the select named six columns without it.
  for (const column of ['name', 'description', 'group_by', 'group_order', 'graph', 'phases', 'custom_fields']) {
    assert.ok(select.includes(column), `getTimeline does not select "${column}"`);
  }
});

test('replaceTimeline writes every timelines column it reads back', () => {
  const at = SOURCE.indexOf('export async function replaceTimeline');
  const body = SOURCE.slice(at, at + 2600);
  for (const column of ['group_by', 'group_order', 'graph', 'phases', 'custom_fields']) {
    assert.ok(body.includes(column), `replaceTimeline does not write "${column}"`);
  }
});

/** The statement a marker sits in: from the marker back to the previous `sql` tag. */
function sliceAround(marker: string): string {
  const at = SOURCE.indexOf(marker);
  assert.ok(at > 0, `marker not found in timeline-repo.ts: ${marker}`);
  const from = SOURCE.lastIndexOf('sql`', at - 200 > 0 ? at - 200 : 0);
  return SOURCE.slice(from > 0 ? from : at - 200, at + 400);
}
