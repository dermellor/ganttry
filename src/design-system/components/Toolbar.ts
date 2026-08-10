import './Toolbar.css';
import { classes, data, el, type Attrs, type Child } from './dom';
import { Label } from './Text';

/**
 * The three horizontal bars the app is framed by — the header, the grouping and
 * filter row under it, and the status footer — plus the labelled control that
 * fills them.
 *
 * They are one component with a `tone` rather than three, because they are the
 * same object: a full-width row with a hairline against the content and
 * consistent inline padding. Three separate definitions is how one of them ends
 * up 2px taller after someone adjusts a single button.
 */

export type ToolbarTone =
  /** Top of the app: the title, view picker and global actions. */
  | 'header'
  /** Between the header and the content: grouping and filtering. */
  | 'view'
  /** Bottom: the status line and the export link. */
  | 'footer';

export type ToolbarOptions = {
  children?: Child;
  tone?: ToolbarTone;
  hidden?: boolean;
  ariaLabel?: string;
  className?: string;
  attrs?: Attrs;
};

export function Toolbar(options: ToolbarOptions = {}): HTMLElement {
  const { children, tone = 'view', hidden, ariaLabel, className, attrs } = options;
  const tag = tone === 'header' ? 'header' : tone === 'footer' ? 'footer' : 'div';
  return el(
    tag,
    { class: classes('ds-Toolbar', className), hidden, 'aria-label': ariaLabel, ...data({ tone }), ...attrs },
    children,
  );
}

export type ToolbarGroupOptions = {
  children?: Child;
  /** Pushed to the trailing edge of the bar. */
  end?: boolean;
  className?: string;
  attrs?: Attrs;
};

export function ToolbarGroup(options: ToolbarGroupOptions = {}): HTMLDivElement {
  const { children, end, className, attrs } = options;
  return el('div', { class: classes('ds-ToolbarGroup', className), ...data({ end }), ...attrs }, children);
}

export type ToolbarControlOptions = {
  /** The caption before the control. Uppercase micro-type, like a field's label. */
  label?: string;
  children?: Child;
  /** Renders as a `<label>`, so the caption focuses the control. Off for a group
   *  of several controls, where a label element would claim only the first. */
  labelled?: boolean;
  hidden?: boolean;
  className?: string;
  attrs?: Attrs;
};

/** A caption plus its control, sitting inline in a toolbar. */
export function ToolbarControl(options: ToolbarControlOptions = {}): HTMLElement {
  const { label, children, labelled = true, hidden, className, attrs } = options;
  const inner: Child[] = [
    label != null && (labelled ? label : Label({ text: label })),
    ...(Array.isArray(children) ? children : [children]),
  ];
  return el(
    labelled ? 'label' : 'div',
    { class: classes('ds-ToolbarControl', className), hidden, ...attrs },
    inner,
  );
}

export type ToolbarAnchorOptions = {
  children?: Child;
  className?: string;
  attrs?: Attrs;
};

/**
 * A positioning context for a popover inside a toolbar: the filter's value
 * button and the checklist it opens. The anchored placement in Menu.css needs a
 * positioned ancestor, and the toolbar itself is the wrong one — a popover
 * anchored to the whole bar would open at its left edge.
 */
export function ToolbarAnchor(options: ToolbarAnchorOptions = {}): HTMLDivElement {
  const { children, className, attrs } = options;
  return el('div', { class: classes('ds-ToolbarAnchor', className), ...attrs }, children);
}

export type AppMarkOptions = {
  className?: string;
};

/** The accent square beside the app title. Shape follows `--mark-radius`. */
export function AppMark(options: AppMarkOptions = {}): HTMLSpanElement {
  return el('span', { class: classes('ds-AppMark', options.className), 'aria-hidden': 'true' });
}
