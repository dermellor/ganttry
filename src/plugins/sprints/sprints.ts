// The sprint entities: reading the rows the host stores for this plugin, and the
// rules over them that more than one consumer needs.
//
// This module exists because a sprint stopped being a label computed from a date.
// Membership is an act (canon makes the Sprint Backlog a *selection*), a Sprint Goal
// is the change-control criterion during the sprint, and a closed sprint's result is
// frozen, and none of that fits on a value derived from `item.start`. The reasoning and
// the sources are in ./docs/model.md; this file implements it.
//
// Three constraints shape everything below.
//
//   - **The rows are user-editable data, so nothing here throws.** They arrive from a
//     JSON file a person maintains, an MCP `plugin_data_write`, or an API call, and on
//     a local source they are in the very file the user owns. `fields.ts` runs on the
//     item form's path and `derive` runs over every item on every build, so an
//     exception here would cost the plugin its values everywhere rather than dropping
//     one malformed row. Every reader below returns the rows it could make sense of.
//   - **One rule, one place.** The view words a warning for a person, the tools word
//     it for an agent, and both must not decide *what* a warning is. So the warnings
//     are returned as data and the wording stays with the consumer. Two copies of
//     „is this item in its sprint" is how one of them ends up fixed.
//   - **Day comparison goes through `raster.ts`.** `dayOf` is the plugin's single
//     reading of a stored date, and re-deriving it here would disagree with the lanes
//     for a value carrying a zone and for a day beside a clock change (see the notes
//     in that module).
//
// It is imported statically by `fields.ts`, so it stays data-only: types, the contract
// barrel and this plugin's own modules. Anything reaching view code would land the
// plugin in the generic bundle (scripts/ci/check-bundle-split.sh).

import { hasPlugin, pluginConfig, statusOrDefault } from '../../pluginHost/api';
import type { PluginDataRow, TimelineFile, TimelineFileItem } from '../../types';
import { MIN_CAPACITY, SPRINT_COLLECTIONS, sprintsManifest } from './manifest';
import { dayOf, rasterFrom, readSprintConfig, shiftDayString, sprintFirstDay, type SprintRaster } from './raster';

/**
 * Stable id of this plugin, read from the manifest so the id exists exactly once. The
 * manifest is what the host reads, so a second copy would be the one that goes stale.
 */
export const SPRINTS_PLUGIN = sprintsManifest.id;

/**
 * The item metadata key carrying the **assigned** sprint's row id.
 *
 * Stored, and therefore owned in the manifest's `metadataKeys`. The value is a row id
 * and never a name, so renaming „Sprint 7" orphans nothing.
 */
export const SPRINT_KEY = 'sprint';

/**
 * The key of the **derived** field: the sprint whose window contains the item's start.
 *
 * Nothing is ever stored under it, which is why it is absent from `metadataKeys`. It
 * is the suggestion the plan makes, and it is deliberately a second dimension rather
 * than a correction of the assignment: moving the item's dates would edit a plan the
 * user made, moving it out of its sprint would edit a commitment the team made, so a
 * disagreement is shown instead of resolved.
 */
export const SPRINT_BY_DATE_KEY = 'sprintByDate';

/** The estimate, chosen from `scale`. Stored on the item, so owned in the manifest. */
export const STORY_POINTS_KEY = 'storyPoints';

/** How much the estimate is trusted. Stored on the item. */
export const CONFIDENCE_KEY = 'estimateConfidence';

/**
 * Where a sprint stands. `cancelled` is its own state rather than a closed sprint with
 * a reason, because canon gives it its own cause and its own authority.
 */
export const SPRINT_STATES = ['planned', 'active', 'closed', 'cancelled'] as const;
export type SprintState = (typeof SPRINT_STATES)[number];

/** What a capacity counts. */
export const CAPACITY_UNITS = ['points', 'hours', 'items'] as const;
export type CapacityUnit = (typeof CAPACITY_UNITS)[number];

/** What became of an item when a sprint closed. */
export const PASS_OUTCOMES = ['done', 'carried', 'removed', 'cancelled'] as const;
export type PassOutcome = (typeof PASS_OUTCOMES)[number];

