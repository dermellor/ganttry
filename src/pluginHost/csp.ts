// The Content-Security-Policy this deploy ships.
//
// Plugins run in the app's own realm (docs/plugin-isolation.md), so nothing here
// stops a plugin reading the page. What it does stop is the part that turns a
// hostile plugin into a breach: getting the data OUT. `connect-src 'self'` means
// a plugin's `fetch` to somewhere else fails, and `img-src`/`form-action` close
// the two obvious ways around that.
//
// Be clear about the limit: this is a barrier, not a proof. A determined plugin
// can still navigate the top-level window to a URL carrying data, which no CSP
// directive prevents. What the policy buys is that exfiltration stops being three
// lines of code and becomes something conspicuous — and conspicuous is what makes
// review, and the integrity pin that keeps a reviewed artifact from changing,
// worth anything.
//
// Pure so the policy can be asserted in a test rather than eyeballed in a header.

export type CspInput = {
  /** The Supabase origin the browser opens a realtime socket to, if any. */
  supabaseUrl?: string;
  /** Origins the operator allows plugin code to be loaded from and talk to. */
  pluginOrigins?: string[];
  /** The JIRA base URL, when the issue picker is wired up. */
  jiraUrl?: string;
};

/** An origin from a URL, or null when it is not one. Never throws. */
export function originOf(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * A realtime socket is `wss://` against the same host the API is on. It has to be
 * listed separately: `connect-src` matches on scheme too, so an `https://` origin
 * does not cover the WebSocket that Supabase Realtime opens to it.
 */
function socketOrigin(origin: string): string | null {
  if (origin.startsWith('https://')) return `wss://${origin.slice('https://'.length)}`;
  if (origin.startsWith('http://')) return `ws://${origin.slice('http://'.length)}`;
  return null;
}

const uniq = (values: (string | null | undefined)[]): string[] => [
  ...new Set(values.filter((v): v is string => !!v)),
];

/**
 * Build the policy.
 *
 * Defaults are closed: with nothing configured the page may load and talk to
 * itself and nothing else. Every widening is something an operator asked for.
 */
export function buildCsp(input: CspInput = {}): string {
  const plugins = uniq((input.pluginOrigins ?? []).map((o) => originOf(o)));
  const supabase = originOf(input.supabaseUrl);
  const jira = originOf(input.jiraUrl);

  const connect = uniq([
    "'self'",
    supabase,
    supabase ? socketOrigin(supabase) : null,
    jira,
    ...plugins,
  ]);

  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    // `blob:` is what lets the loader execute the bytes it verified instead of
    // importing the URL a second time, where the server could answer differently
    // (see src/pluginHost/loader.ts). It is the narrower of the two risks, and it
    // is the first line a security review should ask about.
    ['script-src', uniq(["'self'", 'blob:', ...plugins])],
    // vis-timeline and the item renderers write inline styles, and the pricing
    // view builds HTML strings that carry them. Removing this means auditing
    // every one of those first; it is a real weakening and it is not a plugin
    // concession — the app needs it as it stands today.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:']],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', connect],
    // The part that matters for a same-realm plugin: no other destination for
    // data. A form posting elsewhere is exfiltration with extra steps.
    ['form-action', ["'self'"]],
    ['base-uri', ["'self'"]],
    ['object-src', ["'none'"]],
    // Nothing embeds this app, so nothing can frame it into a clickjack. Also the
    // directive that would have to change the day the sandbox decision is
    // revisited, since a plugin frame needs `frame-src`.
    ['frame-src', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/** Parse the operator's comma-separated allowlist. Empty when unset. */
export function parseOrigins(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
