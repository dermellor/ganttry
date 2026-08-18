// The three verbs an agent can call, and nothing else.
//
// The domain rules themselves live in `lifecycle.ts` and are tested there. This module
// is the adapter: it reads the arguments, calls one rule, and turns the result into a
// plan of item changes plus the notes an agent has to relay. Keeping the split means
// the arithmetic is testable without constructing a `ToolContext`, and the same rule
// backs the derived fields.
//
// **The text here is English and stays English.** A tool's notes are part of the agent
// surface (docs/mcp.md), not the interface, so they do not go through `messages.ts` —
// which is also why `check-ui-text.mjs` exempts this file's quoting.
//
// Three constraints, all following from „a tool is a pure function":
//
//   - It returns changes; it does not perform them. The host applies the plan through
//     its own write path, which is what keeps capabilities, optimistic locking and the
//     audit trail in force.
//   - It reads `now` from its context and never the clock. That is what makes „the
//     end-of-support date is already past" a case a test can reach.
//   - No I/O, no DOM. This module is imported statically by the registry and by the
//     process that serves agent calls, which has no DOM.
//
// **What no verb here can do**, and both absences are deliberate rather than pending:
// none of them writes a freeze window (a tool returns item changes, never the plugin's
// own rows, and a freeze calendar is somebody's decision rather than a computation),
// and none of them writes an end-of-support date. That date belongs to the vendor, and
// a verb that could move it would be able to make a late plan look on time.

import type { ToolHandler, ToolPlan } from '../../pluginHost/api';
import {
  CUTOVER_KEY,
  SHUTDOWN_KEY,
  type Freeze,
  type LifecyclePlan,
  type Risk,
  daysBetween,
  freezeAt,
  latestStart,
  nextFreeDay,
  parallelRunDays,
  placeCutover,
  readConfig,
  readFreezes,
  readPlan,
  readPlans,
  risksOf,
} from './lifecycle';

/** How an item is named in a note: its content, falling back to its id. */
function nameOf(plan: LifecyclePlan): string {
  return plan.content || plan.itemId;
}

function freezeName(freeze: Freeze): string {
  return `"${freeze.name}" (${freeze.from} to ${freeze.to})`;
}

/**
 * Place one item's cutover and shutdown by counting backwards from its deadline.
 *
 * Throws rather than returning an empty plan for every refusal, because an empty plan
 * reads as „nothing to do" and each of these is a different fact the caller has to
 * act on: no vendor date, no configured minimum, or a freeze calendar that leaves no
 * admissible day at all.
 */
export const planCutover: ToolHandler = ({ file, config, args, now }): ToolPlan => {
  const itemId = String(args.item ?? '').trim();
  const item = (file.items ?? []).find((i) => i.id === itemId);
  if (!item) throw new Error(`no item "${itemId}" on this timeline`);

  const cfg = readConfig(config);
  const plan = readPlan(item, cfg);
  const freezes = readFreezes(file);

  const placed = placeCutover({ plan, minParallelRunDays: cfg.minParallelRunDays, freezes, now });
  if (placed.ok === false) {
    switch (placed.reason) {
      case 'no-deadline':
        throw new Error(
          `"${nameOf(plan)}" carries no end-of-support date, so there is nothing to count backwards from. ` +
            `Set "${'endOfSupport'}" on the item first.`,
        );
      case 'no-minimum':
        throw new Error(
          'this plugin has no minParallelRunDays configured, and there is no industry-wide default to fall back ' +
            'on. Configure it on the timeline before dating a cutover.',
        );
      case 'freeze-blocks-every-day':
        throw new Error(
          `every candidate day for the cutover of "${nameOf(plan)}" falls in a freeze window` +
            `${placed.freeze ? `, starting with ${freezeName(placed.freeze)}` : ''}. The freeze calendar and this ` +
            'deadline cannot both be satisfied: shorten the freeze, buy extended support, or accept a shorter ' +
            'parallel run explicitly.',
        );
      case 'no-room-before-start':
        throw new Error(
          `the cutover of "${nameOf(plan)}" would have to fall before the item's own start (${plan.start}) to clear ` +
            `${placed.freeze ? freezeName(placed.freeze) : 'the freeze windows'} and keep the parallel-run minimum. ` +
            'Move the start earlier or reduce the minimum.',
        );
    }
    // Unreachable while `PlacementRefusal` is fully handled above, and here so that a
    // fifth refusal added to the rule cannot silently fall through to a success path
    // that has no placement to read.
    throw new Error(`the cutover of "${nameOf(plan)}" could not be placed: ${placed.reason}`);
  }

  const { placement } = placed;
  const notes: string[] = [
    `"${nameOf(plan)}": cutover ${placement.cutover}, shutdown ${placement.shutdown}, ` +
      `parallel run ${placement.parallelRunDays} days.`,
  ];
  if (placement.movedOutOf) {
    notes.push(
      `the cutover was moved earlier out of ${freezeName(placement.movedOutOf)}, which lengthens the parallel run ` +
        'rather than shortening it.',
    );
  }
  if (placement.deadlinePast) {
    notes.push(`the deadline is already behind ${now}, so every date in this plan is in the past.`);
  }
  if (placement.startsLate) {
    const latest = latestStart(plan);
    notes.push(
      `the item starts on ${plan.start}, after the latest possible start (${latest}), so the lead time no longer fits.`,
    );
  }

  return {
    changes: [
      {
        op: 'update',
        itemId,
        patch: {
          metadata: {
            ...(item.metadata ?? {}),
            [CUTOVER_KEY]: placement.cutover,
            [SHUTDOWN_KEY]: placement.shutdown,
          },
        },
      },
    ],
    notes,
  };
};

