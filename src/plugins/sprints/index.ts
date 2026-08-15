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
} from '../../pluginHost/viewApi';
import type { TimelineFileItem } from '../../types';
import { MIN_CAPACITY, SPRINT_COLLECTIONS, sprintsManifest } from './manifest';
import { dayOf, type SprintRaster } from './raster';
import {
  CAPACITY_UNITS,
  type CapacityUnit,
  capacityUnitOf,
  carriedInto,
  type CloseObjection,
  closeIncomplete,
  closeObjection,
  estimateOf,
  figuresSource,
  isDone,
  itemsOfSprint,
  nextSprint,
  rasterOf,
  readEstimateUnit,
  readPasses,
  readReports,
  readSprints,
  recordableItems,
  reportOfSprint,
  reportUnitOf,
  type Sprint,
  SPRINT_STATES,
  type SprintEdit,
  type SprintEditRefusal,
  sprintEditPatch,
  type SprintPass,
  type SprintReport,
  type SprintState,
  type SprintWarning,
  sprintWarnings,
  sprintWindow,
  suggestedCapacity,
  timelineScope,
} from './sprints';
import {
  MAX_SPRINT_DAYS,
  axisMax,
  type ChartGeometry,
  chartGeometry,
  frozenSeries,
  idealSeries,
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
} from './burndown';

/** The view id the manifest declares. Anything else is not this plugin's. */
const VIEW_ID = 'board';

/**
 * Which sprint the reader was last looking at, **per timeline**: one key holding
 * `{ [scope]: sprintId }`, the shape `timelines.viewPrefs` uses for the same reason.
 *
 * It used to hold a bare id for the whole instance, and sprint ids are minted per
 * timeline (`sprint-1…N`), so a selection made in one timeline resolved in the next one.
 * A legacy bare string therefore reads as „nothing stored" rather than being migrated:
 * that value IS the cross-timeline resolution being fixed, and what it costs to drop is
 * one click.
 */
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
/** The geometry the last paint drew the chart with. The resize handler compares against it. */
let geometry: ChartGeometry = chartGeometry(NaN);
/**
 * The sprint a close is running for, or null.
 *
 * A close is six or seven writes with no lock across them, and the button was live
 * throughout: a second click wrote everything a second time (idempotent) and then 409ed on
 * the state patch, leaving the page showing the badge „abgeschlossen" beside a red alert
 * claiming the sprint was still „aktiv".
 */
let closing: string | null = null;
/**
 * What the page says about the last write.
 *
 * `sticky` is the reason this is not simply cleared on every render: a notice about a
 * close that stopped halfway has to survive the next repaint, because that repaint arrives
 * from anybody's change on a DB timeline and the status line is one slot — one ordinary
 * save later, the partial close was recorded nowhere while its `passes` rows sat on the
 * server. It names the sprint, so `closeIncomplete` can say when the situation is over.
 */
type Notice = {
  tone: 'danger' | 'warning' | 'info';
  text: string;
  /** Keep this notice while an unfinished close of this sprint is still unfinished. */
  sticky?: string;
};
let notices: Notice[] = [];

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
  /** Null when nothing says what the scope was: the axis then has no top and no plan line. */
  scope: number | null;
  plan: BurndownPoint[];
  actual: BurndownPoint[];
  ariaLabel: string;
};

/**
 * The geometry this paint draws with: the canvas, the plot box and the label count, all
 * out of `chartGeometry`.
 *
 * Measured against the **viewport** rather than the container, because the container is
 * detached while this renders: the host hands the plugin a staging element and swaps it in
 * when the render settles (src/pluginHost/renderView.ts), so its `clientWidth` is 0 here.
 * A resize repaints (see `renderView`), so the answer does not outlive the width it was
 * computed for.
 */
