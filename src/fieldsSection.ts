// The „Felder" section of the timeline's settings: its own field definitions,
// edited where they are used rather than in a JSON file or a database column.
//
// They are the part of a timeline that most wants an interface and had none: the
// item form, the grouping dimensions, the filter and the context menu all read
// these definitions, and every one of them could only be changed by hand.
//
// The rules live in [`src/fieldDefs.ts`](./fieldDefs.ts), DOM-free and unit-tested,
// because they are what keeps an edit from destroying data. This module is the form
// around them: one card per definition, one save for the set (the API patches
// `customFields` as a unit), and every refusal shown at the field it belongs to.
//
// The section shows labels, control states and refusals, and nothing else. It once
// carried three explanations nobody had asked for — what a removal does to stored
// values, why a used key is locked, which fields a plugin contributes — each of them
// added in anticipation of a question, and together they pushed the first input of a
// new field below the fold. An anticipated question is not a reason to put text on
// screen; add copy here only when somebody reports being stuck without it.

import {
  Button,
  Callout,
  Checkbox,
  Field,
  Select,
  setSelectOptions,
  Text,
  TextArea,
  TextInput,
  el,
} from './design-system';
import { apiUpdateMeta } from './editor';
import {
  FIELD_TYPES,
  fieldKeysInUse,
  formatFieldOptions,
  hasOptions,
  keyEditable,
  moveFieldDef,
  normalizeFieldDef,
  parseFieldOptions,
  validateFieldDefs,
  type FieldDefProblem,
} from './fieldDefs';
import { pluginFieldDefs } from './pluginHost/registry';
import { renderTimeline } from './render';
import { els, state } from './state';
import type { CustomFieldDef, CustomFieldType } from './types';

/** The draft the form edits: the stored definitions, never the contributed ones. */
let draft: CustomFieldDef[] = [];
let notice = '';

function newField(): CustomFieldDef {
  return { key: '', label: '', type: 'text' };
}

function fieldCard(
  def: CustomFieldDef,
  index: number,
  ctx: { editable: boolean; inUse: ReadonlySet<string>; problems: FieldDefProblem[]; rerender: () => void },
): HTMLElement {
  const { editable, inUse, problems, rerender } = ctx;
  const mine = problems.filter((p) => p.index === index);
  const keyLocked = !keyEditable(def.key, inUse) && !!def.key;

  const key = TextInput({
    value: def.key,
    disabled: !editable || keyLocked,
    on: { input: (e) => { def.key = (e.target as HTMLInputElement).value; } },
  });
  const label = TextInput({
    value: def.label,
    disabled: !editable,
    on: { input: (e) => { def.label = (e.target as HTMLInputElement).value; } },
  });
  const type = Select({ disabled: !editable });
  setSelectOptions(type, FIELD_TYPES.map((t) => ({ value: t.value, label: t.label })));
  type.value = def.type;
  type.addEventListener('change', () => {
    def.type = type.value as CustomFieldType;
    // The card's own shape depends on the type (options only exist for a list), so
    // the section re-renders rather than toggling pieces by hand.
    rerender();
  });

  const options = hasOptions(def.type)
    ? TextArea({
        value: formatFieldOptions(def.options),
        rows: 4,
        disabled: !editable,
        on: {
          input: (e) => {
            def.options = parseFieldOptions((e.target as HTMLTextAreaElement).value);
          },
        },
      })
    : null;

  const group = TextInput({
    value: def.group ?? '',
    disabled: !editable,
    on: { input: (e) => { def.group = (e.target as HTMLInputElement).value; } },
  });

  return el('section', { class: 'field-card' }, [
    el('div', { class: 'field-card-head' }, [
      Text({ text: def.label.trim() || def.key.trim() || 'Neues Feld', className: 'field-card-title' }),
      el('div', { class: 'field-card-tools' }, [
        Button({
          label: '↑',
          variant: 'trigger',
          ariaLabel: 'Nach oben',
          disabled: !editable || index === 0,
          on: { click: () => { draft = moveFieldDef(draft, index, -1); rerender(); } },
        }),
        Button({
          label: '↓',
          variant: 'trigger',
          ariaLabel: 'Nach unten',
          disabled: !editable || index === draft.length - 1,
          on: { click: () => { draft = moveFieldDef(draft, index, 1); rerender(); } },
        }),
        Button({
          label: 'Entfernen',
          variant: 'danger',
          disabled: !editable,
          on: {
            click: () => {
              // The definition goes, the values stay: nothing here touches an item.
              draft = draft.filter((_, i) => i !== index);
              rerender();
            },
          },
        }),
      ]),
    ]),
    Field({ label: 'Bezeichnung', control: label }),
    Field({
      label: 'Schlüssel',
      // The hint only names the state of a locked input; there is deliberately no
      // hint on an editable one, and no prose under either.
      hint: keyLocked ? 'fest, weil benutzt' : undefined,
      control: key,
    }),
    Field({ label: 'Typ', control: type }),
    options
      ? Field({
          label: 'Werte',
          hint: 'einer pro Zeile: wert = Beschriftung #farbe',
          control: options,
        })
      : null,
    hasOptions(def.type)
      ? Checkbox({
          label: 'Auch im Rechtsklick-Menü anbieten',
          checked: !!def.contextMenu,
          disabled: !editable,
          on: { change: (e) => { def.contextMenu = (e.target as HTMLInputElement).checked; } },
        })
      : null,
    Field({ label: 'Abschnitt', hint: 'optional', control: group }),
    ...mine.map((p) => Callout({ tone: 'danger', text: p.message })),
  ]);
}