/** One sprint, as the rest of the plugin reads it. Every optional field is absent
 * rather than empty, so „no goal" is one case instead of three. */
export type Sprint = {
  id: string;
  /**
   * 1-based position in the ordered collection.
   *
   * Not stored: it *is* the row order, and it is carried on the entity because the
   * raster fallback needs it: a sprint with no dates yet takes the window of the
   * raster sprint at its position. Recomputing it at each call site would mean every
   * caller had to keep the list it read it from, which is how one of them ends up
   * asking with an index into a filtered list.
   */
  position: number;
  name: string;
  goal?: string;
  start?: string;
  end?: string;
  state: SprintState;
  closedOn?: string;
  capacity?: number;
  capacityUnit?: CapacityUnit;
  note?: string;
};

/** One item's passage through one sprint. The per-item history an assignment cannot hold. */
export type SprintPass = {
  /** The row id the host derived from `itemId` + `sprintId`. */
  id: string;
  itemId: string;
  sprintId: string;
  outcome: PassOutcome;
  recordedOn?: string;
  estimateAtClose?: number;
};

/** The frozen result of a closed sprint. Never recomputed from live items. */
export type SprintReport = {
  id: string;
  sprintId: string;
  scopeAtStart?: number;
  scopeAtClose?: number;
  completed?: number;
  /**
   * What moved on, in the same unit.
   *
   * It counts what the unit counts, which is why a report can say `carried: 0` while a
   * `passes` row records an item as `carried`: an item nobody estimated carries no
   * points out of the sprint. In a points sprint the two statements are both true and
   * look like a contradiction, so a reader that shows one should show the other.
   */
  carried?: number;
  /**
   * What these figures and this curve count, as it stood at the close.
   *
   * Frozen with them for the same reason they are frozen: editing a closed sprint's
   * `capacityUnit` afterwards relabelled the curve („21 Punkte" became „21 Einträge",
   * same numbers), which is exactly the rewriting of history the frozen report exists
   * to prevent. Absent on every report written before the field existed, and
   * `reportUnitOf` decides what that means.
   */
  unit?: CapacityUnit;
  /**
   * The stored curve, **as stored**: `frozenSeries` (`burndown.ts`) is its only reader.
   *
   * Deliberately not parsed here. While this reader filtered and sorted first, one
   * point could be dropped here and accepted there, so the view drew „no record" for a
   * day that has one and the count of damaged entries that exists so somebody can be
   * told stayed at zero.
   */
  series: unknown;
};

/** A closed interval of calendar days, both ends inclusive and canonical. */
export type DayWindow = { start: string; end: string };

/**
 * Where a sprint's window came from. Carried on the window because every place that
 * states one has to be able to say so: a computed end presented as the sprint's own is
 * a date the team never wrote, and it is the one a warning then quotes back at them.
 */
export type WindowSource =
  /** Both dates are written on the row. */
  | 'row'
  /** The start is written, the end computed from the cadence length. */
  | 'end-from-cadence'
  /** Neither is written: the cadence window at the sprint's position in the list. */
  | 'cadence';

/** A sprint's window, and whether the team wrote it or the cadence produced it. */
export type SprintWindow = DayWindow & { source: WindowSource };

/**
 * Something the data says that a person should decide about, as **data**.
 *
 * Not formatted strings: `sprint_status` writes an agent-facing note and the view
 * writes German interface text, and a shared sentence would be wrong for one of them.
 * What must not differ is the rule, so it lives here once.
 *
 * `itemId` is nullable because an item's id is optional in this data model; `content`
 * is carried alongside so a warning can still name the item a reader sees.
 */
