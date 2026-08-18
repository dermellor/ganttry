// Which plugins this timeline carries, as a control rather than as a row somebody
// writes by hand (#85).
//
// **Installed and enabled are two different questions**, and this section answers
// only the second. The instance decides what exists and what it grants; a timeline
// decides which of those it switches on. Keeping them apart is what „Installed
// (instance) versus enabled (timeline)" (docs/plugin-lifecycle.md) exists for, and
// it is why switching a plugin off here deletes one row and touches none of the
// plugin's data: switching it on again finds everything where it was.
//
// The rule half — what to list and what to refuse — is in `pluginRows.ts`, which
// is DOM-free and tested. This file draws it.

import { Callout, Checkbox, Text, el } from './design-system';
import { apiDisablePlugin, apiEnablePlugin } from './editor';
import { t } from './i18n';
import { pluginRows, type PluginRow } from './pluginRows';
import { loadPluginStatuses } from './pluginPanel';
import { renderTimeline } from './render';
import { state } from './state';
import type { PluginStatus } from './types';

/** The reader's wording for a reason the server reported as a code. */
function refusalText(reason: NonNullable<PluginRow['refusal']>): string {
  if (reason === 'disabled') return t('refusal.plugin.disabled');
  if (reason === 'api-version') return t('refusal.plugin.apiVersion');
  return t('refusal.plugin.invalidManifest');
}

function row(
  entry: PluginRow,
  opts: { editable: boolean; onToggle: (id: string, on: boolean) => void },
): HTMLElement {
  // A colon after each label, because the values carry colons of their own
  // („items:read", „data:own") and without one the line reads as a single run:
  // „Capabilities items:read, fields, views Pricing".
  const meta = [
    `${t('plugins.version')}: ${entry.version}`,
    entry.capabilities.length
      ? `${t('plugins.capabilities')}: ${entry.capabilities.join(', ')}`
      : null,
    entry.views.length ? `${t('plugins.views')}: ${entry.views.join(', ')}` : null,
  ].filter(Boolean) as string[];

  return el('div', { class: 'plugin-row' }, [
    el('div', { class: 'plugin-row-head' }, [
      Text({ text: entry.name }),
      entry.refusal
        ? null
        : Checkbox({
            label: t('plugins.enabled'),
            checked: entry.enabled,
            disabled: !opts.editable,
            on: {
              change: (e: Event) =>
                opts.onToggle(entry.id, (e.currentTarget as HTMLInputElement).checked),
            },
          }),
    ]),
    Text({ as: 'p', text: meta.join(' · '), tone: 'muted', size: 'sm' }),
    entry.refusal
      ? Callout({ tone: 'warning', role: 'note', text: refusalText(entry.refusal) })
      : null,
  ]);
}

export async function mountPluginsSection(root: HTMLElement): Promise<void> {
  const view = state.activeView;
  const editable = state.activeSourceEditable;
  let notice = '';

  // What the instance installed, which is a superset of what the client registry
  // holds: a plugin the host cannot run is refused at registration and would
  // otherwise be invisible here. See `pluginRows.ts`.
  let statuses: PluginStatus[] = [];
  try {
    statuses = await loadPluginStatuses(undefined);
  } catch {
    statuses = [];
  }

  const rerender = (): void => {
    const rows = pluginRows(statuses, state.activeSourceFile);

    const onToggle = (id: string, on: boolean): void => {
      if (!view) return;
      const write = on ? apiEnablePlugin(view.source.id, id) : apiDisablePlugin(view.source.id, id);
      void write
        .then(async () => {
          // The whole view, because a plugin decides item fields, the grouping
          // list, the filter and the presentation bar. Patching each of them from
          // here would be four places to keep in step with a fifth.
          await renderTimeline(view);
          notice = t('timeline.saved');
          rerender();
        })
        .catch((e: unknown) => {
          notice = e instanceof Error ? e.message : String(e);
          rerender();
        });
    };

    root.replaceChildren(
      el('div', { class: 'settings-form' }, [
        ...rows.map((entry) => row(entry, { editable, onToggle })),
        rows.length ? null : Text({ as: 'p', text: t('plugins.none'), tone: 'muted' }),
        notice ? Text({ as: 'p', text: notice, tone: 'muted', size: 'sm' }) : null,
      ]),
    );
  };

  rerender();
}
