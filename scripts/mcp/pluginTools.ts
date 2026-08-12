// Exposing the verbs plugins contribute as MCP tools.
//
// Written for both servers that speak MCP — the local stdio one (./server.ts,
// which rewrites a whole timeline file) and the remote one
// (netlify/functions/mcp.ts, which goes through the dispatcher). The assembling,
// the argument shape and the checking live here rather than in two hand-kept
// copies; only *applying* a plan differs, because the two have different write
// paths, and that is the part each server keeps.
//
// **Only the local server registers these today, and the reason is bundling.**
// The list comes from the client registry, whose descriptors carry
// `load: () => import('./index')` — the edge into a plugin's view chunk. Under
// tsx that expression is never evaluated, so the stdio server never reaches it.
// A serverless function is *bundled*, and a bundler follows the dynamic import
// statically, into a module whose first line imports a stylesheet that no
// function bundler has a loader for. Fixing it means an enumeration of in-tree
// plugins that carries no view edge, which is a seam change rather than a
// registration line, and it is the same enumeration #14's loader removes. Until
// then a remote agent has the generic tools only.
//
// What a plugin supplies is a pure function (src/pluginHost/tools.ts). Nothing in
// this module lets it reach the database, the network or the clock: it is handed a
// timeline, arguments and today's date, and it returns changes the server applies.

import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import type { TimelineFile } from '../../src/types.ts';
import type { ToolDecl } from '../../src/pluginHost/manifest.ts';
import { pluginTools, type ToolProblem } from '../../src/pluginHost/registry.ts';
import { runTool, type ItemChange, type ToolPlan } from '../../src/pluginHost/tools.ts';

/**
 * The timeline id every tool takes. Reserved as an argument name, which is why a
 * plugin declaring a property of this name makes its manifest invalid: a tool
 * always runs against one timeline, and the host supplies it.
 */
const TIMELINE_ARG = 'id';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A zod type for one declared property.
 *
 * **Never stricter than the declared schema.** This layer exists so an agent sees
 * the shape of an argument before calling; the enforcement is `validateToolArgs`,
 * which applies the manifest's schema itself. Anything this converter cannot
 * express becomes `z.unknown()` rather than a guess, because a zod type that
 * rejects more than the schema does turns a valid call into an error the plugin
 * author cannot find in their own manifest.
 *
 * Objects pass unknown keys through for the same reason inverted: a stripped key
 * is one `additionalProperties: false` would have rejected, and the rejection has
 * to survive long enough for `validateToolArgs` to make it.
 */
function zodFor(schema: unknown): ZodTypeAny {
  if (!isPlainObject(schema)) return z.unknown();
  const describe = (t: ZodTypeAny) =>
    typeof schema.description === 'string' ? t.describe(schema.description) : t;

  if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === 'string')) {
    const values = schema.enum as string[];
    // z.enum needs a non-empty tuple; an empty one is a schema that permits
    // nothing, and z.never() would be stricter than the declaration only in the
    // sense that both reject everything.
    if (values.length) return describe(z.enum(values as [string, ...string[]]));
  }

  const declared = Array.isArray(schema.type) ? schema.type : schema.type == null ? [] : [schema.type];
  // A union of types is expressible but rarely worth it here, and getting it
  // wrong costs a false rejection. One declared type is the case that matters.
  if (declared.length !== 1) return describe(z.unknown());

  switch (declared[0]) {
    case 'string':
      return describe(z.string());
    case 'integer':
      return describe(z.number().int());
    case 'number':
      return describe(z.number());
    case 'boolean':
      return describe(z.boolean());
    case 'null':
      return describe(z.null());
    case 'array':
      return describe(z.array(zodFor(schema.items ?? {})));
    case 'object': {
      const props = isPlainObject(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const shape: ZodRawShape = {};
      for (const [name, sub] of Object.entries(props)) {
        const t = zodFor(sub);
        shape[name] = required.has(name) ? t : t.optional();
      }
      return describe(z.object(shape).passthrough());
    }
    default:
      return describe(z.unknown());
  }
}

