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
 * Here rather than in `lifecycle.ts` because the manifest is what the host reads
 * before any plugin code runs, and a second copy of a collection id is the one that
 * goes stale: the id keys the rows in `plugin_data`, so a mismatch between the
 * declaration and the reader is a silently empty collection rather than an error.
 */
export const LIFECYCLE_COLLECTIONS = {
  freezes: 'freezes',
} as const;

/**
 * A calendar day and nothing else.
 *
 * `format: 'date'` is not in the subset the host enforces (`SUPPORTED_KEYWORDS` in
 * src/pluginHost/dataSchema.ts), and a keyword nothing checks is worse than a blunt
 * one: the author reads it as a constraint. `pattern` is enforced, so a freeze window
 * cannot be stored as „über Weihnachten" and then block nothing.
 */
const DAY_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

export const lifecycleManifest: PluginManifest = {
  id: 'dev.zeitlines.lifecycle',
  name: 'Lifecycle',
  version: '0.1.0',
  // `^1.7` is the floor, and each step of it is load-bearing here rather than
  // aspirational: `^1.3` for `tools`, `^1.5` for the two `derived` fields (on an
  // older host they render as editable controls with nothing filling them, which
  // reads as the plugin being broken), `^1.6` for the calendar-day arithmetic this
  // plugin takes from the contract instead of restating — the first date-shaped
  // plugin that restated it computed a date nobody had written — and `^1.7` for
  // `pluginMessages`, without which the labels below cannot follow the reader.
  apiVersion: '^1.7',

  // `items:read` for the plans, `items:write` because two verbs move dates, `fields`
  // for the eight fields, `tools` for the three verbs, `data:own` for the freeze
  // windows, `public:read` so the committed example renders on a static deploy.
  //
  // No `views`: what the domain wants to see is „which systems are late", and
  // grouping by the derived support window renders that already. A view here would
  // be ten times the work of the rule that makes it worth having.
  capabilities: ['items:read', 'items:write', 'fields', 'tools', 'data:own', 'public:read'],

  catalogue: {
    summary:
      'Dates a migration backwards from a vendor’s end-of-support date: the latest possible start, a cutover that avoids the freeze windows, and a parallel run that keeps its minimum.',
    // A slug, not the prose „lifecycle management": the validator demands
    // `^[a-z][a-z0-9-]*$` for a domain, and a space here would make `register()`
    // throw at module load, which takes the whole app down rather than hiding one
    // plugin.
    domain: 'lifecycle-management',
    // The words the harvest found people searching with, not the ones this code
    // uses. „EOL" and „end of support" are both here because the vendors' own pages
    // disagree about which one they mean.
    keywords: [
      'end of life',
      'EOL',
      'end of support',
      'extended support',
      'migration planning',
      'cutover',
      'freeze window',
      'change freeze',
      'parallel run',
      'decommission',
      'legacy migration',
    ],
    example: 'src:example-eol-migration',
  },

  // The six keys a person fills in, and therefore the six an uninstall has to clean
  // off items.
  //
  // `latestStart` and `supportWindow` are deliberately absent, and that difference is
  // the whole model: both are computed on every build from the item's own dates, so no
  // item carries a value under them and there is nothing to purge. Listing them would
  // promise a cleanup with nothing to clean and would suggest the computed dates are
  // stored — which is the exact misunderstanding the derived seam exists to prevent.
  metadataKeys: ['system', 'endOfSupport', 'extendedUntil', 'leadTimeDays', 'cutover', 'shutdown'],

  configSchema: {
    type: 'object',
    properties: {
      minParallelRunDays: {
        // **No `default`.** The sources disagree by an order of magnitude: two to four
        // weeks, fifteen days to three months, two to eight weeks, and „a full business
        // year" before the old system goes off. A default here would be this plugin
        // inventing a domain rule and every plan inheriting it silently, so the verbs
        // report that they cannot answer instead.
        type: 'integer',
        minimum: 1,
        description:
          'Shortest parallel run the plan may have, in days. No default: the practice has no industry-wide number, so without this the cutover and risk verbs report that they cannot answer.',
      },
      defaultLeadTimeDays: {
        type: 'integer',
        minimum: 1,
        description:
          'Migration lead time for an item that names none, in days. Absent rather than defaulted, for the same reason.',
      },
    },
    additionalProperties: false,
  },

  // One collection, and the reason it is a collection rather than a field: a freeze
  // window is a property of the organisation's calendar, not of one item. Stored per
  // item it would be repeated on every plan and could disagree with itself; a year-end
  // freeze is one span that applies to every system at once.
  collections: [
    {
      // Not `ordered`: nothing about a freeze depends on its position, and the reader
      // sorts by `from` anyway. Declaring an order the code does not use would be an
      // invariant the next person has to maintain for nothing.
      id: LIFECYCLE_COLLECTIONS.freezes,
      schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            description: 'What the freeze is called („Year-end freeze", „Peak season").',
          },
          from: { type: 'string', pattern: DAY_PATTERN, description: 'First blocked day, YYYY-MM-DD.' },
          to: {
            type: 'string',
            pattern: DAY_PATTERN,
            description: 'Last blocked day, inclusive. A cutover on this day is still refused.',
          },
        },
        // All three, because a span with one end is not a span: defaulting the missing
        // end would block days nobody declared, and a nameless window cannot be
        // reported back in a way anybody can act on.
        required: ['name', 'from', 'to'],
        additionalProperties: false,
      },
    },
  ],

  // The rows are declared public-readable so the committed example renders on a static
  // deploy: `stripFileForPublication` removes the rows of every plugin that did not
  // declare them, which would leave the example showing a timeline with no freeze
  // windows — and a cutover that avoids nothing is not a demonstration of this plugin.
  // Consent stays per timeline (`public` on the plugin entry) and is off by default, so
  // declaring this publishes nothing on its own. See docs/plugin-public-read.md.
  publicRead: {
    collections: [LIFECYCLE_COLLECTIONS.freezes],
  },

  // The three verbs, implemented as pure functions in `tools.ts` under the same names.
  // The descriptions are what a model reads before choosing, so each names the rule
  // **and its limit** rather than saying „applies the rule".
  //
  // Two absences are deliberate. There is no verb that writes a freeze window: a tool
  // returns item changes and never the plugin's own rows, and a freeze calendar is
  // somebody's decision rather than a computation. And there is no verb that sets an
  // end-of-support date — that date belongs to the vendor, and a plugin that could
  // move it would be able to make a late plan look on time.
  tools: [
    {
      name: 'plan_cutover',
      title: 'Date a cutover backwards from end of support',
      description:
        'Place the cutover and the shutdown of one item by counting backwards from its end-of-support date: the ' +
        'old system is off by the deadline, and the parallel run before it is at least the configured minimum. ' +
        'Only the cutover moves out of a freeze window, and it moves EARLIER — moving it later would trade away ' +
        'the parallel-run minimum it was just given. Uses the extended-support date when the item carries one, ' +
        'and never derives one from end of support. Refuses, with the reason, when there is no end-of-support ' +
        'date, no configured minimum, or when the freeze windows leave no admissible day before the plan starts. ' +
        'Reports rather than hides a deadline that is already past. Writes no vendor date and no freeze row.',
      inputSchema: {
        type: 'object',
        properties: {
          item: { type: 'string', minLength: 1, description: 'Id of the item to date.' },
        },
        required: ['item'],
        additionalProperties: false,
      },
      writes: 'items',
    },
    {
      name: 'check_eol_risk',
      title: 'Report lifecycle risk',
      description:
        'Report every item whose plan does not hold: it starts after the latest possible start (end of support ' +
        'minus the lead time), its shutdown falls after the deadline, its cutover sits in a freeze window, its ' +
        'parallel run is shorter than the configured minimum, or its end-of-support date has already passed. ' +
        'Also names the items that cannot be judged at all — no end-of-support date, no lead time — so the ' +
        'silence is not read as safety. Groups by the system field where items name one. Ranks nothing: ' +
        'severity depends on what the system does, which is not in the timeline. Changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          system: {
            type: 'string',
            minLength: 1,
            description: 'Report only items carrying this system. Absent: every item.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'shift_out_of_freeze',
      title: 'Move a cutover out of a freeze window',
      description:
        'Move the cutover of every affected item to the first admissible day AFTER the freeze window it sits in, ' +
        'walking on through any window that follows. The shutdown is deliberately left where it is, because the ' +
        'vendor’s date is the one nobody can negotiate — so the freeze costs parallel-run time, and the answer ' +
        'names how many days each plan loses and which ones drop under the configured minimum. Touches no item ' +
        'whose cutover is already admissible. Refuses when a window has no end a walk can leave.',
      inputSchema: {
        type: 'object',
        properties: {
          item: {
            type: 'string',
            minLength: 1,
            description: 'Id of one item to move. Absent: every item whose cutover sits in a freeze window.',
          },
        },
        additionalProperties: false,
      },
      writes: 'items',
    },
  ],
};