/**
 * Who a risk is about.
 *
 * The system comes first when the item names one, because the question this verb
 * answers is „which of my systems is late" and the item is only where the dates
 * happen to be written. Both are given when they differ: one system's migration can be
 * several items, and „Exchange 2016 is late" is not actionable without saying which
 * part of it.
 */
function riskSubject(plan: LifecyclePlan): string {
  const item = nameOf(plan);
  if (!plan.system) return `"${item}"`;
  return plan.system === item ? `"${plan.system}"` : `"${plan.system}" — "${item}"`;
}

/** One risk as a sentence an agent can relay without the reader seeing the timeline. */
function riskNote(risk: Risk, minParallelRunDays: number | undefined): string {
  const who = riskSubject(risk.plan);
  switch (risk.kind) {
    case 'no-end-of-support':
      return `${who}: no end-of-support date, so nothing about this plan can be judged.`;
    case 'deadline-past':
      return `${who}: end of support was ${risk.day}, which has passed.`;
    case 'no-lead-time':
      return `${who}: no lead time, so there is no latest possible start to compare against.`;
    case 'starts-after-latest-start':
      return `${who}: starts ${risk.days} days after the latest possible start (${risk.day}).`;
    case 'shutdown-after-deadline':
      return `${who}: shutdown is ${risk.days} days after the deadline (${risk.day}), so the old system runs unsupported.`;
    case 'cutover-in-freeze':
      return `${who}: the cutover on ${risk.day} falls in ${risk.freeze ? freezeName(risk.freeze) : 'a freeze window'}.`;
    case 'parallel-run-too-short':
      return `${who}: parallel run is ${risk.days} days, under the configured minimum of ${minParallelRunDays}.`;
    case 'shutdown-before-cutover':
      return `${who}: the shutdown falls before the cutover, so there is no parallel run at all.`;
  }
}

/**
 * Report every plan that does not hold. Changes nothing, and declares no `writes`, so
 * the notes are the entire answer.
 *
 * It reports what it cannot judge as loudly as what is wrong. A verb that listed only
 * failures would answer „no risks" for a timeline where nobody has filled in a single
 * vendor date, and that silence reads as safety.
 */
