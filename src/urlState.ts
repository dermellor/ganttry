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
};

const ORDER = ['view', 'item', 'from', 'to', 'm', 'mode'] as const;

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
  return state;
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
