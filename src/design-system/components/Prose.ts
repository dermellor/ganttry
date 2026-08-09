import './Prose.css';
import { classes, data, el, type Attrs, type Child } from './dom';

/**
 * Rendered Markdown. One component for both places the viewer shows it: the
 * detail panel's read-only body, and the editing surface of the WYSIWYG editor.
 *
 * Those were two stylesheets describing the same six elements — headings, code,
 * pre, links, lists, quotes — and they had already drifted: the reading view gave
 * code a 4px radius and the editor 3px, and only one of them styled blockquotes
 * at all. A person editing a note and then closing the form saw the text move.
 */

export type ProseOptions = {
  children?: Child;
  /**
   * The editing surface: bounded height with its own scroll, and the tighter
   * leading that a text you are typing into wants. The reading view is
   * unbounded — it scrolls with the panel.
   */
  editable?: boolean;
  className?: string;
  attrs?: Attrs;
};

export function Prose(options: ProseOptions = {}): HTMLDivElement {
  const { children, editable, className, attrs } = options;
  return el('div', { class: classes('ds-Prose', className), ...data({ editable }), ...attrs }, children);
}
