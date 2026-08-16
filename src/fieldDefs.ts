// The rules for editing a timeline's own field definitions: what a definition has
// to look like, which key may still be changed, and how the option list is written.
//
// DOM-free so every rule is unit-testable, and because these are the rules that
// keep an edit from destroying data. Two of them are the reason this module exists
// rather than a handful of checks in the form:
//
//   - A key is an item's metadata key. Renaming it on a field that items already
//     carry values for orphans every one of those values, silently: the field then
//     reads empty everywhere and the old values sit in the file under a key nothing
//     offers. So a key is editable only while nothing uses it.
//   - A stored definition on a key a plugin also contributes is invisible, because
//     the contributed one wins (`mergeFieldDefs`). Storing one anyway looks like an
//     edit that did not take.

import type { CustomFieldDef, CustomFieldOption, CustomFieldType, TimelineFileItem } from './types';

import { translate, type MessageKey } from './i18n/catalogue.ts';
import { DEFAULT_LOCALE, type Locale } from './i18n/locale.ts';

/** The three shapes a field can have. Stored on the definition; never a label. */
export const FIELD_TYPE_VALUES: readonly CustomFieldType[] = ['text', 'select', 'multi-select'];

const FIELD_TYPE_KEY: Record<CustomFieldType, MessageKey> = {
  text: 'field.type.text',
  select: 'field.type.select',
  'multi-select': 'field.type.multiSelect',
};

/**
 * The `<select>` rows for a field's type, in a language.
 *
 * A function rather than the constant table it was: a table is filled on import,
 * before a reader's language is known, and this module is also read by the server
 * — so the locale comes in as an argument here for the reason `validateFieldDefs`
 * takes one (see below).
 */
export function fieldTypeRows(
  locale: Locale = DEFAULT_LOCALE,
): { value: CustomFieldType; label: string }[] {
  return FIELD_TYPE_VALUES.map((value) => ({
    value,
    label: translate(locale, FIELD_TYPE_KEY[value]),
  }));
}

/**
 * Metadata keys the product already owns. A field on one of these would be a
 * second editor for the same value, and the item form already renders the built-in
 * (see `RESERVED_META_KEYS` in customFields.ts, which this deliberately mirrors:
 * the list is short, stable and worth stating where the rule that needs it lives).
 * `wikilinks` and `sequence` are owned by the directory scanner rather than by a
 * control: a field of either name would be overwritten on every read.
 */
export const RESERVED_FIELD_KEYS = [
  'dependsOn',
  'parent',
  'owner',
  'jira',
  'tags',
  'tag',
  'wikilinks',
  'sequence',
];

/** A key has to be usable as a JSON object key without quoting surprises. */
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Which field keys the items actually carry a value for. */
export function fieldKeysInUse(items: readonly TimelineFileItem[] | undefined): Set<string> {
  const used = new Set<string>();
  for (const item of items ?? []) {
    for (const [key, value] of Object.entries(item.metadata ?? {})) {
      // An empty array or an empty string is a stored „nothing" and does not pin the
      // key: clearing the last value has to leave the key renameable again.
      if (value == null) continue;
      if (Array.isArray(value) ? value.length > 0 : String(value).trim() !== '') used.add(key);
    }
  }
  return used;
}

/**
 * One option per line: `value`, or `value = Label`, or either followed by `#rrggbb`.
 *
 * A textarea rather than a row of inputs per option, because an option list is
 * usually typed in one go and pasted from somewhere else. The grammar is stated in
 * the form's hint, and anything unparseable stays as a plain value rather than
 * being dropped — losing a line somebody typed is worse than keeping it verbatim.
 */