export function mountFields(root: HTMLElement): void {
  const view = state.activeView;
  const file = state.activeSourceFile;
  if (!view || !file) {
    root.replaceChildren(Callout({ text: 'Keine Timeline geladen.' }));
    return;
  }

  const editable = state.activeSourceEditable;
  const contributed = pluginFieldDefs(file);
  const pluginKeys = contributed.map((f) => f.key);
  const inUse = fieldKeysInUse(file.items);
  const problems = validateFieldDefs(draft, pluginKeys);

  const rerender = () => mountFields(root);

  const save = Button({
    label: 'Speichern',
    variant: 'outline',
    disabled: problems.length > 0,
    attrs: { hidden: !editable },
  });
  const status = Text({
    as: 'p',
    text: notice || (problems.length ? `${problems.length} Problem(e) zu klären.` : ''),
    tone: 'muted',
    size: 'xs',
    attrs: { role: 'status' },
  });

  save.addEventListener('click', () => {
    notice = 'Wird gespeichert …';
    save.disabled = true;
    status.textContent = notice;
    void apiUpdateMeta(view.source.id, { customFields: draft.map(normalizeFieldDef) })
      .then(async () => {
        // Re-render the whole view, because these definitions drive the item form,
        // the grouping list, the filter and the context menu. Patching each of them
        // from here would be four places to keep in step with a fifth.
        await renderTimeline(view);
        notice = 'Gespeichert.';
        draft = (state.activeSourceFile?.customFields ?? []).map((f) => structuredClone(f));
        rerender();
      })
      .catch((e: unknown) => {
        notice = e instanceof Error ? e.message : String(e);
        rerender();
      });
  });
  notice = '';

  root.replaceChildren(
    el('div', { class: 'settings-form' }, [
      ...draft.map((def, index) => fieldCard(def, index, { editable, inUse, problems, rerender })),
      draft.length ? null : Text({ as: 'p', text: 'Noch keine eigenen Felder.', tone: 'muted' }),
      el('div', { class: 'settings-actions' }, [
        Button({
          // „Add another one" under a repeatable row: the dashed slot the design
          // system has for exactly this, rather than a second outline button
          // competing with Speichern.
          label: '+ Feld',
          variant: 'dashed',
          attrs: { hidden: !editable },
          on: { click: () => { draft = [...draft, newField()]; rerender(); } },
        }),
        save,
        status,
      ]),
    ]),
  );
}

/**
 * The draft is rebuilt from the file on every mount, so leaving the section and
 * coming back discards unsaved edits rather than reviving them against a timeline
 * that may have changed underneath.
 */
export function resetFieldsDraft(): void {
  draft = (state.activeSourceFile?.customFields ?? []).map((f) => structuredClone(f));
  notice = '';
}

export function unmountFields(): void {
  draft = [];
  notice = '';
}

/** Kept for the section registry: mounting starts from the stored state. */
export function mountFieldsSection(root: HTMLElement): void {
  resetFieldsDraft();
  mountFields(root);
  // The area's own scroll position is the panel's, and a long field list is the
  // first thing here that can outgrow it.
  els.tlSettingsBody.scrollTop = 0;
}
