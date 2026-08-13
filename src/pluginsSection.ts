// The „Plugins" section of the timeline's settings: which plugins this timeline
// uses, and with what configuration.
//
// Which plugins a timeline carries has been pure data from the start — a row in
// `timeline_plugins`, surfaced as `TimelineFile.plugins` — and the single-plugin
// route has existed as long as the plugin API. What was missing is this: switching
// one on meant running SQL or editing a file, so the feature was reachable only by
// whoever had database access.
//
// The verdicts come from [`src/pluginSettings.ts`](./pluginSettings.ts), DOM-free and
// unit-tested; this module is the form around them. Two rules it does NOT re-decide,
// on purpose:
//
//   - **Whether a config is valid.** The API validates it against the manifest's own
//     `configSchema` and answers with the reason, which is shown at the card. A second
//     copy of that check here would be the one that keeps accepting what the server
//     has started refusing.
//   - **Whether a plugin may run.** `pluginStatus` decided that already; a contract
//     this host does not satisfy is listed with its reason and gets no switch.

import {
  Badge,
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
import { apiDisablePlugin, apiEnablePlugin } from './editor';
import { loadPluginStatuses } from './pluginPanel';
import {
  configForm,
  entriesToMap,
  mapEntries,
  pruneEmpty,
  stringsValue,
  undeclaredKeys,
  type ConfigControl,
} from './pluginConfigForm';
import { pluginSettingsRows, type PluginSettingsRow } from './pluginSettings';
import { state } from './state';
import type { PluginStatus } from './types';

/** The registry as this section last read it, so a re-mount does not refetch. */
let installed: PluginStatus[] | null = null;
/**
 * What to run once the enabled set changed: re-read the timeline and re-sync
 * everything that follows from which plugins apply (the views in the bar, the fields
 * in the item form, the data that loads).
 *
 * Handed in rather than imported, the way the saved-views control takes its mode
 * switch: that sequence lives in main.ts, and importing it here would close a cycle
 * around the module that mounts this section.
 */
let refreshTimeline: (() => Promise<void>) | null = null;

export function setPluginsSectionRefresh(fn: () => Promise<void>): void {
  refreshTimeline = fn;
}
/**
 * What the config form currently holds, per plugin id: the bag being edited, plus the
 * two things a bag cannot hold on its own.
 *
 * `mapRows` keeps a key/value editor's rows, because a row whose key is still empty has
 * to survive a keystroke and an object cannot express one. `texts` keeps the raw text of
 * a JSON control while it is being typed, which is the only state that may be
 * temporarily unparseable.
 */
const drafts = new Map<string, Record<string, unknown>>();
const mapRows = new Map<string, [string, string][]>();
const texts = new Map<string, string>();
const notices = new Map<string, string>();

/** A key for the two side maps, so one plugin's control cannot read another's. */
function slot(pluginId: string, key = ''): string {
  return `${pluginId}␟${key}`;
}

/** Drop one plugin's draft state, after a save made it stale. */
function forget(pluginId: string): void {
  drafts.delete(pluginId);
  const prefix = slot(pluginId);
  for (const key of [...mapRows.keys()]) if (key.startsWith(prefix)) mapRows.delete(key);
  for (const key of [...texts.keys()]) if (key.startsWith(prefix)) texts.delete(key);
}

/**
 * Why a plugin cannot be switched on here, in the interface's language.
 *
 * Worded here rather than shown as it arrives, for the reason the plugin list beside
 * it does: `problem` is written for logs and for whoever wrote the plugin, and printing
 * a server's English sentence at a user of a German interface reads as a leak. The full
 * sentence stays reachable on hover.
 */
function stateText(row: PluginSettingsRow): string {
  if (row.offerable) {
    return row.running
      ? row.enabledHere
        ? 'aktiv in dieser Timeline'
        : 'einsatzbereit'
      : 'installiert, Code läuft gerade nicht';
  }
  switch (row.reason) {
    case 'disabled':
      return 'für diese Instanz abgeschaltet';
    case 'api-version':
      return 'passt nicht zu dieser Host-Version';
    case 'invalid-manifest':
      return 'das Manifest ist nicht mehr gültig';
    default:
      return row.problem ?? 'kann hier nicht verwendet werden';
  }
}

/** „views, data" as one quiet line, or nothing when the manifest declares none. */
function factLine(label: string, values: string[]): HTMLElement | null {
  if (!values.length) return null;
  return Text({
    as: 'p',
    text: `${label}: ${values.join(', ')}`,
    tone: 'muted',
    size: 'xs',
  });
}

/** The bag being edited: the draft if there is one, else what the timeline stores. */
function draftFor(row: PluginSettingsRow): Record<string, unknown> {
  const existing = drafts.get(row.id);
  if (existing) return existing;
  const bag = { ...row.config };
  drafts.set(row.id, bag);
  return bag;
}

/**
 * The hint beside a key's label: what may be put there, in words.
 *
 * The control's kind rather than the schema's `type`, because „array" and „object" are
 * the author's vocabulary and „Liste von Texten" is the reader's. The kind already
 * carries everything the type said, which is why deriving the form made the raw type
 * unnecessary in the interface.
 */
const KIND_HINT: Record<ConfigControl['kind'], string> = {
  text: 'Text',
  number: 'Zahl',
  boolean: '',
  select: 'Auswahl',
  strings: 'Liste von Texten',
  map: 'Schlüssel und Wert',
  json: 'JSON',
};

function hint(control: ConfigControl): string | undefined {
  const parts = [KIND_HINT[control.kind], control.required ? 'erforderlich' : ''];
  const text = parts.filter(Boolean).join(', ');
  return text || undefined;
}

/** „+ Wert" / „Entfernen" as the fields section words them, so the two rhyme. */
function rowTools(children: (HTMLElement | null)[]): HTMLElement {
  return el('div', { class: 'plugin-config-row', ...{} }, children);
}

/**
 * One control per declared key.
 *
 * The whole section used to be one JSON textarea per plugin. That was honest about
 * arbitrary schemas and wrong as an interface: switching a plugin on required knowing
 * JSON, and a missing brace failed the save rather than the keystroke. Which control a
 * key deserves is decided in `pluginConfigForm.ts`; this only draws it.
 */
function controlNode(
  row: PluginSettingsRow,
  control: ConfigControl,
  bag: Record<string, unknown>,
  disabled: boolean,
  rerender: () => void,
): HTMLElement {
  const label = control.key;
  const common = { label, hint: hint(control), htmlFor: undefined as string | undefined };

  if (control.kind === 'boolean') {
    const box = Checkbox({
      label,
      checked: bag[control.key] === true,
      disabled,
      on: {
        change: (e) => {
          bag[control.key] = (e.target as HTMLInputElement).checked;
        },
      },
    });
    return el('div', { class: 'plugin-config-field' }, [box, note(control)]);
  }

  if (control.kind === 'select') {
    const select = Select({ disabled });
    // An empty option unless the key is required: „not set" has to stay reachable, and
    // a list with no way back to it turns opening the form into setting a value.
    setSelectOptions(select, [
      ...(control.required ? [] : [{ value: '', label: '— keine Angabe —' }]),
      ...(control.options ?? []).map((o) => ({ value: o, label: o })),
    ]);
    const current = bag[control.key];
    select.value = typeof current === 'string' ? current : '';
    select.addEventListener('change', () => {
      if (select.value) bag[control.key] = select.value;
      else delete bag[control.key];
    });
    return el('div', {}, [Field({ ...common, control: select }), note(control)]);
  }

  if (control.kind === 'text' || control.kind === 'number') {
    const input = TextInput({
      value: (() => {
        const v = bag[control.key];
        return v == null ? '' : String(v);
      })(),
      disabled,
      attrs: control.kind === 'number' ? { type: 'number' } : {},
      on: {
        input: (e) => {
          const raw = (e.target as HTMLInputElement).value;
          if (raw === '') delete bag[control.key];
          else if (control.kind === 'number') {
            const n = Number(raw);
            // A half-typed number („-", „1e") is not a value yet. Keeping the last good
            // one would silently disagree with what is on screen, so the key goes until
            // the field parses again.
            if (Number.isFinite(n)) bag[control.key] = n;
            else delete bag[control.key];
          } else bag[control.key] = raw;
        },
      },
    });
    return el('div', {}, [Field({ ...common, control: input }), note(control)]);
  }

  if (control.kind === 'strings') {
    const values = stringsValue(bag[control.key]);
    bag[control.key] = values;
    const rows = values.map((value, index) =>
      rowTools([
        TextInput({
          value,
          disabled,
          on: {
            input: (e) => {
              values[index] = (e.target as HTMLInputElement).value;
            },
          },
        }),
        Button({
          label: 'Entfernen',
          variant: 'danger',
          disabled,
          on: {
            click: () => {
              values.splice(index, 1);
              rerender();
            },
          },
        }),
      ]),
    );
    return el('div', { class: 'plugin-config-field' }, [
      Field({ ...common, control: el('div', { class: 'plugin-config-rows' }, rows) }),
      note(control),
      Button({
        label: '+ Wert',
        variant: 'outline',
        disabled,
        on: {
          click: () => {
            values.push('');
            rerender();
          },
        },
      }),
    ]);
  }

  if (control.kind === 'map') {
    const key = slot(row.id, control.key);
    const entries = mapRows.get(key) ?? mapEntries(bag[control.key]);
    mapRows.set(key, entries);
    const sync = () => {
      bag[control.key] = entriesToMap(entries);
    };
    sync();
    const rows = entries.map((entry, index) =>
      rowTools([
        TextInput({
          value: entry[0],
          placeholder: 'Schlüssel',
          disabled,
          on: {
            input: (e) => {
              entries[index][0] = (e.target as HTMLInputElement).value;
              sync();
            },
          },
        }),
        TextInput({
          value: entry[1],
          placeholder: 'Wert',
          disabled,
          on: {
            input: (e) => {
              entries[index][1] = (e.target as HTMLInputElement).value;
              sync();
            },
          },
        }),
        Button({
          label: 'Entfernen',
          variant: 'danger',
          disabled,
          on: {
            click: () => {
              entries.splice(index, 1);
              sync();
              rerender();
            },
          },
        }),
      ]),
    );
    return el('div', { class: 'plugin-config-field' }, [
      Field({ ...common, control: el('div', { class: 'plugin-config-rows' }, rows) }),
      note(control),
      Button({
        label: '+ Eintrag',
        variant: 'outline',
        disabled,
        on: {
          click: () => {
            entries.push(['', '']);
            sync();
            rerender();
          },
        },
      }),
    ]);
  }

  // Everything the schema does not describe well enough to draw: a nested object, a list
  // of objects, a key with no type. One field rather than a guessed control, because a
  // control that stores the wrong shape is worse than a field that says „JSON".
  const key = slot(row.id, control.key);
  const value = bag[control.key];
  const area = TextArea({
    value: texts.get(key) ?? (value === undefined ? '' : JSON.stringify(value, null, 2)),
    rows: 4,
    mono: true,
    disabled,
    attrs: { spellcheck: 'false' },
    on: {
      input: (e) => {
        texts.set(key, (e.target as HTMLTextAreaElement).value);
      },
    },
  });
  return el('div', {}, [Field({ label, hint: hint(control), control: area }), note(control)]);
}

/** The schema's own `description`, where it wrote one. */
function note(control: ConfigControl): HTMLElement | null {
  if (!control.description) return null;
  return Text({ as: 'p', text: control.description, tone: 'muted', size: 'xs' });
}

function card(row: PluginSettingsRow, editable: boolean, sourceId: string, root: HTMLElement): HTMLElement {
  const notice = notices.get(row.id) ?? '';
  const status = Text({
    as: 'p',
    text: notice,
    tone: 'muted',
    size: 'xs',
    attrs: { role: 'status' },
  });

  const toggle = Checkbox({
    label: 'In dieser Timeline aktiv',
    checked: row.enabledHere,
    // Not offerable → no switch to flip; not editable → nothing here may be written.
    // Both are said in words elsewhere on the card, so the control only has to be inert.
    disabled: !row.offerable || !editable,
  });

  const publish = row.publishable
    ? Checkbox({
        label: 'Daten dieses Plugins öffentlich lesbar',
        checked: row.public,
        disabled: !row.enabledHere || !editable,
      })
    : null;

  const form = configForm(row.configSchema);
  const disabled = !row.enabledHere || !editable;
  const bag = draftFor(row);
  const rerender = () => mountPluginsSection(root);

  /**
   * The bag as it would be stored. Only a JSON control can fail here — every other
   * control produces a value of the declared shape by construction, which is the point
   * of deriving the form from the schema.
   */
  function collect(): { config: Record<string, unknown> } | { error: string } {
    if (!form) return { config: {} };
    if (form.kind === 'freeform') {
      const text = texts.get(slot(row.id)) ?? (Object.keys(bag).length ? JSON.stringify(bag, null, 2) : '');
      if (!text.trim()) return { config: {} };
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { error: 'Die Konfiguration muss ein JSON-Objekt sein.' };
        }
        return { config: parsed as Record<string, unknown> };
      } catch (e) {
        return { error: `Kein gültiges JSON: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    for (const control of form.controls) {
      if (control.kind !== 'json') continue;
      const text = texts.get(slot(row.id, control.key));
      if (text === undefined) continue;
      if (!text.trim()) {
        delete bag[control.key];
        continue;
      }
      try {
        bag[control.key] = JSON.parse(text);
      } catch (e) {
        return {
          error: `${control.key}: kein gültiges JSON (${e instanceof Error ? e.message : String(e)})`,
        };
      }
    }
    return { config: pruneEmpty(bag, new Set(form.controls.map((c) => c.key))) };
  }

  const configNodes: (HTMLElement | null)[] = form
    ? form.kind === 'freeform'
      ? [
          Field({
            label: 'Konfiguration (JSON)',
            hint: 'das Manifest nennt keine Schlüssel',
            control: TextArea({
              value: texts.get(slot(row.id)) ?? (Object.keys(bag).length ? JSON.stringify(bag, null, 2) : ''),
              rows: 6,
              mono: true,
              disabled,
              attrs: { spellcheck: 'false' },
              on: {
                input: (e) => texts.set(slot(row.id), (e.target as HTMLTextAreaElement).value),
              },
            }),
          }),
        ]
      : form.controls.map((control) => controlNode(row, control, bag, disabled, rerender))
    : [];

  // Kept rather than normalised away: a form that writes back only what it drew is how a
  // stored value disappears because the manifest moved on.
  const undeclared = undeclaredKeys(row.config, form);
  const undeclaredNote = undeclared.length
    ? Text({
        as: 'p',
        text: `Nicht im Manifest erklärt und unverändert übernommen: ${undeclared.join(', ')}.`,
        tone: 'muted',
        size: 'xs',
      })
    : null;

  const save = form
    ? Button({
        label: 'Konfiguration speichern',
        variant: 'outline',
        attrs: { hidden: disabled },
      })
    : null;

  async function write(action: () => Promise<void>, done: string): Promise<void> {
    status.textContent = 'Wird gespeichert …';
    try {
      await action();
      notices.set(row.id, done);
      // The enabled set decides which views appear in the bar, which fields the item
      // form shows and which data loads, so the whole timeline is re-read rather than
      // this list patched. Leaving that out left a switched-off plugin's view control
      // standing in the toolbar, offering a presentation the timeline no longer has.
      await refreshTimeline?.();
      mountPluginsSection(root);
    } catch (e) {
      // The server's own message: a refusal here says which config key is wrong or
      // that the plugin is switched off instance-wide, and both are actionable.
      status.textContent = e instanceof Error ? e.message : String(e);
      toggle.querySelector('input')!.checked = row.enabledHere;
    }
  }

  toggle.querySelector('input')!.addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (on) {
      const collected = collect();
      if ('error' in collected) {
        status.textContent = collected.error;
        (e.target as HTMLInputElement).checked = false;
        return;
      }
      void write(() => apiEnablePlugin(sourceId, row.id, { config: collected.config }), 'Aktiviert.');
    } else {
      // The config belongs to the enablement row, so disabling takes it with it: the rows
      // the plugin owns are what survives (docs/plugin-lifecycle.md). The draft stays, so
      // switching back on restores it instead of enabling the plugin with an empty bag.
      // For a plugin whose config names its versions, that would bring the view back
      // unable to render data that is still there.
      void write(() => apiDisablePlugin(sourceId, row.id), 'Deaktiviert, Daten bleiben erhalten.');
    }
  });

  publish?.querySelector('input')!.addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    void write(
      () => apiEnablePlugin(sourceId, row.id, { public: on }),
      on ? 'Öffentlich lesbar.' : 'Nicht mehr öffentlich lesbar.',
    );
  });

  save?.addEventListener('click', () => {
    const collected = collect();
    if ('error' in collected) {
      status.textContent = collected.error;
      return;
    }
    // Forgotten on success, so the card comes back showing what the server stored rather
    // than what was typed at it.
    forget(row.id);
    void write(
      () => apiEnablePlugin(sourceId, row.id, { config: collected.config }),
      'Konfiguration gespeichert.',
    );
  });

  const head = el('div', { class: 'field-card-head' }, [
    el('div', { class: 'plugin-card-title' }, [
      el('span', { class: 'field-card-title' }, row.name),
      Badge({ label: row.version, tone: 'neutral' }),
    ]),
    el(
      'span',
      { class: 'plugin-card-state', ...(row.problem ? { title: row.problem } : {}) },
      stateText(row),
    ),
  ]);

  return el('div', { class: 'plugin-card field-card' }, [
    head,
    // The two manifest facts as one block: they are read together („what would this
    // plugin do here"), and the card's own spacing pushes them apart into two
    // unrelated sentences.
    el('div', { class: 'plugin-card-facts' }, [
      factLine('Berechtigungen', row.capabilities),
      factLine('Darstellungen', row.views),
    ]),
    row.offerable ? toggle : null,
    publish,
    configNodes.length ? el('div', { class: 'plugin-config' }, [...configNodes, undeclaredNote]) : null,
    save || notice ? el('div', { class: 'settings-actions' }, [save, status]) : null,
  ]);
}

/**
 * Mount the section. The registry is fetched once per session and kept, because it is
 * instance state that an enable here cannot change — what does change is the timeline,
 * and that is re-read from the source on every write.
 */
export function mountPluginsSection(root: HTMLElement): void {
  const view = state.activeView;
  const file = state.activeSourceFile;
  if (!view || !file) {
    root.replaceChildren(Callout({ text: 'Keine Timeline geladen. Öffne eine und komm zurück.' }));
    return;
  }

  if (!installed) {
    root.replaceChildren(Text({ as: 'p', text: 'Plugins werden geladen …', tone: 'muted' }));
    void loadPluginStatuses(state.config?.plugins).then((list) => {
      installed = list;
      mountPluginsSection(root);
    });
    return;
  }

  const editable = state.activeSourceEditable;
  const rows = pluginSettingsRows(installed, file.plugins ?? [], state.pluginLoad ?? []);

  root.replaceChildren(
    el('div', { class: 'settings-form plugin-cards' }, [
      editable
        ? null
        : Callout({
            tone: 'warning',
            text:
              'Diese Timeline ist hier nicht bearbeitbar, deshalb ist nur zu lesen, welche Plugins sie nutzt. ' +
              'Woran das liegt, steht im Badge neben ihrem Namen.',
          }),
      rows.length
        ? null
        : Callout({
            text:
              'Auf dieser Instanz ist kein Plugin installiert. Installiert wird instanzweit, ' +
              'hier wird nur entschieden, welche dieser Timeline gehören.',
          }),
      ...rows.map((row) => card(row, editable, view.source.id, root)),
      rows.length
        ? Text({
            as: 'p',
            text:
              'Ausschalten löscht die Daten eines Plugins nicht: sie bleiben liegen und sind wieder da, ' +
              'sobald es hier erneut aktiv ist. Die Konfiguration gehört zur Aktivierung und geht mit ' +
              'ihr. Sie steht danach noch im Feld, solange dieser Bereich offen bleibt.',
            tone: 'muted',
            size: 'xs',
          })
        : null,
    ]),
  );
}

/** Forget the drafts when the section closes, so a reopen shows what is stored. */
export function unmountPlugins(): void {
  drafts.clear();
  mapRows.clear();
  texts.clear();
  notices.clear();
}
