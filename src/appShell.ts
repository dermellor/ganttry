// The application frame, assembled from design-system components.
//
// It exists because there were two copies of this markup: the static shell in
// index.html and the one `src/export.ts` writes into every exported HTML file.
// They had already diverged in the ways two hand-kept copies do — the export's
// panel had no tools row and no id on its meta list — and each new control had
// to be added twice or silently only work in the app.
//
// So the frame is built here once, in two modes:
//
//   'app'     the full interactive shell, mounted into <body> at startup
//   'export'  the reading-only subset, rendered to a string by export.ts
//
// The export is not a stripped-down copy but the same components with the
// interactive parts left out, which is what keeps a change to the panel or the
// toolbar reaching both.
//
// Mounting happens before `state.ts` builds its element map, and that ordering
// is why `mountAppShell` returns the elements rather than the app looking them
// up: an id lookup depends on the shell already being in the document, which is
// exactly the kind of implicit ordering that breaks the first time somebody
// reorders two imports.

import {
  AppMain,
  AppMark,
  AvatarStack,
  Badge,
  Button,
  Checkbox,
  ContentArea,
  DescriptionList,
  el,
  fromHtml,
  Heading,
  IconButton,
  html,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTools,
  Prose,
  Popover,
  ScrollArea,
  SegmentedControl,
  Select,
  SuggestList,
  Tabs,
  Text,
  TextInput,
  Toolbar,
  ToolbarAnchor,
  ToolbarControl,
  ToolbarGroup,
  ViewSection,
} from './design-system';

/** The nodes the app wires behaviour to. `state.ts` re-exports this as `els`. */
export type AppShellElements = {
  timeline: HTMLElement;
  list: HTMLElement;
  listBody: HTMLElement;
  contentArea: HTMLElement;
  modeToggle: HTMLElement;
  groupBy: HTMLSelectElement;
  groupByControl: HTMLElement;
  filterControl: HTMLElement;
  filterToggle: HTMLButtonElement;
  filterMenu: HTMLElement;
  switcherBtn: HTMLButtonElement;
  switcherControl: HTMLElement;
  switcherSearch: HTMLInputElement;
  switcherSearchWrap: HTMLElement;
  switcherList: HTMLElement;
  modeTimelineBtn: HTMLButtonElement;
  modeListBtn: HTMLButtonElement;
  presence: HTMLElement;
  sourceOrigin: HTMLElement;
  settingsBtn: HTMLButtonElement;
  settings: HTMLElement;
  settingsNav: HTMLElement;
  settingsHeading: HTMLHeadingElement;
  settingsBody: HTMLElement;
  settingsClose: HTMLButtonElement;
  tlSettings: HTMLElement;
  tlSettingsNav: HTMLElement;
  tlSettingsHeading: HTMLHeadingElement;
  tlSettingsBody: HTMLElement;
  tlSettingsClose: HTMLButtonElement;
  tlSettingsBtn: HTMLButtonElement;
  addBtn: HTMLButtonElement;
  exportBtn: HTMLButtonElement;
  pluginsBtn: HTMLButtonElement;
  pluginsPanel: HTMLElement;
  status: HTMLElement;
  detail: HTMLElement;
  detailTitle: HTMLHeadingElement;
  detailTools: HTMLElement;
  detailMeta: HTMLDListElement;
  detailBody: HTMLElement;
  detailClose: HTMLButtonElement;
};

const TIMELINE_ICON = `
<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
  <line x1="4" y1="6" x2="14" y2="6" />
  <line x1="9" y1="12" x2="20" y2="12" />
  <line x1="4" y1="18" x2="12" y2="18" />
</svg>`;

const GEAR_ICON = `
<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="3" />
  <path d="M12 3.5v2M12 18.5v2M4.9 7.5l1.8 1M17.3 15.5l1.8 1M4.9 16.5l1.8-1M17.3 8.5l1.8-1" />
</svg>`;