export type SprintWarning =
  | {
      /** Canon requires a goal; no product enforces one, so it is named while it matters. */
      kind: 'active-sprint-without-goal';
      sprintId: string;
    }
  | {
      /** „A new Sprint starts immediately after the conclusion of the previous Sprint." */
      kind: 'several-active-sprints';
      sprintIds: string[];
    }
  | {
      /** The assignment and the dates disagree. Shown, never silently resolved. */
      kind: 'item-outside-sprint-window';
      itemId: string | null;
      content: string;
      sprintId: string;
      window: SprintWindow;
    }
  | {
      /** Named rather than counted as zero: a sum that omits three items is not a capacity. */
      kind: 'item-without-estimate';
      itemId: string | null;
      content: string;
      sprintId: string;
    }
  | {
      /**
       * Two windows cover the same days.
       *
       * Nothing else can see it: an item assigned to the later sprint and starting in
       * the shared days sits inside its own window, so „outside the window" stays
       * silent, while the derived `sprintByDate` names the EARLIER row — the first
       * match wins. The two dimensions then disagree with no fault anywhere to read.
       * A sprint has a fixed length and the next one begins as the previous ends, so an
       * overlap is a row somebody mistyped rather than a plan.
       */
      kind: 'overlapping-sprint-windows';
      sprintIds: [string, string];
      /** The days both cover. */
      overlap: DayWindow;
    }
  | {
      /** A close before the sprint began. One of the two dates is wrong, and no figure can say which. */
      kind: 'closed-before-start';
      sprintId: string;
      start: string;
      closedOn: string;
    }
  | {
      /**
       * A `passes` row naming a sprint that does not exist.
       *
       * The row is kept by `readPasses` on purpose („it stays visible"), which is only
       * true if something looks at it. This is that something.
       */
      kind: 'pass-without-sprint';
      rowId: string;
      itemId: string;
      sprintId: string;
    }
  | {
      /**
       * One row id twice in one collection.
       *
       * The first row wins, deterministically, and the second then exists in the file
       * and in nothing else: not in the options, not in a sum, not in the report a
       * sprint reads. Reachable by hand rather than through the host, which is why it
       * has to be reported rather than prevented.
       */
      kind: 'duplicate-row-id';
      collection: string;
      rowId: string;
    }
  | {
      /**
       * Two `reports` rows for one sprint.
       *
       * `keyFields: ['sprintId']` makes the host replace a report rather than add one,
       * so this too only arrives by hand. `reportOfSprint` takes the first, and the
       * second is a second set of frozen figures for the same closed sprint.
       */
      kind: 'several-reports-for-one-sprint';
      sprintId: string;
      rowIds: string[];
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A trimmed, non-empty string, or undefined. Empty is absent: „" is not a goal. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * A plain decimal number, and nothing more than `Number()` would additionally read.
 *
 * Bare `Number()` takes `"0x10"` as 16 and `"1e3"` as 1000, so a typo in a
 * hand-written file enters a capacity as a figure nobody wrote, and it looks right:
 * because a number always does.
 */
const DECIMAL_RE = /^[+-]?\d+(?:\.\d+)?$/;

function decimal(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // Numeric strings are accepted because nothing checks a hand-written JSON source
  // against the collection schema: `"capacity": "20"` would otherwise read as no
  // capacity at all, with nothing saying why.
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!DECIMAL_RE.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A capacity: at least `MIN_CAPACITY`, or absent.
 *
 * The bound is the schema's rather than a bare „greater than zero", because nothing
 * checks a hand-written file against the schema and the two then disagreed: `0.005`
 * was read as a capacity here and printed as „von 0.01 Punkten" — a figure nobody
 * wrote, rounded into existence by the note that states it.
 */
function positive(value: unknown): number | undefined {
  const parsed = decimal(value);
  return parsed != null && parsed >= MIN_CAPACITY ? parsed : undefined;
}

/** A frozen figure: zero is a legitimate answer here („carried: 0"). */
function nonNegative(value: unknown): number | undefined {
  const parsed = decimal(value);
  return parsed != null && parsed >= 0 ? parsed : undefined;
}

function oneOf<T extends string>(options: readonly T[], value: unknown): T | undefined {
  const found = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return options.find((option) => option === found);
}

/**
 * The rows of one of this plugin's collections, in file order.
 *
 * Guarded three times over, although `PluginData` is a typed section: the file is one
 * people hand-edit, so `pluginData` can be a string, a collection can be an object,
 * and a row can be a number. A row with no usable `id` is dropped rather than given
 * one, because an id is what a reference resolves against and an invented one would
 * make a pass point at a sprint that does not exist.
 */
function rowsOf(file: TimelineFile | null | undefined, collection: string): PluginDataRow[] {
  if (!file || !hasPlugin(file, SPRINTS_PLUGIN)) return [];
  const own = (file as { pluginData?: unknown }).pluginData;
  if (!isPlainObject(own)) return [];
  const collections = own[SPRINTS_PLUGIN];
  if (!isPlainObject(collections)) return [];
  const rows = collections[collection];
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is PluginDataRow => isPlainObject(row) && !!text(row.id) && isPlainObject(row.data),
  );
}

/**
 * The sprints, in the order the collection declares, which is the order the field's
 * options and the lanes get, and the order the raster fallback counts in.
 *
 * A repeated id keeps its first row: two rows under one id cannot both be addressed,
 * and taking the later one would make the reference target depend on read order.
 * A row with no `name` is labelled by its id rather than dropped, because dropping it
 * would orphan every item assigned to it while the row is still there.
 */
export function readSprints(file: TimelineFile | null | undefined): Sprint[] {
  const out: Sprint[] = [];
  const seen = new Set<string>();
  for (const row of rowsOf(file, SPRINT_COLLECTIONS.sprints)) {
    const id = String(row.id).trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const data = row.data;
    out.push({
      id,
      position: out.length + 1,
      name: text(data.name) ?? id,
      goal: text(data.goal),
      start: dayOf(data.start) ?? undefined,
      end: dayOf(data.end) ?? undefined,
      // An unparseable state reads as `planned`, the state that claims the least: a row
      // nobody can read must not become the active sprint, and must not let a closed
      // sprint's frozen figures be taken as current.
      state: oneOf(SPRINT_STATES, data.state) ?? 'planned',
      closedOn: dayOf(data.closedOn) ?? undefined,
      capacity: positive(data.capacity),
      capacityUnit: oneOf(CAPACITY_UNITS, data.capacityUnit),
      note: text(data.note),
    });
  }
  return out;
}

/**
 * The per-item history, in file order.
 *
 * A row without both ids, or with an outcome that is none of the four, is dropped: the
 * outcome is the whole content of the record, and defaulting it would put a number
 * into a report that nobody entered. A row pointing at a sprint that does not exist is
 * **kept**: it is well-formed data, and `passesOfSprint` never yields it anyway, so
 * dropping it would hide a dangling reference instead of leaving it visible.
 */
export function readPasses(file: TimelineFile | null | undefined): SprintPass[] {
  const out: SprintPass[] = [];
  for (const row of rowsOf(file, SPRINT_COLLECTIONS.passes)) {
    const data = row.data;
    const itemId = text(data.itemId);
    const sprintId = text(data.sprintId);
    const outcome = oneOf(PASS_OUTCOMES, data.outcome);
    if (!itemId || !sprintId || !outcome) continue;
    out.push({
      id: String(row.id).trim(),
      itemId,
      sprintId,
      outcome,
      recordedOn: dayOf(data.recordedOn) ?? undefined,
      estimateAtClose: nonNegative(data.estimateAtClose),
    });
  }
  return out;
}

/**
 * The frozen reports, in file order, their curves **untouched**.
 *
 * The figures are read the way every other field is; the `series` is carried through as
 * stored, because there is exactly one reader of a frozen curve and it is
 * `frozenSeries` (`burndown.ts`), which reads it against the window it is drawn on.
 *
 * This reader used to filter and sort the points first, and the two then disagreed in
 * both directions over one row: a point with a negative `remaining` was dropped here
 * and would have been accepted (and clamped to the baseline) there, so the view drew
 * „kein Verlauf" for a day that has a record, while the count of damaged entries that
 * exists so the view can say so stayed at zero. The sort is not lost: `frozenSeries`
 * orders the points by their position in the window, which is the order they are drawn
 * in and a stricter statement than a string sort.
 */
export function readReports(file: TimelineFile | null | undefined): SprintReport[] {
  const out: SprintReport[] = [];
  for (const row of rowsOf(file, SPRINT_COLLECTIONS.reports)) {
    const data = row.data;
    const sprintId = text(data.sprintId);
    if (!sprintId) continue;
    out.push({
      id: String(row.id).trim(),
      sprintId,
      scopeAtStart: nonNegative(data.scopeAtStart),
      scopeAtClose: nonNegative(data.scopeAtClose),
      completed: nonNegative(data.completed),
      carried: nonNegative(data.carried),
      unit: oneOf(CAPACITY_UNITS, data.unit),
      series: data.series,
    });
  }
  return out;
}

/**
 * Row ids a collection carries more than once, in the order they first repeat.
 *
 * The readers keep the first row under an id, which is the only deterministic choice:
 * two rows under one id cannot both be addressed, and taking the later one would make a
 * reference target depend on read order. That leaves the second row present in the file
 * and in nothing else, which is what this reports.
 */
function repeatedRowIds(file: TimelineFile | null | undefined, collection: string): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const row of rowsOf(file, collection)) {
    const id = String(row.id).trim();
    if (!seen.has(id)) seen.add(id);
    else if (!repeated.includes(id)) repeated.push(id);
  }
  return repeated;
}

