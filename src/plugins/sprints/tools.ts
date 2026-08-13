// The domain rules this plugin contributes, as verbs an agent can call.
//
// This is the half of the plugin that fields cannot express. An agent gets
// `add_item` and `update_item` from the core; what it cannot get is the rule that
// decides which items belong to a sprint and what happens to the ones that did not
// finish. Kept in a prompt, such a rule cannot be tested, cannot be reused, and is
// wrong in a way nobody notices until a commitment is wrong.
//
// Every rule here follows from „a tool is a pure function": it returns changes rather
// than performing them, it reads `now` from its context and never the clock, and it
// does no I/O and touches no DOM (this module is imported statically by the registry
// and by the process that serves agent calls, which has no DOM).
//
// **The verbs follow the sprint entity, not the raster.** Membership is an assignment on
// the item (`metadata.sprint` carries a sprint row's id), so the three verbs are
// „assign", „move the unfinished work" and „report" rather than the date arithmetic the
// first cut had. What a sprint *is* — the rows, the window, the assignment lookup, the
// „done" test, the warnings — lives in `./sprints.ts` and is imported: two answers to
// „is this item in its sprint" is how one of them ends up fixed. The wording is what
// stays here, because the view words the same warning for a person and these notes word
// it for an agent.
//
// Six rules the boundaries are chosen for, each with the failure it prevents:
//
//   - **No verb here rewrites a date.** A disagreement between an item's dates and its
//     assignment is surfaced and left standing, because both silent fixes edit
//     something a person decided: moving the dates rewrites a plan, dropping the
//     assignment rewrites a commitment (`./docs/model.md`, „Membership, and the two
//     clocks").
//   - **`roll_over` has no default target.** Canon returns unfinished work to the
//     Product Backlog, the common products default to the next sprint, and choosing
//     silently would pick a philosophy on the caller's behalf. An absent target is a
//     refusal that names both options.
//   - **Finished work is never re-dated and never rolled over.** Its scope stays in the
//     sprint's sum, because that capacity really was consumed, and it keeps the sprint
//     it was finished in: the record of where something was done is the one thing a
//     later edit must not rewrite.
//   - **An item with no usable estimate is named, never counted as zero.** A sum that
//     silently omits three items reads as a capacity statement and is not one. The rule
//     is `estimateOf` in `./sprints.ts`, so „usable" means the same thing in the lanes,
//     in the view and here.
//   - **A write that cannot help is worse than a refusal.** An assignment an item
//     already carries is not written, an item whose id cannot address it is named
//     instead of put into a plan, and a roll-over into a sprint that is over is
//     refused. A write with no possible benefit looks like the tool worked, which is the
//     one outcome nobody checks.
//   - **No velocity figure and no „committed versus completed" pair, in any note.** Not
//     an omission: `./docs/model.md` („Velocity: computed, never displayed as a metric")
//     carries the sources. An extrapolation is stated as one, out of a sprint's own
//     capacity, and never as a date the plan then has to hold.

import { type ItemChange, type ToolHandler, type ToolPlan } from '../../pluginHost/api';
import type { TimelineFile, TimelineFileItem } from '../../types';
import { isDayString, sprintOfDay, type SprintRaster } from './raster';
import {
  SPRINT_KEY,
  activeSprints,
  assignedSprintId,
  capacityUnitOf,
  carriedInto,
  estimateOf,
  isDone,
  itemsOfSprint,
  rasterOf,
  readEstimateUnit,
  readPasses,
  readSprints,
  sprintById,
  sprintWarnings,
  sprintWindow,
  windowContains,
  type CapacityUnit,
  type Sprint,
  type SprintState,
  type SprintWarning,
  type SprintWindow,
} from './sprints';

/**
 * Whole calendar days from `from` to `to`; negative when `to` is earlier, null when
 * either value names no day.
 *
 * FOLD INTO `./sprints.ts`: „how much time is left" is a question about a sprint
 * window, and this is the only arithmetic in this file that is not wording.
 *
 * Built on `sprintOfDay` with a one-day raster rather than on date parsing of its own,
 * and that is the point: a second copy of the day rules is what this plugin's
 * `AGENTS.md` forbids, and the copy would be the one that gets the Europe/Berlin change
 * of 2026-03-29 wrong (`raster.test.ts` pins it). A one-day raster anchored at `from`
 * numbers `to` as its offset plus one, so the offset falls out of the arithmetic that
 * decides every other date question here.
 */
function dayOffset(from: string, to: string): number | null {
  const oneDay = (anchor: string): SprintRaster => ({ anchor, lengthDays: 1, velocity: null, scale: [] });
  const forward = sprintOfDay(oneDay(from), to);
  if (forward != null) return forward - 1;
  const backward = sprintOfDay(oneDay(to), from);
  return backward == null ? null : -(backward - 1);
}

// ---- wording ----------------------------------------------------------------

/**
 * A value named in an error message so it cannot be mistaken for valid input.
 *
 * `String(["S-3"])` is `"S-3"`, so `{sprint: ["S-3"]}` was quoted back as „„S-3" ist
 * keine Sprint-Id" — an agent reading that sees the id it did not send and no reason for
 * the refusal. JSON keeps the brackets, the quotes and the type.
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
  return item.content?.trim() || item.id?.trim() || '(ohne Titel)';
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

/** A sprint in a note: the name a person reads plus the id a follow-up call needs. */
function sprintLabel(sprint: Sprint): string {
  return `„${sprint.name}" (${sprint.id})`;
}

/** Every sprint a caller could have meant, so a refusal is actionable. */
function sprintChoices(sprints: readonly Sprint[]): string {
  return sprints.map((s) => `${s.id} („${s.name}")`).join(', ');
}

/**
 * „Dieses Fenster ist berechnet", or nothing when the row carries it.
 *
 * Said wherever a window is stated, because a computed end reads exactly like a written
 * one: the same two dates, and only the row knows the difference. A caller told that its
 * items contradict „2026-05-01 bis 2026-05-14" has to be able to see which half of that
 * nobody wrote, or it corrects the items against a date the plugin invented.
 */
