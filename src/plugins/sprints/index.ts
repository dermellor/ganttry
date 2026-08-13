// The sprint's own page: its goal, its numbers, its burndown, its items.
//
// The registry reaches this file through a dynamic `import()`, so Rollup emits
// everything below as its own chunk and a deploy without this plugin downloads
// none of it. The stylesheet is imported *here* rather than linked from
// `index.html`, which is what puts the CSS in that chunk too — the promise
// `scripts/ci/check-bundle-split.sh` asserts.
//
// **What this view is for.** `docs/model.md` makes the Sprint Goal the point of a
// sprint: canon's change-control criterion during the sprint, what the Daily Scrum
// inspects, the only cancellation trigger. A grouping dimension cannot hold that,
// which is why the sprint became a row and why the row needs a page.
//
// **Nothing here decides a domain rule.** Which items belong to a sprint, what
// „done" means, what counts as an estimate, what a warning is: all of it comes from
// `./sprints.ts`, because `sprint_status` answers the same questions for an agent
// and two copies of one rule is how the chart's scope and the agent's scope end up
// different numbers, each looking right on its own. This file words those answers
// in German and draws them.
//
// **Two numbers this view will never show**, both settled with sources in
// „Velocity: computed, never displayed as a metric":
//
//   - a velocity figure. It is used to *suggest* a capacity and is not a result.
//   - a „committed versus completed" pair. The framework moved away from
//     „commitment" for a sprint's scope in 2011, and the objection to comparing
//     teams by output is the general form of the same point.
//
// A future reader adding either would be adding the thing the model argues
// against, so the absence is deliberate rather than unfinished.

import './sprints.css';

import {
  Badge,
  Button,
  Callout,
  Field,
  FormActions,
  FormGrid,
  Heading,
  Select,
  StatusDot,
  Table,
  TableCell,
  TableHead,
  TableRow,
  Text,
  TextArea,
  TextInput,
  ToolbarControl,
  el,
  statusOrDefault,
  type HostApi,
  type PluginRow,
  type TimelineSnapshot,
} from '../../pluginHost/api';
import type { TimelineFileItem } from '../../types';
import { SPRINT_COLLECTIONS, sprintsManifest } from './manifest';
import { dayOf, type SprintRaster } from './raster';
import {
  CAPACITY_UNITS,
  type CapacityUnit,
  capacityUnitOf,
  carriedInto,
  estimateOf,
  isDone,
  itemsOfSprint,
  rasterOf,
  readEstimateUnit,
  readPasses,
  readReports,
  readSprints,
  reportOfSprint,
  reportUnitOf,
  type Sprint,
  SPRINT_STATES,
  type SprintPass,
  type SprintReport,
  type SprintState,
  type SprintWarning,
  sprintWarnings,
  sprintWindow,
  suggestedCapacity,
} from './sprints';
import {
  MAX_SPRINT_DAYS,
  axisMax,
  frozenSeries,
  idealSeries,
  parseEstimate,
  polylinePoints,
  reconstructSeries,
  round2,
  scopeAndCompleted,
  splitAtGaps,
  sprintDays,
  tickIndices,
  xForIndex,
  yForValue,
  type BurndownItem,
  type BurndownPoint,
  type PlotBox,
} from './burndown';

/** The view id the manifest declares. Anything else is not this plugin's. */
const VIEW_ID = 'board';

/** Which sprint the reader was last looking at. See the note in `paint`. */
const SELECTED_KEY = 'timelines.sprintsSelected';

const STATE_LABELS: Record<SprintState, string> = {
  planned: 'geplant',
  active: 'aktiv',
  closed: 'abgeschlossen',
  cancelled: 'abgebrochen',
};

const UNIT_LABELS: Record<CapacityUnit, string> = {
  points: 'Punkte',
  hours: 'Stunden',
  items: 'Einträge',
};

const numbers = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });

/** The mark for a figure the data does not carry. Never a 0, which reads as measured. */
const NO_FIGURE = '–';

// ---------------------------------------------------------------------------
// The render pass.
//
// A module-level snapshot rather than an await at each call site, for the reason
// `product-roadmap/host.ts` gives: the host API is async by contract so it can move
// behind an iframe, and this tree reads the model in two dozen places, most of them
// inside builders that cannot become async without turning every caller async too.
// The snapshot is taken once per pass and read synchronously.
//
// The consequence to respect: `file` is a copy. Writing through it changes nothing
// on the server, which is why every write below goes through `host.data` and then
// re-reads.
// ---------------------------------------------------------------------------

let api: HostApi | null = null;
let file: TimelineSnapshot | null = null;
let writable = false;
let sprints: Sprint[] = [];
let reports: SprintReport[] = [];
// The history rows. Read for „aus Sprint 2 übertragen": a close writes them, and until
// something looked at them the per-item history was a store with no reader.
let passes: SprintPass[] = [];
let warnings: SprintWarning[] = [];
let raster: SprintRaster | null = null;
/** Row id → the host's lock counter. See `versionsFrom`. */
let versions = new Map<string, number>();
let section: HTMLElement | null = null;
let selectedId: string | null = null;
let editing = false;
/** Notices that outlive one paint: a partial close has to stay on screen. */
let notices: { tone: 'danger' | 'warning' | 'info'; text: string }[] = [];

function host(): HostApi {
  if (!api) throw new Error('sprints: no host API — renderView has not run yet');
  return api;
}

/**
 * Row id → the host's lock counter, read off the row envelopes.
 *
 * `readSprints` hands back entities and drops the envelope on purpose, so the
 * counter has to be read separately. It is not optional: without it every edit is a
 * blind write, and a concurrent change is overwritten silently instead of answering
 * 409. **This wants to become a `rowVersion` on `Sprint`** — the way
 * `product-roadmap`'s `entity()` carries one — which is a change to `sprints.ts`
 * rather than to this file.
 */
function versionsFrom(rows: readonly PluginRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) if (row?.id && row.version != null) out.set(row.id, row.version);
  return out;
}

function rawRows(snapshot: TimelineSnapshot | null, collection: string): PluginRow[] {
  const own = snapshot?.pluginData?.[sprintsManifest.id]?.[collection];
  return Array.isArray(own) ? own : [];
}

