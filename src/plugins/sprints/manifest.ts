// What this plugin declares about itself. The host reads it *before* running any
// plugin code, so everything the plugin needs has to be declared rather than
// requested at runtime.
//
// `register()` refuses an invalid manifest and throws while the module loads, so a
// mistake here does not produce a plugin that fails to appear: it takes the app
// down. `manifest.test.ts` is the cheap guard against that.

import type { PluginManifest } from '../../pluginHost/api';

export const sprintsManifest: PluginManifest = {
  id: 'dev.zeitlines.sprints',
  name: 'Sprints',
  version: '0.1.0',
  // `^1.5` and not `^1`, because the `sprint` field is `derived`: the value comes
  // from `derive(file)` and nothing is stored. On a host older than 1.5 that field
  // would render as an editable control with nothing behind it, and no newer host
  // can warn about it on the older one's behalf.
  apiVersion: '^1.5',

  // `items:read` for the raster and the sums, `items:write` because
  // `rebalance_sprint` moves items, `fields` for the three fields, `tools` for the
  // three verbs. No `views`: grouping by „Sprints · Sprint" *is* the raster
  // rendering (see „What it deliberately does not do" in the README).
  capabilities: ['items:read', 'items:write', 'fields', 'tools'],

  catalogue: {
    summary:
      'A sprint raster that follows from the dates: which sprint an item is in is computed, not stored, with capacity checks and a forecast on top.',
    // A slug, not the prose „delivery planning": the validator demands
    // `^[a-z][a-z0-9-]*$` for a domain, and a space here would make `register()`
    // throw at module load, which takes the whole app down rather than hiding one
    // plugin.
    domain: 'delivery-planning',
    keywords: [
      'sprint',
      'sprint planning',
      'story points',
      'velocity',
      'capacity',
      'forecast',
      'scrum',
      'self-hosted roadmap',
    ],
    example: 'src:example-sprint-planung',
  },

  // The two keys a person chooses, and therefore the two an uninstall has to clean
  // off items. `sprint` is deliberately NOT here: it is derived, so no item carries
  // a value under it and there is nothing to purge. Listing it would make an
  // uninstall promise a cleanup it cannot perform, and would suggest the value is
  // stored, which is the exact misunderstanding the derived seam exists to prevent.
  metadataKeys: ['storyPoints', 'estimateConfidence'],

  configSchema: {
    type: 'object',
    properties: {
      start: {
        type: 'string',
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
    },
    additionalProperties: false,
  },

  // The three verbs, implemented as pure functions in `tools.ts` under the same
  // names. The descriptions are what a model reads before choosing, so they name
  // the rule and its limit rather than saying „applies the rule".
  //
  // There is deliberately no `plan_sprints`: a tool returns item changes and notes,
  // never configuration, and the raster is configuration (`configure_plugin` writes
  // it).
  tools: [
    {
      name: 'check_sprint_capacity',
      title: 'Check sprint capacity',
      description:
        'Sum the story points per sprint and compare them against the configured velocity. Reports which sprints are overcommitted, names the items carrying no usable estimate, and names the items the raster does not place at all (no start, or a start before the anchor) with their points and ids, because a sum that is missing three items is not a capacity statement. Changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          sprint: {
            type: 'integer',
            minimum: 1,
            description: 'Sprint number to check. Absent: every sprint the items occupy.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'rebalance_sprint',
      title: 'Rebalance one sprint',
      description:
        'Move items out of one overcommitted sprint into the next one until the sum fits the velocity: latest start first, tie-break the larger estimate, then the item id. A move shifts the start by one sprint length and keeps the duration. Four kinds of item are named and left where they are, because moving them could not help: an estimate larger than the whole velocity, finished work (status Done, whose points still count in the sum), an item another item depends on, and an item whose id or dates cannot be written back. When those alone exceed the velocity the call changes nothing and says why. Relieves exactly one sprint and does not cascade: if the receiving sprint is overcommitted afterwards it says so, and a second call is how the next sprint gets relieved.',
      inputSchema: {
        type: 'object',
        properties: {
          sprint: {
            type: 'integer',
            minimum: 1,
            description: 'Sprint number to relieve.',
          },
        },
        required: ['sprint'],
        additionalProperties: false,
      },
      writes: 'items',
    },
    {
      name: 'forecast_completion',
      title: 'Forecast the completion sprint',
      description:
        'Divide the open story points by the velocity to say which sprint the remaining scope is expected to finish in, counting from the later of the sprint today falls into and the earliest sprint that still holds open scheduled work — a scope cannot finish before the plan starts it. Says so when open work is scheduled after the computed sprint, and when the date it was handed is not one. Optionally narrowed to one group. An extrapolation from an average, never a commitment. Changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          group: {
            type: 'string',
            description: 'Group id to narrow the scope to. Absent: the whole timeline.',
          },
        },
        additionalProperties: false,
      },
    },
  ],
};
