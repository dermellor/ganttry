// What this plugin declares about itself. The host reads it *before* running any
// plugin code, so everything the plugin needs has to be declared rather than
// requested at runtime.
//
// `register()` refuses an invalid manifest and throws while the module loads, so a
// mistake here does not produce a plugin that fails to appear: it takes the app
// down. `manifest.test.ts` is the cheap guard against that.

import type { PluginManifest } from '../../pluginHost/api';

/**
 * The collections this plugin owns, named once.
 *
 * Here rather than in `sprints.ts` because the manifest is what the host reads before
 * any plugin code runs, and a second copy of a collection id is the one that goes
 * stale: the id keys the rows in `plugin_data`, so a mismatch between the declaration
 * and the reader is a silently empty collection rather than an error.
 */
export const SPRINT_COLLECTIONS = {
  sprints: 'sprints',
  passes: 'passes',
  reports: 'reports',
} as const;

/**
 * A calendar day and nothing else.
 *
 * `format: 'date'` is not in the subset the host enforces (`SUPPORTED_KEYWORDS` in
 * src/pluginHost/dataSchema.ts), and a keyword nothing checks is worse than a blunt
 * one: the author reads it as a constraint. `pattern` is enforced, so a sprint window
 * cannot be stored as „Anfang März" and then silently cover nothing.
 */
const DAY_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/**
 * The smallest capacity a rule may divide by, in the schema and in the row reader.
 *
 * Exported because `sprints.ts` enforces the same bound when it reads a row: a
 * hand-edited file is checked against no schema, and `capacity: 0.005` was accepted
 * there and printed as „von 0.01 Punkten" — a capacity nobody wrote, rounded into
 * existence by the note. `exclusiveMinimum` is not in the subset the host enforces
 * (`SUPPORTED_KEYWORDS` in src/pluginHost/dataSchema.ts), and 0.01 is the smallest
 * value the verbs can tell from zero anyway: they compare sums at the two decimals
 * their notes print at.
 */
export const MIN_CAPACITY = 0.01;

