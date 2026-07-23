// Pure decision logic for the polling live-update implementation. Kept free of
// vite (`import.meta.env`) and supabase deps so it runs under `node --test`; the
// fetch/DOM/timer machinery lives in realtime.ts (`pollTimeline`).

import type { Watermark } from './types';

// Poll cadence. A visible tab polls briskly; a hidden one backs off hard (the
// user isn't watching, and any missed change is caught on the next visible tick
// or on focus). Deliberately inside the issue's ~5–15 s visible band.
export const POLL_INTERVAL_VISIBLE_MS = 8_000;
export const POLL_INTERVAL_HIDDEN_MS = 60_000;

export function nextPollDelay(hidden: boolean): number {
  return hidden ? POLL_INTERVAL_HIDDEN_MS : POLL_INTERVAL_VISIBLE_MS;
}

// True when two reads differ in any tracked dimension — i.e. something changed
// server-side and the client should reload. A field-wise compare (not deep
// JSON) keeps it explicit about what counts as a change.
export function watermarkChanged(a: Watermark, b: Watermark): boolean {
  return a.v !== b.v || a.n !== b.n || a.t !== b.t;
}