/**
 * Today, as the day a reconstruction runs to. The one clock read in this plugin,
 * which is why every function in `burndown.ts` takes it as an argument instead.
 *
 * Local components, because that is what `dayOf` reads a stored date back as and
 * what the viewer draws a bar on. A UTC day would leave the chart a day short of
 * today between local midnight and 01:00 in a UTC+ zone, with nothing saying why.
 */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `2026-03-02` as `02.03.2026`, or the value itself when it names no day. */
function germanDay(value: string | undefined | null): string | null {
  if (!value) return null;
  const day = dayOf(value);
  if (!day) return value;
  const [year, month, dd] = day.split('-');
  return `${dd}.${month}.${year}`;
}

/**
 * What to call an item in a warning: its title, and its id only when it has none.
 *
 * A warning naming three row ids is a warning nobody can act on without looking
 * each one up.
 */
function itemLabel(item: TimelineFileItem): string {
  return item.content?.trim() || item.id?.trim() || '(ohne Titel)';
}

/**
 * The key `sprintWarnings` identifies an item by: its id, and its title as well,
 * because an item's id is optional in this data model.
 *
 * The separator is written as an escape rather than as the character itself: a
 * literal NUL in the source makes `grep` treat the whole file as binary, and the CI
 * checks that scan `src/**` for a hand-built button or a plugin id then skip it
 * silently. It is `\u0000` because a title and an id may both contain anything a
 * person can type, and two different pairs must not collide into one key.
 */
function warningKey(itemId: string | null, content: string): string {
  return `${itemId ?? ''}\u0000${content}`;
}

// ---------------------------------------------------------------------------
// The chart.
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_W = 720;
const VIEW_H = 300;
const BOX: PlotBox = { left: 48, top: 16, width: 656, height: 244 };
/** The most day labels that fit across 656 units without touching. */
const X_LABELS = 7;
const Y_LINES = 4;
/**
 * Above this many days the per-day dots are dropped and only the line is drawn:
 * 400 marks on 656 units merge into a band, which reads as a thicker line with no
 * information in it.
 */
const DOT_LIMIT = 62;

/**
 * An SVG element. `el()` cannot build one — it creates HTML elements, and an `<svg>`
 * child needs the SVG namespace — and `fromHtml()` takes a source literal only,
 * which a data-driven chart is not.
 */
