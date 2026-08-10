import './Input.css';
import { classes, data, el, on, type Attrs, type Listeners } from './dom';

/**
 * The editing surfaces: text, multi-line text, a choice, a boolean.
 *
 * All four share one focus treatment, and it is deliberately not the focus ring
 * the rest of the viewer uses: an input tints its border instead. A 2px accent
 * ring around every field you touch read as a heavy frame on a form with twelve
 * of them. Buttons keep the real ring, because there is no border there to
 * recolour. That split is the reason this rule lives in the component rather
 * than in a global `:focus-visible`.
 */

type CommonOptions = {
  id?: string;
  name?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  /** Fills the width of its field. On by default; a date input opts out. */
  block?: boolean;
  /** Marks the control as holding a rejected value (see Field's error slot). */
  invalid?: boolean;
  className?: string;
  attrs?: Attrs;
  on?: Listeners;
};

export type TextInputOptions = CommonOptions & {
  type?: 'text' | 'date' | 'number' | 'search' | 'url' | 'email';
  /** Strips the border and background: the input inside a ChipBox. */
  bare?: boolean;
};

export function TextInput(options: TextInputOptions = {}): HTMLInputElement {
  const { type = 'text', bare, block = true, invalid, className, attrs, on: listeners, ...rest } = options;
  const node = el('input', {
    type,
    class: classes('ds-Input', className),
    id: rest.id,
    name: rest.name,
    value: rest.value,
    placeholder: rest.placeholder,
    disabled: rest.disabled,
    readonly: rest.readonly,
    required: rest.required,
    'aria-invalid': invalid ? 'true' : undefined,
    ...data({ bare, block }),
    ...attrs,
  });
  on(node, listeners);
  return node;
}

export type TextAreaOptions = CommonOptions & {
  rows?: number;
  /** Monospace, for the raw-metadata escape hatch. Prose uses the body face. */
  mono?: boolean;
};

export function TextArea(options: TextAreaOptions = {}): HTMLTextAreaElement {
  const { rows, mono, block = true, invalid, className, attrs, on: listeners, ...rest } = options;
  const node = el(
    'textarea',
    {
      class: classes('ds-Input ds-TextArea', className),
      id: rest.id,
      name: rest.name,
      placeholder: rest.placeholder,
      disabled: rest.disabled,
      readonly: rest.readonly,
      required: rest.required,
      rows,
      'aria-invalid': invalid ? 'true' : undefined,
      ...data({ mono, block }),
      ...attrs,
    },
    rest.value,
  );
  on(node, listeners);
  return node;
}

export type SelectOption = {
  value: string;
  label: string;
  selected?: boolean;
  disabled?: boolean;
};

/** A non-selectable heading with its own options — a parent group in the item form. */
export type SelectOptionGroup = {
  label: string;
  options: SelectOption[];
};

export type SelectOptions = CommonOptions & {
  options?: (SelectOption | SelectOptionGroup)[];
  /** The toolbar's wider select, which has to fit a view name. */
  wide?: boolean;
};

function optionNode(option: SelectOption): HTMLOptionElement {
  return el(
    'option',
    { value: option.value, selected: option.selected, disabled: option.disabled },
    option.label,
  );
}

export function Select(options: SelectOptions = {}): HTMLSelectElement {
  const { options: items = [], wide, block = true, invalid, className, attrs, on: listeners, ...rest } = options;
  const node = el(
    'select',
    {
      class: classes('ds-Input ds-Select', className),
      id: rest.id,
      name: rest.name,
      disabled: rest.disabled,
      required: rest.required,
      'aria-invalid': invalid ? 'true' : undefined,
      ...data({ wide, block }),
      ...attrs,
    },
    items.map((item) =>
      'options' in item
        ? el('optgroup', { label: item.label }, item.options.map(optionNode))
        : optionNode(item),
    ),
  );
  if (rest.value != null) node.value = rest.value;
  on(node, listeners);
  return node;
}

/**
 * Refill an existing `<select>`. The app's toolbar selects are part of the frame
 * and get repopulated as views and dimensions change, rather than rebuilt — a
 * replaced element loses focus, which closes the dropdown under the pointer of
 * whoever is using it.
 */
export function setSelectOptions(
  select: HTMLSelectElement,
  items: (SelectOption | SelectOptionGroup)[],
): void {
  select.replaceChildren(
    ...items.map((item) =>
      'options' in item
        ? el('optgroup', { label: item.label }, item.options.map(optionNode))
        : optionNode(item),
    ),
  );
}

export type CheckboxOptions = {
  id?: string;
  name?: string;
  value?: string;
  label?: string;
  checked?: boolean;
  disabled?: boolean;
  className?: string;
  attrs?: Attrs;
  on?: Listeners;
};

/**
 * Always a `<label>` wrapping its box, never a bare `<input>` beside a `<span>`:
 * the wrapping form gives the label a hit area for free, and every checkbox in
 * the viewer sits next to text that should be clickable.
 */
export function Checkbox(options: CheckboxOptions = {}): HTMLLabelElement {
  const { id, name, value, label, checked, disabled, className, attrs, on: listeners } = options;
  const box = el('input', {
    type: 'checkbox',
    class: 'ds-Checkbox-box',
    id,
    name,
    value,
    checked,
    disabled,
  });
  on(box, listeners);
  return el('label', { class: classes('ds-Checkbox', className), ...attrs }, [
    box,
    label != null && el('span', { class: 'ds-Checkbox-label' }, label),
  ]);
}
