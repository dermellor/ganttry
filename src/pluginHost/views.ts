// The DOM a plugin view needs: its segment in the bar, and its host section in the
// content area.
//
// Both used to be written into index.html, one set per plugin, which is what made
// "add a second view" a change to the core markup. The host creates them from the
// plugin's declared views instead, and owns them here rather than in main.ts so
// that the repaint path (render.ts) can reach a view's container without importing
// the entry module and creating a cycle.
//
// **One control per plugin, not one segment per view.** Every declared view used to
// be appended into the built-in switch as a peer of Timeline and Liste. Measured on
// five plugins declaring three views each: 17 segments in a control that divides its
// width rather than asking for more, 34px each for labels needing 90, and since an
// icon segment shows only its icon, fifteen identical unlabelled squares whose
// meaning was reachable only by hovering one after another. A plugin's views are
// „matrix, cards, board" *of that plugin*, so they sit in that plugin's own control,
// which carries its name inside on the left.

import { fromHtml, SegmentedControl, ViewSection } from '../design-system';
import { manifestText } from './messages';
import { loadedPluginView, pluginById, type PluginView } from './registry';
import { hostApiFor } from './hostBackend';
import { renderPluginViewInto } from './renderView';
import { parsePluginViewMode, pluginViewMode } from './viewMode';

// Keyed by the addressable mode id, created once and reused: availability is
// re-checked on every view switch, and rebuilding the DOM each time would drop
// focus and churn the bar.
const buttons = new Map<string, HTMLButtonElement>();
const sections = new Map<string, HTMLElement>();
// One control per plugin, keyed by plugin id: the unit that is shown, hidden and
// marked active is the plugin, because its views arrive and go together.
const groups = new Map<string, HTMLElement>();

/**
 * The control holding one plugin's views, created once and reused.
 *
 * Built with the same component the built-in switch uses, so a plugin's segments
 * cannot drift from the ones beside them; what differs is the caption inside it,
 * which is the plugin's name. That caption is the only thing that explains the
 * icons, so it is not optional — see the note at the top of this module.
 */
export function pluginViewGroup(
  host: HTMLElement,
  pluginId: string,
  pluginName: string,
  views: readonly PluginView[],
  onSelect: (mode: string) => void,
): HTMLElement {
  let group = groups.get(pluginId);
  if (!group) {
    const firstMode = views[0] ? pluginViewMode(pluginId, views[0].id) : null;
    group = SegmentedControl({
      // The manifest's literal is the fallback, not the value: a manifest cannot
      // call `t()`, so its name and its view labels are looked up in the plugin's
      // own catalogue first. See `manifestText`.
      label: manifestText(pluginId, 'manifest.name', pluginName),
      // The name is the biggest target in the control and reads as the way into
      // the plugin, so it enters it: the first view, which is the one the plugin
      // declares first for that reason. While one of this plugin's views is
      // already showing, it does nothing — throwing a user back from „Karten" to
      // „Matrix" for clicking the plugin's own name is a loss of place, not a
      // shortcut.
      onLabelClick: firstMode
        ? () => {
            if (group?.dataset.active) return;
            onSelect(firstMode);
          }
        : undefined,
      className: 'plugin-view-group',
      attrs: { 'data-plugin': pluginId },
      segments: views.map((view) => {
        const mode = pluginViewMode(pluginId, view.id);
        return {
          value: mode,
          label: manifestText(pluginId, `manifest.view.${view.id}`, view.label),
          // Markup the plugin declares: inert SVG, rendered into a segment the
          // host owns.
          icon: fromHtml(view.icon),
          attrs: { 'data-mode': mode },
          on: { click: () => onSelect(mode) },
        };
      }),
    });
    for (const btn of group.querySelectorAll<HTMLButtonElement>('button')) {
      const mode = btn.dataset.mode;
      if (mode) buttons.set(mode, btn);
    }
    host.appendChild(group);
    groups.set(pluginId, group);
  }
  return group;
}

export function pluginViewSection(
  contentArea: HTMLElement,
  pluginId: string,
  view: PluginView,
): HTMLElement {
  const mode = pluginViewMode(pluginId, view.id);
  let section = sections.get(mode);
  if (!section) {
    // `plain`: the section claims the space and styles nothing. How the view
    // fills it is the plugin's own stylesheet's business.
    section = ViewSection({
      ariaLabel: manifestText(pluginId, `manifest.view.${view.id}`, view.label),
      hidden: true,
      attrs: { id: `plugin-view-${pluginId}-${view.id}` },
    });
    contentArea.appendChild(section);
    sections.set(mode, section);
  }
  return section;
}

export function pluginViewButtons(): ReadonlyMap<string, HTMLButtonElement> {
  return buttons;
}

/** The controls, by plugin id. The unit of showing and hiding. */
export function pluginViewGroups(): ReadonlyMap<string, HTMLElement> {
  return groups;
}

/**
 * Mark the control whose view is active, so the row says *whose* segment is on.
 * `aria-pressed` on the segment alone leaves „some square is dark" as the only
 * signal, and with five plugins that is not an answer.
 */
export function setActivePluginGroup(mode: string): void {
  const owner = parsePluginViewMode(mode)?.pluginId ?? null;
  for (const [pluginId, group] of groups) {
    if (pluginId === owner) group.dataset.active = 'true';
    else delete group.dataset.active;
  }
}

/** Show the section for `mode` (if it is a plugin view) and hide every other. */
export function showOnlyPluginSection(mode: string | null): void {
  for (const [sectionMode, section] of sections) section.hidden = sectionMode !== mode;
}

/**
 * Repaint the currently shown plugin view after the data changed. A no-op while
 * the plugin's chunk is still loading (it renders on arrival anyway) and for the
 * built-in modes, which keeps the call sites in render.ts to one line.
 */
export { renderPluginViewInto };

export function repaintPluginView(mode: string): void {
  const parsed = parsePluginViewMode(mode);
  if (!parsed) return;
  const section = sections.get(mode);
  if (!section) return;
  const plugin = pluginById(parsed.pluginId);
  if (!plugin) return;
  const mod = loadedPluginView(parsed.pluginId);
  if (!mod) return;
  renderPluginViewInto(section, parsed.pluginId, parsed.viewId, mod, hostApiFor(plugin.manifest));
}