function computedWindowNote(label: string, window: SprintWindow): string | null {
  if (window.source === 'row') return null;
  if (window.source === 'end-from-cadence') {
    return (
      `Das Ende dieses Fensters (${window.end}) steht nicht auf ${label}: es ist aus dem geschriebenen Anfang und ` +
      'der Kadenzlänge berechnet. Ein Sprint hat eine feste Länge, geschrieben ist hier aber nur der Anfang.'
    );
  }
  return (
    `Dieses Fenster (${window.start} bis ${window.end}) steht nicht auf ${label}: es kommt aus dem Raster der ` +
    'Konfiguration, an der Position dieser Zeile, und verschiebt sich deshalb, wenn die Zeilen umsortiert werden.'
  );
}

/**
 * The state as interface text.
 *
 * The stored value is one of four English ids, and a note is read by a person: an answer
 * that mixes „aktiv" and „active" reads as two systems talking past each other.
 */
const STATE_LABELS: Record<SprintState, string> = {
  planned: 'geplant',
  active: 'aktiv',
  closed: 'abgeschlossen',
  cancelled: 'abgebrochen',
};

/**
 * The unit a number in a note is counted in, declined for that number.
 *
 * The singular is not decoration: counting entries made a scope of exactly 1 an everyday
 * case, and „davon offen 1 Einträge" is the kind of wrongness that makes the whole
 * answer read as machine output nobody checked. Same reason `count` exists.
 */
function unitLabel(unit: CapacityUnit, value: number): string {
  const one = atPrintedResolution(value) === 1;
  if (unit === 'hours') return one ? 'Stunde' : 'Stunden';
  if (unit === 'items') return one ? 'Eintrag' : 'Einträge';
  return one ? 'Punkt' : 'Punkte';
}

/**
 * The same unit after „von" or „mit".
 *
 * Two forms rather than one, because German declines: „13 Punkte" and „von 20 Punkten"
 * are both right and „von 20 Punkte" is not. The number it agrees with is the one it
 * follows, which is why it is an argument.
 */
function unitDative(unit: CapacityUnit, value: number): string {
  const one = atPrintedResolution(value) === 1;
  if (unit === 'hours') return one ? 'Stunde' : 'Stunden';
  if (unit === 'items') return one ? 'Eintrag' : 'Einträgen';
  return one ? 'Punkt' : 'Punkten';
}

/**
 * A value at the resolution the notes print it at.
 *
 * Two decimals, so a fractional capacity leaves no trailing noise. The overflow guard
 * is the part that is not decoration: `value * 100` becomes Infinity above ~1.8e306,
 * and `Math.round(Infinity) / 100` printed „Infinity" for a sum of 2e307 — a finite
 * total reported as a number that is not one.
 */
function atPrintedResolution(value: number): number {
  const scaled = value * 100;
  if (!Number.isFinite(scaled)) return value;
  return Math.round(scaled) / 100;
}

/** A number in a note: no trailing noise from a fractional capacity. */
function points(value: number): string {
  return String(atPrintedResolution(value));
}

/**
 * Is the sum over the capacity, **at the resolution the note prints**?
 *
 * Comparing the raw floats let the verdict contradict the two numbers beside it:
 * `"0.1"` + `"0.2"` is 0.30000000000000004, so a capacity of 0.3 produced „0.3 von 0.3
 * Punkten (überbucht)". Both sides are compared where they are shown, so a reader can
 * always check the verdict against the figures it is printed with.
 */
