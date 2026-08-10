import { parseLocalDay } from './date';

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
};

const ORDER = ['view', 'item', 'from', 'to', 'm', 'mode', 'settings'] as const;

function parseHash(hash: string): URLSearchParams {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  return new URLSearchParams(h);
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
  const settings = p.get('settings');
  // A bare `#settings` (no `=`) opens the area on its first section. URLSearchParams
  // reads that as an empty string, which is a *present* key — distinguishing it
  // from an absent one is what makes the short link work.
  if (settings != null) state.settings = settings;
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
  if (state.milestones) map.m = '1';
  // 'timeline' is the default and stays out of the hash, so a plain link keeps
  // looking plain. Everything else (list, or a plugin view) is written verbatim.
  if (state.mode && state.mode !== 'timeline') map.mode = state.mode;
  if (state.settings) map.settings = state.settings;
  return ORDER.flatMap((k) =>
    map[k] != null ? [`${encodeURIComponent(k)}=${encodeURIComponent(map[k])}`] : [],
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
