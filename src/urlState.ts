export type UrlState = {
  view?: string;
  item?: string;
  from?: string;
  to?: string;
  milestones?: boolean;
  brand?: string;
  mode?: 'timeline' | 'list';
};

const ORDER = ['view', 'item', 'from', 'to', 'm', 'brand', 'mode'] as const;

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
  const brand = p.get('brand');
  if (brand) state.brand = brand;
  const mode = p.get('mode');
  if (mode === 'list' || mode === 'timeline') state.mode = mode;
  return state;
}

function buildHash(state: UrlState): string {
  const map: Record<string, string> = {};
  if (state.view) map.view = state.view;
  if (state.item) map.item = state.item;
  if (state.from) map.from = state.from;
  if (state.to) map.to = state.to;
  if (state.milestones) map.m = '1';
  if (state.brand) map.brand = state.brand;
  if (state.mode === 'list') map.mode = state.mode;
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
