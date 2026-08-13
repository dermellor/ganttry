import { parseLocalDay } from './date';
import { decodeFilterSelection, encodeFilterSelection, FILTER_PARAM } from './filterParam';
import type { FilterSelection } from './filterRule';

export type UrlState = {
  view?: string;
  item?: string;
  from?: string;
  to?: string;
  milestones?: boolean;
  // Kept as a raw string on purpose: a plugin view mode is `plugin:<id>:<view>`,
  // and this module stays free of the registry that knows which of those exist.
  // The caller normalises (see readViewMode) and drops what does not resolve.
  mode?: string;
  // Which section of the settings area is open; absent means the area is closed.
  // Raw like `mode`, and for the same reason: the sections are a property of the
  // area, not of the URL grammar. `settingsSection` normalises.
  //
  // The rest of the state stays in the hash while the area is open, so closing
  // it returns to the timeline the operator left rather than to the default view.
  settings?: string;
  // Which section of the OPEN TIMELINE's settings is showing. A second key rather
  // than a value of `settings`, because the two are different levels: one is the
  // deployment, one is this document (see docs/information-architecture.md). Only
  // one of them is ever set — both areas replace the content, so opening one closes
  // the other.
  timelineSettings?: string;
  /**
   * The saved view a link applies (`sv=<id>`), raw like `mode`: which ids exist is
   * a property of the timeline being opened, and this module never loads one. An
   * id the timeline does not have is dropped rather than refused — a link outliving
   * a deleted view has to open the timeline, not fail.
   */
  savedView?: string;
  /**
   * The filter selection (`f=status:Open,Done`), the other half of the extent beside
   * `from`/`to`. Absent means the link says nothing about the narrowing, which the two
   * entry points read differently — see „URL state" (docs/editing.md).
   */
  filters?: FilterSelection;
};

const ORDER = [
  'view',
  'item',
  'from',
  'to',
  'm',
  'mode',
  FILTER_PARAM,
  'sv',
  'settings',
  'timeline-settings',
] as const;

/**
 * Keys whose value is written into the hash exactly as the caller built it.
 *
 * `f` carries its own percent-encoding per dimension and per value, with the
 * separators left literal (see filterParam.ts). Encoding it again would escape those
 * separators and turn a legible link into a wall of `%3A`.
 */
const PRE_ENCODED = new Set<string>([FILTER_PARAM]);

function parseHash(hash: string): URLSearchParams {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  return new URLSearchParams(h);
}

/**
 * One parameter as it literally stands in the hash, undecoded.
 *
 * `URLSearchParams` decodes percent-escapes before a caller can split on anything,
 * so a filter value containing a comma would arrive as two values and one containing
 * a `+` as a space. Only `f` needs this; everything else is a single opaque value
 * that the standard parser handles correctly.
 */
function rawParam(hash: string, key: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of h.split('&')) {
    if (part.startsWith(`${key}=`)) return part.slice(key.length + 1);
  }
  return null;
}

export function readUrlState(): UrlState {
  const p = parseHash(location.hash);
  const state: UrlState = {};
  const view = p.get('view');
  if (view) state.view = view;
  const item = p.get('item');
  if (item) state.item = item;
  const from = p.get('from');
  if (from) state.from = from;
  const to = p.get('to');
  if (to) state.to = to;
  if (p.get('m') === '1') state.milestones = true;
  const mode = p.get('mode');
  if (mode) state.mode = mode;
  const savedView = p.get('sv');
  if (savedView) state.savedView = savedView;
  // Out of the raw hash, and only set when the parameter is actually there: an absent
  // key has to stay distinguishable from „narrows nothing", because the two mean
  // different things on the two entry points.
  const rawFilters = rawParam(location.hash, FILTER_PARAM);
  if (rawFilters != null) state.filters = decodeFilterSelection(rawFilters);
  const settings = p.get('settings');
  // A bare `#settings` (no `=`) opens the area on its first section. URLSearchParams
  // reads that as an empty string, which is a *present* key — distinguishing it
  // from an absent one is what makes the short link work.
  if (settings != null) state.settings = settings;
  const tlSettings = p.get('timeline-settings');
  if (tlSettings != null) state.timelineSettings = tlSettings;
  return state;
}

