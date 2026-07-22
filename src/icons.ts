// Curated, brand-agnostic icon set.
//
// An item stores only a *semantic* key (what the icon means, not how it looks).
// Each brand resolves that key to its own icon set's glyph via a `--icon-<key>`
// CSS custom property (see src/styles/icons.css). This keeps the data portable
// across brands and round-trips cleanly through the DB, editor and exports.
//
// The base glyphs (in icons.css `:root`) are Acme neo-icons; a brand can
// override any key with `[data-brand='…'] { --icon-<key>: url(…) }`.

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

// The `<span>` prepended to an item's content at render time. Empty string when
// no valid icon, so it is safe to always concatenate.
export function iconSpanHtml(value: unknown): string {
  const key = normalizeIcon(value);
  if (!key) return '';
  return `<span class="item-icon" style="--item-icon:var(--icon-${key})"></span>`;
}