function overCapacity(sum: number, capacity: number): boolean {
  return atPrintedResolution(sum) > atPrintedResolution(capacity);
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

/** A set of items as a number plus the items that number does not account for. */
type Scope = { sum: number; missing: TimelineFileItem[] };

/**
 * The scope of a set of items, in the unit the sprint is planned in.
 *
 * **„items" counts entries, and that is the whole fix here.** A sprint with
 * `capacityUnit: 'items'` and a capacity of 3, holding two items of 8 and 13 points,
 * was reported as „Umfang 21 von 3 Einträgen (überbucht)": a story-point sum compared
 * against a count of entries, declared over budget by an arithmetic nobody performed.
 *
 * Nothing is missing from such a count, so `missing` is empty for it: an entry is one
 * entry whether or not anybody sized it. The absent estimate is still named, by
 * `sprintWarnings` („item-without-estimate"), where it is a question about the item
 * rather than about the sum.
 */
function scopeOf(items: readonly TimelineFileItem[], unit: CapacityUnit): Scope {
  if (unit === 'items') return { sum: items.length, missing: [] };
  let sum = 0;
  const missing: TimelineFileItem[] = [];
  for (const item of items) {
    const estimate = estimateOf(item);
    if (estimate == null) missing.push(item);
    else sum += estimate;
  }
  return { sum, missing };
}

/** „ohne verwertbare Schätzung: …", or nothing when every item carries one. */
function missingEstimateNote(where: string, missing: readonly TimelineFileItem[]): string | null {
  if (!missing.length) return null;
  return (
    `${where}: ohne verwertbare Schätzung: ${nameList(missing)}. ` +
    `Eine Summe, in der ${count(missing.length, 'Eintrag fehlt', 'Einträge fehlen')}, ist keine Kapazitätsaussage.`
  );
}

/**
 * Which items point at which, through `metadata.dependsOn`.
 *
 * Restated here rather than imported: `extractDependsOn` lives in `src/buildItems.ts`,
 * which a plugin may not import (plugin isolation, see `AGENTS.md` in this folder), so
 * the accepted shapes have to agree with that function by hand — a list of ids, or a
 * single id written as a bare string. `dependsOn` is a core reserved metadata key
 * (`RESERVED_META_KEYS` in src/customFields.ts) and the relation graph draws an edge for
 * every entry, which is why a rule that changes what a sprint holds has to read it.
 *
 * **Character for character the core's rule, including where it does not trim.** An
 * entry of a list keeps its whitespace there (`v.map(String).filter((s) => s.length)`),
 * so `[" P-1 "]` names no item and no edge is drawn; only the single-string form is
 * trimmed. Trimming both here made this file claim a dependent the relation graph does
 * not draw — a note about a stranded successor that no arrow on the page corresponds to.
 */
function dependentsByTarget(items: readonly TimelineFileItem[]): Map<string, TimelineFileItem[]> {
  const map = new Map<string, TimelineFileItem[]>();
  for (const item of items) {
    const raw = item.metadata?.dependsOn;
    const list = Array.isArray(raw)
      ? raw.map(String).filter((entry) => entry.length > 0)
      : typeof raw === 'string' && raw.trim()
        ? [raw.trim()]
        : [];
    for (const target of list) {
      const known = map.get(target);
      if (known) known.push(item);
      else map.set(target, [item]);
    }
  }
  return map;
}

// ---- the disagreement between an item's dates and its sprint ----------------

/**
 * Do the item's own dates fall outside the window?
 *
 * Composed from `windowContains` rather than comparing days here, so „outside" means
 * exactly what `sprintWarnings` means by it: the start counts, and the end counts when
 * the item carries one. An item with no date at all is not a disagreement — it is the
 * separate case below, because there is nothing to compare.
 */
function datesDisagree(window: SprintWindow, item: TimelineFileItem): boolean {
  const startOff = isDayString(item.start) && !windowContains(window, item.start);
  const endOff = isDayString(item.end) && !windowContains(window, item.end);
  return startOff || endOff;
}

/**
 * What the writing verbs say about the items they just assigned.
 *
 * Never a change: „the assignment wins, and a disagreement is shown rather than
 * resolved" is this function's whole reason to exist. `sprint_status` renders the same
 * facts out of `sprintWarnings`, which scans the timeline as stored; a plan has not been
 * applied yet, so the verbs that write need this check over the items in hand.
 */
function windowNotes(sprint: Sprint, raster: SprintRaster | null, items: readonly TimelineFileItem[]): string[] {
  if (!items.length) return [];
  const notes: string[] = [];
  const window = sprintWindow(sprint, raster);
  if (!window) {
    return [
      `${sprintLabel(sprint)} hat kein Fenster: weder trägt die Zeile start und end, noch gibt es ein Raster, das ` +
        'eines beisteuert. Ob die Daten eines Eintrags der Zuordnung widersprechen, ist damit nicht prüfbar.',
    ];
  }
  const outside = items.filter((item) => datesDisagree(window, item));
  // Named once: an item with no start but an end outside the window is already in the
  // line above, and two notes about one item read as two findings.
  const undated = items.filter((item) => !isDayString(item.start) && !outside.includes(item));
  if (outside.length) {
    notes.push(
      `Die eigenen Daten widersprechen der Zuordnung zu ${sprintLabel(sprint)} (${window.start} bis ${window.end}): ` +
        `${nameList(outside)} (${idList(outside)}). Weder die Daten noch die Zuordnung werden geändert: das eine ` +
        'überschreibt einen Plan, das andere eine Zusage, und beides hat ein Mensch entschieden.',
    );
    const computed = computedWindowNote(sprintLabel(sprint), window);
    if (computed) notes.push(computed);
  }
  if (undated.length) {
    notes.push(
      `Ohne Startdatum und daher an keiner Stelle des Fensters: ${nameList(undated)} (${idList(undated)}). ` +
        'Die Zuordnung gilt trotzdem, ein Vergleich mit dem Fenster ist nicht möglich.',
    );
  }
  return notes;
}

// ---- the warnings, as an agent reads them -----------------------------------

/** What a warning calls the item it is about. The content first, the id as a fallback. */
function warnedName(warning: { content: string; itemId: string | null }): string {
  return `„${warning.content.trim() || warning.itemId?.trim() || '(ohne Titel)'}"`;
}

/**
 * The typed warnings of `sprints.ts`, worded for an agent.
 *
 * The rule stays there and the sentence stays here on purpose: the view says the same
 * things to a person in its own layout, and one shared string would be wrong for one of
 * the two. The grouping by sprint is wording as well — four separate lines for four
 * unestimated items of one sprint is a wall an agent relays verbatim.
 */
function warningNotes(
  warnings: readonly SprintWarning[],
  sprints: readonly Sprint[],
  file: TimelineFile,
): string[] {
  const notes: string[] = [];
  const label = (id: string) => {
    const sprint = sprintById(sprints, id);
    return sprint ? sprintLabel(sprint) : `„${id}"`;
  };

  for (const warning of warnings) {
    if (warning.kind === 'active-sprint-without-goal') {
      notes.push(
        `${label(warning.sprintId)} ist aktiv und hat kein Sprint-Ziel. Das Ziel ist das Kriterium, an dem während ` +
          'des Sprints über Änderungen entschieden wird, und der einzige Grund, einen Sprint abzubrechen.',
      );
    }
    if (warning.kind === 'several-active-sprints') {
      // The host enforces no rule across rows, so „at most one active sprint" can only
      // be reported, never prevented: „A new Sprint starts immediately after the
      // conclusion of the previous Sprint".
      notes.push(
        `${count(warning.sprintIds.length, 'Sprint ist', 'Sprints sind')} gleichzeitig aktiv ` +
          `(${warning.sprintIds.map(label).join(', ')}). Es kann nur einen aktiven Sprint geben; die übrigen ` +
          'gehören geschlossen oder auf „planned" zurückgesetzt.',
      );
    }
    if (warning.kind === 'overlapping-sprint-windows') {
      // Both ids, because the fault is the pair and neither row is wrong on its own.
      notes.push(
        `Die Fenster von ${label(warning.sprintIds[0])} und ${label(warning.sprintIds[1])} überschneiden sich ` +
          `(${warning.overlap.start} bis ${warning.overlap.end}). Ein Sprint beginnt, wenn der vorige endet, und ` +
          'für einen Eintrag in diesen Tagen nennt „Sprint nach Datum" die frühere Zeile, während die Zuordnung ' +
          'auf die spätere zeigt: der Widerspruch ist dann in keiner der beiden Zeilen zu sehen.',
      );
    }
    if (warning.kind === 'closed-before-start') {
      notes.push(
        `${label(warning.sprintId)} ist am ${warning.closedOn} abgeschlossen worden und beginnt am ` +
          `${warning.start}, also danach. Eines der beiden Daten ist falsch, und welches, sagt keine Zahl hier: ` +
          'der eingefrorene Verlauf liegt damit außerhalb des Fensters, in dem er gezeichnet würde.',
      );
    }
    if (warning.kind === 'pass-without-sprint') {
      notes.push(
        `Der Verlaufseintrag ${quoted(warning.rowId)} nennt den Sprint ${quoted(warning.sprintId)}, den es nicht ` +
          `gibt (Eintrag ${quoted(warning.itemId)}). Er zählt damit in keinem Sprint und wird auch nicht ` +
          'gelöscht: gehört er zu einem umbenannten Sprint, ist die Id zu korrigieren, sonst die Zeile zu entfernen.',
      );
    }
    if (warning.kind === 'duplicate-row-id') {
      notes.push(
        `Die Sammlung „${warning.collection}" trägt die Id ${quoted(warning.rowId)} mehr als einmal. Gelesen wird ` +
          'die erste Zeile, jede weitere existiert nur noch in der Datei: sie steht in keiner Auswahl, in keiner ' +
          'Summe und in keinem Bericht.',
      );
    }
    if (warning.kind === 'several-reports-for-one-sprint') {
      notes.push(
        `Zu ${label(warning.sprintId)} gibt es mehr als einen Bericht (${warning.rowIds.map(quoted).join(', ')}). ` +
          'Gelesen wird der erste; die übrigen sind zweite eingefrorene Zahlen zum selben abgeschlossenen Sprint.',
      );
    }
  }

  const bySprint = new Map<string, SprintWarning[]>();
  for (const warning of warnings) {
    if (warning.kind !== 'item-outside-sprint-window' && warning.kind !== 'item-without-estimate') continue;
    const known = bySprint.get(warning.sprintId);
    if (known) known.push(warning);
    else bySprint.set(warning.sprintId, [warning]);
  }

  for (const [sprintId, group] of bySprint) {
    const outside = group.filter((w) => w.kind === 'item-outside-sprint-window');
    const missing = group.filter((w) => w.kind === 'item-without-estimate');
    if (outside.length) {
      const window = outside[0].kind === 'item-outside-sprint-window' ? outside[0].window : null;
      notes.push(
        `Die eigenen Daten widersprechen der Zuordnung zu ${label(sprintId)}` +
          `${window ? ` (${window.start} bis ${window.end})` : ''}: ` +
          `${outside.map(warnedName).join(', ')}. Weder die Daten noch die Zuordnung werden geändert: das eine ` +
          'überschreibt einen Plan, das andere eine Zusage, und beides hat ein Mensch entschieden.',
      );
      // The window this contradiction is measured against may be one nobody wrote.
      const computed = window ? computedWindowNote(label(sprintId), window) : null;
      if (computed) notes.push(computed);
    }
    if (missing.length) {
      // A sprint counted in entries has a complete scope without these estimates, so the
      // „diese Summe ist keine Kapazitätsaussage" sentence would be false there — the
      // missing estimate is still worth naming, for a different reason.
      const sprint = sprintById(sprints, sprintId);
      const counted = sprint != null && capacityUnitOf(sprint, file) === 'items';
      notes.push(
        `${label(sprintId)}: ohne verwertbare Schätzung: ${missing.map(warnedName).join(', ')}. ` +
          (counted
            ? 'Dieser Sprint zählt Einträge, sein Umfang ist damit vollständig; über den Aufwand sagt er nichts.'
            : `Eine Summe, in der ${count(missing.length, 'Eintrag fehlt', 'Einträge fehlen')}, ist keine ` +
              'Kapazitätsaussage.'),
      );
    }
  }
  return notes;
}

// ---- arguments --------------------------------------------------------------

/**
 * The sprint rows, or a refusal.
 *
 * Throwing rather than returning an empty plan: „nothing to do" is what an empty plan
 * says, and „this timeline has no sprints" is not that. The message reaches the agent,
 * which is the party that can create one.
 */
function requireSprints(file: TimelineFile): Sprint[] {
  const sprints = readSprints(file);
  if (!sprints.length) {
    throw new Error(
      'Auf dieser Timeline ist kein Sprint angelegt. Die Zuordnung verweist auf die Id einer Zeile der Sammlung ' +
        '„sprints", die es dafür geben muss: erst einen Sprint anlegen, dann zuordnen.',
    );
  }
  return sprints;
}

/** The sprint an argument names, or a refusal that lists the ones that exist. */
function requireSprint(sprints: readonly Sprint[], raw: unknown, argName: string): Sprint {
  if (raw == null) {
    throw new Error(`\`${argName}\` fehlt: erwartet ist die Id eines Sprints. Vorhanden: ${sprintChoices(sprints)}.`);
  }
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) {
    throw new Error(
      `${quoted(raw)} ist keine Sprint-Id: erwartet ist die Id einer Zeile der Sammlung „sprints". ` +
        `Vorhanden: ${sprintChoices(sprints)}.`,
    );
  }
  const found = sprintById(sprints, id);
  if (!found) throw new Error(`Kein Sprint mit der Id ${quoted(id)}. Vorhanden: ${sprintChoices(sprints)}.`);
  return found;
}

