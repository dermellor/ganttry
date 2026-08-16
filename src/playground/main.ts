// The design-system playground: every component, every variant, on one page.
//
// It is a second Vite entry (`playground.html`) rather than a route inside the
// app, for two reasons. The app has no router — adding one to host a development
// page would be the tail wagging the dog — and a separate entry is what keeps
// this page's code out of the app's bundle, which
// `scripts/ci/check-bundle-split.sh` asserts rather than trusts.
//
// What it is for: seeing a variant next to its siblings before shipping it. A
// component whose states you can only reach by driving the app through six
// clicks is a component nobody checks, and the empty, error and loading states
// are exactly the ones that rot.
//
// Adding a component to `src/design-system/components/index.ts` and not to this
// page is a mistake the contract check catches (see check-design-system.sh).

import '../design-system';
import './playground.css';
import {
  AppMain,
  AppMark,
  Avatar,
  Badge,
  AvatarStack,
  Button,
  Callout,
  Checkbox,
  Chip,
  ChipBox,
  ChipBoxSlot,
  ContentArea,
  DescriptionList,
  Dialog,
  Disclosure,
  Dot,
  el,
  Field,
  FieldError,
  FieldNote,
  Fieldset,
  FormActions,
  FormGrid,
  fromHtml,
  GraphNode,
  Heading,
  Icon,
  IconButton,
  Label,
  Link,
  Menu,
  MenuItem,
  MenuSection,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTools,
  PickerGrid,
  PickerList,
  Popover,
  Prose,
  ScrollArea,
  SegmentedControl,
  Select,
  Separator,
  SuggestEmpty,
  SuggestItem,
  SuggestList,
  Tab,
  Table,
  TableCell,
  TableGroupRow,
  TableHead,
  TabPanel,
  TableRow,
  Tabs,
  Tag,
  TreeToggle,
  Text,
  TextArea,
  TextInput,
  TimelineSkeleton,
  Toolbar,
  ToolbarAnchor,
  ToolbarControl,
  ToolbarGroup,
  ViewSection,
  StatusDot,
  type Child,
} from '../design-system';
import { TIMELINE_ICON_KEYS } from '../icons';
import { ITEM_STATUSES } from '../status';
import { tokens } from '../design-system/tokens';

/* ------------------------------------------------------------------------- */
/* Page furniture                                                            */
/* ------------------------------------------------------------------------- */

const sections: { id: string; title: string }[] = [];

function section(id: string, title: string, note: string, children: Child): HTMLElement {
  sections.push({ id, title });
  return el('section', { class: 'pg-Section', id }, [
    el('div', { class: 'pg-Section-head' }, [
      Heading({ level: 2, text: title }),
      Text({ as: 'p', text: note, tone: 'muted', size: 'sm' }),
    ]),
    children,
  ]);
}

/** A labelled specimen. The caption names the variant, so a screenshot is legible. */
function specimen(label: string, ...nodes: Child[]): HTMLElement {
  return el('div', { class: 'pg-Specimen' }, [
    el('div', { class: 'pg-Specimen-stage' }, nodes),
    Text({ text: label, tone: 'muted', size: 'xs', className: 'pg-Specimen-label' }),
  ]);
}

/** A row of specimens that wraps. */
function row(...nodes: Child[]): HTMLElement {
  return el('div', { class: 'pg-Row' }, nodes);
}

/** A specimen on a surface, for a component that only makes sense inside one. */
function stage(...nodes: Child[]): HTMLElement {
  return el('div', { class: 'pg-Stage' }, nodes);
}

/* ------------------------------------------------------------------------- */
/* Tokens                                                                    */
/* ------------------------------------------------------------------------- */

function swatch(name: string, value: string): HTMLElement {
  return el('div', { class: 'pg-Swatch' }, [
    el('div', { class: 'pg-Swatch-chip', style: `background:${value}` }),
    Text({ text: name, size: 'xs', className: 'pg-Swatch-name' }),
  ]);
}

function scaleRow(name: string, value: string, render: (value: string) => HTMLElement): HTMLElement {
  return el('div', { class: 'pg-ScaleRow' }, [
    Text({ text: name, size: 'xs', tone: 'muted', className: 'pg-ScaleRow-name' }),
    render(value),
  ]);
}

const colourSection = section(
  'tokens-colour',
  'Farbtokens',
  'Überschreibbar in einem Stylesheet nach tokens.css. Die Namen sind die dokumentierte Theming-Naht.',
  el('div', { class: 'pg-Grid' }, [
    ...Object.entries(tokens.color).map(([key, value]) => swatch(key, value)),
    ...Object.entries(tokens.status).map(([key, value]) => swatch(`status.${key}`, value)),
    ...Object.entries(tokens.lane).map(([key, value]) => swatch(`lane.${key}`, value)),
  ]),
);