/**
 * The argument shape an MCP server registers: the timeline id plus the tool's own
 * declared properties, flat.
 *
 * Flat rather than nested under an `args` object because that is what an agent
 * calls well: every other tool on these servers takes its arguments at the top
 * level, and one tool family with a different convention gets called wrongly.
 *
 * One consequence worth knowing: the transport parses against this shape and
 * drops top-level keys it does not know, so `additionalProperties: false` on the
 * *root* of an `inputSchema` cannot be enforced on this path. Every constraint on
 * a declared property still is.
 */
export function toolArgShape(decl: ToolDecl): ZodRawShape {
  const shape: ZodRawShape = {
    [TIMELINE_ARG]: z.string().describe('Timeline id from list_timelines.'),
  };
  const schema = decl.inputSchema;
  if (!isPlainObject(schema)) return shape;
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [name, sub] of Object.entries(props)) {
    if (name === TIMELINE_ARG) continue; // refused by the manifest check; belt and braces
    const t = zodFor(sub);
    shape[name] = required.has(name) ? t : t.optional();
  }
  return shape;
}

/** Today as `YYYY-MM-DD` in the server's own timezone. */
export function today(clock: Date = new Date()): string {
  const y = clock.getFullYear();
  const m = String(clock.getMonth() + 1).padStart(2, '0');
  const d = String(clock.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** What a server needs to expose one plugin tool. */
export type McpPluginTool = {
  pluginId: string;
  decl: ToolDecl;
  /** Argument shape for `registerTool`, including the timeline id. */
  shape: ZodRawShape;
  /**
   * Run the rule against a timeline. Throws with every problem when the arguments
   * or the returned plan do not hold, so a server's tool handler can let it
   * propagate: the MCP layer turns a thrown error into the agent's answer.
   */
  plan(file: TimelineFile, args: Record<string, unknown>, now?: string): ToolPlan;
};

/**
 * Every plugin tool an MCP server should expose, plus the ones it cannot.
 *
 * The problems are returned rather than logged here because the two servers
 * report differently: the stdio one writes to stderr, the function has no
 * console a user reads. Both have to say something — a verb that silently is not
 * there is indistinguishable from a plugin that was never installed.
 */
export function mcpPluginTools(): { tools: McpPluginTool[]; problems: ToolProblem[] } {
  const { tools, problems } = pluginTools();
  return {
    problems,
    tools: tools.map(({ pluginId, decl, run }) => ({
      pluginId,
      decl,
      shape: toolArgShape(decl),
      plan(file, args, now) {
        const config = file.plugins?.find((p) => p.id === pluginId)?.config ?? {};
        const result = runTool(decl, run, { file, config, args, now: now ?? today() });
        if (!result.ok) throw new Error(`${decl.name}: ${result.problems.join('; ')}`);
        return result.plan;
      },
    })),
  };
}

/** The changes in a plan, split by what a write path has to do with them. */
export function splitChanges(plan: ToolPlan): {
  updates: Array<{ itemId: string; patch: Record<string, unknown> }>;
  adds: Array<Record<string, unknown>>;
} {
  const updates: Array<{ itemId: string; patch: Record<string, unknown> }> = [];
  const adds: Array<Record<string, unknown>> = [];
  for (const change of plan.changes ?? ([] as ItemChange[])) {
    if (change.op === 'update') updates.push({ itemId: change.itemId, patch: change.patch as Record<string, unknown> });
    else adds.push(change.item as Record<string, unknown>);
  }
  return { updates, adds };
}

/**
 * What a tool call answers with.
 *
 * `notes` comes first because for a tool that changes nothing it is the whole
 * result, and an agent that has to relay „the fourth deadline was already past"
 * should not have to dig it out from under a count.
 */
export function toolResult(plan: ToolPlan, applied: { updated: number; added: number }) {
  return {
    ok: true,
    notes: plan.notes ?? [],
    updated: applied.updated,
    added: applied.added,
  };
}