/**
 * The item ids an argument names, plus the entries that are no id at all.
 *
 * The unusable entries come back rather than being thrown on, for the reason the
 * whitespace-id rule already established: one bad entry must not make the whole call
 * impossible, and an entry that is silently dropped is the other half of that bug.
 *
 * **`unusable` is reachable through the host, and that is why it stays.** The declared
 * `items` schema is `string` with `minLength: 1`, and the host counts characters rather
 * than non-blank ones (`validateRow` in src/pluginHost/dataSchema.ts), so `"  "` passes
 * validation and arrives here. A direct call — a test, another plugin's rule — can hand
 * over a number as well. Without this branch either entry would vanish from a plan the
 * caller believes covered its whole list.
 */
function itemIdsArg(raw: unknown): { ids: string[]; unusable: unknown[] } {
  if (raw == null) throw new Error('`items` fehlt: erwartet ist eine Liste von Item-Ids.');
  if (!Array.isArray(raw)) throw new Error(`${quoted(raw)} ist keine Liste von Item-Ids.`);
  if (!raw.length) throw new Error('`items` ist leer: ohne Einträge gibt es nichts zuzuordnen.');
  const ids: string[] = [];
  const unusable: unknown[] = [];
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry.trim() : '';
    if (!id) unusable.push(entry);
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, unusable };
}

/**
 * The items of a timeline a plan can address, looked up by trimmed id.
 *
 * Matched trimmed, so a caller's `"A-1"` finds an item whose stored id is `" A-1 "`:
 * ids are unconstrained strings in this data model and nothing trims them on the way
 * in. What goes into a plan is then the item's **own** id — see `planItemId` — because
 * the host matches a change against the id as stored and refuses the whole plan when it
 * does not find it. One padded id used to block the assignment of every other item in
 * the call.
 */
