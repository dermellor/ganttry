import './Dialog.css';
import { classes, el, type Attrs, type Child } from './dom';
import { Heading } from './Text';
import { IconButton } from './Button';

/**
 * A modal built on the native `<dialog>`.
 *
 * Native rather than a div with a z-index, because `showModal()` brings the
 * three things a hand-rolled modal reliably gets wrong: the top layer (so
 * nothing in the app can paint over it), the focus trap, and Escape. The
 * backdrop is styled here; everything else about it is the browser's.
 *
 * Distinct from `Panel`, which is an overlay *beside* the content and leaves it
 * usable. A dialog says: nothing else until this is dealt with.
 */

export type DialogOptions = {
  title?: string;
  children?: Child;
  closeLabel?: string;
  /** Called by the close button. `showModal`/`close` stay the caller's business. */
  onClose?: () => void;
  ariaLabel?: string;
  className?: string;
  attrs?: Attrs;
};

export function Dialog(options: DialogOptions = {}): HTMLDialogElement {
  const { title, children, closeLabel = 'Schließen', onClose, ariaLabel, className, attrs } = options;

  const close = IconButton({
    icon: '×',
    ariaLabel: closeLabel,
    boxSize: 'lg',
    className: 'ds-Dialog-close',
  });
  if (onClose) close.addEventListener('click', onClose);

  return el(
    'dialog',
    { class: classes('ds-Dialog', className), 'aria-label': ariaLabel ?? title, ...attrs },
    [
      el('div', { class: 'ds-Dialog-head' }, [
        title != null && Heading({ level: 2, text: title }),
        close,
      ]),
      children,
    ],
  );
}
