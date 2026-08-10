import './Separator.css';
import { classes, data, el, type Attrs } from './dom';

export type SeparatorOptions = {
  orientation?: 'horizontal' | 'vertical';
  /** Vertical air around the rule, for a divider between blocks of content. */
  spaced?: boolean;
  className?: string;
  attrs?: Attrs;
};

/**
 * A rule between two blocks. `<hr>` rather than a bordered div, because that is
 * what it means and it gives assistive tech the separator role for free.
 */
export function Separator(options: SeparatorOptions = {}): HTMLHRElement {
  const { orientation = 'horizontal', spaced, className, attrs } = options;
  return el('hr', {
    class: classes('ds-Separator', className),
    ...data({ orientation, spaced }),
    ...attrs,
  });
}