function addressableItems(items: readonly TimelineFileItem[]): Map<string, TimelineFileItem> {
  const map = new Map<string, TimelineFileItem>();
  for (const item of items) {
    const id = item.id?.trim();
    // An id that is only whitespace passes a plain falsy check and then makes
    // `validateToolPlan` refuse the WHOLE plan over a blank `itemId`. Such an item is
    // named in the notes instead, so one bad id cannot block everything else.
    if (id && !map.has(id)) map.set(id, item);
  }
  return map;
}

/**
 * The id a plan addresses an item by: the one the item carries, untrimmed.
 *
 * `validateToolPlan` compares against `file.items[].id` as stored, so a trimmed id for
 * an item stored as `" A-1 "` is „no item on this timeline" and the host refuses the
 * plan whole — every other change in it included.
 */
function planItemId(item: TimelineFileItem): string {
  return item.id as string;
}

// ---- plan_sprint ------------------------------------------------------------

/**
 * Assign items to a sprint. Writes the assignment key and nothing else.
 *
 * Membership is an act rather than a date test (`./docs/model.md`, „Why the sprint is an
 * entity and not a date range"), so this verb is the act. What it deliberately does not
 * do is make the dates agree: an item whose own dates fall outside the sprint's window
 * is named, and both sides are left exactly as they are.
 */
export const planSprint: ToolHandler = ({ file, args }): ToolPlan => {
  const sprints = requireSprints(file);
  const sprint = requireSprint(sprints, args.sprint, 'sprint');
  if (sprint.state === 'closed' || sprint.state === 'cancelled') {
    // The same refusal `roll_over` gives for the same reason, and it was missing here:
    // assigning work into a sprint that is over changes nothing about what was
    // delivered, while the live scope it appears in then contradicts the frozen report
    // that holds that sprint's figures — and no note said a report existed. A write with
    // no possible benefit looks exactly like one that worked.
    throw new Error(
      `${sprintLabel(sprint)} ist ${STATE_LABELS[sprint.state]}: dorthin wird nichts mehr zugeordnet. Die Zahlen ` +
        'dieses Sprints stehen in seinem eingefrorenen Bericht und werden nicht neu berechnet, eine weitere ' +
        'Zuordnung würde ihm also nur widersprechen. Nenne einen geplanten oder aktiven Sprint.',
    );
  }
  const { ids, unusable } = itemIdsArg(args.items);
  const known = addressableItems(file.items ?? []);

  const assign: TimelineFileItem[] = [];
  const already: TimelineFileItem[] = [];
  // Ids that name nothing first, then entries that are no id at all: the first group is
  // what a caller mistyped, the second what it built wrongly.
  const unknown: unknown[] = [];
  for (const id of ids) {
    const item = known.get(id);
    if (!item) {
      unknown.push(id);
      continue;
    }
    if (assignedSprintId(item) === sprint.id) already.push(item);
    else assign.push(item);
  }

  const changes: ItemChange[] = assign.map((item) => ({
    op: 'update',
    itemId: planItemId(item),
    // The metadata of a patch is shallow-merged onto the item (`resolveItemPatch` in
    // scripts/mcp/patch.ts), so writing one key keeps the estimate and everything else
    // the item carries. A whole metadata object here would drop them.
    patch: { metadata: { [SPRINT_KEY]: sprint.id } },
  }));

  const notes: string[] = [];
  notes.push(
    assign.length
      ? `${sprintLabel(sprint)}: ${count(assign.length, 'Eintrag', 'Einträge')} zugeordnet (${nameList(assign)}). ` +
        'Daten wurden dabei nicht angefasst.'
      : `${sprintLabel(sprint)}: nichts zugeordnet.`,
  );
  if (already.length) {
    // Writing the value an item already carries is a patch with no effect, and a plan
    // that reports it looks like a change happened.
    notes.push(`Bereits ${sprintLabel(sprint)} zugeordnet und daher nicht erneut geschrieben: ${nameList(already)}.`);
  }
  if (unknown.length || unusable.length) {
    notes.push(
      `Nicht auf dieser Timeline und daher nicht zugeordnet: ${[...unknown, ...unusable].map(quoted).join(', ')}. ` +
        'Eine Id, die kein Eintrag trägt, würde den gesamten Plan ungültig machen, deshalb ist sie nicht darin.',
    );
  }

  const done = assign.filter(isDone);
  if (done.length) {
    notes.push(
      `Auch abgeschlossene Arbeit wurde zugeordnet (${nameList(done)}): das ändert kein Datum, verschiebt aber ` +
        'fertige Arbeit in die Bilanz dieses Sprints. Für den Verlauf zählt der Sprint, in dem sie fertig wurde.',
    );
  }

  notes.push(...windowNotes(sprint, rasterOf(file), [...assign, ...already]));
  notes.push(
    `Ob der Umfang in ${sprintLabel(sprint)} passt, beantwortet \`sprint_status\`: dieser Aufruf ordnet zu und ` +
      'rechnet nichts.',
  );

  return { changes, notes };
};

// ---- roll_over --------------------------------------------------------------

/** Where the unfinished work of a sprint goes. There is no default, and that is the rule. */
function rollOverTarget(sprints: readonly Sprint[], source: Sprint, args: Record<string, unknown>): Sprint | null {
  const wantsBacklog = args.toBacklog;
  if (wantsBacklog != null && typeof wantsBacklog !== 'boolean') {
    throw new Error(
      `${quoted(wantsBacklog)} ist kein Wahrheitswert: \`toBacklog\` ist entweder true oder nicht gesetzt.`,
    );
  }
  const backlog = wantsBacklog === true;
  const named = args.toSprint;
  if (backlog && named != null) {
    throw new Error(
      'Entweder `toSprint` oder `toBacklog`, nicht beides: zwei Ziele sind kein Ziel, und welches gewonnen hätte, ' +
        'wäre an der Antwort nicht zu sehen.',
    );
  }
  if (!backlog && named == null) {
    // Canon: unfinished work „returns to the Product Backlog". Jira, Azure DevOps and
    // Linear all offer the next sprint instead. A default here would pick one of those
    // philosophies for the caller, silently, on a write.
    throw new Error(
      'Ohne Ziel wird nichts verschoben: `toSprint` (Id des Zielsprints) oder `toBacklog: true` (Zuordnung ' +
        'entfernen) muss gesetzt sein. Es gibt hier absichtlich kein Standardziel, weil der Scrum Guide unfertige ' +
        'Arbeit ins Product Backlog zurücklegt und die verbreiteten Werkzeuge sie in den nächsten Sprint schieben.',
    );
  }
  if (backlog) return null;
  const target = requireSprint(sprints, named, 'toSprint');
  if (target.id === source.id) {
    throw new Error(
      `Quelle und Ziel sind derselbe Sprint (${sprintLabel(source)}): das wäre ein Schreibvorgang ohne Wirkung.`,
    );
  }
  if (target.state === 'closed' || target.state === 'cancelled') {
    // Unfinished work rolled into a sprint that is over cannot be worked on there, so
    // the write could not help and would look like a roll-over that succeeded.
    throw new Error(
      `${sprintLabel(target)} ist ${STATE_LABELS[target.state]}: offene Arbeit dorthin zu verschieben hilft nichts. ` +
        'Nenne einen geplanten oder aktiven Sprint, oder `toBacklog: true`.',
    );
  }
  return target;
}