const scaleSection = section(
  'tokens-scale',
  'Skalen',
  'Abstand, Radius, Schriftgröße. Ein roher px-Wert in padding, margin oder gap ist genau das, was der Contract-Check ablehnt.',
  el('div', { class: 'pg-Columns' }, [
    el('div', {}, [
      Label({ text: 'space' }),
      ...Object.entries(tokens.space).map(([key, value]) =>
        scaleRow(key, value, (v) => el('div', { class: 'pg-Bar', style: `width:${v}` })),
      ),
    ]),
    el('div', {}, [
      Label({ text: 'radius' }),
      ...Object.entries(tokens.radius).map(([key, value]) =>
        scaleRow(key, value, (v) => el('div', { class: 'pg-Box', style: `border-radius:${v}` })),
      ),
    ]),
    el('div', {}, [
      Label({ text: 'text' }),
      ...Object.entries(tokens.text).map(([key, value]) =>
        scaleRow(key, value, (v) => el('div', { style: `font-size:${v}` }, 'Zeitlines')),
      ),
    ]),
  ]),
);

/* ------------------------------------------------------------------------- */
/* Typography                                                                */
/* ------------------------------------------------------------------------- */

const typographySection = section(
  'typography',
  'Heading · Text · Label',
  'Drei Stimmen: die Serifen-Überschrift, Fließtext, die Versal-Mikrozeile an Bedienelementen und Tabellenköpfen.',
  el('div', { class: 'pg-Stack' }, [
    Heading({ level: 1, text: 'Heading, Level 1' }),
    Heading({ level: 2, text: 'Heading, Level 2' }),
    Heading({ level: 3, text: 'Heading, Level 3' }),
    Text({ as: 'p', text: 'Text, base — Fließtext im Detailbereich.', size: 'base' }),
    Text({ as: 'p', text: 'Text, md — die Größe der Formularfelder.', size: 'md' }),
    Text({ as: 'p', text: 'Text, sm, muted — Sekundärangaben.', size: 'sm', tone: 'muted' }),
    Text({ as: 'p', text: 'Text, danger — eine abgelehnte Eingabe.', size: 'sm', tone: 'danger' }),
    Text({ as: 'p', text: 'Kein Wert hinterlegt', placeholder: true }),
    Label({ text: 'Label', hint: 'mit Hinweis' }),
    el('p', {}, [
      Link({ text: 'Ein Link', href: '#typography' }),
      ' · ',
      Link({ text: 'ZT-142 – ohne Ziel', tabular: true }),
      ' · ',
      Link({ text: 'Extern', href: 'https://example.com', external: true }),
    ]),
  ]),
);

/* ------------------------------------------------------------------------- */
/* Buttons                                                                   */
/* ------------------------------------------------------------------------- */

const PLUS_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

const buttonSection = section(
  'button',
  'Button',
  'Sieben Varianten, weil die Oberfläche vor dem Component sieben Button-Behandlungen in fünf Stylesheets hatte.',
  el('div', { class: 'pg-Stack' }, [
    row(
      ...(['primary', 'outline', 'ghost', 'danger', 'link', 'dashed', 'trigger'] as const).map((variant) =>
        specimen(variant, Button({ label: 'Aktion', variant })),
      ),
    ),
    row(
      specimen('size sm', Button({ label: 'Aktion', size: 'sm' })),
      specimen('size md', Button({ label: 'Aktion', size: 'md' })),
      specimen('mit Icon', Button({ label: 'Eintrag', icon: fromHtml(PLUS_ICON) })),
      specimen('disabled', Button({ label: 'Exportiert…', disabled: true })),
      specimen('block', Button({ label: 'Volle Breite', block: true })),
    ),
    row(
      specimen('trigger, offen', Button({ label: 'Alle Werte', variant: 'trigger', attrs: { 'aria-expanded': 'true' } })),
      specimen(
        'reveal (Hover auf der Fläche)',
        el('div', { class: 'pg-RevealHost' }, [
          Text({ text: 'Gruppenzeile', size: 'sm' }),
          Button({ label: '+ Eintrag', variant: 'outline', size: 'sm', reveal: true }),
        ]),
      ),
    ),
    row(
      ...(['sm', 'md', 'lg'] as const).map((boxSize) =>
        specimen(`IconButton ${boxSize}`, IconButton({ icon: '×', ariaLabel: 'Schließen', boxSize })),
      ),
      specimen(
        'IconButton outline',
        IconButton({ icon: Icon({ name: 'milestone', standalone: true }), ariaLabel: 'Icon', variant: 'outline' }),
      ),
      specimen(
        'IconButton outline, offen',
        IconButton({
          icon: Icon({ name: 'launch', standalone: true }),
          ariaLabel: 'Icon',
          variant: 'outline',
          attrs: { 'aria-expanded': 'true' },
        }),
      ),
    ),
  ]),
);

/* ------------------------------------------------------------------------- */
/* Inputs                                                                    */
/* ------------------------------------------------------------------------- */