function svg(
  doc: Document,
  tag: string,
  attrs: Record<string, string | number>,
  children: (Element | null)[] = [],
): SVGElement {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

type ChartInput = {
  days: string[];
  scope: number;
  plan: BurndownPoint[];
  actual: BurndownPoint[];
  ariaLabel: string;
};

/**
 * How many day labels to draw.
 *
 * The SVG scales uniformly with its column, so at a narrow width every label shrinks
 * with the chart and seven dates collide into a grey smear. Fewer labels is the half
 * of the answer that belongs here; the other half is the font size, which
 * `sprints.css` bumps at the same breakpoint.
 *
 * Measured against the **viewport** rather than the container, because the container
 * is detached while this renders: the host hands the plugin a staging element and
 * swaps it in when the render settles (src/pluginHost/renderView.ts), so its
 * `clientWidth` is 0 here. The viewport decides the same question closely enough — a
 * chart in a 375px window has room for two dates, not seven.
 */
function labelCount(doc: Document): number {
  const width = doc.defaultView?.innerWidth ?? 1200;
  return Math.max(2, Math.min(X_LABELS, Math.floor(width / 150)));
}

/**
 * The burndown as inline SVG: the ideal line, the recorded one, and the axes.
 *
 * Built here rather than added to the design system on purpose. A chart with one
 * consumer is not a component; making it one would put a burndown in the playground
 * for every plugin to inherit, and „a missing variant is added to the component"
 * would then apply to a shape only this plugin has. No charting library either: two
 * polylines and eleven text nodes do not need one.
 *
 * Every colour comes from `sprints.css` through a class, so the chart is themeable
 * with everything else and no colour is written into the markup.
 */
function chart(doc: Document, input: ChartInput): SVGElement {
  const { days, scope, plan, actual, ariaLabel } = input;
  const max = axisMax(scope, plan, actual);
  const baseline = BOX.top + BOX.height;

  const gridlines: Element[] = [];
  for (let i = 0; i <= Y_LINES; i++) {
    const value = (max / Y_LINES) * i;
    const y = yForValue(value, max, BOX);
    gridlines.push(
      svg(doc, 'line', {
        class: 'sprints-grid-line',
        x1: BOX.left,
        x2: BOX.left + BOX.width,
        y1: y,
        y2: y,
      }),
    );
    const label = svg(doc, 'text', {
      class: 'sprints-axis-label',
      x: BOX.left - 8,
      y,
      'text-anchor': 'end',
      'dominant-baseline': 'middle',
    });
    label.textContent = numbers.format(round2(value));
    gridlines.push(label);
    // A sprint with no scope has one line, not five identical zeroes.
    if (max === 0) break;
  }

  const ticks = tickIndices(days.length, labelCount(doc));
  const dayLabels = ticks.map((index, at) => {
    // The outer two labels are anchored to their edge rather than centred on it: a
    // centred label on the last day hangs half outside the viewBox and gets clipped,
    // which is how a burndown ends on an unreadable date.
    const anchor = at === 0 ? 'start' : at === ticks.length - 1 ? 'end' : 'middle';
    const node = svg(doc, 'text', {
      class: 'sprints-axis-label',
      x: xForIndex(index, days.length, BOX),
      y: baseline + 18,
      'text-anchor': anchor,
    });
    // Day and month only: the year is on the sprint's own window line above, and
    // repeating it seven times across the axis is what makes the labels collide.
    node.textContent = (germanDay(days[index]) ?? '').slice(0, 6);
    return node;
  });

  const planLine = plan.length
    ? svg(doc, 'polyline', { class: 'sprints-plan-line', points: polylinePoints(plan, days, max, BOX) })
    : null;

  // One line per run of consecutive days, so a gap in a frozen series stays a gap:
  // a polyline drawn straight through it would claim a measurement nobody took.
  const actualRuns = splitAtGaps(actual, days).map((run) =>
    run.length > 1
      ? svg(doc, 'polyline', { class: 'sprints-actual-line', points: polylinePoints(run, days, max, BOX) })
      : null,
  );
  // A run of one has no line to draw, so the dots are what make it visible at all —
  // which is the whole chart on a one-day sprint.
  const actualDots =
    days.length <= DOT_LIMIT
      ? actual.map((point) => {
          const at = days.indexOf(point.day);
          if (at < 0) return null;
          return svg(doc, 'circle', {
            class: 'sprints-actual-dot',
            cx: xForIndex(at, days.length, BOX),
            cy: yForValue(point.remaining, max, BOX),
            r: 2.5,
          });
        })
      : [];

  return svg(
    doc,
    'svg',
    {
      class: 'sprints-chart-svg',
      viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': ariaLabel,
    },
    [
      ...gridlines,
      svg(doc, 'line', { class: 'sprints-grid-line', x1: BOX.left, x2: BOX.left, y1: BOX.top, y2: baseline }),
      ...dayLabels,
      planLine,
      ...actualRuns,
      ...actualDots,
    ],
  );
}

function legendKey(label: string, series: 'plan' | 'actual'): HTMLElement {
  return el('span', { class: 'sprints-legend-key' }, [
    el('span', { class: 'sprints-legend-swatch', 'data-series': series, 'aria-hidden': 'true' }),
    label,
  ]);
}

// ---------------------------------------------------------------------------
// The numbers.
// ---------------------------------------------------------------------------

/**
 * Scope, completed and remaining — and where they came from.
 *
 * `frozen` is the part that matters: for a closed sprint the figures are read out of
 * the report and never recomputed, for the same reason its curve is not. The item
 * list keeps moving after a sprint closes, so a recomputed „completed" turns every
 * later edit into a rewrite of what the sprint delivered.
 *
 * A figure the report does not carry stays null and is drawn as a dash. Falling back
 * to a recomputation there would be the rewrite in one field instead of four.
 */
type Figures = {
  scope: number | null;
  completed: number | null;
  remaining: number | null;
  /** What the figures count. A closed sprint takes it from its report, not from the row. */
  unit: CapacityUnit;
  frozen: boolean;
};

function liveFigures(sprint: Sprint, members: readonly TimelineFileItem[]): Figures {
  // `scopeAndCompleted` rather than a sum of its own, over the same items the curve
  // is built from: an item with no usable estimate enters neither, because counting
  // it as zero is what makes a scope look complete when it is not.
  //
  // The unit is passed in because „items" counts entries rather than summing their
  // points. Without it the figures were points under an „Einträge" label.
  const { scope, completed } = scopeAndCompleted(burndownItems(members), capacityUnitOf(sprint, file));
  return {
    scope,
    completed,
    // Null rather than a number when either half is not representable: a sum that
    // overflowed is not a figure, and subtracting it produced NaN in the header and
    // `NaN` coordinates in the chart.
    remaining: scope != null && completed != null ? round2(scope - completed) : null,
    unit: capacityUnitOf(sprint, file),
    frozen: false,
  };
}

function figuresFor(sprint: Sprint, members: readonly TimelineFileItem[], report: SprintReport | null): Figures {
  const isPast = sprint.state === 'closed' || sprint.state === 'cancelled';
  if (isPast && report) {
    return {
      scope: report.scopeAtClose ?? null,
      completed: report.completed ?? null,
      remaining: report.carried ?? null,
      // The unit the figures were counted in, from the report itself where it has one.
      // The sprint's own `capacityUnit` may have been edited since.
      unit: reportUnitOf(report, sprint, file),
      frozen: true,
    };
  }
  return liveFigures(sprint, members);
}

function numberBox(label: string, value: string): HTMLElement {
  return el('div', { class: 'sprints-number' }, [
    el('span', { class: 'sprints-number-value' }, value),
    el('span', { class: 'sprints-number-label' }, label),
  ]);
}

function figure(value: number | null): string {
  return value == null ? NO_FIGURE : numbers.format(value);
}

function numbersBlock(sprint: Sprint, figures: Figures): HTMLElement {
  // The figures' own unit, not the timeline's default: a closed sprint's numbers come
  // out of its frozen report, which carries the unit they were counted in. Reading the
  // config here labelled a frozen count of entries as points.
  const unit = UNIT_LABELS[figures.unit];
  const boxes = [
    numberBox(`Umfang (${unit})`, figure(figures.scope)),
    numberBox('Abgeschlossen', figure(figures.completed)),
    numberBox('Offen', figure(figures.remaining)),
  ];
  // Only when the sprint carries one. A „Kapazität: –" box invites the reader to
  // treat the dash as a number, and there is no team constant to fall back on: what
  // a team can take varies with absences and with a shortened sprint.
  if (sprint.capacity != null) {
    boxes.push(numberBox(`Kapazität (${UNIT_LABELS[capacityUnitOf(sprint, file)]})`, numbers.format(sprint.capacity)));
  }
  return el('div', { class: 'sprints-numbers' }, boxes);
}

// ---------------------------------------------------------------------------
// The header.
// ---------------------------------------------------------------------------

/** „02.03. bis 13.03.2026", plus where the window came from when it is not the row's. */
function windowText(sprint: Sprint): string | null {
  const window = sprintWindow(sprint, raster);
  if (!window) return null;
  const from = germanDay(window.start) ?? '';
  const to = germanDay(window.end) ?? '';
  const range = `${from.slice(0, 6)} bis ${to}`;
  // Said rather than hidden, and the three cases are different statements: a window
  // the row does not carry at all moves when the rows are reordered, while a written
  // start with a computed end does not. Labelling the second as „from the cadence"
  // claimed the row's own start was invented.
  if (window.source === 'row') return range;
  if (window.source === 'end-from-cadence') return `${range} (Ende aus der Sprintlänge)`;
  return `${range} (aus dem Raster der Konfiguration)`;
}

function headerBlock(sprint: Sprint): HTMLElement {
  const children: (Element | string | null)[] = [
    el('div', { class: 'sprints-title-row' }, [
      Heading({ level: 2, text: sprint.name }),
      Badge({
        label: STATE_LABELS[sprint.state],
        tone: sprint.state === 'active' ? 'accent' : sprint.state === 'planned' ? 'neutral' : 'muted',
      }),
    ]),
  ];
  const window = windowText(sprint);
  if (window) children.push(el('div', { class: 'sprints-meta' }, Text({ text: window, tone: 'muted', size: 'sm' })));

  const goalMissing = warnings.some((w) => w.kind === 'active-sprint-without-goal' && w.sprintId === sprint.id);
  if (sprint.goal) {
    children.push(el('p', { class: 'sprints-goal' }, sprint.goal));
  } else if (goalMissing) {
    // The one place canon and the products disagree: canon requires a Sprint Goal,
    // no product enforces one. Nullable in storage, stated here while the sprint
    // runs, which is the only way to be true to both.
    children.push(
      Callout({ tone: 'warning', role: 'note', text: 'Dieser Sprint ist aktiv und hat kein Sprint-Ziel.' }),
    );
  }
  if (sprint.closedOn) {
    children.push(Text({ text: `Abgeschlossen am ${germanDay(sprint.closedOn)}`, tone: 'muted', size: 'sm' }));
  }
  if (sprint.note) children.push(Text({ as: 'p', text: sprint.note, size: 'sm' }));

  return el('div', { class: 'sprints-header' }, children);
}

// ---------------------------------------------------------------------------
// The burndown block.
// ---------------------------------------------------------------------------

function chartBlock(
  doc: Document,
  sprint: Sprint,
  members: readonly TimelineFileItem[],
  figures: Figures,
  report: SprintReport | null,
): HTMLElement {
  const window = sprintWindow(sprint, raster);
  const days = window ? sprintDays(window.start, window.end) : [];
  if (!days.length) {
    return Callout({
      tone: 'info',
      role: 'note',
      text: window
        ? `Der Zeitraum dieses Sprints ist länger als ${MAX_SPRINT_DAYS} Tage. Dafür wird keine Tagesachse gezeichnet: ein Sprint dauert einen Monat oder weniger.`
        : 'Ohne Anfang und Ende gibt es keine Tagesachse, deshalb zeichnet dieser Sprint kein Burndown.',
    });
  }

  const isPast = sprint.state === 'closed' || sprint.state === 'cancelled';
  const plan = idealSeries(days, figures.scope ?? 0);
  const extras: (Element | null)[] = [];
  let actual: BurndownPoint[] = [];
  // What the second line IS, as its legend key. There used to be a caption under the
  // chart saying it in a sentence, which is documentation standing in an interface: the
  // legend already has to name both lines, so the one word belongs there and nowhere
  // else. Null when there is no second line to name.
  let actualKey: string | null = null;

  if (isPast && report) {
    // A closed sprint's curve is the record, never a recomputation: the item list
    // keeps moving afterwards, so recomputing rewrites history on every edit.
    const read = frozenSeries(days, report.series);
    actual = read.points;
    actualKey = sprint.closedOn ? `Eingefroren am ${germanDay(sprint.closedOn)}` : 'Eingefroren';
    if (read.outside.length) {
      extras.push(
        Callout({
          tone: 'warning',
          role: 'note',
          text:
            `Der eingefrorene Verlauf enthält Tage außerhalb des Sprintzeitraums: ${read.outside.join(', ')}.`,
        }),
      );
    }
    if (!read.points.length) {
      extras.push(
        Callout({
          tone: 'info',
          role: 'note',
          text: 'Zu diesem abgeschlossenen Sprint ist kein Verlauf gespeichert.',
        }),
      );
    }
  } else if (isPast) {
    // No key: there is no second line, and „there is none" is what an absent key says.
  } else {
    const built = reconstructSeries(days, burndownItems(members), today());
    actual = built.points;
    // Nothing is drawn before the first day, so there is nothing to name then either.
    actualKey = built.points.length ? 'Rekonstruiert' : null;
  }

  const unit = UNIT_LABELS[figures.unit];
  const ariaLabel =
    `Burndown ${sprint.name}: ${days.length} Tage, Umfang ${figure(figures.scope)} ${unit}, ` +
    `offen ${figure(figures.remaining)}.`;

  return el('figure', { class: 'sprints-chart' }, [
    chart(doc, { days, scope: figures.scope ?? 0, plan, actual, ariaLabel }),
    el('div', { class: 'sprints-legend' }, [
      legendKey('Plan', 'plan'),
      actualKey ? legendKey(actualKey, 'actual') : null,
    ]),
    ...extras,
  ]);
}

/** The items as the chart reads them. The rules are `sprints.ts`'s; the shape is the chart's. */
function burndownItems(members: readonly TimelineFileItem[]): BurndownItem[] {
  // The stored fields, not a resolved end: `itemEndDay` resolves `duration` through the
  // core's own arithmetic, and doing it here instead put every duration-only item on the
  // day it STARTED — which is how a burndown came to describe when work began.
  return members.map((item) => ({
    id: itemLabel(item),
    estimate: estimateOf(item),
    done: isDone(item),
    start: item.start ?? null,
    end: item.end ?? null,
    duration: item.duration,
    point: item.type === 'point',
  }));
}

// ---------------------------------------------------------------------------
// The item list.
// ---------------------------------------------------------------------------

/**
 * The warnings for one sprint's items, keyed by item, worded for a reader.
 *
 * `sprintWarnings` decides *what* a warning is and hands it over as data; the German
 * is this file's. That split is why `sprint_status` can word the same finding for an
 * agent without the two drifting apart.
 */
function itemWarnings(sprintId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (key: string, message: string) => {
    const list = out.get(key);
    if (list) list.push(message);
    else out.set(key, [message]);
  };
  for (const warning of warnings) {
    if (warning.kind === 'item-outside-sprint-window' && warning.sprintId === sprintId) {
      add(
        warningKey(warning.itemId, warning.content),
        `Termine außerhalb des Sprints (${germanDay(warning.window.start)} bis ${germanDay(warning.window.end)})`,
      );
    } else if (warning.kind === 'item-without-estimate' && warning.sprintId === sprintId) {
      add(warningKey(warning.itemId, warning.content), 'keine verwertbare Schätzung');
    }
  }
  return out;
}

/**
 * The two row-level faults that need a sentence rather than a name.
 *
 * Both are only reachable in data nobody wrote through this interface (a hand-edited
 * file, an import, a close that stopped halfway), and both make a row invisible: the
 * reader keeps the first of a duplicated id, so the second one's goal, window and
 * capacity are simply not there while its figures are counted off the first.
 */
function rowFaultText(
  warning: Extract<SprintWarning, { kind: 'duplicate-row-id' | 'several-reports-for-one-sprint' }>,
): string {
  if (warning.kind === 'duplicate-row-id') {
    return `Die Id „${warning.rowId}" kommt in „${warning.collection}" mehrfach vor; gelesen wird die erste Zeile.`;
  }
  return `Für einen Sprint liegen mehrere Berichte vor (${warning.rowIds.join(', ')}); gelesen wird der erste.`;
}

/**
 * „aus Sprint 2 übertragen", per item, out of the history rows.
 *
 * The `passes` collection was written by every close and read by nothing, which made
 * the per-item history a store nobody could see. This is its reader in the interface:
 * an item that an earlier sprint handed over says so on the sprint that holds it now.
 */
function carriedInLabels(sprintId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of carriedInto(sprints, passes, file?.items ?? [], sprintId)) {
    const from = sprints.find((s) => s.id === entry.fromSprintId);
    out.set(entry.itemId, `aus „${from?.name ?? entry.fromSprintId}" übertragen`);
  }
  return out;
}