export const checkEolRisk: ToolHandler = ({ file, config, args, now }): ToolPlan => {
  const cfg = readConfig(config);
  const wanted = typeof args.system === 'string' ? args.system.trim() : '';
  const all = readPlans(file, cfg);
  const filtered = wanted ? all.filter((plan) => plan.system === wanted) : all;
  // Grouped by system so one system's findings arrive together rather than interleaved
  // with four others'. Stable within a system, which keeps the item order the timeline
  // has; items naming no system go last, because they are the ones nobody has classified
  // and reading them first would bury the answer.
  const plans = [...filtered].sort((a, b) => {
    if (a.system === b.system) return 0;
    if (!a.system) return 1;
    if (!b.system) return -1;
    return a.system < b.system ? -1 : 1;
  });
  const freezes = readFreezes(file);

  if (!plans.length) {
    return {
      notes: [
        wanted
          ? `no item on this timeline carries the system "${wanted}".`
          : 'no item on this timeline carries any lifecycle dates, so there is nothing to judge.',
      ],
    };
  }

  const risks = risksOf({ plans, freezes, config: cfg, now });
  if (!risks.length) {
    const notes = [`${plans.length} plans checked against ${now}, none of them at risk.`];
    // Named rather than left implicit: without a minimum, two of the six checks did
    // not run, and „none at risk" would otherwise be read as covering them.
    if (!cfg.minParallelRunDays) {
      notes.push('no minParallelRunDays is configured, so the parallel-run length was not checked.');
    }
    return { notes };
  }

  const notes = risks.map((risk) => riskNote(risk, cfg.minParallelRunDays));
  notes.unshift(`${risks.length} findings across ${plans.length} plans, checked against ${now}.`);
  if (!cfg.minParallelRunDays) {
    notes.push('no minParallelRunDays is configured, so the parallel-run length was not checked.');
  }
  return { notes };
};

/**
 * Move affected cutovers forward out of their freeze windows.
 *
 * **The shutdown deliberately stays where it is.** Moving it along would keep the
 * parallel run intact and push the old system past the vendor's date, which is the one
 * date nobody can negotiate; leaving it means the freeze costs parallel-run time, and
 * this verb's job is then to say exactly how much. Both are defensible and only one of
 * them is honest about which date is fixed.
 */
export const shiftOutOfFreeze: ToolHandler = ({ file, config, args }): ToolPlan => {
  const cfg = readConfig(config);
  const freezes = readFreezes(file);
  const only = typeof args.item === 'string' ? args.item.trim() : '';

  const items = (file.items ?? []).filter((item) => !!item.id && (!only || item.id === only));
  if (only && !items.length) throw new Error(`no item "${only}" on this timeline`);
  if (!freezes.length) return { notes: ['this timeline declares no freeze windows, so no cutover can sit in one.'] };

  const changes: ToolPlan['changes'] = [];
  const notes: string[] = [];

  for (const item of items) {
    const plan = readPlan(item, cfg);
    if (!plan.cutover) continue;
    const hit = freezeAt(plan.cutover, freezes);
    if (!hit) continue;

    const moved = nextFreeDay(plan.cutover, freezes);
    if (!moved) {
      throw new Error(
        `the freeze windows after ${plan.cutover} leave no admissible day for "${nameOf(plan)}", so its cutover ` +
          'cannot be moved forward. Nothing was changed.',
      );
    }

    const lost = daysBetween(plan.cutover, moved);
    notes.push(
      `"${nameOf(plan)}": cutover ${plan.cutover} → ${moved}, out of ${freezeName(hit)} (${lost} days later).`,
    );

    const run = parallelRunDays({ cutover: moved, shutdown: plan.shutdown });
    if (run != null && run < 0) {
      notes.push(
        `"${nameOf(plan)}": the new cutover falls after the shutdown (${plan.shutdown}), so this plan has no ` +
          'parallel run left at all.',
      );
    } else if (run != null && cfg.minParallelRunDays && run < cfg.minParallelRunDays) {
      notes.push(
        `"${nameOf(plan)}": the parallel run drops to ${run} days, under the configured minimum of ` +
          `${cfg.minParallelRunDays}. The shutdown was left on ${plan.shutdown}, because that is the vendor's date.`,
      );
    }

    changes.push({
      op: 'update',
      itemId: item.id!,
      patch: { metadata: { ...(item.metadata ?? {}), [CUTOVER_KEY]: moved } },
    });
  }

  if (!changes.length) {
    return { notes: ['no cutover on this timeline sits in a freeze window.'] };
  }
  notes.unshift(
    changes.length === 1
      ? 'One cutover moved out of a freeze window.'
      : `${changes.length} cutovers moved out of a freeze window.`,
  );
  return { changes, notes };
};

/** Keyed by the tool names the manifest declares. The two must agree. */
export const lifecycleTools: Record<string, ToolHandler> = {
  plan_cutover: planCutover,
  check_eol_risk: checkEolRisk,
  shift_out_of_freeze: shiftOutOfFreeze,
};
