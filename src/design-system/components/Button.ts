import './Button.css';
import { classes, data, el, on, type Attrs, type Child, type Listeners } from './dom';

/**
 * The viewer had seven button treatments before this component, in five
 * stylesheets: the accent action, its outlined sibling, the ghost icon, the
 * destructive one, the underlined footer link, the dashed „add another row",
 * and the bordered dropdown trigger. They are the seven variants below. If a
 * new surface needs an eighth, it is a variant here — a one-off rule at the
 * call site is what the contract forbids, because that is how „the same button"
 * ends up with three different radii.
 */
export type ButtonVariant =
  /** The one action a surface is really about. Accent fill. */
  | 'primary'
  /** An action of equal standing that must not compete: accent on a bordered surface. */
  | 'outline'
  /** Chrome. No fill, no border, until hovered. */
  | 'ghost'
  /** Destructive. Muted until hovered, then red — the colour is the confirmation. */
  | 'danger'
  /** An action that reads as text: the footer's export, an inline link. */
  | 'link'
  /** „Add another one" under a repeatable row. Dashed, so it reads as a slot. */
  | 'dashed'
  /** Opens something anchored to itself. Carries the caret and the expanded state. */
  | 'trigger';

export type ButtonSize = 'sm' | 'md';

export type ButtonOptions = {
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading slot: a glyph node. Renders alone when there is no label. */
  icon?: Element;
  /** `type` on the element. Defaults to `button`, never the form-submitting default. */
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  title?: string;
  /** Sets both `aria-label` and `title` — an icon-only button needs both. */
  ariaLabel?: string;
  /** Hidden until its container is hovered (the list's per-group „+ Eintrag"). */
  reveal?: boolean;
  /** Stretches to the width of its container instead of hugging its label. */
  block?: boolean;
  className?: string;
  attrs?: Attrs;
  on?: Listeners;
};

export function Button(options: ButtonOptions = {}): HTMLButtonElement {
  const {
    label,
    variant = 'primary',
    size = 'md',
    icon,
    type = 'button',
    disabled,
    title,
    ariaLabel,
    reveal,
    block,
    className,
    attrs,
    on: listeners,
  } = options;

  const iconOnly = !!icon && !label;
  const node = el(
    'button',
    {
      type,
      class: classes('ds-Button', className),
      disabled,
      title: title ?? ariaLabel,
      'aria-label': ariaLabel,
      ...data({ variant, size, 'icon-only': iconOnly, reveal, block }),
      ...attrs,
    },
    [
      icon && el('span', { class: 'ds-Button-icon', 'aria-hidden': 'true' }, icon),
      label != null && el('span', { class: 'ds-Button-label' }, label),
    ],
  );
  on(node, listeners);
  return node;
}

export type IconButtonOptions = Omit<ButtonOptions, 'label' | 'icon' | 'block'> & {
  icon: Element | string;
  /** Required: an icon alone tells a screen reader nothing. */
  ariaLabel: string;
  /** `sm` 28px, `md` 30px, `lg` 32px — the three control heights. */
  boxSize?: 'sm' | 'md' | 'lg';
};

/**
 * A square button whose whole content is one mark. Separate from `Button`
 * because the sizing is a control *box* (28/30/32px, the tokens that keep the
 * detail panel's header row level) rather than padding around a label.
 */
export function IconButton(options: IconButtonOptions): HTMLButtonElement {
  const { icon, ariaLabel, boxSize = 'md', variant = 'ghost', className, attrs, ...rest } = options;
  const node = Button({
    ...rest,
    variant,
    ariaLabel,
    className: classes('ds-IconButton', className),
    attrs: { ...data({ box: boxSize }), ...attrs },
    icon: typeof icon === 'string' ? el('span', { class: 'ds-IconButton-glyph' }, icon) : icon,
  });
  return node;
}

/** The children of a `<span>`-wrapped label, for a button that needs markup. */
export function buttonLabel(children: Child): HTMLSpanElement {
  return el('span', { class: 'ds-Button-label' }, children);
}