/**
 * The `from`/`to` pair as a timeline window, or null when it is absent or
 * unparseable.
 *
 * Goes through `parseLocalDay` rather than `new Date`, because the hash carries
 * the same "YYYY-MM-DD" calendar day everything else stores (syncUrl writes it
 * with `isoDateOnly`) and a bare day string parses as **UTC** midnight in the
 * native constructor. That opened a deep-linked window one timezone offset off
 * the local-midnight days vis-timeline places items on. The error does not
 * accumulate over a share → open → share loop (the write side collapses back to a
 * calendar day), and on a months-wide window it is invisible; what it does do is
 * contradict the single convention `src/date.ts` exists to hold, which is how a
 * zoomed-in window ends up a day off its items.
 *
 * Both entry points (bootstrap and the hashchange handler) read the window here
 * so the rule cannot be fixed in one of them and left broken in the other, which
 * is how it got two copies in the first place. Anything carrying a time
 * component still falls through to the native constructor, so a link shared with
 * a full ISO timestamp keeps resolving to the same instant it always did.
 */
export function parseUrlWindow(state: UrlState): { start: Date; end: Date } | null {
  if (!state.from || !state.to) return null;
  const start = parseLocalDay(state.from);
  const end = parseLocalDay(state.to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end };
}

function buildHash(state: UrlState): string {
  const map: Record<string, string> = {};
  if (state.view) map.view = state.view;
  if (state.item) map.item = state.item;
  if (state.from) map.from = state.from;
  if (state.to) map.to = state.to;
  // `m` is read but never written: „nur Meilensteine" is a value of the filter's
  // type dimension, and the whole selection now travels as `f`. Writing both would
  // put the same narrowing in the hash twice, in two grammars. `UrlState.milestones`
  // therefore only ever arrives from outside, out of a link that predates `f`.
  if (state.milestones) map.m = '1';
  // 'timeline' is the default and stays out of the hash, so a plain link keeps
  // looking plain. Everything else (list, or a plugin view) is written verbatim.
  if (state.mode && state.mode !== 'timeline') map.mode = state.mode;
  // Written only while a saved view is applied, so a plain link stays plain. It
  // carries the whole extent under one short key, which is what the filter itself
  // has never done (see „URL state" in docs/editing.md).
  if (state.savedView) map.sv = state.savedView;
  // Written only while something is narrowed, the rule `mode` and `sv` follow: a
  // parameter on every link would say „this is a narrowed view" about the plain one.
  if (state.filters) {
    const encoded = encodeFilterSelection(state.filters);
    if (encoded) map[FILTER_PARAM] = encoded;
  }
  if (state.settings) map.settings = state.settings;
  if (state.timelineSettings) map['timeline-settings'] = state.timelineSettings;
  return ORDER.flatMap((k) =>
    map[k] != null
      ? [`${encodeURIComponent(k)}=${PRE_ENCODED.has(k) ? map[k] : encodeURIComponent(map[k])}`]
      : [],
  ).join('&');
}

let lastWrittenHash = '';

export function writeUrlState(next: UrlState, options: { replace?: boolean } = {}): void {
  const hash = buildHash(next);
  const current = location.hash.replace(/^#/, '');
  if (current === hash) {
    lastWrittenHash = hash;
    return;
  }
  lastWrittenHash = hash;
  const url = `${location.pathname}${location.search}${hash ? '#' + hash : ''}`;
  if (options.replace ?? true) {
    history.replaceState(null, '', url);
  } else {
    history.pushState(null, '', url);
  }
}

export function onExternalUrlStateChange(handler: (state: UrlState) => void): () => void {
  const listener = () => {
    const current = location.hash.replace(/^#/, '');
    if (current === lastWrittenHash) return;
    lastWrittenHash = current;
    handler(readUrlState());
  };
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}
