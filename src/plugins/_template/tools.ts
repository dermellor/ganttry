// The domain rules this plugin contributes, as verbs an agent can call.
//
// TEMPLATE. **Delete this file if the plugin has no rules of its own** — a
// fields-only plugin is a legitimate and common shape. Delete the `tools` line in
// `descriptor.ts` and the `tools` section in `manifest.ts` with it.
//
// This is the half of a plugin that fields cannot express. An agent gets
// `add_item` and `update_item` from the core; what it cannot get is the rule that
// decides WHICH items and WHAT dates. Kept in a prompt, that rule cannot be
// tested, cannot be reused, and is wrong in a way nobody notices until a date is
// wrong.
//
// Three constraints, all following from „a tool is a pure function":
//
//   - It returns changes; it does not perform them. The host applies the plan
//     through its own write path, which is what keeps capabilities, optimistic
//     locking and the audit trail in force.
//   - It reads `now` from its context and never the clock. That is what makes the
//     boundary the domain cares about testable — the deadline landing on a
//     weekend, the trade with zero lead time.
//   - No I/O, no DOM. This module is imported statically by the registry (see
//     descriptor.ts) and by the process that serves agent calls, which has no DOM.
//
// Every rule here needs a test in `tools.test.ts`. That is where a wrong deadline
// calculation gets caught, and a plausible-looking wrong rule is worse than a
// missing one because it gets trusted.

import type { ToolHandler, ToolPlan } from '../../pluginHost/api';

/**
 * The rule behind one declared verb.
 *
 * Throwing is a legitimate answer: a domain rule meeting data it cannot handle is
 * an expected outcome, and the message reaches the agent instead of a stack
 * trace. Prefer it over returning an empty plan, which reads as „nothing to do".
 */
export const shiftExample: ToolHandler = ({ file, args, now }): ToolPlan => {
  const from = typeof args.from === 'string' ? args.from : now;

  const changes = file.items
    .filter((item) => item.id && item.start)
    .map((item) => ({ op: 'update' as const, itemId: item.id!, patch: { start: from } }));

  // `notes` is the part an agent has to relay and cannot infer from a diff. For a
  // tool that declares no `writes` it is the entire answer.
  return { changes, notes: [`${changes.length} Einträge auf ${from} gesetzt`] };
};

/** Keyed by the tool name the manifest declares. The two must agree. */
export const exampleTools: Record<string, ToolHandler> = {
  shift_example: shiftExample,
};