/**
 * Move the unfinished work of one sprint to an explicit target. Writes assignments.
 *
 * Three things it never does, each one a write that could not help: it does not touch
 * finished work (whose sprint is the record of where it was finished), it does not
 * change a single date (the item's own dates and the target's window may disagree, and
 * that is reported), and it does not follow the dependency graph. What it does report is
 * every item that stays behind, with the reason.
 */
export const rollOver: ToolHandler = ({ file, args }): ToolPlan => {
  const sprints = requireSprints(file);
  const source = requireSprint(sprints, args.sprint, 'sprint');
  const target = rollOverTarget(sprints, source, args);
  const items = file.items ?? [];
  const members = itemsOfSprint(items, source.id);

  if (!members.length) {
    return { changes: [], notes: [`${sprintLabel(source)} hält keinen Eintrag: es gibt nichts zu verschieben.`] };
  }

  const notes: string[] = [];
  const done = members.filter(isDone);
  const moved: TimelineFileItem[] = [];
  const unaddressable: TimelineFileItem[] = [];
  for (const item of members) {
    if (isDone(item)) continue;
    if (!item.id?.trim()) unaddressable.push(item);
    else moved.push(item);
  }

  const where = target ? sprintLabel(target) : 'das Backlog';
  const changes: ItemChange[] = moved.map((item) => ({
    op: 'update',
    itemId: planItemId(item),
    // A metadata value of null removes the key (`mergeMetadata` in
    // scripts/mcp/patch.ts), and that is what „back to the backlog" is: no assignment,
    // rather than an assignment to something called backlog.
    patch: { metadata: { [SPRINT_KEY]: target ? target.id : null } },
  }));

  notes.push(
    moved.length
      ? `${sprintLabel(source)}: ${count(moved.length, 'offener Eintrag', 'offene Einträge')} nach ${where} ` +
        `verschoben (${nameList(moved)}). Kein Datum wurde dabei geändert.`
      : `${sprintLabel(source)}: kein offener Eintrag verschoben.`,
  );

  if (done.length) {
    notes.push(
      `Abgeschlossene Arbeit bleibt in ${sprintLabel(source)} (${nameList(done)}): sie ist dort fertig geworden, und ` +
        'eine andere Zuordnung würde den Verlauf umschreiben.',
    );
  }
  if (unaddressable.length) {
    notes.push(
      `Ohne verwendbare Id und daher nicht verschoben: ${nameList(unaddressable)}. Ein Plan adressiert einen ` +
        'Eintrag über seine Id; eine leere Id würde den gesamten Plan ungültig machen.',
    );
  }

  // The dependency graph is not followed, and the successors left behind are named
  // instead. The older rule refused to *move* a depended-on item, and its reason was a
  // date: shifting a predecessor by a sprint length put its successor's start before the
  // predecessor's end, which the relation graph then drew backwards. This verb changes
  // no date, so that failure cannot happen — while refusing to move the item would leave
  // unfinished work in a sprint that is over, the very thing this verb exists for. What
  // remains is a dependency now pointing back across a sprint boundary, and that is a
  // note. Moving the successors along would rewrite the rest of the plan out of one call.
  // Looked up by the item's own id, and „did it move too" asked of the item rather than
  // of a trimmed id: `dependsOn` names an id exactly as the core resolves it, so the
  // edges named here are the edges the relation graph draws and no others.
  const movedSet = new Set(moved);
  const dependents = dependentsByTarget(items);
  const stranded: TimelineFileItem[] = [];
  for (const item of moved) {
    for (const waiting of dependents.get(planItemId(item)) ?? []) {
      if (movedSet.has(waiting)) continue;
      if (!stranded.includes(waiting)) stranded.push(waiting);
    }
  }
  if (stranded.length) {
    notes.push(
      'Hängt an verschobener Arbeit und ist selbst nicht mitverschoben worden (`dependsOn`): ' +
        `${nameList(stranded)} (${idList(stranded)}). Die Abhängigkeit zeigt jetzt über eine Sprintgrenze zurück; ` +
        'ein Mitverschieben wäre eine Umschreibung des restlichen Plans aus einem Aufruf.',
    );
  }

  if (moved.length) {
    // A tool returns item changes and cannot write the plugin's own rows, so this verb
    // moves items and nothing else: the sprint keeps its state and no `passes` row
    // records the move (./docs/model.md, „A close is not atomic"). An agent that reads
    // „rolled over" as „closed" would leave a sprint that is over standing as active.
    notes.push(
      'Verschoben wurden nur Zuordnungen: der Status des Sprints bleibt, und es entsteht kein Verlaufseintrag ' +
        '(`passes`). Ein Abschluss ist ein eigener Schritt.',
    );
  }

  if (target) notes.push(...windowNotes(target, rasterOf(file), moved));
  else if (moved.length) {
    notes.push(
      'Im Backlog gilt kein Fenster, die Daten der Einträge bleiben stehen. Sie widersprechen damit keiner ' +
        'Zuordnung mehr, terminieren aber weiterhin Arbeit, die niemand zugesagt hat.',
    );
  }

  return { changes, notes };
};

// ---- sprint_status ----------------------------------------------------------

/**
 * What one sprint answers with, before the warnings.
 *
 * The raster is handed in rather than read here: it decides the window of a sprint whose
 * row carries no dates, so every line of one answer has to be computed against the same
 * one.
 */