const inputSection = section(
  'input',
  'TextInput · TextArea · Select · Checkbox',
  'Fokus färbt den Rahmen statt einen Ring zu zeichnen — bei zwölf Feldern las der Ring als Rahmen um jedes berührte Feld.',
  el('div', { class: 'pg-Stack' }, [
    row(
      specimen('TextInput', TextInput({ value: 'Meilenstein', block: false })),
      specimen('placeholder', TextInput({ placeholder: 'Titel…', block: false })),
      specimen('date', TextInput({ type: 'date', value: '2026-08-09', block: false })),
      specimen('readonly', TextInput({ value: 'aus der Quelle', readonly: true, block: false })),
      specimen('invalid', TextInput({ value: 'Ende vor Start', invalid: true, block: false })),
      specimen('disabled', TextInput({ value: 'gesperrt', disabled: true, block: false })),
    ),
    row(
      specimen(
        'Select',
        Select({
          block: false,
          options: [
            { value: 'a', label: 'Gruppe A' },
            { value: 'b', label: 'Gruppe B' },
          ],
        }),
      ),
      specimen(
        'Select, optgroup',
        Select({
          block: false,
          options: [
            { label: 'Programm', options: [{ value: 'p1', label: 'Phase 1' }, { value: 'p2', label: 'Phase 2' }] },
          ],
        }),
      ),
      specimen('Select, wide', Select({ wide: true, block: false, options: [{ value: 'v', label: 'Produkt-Roadmap' }] })),
      specimen('Checkbox', Checkbox({ label: 'Nur Meilensteine', checked: true })),
      specimen('Checkbox, disabled', Checkbox({ label: 'Nicht verfügbar', disabled: true })),
    ),
    row(
      specimen('TextArea', TextArea({ value: 'Zwei Zeilen\nFließtext', rows: 3, block: false })),
      specimen('TextArea, mono', TextArea({ value: '{ "owner": "ada" }', rows: 3, mono: true, block: false })),
    ),
  ]),
);

/* ------------------------------------------------------------------------- */
/* Marks                                                                     */
/* ------------------------------------------------------------------------- */

const marksSection = section(
  'marks',
  'Icon · StatusDot · Dot · Tag · Avatar',
  'Der Glyph ist eine CSS-Maske, keine Grafik: er nimmt die Textfarbe an und passt damit ohne zweites Asset in jede Lane und jedes Theme.',
  el('div', { class: 'pg-Stack' }, [
    el('div', { class: 'pg-IconGrid' }, [
      // The key rather than the translated label: these sections are module-scope
      // constants, and `t()` there is evaluated before the language is resolved
      // (see „Never call t() at module scope" in src/i18n/index.ts). A specimen
      // page names the vocabulary anyway.
      ...TIMELINE_ICON_KEYS.map((key) =>
        specimen(key, Icon({ name: key, size: 'lg', standalone: true, attrs: { title: key } })),
      ),
      // Every `--ui-icon-*` in icons.css belongs here. The list is hand-kept and had
      // already lost `caret`, which is how a chrome glyph goes years without anyone
      // looking at it — the gear was a sun the whole time it was drawn inline in
      // appShell.ts, outside both this grid and the glyph file.
      ...['delete', 'warning', 'check', 'caret', 'gear', 'menu', 'view'].map((name) =>
        specimen(`ui: ${name}`, Icon({ name, chrome: true, size: 'lg', standalone: true })),
      ),
    ]),
    row(
      ...ITEM_STATUSES.map(({ key }) => specimen(`StatusDot ${key}`, StatusDot({ status: key }))),
      specimen('Dot xs', Dot({ color: '#f32ed4' })),
      specimen('Dot sm', Dot({ color: '#94d825', size: 'sm' })),
      specimen('Dot ohne Farbe', Dot({})),
    ),
    row(
      specimen('Tag', Tag({ label: 'Infra', color: '#2f0d5b' })),
      specimen('Tag, andere Farbe', Tag({ label: 'Vertrieb', color: '#e8ac68' })),
      specimen('Tag, compact', Tag({ label: 'Infra', color: '#2f0d5b', compact: true })),
      specimen('Badge', Badge({ label: 'Eingeladen' })),
      specimen('Badge, accent', Badge({ label: 'Aktiv', tone: 'accent' })),
      specimen('Badge, muted', Badge({ label: 'Gesperrt', tone: 'muted' })),
    ),
    row(
      specimen('Avatar md', Avatar({ initials: 'AM', hue: 260 })),
      specimen('Avatar sm', Avatar({ initials: 'BK', hue: 30, size: 'sm' })),
      specimen('Avatar, self', Avatar({ initials: 'CM', hue: 120, self: true })),
      specimen(
        'AvatarStack',
        AvatarStack({
          children: [
            Avatar({ initials: 'AM', hue: 260, stacked: true }),
            Avatar({ initials: 'BK', hue: 30, stacked: true }),
            Avatar({ initials: 'CM', hue: 120, stacked: true, self: true }),
            Avatar({ initials: '+3', hue: 0, stacked: true, overflow: true }),
          ],
        }),
      ),
    ),
  ]),
);

