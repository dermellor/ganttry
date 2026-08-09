// The DOM a plugin view needs: its button in the header toggle, and its host
// section in the content area.
//
// Both used to be written into index.html, one set per plugin, which is what made
// "add a second view" a change to the core markup. The host creates them from the
// plugin's declared views instead, and owns them here rather than in main.ts so
// that the repaint path (render.ts) can reach a view's container without importing
// the entry module and creating a cycle.

import { fromHtml, SegmentedControl, ViewSection } from '../design-system';
import { loadedPluginView, type PluginView } from './registry';
import { parsePluginViewMode, pluginViewMode } from './viewMode';

// Keyed by the addressable mode id, created once and reused: availability is
// re-checked on every view switch, and rebuilding the DOM each time would drop
// focus and churn the toggle.
const buttons = new Map<string, HTMLButtonElement>();
const sections = new Map<string, HTMLElement>();

export function pluginViewButton(
  toggle: HTMLElement,
  pluginId: string,
  view: PluginView,
  onSelect: (mode: string) => void,
): HTMLButtonElement {
  const mode = pluginViewMode(pluginId, view.id);
  let btn = buttons.get(mode);
  if (!btn) {
    // A segment of the header's view switch, so it is built with the same
    // component the built-in Timeline and Liste segments are — a plugin view is
    // a peer of those, and a button that merely resembled them would drift.
    [btn] = Array.from(
      SegmentedControl({
        segments: [
          {
            value: mode,
            label: view.label,
            // Markup the plugin declares: inert SVG, rendered into a segment the
            // host owns.
            icon: fromHtml(view.icon),
            on: { click: () => onSelect(mode) },
          },
        ],
      }).querySelectorAll('button'),
    );
    btn.dataset.mode = mode;
    // The segments live in the host's one control, so the plugin's button is
    // moved out of the throwaway wrapper the component built it in.
    toggle.appendChild(btn);
    buttons.set(mode, btn);
  }
  return btn;
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
      ariaLabel: view.label,
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

/** Show the section for `mode` (if it is a plugin view) and hide every other. */
export function showOnlyPluginSection(mode: string | null): void {
  for (const [sectionMode, section] of sections) section.hidden = sectionMode !== mode;
}

/**
 * Repaint the currently shown plugin view after the data changed. A no-op while
 * the plugin's chunk is still loading (it renders on arrival anyway) and for the
 * built-in modes, which keeps the call sites in render.ts to one line.
 */
export function repaintPluginView(mode: string): void {
  const parsed = parsePluginViewMode(mode);
  if (!parsed) return;
  const section = sections.get(mode);
  if (!section) return;
  loadedPluginView(parsed.pluginId)?.renderView(section, parsed.viewId);
}
