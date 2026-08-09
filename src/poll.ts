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
//
// pv/pn cover the plugin-owned rows. They are optional, and comparing them with
// `!==` handles that correctly on its own: a source that has no plugin rows omits
// both, so two such reads compare undefined to undefined. A source that gains its
// first plugin row goes from undefined to a number, which is the change it should
// be. The one case a value pair cannot see — a row deleted and another inserted
// between two polls, leaving the count identical — is covered by `t`, which every
// write moves.
export function watermarkChanged(a: Watermark, b: Watermark): boolean {
  return a.v !== b.v || a.n !== b.n || a.t !== b.t || a.pv !== b.pv || a.pn !== b.pn;
}