/* ------------------------------------------------------------------------- */
/* Form                                                                      */
/* ------------------------------------------------------------------------- */

const formSection = section(
  'form',
  'FormGrid · Field · Fieldset · Disclosure · FormActions',
  'Die Luft steht zwischen den Feldern, nie in einem: Label 4px zum Bedienelement, 12px zum nächsten Feld.',
  stage(
    FormGrid({
      children: [
        Field({ label: 'Titel', full: true, control: TextInput({ value: 'Rollout Phase 2' }) }),
        Field({ label: 'Start', control: TextInput({ type: 'date', value: '2026-09-01' }) }),
        Field({ label: 'Ende', hint: 'optional', muted: true, control: TextInput({ type: 'date', value: '' }) }),
        FieldError({ text: 'Das Ende liegt vor dem Start.' }),
        FieldNote({ text: 'Zwei Untereinträge liegen außerhalb dieses Zeitraums.' }),
        Field({
          label: 'Gruppe',
          control: Select({ options: [{ value: 'g', label: 'Plattform' }] }),
        }),
        Field({ label: 'Verantwortlich', control: TextInput({ value: 'Ada Lovelace' }) }),
        Fieldset({
          legend: 'Produkt',
          children: [
            Field({ label: 'Tier', control: Select({ options: [{ value: 't', label: 'Business' }] }) }),
            Field({ label: 'Version', control: TextInput({ value: '4.2' }) }),
          ],
        }),
        Disclosure({
          summary: 'Erweitert',
          children: Field({ label: 'Metadaten', full: true, control: TextArea({ mono: true, rows: 3, value: '{}' }) }),
        }),
        FormActions({ centered: true, children: Button({ label: 'Löschen', variant: 'danger' }) }),
      ],
    }),
  ),
);

/* ------------------------------------------------------------------------- */
/* Chips and suggestions                                                     */
/* ------------------------------------------------------------------------- */