function statusOf(
  sprint: Sprint,
  sprints: readonly Sprint[],
  file: TimelineFile,
  raster: SprintRaster | null,
  now: string,
): string[] {
  const notes: string[] = [];
  const members = itemsOfSprint(file.items ?? [], sprint.id);
  const unit = capacityUnitOf(sprint, file);
  const state = STATE_LABELS[sprint.state];

  if (!members.length) {
    notes.push(`${sprintLabel(sprint)}, ${state}: kein Eintrag zugeordnet.`);
  } else {
    const scope = scopeOf(members, unit);
    const remaining = scopeOf(members.filter((item) => !isDone(item)), unit);
    const unusable = unusableSumNote(scope.sum, sprintLabel(sprint));
    if (unusable) {
      notes.push(unusable);
    } else if (sprint.capacity == null) {
      notes.push(
        `${sprintLabel(sprint)}, ${state}: ${count(members.length, 'Eintrag', 'Einträge')}, Umfang ` +
          `${points(scope.sum)} ${unitLabel(unit, scope.sum)}, davon offen ${points(remaining.sum)} ` +
          `${unitLabel(unit, remaining.sum)}. ` +
          'Ohne `capacity` auf dem Sprint steht diese Zahl ohne Maßstab.',
      );
    } else {
      notes.push(
        `${sprintLabel(sprint)}, ${state}: ${count(members.length, 'Eintrag', 'Einträge')}, Umfang ` +
          `${points(scope.sum)} von ${points(sprint.capacity)} ${unitDative(unit, sprint.capacity)} ` +
          `(${overCapacity(scope.sum, sprint.capacity) ? 'überbucht' : 'im Rahmen'}), ` +
          `davon offen ${points(remaining.sum)} ${unitLabel(unit, remaining.sum)}.`,
      );
    }

    // The extrapolation the retired `forecast_completion` did, against a real sprint's
    // own capacity instead of a team constant. Stated as an extrapolation and never as a
    // velocity: a throughput figure on a page invites exactly the comparison
    // ./docs/model.md („Velocity: computed, never displayed as a metric") argues against.
    if (sprint.capacity != null && Number.isFinite(remaining.sum) && overCapacity(remaining.sum, sprint.capacity)) {
      const further = Math.ceil(remaining.sum / sprint.capacity) - 1;
      notes.push(
        // A count of 1e306 sprints is arithmetically right and says nothing, which is
        // the failure `unusableSumNote` catches one step earlier: a figure nobody can
        // check reads exactly as confident as one that can.
        Number.isSafeInteger(further)
          ? `Offen sind ${points(remaining.sum)} ${unitLabel(unit, remaining.sum)} bei einer Kapazität von ` +
            `${points(sprint.capacity)}: das reicht über diesen Sprint hinaus, um ` +
            `${count(further, 'weiteren Sprint', 'weitere Sprints')} dieser Größe. Hochrechnung aus einer ` +
            'Kapazität, keine Zusage.'
          : `Der offene Umfang (${points(remaining.sum)} ${unitLabel(unit, remaining.sum)}) ist gegen eine ` +
            `Kapazität von ${points(sprint.capacity)} keine Zahl von Sprints mehr, die eine Aussage wäre. ` +
            'Die Schätzungen gehören korrigiert.',
      );
    }
  }

  notes.push(...carriedInNotes(sprint, sprints, file));
  notes.push(...daysLeftNotes(sprint, raster, now));
  return notes;
}

/**
 * What this sprint received from an earlier one, out of the `passes` rows.
 *
 * The rows were written at every close and read by nothing, so „carried" was a record
 * kept for its own sake. It answers what neither the assignment nor any current figure
 * can: part of this sprint's scope was already committed once and did not get done, and
 * the estimate it carried at that close is the one figure a later re-estimate cannot
 * rewrite.
 */
function carriedInNotes(sprint: Sprint, sprints: readonly Sprint[], file: TimelineFile): string[] {
  const carried = carriedInto(sprints, readPasses(file), file.items ?? [], sprint.id);
  if (!carried.length) return [];
  const unit = capacityUnitOf(sprint, file);
  const from = (id: string) => {
    const found = sprintById(sprints, id);
    return found ? sprintLabel(found) : `„${id}"`;
  };
  const parts = carried.map((entry) => {
    const when = entry.recordedOn ? `, festgehalten am ${entry.recordedOn}` : '';
    // The estimate at the close, and „ohne Schätzung" rather than 0 when nobody had
    // sized it: that is also why a report can say `carried: 0` about a carried item.
    const estimate =
      entry.estimateAtClose == null
        ? ', damals ohne Schätzung'
        : `, damals mit ${points(entry.estimateAtClose)} ${unitLabel(unit, entry.estimateAtClose)}`;
    return `${quoted(entry.itemId)} aus ${from(entry.fromSprintId)}${when}${estimate}`;
  });
  return [
    `Aus einem früheren Sprint mitgenommen: ${parts.join('; ')}. Dieser Umfang war schon einmal zugesagt; im ` +
      'Verlauf des früheren Sprints steht er als „carried".',
  ];
}

/** „Wie lange noch", against `now` and never against the clock. */
function daysLeftNotes(sprint: Sprint, raster: SprintRaster | null, now: string): string[] {
  const window = sprintWindow(sprint, raster);
  if (!window) {
    return [
      `${sprintLabel(sprint)} hat kein Fenster: ohne start und end auf der Zeile, und ohne Raster, das eines ` +
        'beisteuert, ist nicht zu sagen, wie viel Zeit bleibt. Ein Sprint hat eine feste Länge, und ohne sie kann ' +
        'er auch nicht aktiv sein.',
    ];
  }
  if (!isDayString(now)) {
    // „Outside the window" and „not a date at all" are two different answers, and a
    // count from a value nobody could read is a confident number over nothing.
    return [
      `${quoted(now)} ist kein Datum, deshalb bleibt „wie viel Zeit bleibt" unbeantwortet. Erwartet ist ein Tag ` +
        'als YYYY-MM-DD.',
    ];
  }
  const toStart = dayOffset(now, window.start);
  const toEnd = dayOffset(now, window.end);
  if (toStart == null || toEnd == null) return [];
  // „Wie viel Zeit bleibt" is counted against this end, so where the end came from
  // belongs in the same answer.
  const computed = computedWindowNote(sprintLabel(sprint), window);
  const withSource = (line: string): string[] => (computed ? [line, computed] : [line]);
  if (toStart > 0) {
    return withSource(
      `${sprintLabel(sprint)} beginnt erst am ${window.start}, in ${count(toStart, 'Tag', 'Tagen')} ` +
        `(Stichtag ${now}).`,
    );
  }
  if (toEnd >= 0) {
    return withSource(
      `${count(toEnd + 1, 'Tag', 'Tage')} bis zum Ende am ${window.end}, den Stichtag ${now} eingeschlossen.`,
    );
  }
  const over = withSource(
    `Das Fenster von ${sprintLabel(sprint)} endete am ${window.end}, vor ${count(-toEnd, 'Tag', 'Tagen')} ` +
      `(Stichtag ${now}).`,
  );
  if (sprint.state === 'active') {
    over.push(
      `${sprintLabel(sprint)} steht weiterhin auf „active": nichts schließt einen Sprint von selbst, und ein Sprint ` +
        'wird nicht verlängert, sondern geschlossen.',
    );
  }
  return over;
}