function itemsBlock(sprint: Sprint, members: readonly TimelineFileItem[]): HTMLElement {
  if (!members.length) {
    return el(
      'div',
      { class: 'sprints-items' },
      Callout({ tone: 'info', role: 'note', text: 'Diesem Sprint ist kein Eintrag zugeordnet.' }),
    );
  }
  const perItem = itemWarnings(sprint.id);
  const carriedIn = carriedInLabels(sprint.id);
  const rows = members.map((item) => {
    const estimate = estimateOf(item);
    const status = statusOrDefault(item.status);
    const own = perItem.get(warningKey(item.id?.trim() || null, item.content ?? '')) ?? [];
    const carried = carriedIn.get(item.id?.trim() ?? '');
    return TableRow({
      children: [
        TableCell({ primary: true, children: itemLabel(item) }),
        TableCell({
          nowrap: true,
          className: 'sprints-estimate',
          children: estimate == null ? NO_FIGURE : numbers.format(estimate),
        }),
        TableCell({ nowrap: true, muted: true, children: [StatusDot({ status }), ' ', status] }),
        TableCell({
          children: own.length
            ? el('span', { class: 'sprints-item-warning' }, [own.join('; '), ...(carried ? [`, ${carried}`] : [])])
            : carried
              ? el('span', { class: 'sprints-item-carried' }, carried)
              : '',
        }),
      ],
    });
  });
  return el(
    'div',
    { class: 'sprints-items' },
    Table({
      children: [
        TableHead({ columns: ['Eintrag', `Schätzung (${UNIT_LABELS[capacityUnitOf(sprint, file)]})`, 'Status', 'Hinweis'] }),
        el('tbody', {}, rows),
      ],
    }),
  );
}