const chipSection = section(
  'chip',
  'Chip · ChipBox · Suggest',
  'Chips und Suchfeld in einer Box, die als ein Bedienelement liest. Das spart pro Feld eine Zeile, weshalb zwei davon nebeneinander passen.',
  el('div', { class: 'pg-Stack' }, [
    row(
      specimen('Chip', Chip({ label: 'Plattform', removable: true })),
      specimen('mit Dot', Chip({ label: 'Infra', mark: Dot({ color: '#f32ed4' }), removable: true })),
      specimen('mit Code', Chip({ code: 'ZT-142', label: 'Rollout vorbereiten', removable: true })),
      specimen('mit Avatar', Chip({ mark: Avatar({ initials: 'AL', hue: 200, size: 'sm' }), label: 'Ada Lovelace', removable: true })),
      specimen('unlinked', Chip({ label: 'a.lovelace (alt)', unlinked: true, removable: true })),
      specimen('movable', Chip({ label: 'Revelations', movable: true, movableLabel: 'Revelations, Eingehend' })),
    ),
    stage(
      FormGrid({
        children: [
          Field({
            label: 'Tags',
            control: ChipBox({
              children: [
                // `ChipBoxSlot` is how the widgets re-render into a stable
                // container without it taking up space of its own.
                ChipBoxSlot({
                  children: [
                    Chip({ label: 'Infra', mark: Dot({ color: '#2f0d5b' }), removable: true }),
                    Chip({ label: 'Vertrieb', mark: Dot({ color: '#e8ac68' }), removable: true }),
                  ],
                }),
                TextInput({ bare: true, placeholder: 'Tag suchen…' }),
              ],
            }),
          }),
          Field({
            label: 'Verantwortlich',
            control: [
              ChipBox({ children: TextInput({ bare: true, placeholder: 'Person suchen…' }) }),
              SuggestList({
                alignEnd: true,
                children: [
                  SuggestItem({
                    mark: Avatar({ initials: 'AL', hue: 200, size: 'sm' }),
                    label: 'Ada Lovelace',
                    detail: 'ada@example.com',
                    active: true,
                  }),
                  SuggestItem({
                    mark: Avatar({ initials: 'GH', hue: 320, size: 'sm' }),
                    label: 'Grace Hopper',
                    detail: 'grace@example.com',
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ),
    row(
      specimen(
        'SuggestItem, stacked',
        el('ul', { class: 'ds-SuggestList pg-StaticList' }, [
          SuggestItem({ layout: 'stacked', code: 'ZT-142', description: 'Rollout vorbereiten', active: true }),
          SuggestItem({ layout: 'stacked', code: 'ZT-143', description: 'Migration der Altdaten' }),
        ]),
      ),
      specimen(
        'SuggestEmpty',
        el('ul', { class: 'ds-SuggestList pg-StaticList' }, SuggestEmpty({ text: 'Kein Verzeichnis erreichbar' })),
      ),
    ),
  ]),
);

/* ------------------------------------------------------------------------- */
/* Menus                                                                     */
/* ------------------------------------------------------------------------- */

const menuSection = section(
  'menu',
  'Popover · Menu · MenuItem · PickerGrid',
  'Vor dem Component waren das vier Kopien derselben Fläche in drei Stylesheets, bereits 2px und einen Schatten auseinander.',
  row(
    specimen(
      'Menu mit Sektionen',
      el('div', { class: 'pg-MenuHost' }, [
        Menu({
          placement: 'fixed',
          layer: 'popover',
          className: 'pg-StaticPopover',
          children: [
            MenuSection({
              ariaLabel: 'Status',
              children: ITEM_STATUSES.map(({ key, label }) =>
                MenuItem({ label, mark: StatusDot({ status: key }), checked: key === 'Doing' }),
              ),
            }),
            MenuSection({
              children: [
                MenuItem({ label: 'Feld setzen', mark: Dot({ color: '#94d825' }), parent: true }),
                MenuItem({ label: 'Kein Wert', none: true, mark: el('span', {}, '—') }),
                MenuItem({ label: 'Löschen', danger: true, mark: Icon({ name: 'delete', chrome: true, standalone: true }) }),
              ],
            }),
            // `wrap`, including the empty section that keeps its caption and its
            // height — the state that is easiest to get wrong and hardest to
            // reach by driving the app.
            MenuSection({
              label: 'Eingehend',
              wrap: true,
              children: [
                Chip({ label: 'Revelations', movable: true, movableLabel: 'Revelations, Eingehend' }),
                Chip({ label: 'Hints', movable: true, movableLabel: 'Hints, Eingehend' }),
              ],
            }),
            MenuSection({ label: 'Ausgehend', wrap: true, children: [] }),
          ],
        }),
      ]),
    ),
    specimen(
      'Sektionen mit Titel (Facetten)',
      el('div', { class: 'pg-MenuHost' }, [
        Popover({
          placement: 'fixed',
          layer: 'popover',
          className: 'pg-StaticPopover',
          children: [
            MenuSection({
              label: 'Status',
              children: ITEM_STATUSES.map(({ key, label }) =>
                Checkbox({ label, value: key, checked: key === 'Open', className: 'ds-MenuItem' }),
              ),
            }),
            MenuSection({
              label: 'Tier',
              children: ['Free', 'Scale'].map((v) =>
                Checkbox({ label: v, value: v, className: 'ds-MenuItem' }),
              ),
            }),
          ],
        }),
      ]),
    ),
    specimen(
      'PickerGrid',
      el('div', { class: 'pg-MenuHost' }, [
        Popover({
          placement: 'fixed',
          className: 'pg-StaticPopover',
          children: PickerGrid({
            children: TIMELINE_ICON_KEYS.slice(0, 12).map((key) =>
              MenuItem({
                cell: true,
                label: key,
                mark: Icon({ name: key, standalone: true }),
                selected: key === 'launch',
              }),
            ),
          }),
        }),
      ]),
    ),
    specimen(
      'PickerList',
      el('div', { class: 'pg-MenuHost' }, [
        Popover({
          placement: 'fixed',
          className: 'pg-StaticPopover',
          children: PickerList({
            children: [
              MenuItem({ label: 'Zeitraum', mark: el('span', {}, '▬'), selected: true }),
              MenuItem({ label: 'Zeitpunkt', mark: el('span', {}, '◆') }),
            ],
          }),
        }),
      ]),
    ),
  ),
);

/* ------------------------------------------------------------------------- */
/* Tabs and segmented control                                                */
/* ------------------------------------------------------------------------- */

const TIMELINE_GLYPH = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="6" x2="14" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="12" y2="18"/></svg>`;
const LIST_GLYPH = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/></svg>`;

// The caption as a target: clicking it selects the first segment, which is what
// a plugin's control does in the app. Wired here so the state is reachable
// without driving the app into a plugin.
function segmentedControlWithLabelAction(): HTMLElement {
  const select = (value: string) => {
    for (const seg of control.querySelectorAll<HTMLButtonElement>('.ds-Segment')) {
      seg.setAttribute('aria-pressed', String(seg.dataset.value === value));
    }
  };
  const control = SegmentedControl({
    label: 'Produkt',
    onLabelClick: () => select('matrix'),
    segments: [
      { value: 'matrix', label: 'Matrix', icon: fromHtml(TIMELINE_GLYPH) },
      { value: 'cards', label: 'Karten', icon: fromHtml(LIST_GLYPH), selected: true },
    ],
  });
  for (const seg of control.querySelectorAll<HTMLButtonElement>('.ds-Segment')) {
    seg.addEventListener('click', () => select(seg.dataset.value ?? ''));
  }
  return control;
}

const selectorSection = section(
  'selectors',
  'Tabs · SegmentedControl',
  'Tabs benennen Abschnitte und stehen über dem, was sie umschalten. Ein SegmentedControl ist eine Einstellung in einer Werkzeugleiste.',
  el('div', { class: 'pg-Stack' }, [
    stage(
      FormGrid({
        children: [
          Tabs({
            ariaLabel: 'Felder',
            children: [
              Tab({ label: 'Allgemein', selected: true, controls: 'pg-panel-a' }),
              Tab({ label: 'Termine', controls: 'pg-panel-b' }),
              Tab({ label: 'Verknüpfungen', controls: 'pg-panel-c' }),
            ],
          }),
          TabPanel({
            id: 'pg-panel-a',
            children: [
              Field({ label: 'Titel', full: true, control: TextInput({ value: 'Rollout Phase 2' }) }),
              Field({ label: 'Gruppe', control: Select({ options: [{ value: 'g', label: 'Plattform' }] }) }),
            ],
          }),
          TabPanel({ id: 'pg-panel-b', hidden: true }),
          TabPanel({ id: 'pg-panel-c', hidden: true }),
        ],
      }),
    ),
    row(
      specimen(
        'Tabs, vertikal',
        Tabs({
          orientation: 'vertical',
          ariaLabel: 'Bereiche',
          children: [
            Tab({ label: 'Instanz', selected: true }),
            Tab({ label: 'Benutzer' }),
          ],
        }),
      ),
      specimen(
        'SegmentedControl',
        SegmentedControl({
          ariaLabel: 'Darstellung',
          segments: [
            { value: 'timeline', label: 'Timeline', icon: fromHtml(TIMELINE_GLYPH), selected: true },
            { value: 'list', label: 'Liste', icon: fromHtml(LIST_GLYPH) },
          ],
        }),
      ),
      specimen(
        'SegmentedControl mit Label',
        SegmentedControl({
          label: 'Risiken',
          segments: [
            { value: 'matrix', label: 'Matrix', icon: fromHtml(TIMELINE_GLYPH) },
            { value: 'cards', label: 'Karten', icon: fromHtml(LIST_GLYPH), selected: true },
          ],
        }),
      ),
      specimen('SegmentedControl mit klickbarem Label', segmentedControlWithLabelAction()),
      specimen('Separator, horizontal', el('div', { style: 'width:120px' }, Separator())),
      specimen('Separator, vertikal', el('div', { class: 'pg-VRule' }, Separator({ orientation: 'vertical' }))),
    ),
  ]),
);

/* ------------------------------------------------------------------------- */
/* Surfaces                                                                  */
/* ------------------------------------------------------------------------- */

const surfaceSection = section(
  'surfaces',
  'Panel · Prose · DescriptionList',
  'Das Panel liegt über dem Inhalt statt neben ihm: eine Spalte würde vis-timeline dasselbe Zeitfenster in weniger Breite neu einpassen.',
  el('div', { class: 'pg-Columns' }, [
    el('div', { class: 'pg-PanelHost' }, [
      Panel({
        attrs: { style: '--ds-panel-width:340px' },
        children: [
          PanelHeader({
            title: Heading({ level: 2, text: 'Rollout Phase 2' }),
            tools: PanelTools({
              children: [
                IconButton({ icon: Icon({ name: 'launch', standalone: true }), ariaLabel: 'Icon', variant: 'outline' }),
                IconButton({ icon: el('span', {}, '▬'), ariaLabel: 'Typ', variant: 'outline' }),
                IconButton({ icon: StatusDot({ status: 'Doing' }), ariaLabel: 'Status', variant: 'outline' }),
              ],
            }),
          }),
          DescriptionList({
            entries: [
              { term: 'Start', value: '2026-09-01' },
              { term: 'Ende', value: '2026-11-15' },
              { term: 'Gruppe', value: 'Plattform' },
            ],
          }),
          PanelBody({
            className: 'ds-Prose',
            children: fromHtml(
              '<div><p>Rendertes Markdown im Lesemodus.</p><ul><li>Ein Punkt</li><li>Noch einer</li></ul><pre><code>npm run dev</code></pre></div>',
            ),
          }),
        ],
      }),
    ]),
    el('div', { class: 'pg-Stack' }, [
      specimen(
        'Prose, editierbar',
        Prose({
          editable: true,
          className: 'pg-ProseEditable',
          children: fromHtml('<div><h3>Notiz</h3><p>Die Schreibfläche des Editors.</p></div>'),
        }),
      ),
      specimen(
        'DescriptionList, compact',
        DescriptionList({
          compact: true,
          entries: [
            { term: 'Angelegt', value: fromHtml('<span><strong>ada@example.com</strong> · 2026-08-01</span>') },
            { term: 'ID', value: fromHtml('<code>rollout-phase-2</code>'), breakAll: true },
          ],
        }),
      ),
    ]),
  ]),
);

/* ------------------------------------------------------------------------- */
/* Table                                                                     */
/* ------------------------------------------------------------------------- */

const tableSection = section(
  'table',
  'Table',
  'Eine echte Tabelle, keine Div-Gitter: die Semantik ist es, die einer Vorlesesoftware die Spalte einer Zelle nennt.',
  stage(
    Table({
      children: [
        TableHead({ columns: ['Eintrag', 'Start', 'Typ', 'Status', 'Verantwortlich'] }),
        el('tbody', {}, [
          TableGroupRow({
            title: 'Plattform',
            colspan: 5,
            action: Button({ label: '+ Eintrag', variant: 'outline', size: 'sm', reveal: true }),
          }),
          TableRow({
            interactive: true,
            selected: true,
            summary: true,
            children: [
              TableCell({
                primary: true,
                children: [TreeToggle({ expanded: true, label: 'Untereinträge ausblenden' }), Icon({ name: 'launch' }), 'Rollout Phase 2'],
              }),
              TableCell({ nowrap: true, muted: true, children: '2026-09-01' }),
              TableCell({ nowrap: true, muted: true, children: 'Zeitraum' }),
              TableCell({ nowrap: true, muted: true, children: [StatusDot({ status: 'Doing' }), ' Doing'] }),
              TableCell({
                nowrap: true,
                muted: true,
                children: [Avatar({ initials: 'AL', hue: 200, size: 'sm' }), ' Ada Lovelace'],
              }),
            ],
          }),
          TableRow({
            interactive: true,
            children: [
              TableCell({
                primary: true,
                depth: 1,
                children: [TreeToggle(), Icon({ name: 'milestone' }), 'Freigabe'],
              }),
              TableCell({ nowrap: true, muted: true, children: '2026-11-15' }),
              TableCell({ nowrap: true, muted: true, children: 'Zeitpunkt' }),
              TableCell({ nowrap: true, muted: true, children: [StatusDot({ status: 'Open' }), ' Open'] }),
              TableCell({ nowrap: true, muted: true, children: Text({ text: 'nicht gesetzt', placeholder: true }) }),
            ],
          }),
        ]),
      ],
    }),
  ),
);

/* ------------------------------------------------------------------------- */
/* Toolbar and skeleton                                                      */
/* ------------------------------------------------------------------------- */
/* GraphNode                                                                 */
/* ------------------------------------------------------------------------- */

// Absolutely positioned by the graph, so the specimens need a container that
// gives them a positioning context and the two size properties the box reads.
const graphSection = section(
  'graph',
  'GraphNode',
  'Der Kasten, als den die Beziehungsansicht einen Eintrag zeichnet. Die Größe kommt von außen, weil das Layout jede Position aus einer Kastenbreite rechnet.',
  el('div', { class: 'pg-GraphStage' }, [
    GraphNode({
      label: 'Konzept & Wireframes',
      meta: '01.03.2026 – 14.03.2026',
      status: 'Doing',
      icon: 'launch',
      attrs: { style: 'left:0;top:0' },
    }),
    GraphNode({
      label: 'Ausgewählt: der Eintrag, für den das Detailpanel offen ist',
      meta: '—',
      status: 'Open',
      selected: true,
      attrs: { style: 'left:230px;top:0' },
    }),
    GraphNode({
      label: 'Abgeblendet, während ein Nachbar unter dem Zeiger liegt',
      meta: '20.05.2026',
      status: 'Done',
      dimmed: true,
      attrs: { style: 'left:460px;top:0' },
    }),
    GraphNode({
      label: 'Eigene Gruppenfarbe, plus eine Bezugszeile',
      reference: 'Szenen: Das Angebot – Setup',
      color: '#198754',
      attrs: { style: 'left:690px;top:0;--ds-graph-node-h:62px' },
    }),
  ]),
);

/* ------------------------------------------------------------------------- */

const SKELETON_ROWS = [
  [{ x: 4, w: 30 }, { x: 42, w: 17 }],
  [{ x: 10, w: 44 }, { x: 64, point: true as const }],
  [{ x: 6, w: 19 }, { x: 33, w: 27 }],
  [{ x: 24, w: 37 }, { x: 71, w: 15 }],
];

const frameSection = section(
  'frame',
  'Toolbar · TimelineSkeleton',
  'Kopfzeile, Darstellungsleiste und Fußzeile sind ein Component mit drei Tönen: drei Definitionen sind der Weg, auf dem eine davon 2px höher wird.',
  el('div', { class: 'pg-Stack' }, [
    stage(
      Toolbar({
        tone: 'header',
        children: [
          ToolbarGroup({
            children: [
              AppMark(),
              ToolbarControl({ label: 'Timeline', children: Select({ wide: true, options: [{ value: 'v', label: 'Produkt-Roadmap' }] }) }),
              Checkbox({ label: 'Nur Meilensteine', className: 'ds-ToolbarControl' }),
            ],
          }),
          ToolbarGroup({ end: true, children: Button({ label: '+ Eintrag', variant: 'outline' }) }),
        ],
      }),
    ),
    stage(
      Toolbar({
        tone: 'view',
        children: [
          ToolbarControl({ label: 'Gruppieren', children: Select({ options: [{ value: 'g', label: 'Gruppe' }] }) }),
          ToolbarControl({
            label: 'Filter',
            labelled: false,
            children: [
              Select({ options: [{ value: 'tag', label: 'Tag' }] }),
              ToolbarAnchor({ children: Button({ label: 'Alle Werte', variant: 'trigger' }) }),
            ],
          }),
        ],
      }),
    ),
    stage(
      Toolbar({
        tone: 'footer',
        children: [Text({ text: '42 Einträge · 6 Gruppen', tone: 'muted' }), Button({ label: 'Plugins', variant: 'link' })],
      }),
    ),
    el('div', { class: 'pg-SkeletonHost' }, TimelineSkeleton({ rows: SKELETON_ROWS })),
  ]),
);

/* ------------------------------------------------------------------------- */
/* Callout and Dialog                                                        */
/* ------------------------------------------------------------------------- */

const dialogDemo = Dialog({
  title: 'Benutzer',
  className: 'pg-StaticDialog',
  children: Text({
    as: 'p',
    text: 'Ein Dialog sagt: nichts anderes, bis das hier erledigt ist. Das Panel daneben lässt den Inhalt benutzbar.',
    tone: 'muted',
    size: 'sm',
  }),
});
dialogDemo.setAttribute('open', '');

const messageSection = section(
  'messages',
  'Callout · Dialog',
  'Der Callout steht dort, wo der Inhalt gewesen wäre: die Fußzeile allein lässt eine leere Fläche zurück, und leer liest sich als „kaputt" statt als „abgelehnt".',
  el('div', { class: 'pg-Stack' }, [
    Callout({ text: 'Diese Quelle konnte nicht geladen werden: 403 Forbidden.', tone: 'danger' }),
    Callout({ text: 'Diese Timeline ist schreibgeschützt.', tone: 'warning' }),
    Callout({ text: 'Drei Einträge liegen außerhalb des sichtbaren Zeitraums.', tone: 'info' }),
    el('div', { class: 'pg-DialogHost' }, dialogDemo),
  ]),
);

/* ------------------------------------------------------------------------- */
/* Layout                                                                    */
/* ------------------------------------------------------------------------- */

// The frame in miniature. It is here rather than described in prose because the
// layout primitives only make sense nested — a `ViewSection` on its own is an
// empty box, and what it does is claim the height its siblings leave.
const layoutSection = section(
  'layout',
  'AppMain · ContentArea · ViewSection · ScrollArea',
  'Das Panel liegt in AppMain, nicht neben ContentArea: eine zweite Spalte würde die Breite des Charts verändern.',
  el(
    'div',
    { class: 'pg-LayoutHost' },
    AppMain({
      children: [
        ContentArea({
          children: [
            Toolbar({
              tone: 'view',
              children: ToolbarControl({
                label: 'Gruppieren',
                children: Select({ options: [{ value: 'g', label: 'Gruppe' }] }),
              }),
            }),
            ViewSection({
              tone: 'chart',
              ariaLabel: 'Chart',
              children: Text({ text: 'ViewSection, tone="chart"', tone: 'muted', size: 'sm' }),
            }),
            ViewSection({
              ariaLabel: 'Liste',
              children: ScrollArea({
                children: Text({ text: 'ViewSection + ScrollArea', tone: 'muted', size: 'sm' }),
              }),
            }),
          ],
        }),
        Panel({
          attrs: { style: '--ds-panel-width:180px' },
          children: PanelBody({ children: Text({ text: 'Panel', tone: 'muted', size: 'sm' }) }),
        }),
      ],
    }),
  ),
);

/* ------------------------------------------------------------------------- */
/* Assembly                                                                  */
/* ------------------------------------------------------------------------- */

const body = el('div', { class: 'pg-Body' }, [
  colourSection,
  scaleSection,
  typographySection,
  buttonSection,
  inputSection,
  marksSection,
  formSection,
  chipSection,
  menuSection,
  selectorSection,
  surfaceSection,
  tableSection,
  graphSection,
  messageSection,
  frameSection,
  layoutSection,
]);

const nav = el('nav', { class: 'pg-Nav', 'aria-label': 'Abschnitte' }, [
  Heading({ level: 3, text: 'Design System' }),
  Text({
    as: 'p',
    text: 'Der Vertrag steht in docs/design-system.md.',
    tone: 'muted',
    size: 'xs',
  }),
  el(
    'ul',
    {},
    sections.map(({ id, title }) => el('li', {}, el('a', { href: `#${id}` }, title))),
  ),
]);

document.body.append(el('div', { class: 'pg-Layout' }, [nav, ScrollArea({ className: 'pg-Main', children: body })]));
