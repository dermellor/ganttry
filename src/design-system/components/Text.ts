import './Text.css';
import { classes, data, el, type Attrs, type Child } from './dom';

/**
 * The typographic voices the viewer actually has, as three components. There
 * are only three because the interface only says three kinds of thing: a
 * headline in the serif face, body copy, and the uppercase micro-caption that
 * labels a control or a table column.
 */

export type HeadingLevel = 1 | 2 | 3;

export type HeadingOptions = {
  level?: HeadingLevel;
  text?: string;
  children?: Child;
  /** Renders the headline as an editable surface (the detail panel's title). */
  editable?: boolean;
  className?: string;
  attrs?: Attrs;
};

/**
 * The serif voice. Its weight comes from `--headline-weight` rather than being
 * hardcoded, because a theme that swaps `--font-headline` for a sans face
 * almost always has to move the weight with it.
 */
export function Heading(options: HeadingOptions = {}): HTMLHeadingElement {
  const { level = 2, text, children, editable, className, attrs } = options;
  return el(
    `h${level}` as 'h1' | 'h2' | 'h3',
    {
      class: classes('ds-Heading', className),
      ...data({ level }),
      contenteditable: editable ? 'true' : undefined,
      ...attrs,
    },
    children ?? text,
  );
}

export type TextTone = 'default' | 'muted' | 'danger' | 'accent';
export type TextSize = 'xs' | 'sm' | 'md' | 'base';

export type TextOptions = {
  as?: 'span' | 'p' | 'div' | 'small';
  text?: string;
  children?: Child;
  tone?: TextTone;
  size?: TextSize;
  /** Clips to one line with an ellipsis. Needs a bounded width to do anything. */
  truncate?: boolean;
  /** „No value here", rendered in the italic voice the viewer uses for that. */
  placeholder?: boolean;
  className?: string;
  attrs?: Attrs;
};

export function Text(options: TextOptions = {}): HTMLElement {
  const { as = 'span', text, children, tone, size, truncate, placeholder, className, attrs } = options;
  return el(
    as,
    {
      class: classes('ds-Text', className),
      ...data({ tone, size, truncate, placeholder }),
      ...attrs,
    },
    children ?? text,
  );
}

export type LinkOptions = {
  text: string;
  href?: string;
  /** Opens in a new tab, with the `rel` that prevents opener access. */
  external?: boolean;
  /** Figures line up in a column — issue keys, versions, dates. */
  tabular?: boolean;
  title?: string;
  className?: string;
  attrs?: Attrs;
};

/**
 * A link. Without an `href` it renders as plain text rather than as a dead
 * anchor: a JIRA reference on a deployment with no `JIRA_BASE_URL` has nowhere
 * to go, and an anchor that does nothing is worse than a label.
 */
export function Link(options: LinkOptions): HTMLElement {
  const { text, href, external, tabular, title, className, attrs } = options;
  return el(
    href ? 'a' : 'span',
    {
      class: classes('ds-Link', className),
      href,
      title,
      target: href && external ? '_blank' : undefined,
      rel: href && external ? 'noopener noreferrer' : undefined,
      ...data({ tabular, static: !href }),
      ...attrs,
    },
    text,
  );
}

export type LabelOptions = {
  text: string;
  /** A second, quieter line inside the label — a unit, a format hint. */
  hint?: string;
  htmlFor?: string;
  className?: string;
  attrs?: Attrs;
};

/**
 * The uppercase micro-caption: a form field's label, a table's column head, a
 * definition list's term. One component for all three, because they are one
 * typographic statement and used to be three copies of the same five
 * declarations in three stylesheets.
 */
export function Label(options: LabelOptions): HTMLLabelElement {
  const { text, hint, htmlFor, className, attrs } = options;
  return el('label', { class: classes('ds-Label', className), for: htmlFor, ...attrs }, [
    text,
    hint && el('small', { class: 'ds-Label-hint' }, ` ${hint}`),
  ]);
}