// ---------------------------------------------------------------------------
// Writing.
// ---------------------------------------------------------------------------

function data() {
  const store = host().data;
  // A declaration mistake worth failing loudly on: a write that silently does
  // nothing is the version of it that costs an afternoon.
  if (!store) throw new Error('sprints: the manifest is missing the "data:own" capability');
  return store;
}

/**
 * May this reader change anything? Both halves, and they answer different
 * questions: the capability says what the plugin is allowed to do, `canWrite` says
 * what the timeline accepts. A „Sprint anlegen" button without the second one is a
 * button that fails on click.
 */
function canEdit(): boolean {
  return writable && api?.data != null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Re-read this plugin's own rows after a write, then repaint.
 *
 * A re-list rather than a mirror of the written row into the snapshot: writes here
 * are rare (create, save, close) and a mirror is a second implementation of „what
 * does a stored row look like" — which is the copy that drifts. The rows go back
 * through `readSprints` and `readReports`, so a row that was just written and one
 * that arrived with the snapshot cannot be two different shapes.
 */
async function reload(): Promise<void> {
  const store = data();
  const [sprintRows, reportRows] = await Promise.all([
    store.list(SPRINT_COLLECTIONS.sprints),
    store.list(SPRINT_COLLECTIONS.reports),
  ]);
  // No timeline means the readers would find no plugin entry to read against, and
  // the rows would silently read as none — worse than showing the previous paint.
  if (!file) return repaint();
  const own = { ...(file.pluginData ?? {}) };
  own[sprintsManifest.id] = {
    ...(own[sprintsManifest.id] ?? {}),
    [SPRINT_COLLECTIONS.sprints]: sprintRows,
    [SPRINT_COLLECTIONS.reports]: reportRows,
  };
  adopt({ ...file, pluginData: own });
  repaint();
}

function uniqueId(prefix: string, taken: readonly string[]): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const candidate = `${prefix}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

async function createSprint(): Promise<void> {
  const id = uniqueId(
    'sprint',
    sprints.map((s) => s.id),
  );
  const name = `Sprint ${sprints.length + 1}`;
  try {
    // `planned`, with no window and no goal. Demanding either here would be a row
    // nobody creates before the planning meeting; the goal is warned about once the
    // sprint is active instead.
    const saved = await data().put(SPRINT_COLLECTIONS.sprints, { id, data: { name, state: 'planned' } });
    selectedId = saved.id;
    editing = true;
    notices = [];
    host().status(`Sprint „${name}" angelegt`);
    await reload();
  } catch (error) {
    fail(`Sprint anlegen fehlgeschlagen: ${message(error)}`);
  }
}

type SprintEdit = {
  name: string;
  goal: string;
  start: string;
  end: string;
  state: string;
  capacity: string;
  capacityUnit: string;
  note: string;
};

/** A refusal the reader caused: shown where they are looking, and nowhere else. */
function refuse(text: string): void {
  notices = [{ tone: 'warning', text }];
  repaint();
}

/**
 * A write that failed, or half-landed.
 *
 * Said twice on purpose: in the page, because that is where the reader is, and in
 * the app's status line, because a realtime update repaints this view and would
 * otherwise take the only record of a half-finished close off the screen. The status
 * line is what the product already has for „what just happened".
 */
function fail(text: string): void {
  notices = [{ tone: 'danger', text }];
  host().status(text);
  repaint();
}

/**
 * Save the edited fields. `null` clears a key, which is the host's rule for a patch:
 * an emptied input has to disappear rather than be stored as an empty string every
 * reader then special-cases.
 */
