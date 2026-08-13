// The domain rules this plugin contributes, as verbs an agent can call.
//
// This is the half of the plugin that fields cannot express. An agent gets
// `add_item` and `update_item` from the core; what it cannot get is the rule that
// decides which items move and where. Kept in a prompt, such a rule cannot be tested,
// cannot be reused, and is wrong in a way nobody notices until a date is wrong.
//
// Every rule here follows from „a tool is a pure function": it returns changes rather
// than performing them, it reads `now` from its context and never the clock, and it
// does no I/O and touches no DOM (this module is imported statically by the registry
// and by the process that serves agent calls, which has no DOM).
//
// Five rules the boundaries are chosen for, each with the failure it prevents:
//
//   - **No velocity, no capacity answer.** Absent, zero, negative and unparseable are
//     one case: the verbs say they cannot answer. Dividing by it would be a division
//     by zero, and defaulting to some number would produce a confident forecast out of
//     a value nobody entered.
//   - **An item with no usable estimate is named, never counted as zero.** A sum that
//     silently omits three items reads as a capacity statement and is not one.
//     „Usable" is what it says: the value is a `select` string, so `"8"` counts and
//     `""`, `"XL"` or a stray array do not.
//   - **`rebalance_sprint` relieves ONE sprint and stops.** A cascade rewrites the
//     rest of the roadmap out of a single call; an agent that wants the next sprint
//     relieved can ask again, and the note says so.
//   - **A write that cannot help is worse than a refusal.** Three of the rules below
//     exist for that one reason: finished work does not move, an item a successor
//     depends on does not move, and a sprint whose immovable part alone exceeds the
//     velocity is left untouched. A date rewrite with no possible benefit looks like
//     the tool worked, which is the one outcome nobody checks.
//   - **The verbs agree on what „the work in this sprint" is.** „Done" is decided by
//     `statusOrDefault` in every verb, and every item carrying an estimate is
//     accounted for in every answer, including the ones the raster does not place.
//     Two verbs disagreeing about the same scope is wrong in a way neither shows.

import { statusOrDefault, type ItemChange, type ToolHandler, type ToolPlan } from '../../pluginHost/api';
import type { TimelineFileItem } from '../../types';
import { STORY_POINTS_KEY } from './fields';
import {
  isDayString,
  rasterFrom,
  readSprintConfig,
  shiftDayString,
  sprintFirstDay,
  sprintLabel,
  sprintOfDay,
  sprintOfItem,
  sprintsInPlay,
  type SprintRaster,
} from './raster';

/**
 * The raster, or a refusal.
 *
 * Throwing rather than returning an empty plan: „nothing to do" is what an empty plan
 * says, and an unconfigured raster is not that. The message reaches the agent, which
 * is the only party that can fix the config.
 */
function requireRaster(config: Record<string, unknown>): SprintRaster {
  const raster = rasterFrom(readSprintConfig(config));
  if (!raster) {
    throw new Error(
      'Kein Sprintraster konfiguriert: `start` (Ankerdatum von Sprint 1, YYYY-MM-DD) fehlt oder ' +
        '`lengthDays` ist keine ganze Zahl ab 1.',
    );
  }
  return raster;
}

/** The velocity, or a refusal naming what is missing. */
function requireVelocity(raster: SprintRaster): number {
  if (raster.velocity == null) {
    throw new Error(
      'Ohne verwertbaren `velocity`-Wert in der Konfiguration ist nicht entscheidbar, was in einen ' +
        'Sprint passt. Diese Frage bleibt unbeantwortet, statt auf einer Annahme zu rechnen.',
    );
  }
  return raster.velocity;
}

/**
 * A value named in an error message so it cannot be mistaken for valid input.
 *
 * `String([3])` is `"3"`, so `{sprint: [3]}` was quoted back as „„3" ist keine
 * Sprintnummer" — an agent reading that sees the number it did not send and no reason
 * for the refusal. JSON keeps the brackets, the quotes and the type.
 */
function quoted(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // A value JSON cannot represent (a BigInt, a circular object) still has to be
    // named: an error path that throws its own error hides the actual problem.
  }
  return `<${typeof value}>`;
}