/** The raster the config describes, or null when it describes none. */
export function rasterOf(file: TimelineFile | null | undefined): SprintRaster | null {
  if (!file || !hasPlugin(file, SPRINTS_PLUGIN)) return null;
  return rasterFrom(readSprintConfig(pluginConfig(file, SPRINTS_PLUGIN)));
}

/** What a capacity counts when a sprint names no unit: the config's, else points. */
export function readEstimateUnit(file: TimelineFile | null | undefined): CapacityUnit {
  const config = file && hasPlugin(file, SPRINTS_PLUGIN) ? pluginConfig(file, SPRINTS_PLUGIN) : null;
  return oneOf(CAPACITY_UNITS, config?.estimateUnit) ?? 'points';
}

/** The unit one sprint's capacity is in. One place, so a row and the config cannot
 * be read in a different order by two consumers. */
export function capacityUnitOf(sprint: Sprint, file: TimelineFile | null | undefined): CapacityUnit {
  return sprint.capacityUnit ?? readEstimateUnit(file);
}

/**
 * The unit a closed sprint's **frozen** figures are counted in: the report's own when
 * it carries one, the live chain otherwise.
 *
 * The report wins because its numbers were frozen in that unit. Reading the sprint row
 * instead let an edit to a closed sprint's `capacityUnit` relabel figures and a curve
 * that nothing recomputes: 21 points shown as „21 Einträge", with no number changing
 * and nothing saying they had been reinterpreted. A report without the field falls back,
 * which is the best available answer for one written before the field existed.
 */