const LIST_ICON = `
<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
  <line x1="9" y1="6" x2="20" y2="6" />
  <line x1="9" y1="12" x2="20" y2="12" />
  <line x1="9" y1="18" x2="20" y2="18" />
  <circle cx="4.5" cy="6" r="1.1" fill="currentColor" stroke="none" />
  <circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
  <circle cx="4.5" cy="18" r="1.1" fill="currentColor" stroke="none" />
</svg>`;

type DetailPanelParts = {
  detail: HTMLElement;
  detailTitle: HTMLHeadingElement;
  detailTools: HTMLElement;
  detailMeta: HTMLDListElement;
  detailBody: HTMLElement;
  detailClose: HTMLButtonElement;
};

/**
 * The detail panel, in both modes. The export gets it without the tools row,
 * because there is nothing to edit there; everything else — the sticky header,
 * the close button, the meta list, the prose body — is identical and used to be
 * written out twice.
 */
function detailPanel(interactive: boolean): DetailPanelParts {
  const detailTitle = Heading({ level: 2, attrs: { id: 'detail-title' } });
  const detailTools = PanelTools({ hidden: true, attrs: { id: 'detail-tools' } });
  const header = PanelHeader({ title: detailTitle, tools: interactive ? detailTools : undefined });
  const detailMeta = DescriptionList({ attrs: { id: 'detail-meta' } });
  // The exported page only ever shows a rendered note, so there the body it
  // writes into *is* a `Prose`. In the app the same element also holds the edit
  // form, so the prose styling goes on a wrapper `showDetail` puts inside it —
  // carried on the body itself it reached the form too, and `.ds-Prose code`
  // turned the audit block's item id into a grey pill.
  const detailBody = interactive
    ? PanelBody({ attrs: { id: 'detail-body' } })
    : Prose({ attrs: { id: 'detail-body' }, className: 'ds-Panel-body' });
  const detail = Panel({
    hidden: true,
    attrs: { id: 'detail' },
    children: [header, detailMeta, detailBody],
  });
  return {
    detail,
    detailTitle,
    detailTools,
    detailMeta,
    detailBody,
    detailClose: header.querySelector('.ds-Panel-close') as HTMLButtonElement,
  };
}

/** The nodes one settings area is made of. */
export type SettingsFrame = {
  root: HTMLElement;
  nav: HTMLElement;
  heading: HTMLHeadingElement;
  body: HTMLElement;
  close: HTMLButtonElement;
};

/**
 * A settings area: a section list beside a panel, replacing the content rather
 * than floating over it.
 *
 * Beside the content and not inside it, because an area is not a view (a view
 * names a timeline source); and not a dialog, because a dialog is the wrong size
 * for a surface that grows a section per concern — the membership screen was one,
 * and that is what this replaced.
 *
 * Only the frame is built here. Each section mounts its own body when opened, so
 * nothing a section needs is in the document for the visitors who never open it.
 *
 * Deliberately not `Panel`: that one is the overlay drawer, positioned over the
 * chart so opening an item does not resize vis-timeline. `settings.css` arranges
 * the two columns for both areas, keyed on the shared `.settings` class.
 */
function settingsFrame(id: string, title: string, closeLabel: string): SettingsFrame {
  const nav = Tabs({
    orientation: 'vertical',
    ariaLabel: 'Bereiche',
    className: 'settings-nav',
    attrs: { id: `${id}-nav` },
  });
  const heading = Heading({ level: 2, attrs: { id: `${id}-heading` } });
  const body = ScrollArea({ attrs: { id: `${id}-body` } });
  const close = IconButton({
    icon: '×',
    ariaLabel: closeLabel,
    boxSize: 'lg',
    attrs: { id: `${id}-close` },
  });
  const root = ViewSection({
    ariaLabel: title,
    hidden: true,
    className: 'settings',
    attrs: { id },
    children: [
      nav,
      el('div', { class: 'settings-panel' }, [
        el('div', { class: 'settings-head' }, [heading, close]),
        body,
      ]),
    ],
  });
  return { root, nav, heading, body, close };
}

