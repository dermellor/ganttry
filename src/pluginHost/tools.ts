// Running a verb a plugin contributed, and checking what it produced.
//
// The declaration lives in the manifest (`ToolDecl`), so the host can list and
// version-check a tool without executing anything. This module is the other
// half: what a tool receives, what it may return, and the two checks the host
// applies around it.
//
// **A tool is a pure function.** Timeline plus arguments in, a plan of item
// changes out. That is not a stylistic preference, it is what the surrounding
// constraints leave:
//
//   - A plugin must not ship server code (see the header of ./manifest.ts and
//     docs/plugin-isolation.md), while the thing calling a tool is a server
//     process. A handler that did its own I/O would be server code by another
//     name.
//   - A domain rule has to be unit-testable, which is the entire reason for
//     moving it out of a prompt. A function over data is testable; one that
//     writes through to a database is not, and the boundary the domain cares
//     about — the deadline landing on a weekend, the trade with zero lead time —
//     is exactly what nobody sets up an integration test for.
//   - The host already owns a write path with capabilities, optimistic locking
//     and an audit trail on it. A tool returning changes keeps all three; a tool
//     performing them would have to be handed a second way in.
//
// `now` is passed in for the same reason: a rule that reads the clock itself
// cannot be tested against the boundary it exists for.

import type { TimelineFile, TimelineFileItem } from '../types';
import type { ToolDecl } from './manifest';
import { validateRow } from './dataSchema';

/** What a tool is handed. Everything it may read, and nothing it can write. */
export type ToolContext = {
  /** The timeline as it currently is. A handler must treat it as read-only. */
  file: TimelineFile;
  /** The plugin's own config bag on this timeline (`{}` when it declared none). */
  config: Record<string, unknown>;
  /** The arguments, already checked against the tool's `inputSchema`. */
  args: Record<string, unknown>;
  /**
   * Today, as `YYYY-MM-DD`. Supplied by the host rather than read from the clock
   * so a rule that depends on the current date is testable at its boundary.
   */
  now: string;
};

/** One change a tool asks for. */
export type ItemChange =
  | { op: 'update'; itemId: string; patch: Partial<TimelineFileItem> }
  | { op: 'add'; item: TimelineFileItem };

/**
 * What a tool returns: the changes it wants applied, and what it concluded.
 *
 * `notes` is not a log. For a tool that declares no `writes` it is the entire
 * answer, and for one that does it is where „three deadlines moved, the fourth
 * was already past" gets said — the part an agent has to relay and cannot infer
 * from a diff.
 */
export type ToolPlan = {
  changes?: ItemChange[];
  notes?: string[];
};

/** The function a plugin implements per declared tool. */
export type ToolHandler = (ctx: ToolContext) => ToolPlan;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Check the arguments against the tool's declared schema.
 *
 * Returns every problem rather than the first, like the manifest check and the
 * row check do: an agent correcting one argument per rejected call is the slow
 * way to learn that three are wrong.
 */
export function validateToolArgs(decl: ToolDecl, args: unknown): string[] {
  if (decl.inputSchema == null) return isPlainObject(args) || args == null ? [] : ['arguments must be an object'];
  if (!isPlainObject(args)) return ['arguments must be an object'];
  return validateRow(decl.inputSchema, args, 'arguments');
}

/**
 * Check a plan before any of it is applied.
 *
 * All-or-nothing on purpose: a plan is one domain rule's answer, and applying
 * the half of it that happened to be well-formed leaves the timeline in a state
 * the rule never described. „Six dates moved, the seventh was refused" is worse
 * than „nothing moved, here is why", because the first looks like it worked.
 */
export function validateToolPlan(decl: ToolDecl, file: TimelineFile, plan: unknown): string[] {
  if (!isPlainObject(plan)) return ['a tool must return an object'];
  const problems: string[] = [];
  const { changes, notes } = plan as ToolPlan;

  if (notes != null && (!Array.isArray(notes) || notes.some((n) => typeof n !== 'string'))) {
    problems.push('notes must be an array of strings');
  }
  if (changes == null) return problems;
  if (!Array.isArray(changes)) return [...problems, 'changes must be an array'];

  // An analysis tool that returns changes is a declaration that stopped being
  // true, and the manifest is what the operator approved on install. Refusing
  // here is what keeps `writes` from being decoration.
  if (changes.length && decl.writes !== 'items') {
    problems.push(
      `tool "${decl.name}" declares no writes, so it must not return changes (it returned ${changes.length})`,
    );
  }

  const existing = new Set((file.items ?? []).map((i) => i.id).filter((id): id is string => !!id));
  const added = new Set<string>();

  changes.forEach((change, i) => {
    const where = `changes[${i}]`;
    if (!isPlainObject(change)) {
      problems.push(`${where}: must be an object`);
      return;
    }
    if (change.op === 'update') {
      if (typeof change.itemId !== 'string' || !change.itemId.trim()) {
        problems.push(`${where}: update needs an itemId`);
        return;
      }
      if (!existing.has(change.itemId) && !added.has(change.itemId)) {
        problems.push(`${where}: no item "${change.itemId}" on this timeline`);
      }
      if (!isPlainObject(change.patch)) {
        problems.push(`${where}: update needs a patch object`);
        return;
      }
      if (!Object.keys(change.patch).length) problems.push(`${where}: patch is empty`);
      // A patch that renames an item silently orphans every dependency pointing
      // at the old id, and a plan is applied without anybody reading it.
      if ('id' in change.patch) problems.push(`${where}: a patch must not change an item's id`);
      // Server-managed, and a plan that sets one either forges an audit trail or
      // defeats the lock it looks like it is honouring.
      for (const managed of ['version', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']) {
        if (managed in change.patch) problems.push(`${where}: "${managed}" is managed by the host`);
      }
      return;
    }
    if (change.op === 'add') {
      if (!isPlainObject(change.item)) {
        problems.push(`${where}: add needs an item object`);
        return;
      }
      const item = change.item as TimelineFileItem;
      if (typeof item.content !== 'string' || !item.content.trim()) {
        problems.push(`${where}: an added item needs content`);
      }
      if (item.id != null) {
        if (typeof item.id !== 'string' || !item.id.trim()) problems.push(`${where}: item id must be a non-empty string`);
        else if (existing.has(item.id) || added.has(item.id)) problems.push(`${where}: item id "${item.id}" already exists`);
        else added.add(item.id);
      }
      return;
    }
    problems.push(`${where}: op must be "update" or "add"`);
  });

  return problems;
}

/**
 * Run a tool and check both ends of it.
 *
 * A handler that throws is reported as a refusal rather than propagated: a
 * domain rule meeting data it cannot handle is an expected outcome, and the
 * caller of a tool is an agent that has to be told why, not a stack trace.
 */
export function runTool(
  decl: ToolDecl,
  handler: ToolHandler,
  ctx: ToolContext,
): { ok: true; plan: ToolPlan } | { ok: false; problems: string[] } {
  const argProblems = validateToolArgs(decl, ctx.args);
  if (argProblems.length) return { ok: false, problems: argProblems };

  let plan: ToolPlan;
  try {
    plan = handler(ctx);
  } catch (err) {
    return { ok: false, problems: [err instanceof Error ? err.message : String(err)] };
  }

  const planProblems = validateToolPlan(decl, ctx.file, plan);
  if (planProblems.length) return { ok: false, problems: planProblems };
  return { ok: true, plan };
}