export function reportUnitOf(
  report: SprintReport | null | undefined,
  sprint: Sprint,
  file: TimelineFile | null | undefined,
): CapacityUnit {
  return report?.unit ?? capacityUnitOf(sprint, file);
}

/** The sprint with this id, or null. */
export function sprintById(sprints: readonly Sprint[], id: string | null | undefined): Sprint | null {
  if (!id) return null;
  return sprints.find((sprint) => sprint.id === id) ?? null;
}

/**
 * The days the raster covers for a sprint at `position`.
 *
 * Both ends come from `raster.ts`: the last day is the next sprint's first day shifted
 * back by one, so the length rule stays in the module that owns the day arithmetic.
 */
export function rasterWindow(raster: SprintRaster | null | undefined, position: number): SprintWindow | null {
  if (!raster) return null;
  const start = sprintFirstDay(raster, position);
  const next = sprintFirstDay(raster, position + 1);
  if (!start || !next) return null;
  const end = shiftDayString(next, -1);
  return end ? { start, end, source: 'cadence' } : null;
}

/**
 * The days a sprint covers and where those days came from, or null when nothing says.
 *
 * The row wins when it carries both dates, because that is what a team wrote down.
 *
 * **A written start is never discarded.** A row with a start and no end used to fall
 * back to the cadence window at its position, which moved the whole window: a sprint
 * starting 2026-05-01 was tested against 2026-01-05 to 2026-01-18, so an item starting
 * 2026-05-04 — inside the only window anybody had written — was reported as
 * contradicting its assignment. So the start stays and the end is computed from the
 * cadence length, `source` says which half that was, and every consumer states it. The
 * same holds for an end before its start: that pair cannot both be right, and the start
 * is the half a plan is built forward from.
 *
 * Without a cadence there is no length to compute with, and `lengthDays` is never
 * guessed (see `raster.ts`), so such a row has no window at all rather than a
 * fourteen-day one nobody configured.
 *
 * A row carrying only an end keeps falling back to the cadence window: „a sprint of the
 * usual length ending here" is a second rule, and the position is a statement the file
 * already makes.
 */
