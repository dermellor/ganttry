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
  Button,
  Checkbox,
  ContentArea,
  DescriptionList,
  fromHtml,
  Heading,
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
  Text,
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
  viewToolbar: HTMLElement;
  groupBy: HTMLSelectElement;
  filterControl: HTMLElement;
  filterDim: HTMLSelectElement;
  filterToggle: HTMLButtonElement;
  filterMenu: HTMLElement;
  viewSelect: HTMLSelectElement;
  modeTimelineBtn: HTMLButtonElement;
  modeListBtn: HTMLButtonElement;
  milestonesOnly: HTMLInputElement;
  milestonesControl: HTMLElement;
  presence: HTMLElement;
  membersBtn: HTMLButtonElement;
  addBtn: HTMLButtonElement;
  exportBtn: HTMLButtonElement;
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

/** Builds the interactive shell. Returns the frame's nodes; mounts nothing. */
export function AppShell(): { nodes: HTMLElement[]; els: AppShellElements } {
  const viewSelect = Select({ id: 'view-select', wide: true });

  const modeToggle = SegmentedControl({
    ariaLabel: 'Ansicht',
    attrs: { id: 'mode-toggle' },
    segments: [
      { value: 'timeline', label: 'Timeline', icon: fromHtml(TIMELINE_ICON), selected: true },
      { value: 'list', label: 'Liste', icon: fromHtml(LIST_ICON) },
    ],
  });
  const [modeTimelineBtn, modeListBtn] = Array.from(modeToggle.querySelectorAll('button'));
  modeTimelineBtn.id = 'mode-timeline';
  modeListBtn.id = 'mode-list';

  const milestonesControl = Checkbox({
    id: 'milestones-only',
    label: 'Nur Meilensteine',
    className: 'ds-ToolbarControl',
    attrs: { id: 'milestones-control' },
  });
  const milestonesOnly = milestonesControl.querySelector('input') as HTMLInputElement;

  const presence = AvatarStack({ ariaLabel: 'Online', hidden: true, attrs: { id: 'presence' } });
  // Only an admin is offered the screen (main.ts unhides it). Hiding it is an
  // affordance, never the permission: /api/members refuses anyone else whatever
  // is on screen.
  const membersBtn = Button({
    label: 'Benutzer',
    variant: 'outline',
    ariaLabel: 'Benutzer dieser Instanz verwalten',
    attrs: { id: 'members-btn', hidden: true },
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
          ToolbarControl({ label: 'View', children: viewSelect }),
          modeToggle,
          milestonesControl,
        ],
      }),
      ToolbarGroup({ end: true, children: [presence, membersBtn, addBtn] }),
    ],
  });

  const groupBy = Select({ id: 'groupby' });
  const filterDim = Select({ id: 'filter-dim', attrs: { 'aria-label': 'Filter-Dimension' } });
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
    label: 'Filter',
    // Not a `<label>`: it holds two controls, and a label element would claim
    // only the first of them.
    labelled: false,
    attrs: { id: 'filter-control' },
    children: [filterDim, ToolbarAnchor({ children: [filterToggle, filterMenu] })],
  });

  const viewToolbar = Toolbar({
    tone: 'view',
    attrs: { id: 'view-toolbar' },
    children: [ToolbarControl({ label: 'Gruppieren', children: groupBy }), filterControl],
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
  const main = AppMain({ children: [contentArea, panel.detail] });

  const status = Text({ text: '…', tone: 'muted', attrs: { id: 'status' } });
  const exportBtn = Button({
    label: 'Export HTML',
    variant: 'link',
    ariaLabel: 'Aktuelle View als statische HTML-Datei herunterladen',
    attrs: { id: 'export-btn' },
  });
  const footer = Toolbar({ tone: 'footer', children: [status, exportBtn] });

  return {
    nodes: [header, main, footer],
    els: {
      timeline,
      list,
      listBody,
      contentArea,
      modeToggle,
      viewToolbar,
      groupBy,
      filterControl,
      filterDim,
      filterToggle,
      filterMenu,
      viewSelect,
      modeTimelineBtn,
      modeListBtn,
      milestonesOnly,
      milestonesControl,
      presence,
      membersBtn,
      addBtn,
      exportBtn,
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