/** The sprint number an argument names. */
function sprintArg(args: Record<string, unknown>, required: boolean): number | null {
  const raw = args.sprint;
  if (raw == null) {
    if (required) throw new Error('`sprint` fehlt: erwartet ist die Nummer des Sprints, der entlastet werden soll.');
    return null;
  }
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${quoted(raw)} ist keine Sprintnummer: erwartet ist eine ganze Zahl ab 1.`);
  }
  return value;
}

/**
 * A plain decimal number, and nothing `Number()` is additionally willing to read.
 *
 * Bare `Number()` accepted `"0x10"` as 16 and `"1e3"` as 1000, so a typo in a
 * hand-written file entered a capacity sum as a number nobody wrote — and the sum
 * looked right, because a sum always does. „Usable" is a plain string of digits, which
 * is what this plugin's `AGENTS.md` promises.
 */
const DECIMAL_RE = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * The item's estimate, or null when it carries none that can be summed.
 *
 * A `select` field's value is a **string** in this data model (`readFieldValues` in
 * src/customFields.ts normalises the same way), so `"8"` is the normal shape and a
 * number is accepted for an agent that wrote one directly. Zero and negative values
 * are treated as „no usable estimate": they cannot move a sum, so counting them would
 * only hide them from the notes.
 */
function estimateOf(item: TimelineFileItem): number | null {
  const raw = item.metadata?.[STORY_POINTS_KEY];
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!DECIMAL_RE.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function totalPoints(items: readonly TimelineFileItem[]): number {
  return items.reduce((sum, item) => sum + (estimateOf(item) ?? 0), 0);
}

/**
 * A value at the resolution the notes print it at.
 *
 * Two decimals, so a fractional velocity leaves no trailing noise. The overflow guard
 * is the part that is not decoration: `value * 100` becomes Infinity above ~1.8e306,
 * and `Math.round(Infinity) / 100` printed „Infinity" for a sum of 2e307 — a finite
 * total reported as a number that is not one.
 */
function atPrintedResolution(value: number): number {
  const scaled = value * 100;
  if (!Number.isFinite(scaled)) return value;
  return Math.round(scaled) / 100;
}

/** A number in a note: no trailing noise from a fractional velocity. */
function points(value: number): string {
  return String(atPrintedResolution(value));
}

/**
 * Is the sum over the velocity, **at the resolution the note prints**?
 *
 * Comparing the raw floats let the verdict contradict the two numbers beside it:
 * `"0.1"` + `"0.2"` is 0.30000000000000004, so a velocity of 0.3 produced
 * „0.3 von 0.3 Punkten (überbucht)". Both sides are compared where they are shown, so
 * a reader can always check the verdict against the figures it is printed with.
 */
function overcommitted(sum: number, velocity: number): boolean {
  return atPrintedResolution(sum) > atPrintedResolution(velocity);
}

/**
 * „The sum is not a number a note can state", or nothing when it is.
 *
 * A total of Infinity divides, compares and prints as though it were a capacity, and
 * every answer built on it is arithmetic nobody can check. Saying so is the answer.
 */
function unusableSumNote(sum: number, where: string): string | null {
  if (Number.isFinite(sum)) return null;
  return (
    `${where}: Die Summe der Schätzungen ist keine darstellbare Zahl mehr (${String(sum)}). ` +
    'Solange einzelne Schätzungen so groß sind, ist keine Kapazitätsaussage möglich; die Werte gehören korrigiert.'
  );
}

/**
 * A counted noun in German. Notes are interface text an agent relays verbatim, and
 * „1 Einträge" is the kind of wrongness that makes the whole answer read as machine
 * output nobody checked.
 */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a person recognises the item by. The id is the fallback, never the first choice. */
function nameOf(item: TimelineFileItem): string {
  return item.content?.trim() || item.id || '(ohne Titel)';
}

function nameList(items: readonly TimelineFileItem[]): string {
  return items.map((item) => `„${nameOf(item)}"`).join(', ');
}

/**
 * The ids, for a note a caller has to act on. A title is what a person recognises, but
 * only an id addresses an item in a follow-up call.
 */
function idList(items: readonly TimelineFileItem[]): string {
  return items.map((item) => item.id?.trim() || `(ohne Id: ${nameOf(item)})`).join(', ');
}