export function sprintWindow(
  sprint: Sprint | null | undefined,
  raster: SprintRaster | null | undefined,
): SprintWindow | null {
  if (!sprint) return null;
  if (sprint.start && sprint.end && sprint.start <= sprint.end) {
    return { start: sprint.start, end: sprint.end, source: 'row' };
  }
  if (sprint.start && raster) {
    const end = shiftDayString(sprint.start, raster.lengthDays - 1);
    if (end) return { start: sprint.start, end, source: 'end-from-cadence' };
  }
  return rasterWindow(raster, sprint.position);
}

/** Does a stored date fall inside the window? False for a value that names no day. */
export function windowContains(window: DayWindow | null | undefined, value: unknown): boolean {
  const day = dayOf(value);
  if (!window || !day) return false;
  return day >= window.start && day <= window.end;
}

/** The row id an item is assigned to, or null. Never a name, so a rename orphans nothing. */
export function assignedSprintId(item: TimelineFileItem | null | undefined): string | null {
  return text(item?.metadata?.[SPRINT_KEY]) ?? null;
}

/** The items assigned to a sprint, in the order the timeline carries them. */
export function itemsOfSprint(
  items: readonly TimelineFileItem[] | null | undefined,
  sprintId: string,
): TimelineFileItem[] {
  return (items ?? []).filter((item) => assignedSprintId(item) === sprintId);
}

/**
 * The sprint the item's **start** falls into: the suggestion, not the membership.
 *
 * The first matching row wins. Windows cannot overlap in data the host wrote, but a
 * hand-edited file can overlap them, and „the earlier row" is at least an order a
 * reader can predict; picking the shortest or the latest would make the lane an item
 * sits in depend on a rule nobody can see.
 */
export function suggestedSprintId(
  sprints: readonly Sprint[],
  raster: SprintRaster | null | undefined,
  item: TimelineFileItem | null | undefined,
): string | null {
  if (!item || !dayOf(item.start)) return null;
  for (const sprint of sprints) {
    if (windowContains(sprintWindow(sprint, raster), item.start)) return sprint.id;
  }
  return null;
}

/**
 * Is the item finished? The core's item status is the mapping, and that is the
 * Definition of Done as far as any figure in this plugin goes, so the plugin does not
 * reimplement the defaulting an absent status has.
 */
export function isDone(item: TimelineFileItem | null | undefined): boolean {
  return statusOrDefault(item?.status) === 'Done';
}

/**
 * The item's estimate, or null when it carries none that can be summed.
 *
 * A `select` value is a string in this data model, so `"8"` is the normal shape and a
 * number is accepted for an agent that wrote one directly. Zero and negative are „no
 * usable estimate" rather than a value: they cannot move a sum, so counting them would
 * only take the item out of the notes.
 */
export function estimateOf(item: TimelineFileItem | null | undefined): number | null {
  const raw = item?.metadata?.[STORY_POINTS_KEY];
  const parsed = decimal(raw);
  return parsed != null && parsed > 0 ? parsed : null;
}

/** The sprints that are `active`. More than one is a violation, which is why this
 * returns a list rather than the first one it finds. */
export function activeSprints(sprints: readonly Sprint[]): Sprint[] {
  return sprints.filter((sprint) => sprint.state === 'active');
}

/** The one active sprint, or null when there is none, and null when there are
 * several, because „which one" has no answer then and picking one hides the fault. */
export function activeSprint(sprints: readonly Sprint[]): Sprint | null {
  const active = activeSprints(sprints);
  return active.length === 1 ? active[0] : null;
}

/** A sprint's history, in file order. */
export function passesOfSprint(passes: readonly SprintPass[], sprintId: string): SprintPass[] {
  return passes.filter((pass) => pass.sprintId === sprintId);
}

/** A sprint's frozen report, or null. */
export function reportOfSprint(reports: readonly SprintReport[], sprintId: string): SprintReport | null {
  return reports.find((report) => report.sprintId === sprintId) ?? null;
}