function geometryFor(doc: Document): ChartGeometry {
  return chartGeometry(doc.defaultView?.innerWidth ?? NaN);
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
  // One geometry for the whole chart: the box the gridlines are drawn in, the box the
  // points are placed in and the box the labels are counted for have to be the same one.
  const { width: viewW, height: viewH, box: BOX, labels } = geometry;
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

  const ticks = tickIndices(days.length, labels);
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
      viewBox: `0 0 ${viewW} ${viewH}`,
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

/** No figures at all: a past sprint whose report is missing has none, and a recomputation
 * there would be the freeze rule silently not holding. */
const NO_FIGURES = (unit: CapacityUnit): Figures => ({
  scope: null,
  completed: null,
  remaining: null,
  unit,
  frozen: true,
});

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
  switch (figuresSource(sprint, report)) {
    case 'frozen':
      return {
        scope: report?.scopeAtClose ?? null,
        completed: report?.completed ?? null,
        remaining: report?.carried ?? null,
        // The unit the figures were counted in, from the report itself where it has one.
        // The sprint's own `capacityUnit` may have been edited since.
        unit: reportUnitOf(report, sprint, file),
        frozen: true,
      };
    case 'report-missing':
      // A fault, and it is stated where the other faults are rather than as a caption
      // under the boxes — see `paint`.
      return NO_FIGURES(capacityUnitOf(sprint, file));
    default:
      return liveFigures(sprint, members);
  }
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
  // Null scope draws no plan line, and that is the point: a past sprint with no report
  // knows no scope, and a plan line at zero would be a figure invented to fill the plot.
  const plan = idealSeries(days, figures.scope);
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
    chart(doc, { days, scope: figures.scope, plan, actual, ariaLabel }),
    el('div', { class: 'sprints-legend' }, [
      // No key for a line that is not drawn: a legend naming an absent plan is the same
      // mistake as a number box holding a dash.
      plan.length ? legendKey('Plan', 'plan') : null,
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

function itemsBlock(sprint: Sprint, members: readonly TimelineFileItem[], figures: Figures): HTMLElement {
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
  return el('div', { class: 'sprints-items' }, [
    // One word, and only beside frozen figures: the numbers and the curve are the record
    // of the close, while this table is the item list as it stands now — after a close,
    // moving two items to Done with new estimates changes every cell here and nothing
    // there. A sentence explaining the difference is what the deletion pass removed.
    figures.frozen ? el('div', {}, Badge({ label: 'aktuell', tone: 'neutral' })) : null,
    Table({
      children: [
        TableHead({ columns: ['Eintrag', `Schätzung (${UNIT_LABELS[capacityUnitOf(sprint, file)]})`, 'Status', 'Hinweis'] }),
        el('tbody', {}, rows),
      ],
    }),
  ]);
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
/** This plugin's rows spliced into the snapshot, so one reader sees one shape. */
function withRows(rows: Record<string, PluginRow[]>): TimelineSnapshot | null {
  if (!file) return null;
  const own = { ...(file.pluginData ?? {}) };
  own[sprintsManifest.id] = { ...(own[sprintsManifest.id] ?? {}), ...rows };
  return { ...file, pluginData: own };
}

async function reload(): Promise<void> {
  const store = data();
  const [sprintRows, reportRows, passRows] = await Promise.all([
    store.list(SPRINT_COLLECTIONS.sprints),
    store.list(SPRINT_COLLECTIONS.reports),
    // The history too, and not only for „aus Sprint 2 übertragen": whether a close is
    // still unfinished is read off these rows, so a reload that left them behind would
    // keep answering with the state from before the write.
    store.list(SPRINT_COLLECTIONS.passes),
  ]);
  const next = withRows({
    [SPRINT_COLLECTIONS.sprints]: sprintRows,
    [SPRINT_COLLECTIONS.reports]: reportRows,
    [SPRINT_COLLECTIONS.passes]: passRows,
  });
  // No timeline means the readers would find no plugin entry to read against, and
  // the rows would silently read as none — worse than showing the previous paint.
  if (!next) return repaint();
  adopt(next);
  repaint();
}

/**
 * The sprint rows as they stand on the server right now, with their lock counters.
 *
 * Through `readSprints` rather than by reading the row's `data` here, for the reason
 * `reload` re-lists instead of mirroring: a row that was just fetched and one that arrived
 * with the snapshot must not be two different shapes.
 */
async function currentSprints(): Promise<{ sprints: Sprint[]; versions: Map<string, number> } | null> {
  const rows = await data().list(SPRINT_COLLECTIONS.sprints);
  const snapshot = withRows({ [SPRINT_COLLECTIONS.sprints]: rows });
  if (!snapshot) return null;
  return { sprints: readSprints(snapshot), versions: versionsFrom(rows) };
}

async function createSprint(): Promise<void> {
  // The id and the name from one counter: two counters wrote `id: sprint-2` named
  // „Sprint 3" on a timeline holding `sprint-1` and `sprint-5`.
  const { id, name } = nextSprint(sprints.map((s) => s.id));
  try {
    // `put` without a version is a blind upsert, so the id is checked against the rows as
    // they are NOW rather than against the ones this page loaded with: two clicks, or two
    // tabs, otherwise overwrote each other's new sprint with no 409 and nothing said.
    const current = await currentSprints();
    if (current?.sprints.some((s) => s.id === id)) {
      return refuse(`„${id}" ist inzwischen angelegt. Noch einmal „Sprint anlegen" wählen.`);
    }
    // `planned`, with no window and no goal. Demanding either here would be a row
    // nobody creates before the planning meeting; the goal is warned about once the
    // sprint is active instead.
    const saved = await data().put(SPRINT_COLLECTIONS.sprints, { id, data: { name, state: 'planned' } });
    selectedId = saved.id;
    remember(saved.id);
    editing = true;
    notices = [];
    host().status(`Sprint „${name}" angelegt`);
    await reload();
  } catch (error) {
    fail(`Sprint anlegen fehlgeschlagen: ${message(error)}`);
  }
}

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
 *
 * `sticky` names the sprint whose unfinished close the sentence describes: such a notice
 * outlives the next host render and goes when the situation does, because the status line
 * is one slot and one ordinary save later it was the only record left.
 */
function fail(text: string, sticky?: string): void {
  notices = [{ tone: 'danger', text, ...(sticky ? { sticky } : {}) }];
  host().status(text);
  repaint();
}

/** The German for a refused edit. The rule is `sprintEditPatch`'s; the sentence is this file's. */
function editRefusalText(refusal: SprintEditRefusal): string {
  switch (refusal.kind) {
    case 'name-missing':
      return 'Ein Sprint braucht einen Namen.';
    case 'unknown-state': {
      const known = SPRINT_STATES.map((key) => STATE_LABELS[key]).join(', ');
      return `„${refusal.value}" ist kein Status. Möglich sind: ${known}.`;
    }
    case 'second-active-sprint': {
      const other = sprints.find((s) => s.id === refusal.sprintId);
      const name = other?.name ?? refusal.sprintId;
      return (
        `„${name}" ist bereits aktiv. Eine Zeitleiste hat höchstens einen aktiven Sprint: ` +
        `erst „${name}" abschließen oder abbrechen.`
      );
    }
    case 'end-before-start':
      return 'Der letzte Tag liegt vor dem ersten.';
    case 'active-without-window':
      return 'Ein aktiver Sprint braucht einen ersten und einen letzten Tag.';
    case 'capacity-not-a-decimal':
      // The FORMAT, not the size: „1e3" is refused while 1000 is a perfectly good
      // capacity, and „muss eine Zahl größer als 0 sein" said the opposite.
      return `„${refusal.value}" ist keine Dezimalzahl, zum Beispiel 20 oder 20.5.`;
    case 'capacity-below-minimum':
      return `Die Kapazität muss mindestens ${numbers.format(MIN_CAPACITY)} betragen.`;
  }
}

/**
 * Save the edited fields.
 *
 * Every rule the form applies is `sprintEditPatch`'s, so the interface cannot accept a
 * value the schema and the row reader refuse: it did, and `0.005` came back from the
 * server as `400 row.capacity: below 0.01` — an English field path in a German interface.
 * What stays here is the German.
 */
async function saveSprint(sprint: Sprint, edit: SprintEdit): Promise<void> {
  const result = sprintEditPatch(sprint, sprints, edit);
  if (result.refusal) return refuse(editRefusalText(result.refusal));
  try {
    await data().patch(SPRINT_COLLECTIONS.sprints, sprint.id, result.patch, versions.get(sprint.id));
    editing = false;
    notices = [];
    host().status(`Sprint „${result.patch.name as string}" gespeichert`);
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
  // One close at a time. Without this the button stayed live through six or seven writes:
  // a second click wrote them all again (idempotent, so no damage) and then 409ed on the
  // state patch, which left the page carrying the badge „abgeschlossen" and a red alert
  // saying the sprint was still „aktiv".
  if (closing) return refuse('Ein Abschluss läuft noch.');
  closing = sprint.id;
  repaint();
  try {
    await runClose(sprint);
  } finally {
    closing = null;
    repaint();
  }
}

async function runClose(sprint: Sprint): Promise<void> {
  const store = data();
  const members = itemsOfSprint(file?.items, sprint.id);
  // An item with no id cannot be recorded: `passes` is keyed on it, and a row keyed on an
  // empty string would collide with the next one. Counted apart from the recordable ones,
  // because `members.length` as the denominator of every sentence was the only hint the
  // reader got that something had been skipped.
  const { recordable, skipped } = recordableItems(members);
  const figures = liveFigures(sprint, members);
  const recordedOn = today();
  const skippedNote = skipped.length
    ? ` ${skipped.length} ${skipped.length === 1 ? 'Eintrag hat' : 'Einträge haben'} keine Id und stehen in keiner Historienzeile: ` +
      `${skipped.map(itemLabel).join(', ')}.`
    : '';
  let written = 0;
  let done = 0;

  for (const item of recordable) {
    const itemId = item.id!.trim();
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
        `Abschluss abgebrochen. ${written} von ${recordable.length} Einträgen stehen in der Historie, ` +
          `dann schlug „${itemLabel(item)}" fehl (${message(error)}). Kein Report geschrieben, ` +
          'der Status ist nicht gesetzt. Ein erneuter Abschluss schreibt die vorhandenen Zeilen nicht doppelt.',
        sprint.id,
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
        `(${message(error)}). Der Status ist nicht gesetzt; ein erneuter Abschluss ist gefahrlos.`,
      sprint.id,
    );
    return;
  }

  // The row's version, read again HERE and not at page load.
  //
  // **Why a multi-row action needs this.** On a local file source the version is the
  // file's mtime and the lock covers the whole document, so the six writes above moved
  // it: the patch sent the counter this page loaded with and answered 409 every single
  // time, and the „try again" it advised failed identically because nothing reloaded in
  // between. On a Postgres source the same sequence succeeded, because there the counter
  // belongs to the row. Any plugin action that writes more than one row hits this, which
  // is why it is spelled out rather than fixed quietly.
  //
  // Re-reading must not become a way around the lock, though — the lock is there to catch
  // SOMEBODY ELSE's write. So the fresh row has to prove it is still the one the reader
  // decided to close, and `closeObjection` is that test.
  const current = await currentSprints();
  const fresh = current?.sprints.find((s) => s.id === sprint.id) ?? null;
  const objection = closeObjection(sprint, fresh);
  if (objection) {
    fail(
      `Historie und Report sind geschrieben, der Status nicht: ${objectionText(objection)} ` +
        'Der Abschluss ist damit nicht fertig.',
      sprint.id,
    );
    return;
  }
  try {
    await store.patch(
      SPRINT_COLLECTIONS.sprints,
      sprint.id,
      { state: 'closed', closedOn: recordedOn },
      current?.versions.get(sprint.id),
    );
  } catch (error) {
    // What the row says now, read rather than remembered: interpolating the state from the
    // object captured at click time is how the page came to claim „aktiv" under a badge
    // reading „abgeschlossen".
    const after = (await currentSprints().catch(() => null))?.sprints.find((s) => s.id === sprint.id) ?? null;
    fail(
      `Historie und Report sind geschrieben, der Status nicht (${message(error)}). ` +
        (after
          ? `Der Sprint steht auf „${STATE_LABELS[after.state]}"; ein erneuter Abschluss setzt ihn.`
          : 'Der Sprint ist nicht mehr zu lesen.'),
      sprint.id,
    );
    return;
  }

  notices = [];
  host().status(
    `Sprint „${sprint.name}" abgeschlossen: ${done} von ${recordable.length} Einträgen fertig, ` +
      `${figure(figures.remaining)} ${UNIT_LABELS[unit]} übernommen.${skippedNote}`,
  );
  await reload();
}

/** Why the close stopped before the state patch. The test is `closeObjection`'s. */
function objectionText(objection: CloseObjection): string {
  switch (objection.kind) {
    case 'sprint-gone':
      return 'Die Zeile ist inzwischen gelöscht.';
    case 'state-changed':
      return `Der Sprint steht inzwischen auf „${STATE_LABELS[objection.state]}".`;
    case 'window-changed':
      return 'Der Zeitraum ist inzwischen geändert worden.';
    case 'capacity-changed':
      return 'Die Kapazität ist inzwischen geändert worden.';
  }
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
  // A text input rather than a number one, and `inputmode` for the phone keypad.
  // `type: 'number'` hands `.value` back as `""` for anything the browser cannot parse, so
  // „0x10" arrived here as an empty field and was saved as `capacity: null` with nothing
  // said. Its `min` was inert as well — the button calls `submit()` directly, so no
  // constraint validation ever ran — and it named 0, which is not the bound: `MIN_CAPACITY`
  // is, and `sprintEditPatch` enforces it.
  const capacityInput = TextInput({
    value: sprint.capacity == null ? '' : String(sprint.capacity),
    attrs: { 'aria-label': 'Kapazität', inputmode: 'decimal' },
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
        if (selectedId) remember(selectedId);
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
      const running = closing === selected.id;
      actions.push(
        Button({
          // Disabled while it runs, and the label says which state it is in: the guard in
          // `closeSprint` refuses the second call, and a button that looks clickable and
          // silently does nothing is the half of that fix a reader can see.
          label: running ? 'Wird abgeschlossen …' : 'Sprint abschließen',
          variant: 'outline',
          disabled: running,
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

/**
 * The stored selection of THIS timeline, or null.
 *
 * A malformed store, a legacy bare id and a full `localStorage` all read as „nothing
 * stored": a saved sprint choice is worth one click, and none of the three is worth
 * letting an exception through a paint.
 */
function remembered(): string | null {
  const scope = timelineScope(file);
  if (!scope) return null;
  try {
    const raw = JSON.parse(localStorage.getItem(SELECTED_KEY) ?? 'null');
    const found = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)[scope] : null;
    return typeof found === 'string' && found ? found : null;
  } catch {
    return null;
  }
}

function remember(sprintId: string): void {
  const scope = timelineScope(file);
  // Nothing identifies this timeline, so there is no bucket to write into. Falling back to
  // an instance-wide one is the bug, not the fallback.
  if (!scope) return;
  try {
    const raw = JSON.parse(localStorage.getItem(SELECTED_KEY) ?? 'null');
    const store = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    localStorage.setItem(SELECTED_KEY, JSON.stringify({ ...store, [scope]: sprintId }));
  } catch {
    // A full or disabled localStorage must not break switching sprints, the rule
    // `writeViewPrefsStore` (src/state.ts) already follows for the same store.
  }
}

function paint(into: HTMLElement): void {
  const doc = into.ownerDocument;
  section = into;
  geometry = geometryFor(doc);

  // The selection is per reader and per timeline (see `SELECTED_KEY`): a stored id this
  // timeline does not have falls back to the active sprint, so switching timelines lands
  // on something rather than on blank.
  if (selectedId && !sprints.some((s) => s.id === selectedId)) selectedId = null;
  if (!selectedId) {
    const stored = remembered();
    if (stored && sprints.some((s) => s.id === stored)) selectedId = stored;
  }
  const selected =
    sprints.find((s) => s.id === selectedId) ?? sprints.find((s) => s.state === 'active') ?? sprints[0] ?? null;
  selectedId = selected?.id ?? null;

  const children: (Element | null)[] = [switcherBar(selected)];
  // Read before the notices are built, because one of them is about these figures: a past
  // sprint with no report has none, and that belongs with the other faults rather than
  // under the boxes.
  const members = selected ? itemsOfSprint(file?.items, selected.id) : [];
  const report = selected ? reportOfSprint(reports, selected.id) : null;
  const figures = selected ? figuresFor(selected, members, report) : null;

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
    } else if (warning.kind === 'close-incomplete') {
      // Derived from the rows, so a reload no longer hides it. The page used to hold a
      // notice for as long as the situation lasted, which meant it survived a repaint and
      // not a refresh: the history rows sat on the server, the sprint said „aktiv", and
      // nobody arriving later could see that a close had stopped halfway.
      const name = sprints.find((s) => s.id === warning.sprintId)?.name ?? warning.sprintId;
      // Phrased so the count is not the subject of a verb. „1 Historienzeile sind
      // geschrieben" was the first attempt, and a sentence that has to decline both a
      // noun and its verb around a number gets one of the two wrong.
      const rows = `${warning.passes} ${warning.passes === 1 ? 'Historienzeile' : 'Historienzeilen'}`;
      const written = warning.report ? `${rows} und Bericht geschrieben` : `${rows} geschrieben, kein Bericht`;
      pageNotices.push(
        Callout({
          tone: 'warning',
          role: 'note',
          text: `Abschluss von „${name}" ist unfertig: ${written}, Status „${STATE_LABELS[warning.state]}".`,
        }),
      );
    } else if (warning.kind === 'sprint-window-past') {
      // The window ran out and the row did not move with it. Nothing in this product
      // closes a sprint by itself, so the page has to say it: it showed „aktiv", a flat
      // reconstruction and no word about the last day having passed six months ago, while
      // `sprint_status` said it precisely.
      const name = sprints.find((s) => s.id === warning.sprintId)?.name ?? warning.sprintId;
      pageNotices.push(
        Callout({
          tone: 'warning',
          role: 'note',
          text:
            `„${name}" steht auf „${STATE_LABELS[warning.state]}", das Fenster endete am ` +
            `${germanDay(warning.window.end)} (vor ${warning.days} ${warning.days === 1 ? 'Tag' : 'Tagen'}).`,
        }),
      );
    }
  }
  // „No sprint is active" is not a fault in the data — nothing fires at a sprint boundary,
  // so a plan whose sprints have not started is a normal plan — but the page falls back to
  // the first row, which is usually the oldest and closed. Saying nothing left the reader
  // looking at a closed sprint as though it were the current one, while `sprint_status`
  // reports the absence.
  if (sprints.length && !sprints.some((s) => s.state === 'active')) {
    pageNotices.push(Callout({ tone: 'info', role: 'note', text: 'Kein Sprint ist aktiv.' }));
  }
  // A past sprint with no frozen report, with the other faults: it used to fall through to
  // a live recomputation, so the boxes showed numbers beside an empty plot and read as
  // current — the model's freeze rule quietly not holding.
  if (selected && figuresSource(selected, report) === 'report-missing') {
    pageNotices.push(
      Callout({
        tone: 'warning',
        role: 'note',
        text: `Zu „${selected.name}" ist kein Bericht gespeichert, deshalb gibt es keine Zahlen dazu.`,
      }),
    );
  }
  if (pageNotices.length) children.push(el('div', { class: 'sprints-notices' }, pageNotices));

  if (!selected || !figures) {
    children.push(emptyState());
  } else {
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
    children.push(itemsBlock(selected, members, figures));
  }

  // The scroll position, carried across the rebuild.
  //
  // `.sprints-inner` IS the scroll container, so replacing it puts the reader back at the
  // top: measured 89.5 before an edit toggle and 0 after. On a DB timeline the host
  // repaints this view on every change from anybody, so „the page jumps while I read it"
  // was not even limited to one's own edits. Read before the swap, written after, because
  // scrollTop on a detached node is 0 and setting it needs the content to be laid out.
  const top = into.querySelector<HTMLElement>('.sprints-inner')?.scrollTop ?? 0;
  const inner = el('div', { class: 'sprints-inner' }, children);
  into.replaceChildren(inner);
  if (top) inner.scrollTop = top;
}

/** Read everything this pass draws from, through `sprints.ts` and nothing else. */
function adopt(snapshot: TimelineSnapshot | null): void {
  file = snapshot;
  sprints = readSprints(snapshot);
  reports = readReports(snapshot);
  passes = readPasses(snapshot);
  // The day is passed in rather than read inside the rule: `sprintWarnings` compares a
  // window against it and would otherwise be a domain function reading a clock.
  warnings = sprintWarnings(snapshot, today());
  raster = rasterOf(snapshot);
  versions = versionsFrom(rawRows(snapshot, SPRINT_COLLECTIONS.sprints));
}

/**
 * A repaint on resize, so the chart's two halves cannot disagree.
 *
 * The geometry — canvas, gutters, label count — is computed from the viewport width
 * (`chartGeometry`), and before this listener the count was decided once during a render
 * pass and never revised: resizing from 1600 to 380 kept seven labels and collided them.
 * Attached once, and only repaints when the geometry actually changed, so dragging a window
 * edge does not rebuild the page on every pixel (which would also fight the scroll
 * restoration in `paint`).
 */
let resizeBound = false;

function bindResize(doc: Document): void {
  const view = doc.defaultView;
  if (resizeBound || !view) return;
  resizeBound = true;
  view.addEventListener('resize', () => {
    if (!section) return;
    const next = chartGeometry(view.innerWidth);
    if (next.width === geometry.width && next.height === geometry.height && next.labels === geometry.labels) return;
    repaint();
  });
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
  // A render pass from the HOST is a new context: a view switch, another timeline, a
  // realtime update. So an open edit form is closed — it survived a timeline switch and
  // was found open and pre-filled on a sprint nobody asked to edit — and a notice about
  // the last write goes, because it no longer describes what is on screen.
  editing = false;
  const [snapshot, writableNow] = await Promise.all([hostApi.timeline(), hostApi.canWrite()]);
  writable = writableNow;
  adopt(snapshot);
  // Except a notice about a close that stopped halfway: that one describes the DATA, not
  // the last click, so it stays until the situation it names is resolved. The status line
  // is one slot, so one ordinary save later it was the only record of a sprint carrying
  // `passes` rows, no report and still „aktiv".
  notices = notices.filter((notice) => notice.sticky && closeIncomplete(sprints, passes, reports, notice.sticky));
  // The host gives every plugin view the same neutral box; how this one fills it is
  // this plugin's stylesheet's business, so it claims its class on the container.
  container.classList.add('sprints-view');
  bindResize(container.ownerDocument);
  paint(container);
}