/** Builds the interactive shell. Returns the frame's nodes; mounts nothing. */
export function AppShell(): { nodes: HTMLElement[]; els: AppShellElements } {
  // The open timeline, as a trigger rather than a `<select>`: the list is searched
  // and grouped by origin, neither of which a select can do, and the trigger doubles
  // as the statement of which document you are in (see src/timelineSwitcher.ts).
  const switcherBtn = Button({
    label: 'Timeline',
    variant: 'trigger',
    attrs: {
      id: 'switcher-btn',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-controls': 'switcher-list',
    },
  });
  const switcherSearch = TextInput({
    id: 'switcher-search',
    placeholder: 'Suchen…',
    bare: true,
    attrs: { autocomplete: 'off', role: 'combobox', 'aria-controls': 'switcher-list', 'aria-expanded': 'true' },
  });
  const switcherSearchWrap = el(
    'div',
    { class: 'switcher-search', hidden: true },
    switcherSearch,
  );
  const switcherList = SuggestList({
    hidden: true,
    ariaLabel: 'Timelines',
    attrs: { id: 'switcher-list' },
  });
  const switcherControl = ToolbarControl({
    labelled: false,
    label: 'Timeline',
    attrs: { id: 'switcher-control' },
    children: ToolbarAnchor({ children: [switcherBtn, switcherSearchWrap, switcherList] }),
  });

  const modeToggle = SegmentedControl({
    // „Darstellung", not „Ansicht": in the code a `View` is a registered timeline
    // (`config.views[]`, `?view=`), so the interface must not spend the same word on
    // the way one is drawn. See „What this leaves alone" in
    // docs/information-architecture.md.
    ariaLabel: 'Darstellung',
    attrs: { id: 'mode-toggle' },
    segments: [
      { value: 'timeline', label: 'Timeline', icon: fromHtml(TIMELINE_ICON), selected: true },
      { value: 'list', label: 'Liste', icon: fromHtml(LIST_ICON) },
    ],
  });
  const [modeTimelineBtn, modeListBtn] = Array.from(modeToggle.querySelectorAll('button'));
  modeTimelineBtn.id = 'mode-timeline';
  modeListBtn.id = 'mode-list';

  // Filled by `showSourceOrigin` once a source has loaded, because until then
  // „Datenbank" or „Lokal" would be a claim about nothing. Hidden rather than
  // empty: an empty pill reads as a value that failed to arrive.
  const sourceOrigin = Badge({ label: '', hidden: true, attrs: { id: 'source-origin' } });
  // The way into what is true of this timeline as a whole. It sits with the
  // timeline's own identity rather than next to „Einstellungen" on the right:
  // that one is the instance, and putting the two side by side is what made the
  // header unreadable in the first place. Unhidden by main.ts for a role that may
  // write — an affordance, never the permission.
  const tlSettingsBtn = IconButton({
    icon: fromHtml(GEAR_ICON),
    ariaLabel: 'Einstellungen dieser Timeline',
    boxSize: 'md',
    attrs: { id: 'tl-settings-btn', hidden: true },
  });
  const presence = AvatarStack({ ariaLabel: 'Online', hidden: true, attrs: { id: 'presence' } });
  // Only an admin is offered the area (main.ts unhides it). Hiding it is an
  // affordance, never the permission: /api/settings and /api/members refuse
  // anyone else whatever is on screen.
  const settingsBtn = Button({
    label: 'Einstellungen',
    variant: 'outline',
    ariaLabel: 'Einstellungen dieser Instanz',
    attrs: { id: 'settings-btn', hidden: true },
  });
  const addBtn = Button({
    label: '+ Eintrag',
    variant: 'outline',
    ariaLabel: 'Neuen Eintrag hinzufügen',
    attrs: { id: 'add-btn', hidden: true },
  });

  const header = Toolbar({
    tone: 'header',
    children: [
      ToolbarGroup({
        children: [
          AppMark(),
          // Classed so the settings area can hide the controls that steer a
          // timeline while it is open — see src/styles/settings.css. The mark
          // stays, so the header does not collapse to an empty bar.
          //
          // What is left here identifies: the instance (mark, settings) and which
          // timeline is open. Everything about *how* it is drawn moved into the
          // bar below (see „Where every control belongs" in
          // docs/information-architecture.md).
          // The open timeline, as one group: which one it is, where it comes
          // from, and who else is looking at it. Presence used to sit on the
          // right among the instance controls, which said it was about the
          // deployment; a session joins per timeline (see „Where every control
          // belongs" in docs/information-architecture.md).
          el('div', { class: 'app-timeline-controls' }, [
            switcherControl,
            sourceOrigin,
            tlSettingsBtn,
            presence,
          ]),
        ],
      }),
      ToolbarGroup({ end: true, children: [settingsBtn] }),
    ],
  });

  const groupBy = Select({ id: 'groupby' });
  // Kept as a node rather than inlined into the bar: the presentation declares
  // which accessories apply (see main.ts), so each of them has to be hideable on
  // its own.
  const groupByControl = ToolbarControl({
    label: 'Gruppieren',
    attrs: { id: 'groupby-control' },
    children: groupBy,
  });
  // No dimension dropdown beside it any more: the panel holds every dimension at
  // once, so picking one was a step that bought nothing and a limit that cost the
  // combination of two narrowings (see src/filterControl.ts).
  const filterToggle = Button({
    label: 'Alle Werte',
    variant: 'trigger',
    attrs: { id: 'filter-toggle', 'aria-haspopup': 'true', 'aria-expanded': 'false', hidden: true },
  });
  const filterMenu = Popover({
    role: 'group',
    ariaLabel: 'Filterwerte',
    scroll: true,
    hidden: true,
    attrs: { id: 'filter-menu' },
  });
  const filterControl = ToolbarControl({
    // Not a `<label>`: the trigger is a button, and a label element pointing at it
    // would duplicate its own accessible name.
    labelled: false,
    label: 'Filter',
    attrs: { id: 'filter-control' },
    children: ToolbarAnchor({ children: [filterToggle, filterMenu] }),
  });

  const exportBtn = Button({
    label: 'Export HTML',
    variant: 'outline',
    ariaLabel: 'Aktuelle Darstellung als statische HTML-Datei herunterladen',
    attrs: { id: 'export-btn' },
  });

  // The presentation level, in one bar and in the order the three actions happen:
  // a presentation is *chosen*, a perspective is *set*, an extent is *narrowed* —
  // then the things you *do* to what is on screen, pushed to the far end.
  //
  // Before this the switch and one narrowing sat in the header, the perspective and
  // the other narrowing here, „+ Eintrag" among the instance controls and „Export
  // HTML" in the status line. Four places for one level, so the row you were
  // reading never said what a click would change.
  //
  // Which of the two middle controls a presentation gets is declared by that
  // presentation (see „Accessories" in docs/architecture.md). The bar itself is
  // never hidden any more: it carries the switch, so hiding it would strand
  // whoever is in a plugin view with no way back.
  const viewToolbar = Toolbar({
    tone: 'view',
    attrs: { id: 'view-toolbar' },
    children: [
      ToolbarGroup({ children: [modeToggle, groupByControl, filterControl] }),
      ToolbarGroup({ end: true, children: [addBtn, exportBtn] }),
    ],
  });

  const timeline = ViewSection({
        tone: 'chart',
        ariaLabel: 'Timeline',
        // `timeline` is the chart adapter's own hook: src/styles/timeline.css
        // scopes vis-timeline's furniture — the item rail, the status marks, the
        // phase band — to it. Not a design-system class, and deliberately so
        // (docs/design-system.md → „What is not in the design system").
        className: 'timeline',
        attrs: { id: 'timeline' },
      });
  const listBody = ScrollArea({ attrs: { id: 'list-body' } });
  const list = ViewSection({
    ariaLabel: 'Liste',
    hidden: true,
    attrs: { id: 'list' },
    children: listBody,
  });

  const contentArea = ContentArea({
    attrs: { id: 'content-area' },
    children: [viewToolbar, timeline, list],
  });

  const panel = detailPanel(true);

  // Two areas of the same shape: one for what is true of the instance, one for what
  // is true of the open timeline. Built from one function rather than twice, since
  // the second one arrived by copying the first in the draft and the copies had
  // already drifted apart by a heading level.
  const instanceArea = settingsFrame('settings', 'Einstellungen', 'Einstellungen schließen');
  const timelineArea = settingsFrame(
    'timeline-settings',
    'Timeline-Einstellungen',
    'Timeline-Einstellungen schließen',
  );

  const main = AppMain({
    children: [contentArea, instanceArea.root, timelineArea.root, panel.detail],
  });

  const status = Text({ text: '…', tone: 'muted', attrs: { id: 'status' } });
  // Which plugins this instance has, and why one of them is not running. It sits
  // in the footer rather than in a settings screen because the answer is usually
  // wanted while looking at a timeline that is missing something.
  const pluginsBtn = Button({
    label: 'Plugins',
    variant: 'link',
    ariaLabel: 'Installierte Plugins und ihr Zustand',
    attrs: { id: 'plugins-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
  });
  const pluginsPanel = el('div', {
    id: 'plugins-panel',
    class: 'plugin-panel',
    role: 'group',
    'aria-label': 'Plugins',
    hidden: true,
  });
  // The panel is absolutely positioned above its button, so it needs a
  // positioned ancestor of its own: anchored to the footer instead, it would sit
  // wherever the footer's box happens to be rather than over the control that
  // opened it.
  const pluginsWrap = el('div', { class: 'plugin-panel-wrap' }, [pluginsBtn, pluginsPanel]);
  // Status plus the one thing here that is about the deploy rather than about the
  // timeline. „Export HTML" left, because it exports the active presentation with
  // its extent and therefore belongs to that presentation, not to a status line.
  const footer = Toolbar({
    tone: 'footer',
    children: [status, el('div', { class: 'footer-actions' }, [pluginsWrap])],
  });

  return {
    nodes: [header, main, footer],
    els: {
      timeline,
      list,
      listBody,
      contentArea,
      modeToggle,
      groupBy,
      groupByControl,
      filterControl,
      filterToggle,
      filterMenu,
      switcherBtn,
      switcherControl,
      switcherSearch,
      switcherSearchWrap,
      switcherList,
      modeTimelineBtn,
      modeListBtn,
      presence,
      sourceOrigin,
      settingsBtn,
      settings: instanceArea.root,
      settingsNav: instanceArea.nav,
      settingsHeading: instanceArea.heading,
      settingsBody: instanceArea.body,
      settingsClose: instanceArea.close,
      tlSettings: timelineArea.root,
      tlSettingsNav: timelineArea.nav,
      tlSettingsHeading: timelineArea.heading,
      tlSettingsBody: timelineArea.body,
      tlSettingsClose: timelineArea.close,
      tlSettingsBtn,
      addBtn,
      exportBtn,
      pluginsBtn,
      pluginsPanel,
      status,
      ...panel,
    },
  };
}

/** Builds the shell and puts it in the document. Called once, from `state.ts`. */
export function mountAppShell(host: HTMLElement = document.body): AppShellElements {
  const { nodes, els } = AppShell();
  host.append(...nodes);
  return els;
}

/**
 * The exported file's frame, as a string. Read-only: no view picker, no mode
 * switch, no filters, no editing — an export is a snapshot, and a control that
 * cannot do anything is worse than an absent one.
 */
export function exportShellHtml(title: string): string {
  const header = Toolbar({
    tone: 'header',
    children: ToolbarGroup({ children: [AppMark(), Heading({ level: 1, text: title })] }),
  });
  const main = AppMain({
    children: [
      ViewSection({
        tone: 'chart',
        ariaLabel: 'Timeline',
        // `timeline` is the chart adapter's own hook: src/styles/timeline.css
        // scopes vis-timeline's furniture — the item rail, the status marks, the
        // phase band — to it. Not a design-system class, and deliberately so
        // (docs/design-system.md → „What is not in the design system").
        className: 'timeline',
        attrs: { id: 'timeline' },
      }),
      detailPanel(false).detail,
    ],
  });
  const footer = Toolbar({
    tone: 'footer',
    children: Text({ text: '…', tone: 'muted', attrs: { id: 'status' } }),
  });
  return [header, main, footer].map(html).join('\n');
}