/** One item this sprint received from an earlier one, as that sprint's close recorded it. */
export type CarriedIn = {
  itemId: string;
  /** The sprint it was carried out of. */
  fromSprintId: string;
  recordedOn?: string;
  /** The estimate as it stood at that close. Absent when nobody had sized it. */
  estimateAtClose?: number;
};

/**
 * The items a sprint holds that an earlier sprint's close recorded as `carried`.
 *
 * This is what `passes` is **for**, and until now nothing read it: the rows were
 * written at every close and justified as „so it stays visible", which is only true
 * once something looks. What it answers is a question the assignment cannot: a sprint's
 * scope contains work that was already committed once, and „the third sprint in a row
 * this item did not get done" is not visible in any current figure.
 *
 * Only a sprint EARLIER in the list counts. A `carried` row of a later sprint is not
 * something this one received, and reporting it as such would read as history running
 * backwards.
 */
export function carriedInto(
  sprints: readonly Sprint[],
  passes: readonly SprintPass[],
  items: readonly TimelineFileItem[] | null | undefined,
  sprintId: string,
): CarriedIn[] {
  const target = sprintById(sprints, sprintId);
  if (!target) return [];
  const out: CarriedIn[] = [];
  for (const item of itemsOfSprint(items, sprintId)) {
    const itemId = text(item.id);
    if (!itemId) continue;
    for (const pass of passes) {
      if (pass.itemId !== itemId || pass.outcome !== 'carried' || pass.sprintId === sprintId) continue;
      const from = sprintById(sprints, pass.sprintId);
      if (!from || from.position >= target.position) continue;
      out.push({
        itemId,
        fromSprintId: from.id,
        recordedOn: pass.recordedOn,
        estimateAtClose: pass.estimateAtClose,
      });
    }
  }
  return out;
}

/** How many closed sprints a capacity suggestion averages over. */
export const VELOCITY_WINDOW = 3;

/**
 * A capacity to suggest for a sprint that has none: the mean completed figure of the
 * last closed sprints that have a report.
 *
 * It is a **suggestion and never a metric**. No figure computed here is displayed as a
 * velocity and nothing draws committed against completed: the framework moved away
 * from „commitment" for a sprint's scope in 2011, and the warnings against comparing
 * teams by velocity are on the record (see ./docs/model.md). A number on a page invites
 * exactly the use those warn about.
 *
 * Null when no closed sprint has a report: a suggestion out of no evidence is a guess
 * wearing a figure's clothes.
 */
export function suggestedCapacity(
  sprints: readonly Sprint[],
  reports: readonly SprintReport[],
): number | null {
  const completed = sprints
    .filter((sprint) => sprint.state === 'closed')
    .map((sprint) => reportOfSprint(reports, sprint.id)?.completed)
    .filter((value): value is number => value != null)
    .slice(-VELOCITY_WINDOW);
  if (!completed.length) return null;
  return completed.reduce((sum, value) => sum + value, 0) / completed.length;
}

/**
 * Everything the data says that a person should decide about, in a stable order:
 * the sprint-level facts first, then one item at a time.
 *
 * **„No active sprint" is deliberately not among them.** Nothing in the host fires at
 * a sprint boundary, so the plugin cannot know whether a sprint *should* have started;
 * a plan whose first sprint has not begun is the normal state of a plan, and a warning
 * there would fire on every timeline that has one. What canon supports is the opposite
 * direction, and that is the one warned about: a second active sprint.
 *
 * The dates check compares the item's start, and its end when it carries one. **A
 * `duration` is deliberately not resolved into an end here**, although the contract now
 * carries the arithmetic (host API 1.6) and `burndown.ts` uses it: the end a duration
 * describes is the instant the bar stops, so a two-week item on the first day of a
 * fortnight-long sprint resolves to the day AFTER the window's last. Comparing that
 * against a window whose both ends are inclusive would report a contradiction for
 * every item in a plan that agrees with itself — which is the same false alarm this
 * function was fixed for on the window side.
 */