async function saveSprint(sprint: Sprint, edit: SprintEdit): Promise<void> {
  const name = edit.name.trim();
  if (!name) return refuse('Ein Sprint braucht einen Namen.');

  const state = (SPRINT_STATES as readonly string[]).includes(edit.state)
    ? (edit.state as SprintState)
    : sprint.state;

  // At most one active sprint per timeline: canon has a new sprint start
  // immediately after the previous one concludes. The host enforces no cross-row
  // rule, so the refusal is the plugin's own — and it names the other sprint,
  // because „nicht erlaubt" without it leaves the reader hunting.
  if (state === 'active' && sprint.state !== 'active') {
    const other = sprints.find((s) => s.id !== sprint.id && s.state === 'active');
    if (other) {
      return refuse(
        `„${other.name}" ist bereits aktiv. Eine Zeitleiste hat höchstens einen aktiven Sprint: ` +
          `erst „${other.name}" abschließen oder abbrechen.`,
      );
    }
  }

  const start = edit.start.trim();
  const end = edit.end.trim();
  if (start && end && start > end) return refuse('Der letzte Tag liegt vor dem ersten.');
  // A fixed window is what makes a sprint one, and it is the precondition for the
  // burndown's axis. Refused here rather than after the write, so „aktiv" and „ohne
  // Zeitraum" never coexist in stored data.
  if (state === 'active' && !(start && end)) {
    return refuse('Ein aktiver Sprint braucht einen ersten und einen letzten Tag.');
  }

  const capacityText = edit.capacity.trim();
  const capacity = parseEstimate(capacityText);
  if (capacityText && capacity == null) return refuse('Die Kapazität muss eine Zahl größer als 0 sein.');

  const patch: Record<string, unknown> = {
    name,
    state,
    goal: edit.goal.trim() || null,
    start: start || null,
    end: end || null,
    capacity: capacityText ? capacity : null,
    capacityUnit: (CAPACITY_UNITS as readonly string[]).includes(edit.capacityUnit) ? edit.capacityUnit : null,
    note: edit.note.trim() || null,
  };
  try {
    await data().patch(SPRINT_COLLECTIONS.sprints, sprint.id, patch, versions.get(sprint.id));
    editing = false;
    notices = [];
    host().status(`Sprint „${name}" gespeichert`);
    await reload();
  } catch (error) {
    fail(`Speichern fehlgeschlagen: ${message(error)}`);
  }
}

/**
 * Close a sprint: a `passes` row per assigned item, then the frozen `reports` row,
 * then the state.
 *
 * **A close is not atomic and this does not pretend otherwise** („What this model
 * cannot do", 1). The order is the one that leaves the least damage when it stops
 * halfway: the history first, the report second, the state last — so a sprint that
 * still says „aktiv" is a close that did not finish, rather than a closed sprint with
 * no record of what it delivered. Every step that landed is named in the notice, and
 * a retry is safe because `passes` is keyed on the item and the sprint and `reports`
 * on the sprint.
 */
async function closeSprint(sprint: Sprint): Promise<void> {
  const store = data();
  const members = itemsOfSprint(file?.items, sprint.id);
  const figures = liveFigures(sprint, members);
  const recordedOn = today();
  let written = 0;
  let done = 0;

  for (const item of members) {
    const itemId = item.id?.trim();
    // An item with no id cannot be recorded: `passes` is keyed on it, and a row
    // keyed on an empty string would collide with the next one.
    if (!itemId) continue;
    const estimate = estimateOf(item);
    try {
      await store.put(SPRINT_COLLECTIONS.passes, {
        id: `${sprint.id}:${itemId}`,
        data: {
          itemId,
          sprintId: sprint.id,
          // Two outcomes, not four: `removed` and `cancelled` are decisions a person
          // makes about one item, and `roll_over` is the verb that moves unfinished
          // work. A close reads status and records what it read.
          outcome: isDone(item) ? 'done' : 'carried',
          recordedOn,
          ...(estimate != null ? { estimateAtClose: estimate } : {}),
        },
      });
      written++;
      if (isDone(item)) done++;
    } catch (error) {
      fail(
        `Abschluss abgebrochen. ${written} von ${members.length} Einträgen stehen in der Historie, ` +
          `dann schlug „${itemLabel(item)}" fehl (${message(error)}). Kein Report geschrieben, ` +
          `Status unverändert „${STATE_LABELS[sprint.state]}". ` +
          'Ein erneuter Abschluss schreibt die vorhandenen Zeilen nicht doppelt.',
      );
      return;
    }
  }

  const window = sprintWindow(sprint, raster);
  const days = window ? sprintDays(window.start, window.end) : [];
  const unit = capacityUnitOf(sprint, file);
  const series = days.length
    ? reconstructSeries(days, burndownItems(members), recordedOn, unit).points
    : [];
  try {
    await store.put(SPRINT_COLLECTIONS.reports, {
      id: sprint.id,
      data: {
        sprintId: sprint.id,
        // The same number twice, and that is the truthful version of not knowing:
        // there is no item revision log („What this model cannot do", 4), so a close
        // cannot say what the scope was on day one. A guessed `scopeAtStart` would
        // freeze a figure nobody measured.
        scopeAtStart: figures.scope ?? 0,
        scopeAtClose: figures.scope ?? 0,
        completed: figures.completed ?? 0,
        carried: figures.remaining ?? 0,
        // Frozen with its unit, because the sprint's `capacityUnit` can be edited
        // afterwards: without this, changing it relabelled a curve that was counted in
        // something else, which is the opposite of „never recomputed".
        unit,
        series,
      },
    });
  } catch (error) {
    fail(
      `Abschluss abgebrochen. ${written} Historienzeilen sind geschrieben, der Report nicht ` +
        `(${message(error)}). Status unverändert „${STATE_LABELS[sprint.state]}". ` +
        'Ein erneuter Abschluss ist gefahrlos.',
    );
    return;
  }

  try {
    await store.patch(
      SPRINT_COLLECTIONS.sprints,
      sprint.id,
      { state: 'closed', closedOn: recordedOn },
      versions.get(sprint.id),
    );
  } catch (error) {
    fail(
      `Historie und Report sind geschrieben, der Status nicht (${message(error)}). ` +
        `Der Sprint steht weiter auf „${STATE_LABELS[sprint.state]}"; ein erneuter Abschluss setzt ihn.`,
    );
    return;
  }

  notices = [];
  host().status(
    `Sprint „${sprint.name}" abgeschlossen: ${done} von ${members.length} Einträgen fertig, ` +
      `${figure(figures.remaining)} ${UNIT_LABELS[readEstimateUnit(file)]} übernommen`,
  );
  await reload();
}

