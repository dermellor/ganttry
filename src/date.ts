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