export function sprintWarnings(file: TimelineFile | null | undefined): SprintWarning[] {
  const sprints = readSprints(file);
  if (!sprints.length) return [];
  const raster = rasterOf(file);
  const out: SprintWarning[] = [];
  // Once per sprint, not once per pair and once per item: the pair check below is
  // quadratic, and one window computed twice is one place for the two answers to differ.
  const windows = new Map<string, SprintWindow | null>(
    sprints.map((sprint) => [sprint.id, sprintWindow(sprint, raster)]),
  );

  const active = activeSprints(sprints);
  for (const sprint of active) {
    if (!sprint.goal) out.push({ kind: 'active-sprint-without-goal', sprintId: sprint.id });
  }
  if (active.length > 1) {
    out.push({ kind: 'several-active-sprints', sprintIds: active.map((sprint) => sprint.id) });
  }

  // A close before the sprint began. One of the two dates is wrong and no figure here
  // can say which, so both are handed over rather than one being taken as the truth.
  for (const sprint of sprints) {
    if (sprint.closedOn && sprint.start && sprint.closedOn < sprint.start) {
      out.push({
        kind: 'closed-before-start',
        sprintId: sprint.id,
        start: sprint.start,
        closedOn: sprint.closedOn,
      });
    }
  }

  // Every pair, not just the neighbours: the windows come from rows in any order, and
  // two that overlap need not be adjacent in the list. Cadence windows cannot overlap
  // each other, but a written one and a cadence one can, which is why the source is
  // not a filter here.
  for (let i = 0; i < sprints.length; i++) {
    const a = windows.get(sprints[i].id);
    if (!a) continue;
    for (let j = i + 1; j < sprints.length; j++) {
      const b = windows.get(sprints[j].id);
      if (!b || a.start > b.end || b.start > a.end) continue;
      out.push({
        kind: 'overlapping-sprint-windows',
        sprintIds: [sprints[i].id, sprints[j].id],
        overlap: {
          start: a.start > b.start ? a.start : b.start,
          end: a.end < b.end ? a.end : b.end,
        },
      });
    }
  }

  for (const collection of Object.values(SPRINT_COLLECTIONS)) {
    for (const rowId of repeatedRowIds(file, collection)) {
      out.push({ kind: 'duplicate-row-id', collection, rowId });
    }
  }

  const known = new Set(sprints.map((sprint) => sprint.id));
  for (const pass of readPasses(file)) {
    // `readPasses` keeps such a row rather than dropping it, so that it stays visible.
    // This is the place it becomes visible.
    if (!known.has(pass.sprintId)) {
      out.push({ kind: 'pass-without-sprint', rowId: pass.id, itemId: pass.itemId, sprintId: pass.sprintId });
    }
  }

  const reportRows = new Map<string, string[]>();
  for (const report of readReports(file)) {
    const rows = reportRows.get(report.sprintId);
    if (rows) rows.push(report.id);
    else reportRows.set(report.sprintId, [report.id]);
  }
  for (const [sprintId, rowIds] of reportRows) {
    // Distinct row ids, so a repeated one is the duplicate warning above and not a
    // second finding about the same fault.
    const distinct = [...new Set(rowIds)];
    if (distinct.length > 1) out.push({ kind: 'several-reports-for-one-sprint', sprintId, rowIds: distinct });
  }

  for (const item of file?.items ?? []) {
    const sprintId = assignedSprintId(item);
    if (!sprintId) continue;
    const sprint = sprintById(sprints, sprintId);
    // An assignment naming no row is left alone here: the sprint may have been
    // deleted, and the item then carries a value that resolves to nothing, which the
    // field shows as a value with no option rather than as a sprint problem.
    if (!sprint) continue;
    const itemId = text(item.id) ?? null;
    const content = item.content ?? '';

    const window = windows.get(sprint.id);
    if (window) {
      const start = dayOf(item.start);
      const end = dayOf(item.end);
      const outside =
        (start != null && (start < window.start || start > window.end)) ||
        (end != null && (end < window.start || end > window.end));
      if (outside) out.push({ kind: 'item-outside-sprint-window', itemId, content, sprintId, window });
    }

    if (estimateOf(item) == null) out.push({ kind: 'item-without-estimate', itemId, content, sprintId });
  }

  return out;
}