// ---------------------------------------------------------------------------
// The edit form.
//
// Inline rather than in the host's drawer, and the reason is what the surface is:
// this view IS the sprint's page, so its goal, its window and its capacity are that
// page's own content. The drawer is for a detail of something listed elsewhere — the
// pricing matrix opening a feature's Stammdaten — and putting the page's own fields
// in it would mean reading the goal in one place and editing it in another.
// ---------------------------------------------------------------------------

function editForm(sprint: Sprint): HTMLElement {
  const nameInput = TextInput({ value: sprint.name, block: true, attrs: { 'aria-label': 'Name' } });
  const goalInput = TextArea({ value: sprint.goal ?? '', rows: 2, block: true, attrs: { 'aria-label': 'Sprint-Ziel' } });
  const startInput = TextInput({ type: 'date', value: sprint.start ?? '', attrs: { 'aria-label': 'Erster Tag' } });
  const endInput = TextInput({ type: 'date', value: sprint.end ?? '', attrs: { 'aria-label': 'Letzter Tag' } });
  const stateSelect = Select({
    options: SPRINT_STATES.map((key) => ({ value: key, label: STATE_LABELS[key], selected: key === sprint.state })),
    attrs: { 'aria-label': 'Status' },
  });
  const capacityInput = TextInput({
    type: 'number',
    value: sprint.capacity == null ? '' : String(sprint.capacity),
    attrs: { 'aria-label': 'Kapazität', min: '0', step: 'any' },
  });
  const capacityUnitSelect = Select({
    options: [
      {
        value: '',
        label: `wie konfiguriert (${UNIT_LABELS[readEstimateUnit(file)]})`,
        selected: !sprint.capacityUnit,
      },
      ...CAPACITY_UNITS.map((key) => ({
        value: key,
        label: UNIT_LABELS[key],
        selected: key === sprint.capacityUnit,
      })),
    ],
    attrs: { 'aria-label': 'Einheit der Kapazität' },
  });
  const noteInput = TextArea({ value: sprint.note ?? '', rows: 2, block: true, attrs: { 'aria-label': 'Notiz' } });

  // The one use velocity has in this plugin: a suggestion for a sprint that carries
  // no capacity, which is what Linear's capacity dial does. It is a hint on an input
  // and never a figure on the page — see the note at the top of this file.
  const suggestion = sprint.capacity == null ? suggestedCapacity(sprints, reports) : null;
  const capacityHint =
    suggestion != null
      ? `Vorschlag aus den letzten abgeschlossenen Sprints: ${numbers.format(round2(suggestion))}.`
      : undefined;

  const submit = () =>
    void saveSprint(sprint, {
      name: nameInput.value,
      goal: goalInput.value,
      start: startInput.value,
      end: endInput.value,
      state: stateSelect.value,
      capacity: capacityInput.value,
      capacityUnit: capacityUnitSelect.value,
      note: noteInput.value,
    });

  return el(
    'div',
    { class: 'sprints-form' },
    FormGrid({
      children: [
        Field({ label: 'Name', control: nameInput, full: true }),
        Field({
          label: 'Sprint-Ziel',
          control: goalInput,
          full: true,
        }),
        Field({ label: 'Erster Tag', control: startInput }),
        Field({ label: 'Letzter Tag', control: endInput }),
        Field({ label: 'Status', control: stateSelect }),
        Field({ label: 'Kapazität', hint: capacityHint, control: capacityInput }),
        Field({ label: 'Einheit', control: capacityUnitSelect }),
        Field({
          label: 'Notiz',
          control: noteInput,
          full: true,
        }),
        FormActions({
          children: [
            Button({ label: 'Speichern', variant: 'primary', on: { click: submit } }),
            Button({
              label: 'Abbrechen',
              variant: 'outline',
              on: {
                click: () => {
                  editing = false;
                  notices = [];
                  repaint();
                },
              },
            }),
          ],
        }),
      ],
    }),
  );
}

// ---------------------------------------------------------------------------
// Painting.
// ---------------------------------------------------------------------------

function switcherBar(selected: Sprint | null): HTMLElement {
  const select = Select({
    className: 'sprints-switch',
    block: false,
    options: sprints.map((s) => ({
      value: s.id,
      label: `${s.name} (${STATE_LABELS[s.state]})`,
      selected: s.id === selected?.id,
    })),
    attrs: { 'aria-label': 'Sprint' },
    on: {
      change: (event) => {
        selectedId = (event.currentTarget as HTMLSelectElement).value || null;
        if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId);
        editing = false;
        notices = [];
        repaint();
      },
    },
  });

  const actions: (Element | null)[] = [];
  if (canEdit() && selected) {
    actions.push(
      Button({
        label: editing ? 'Bearbeiten beenden' : 'Sprint bearbeiten',
        variant: 'outline',
        on: {
          click: () => {
            editing = !editing;
            repaint();
          },
        },
      }),
    );
    // Only an active sprint can be closed. A planned one has nothing to record, and
    // an already closed one would be frozen a second time over a moved item list.
    if (selected.state === 'active') {
      actions.push(
        Button({
          label: 'Sprint abschließen',
          variant: 'outline',
          on: { click: () => void closeSprint(selected) },
        }),
      );
    }
  }
  if (canEdit()) {
    actions.push(Button({ label: 'Sprint anlegen', variant: 'primary', on: { click: () => void createSprint() } }));
  }

  return el('div', { class: 'sprints-bar' }, [
    sprints.length ? ToolbarControl({ label: 'Sprint', children: select }) : null,
    el('div', { class: 'sprints-bar-actions' }, actions),
  ]);
}

function emptyState(): HTMLElement {
  return el('div', { class: 'sprints-notices' }, [
    Callout({ tone: 'info', role: 'note', text: 'In dieser Zeitleiste gibt es noch keinen Sprint.' }),
    Text({
      as: 'p',
      size: 'sm',
      tone: 'muted',
      text: canEdit()
        ? 'Noch kein Sprint angelegt.'
        : 'Noch kein Sprint angelegt. Diese Zeitleiste nimmt aus der Oberfläche keine Änderungen an.',
    }),
  ]);
}

