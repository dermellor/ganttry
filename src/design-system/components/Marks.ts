import './Marks.css';
import { classes, data, el, type Attrs, type Child } from './dom';

/**
 * The small marks: a semantic glyph, a status dot, a coloured dot, a tag pill,
 * a person's monogram.
 *
 * They are grouped in one file because they are one idea — a mark stands *for*
 * something and carries no text of its own — and because they are the components
 * most likely to be rendered into an HTML string rather than mounted, which
 * means their markup has to stay small enough to read inside a template literal.
 */

export type IconOptions = {
  /** A key from `src/icons.ts`, resolved to the `--icon-<key>` glyph. */
  name: string;
  /** Chrome glyphs (`--ui-icon-<name>`) rather than the user-pickable item set. */
  chrome?: boolean;
  /** Fixed box instead of `1em`, for a mark that is not sitting in running text. */
  size?: 'sm' | 'md' | 'lg';
  /** Drop the trailing gap: a glyph alone in a button or a picker cell. */
  standalone?: boolean;
  className?: string;
  attrs?: Attrs;
};

/**
 * The glyph is a CSS mask, not an `<img>` or an inline `<svg>`: masking makes it
 * take the surrounding text colour, so one definition adapts to every lane, every
 * theme and both the light bar and the dark selected one without a second asset.
 */
export function Icon(options: IconOptions): HTMLSpanElement {
  const { name, chrome, size, standalone, className, attrs } = options;
  return el('span', {
    class: classes('ds-Icon', className),
    style: `--ds-icon:var(--${chrome ? 'ui-icon' : 'icon'}-${name})`,
    'aria-hidden': 'true',
    ...data({ size, standalone }),
    ...attrs,
  });
}

export type StatusDotOptions = {
  /** An `ITEM_STATUSES` value. Anything unknown falls back to the Open colour. */
  status?: string;
  className?: string;
  attrs?: Attrs;
};

/**
 * The status mark. The value→colour mapping lives here and nowhere else: the
 * picker in the item form and the context menu's status rows both render this
 * component, and a second copy of the mapping is how one of them ends up stale
 * after a change to the `--status-*` tokens.
 */
export function StatusDot(options: StatusDotOptions = {}): HTMLSpanElement {
  const { status, className, attrs } = options;
  return el('span', {
    class: classes('ds-StatusDot', className),
    'data-status': status,
    'aria-hidden': 'true',
    ...attrs,
  });
}

export type DotOptions = {
  /** A resolved colour: a tag's, a custom field option's. Not a token name. */
  color?: string;
  size?: 'xs' | 'sm';
  className?: string;
  attrs?: Attrs;
};

/**
 * A dot whose colour comes from the data rather than from the theme — a tag, a
 * field option. `color` is passed through as a custom property instead of being
 * written into `background` directly, so the contract check can tell a data
 * colour apart from a hardcoded one.
 */
export function Dot(options: DotOptions = {}): HTMLSpanElement {
  const { color, size = 'xs', className, attrs } = options;
  return el('span', {
    class: classes('ds-Dot', className),
    style: color ? `--ds-dot-color:${color}` : undefined,
    'aria-hidden': 'true',
    ...data({ size }),
    ...attrs,
  });
}

export type TagOptions = {
  label: string;
  color?: string;
  /** Collapses to its dot. The timeline sets this when zoomed out. */
  compact?: boolean;
  className?: string;
  attrs?: Attrs;
};

/** The coloured pill before an item's title. */
export function Tag(options: TagOptions): HTMLSpanElement {
  const { label, color, compact, className, attrs } = options;
  return el(
    'span',
    {
      class: classes('ds-Tag', className),
      style: color ? `--ds-tag-color:${color}` : undefined,
      title: label,
      ...data({ compact }),
      ...attrs,
    },
    label,
  );
}

export type AvatarOptions = {
  /** Already-computed initials. The component does not derive them. */
  initials: string;
  /** Hue from `hueFor(email)` — one person, one colour, everywhere. */
  hue: number;
  size?: 'sm' | 'md';
  /** Part of an overlapping row (the header's presence stack). */
  stacked?: boolean;
  /** Our own avatar in that stack, ringed. */
  self?: boolean;
  /** The „+3" chip that ends an overflowing stack: grey, not a person's hue. */
  overflow?: boolean;
  title?: string;
  className?: string;
  attrs?: Attrs;
};

/**
 * One person, one monogram. Shared by the presence badge, the per-item presence
 * marks, an item's owner chip and the list's owner column, so the same colleague
 * is the same colour and the same two letters wherever they turn up.
 */
export type BadgeTone = 'neutral' | 'accent' | 'muted';

export type BadgeOptions = {
  label: string;
  /** `accent` for the state that is working, `muted` for one that is not. */
  tone?: BadgeTone;
  /**
   * `sm` is the badge that rides inside a dense row rather than standing in its
   * own cell — behind a feature name in a table, where the row's own text is the
   * thing being read and the pill has to stay under it.
   */
  size?: 'sm' | 'md';
  /**
   * Uppercase, letter-spaced, bold: for a badge carrying a word the *product*
   * defines („Neu"). Deliberately not implied by `sm`, because a badge carrying a
   * **value** at the same size must not be shouted — „ab 1.0" uppercased reads as
   * an abbreviation („AB 1.0").
   */
  caps?: boolean;
  /**
   * Solid accent instead of an outline. For the one badge in a view that has to be
   * seen before the row it sits in; the fill-versus-outline contrast is what
   * separates two badges of equal size without giving one a competing hue.
   */
  filled?: boolean;
  /**
   * For a badge whose state is not known yet — the open timeline's origin before
   * its source has loaded. An empty pill reads as a value that failed to arrive,
   * so it is absent instead.
   */
  hidden?: boolean;
  className?: string;
  attrs?: Attrs;
};

/**
 * A pill carrying one word about a thing's state — a membership's status.
 *
 * Distinct from `Tag`, which is filled with a colour that comes from the *data*.
 * A badge names a state the product defines, so it is outlined and takes its
 * colour from the theme.
 */
export function Badge(options: BadgeOptions): HTMLSpanElement {
  const { label, tone = 'neutral', size = 'md', caps, filled, hidden, className, attrs } = options;
  return el(
    'span',
    {
      class: classes('ds-Badge', className),
      hidden,
      ...data({ tone, size, caps, filled }),
      ...attrs,
    },
    label,
  );
}

export type AvatarStackOptions = {
  children?: Child;
  ariaLabel?: string;
  hidden?: boolean;
  className?: string;
  attrs?: Attrs;
};

/**
 * A row of overlapping avatars — who else is looking at this timeline. The
 * overlap lives on the avatars (`stacked`), so this is only the row; that split
 * is what lets the same stack hold a single avatar without a stray offset.
 */
export function AvatarStack(options: AvatarStackOptions = {}): HTMLDivElement {
  const { children, ariaLabel, hidden, className, attrs } = options;
  return el(
    'div',
    { class: classes('ds-AvatarStack', className), 'aria-label': ariaLabel, hidden, ...attrs },
    children,
  );
}

export function Avatar(options: AvatarOptions): HTMLSpanElement {
  const { initials, hue, size = 'md', stacked, self, overflow, title, className, attrs } = options;
  return el(
    'span',
    {
      class: classes('ds-Avatar', className),
      style: `--ds-avatar-hue:${hue}`,
      title,
      'aria-hidden': 'true',
      ...data({ size, stacked, self, overflow }),
      ...attrs,
    },
    initials,
  );
}
