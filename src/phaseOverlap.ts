// Phases must never overlap in time. This is the single source of truth for
// that rule, shared by the server write path (rejects overlapping writes from
// any source — UI, MCP, direct API) and the client (form validation + drag
// clamping). Touching boundaries (one phase's end == the next's start) are NOT
// an overlap — gaps and back-to-back phases are both allowed.

import { durationToMs } from './buildItems';
import { parseLocalDay } from './date';
import type { TimelinePhase } from './types';

export type PhaseExtent = { start: number; end: number };

/**
 * Resolve a phase's [start, end] in epoch ms, or null if it has no usable
 * extent (missing start, or neither `end` nor a positive `duration`). Dates are
 * parsed as *local* midnight to match vis-timeline's own parsing (see date.ts),
 * so overlap math lines up with what the ribbon actually renders.
 */
export function resolvePhaseExtentMs(phase: TimelinePhase): PhaseExtent | null {
  if (!phase?.start) return null;
  const start = parseLocalDay(phase.start).getTime();
  if (Number.isNaN(start)) return null;
  let end: number | null = null;
  if (phase.end) {
    const e = parseLocalDay(phase.end).getTime();
    if (!Number.isNaN(e)) end = e;
  } else {
    const ms = durationToMs(phase.duration);
    if (ms && ms > 0) end = start + ms;
  }
  if (end == null || !(end > start)) return null;
  return { start, end };
}

/** Two extents overlap iff they share more than a boundary point. */
export function extentsOverlap(a: PhaseExtent, b: PhaseExtent): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * First overlapping pair of phases (by resolved extent), or null if none. Phases
 * without a resolvable extent can't overlap and are skipped. Returned in input
 * order (a before b) so callers can build a stable message.
 */
export function findPhaseOverlap(
  phases: TimelinePhase[],
): { a: TimelinePhase; b: TimelinePhase } | null {
  const resolved = phases.map((p) => ({ p, ext: resolvePhaseExtentMs(p) }));
  for (let i = 0; i < resolved.length; i++) {
    const ai = resolved[i];
    if (!ai.ext) continue;
    for (let j = i + 1; j < resolved.length; j++) {
      const bj = resolved[j];
      if (!bj.ext) continue;
      if (extentsOverlap(ai.ext, bj.ext)) return { a: ai.p, b: bj.p };
    }
  }
  return null;
}

/** Human-readable reason for a rejected write / blocked save. */
export function describePhaseOverlap(a: TimelinePhase, b: TimelinePhase): string {
  return `Phasen dürfen sich nicht überlappen: „${a.label}" und „${b.label}".`;
}

/**
 * The widest [minStart, maxEnd] window a phase may occupy without overlapping
 * any of the `others`, given its *current* position (used to classify each other
 * phase as lying to the left or right). Returns ±Infinity where there is no
 * neighbour on that side. Drives client drag/resize clamping so a phase can't be
 * dragged across a neighbour. `others` must exclude the phase being moved.
 */
export function phaseGapBounds(
  others: TimelinePhase[],
  origStart: number,
  origEnd: number,
): { minStart: number; maxEnd: number } {
  let minStart = -Infinity;
  let maxEnd = Infinity;
  for (const o of others) {
    const ext = resolvePhaseExtentMs(o);
    if (!ext) continue;
    if (ext.end <= origStart) minStart = Math.max(minStart, ext.end);
    else if (ext.start >= origEnd) maxEnd = Math.min(maxEnd, ext.start);
  }
  return { minStart, maxEnd };
}
