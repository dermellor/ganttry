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

// key -> German label for the editor dropdown
export const TIMELINE_ICONS: { key: IconKey; label: string }[] = [
  { key: 'milestone', label: 'Meilenstein' },
  { key: 'launch', label: 'Launch' },
  { key: 'done', label: 'Erledigt' },
  { key: 'warning', label: 'Warnung' },
  { key: 'blocked', label: 'Blockiert' },
  { key: 'review', label: 'Review' },
  { key: 'deadline', label: 'Deadline' },
  { key: 'meeting', label: 'Meeting' },
  { key: 'idea', label: 'Idee' },
  { key: 'research', label: 'Research' },
  { key: 'design', label: 'Design' },
  { key: 'build', label: 'Build' },
  { key: 'bug', label: 'Bug' },
  { key: 'release', label: 'Release' },
  { key: 'decision', label: 'Entscheidung' },
  { key: 'goal', label: 'Ziel' },
  { key: 'info', label: 'Info' },
  { key: 'note', label: 'Notiz' },
];

const ICON_KEYS = new Set<string>(TIMELINE_ICONS.map((i) => i.key));

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