/**
 * Code-unit order, never `localeCompare`.
 *
 * A collator answers 0 for two distinct strings it considers equal (an id carrying a
 * soft hyphen, `a` + U+00AD + `b`, against the same id without one), so a tie-break built on
 * it stops breaking ties exactly when it is
 * needed and hands the order back to however the source happened to list the items.
 */
function compareRaw(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Is this item finished? The one definition of „done" every verb here uses. */
function isDone(item: TimelineFileItem): boolean {
  return statusOrDefault(item.status) === 'Done';
}

function membersOf(raster: SprintRaster, items: readonly TimelineFileItem[], sprint: number): TimelineFileItem[] {
  return items.filter((item) => sprintOfItem(raster, item) === sprint);
}

/** Items the raster does not place: no start at all, or a start before the anchor. */
function outsideRaster(raster: SprintRaster, items: readonly TimelineFileItem[]): TimelineFileItem[] {
  return items.filter((item) => sprintOfItem(raster, item) == null);
}

/**
 * Which items point at which, through `metadata.dependsOn`.
 *
 * Restated here rather than imported: `extractDependsOn` lives in `src/buildItems.ts`,
 * which a plugin may not import (plugin isolation, see `AGENTS.md` in this folder), so
 * the accepted shapes have to agree with that function by hand — a list of ids, or a
 * single id written as a bare string. `dependsOn` is a core reserved metadata key
 * (`RESERVED_META_KEYS` in src/customFields.ts) and the relation graph draws an edge
 * for every entry, which is why a rule that moves dates has to read it.
 */
function dependentsByTarget(items: readonly TimelineFileItem[]): Map<string, TimelineFileItem[]> {
  const map = new Map<string, TimelineFileItem[]>();
  for (const item of items) {
    const raw = item.metadata?.dependsOn;
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    for (const entry of list) {
      const target = String(entry).trim();
      if (!target) continue;
      const known = map.get(target);
      if (known) known.push(item);
      else map.set(target, [item]);
    }
  }
  return map;
}

/** „ohne verwertbare Schätzung: …", or nothing when every item carries one. */
function missingEstimateNote(sprint: number, members: readonly TimelineFileItem[]): string | null {
  const missing = members.filter((item) => estimateOf(item) == null);
  if (!missing.length) return null;
  return (
    `${sprintLabel(sprint)}: ohne verwertbare Schätzung: ${nameList(missing)}. ` +
    `Eine Summe, in der ${count(missing.length, 'Eintrag fehlt', 'Einträge fehlen')}, ist keine Kapazitätsaussage.`
  );
}

/**
 * „Außerhalb des Rasters …", or nothing when the raster places every item.
 *
 * The counterpart of `missingEstimateNote`, for the same reason and against the same
 * failure: this verb iterates the sprints in play, so an item with no start or with a
 * start before the anchor appeared in no line at all — while `forecast_completion`
 * counted its points. A sum that silently omits three items reads as a capacity
 * statement and is not one, so the answer has to state the scope it did not place.
 */
function outsideRasterNote(raster: SprintRaster, items: readonly TimelineFileItem[]): string | null {
  const outside = outsideRaster(raster, items);
  if (!outside.length) return null;
  const sum = totalPoints(outside);
  return (
    `Außerhalb des Rasters und daher in keiner Sprint-Summe: ` +
    `${points(sum)} Punkte aus ${count(outside.length, 'Eintrag', 'Einträgen')} (${idList(outside)}), ` +
    `ohne Startdatum oder mit einem Start vor dem Anker ${raster.anchor}. ` +
    'Diese Antwort verortet diesen Umfang nicht.'
  );
}

/**
 * The sum of story points per sprint against the velocity. Writes nothing.
 *
 * Without a usable velocity it still reports the sums, and says in its first note that
 * they carry no yardstick: summing needs no velocity, and withholding the numbers
 * would be less useful than labelling them.
 */
export const checkSprintCapacity: ToolHandler = ({ file, config, args }): ToolPlan => {
  const raster = requireRaster(config);
  const items = file.items ?? [];
  const asked = sprintArg(args, false);
  const sprints = asked != null ? [asked] : sprintsInPlay(raster, items);
  // Only the sweep owes the out-of-raster line. A caller who named one sprint asked
  // about that sprint, and an unplaced item is not missing from that answer.
  const outside = asked == null ? outsideRasterNote(raster, items) : null;

  const notes: string[] = [];
  if (raster.velocity == null) {
    notes.push(
      'Ohne verwertbaren `velocity`-Wert in der Konfiguration lässt sich nicht sagen, ob ein Sprint ' +
        'überbucht ist. Die Summen unten stehen ohne Maßstab.',
    );
  }
  if (!sprints.length) {
    notes.push(`Kein Eintrag fällt in einen Sprint des Rasters (Anker ${raster.anchor}, ${raster.lengthDays} Tage).`);
    if (outside) notes.push(outside);
    return { notes };
  }

  for (const sprint of sprints) {
    const members = membersOf(raster, items, sprint);
    if (!members.length) {
      notes.push(`${sprintLabel(sprint)} ist leer.`);
      continue;
    }
    const sum = totalPoints(members);
    const unusable = unusableSumNote(sum, sprintLabel(sprint));
    if (unusable) {
      notes.push(unusable);
    } else {
      notes.push(
        raster.velocity == null
          ? `${sprintLabel(sprint)}: ${points(sum)} Punkte aus ${count(members.length, 'Eintrag', 'Einträgen')}.`
          : `${sprintLabel(sprint)}: ${points(sum)} von ${points(raster.velocity)} Punkten aus ` +
            `${count(members.length, 'Eintrag', 'Einträgen')} ` +
            `(${overcommitted(sum, raster.velocity) ? 'überbucht' : 'im Rahmen'}).`,
      );
    }
    const missing = missingEstimateNote(sprint, members);
    if (missing) notes.push(missing);
  }

  if (outside) notes.push(outside);
  return { notes };
};

/**
 * Move items out of one overcommitted sprint until the sum fits.
 *
 * The overflow order is „latest start first, then the larger estimate, then the item
 * id". It is a stand-in and the README says so: the core has no priority field, so the
 * rule a team would expect („lowest priority first") cannot be written. What it does
 * have is determinism, which is what keeps two runs from producing two different
 * roadmaps.
 *
 * A move shifts the start by exactly one sprint length and shifts the end with it, so
 * the item keeps its duration. An item stored with a `duration` instead of an `end`
 * keeps it without being touched.
 *
 * Four kinds of item are named and left where they are, and each one is a date rewrite
 * that could not have helped: an estimate bigger than the whole velocity, finished
 * work, an item some other item depends on, and an item whose id or dates cannot be
 * written back. When those four alone exceed the velocity, the call changes nothing at
 * all — see the refusal below.
 */
export const rebalanceSprint: ToolHandler = ({ file, config, args }): ToolPlan => {
  const raster = requireRaster(config);
  const velocity = requireVelocity(raster);
  const sprint = sprintArg(args, true)!;
  const items = file.items ?? [];
  const members = membersOf(raster, items, sprint);

  if (!members.length) return { notes: [`${sprintLabel(sprint)} ist leer, es gibt nichts zu entlasten.`] };

  const before = totalPoints(members);
  const trailing: string[] = [];
  const missing = missingEstimateNote(sprint, members);
  if (missing) trailing.push(missing);

  const unusable = unusableSumNote(before, sprintLabel(sprint));
  if (unusable) return { notes: [unusable, ...trailing] };

  if (!overcommitted(before, velocity)) {
    return {
      notes: [`${sprintLabel(sprint)}: ${points(before)} von ${points(velocity)} Punkten, nicht überbucht.`, ...trailing],
    };
  }

  // Finished work is not a capacity lever: its points stay in the sum, because the
  // capacity was consumed, but moving it would re-date work that is over. Reading the
  // status through the same helper `forecast_completion` uses is the point — the two
  // verbs used to disagree about what „the work in this sprint" is, and on the shipped
  // example `rebalance_sprint` moved an item marked „Done".
  const done = members.filter(isDone);
  if (done.length) {
    trailing.push(
      `Abgeschlossene Arbeit wird nicht verschoben (${nameList(done)}): sie zählt weiter in der Summe, weil die ` +
        'Kapazität verbraucht ist, aber ein neues Datum daran würde fertige Arbeit umdatieren.',
    );
  }

  const dependents = dependentsByTarget(items);

  const movable: TimelineFileItem[] = [];
  for (const item of members) {
    const estimate = estimateOf(item);
    if (estimate == null) continue;
    if (overcommitted(estimate, velocity)) {
      // Moving this one relieves nothing: it does not fit in ANY sprint of this
      // raster, so each call would push it one sprint further down the roadmap and
      // the sprint it lands in would be overcommitted by the same item. Saying so is
      // the answer; „move it forever" is not.
      trailing.push(
        `„${nameOf(item)}" trägt ${points(estimate)} Punkte und passt damit in keinen Sprint mit ` +
          `velocity ${points(velocity)}. Verschieben schiebt das Problem weiter: entweder den Eintrag ` +
          'aufteilen oder die velocity korrigieren.',
      );
      continue;
    }
    if (isDone(item)) continue;
    // Trimmed, because `validateToolPlan` refuses a plan whose `itemId` is blank: an
    // id of `"  "` passed a plain falsy check, and the whole plan was then rejected —
    // so one whitespace id made a genuinely overcommitted sprint unrelievable.
    const id = item.id?.trim();
    if (!id) {
      // A plan addresses an item by id, so one without an id cannot be moved. It
      // stays in the sum, which is why the remaining overcommitment is reported below.
      trailing.push(`„${nameOf(item)}" hat keine Id und kann daher nicht verschoben werden.`);
      continue;
    }
    const waiting = dependents.get(id);
    if (waiting?.length) {
      // Moving a predecessor past its successor's start is how a plan starts
      // contradicting itself: the relation graph then draws the edge backwards. The
      // successors are deliberately NOT moved along — that is the same „one call
      // rewrites the roadmap" trade the no-cascade rule already refuses.
      trailing.push(
        `„${nameOf(item)}" wird nicht verschoben: ${nameList(waiting)} ${
          waiting.length === 1 ? 'hängt' : 'hängen'
        } davon ab (\`dependsOn\`), und ein späteres Ende würde vor dem Start des Nachfolgers liegen. ` +
          'Nachfolger werden hier nicht mitverschoben; das wäre eine Umschreibung des restlichen Plans aus einem Aufruf.',
      );
      continue;
    }
    if (item.end != null && shiftDayString(item.end, raster.lengthDays) == null) {
      // Shifting the start alone would stretch the item by a sprint length as a side
      // effect of rebalancing, which is a change nobody asked for.
      trailing.push(`„${nameOf(item)}" hat ein Ende, das sich nicht verschieben lässt (${String(item.end)}).`);
      continue;
    }
    if (shiftDayString(item.start, raster.lengthDays) == null) {
      // A start the raster could read but the shift cannot write back (a date near the
      // end of the four-digit year range, or a format only `new Date` understands).
      // Skipping it silently left it neither moved nor named, and the sum unexplained.
      trailing.push(`„${nameOf(item)}" hat einen Start, der sich nicht verschieben lässt (${String(item.start)}).`);
      continue;
    }
    movable.push(item);
  }

  // What cannot move at all. When that alone exceeds the velocity, every move this
  // call could make would be a date rewrite that leaves the sprint overcommitted by
  // exactly the same amount — and a write with no possible benefit is worse than a
  // refusal, because it looks like the tool worked.
  const immovable = before - totalPoints(movable);
  if (overcommitted(immovable, velocity)) {
    return {
      changes: [],
      notes: [
        `${sprintLabel(sprint)} bleibt überbucht (${points(before)} von ${points(velocity)} Punkten): allein was ` +
          `nicht verschoben werden kann, trägt ${points(immovable)} Punkte. Verschieben könnte daran nichts ändern, ` +
          'deshalb ändert dieser Aufruf nichts.',
        ...trailing,
      ],
    };
  }

  // Latest start first, then the larger estimate, then the id. All three are needed
  // for a total order: without the last one, two items on the same day with the same
  // estimate would move in whatever order the source happened to list them. The raw
  // string comparison is what makes the last key actually total: `localeCompare`
  // returns 0 for distinct spellings a locale treats as equal (an id with a soft
  // hyphen against one without), and then the order falls back to the source array.
  const order = [...movable].sort((a, b) => {
    const byStart = compareRaw(String(b.start ?? ''), String(a.start ?? ''));
    if (byStart !== 0) return byStart;
    const byEstimate = (estimateOf(b) ?? 0) - (estimateOf(a) ?? 0);
    if (byEstimate !== 0) return byEstimate;
    return compareRaw(String(a.id), String(b.id));
  });

  const changes: ItemChange[] = [];
  const moved: TimelineFileItem[] = [];
  let remaining = before;
  for (const item of order) {
    if (!overcommitted(remaining, velocity)) break;
    const start = shiftDayString(item.start, raster.lengthDays);
    // Guaranteed by the filter above; kept as a type guard rather than a `!`.
    if (start == null) continue;
    const patch: Partial<TimelineFileItem> = { start };
    if (item.end != null) {
      const end = shiftDayString(item.end, raster.lengthDays);
      if (end) patch.end = end;
    }
    changes.push({ op: 'update', itemId: item.id!, patch });
    moved.push(item);
    remaining -= estimateOf(item) ?? 0;
  }

  const notes: string[] = [];
  const receiving = sprint + 1;
  if (moved.length) {
    notes.push(
      `${sprintLabel(sprint)}: ${moved.length} von ${count(members.length, 'Eintrag', 'Einträgen')} nach ` +
        `${sprintLabel(receiving)} ` +
        `verschoben (${nameList(moved)}), ${points(before)} → ${points(remaining)} von ${points(velocity)} Punkten.`,
    );
  }
  if (overcommitted(remaining, velocity)) {
    notes.push(
      `${sprintLabel(sprint)} bleibt überbucht (${points(remaining)} von ${points(velocity)} Punkten): ` +
        'was übrig ist, lässt sich nicht verschieben.',
    );
  }
  notes.push(...trailing);

  if (moved.length) {
    const receivingSum = totalPoints(membersOf(raster, items, receiving)) + totalPoints(moved);
    if (overcommitted(receivingSum, velocity)) {
      notes.push(
        `${sprintLabel(receiving)} ist damit überbucht (${points(receivingSum)} von ${points(velocity)} Punkten). ` +
          'Dieser Aufruf entlastet genau einen Sprint und rechnet nicht weiter; für den nächsten ist ein ' +
          'zweiter Aufruf nötig.',
      );
    }
  }

  return { changes, notes };
};

/**
 * Which sprint the open scope is expected to finish in. Writes nothing.
 *
 * Counted from the **later** of two sprints, and both halves are needed:
 *
 *   - the sprint `now` falls into, because the question is „from here", not „from the
 *     anchor". A `now` before the anchor counts from sprint 1: the raster has nothing
 *     earlier;
 *   - the earliest sprint that still holds open, scheduled work, because counting from
 *     „now" alone promised a completion before the work is scheduled to start. On the
 *     shipped example that produced „Abschluss voraussichtlich in Sprint 3 (ab
 *     2026-02-02)" with a first day over a week in the past, while half the points
 *     belonged to an item not scheduled before sprint 7.
 *
 * When open work is scheduled past the computed sprint, the notes say so: a verb may
 * not present a date the plan it is reading contradicts.
 *
 * The result is an extrapolation from an average and the notes say so. Velocity and
 * story points are complementary practice rather than anything the Scrum Guide
 * defines, so presenting a date from them as a commitment would be the one thing this
 * plugin refuses to do (see „How well is this domain modelled?" in the README).
 */
export const forecastCompletion: ToolHandler = ({ file, config, args, now }): ToolPlan => {
  const raster = requireRaster(config);
  const items = file.items ?? [];
  const group = typeof args.group === 'string' && args.group.trim() ? args.group.trim() : null;
  const scope = group ? items.filter((item) => item.group === group) : items;
  const where = group ? ` in Gruppe „${group}"` : '';

  if (raster.velocity == null) {
    return {
      notes: [
        'Ohne verwertbaren `velocity`-Wert in der Konfiguration lässt sich kein Abschluss-Sprint ' +
          'hochrechnen. Diese Frage bleibt unbeantwortet, statt auf einer Annahme zu rechnen.',
      ],
    };
  }

  const open = scope.filter((item) => !isDone(item));
  if (!open.length) {
    return { notes: [`Kein offener Eintrag${where}: es gibt nichts hochzurechnen.`] };
  }

  const missing = open.filter((item) => estimateOf(item) == null);
  const missingNote = missing.length
    ? `Ohne verwertbare Schätzung und daher nicht in der Rechnung: ${nameList(missing)}. ` +
      `Die Prognose fällt um deren Aufwand zu früh aus.`
    : null;

  const openPoints = totalPoints(open);
  if (openPoints === 0) {
    return {
      notes: [
        `Kein offener Eintrag${where} trägt eine verwertbare Schätzung: ohne Punkte gibt es keine Prognose.`,
        ...(missingNote ? [missingNote] : []),
      ],
    };
  }

  const unusable = unusableSumNote(openPoints, `Offener Umfang${where}`);
  if (unusable) return { notes: [unusable, ...(missingNote ? [missingNote] : [])] };

  const notes: string[] = [];

  // „Before the anchor" and „not a date at all" are two different answers, and
  // `sprintOfDay(…) ?? 1` made them one: `""`, `"heute"` and `"2026-13-40"` all became
  // sprint 1 silently, so the verb answered with a confident count over an argument it
  // could not read.
  const nowSprint = sprintOfDay(raster, now);
  if (!isDayString(now)) {
    notes.push(
      `${quoted(now)} ist kein Datum, deshalb beginnt die Zählung bei Sprint 1 statt beim heutigen Sprint. ` +
        'Für eine Rechnung „ab heute" muss `now` ein Tag als YYYY-MM-DD sein.',
    );
  }

  // The earliest sprint that still holds open, scheduled work. Counting from „now"
  // alone let the answer finish the scope before the plan starts it.
  const openSprints = open
    .map((item) => sprintOfItem(raster, item))
    .filter((sprint): sprint is number => sprint != null);
  const earliestOpen = openSprints.length ? openSprints.reduce((a, b) => (b < a ? b : a)) : null;

  const from = Math.max(nowSprint ?? 1, earliestOpen ?? 1);
  const sprintsNeeded = Math.ceil(openPoints / raster.velocity);
  const finish = from + sprintsNeeded - 1;
  const firstDay = sprintFirstDay(raster, finish);

  notes.push(
    `${points(openPoints)} offene Punkte${where} bei velocity ${points(raster.velocity)}: ` +
      `${count(sprintsNeeded, 'Sprint', 'Sprints')} ab ${sprintLabel(from)}, ` +
      `Abschluss voraussichtlich in ${sprintLabel(finish)}` +
      `${firstDay ? ` (ab ${firstDay})` : ''}.`,
    'Hochrechnung aus einem Durchsatzmittel, keine Zusage: Velocity und Story Points sind ergänzende ' +
      'Praxis, kein Bestandteil des Scrum Guide.',
  );

  if (nowSprint != null && from > nowSprint) {
    notes.push(
      `Gezählt wird ab ${sprintLabel(from)}, nicht ab dem heutigen ${sprintLabel(nowSprint)}: davor ist keine ` +
        'offene Arbeit terminiert, und ein Abschluss vor dem geplanten Beginn wäre keine Aussage.',
    );
  }

  // The plan may still contradict the extrapolation: this rule divides points by a
  // throughput and reads no start dates, so open work scheduled after the computed
  // sprint has to be named rather than left for the reader to notice.
  const later = open.filter((item) => {
    const sprint = sprintOfItem(raster, item);
    return sprint != null && sprint > finish;
  });
  if (later.length) {
    notes.push(
      `Der Plan widerspricht dieser Hochrechnung: offene Arbeit ist erst nach ${sprintLabel(finish)} terminiert ` +
        `(${nameList(later)}). Die Rechnung teilt Punkte durch den Durchsatz und liest keine Startdaten.`,
    );
  }

  if (missingNote) notes.push(missingNote);
  return { notes };
};

/** Keyed by the tool name the manifest declares. The two must agree. */
export const sprintsTools: Record<string, ToolHandler> = {
  check_sprint_capacity: checkSprintCapacity,
  rebalance_sprint: rebalanceSprint,
  forecast_completion: forecastCompletion,
};