export function parseFieldOptions(text: string): CustomFieldOption[] {
  const out: CustomFieldOption[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const colour = /(#[0-9a-fA-F]{3,8})\s*$/.exec(line);
    const withoutColour = colour ? line.slice(0, colour.index).trim() : line;
    const [value, ...labelParts] = withoutColour.split('=');
    const option: CustomFieldOption = { value: value.trim() };
    const label = labelParts.join('=').trim();
    if (label) option.label = label;
    if (colour) option.color = colour[1];
    if (option.value) out.push(option);
  }
  return out;
}

/** The inverse, so a round trip through the textarea changes nothing. */
export function formatFieldOptions(options: readonly CustomFieldOption[] | undefined): string {
  return (options ?? [])
    .map((o) => {
      const label = o.label && o.label !== o.value ? ` = ${o.label}` : '';
      const colour = o.color ? ` ${o.color}` : '';
      return `${o.value}${label}${colour}`;
    })
    .join('\n');
}

/** Is this a type whose values come from a declared list? */
export function hasOptions(type: CustomFieldType): boolean {
  return type === 'select' || type === 'multi-select';
}

export type FieldDefProblem = { index: number; message: string };

/**
 * Everything wrong with a set of definitions, all of it at once rather than the
 * first thing: somebody fixing four problems one save at a time gives up.
 *
 * `pluginKeys` are the keys enabled plugins contribute. A stored definition on one
 * of those is refused rather than accepted-and-ignored, because `mergeFieldDefs`
 * lets the contributed one win and the stored one would simply never appear.
 */
export function validateFieldDefs(
  defs: readonly CustomFieldDef[],
  pluginKeys: readonly string[] = [],
  locale: Locale = DEFAULT_LOCALE,
): FieldDefProblem[] {
  // The locale is a parameter rather than read from module state, because this
  // module is shared with the server: the browser knows who is looking, and the
  // write path does not. A default that resolves to the product language keeps
  // every existing caller working and keeps the module free of client state —
  // the same arrangement `declaredSettings` uses, and for the same reason.
  const m = (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars);
  const problems: FieldDefProblem[] = [];
  const seen = new Map<string, number>();
  const plugin = new Set(pluginKeys);

  defs.forEach((def, index) => {
    const key = def.key.trim();
    if (!key) {
      problems.push({ index, message: m('refusal.field.keyMissing') });
    } else if (!KEY_SHAPE.test(key)) {
      problems.push({ index, message: m('refusal.field.keyShape') });
    } else if (RESERVED_FIELD_KEYS.includes(key)) {
      problems.push({ index, message: m('refusal.field.keyReserved', { key }) });
    } else if (plugin.has(key)) {
      problems.push({ index, message: m('refusal.field.keyFromPlugin', { key }) });
    } else if (seen.has(key)) {
      problems.push({ index, message: m('refusal.field.keyTaken', { key, index: seen.get(key)! + 1 }) });
    } else {
      seen.set(key, index);
    }

    if (!def.label.trim()) {
      problems.push({ index, message: m('refusal.field.labelMissing') });
    }
    if (hasOptions(def.type) && !(def.options ?? []).length) {
      problems.push({ index, message: m('refusal.field.optionsMissing') });
    }
  });

  return problems;
}

/**
 * Move one definition, clamped. The order is what the item form and the dimension
 * lists read, so this is the only reordering there is; a „sort" field would be a
 * second source of truth for the same thing.
 */
export function moveFieldDef<T>(defs: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || index >= defs.length || target < 0 || target >= defs.length) return [...defs];
  const out = [...defs];
  const [moved] = out.splice(index, 1);
  out.splice(target, 0, moved);
  return out;
}

/**
 * A definition trimmed to what belongs in the file: no empty strings, no options on
 * a `text` field, no flags that mean nothing on it.
 *
 * Dropping rather than storing an empty value keeps a save from writing keys the
 * timeline did not have — the same rule the item form follows, and what keeps a
 * plain save out of the diff.
 */
export function normalizeFieldDef(def: CustomFieldDef): CustomFieldDef {
  const out: CustomFieldDef = {
    key: def.key.trim(),
    label: def.label.trim(),
    type: def.type,
  };
  if (hasOptions(def.type)) {
    const options = (def.options ?? []).filter((o) => o.value.trim());
    if (options.length) out.options = options;
    // Only a list-valued field can offer a menu of its values, so the flag is
    // dropped on `text` rather than stored and ignored (contextMenuFields owns the
    // same rule at read time; storing it here would make the file claim something).
    if (def.contextMenu) out.contextMenu = true;
  }
  const group = def.group?.trim();
  if (group) out.group = group;
  if (def.width === 'full') out.width = 'full';
  return out;
}

/** Whether a key may still be edited: only while no item carries a value for it. */
export function keyEditable(key: string, inUse: ReadonlySet<string>): boolean {
  return !inUse.has(key);
}

/**
 * The rows a `select` offers for a stored value: the empty choice, the declared
 * options, and — when the stored value is not among them any more — that value.
 *
 * The last one is not a nicety. Leaving the detail panel commits the form („Opening
 * an item's form is a read", docs/editing.md), so a `<select>` that cannot show the
 * stored value shows the empty one and the commit writes that empty over it. One
 * removed option then cleared the field on every item that carried it, in a single
 * click, with no message. Verified against the real form before this existed.
 */
export function selectRowsFor(
  def: Pick<CustomFieldDef, 'options'>,
  current: string,
  locale: Locale = DEFAULT_LOCALE,
): { value: string; label: string; selected: boolean }[] {
  const declared = def.options ?? [];
  const rows = [
    { value: '', label: '— —', selected: !current },
    ...declared.map((o) => ({
      value: o.value,
      label: o.label ?? o.value,
      selected: o.value === current,
    })),
  ];
  if (current && !declared.some((o) => o.value === current)) {
    // Marked rather than shown bare: „Free" beside three other values reads as one
    // of them, and the next person wonders why it is not in the definition.
    rows.push({
      value: current,
      label: translate(locale, 'field.valueNotListed', { value: current }),
      selected: true,
    });
  }
  return rows;
}
