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

import { Badge, Button, Callout, Checkbox, Field, Text, TextArea, el } from './design-system';
import { apiDisablePlugin, apiEnablePlugin } from './editor';
import { loadPluginStatuses } from './pluginPanel';
import {
  configDraftText,
  parseConfigDraft,
  pluginSettingsRows,
  type PluginSettingsRow,
} from './pluginSettings';
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
/** Per plugin id: what the config editor currently holds, and what to say about it. */
const drafts = new Map<string, string>();
const notices = new Map<string, string>();

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

function configLegend(row: PluginSettingsRow): HTMLElement | null {
  if (!row.configKeys?.length) return null;
  return Text({
    as: 'p',
    text:
      'Schlüssel laut Manifest: ' +
      row.configKeys.map((k) => `${k.key} (${k.type}${k.required ? ', erforderlich' : ''})`).join(', '),
    tone: 'muted',
    size: 'xs',
  });
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

  const configField = row.configSchema
    ? TextArea({
        value: drafts.get(row.id) ?? configDraftText(row.config),
        rows: 8,
        mono: true,
        disabled: !row.enabledHere || !editable,
        attrs: { 'data-plugin-config': row.id, spellcheck: 'false' },
      })
    : null;

  if (configField) {
    configField.addEventListener('input', () => drafts.set(row.id, configField.value));
  }

  const save = row.configSchema
    ? Button({
        label: 'Konfiguration speichern',
        variant: 'outline',
        attrs: { hidden: !row.enabledHere || !editable },
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
      const parsed = parseConfigDraft(configField?.value ?? configDraftText(row.config));
      if ('error' in parsed) {
        status.textContent = parsed.error;
        (e.target as HTMLInputElement).checked = false;
        return;
      }
      void write(() => apiEnablePlugin(sourceId, row.id, { config: parsed.config }), 'Aktiviert.');
    } else {
      // The config belongs to the enablement row, so disabling takes it with it — the
      // rows the plugin owns are what survives (docs/plugin-lifecycle.md). Kept in the
      // editor so switching back on restores it instead of enabling the plugin with an
      // empty bag: for a plugin whose config names its versions, that would bring the
      // view back unable to render data that is still there.
      if (Object.keys(row.config).length) drafts.set(row.id, configDraftText(row.config));
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
    const parsed = parseConfigDraft(configField?.value ?? '');
    if ('error' in parsed) {
      status.textContent = parsed.error;
      return;
    }
    drafts.delete(row.id);
    void write(() => apiEnablePlugin(sourceId, row.id, { config: parsed.config }), 'Konfiguration gespeichert.');
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
    configField
      ? el('div', {}, [
          Field({ label: 'Konfiguration (JSON)', control: configField }),
          configLegend(row),
        ])
      : null,
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
  notices.clear();
}