/** Repaint into the section of the last render. No-op before the first one. */
function repaint(): void {
  if (section) paint(section);
}

function paint(into: HTMLElement): void {
  const doc = into.ownerDocument;
  section = into;

  // The selection is per reader rather than per timeline, like the pricing view's
  // version pin: a stored id this timeline does not have falls back to the active
  // sprint, so switching timelines lands on something rather than on blank.
  if (selectedId && !sprints.some((s) => s.id === selectedId)) selectedId = null;
  if (!selectedId) {
    const stored = localStorage.getItem(SELECTED_KEY);
    if (stored && sprints.some((s) => s.id === stored)) selectedId = stored;
  }
  const selected =
    sprints.find((s) => s.id === selectedId) ?? sprints.find((s) => s.state === 'active') ?? sprints[0] ?? null;
  selectedId = selected?.id ?? null;

  const children: (Element | null)[] = [switcherBar(selected)];

  const pageNotices: Element[] = notices.map((notice) =>
    Callout({ tone: notice.tone, role: 'alert', text: notice.text }),
  );
  // A second active sprint is a sprint-level fault rather than a property of the one
  // being read, so it stays on the page whichever sprint is selected.
  const several = warnings.find(
    (w): w is Extract<SprintWarning, { kind: 'several-active-sprints' }> => w.kind === 'several-active-sprints',
  );
  if (several) {
    const names = several.sprintIds.map((id) => sprints.find((s) => s.id === id)?.name ?? id);
    pageNotices.push(
      Callout({
        tone: 'warning',
        role: 'note',
        text:
          `Mehrere Sprints stehen auf „aktiv": ${names.join(', ')}.`,
      }),
    );
  }
  // The four warnings that are faults in the ROWS rather than in one sprint's work.
  // Each was reachable and unsayable before: a hand-edited file, an import or a close
  // that stopped halfway produces them, and the interface stayed quiet while the numbers
  // beside it were computed off that data.
  for (const warning of warnings) {
    if (warning.kind === 'overlapping-sprint-windows') {
      const [a, b] = warning.sprintIds.map((id) => sprints.find((s) => s.id === id)?.name ?? id);
      pageNotices.push(
        Callout({
          tone: 'warning',
          role: 'note',
          text:
            `Die Fenster von „${a}" und „${b}" überlappen sich ` +
            `(${germanDay(warning.overlap.start)} bis ${germanDay(warning.overlap.end)}).`,
        }),
      );
    } else if (warning.kind === 'closed-before-start') {
      const name = sprints.find((s) => s.id === warning.sprintId)?.name ?? warning.sprintId;
      pageNotices.push(
        Callout({
          tone: 'warning',
          role: 'note',
          text:
            `„${name}" ist am ${germanDay(warning.closedOn)} abgeschlossen worden, ` +
            `also vor seinem eigenen Beginn am ${germanDay(warning.start)}.`,
        }),
      );
    } else if (warning.kind === 'pass-without-sprint') {
      pageNotices.push(
        Callout({
          tone: 'warning',
          role: 'note',
          text:
            `Eine Historienzeile verweist auf den Sprint „${warning.sprintId}", den es nicht gibt ` +
            `(Eintrag „${warning.itemId}").`,
        }),
      );
    } else if (warning.kind === 'duplicate-row-id' || warning.kind === 'several-reports-for-one-sprint') {
      pageNotices.push(Callout({ tone: 'warning', role: 'note', text: rowFaultText(warning) }));
    }
  }
  if (pageNotices.length) children.push(el('div', { class: 'sprints-notices' }, pageNotices));

  if (!selected) {
    children.push(emptyState());
  } else {
    const members = itemsOfSprint(file?.items, selected.id);
    const report = reportOfSprint(reports, selected.id);
    const figures = figuresFor(selected, members, report);
    children.push(headerBlock(selected));
    if (editing && canEdit()) children.push(editForm(selected));
    children.push(numbersBlock(selected, figures));
    const unsized = warnings
      .filter(
        (w): w is Extract<SprintWarning, { kind: 'item-without-estimate' }> =>
          w.kind === 'item-without-estimate' && w.sprintId === selected.id,
      )
      .map((w) => w.content || w.itemId || '(ohne Titel)');
    if (unsized.length) {
      children.push(
        Callout({
          tone: 'warning',
          role: 'note',
          text:
            `Ohne verwertbare Schätzung, daher in keiner Summe: ${unsized.join(', ')}.`,
        }),
      );
    }
    children.push(chartBlock(doc, selected, members, figures, report));
    children.push(itemsBlock(selected, members));
  }

  into.replaceChildren(el('div', { class: 'sprints-inner' }, children));
}

/** Read everything this pass draws from, through `sprints.ts` and nothing else. */
function adopt(snapshot: TimelineSnapshot | null): void {
  file = snapshot;
  sprints = readSprints(snapshot);
  reports = readReports(snapshot);
  passes = readPasses(snapshot);
  warnings = sprintWarnings(snapshot);
  raster = rasterOf(snapshot);
  versions = versionsFrom(rawRows(snapshot, SPRINT_COLLECTIONS.sprints));
}

/**
 * Render this plugin's view into the section the host created for it.
 *
 * Async because the snapshot is: the timeline and the writability are awaited once
 * and read synchronously from the module state above. The host renders into a
 * detached element and swaps it in when this settles, so two repaints cannot
 * interleave.
 */
export async function renderView(container: HTMLElement, viewId: string, hostApi: HostApi): Promise<void> {
  if (viewId !== VIEW_ID) return;
  api = hostApi;
  // A render pass from the HOST is a new context — a view switch, another timeline,
  // a realtime update — so a notice about the last write no longer describes what is
  // on screen. `fail` puts the same sentence in the status line, which is where it
  // survives. This plugin's own repaints do not come through here.
  notices = [];
  const [snapshot, writableNow] = await Promise.all([hostApi.timeline(), hostApi.canWrite()]);
  writable = writableNow;
  adopt(snapshot);
  // The host gives every plugin view the same neutral box; how this one fills it is
  // this plugin's stylesheet's business, so it claims its class on the container.
  container.classList.add('sprints-view');
  paint(container);
}