/**
 * Remaining, scope, days left and every warning the rows can produce. Writes nothing.
 *
 * Asked without an argument it reports the active sprint, which is what „how are we
 * doing" means. What it never reports is a velocity figure or a „committed versus
 * completed" pair; ./docs/model.md carries the sources for that.
 */
export const sprintStatus: ToolHandler = ({ file, args, now }): ToolPlan => {
  const sprints = readSprints(file);
  const notes: string[] = [];

  // No rows is an answer here rather than a refusal: this verb writes nothing, so the
  // note *is* the whole result and „there are none yet" is the true one. The writing
  // verbs throw instead, because for them there is nothing to write to.
  if (!sprints.length) {
    notes.push(
      'Auf dieser Timeline ist kein Sprint angelegt: es gibt keinen Umfang, keine Restarbeit und keine ' +
        'Restlaufzeit zu berichten.',
    );
    notes.push(...unaccountedNotes(sprints, file));
    return { notes };
  }

  const asked = args.sprint == null ? null : requireSprint(sprints, args.sprint, 'sprint');
  const active = activeSprints(sprints);
  const targets = asked ? [asked] : active;

  if (!asked && !active.length) {
    // Deliberately not a `SprintWarning`: nothing in the host fires at a sprint
    // boundary, so „no sprint is active" is the normal state of a plan that has not
    // started and is an answer about the argument rather than a fault in the data.
    notes.push(
      `Kein Sprint ist aktiv (${count(sprints.length, 'Sprint', 'Sprints')} angelegt: ${sprintChoices(sprints)}). ` +
        'Ohne Argument berichtet dieser Aufruf den aktiven Sprint; nenne `sprint` für einen bestimmten.',
    );
  }

  const raster = rasterOf(file);
  for (const sprint of targets) notes.push(...statusOf(sprint, sprints, file, raster, now));

  const relevant = new Set(targets.map((sprint) => sprint.id));
  const warnings = sprintWarnings(file).filter((warning) => concerns(warning, relevant));
  notes.push(...warningNotes(warnings, sprints, file));
  notes.push(...unaccountedNotes(sprints, file));
  return { notes };
};

/**
 * Does this warning belong in an answer about these sprints?
 *
 * Three groups rather than one test on `sprintId`, and the difference decides what a
 * caller is never told: a fault of the whole timeline — two active sprints, a row id
 * twice in one collection, a history row naming a sprint that does not exist — names no
 * sprint that could be „the one asked about", and this is the only verb that reports, so
 * a filter on `sprintId` alone would hide it from every answer. An overlap belongs to a
 * pair, so either half brings it in. Everything else is about one sprint.
 */
function concerns(warning: SprintWarning, sprintIds: ReadonlySet<string>): boolean {
  switch (warning.kind) {
    case 'several-active-sprints':
    case 'duplicate-row-id':
    case 'pass-without-sprint':
      return true;
    case 'overlapping-sprint-windows':
      return warning.sprintIds.some((id) => sprintIds.has(id));
    default:
      return sprintIds.has(warning.sprintId);
  }
}

/**
 * The scope no sprint accounts for: the backlog, and assignments pointing at nothing.
 *
 * This is the „außerhalb des Rasters" line of the retired capacity verb, and it exists
 * for the same reason: a per-sprint sum plus silence about everything else reads as a
 * statement about the whole timeline.
 *
 * The dangling assignment is deliberately *not* a `SprintWarning` — `sprints.ts` leaves
 * it out because the field renders it as a value with no option rather than as a sprint
 * problem. It matters here anyway, and only here: such an item is counted in no sprint's
 * sum, so a report that stays quiet about it omits scope.
 */
function unaccountedNotes(sprints: readonly Sprint[], file: TimelineFile): string[] {
  const notes: string[] = [];
  // No sprint owns this scope, so the unit is the config's rather than a row's.
  const unit = readEstimateUnit(file);
  const known = new Set(sprints.map((s) => s.id));
  const backlog: TimelineFileItem[] = [];
  const orphan: TimelineFileItem[] = [];
  for (const item of file.items ?? []) {
    const assigned = assignedSprintId(item);
    if (assigned == null) backlog.push(item);
    else if (!known.has(assigned)) orphan.push(item);
  }
  if (backlog.length) {
    const scope = scopeOf(backlog, unit);
    const sum = Number.isFinite(scope.sum) ? `${points(scope.sum)} ${unitDative(unit, scope.sum)}` : String(scope.sum);
    notes.push(
      `Ohne Sprint-Zuordnung und daher in keiner Sprint-Summe: ${count(backlog.length, 'Eintrag', 'Einträge')} ` +
        `mit ${sum} (${idList(backlog)}). Diese Antwort verortet diesen Umfang nicht.`,
    );
    const missing = missingEstimateNote('Ohne Sprint-Zuordnung', scope.missing);
    if (missing) notes.push(missing);
  }
  if (orphan.length) {
    notes.push(
      `Zugeordnet auf einen Sprint, den es nicht gibt: ${nameList(orphan)} (${idList(orphan)}). Solange die Id auf ` +
        'keine Zeile zeigt, zählt der Eintrag in keinem Sprint und die Oberfläche zeigt ihn ohne Sprint.',
    );
  }
  return notes;
}

/** Keyed by the tool name the manifest declares. The two must agree. */
export const sprintsTools: Record<string, ToolHandler> = {
  plan_sprint: planSprint,
  roll_over: rollOver,
  sprint_status: sprintStatus,
};
