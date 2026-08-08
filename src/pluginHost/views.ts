// The DOM a plugin view needs: its button in the header toggle, and its host
// section in the content area.
//
// Both used to be written into index.html, one set per plugin, which is what made
// "add a second view" a change to the core markup. The host creates them from the
// plugin's declared views instead, and owns them here rather than in main.ts so
// that the repaint path (render.ts) can reach a view's container without importing
// the entry module and creating a cycle.

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
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mode-btn';
    btn.dataset.mode = mode;
    btn.title = view.label;
    btn.setAttribute('aria-label', view.label);
    btn.setAttribute('aria-pressed', 'false');
    // Markup the plugin declares: inert SVG, rendered into a button the host owns.
    btn.innerHTML = view.icon;
    btn.addEventListener('click', () => onSelect(mode));
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
    section = document.createElement('section');
    section.id = `plugin-view-${pluginId}-${view.id}`;
    section.className = 'plugin-view';
    section.setAttribute('aria-label', view.label);
    section.hidden = true;
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
