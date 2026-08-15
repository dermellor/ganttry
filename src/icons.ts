// Curated, semantic icon set.
//
// An item stores only a *semantic* key (what the icon means, not how it looks).
// Each key resolves to a glyph via a `--icon-<key>` CSS custom property. This
// keeps the data portable and round-trips cleanly through the DB, editor and
// exports.
//
// The base glyphs live in `src/design-system/tokens/icons.css`; override any key
// in your own stylesheet with `:root { --icon-<key>: url(…) }`. How one is drawn
// is the `Icon` component's business, not this module's — here it is only the
// vocabulary and the guard that keeps a stored value out of a CSS var name.

import { html, Icon } from './design-system';
import { t } from './i18n';

export type IconKey =
  | 'milestone'
  | 'launch'
  | 'done'
  | 'warning'
  | 'blocked'
  | 'review'
  | 'deadline'
  | 'meeting'
  | 'idea'
  | 'research'
  | 'design'
  | 'build'
  | 'bug'
  | 'release'
  | 'decision'
  | 'goal'
  | 'info'
  | 'note';

// The vocabulary, in the order the picker offers it. Keys only: an icon's *label*
// follows the reader's language and therefore cannot be a constant here — a
// `{ key, label }` table evaluated on import freezes whichever language was in
// force at boot, which is what „Never call t() at module scope" (src/i18n/index.ts)
// is about. Ask `iconLabel` for the word instead.
export const TIMELINE_ICON_KEYS: readonly IconKey[] = [
  'milestone',
  'launch',
  'done',
  'warning',
  'blocked',
  'review',
  'deadline',
  'meeting',
  'idea',
  'research',
  'design',
  'build',
  'bug',
  'release',
  'decision',
  'goal',
  'info',
  'note',
];

/** What the picker calls an icon, in the language in force. */
export function iconLabel(key: IconKey): string {
  return t(`icon.${key}`);
}

/** The picker's rows, resolved at call time so the labels follow the language. */
export function timelineIcons(): { key: IconKey; label: string }[] {
  return TIMELINE_ICON_KEYS.map((key) => ({ key, label: iconLabel(key) }));
}

const ICON_KEYS = new Set<string>(TIMELINE_ICON_KEYS);

// Accepts a stored icon value and returns a valid key or undefined. Guards the
// value before it lands in a CSS var name / HTML attribute.
export function normalizeIcon(value: unknown): IconKey | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return ICON_KEYS.has(v) ? (v as IconKey) : undefined;
}

// The glyph prepended to an item's content at render time, as markup: this feeds
// vis-timeline, which takes a string per item. Empty string when there is no
// valid icon, so it is safe to always concatenate.
export function iconSpanHtml(value: unknown): string {
  const key = normalizeIcon(value);
  if (!key) return '';
  return html(Icon({ name: key }));
}
