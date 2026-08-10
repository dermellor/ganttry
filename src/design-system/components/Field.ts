import './Field.css';
import { append, classes, data, el, type Attrs, type Child } from './dom';
import { Label } from './Text';

/**
 * Form layout: the two-column grid, one labelled field in it, the titled
 * section, the collapsed escape hatch, and the action row.
 *
 * The rule the grid encodes is that air goes *between* fields, never inside one:
 * a label sits 4px from its control and 12px from the next field. Reversing that
 * is what makes a form read as a list of loose controls.
 */

export type FormGridOptions = {
  children?: Child;
  /** Extra space above, for a grid nested under a tabstrip. */
  inset?: boolean;
  className?: string;
  attrs?: Attrs;
};

export function FormGrid(options: FormGridOptions = {}): HTMLDivElement {
  const { children, inset, className, attrs } = options;
  return el('div', { class: classes('ds-FormGrid', className), ...data({ inset }), ...attrs }, children);
}

export type FieldOptions = {
  label?: string;
  /** A quieter second phrase inside the label: a unit, a format. */
  hint?: string;
  /** The control. Anything from Input.ts, a ChipBox, a plugin's own widget. */
  control?: Child;
  /** `id` of the control, so clicking the label focuses it. */
  htmlFor?: string;
  /** Spans both columns. */
  full?: boolean;
  /** Still editable, visually stepped back — an end date while „point" is picked. */
  muted?: boolean;
  hidden?: boolean;
  className?: string;
  attrs?: Attrs;
};

export function Field(options: FieldOptions = {}): HTMLDivElement {
  const { label, hint, control, htmlFor, full, muted, hidden, className, attrs } = options;
  return el(
    'div',
    {
      class: classes('ds-Field', className),
      hidden,
      ...data({ full, muted }),
      ...attrs,
    },
    [label != null && Label({ text: label, hint, htmlFor }), control],
  );
}

export type FieldErrorOptions = {
  text?: string;
  id?: string;
  hidden?: boolean;
  className?: string;
  attrs?: Attrs;
};

/**
 * Why an edit was refused, shown under the fields it belongs to rather than in
 * the status line — the distinction is load-bearing (see `showExtentError` in
 * itemForm.ts). Spans the grid so the sentence gets a full line instead of
 * wrapping inside one column.
 */
export function FieldError(options: FieldErrorOptions = {}): HTMLParagraphElement {
  const { text, id, hidden, className, attrs } = options;
  return el('p', { class: classes('ds-FieldError', className), id, hidden, role: 'alert', ...attrs }, text);
}

/**
 * A statement about the data rather than a refused edit — where the children of
 * a summary item run outside its own dates, say. Muted rather than `--danger`:
 * the value stays authoritative and nothing is being rejected, which is exactly
 * the distinction a red sentence would erase.
 */
export function FieldNote(options: FieldErrorOptions = {}): HTMLParagraphElement {
  const { text, id, hidden, className, attrs } = options;
  return el('p', { class: classes('ds-FieldNote', className), id, hidden, ...attrs }, text);
}

export type FieldsetOptions = {
  legend: string;
  children?: Child;
  className?: string;
  attrs?: Attrs;
};

/**
 * A titled group of fields — what a plugin's contributed fields are collected
 * under, so they read as „these belong together" rather than as loose fields
 * among the timeline's own.
 *
 * The caption sits centred *in* the rule, which breaks around it. The native
 * `<legend>` notch would be the obvious route and does not work here: measured,
 * the legend rendered below the border instead of straddling it. The two line
 * segments are the legend's own pseudo-elements, so the break is exact at any
 * caption width and this element never needs to know the panel's fill colour.
 */
export function Fieldset(options: FieldsetOptions): HTMLFieldSetElement {
  const { legend, children, className, attrs } = options;
  const node = el('fieldset', { class: classes('ds-Fieldset', className), ...attrs }, [
    el('legend', { class: 'ds-Fieldset-legend' }, legend),
  ]);
  const body = el('div', { class: 'ds-Fieldset-body' });
  append(body, children);
  node.appendChild(body);
  return node;
}

export type DisclosureOptions = {
  summary: string;
  children?: Child;
  open?: boolean;
  className?: string;
  attrs?: Attrs;
};

/**
 * A rarely-used fallback folded away behind one line — the raw metadata box.
 * Collapsed it costs a 12px summary instead of a labelled textarea; call sites
 * open it when the item actually carries something, so nothing existing hides
 * itself from the person who put it there.
 */
export function Disclosure(options: DisclosureOptions): HTMLDetailsElement {
  const { summary, children, open, className, attrs } = options;
  return el('details', { class: classes('ds-Disclosure', className), open, ...attrs }, [
    el('summary', { class: 'ds-Disclosure-summary' }, summary),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

export type FormActionsOptions = {
  children?: Child;
  /**
   * Centred under a divider. The item form persists reactively, so Delete is its
   * only action and it gets that treatment; the phase and feature forms keep the
   * plain left-aligned Save + Delete row.
   */
  centered?: boolean;
  className?: string;
  attrs?: Attrs;
};

export function FormActions(options: FormActionsOptions = {}): HTMLDivElement {
  const { children, centered, className, attrs } = options;
  return el('div', { class: classes('ds-FormActions', className), ...data({ centered }), ...attrs }, children);
}
