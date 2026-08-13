// Canonical date handling for the timeline.
//
// The app deals in *calendar days*, stored as plain "YYYY-MM-DD" strings. The
// one representation boundary that keeps biting is Date ⇄ string: vis-timeline
// parses stored day strings as **local midnight** and hands us local Dates back
// from drags/resizes, so we must read those Dates in **local** time too.
// Slicing `toISOString()` (UTC) instead shifts the day back by the timezone
// offset in any UTC+ zone (e.g. CEST) — which silently stored every edit one day
// too early and made right-edge resizes drag the left edge along. Do all Date→day
// conversion through `isoDateOnly` so that bug can only ever live in one place.

// Calendar day of a Date from its *local* components (never UTC).
function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Inverse of `isoDateOnly` for the string→Date boundary: parse a stored day the
// same way vis-timeline does — a bare "YYYY-MM-DD" is **local midnight**, not
// UTC. `new Date("2026-10-15")` would parse as UTC midnight and land the value
// up to a timezone offset away from where vis places the matching item, so any
// hand-rolled time→pixel mapping (e.g. the phase ribbon) must go through here to
// stay pixel-aligned with vis. Values carrying a time component, and Date/number
// inputs, pass through the native Date constructor unchanged.
export function parseLocalDay(value: Date | number | string): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(value);
}

// Shift a calendar day by whole days, staying in local time. Goes through
// parseLocalDay/localDay for the same reason everything else here does: doing the
// arithmetic on a UTC-parsed Date would land the result a day off in any UTC+
// zone. Used for the item form's date bounds — an end must be at least the day
// after its start (see src/itemExtent.ts).
export function shiftDays(day: string, days: number): string {
  const d = parseLocalDay(day);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return localDay(d);
}

/**
 * Add a duration (ms) to a start date and return an end string in the SAME
 * calendar frame as the start. Bare `YYYY-MM-DD` starts are interpreted as
 * LOCAL midnight — the way vis-timeline reads bare dates in the viewer — and the
 * result is emitted WITHOUT a `Z`, so it is parsed back in that same local
 * frame. Using `new Date(start).getTime()` + `.toISOString()` here (UTC, with a
 * trailing `Z`) instead makes a duration-derived end land TZ-offset hours past a
 * neighbouring item's local-midnight `start`: in CET/CEST that's 1–2h, so two
 * back-to-back bars overlap by ~8px and read as "touching" at high zoom.
 */
export function endFromDuration(start: string, ms: number): string | null {
  const base = new Date(
    typeof start === 'string' && start.length === 10 ? `${start}T00:00:00` : start,
  );
  const t = base.getTime();
  if (Number.isNaN(t)) return null;
  const d = new Date(t + ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return time === '00:00:00' ? date : `${date}T${time}`;
}

// Duration parsing lives here (with the other pure date maths) rather than in
// buildItems so the server write path — reachable from the Deno edge bundle via
// phaseOverlap — can parse a phase/item `duration` without dragging the heavy,
// client-oriented buildItems graph (filter, icons, …) into the edge function.
const DURATION_RE = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/;

// Parse a `duration` value ("7d", "2w", "90m", ISO-ish "Nh|d|w|mo|y", or a raw
// number of ms) into milliseconds. Returns null for empty/unparseable input or
// a non-positive result.
export function durationToMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  const m = s.match(DURATION_RE);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const map: Record<string, number> = {
    ms: 1, s: 1000, m: 60000, min: 60000, h: 3600000, hr: 3600000,
    d: 86400000, day: 86400000, w: 604800000, wk: 604800000,
    mo: 2592000000, month: 2592000000, y: 31536000000, year: 31536000000,
  };
  return n * (map[unit] ?? 0) || null;
}

// Normalises any date-ish value to a "YYYY-MM-DD" calendar day. Date/number
// inputs are read in local time (see module note); a string already in
// YYYY-MM-DD form is returned as-is (it's already a calendar day).
export function isoDateOnly(value: Date | string | number | null | undefined): string {
  if (value == null) return '';
  if (value instanceof Date) return localDay(value);
  if (typeof value === 'number') return localDay(new Date(value));
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return localDay(d);
  }
  return '';
}
