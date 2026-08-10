import './Callout.css';
import { classes, data, el, type Attrs, type Child } from './dom';

/**
 * A short statement standing in the space where content would have been.
 *
 * The one in the product is a load failure: the footer's status line carries the
 * same sentence, but on its own it leaves the content area blank, and blank
 * reads as „broken" rather than as „refused". Saying it where somebody is
 * already looking is the whole point, which is why this is a block in the flow
 * and not a toast.
 */

export type CalloutTone =
  /** Something did not happen and the reason is worth reading. */
  | 'danger'
  /** Something to know before acting. */
  | 'warning'
  /** Neutral context. */
  | 'info';

export type CalloutOptions = {
  text?: string;
  children?: Child;
  tone?: CalloutTone;
  /**
   * `status` for a state the app arrived at on its own (a failed load) and
   * `alert` for the result of something the reader just did. The difference is
   * whether a screen reader interrupts.
   */
  role?: 'status' | 'alert' | 'note';
  className?: string;
  attrs?: Attrs;
};

export function Callout(options: CalloutOptions = {}): HTMLDivElement {
  const { text, children, tone = 'danger', role = 'status', className, attrs } = options;
  return el(
    'div',
    { class: classes('ds-Callout', className), role, ...data({ tone }), ...attrs },
    children ?? text,
  );
}