export const sprintsManifest: PluginManifest = {
  id: 'dev.zeitlines.sprints',
  name: 'Sprints',
  version: '0.2.0',
  // `^1.5` was the floor for `sprintByDate` being a `derived` field: the value comes
  // from `derive(file)` and nothing is stored, and on an older host that field renders
  // as an editable control with nothing behind it.
  //
  // `^1.6` now, because the burndown resolves an item's real end through the core's own
  // `durationToMs` + `endFromDuration`, which 1.6 puts on the contract. Restating that
  // arithmetic here is what produced the bug the export exists for: every item in the
  // shipped example carries `duration` and no `end`, so the reconstruction burned each
  // one on the day it STARTED, and the curve described when work began. On a 1.5 host
  // the import does not resolve at all, so the range is the honest statement.
  apiVersion: '^1.6',

  // `items:read` for the sums, `items:write` because a verb moves items, `fields` for
  // the four fields, `tools` for the verbs, `data:own` for the three collections that
  // make a sprint an entity, `views` for the sprint's own page, `public:read` so a
  // committed example renders on a static deploy.
  capabilities: ['items:read', 'items:write', 'fields', 'tools', 'data:own', 'views', 'public:read'],

  catalogue: {
    summary:
      'Sprints as rows with a goal, a capacity and a frozen result: membership is assigned per item, and the date raster stays a suggestion beside it.',
    // A slug, not the prose „delivery planning": the validator demands
    // `^[a-z][a-z0-9-]*$` for a domain, and a space here would make `register()`
    // throw at module load, which takes the whole app down rather than hiding one
    // plugin.
    domain: 'delivery-planning',
    keywords: [
      'sprint',
      'sprint planning',
      'sprint goal',
      'story points',
      'velocity',
      'capacity',
      'forecast',
      'scrum',
      'self-hosted roadmap',
    ],
    example: 'src:example-sprint-planung',
  },

  // One view: a sprint's own page with its goal, its scope and its burndown. It became
  // possible only once a sprint was a row, which is why this plugin had none before:
  // a goal and a frozen result have nowhere to live on a label computed from a date.
  //
  // **No accessories, and each absent rather than declared false.** The page renders one
  // sprint instead of the item list, so the perspective (grouping) and the extent
  // (filter) have nothing to act on, and „+ Eintrag" would create an item where the
  // user cannot see it. Absent and `false` mean the same thing to `viewAccessories`;
  // declaring nothing says „this view is not about the item list" once, rather than
  // three times in the negative.
  views: [
    {
      id: 'board',
      label: 'Sprint',
      // A flag: the Sprint Goal is what the page is built around, and it is the one
      // thing about a sprint that no date can express.
      icon:
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />' +
        '<line x1="4" y1="22" x2="4" y2="15" />' +
        '</svg>',
    },
  ],

  // The three keys a person chooses, and therefore the three an uninstall has to
  // clean off items. `sprint` is here because the assignment IS stored: membership is
  // an act, so an uninstall that left it behind would leave every item carrying a row
  // id pointing at rows that were purged with the plugin.
  //
  // `sprintByDate` is deliberately absent, and that difference is the whole model: it
  // is computed on every build from the item's own start, so no item carries a value
  // under it and there is nothing to purge. Listing it would promise a cleanup that
  // has nothing to clean and would suggest the suggestion is stored, which is the exact
  // misunderstanding the derived seam exists to prevent.
  metadataKeys: ['sprint', 'storyPoints', 'estimateConfidence'],

  configSchema: {
    type: 'object',
    properties: {
      start: {
        // The same `pattern` the sprint rows carry, and for a sharper reason: without
        // it `configure_plugin` accepted `start: "01.05.2026"`, the anchor was read as
        // 2026-01-05, and every window of the cadence sat four months from the day the
        // caller wrote — with a success response and nothing in the interface saying so.
        type: 'string',
        pattern: DAY_PATTERN,
        description: 'Anchor day of sprint 1, YYYY-MM-DD. Without it the plugin contributes nothing.',
      },
      lengthDays: {
        type: 'integer',
        minimum: 1,
        default: 14,
        description: 'Sprint length in days, fixed for every sprint (the Scrum Guide constrains it to one month or less).',
      },
      velocity: {
        // `minimum: 0` accepted a velocity of 0, which every verb then treats as
        // absent and `rebalance_sprint` refuses outright: `configure_plugin` returned
        // success for a plugin that was not configured, and nothing in the interface
        // says so. The bound is 0.01 rather than an exclusive 0 because the schema
        // subset the host enforces has no `exclusiveMinimum` (`SUPPORTED_KEYWORDS` in
        // src/pluginHost/dataSchema.ts), and a keyword nothing checks is worse than a
        // blunt one. 0.01 is also the smallest usable value in practice: the verbs
        // compare sums at the two decimals their notes print at, so anything below it
        // is the same case as 0.
        type: 'number',
        minimum: 0.01,
        description: 'Story points a sprint is expected to hold, greater than zero. Absent: the capacity and forecast verbs report that they cannot answer; zero is refused, because it is not a capacity a rule can divide by.',
      },
      scale: {
        type: 'array',
        items: { type: 'string' },
        description: 'The estimate options offered. Defaults to 1, 2, 3, 5, 8, 13, 21.',
      },
      estimateUnit: {
        // Here rather than per sprint because it is a property of how the team
        // estimates, not of one sprint: a sprint's `capacityUnit` falls back to it, so
        // a team that plans in hours says so once instead of on every row. Without the
        // key the fallback would have nowhere to read from and every capacity would be
        // labelled „points", including the ones that are hours.
        type: 'string',
        enum: ['points', 'hours', 'items'],
        default: 'points',
        description: 'What a capacity counts when a sprint names no unit of its own. Defaults to points.',
      },
    },
    additionalProperties: false,
  },

  // A sprint is a row, and the three collections are the reason: a Sprint Goal, a
  // capacity and a frozen result have nowhere to live on a computed label. See
  // ./docs/model.md, which is the contract these declarations implement.
  collections: [
    {
      // `ordered`, and the order carries meaning beyond presentation: a sprint that
      // has no dates yet takes its window from the config raster at its POSITION in
      // this list, so reordering rows re-dates the undated ones. Numbering is the
      // default naming („Sprint 7"), which is what makes position the honest fallback.
      id: SPRINT_COLLECTIONS.sprints,
      ordered: true,
      schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            description: 'What the sprint is called. Numbering is the default („Sprint 7").',
          },
          goal: {
            // Nullable in storage although canon requires it, because no product
            // enforces one and a row that cannot be saved without a goal is a row
            // nobody creates before the planning meeting. The plugin warns while the
            // sprint is active instead, which is the only way to be true to both.
            type: 'string',
            description: 'The Sprint Goal. Warned about while the sprint is active, never demanded at write time.',
          },
          start: { type: 'string', pattern: DAY_PATTERN, description: 'First day, YYYY-MM-DD.' },
          end: { type: 'string', pattern: DAY_PATTERN, description: 'Last day, YYYY-MM-DD. Fixed length, never extended.' },
          state: {
            type: 'string',
            enum: ['planned', 'active', 'closed', 'cancelled'],
            description:
              'Where the sprint stands. `cancelled` is separate from `closed` because it has its own cause (an obsolete Sprint Goal) and its own authority (the Product Owner).',
          },
          closedOn: {
            // Distinct from `end` on purpose: a sprint can be closed early, and one
            // date cannot answer both „when was it meant to end" and „when did it".
            type: 'string',
            pattern: DAY_PATTERN,
            description: 'The day it was actually closed, which is not always `end`.',
          },
          capacity: {
            // `MIN_CAPACITY` for the reason `velocity` carries the same bound: zero is
            // not a capacity a rule may divide by. Named rather than written twice,
            // because `sprints.ts` enforces the same floor on the read side.
            type: 'number',
            minimum: MIN_CAPACITY,
            description: 'What this sprint can take, per sprint rather than one team constant.',
          },
          capacityUnit: {
            type: 'string',
            enum: ['points', 'hours', 'items'],
            description: 'What `capacity` counts. Absent: the config\'s `estimateUnit`.',
          },
          note: {
            // One field rather than three (review, retro, cancellation reason),
            // because nothing computes on it. Named as a settled open question in
            // ./docs/model.md.
            type: 'string',
            description: 'Review and retro outcome, or the cancellation reason.',
          },
        },
        required: ['name', 'state'],
        additionalProperties: false,
      },
    },
    {
      // Keyed on the pair, which makes closing idempotent: a close is several writes
      // and may be retried, and a retry that duplicated the row would double the
      // completed points in a frozen report.
      id: SPRINT_COLLECTIONS.passes,
      keyFields: ['itemId', 'sprintId'],
      schema: {
        type: 'object',
        properties: {
          itemId: { type: 'string', minLength: 1, description: 'The item that passed through the sprint.' },
          sprintId: { type: 'string', minLength: 1, description: 'The sprint it passed through.' },
          outcome: {
            type: 'string',
            enum: ['done', 'carried', 'removed', 'cancelled'],
            description: 'What became of the item when the sprint closed.',
          },
          recordedOn: { type: 'string', pattern: DAY_PATTERN, description: 'The day the close happened.' },
          estimateAtClose: {
            // Frozen for the same reason the report's series is: a later re-estimate
            // must not rewrite what the sprint delivered.
            type: 'number',
            minimum: 0,
            description: 'The estimate as it stood at the close, so a later re-estimate does not rewrite the record.',
          },
        },
        required: ['itemId', 'sprintId', 'outcome', 'recordedOn'],
        additionalProperties: false,
      },
    },
    {
      // One report per sprint, so the id IS the sprint: a second freeze of the same
      // sprint replaces the report instead of leaving two curves that disagree.
      id: SPRINT_COLLECTIONS.reports,
      keyFields: ['sprintId'],
      schema: {
        type: 'object',
        properties: {
          sprintId: { type: 'string', minLength: 1, description: 'The closed sprint this report belongs to.' },
          scopeAtStart: { type: 'number', minimum: 0, description: 'Estimated scope when the sprint started.' },
          scopeAtClose: { type: 'number', minimum: 0, description: 'Estimated scope when it closed.' },
          completed: { type: 'number', minimum: 0, description: 'What was Done at the close.' },
          carried: { type: 'number', minimum: 0, description: 'What moved on, in the same unit.' },
          unit: {
            // Frozen with the figures, for the same reason they are: the unit is part of
            // what the numbers mean. Reading it off the sprint row instead let an edit to
            // a closed sprint's `capacityUnit` relabel a curve that „never recomputed"
            // was supposed to protect — 21 points became „21 Einträge", with the same
            // figures and nothing saying they had been reinterpreted.
            //
            // Optional, because reports written before this field exists carry none, and
            // refusing them would lose the four figures over a label.
            type: 'string',
            enum: ['points', 'hours', 'items'],
            description: 'What these figures and this curve count. Absent: the sprint\'s unit is read instead.',
          },
          series: {
            // The curve as it was, never a recomputation: the item list keeps moving
            // after a sprint closes, so a chart recomputed from live items rewrites
            // history on every edit (Linear snapshots a completed cycle for exactly
            // this reason).
            type: 'array',
            items: {
              type: 'object',
              properties: {
                day: { type: 'string', pattern: DAY_PATTERN },
                remaining: { type: 'number', minimum: 0 },
              },
              required: ['day', 'remaining'],
              additionalProperties: false,
            },
            description: 'The burndown as it stood at the close, one entry per sprint day.',
          },
        },
        required: ['sprintId', 'scopeAtStart', 'scopeAtClose', 'completed', 'carried'],
        additionalProperties: false,
      },
    },
  ],

  // The host has no foreign keys left to catch a dangling id, so both links are
  // declared: a write naming a sprint that does not exist is refused, and deleting a
  // sprint takes its history and its report with it. `cascade` rather than `unlink`
  // because neither row means anything without its sprint: a pass with no sprint is
  // not „a pass somewhere", it is a record of nothing.
  references: [
    { from: SPRINT_COLLECTIONS.passes, field: 'sprintId', to: SPRINT_COLLECTIONS.sprints, onDelete: 'cascade' },
    { from: SPRINT_COLLECTIONS.reports, field: 'sprintId', to: SPRINT_COLLECTIONS.sprints, onDelete: 'cascade' },
  ],

  // All three, so the committed example renders on a static deploy: a local source
  // materializes the file and `stripFileForPublication` removes the rows of every
  // plugin that did not declare them, which would leave the example showing a
  // timeline with no sprints at all. Consent stays per timeline (`public` on the
  // plugin entry) and is off by default, so declaring this publishes nothing on its
  // own. See docs/plugin-public-read.md.
  publicRead: {
    collections: [SPRINT_COLLECTIONS.sprints, SPRINT_COLLECTIONS.passes, SPRINT_COLLECTIONS.reports],
  },

  // The three verbs, implemented as pure functions in `tools.ts` under the same
  // names. The descriptions are what a model reads before choosing, so each names
  // the rule and its limit rather than saying „applies the rule".
  //
  // Two absences are deliberate. There is no `plan_sprints`: a tool returns item
  // changes and notes, never configuration, and the cadence is configuration
  // (`configure_plugin` writes it). And there is no verb that closes a sprint: a
  // close has to flip the sprint's state, write its `passes` rows and freeze its
  // report, and a tool cannot write the plugin's own rows. That is `host.data` from
  // the view, and `docs/model.md` names it as the gap it is.
  tools: [
    {
      name: 'plan_sprint',
      title: 'Assign items to a sprint',
      description:
        'Assign the named items to a sprint by writing the assignment key on each of them. The sprint is ' +
        'given by the row id from the `sprints` collection, never by its name. Names, and does not change, ' +
        "anything whose own dates fall outside the sprint's window: neither the dates nor the assignment is " +
        'touched, because one overwrites a plan and the other a commitment. Also names ids that no item ' +
        'carries, items that already carry this assignment (not written again), and finished work that was ' +
        'assigned along. Computes no sums; ask `sprint_status` whether the scope fits.',
      inputSchema: {
        type: 'object',
        properties: {
          sprint: { type: 'string', minLength: 1, description: 'Row id of the sprint from the `sprints` collection.' },
          items: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 },
            description: 'Ids of the items to assign.',
          },
        },
        required: ['sprint', 'items'],
        additionalProperties: false,
      },
      writes: 'items',
    },
    {
      name: 'roll_over',
      title: 'Roll unfinished work over',
      description:
        'Move the unfinished work of one sprint to an explicit target: another sprint (`toSprint`) or the ' +
        'Product Backlog (`toBacklog: true`, which clears the assignment). There is deliberately no default ' +
        'target, because the Scrum Guide returns unfinished work to the Product Backlog while the common ' +
        'tools default to the next sprint; a call without a target is refused, and so is one with both. ' +
        'Finished work keeps the sprint it was finished in. No date is changed, and dependents left behind ' +
        'are named rather than moved along. Only assignments are written: the sprint keeps its state and no ' +
        '`passes` row is recorded, so a roll-over is not a close.',
      inputSchema: {
        type: 'object',
        properties: {
          sprint: { type: 'string', minLength: 1, description: 'Row id of the sprint whose unfinished work moves.' },
          toSprint: {
            type: 'string',
            minLength: 1,
            description: 'Row id of the target sprint. Mutually exclusive with `toBacklog`; one of the two is required.',
          },
          toBacklog: {
            type: 'boolean',
            description: 'true clears the assignment (back to the Product Backlog). Mutually exclusive with `toSprint`.',
          },
        },
        required: ['sprint'],
        additionalProperties: false,
      },
      writes: 'items',
    },
    {
      name: 'sprint_status',
      title: 'Report a sprint',
      description:
        'Report one sprint: scope and remaining work against its capacity, how many days are left against ' +
        'today, and every warning the rows produce — an active sprint without a goal, more than one active ' +
        'sprint, items whose dates disagree with their assignment, items with no usable estimate. Also ' +
        'reports the scope no sprint accounts for, so the sums cannot be read as the whole timeline. Without ' +
        'an argument it reports the active sprint. Never a velocity figure and never a ' +
        'committed-versus-completed pair. Changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          sprint: { type: 'string', minLength: 1, description: 'Row id of the sprint to report. Absent: the active sprint.' },
        },
        additionalProperties: false,
      },
    },
  ],
};
