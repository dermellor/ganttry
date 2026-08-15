// The settings area: one surface for everything that is true of this instance
// rather than of one timeline.
//
// It exists because instance-wide state had no place in the running app. An
// operator asking „does this deployment require sign-in, which domains may sign
// in, who may administer it, what do the automations act as" had to read an env
// file, a hosting dashboard and `psql`, and know in advance which of the three
// held the answer. The alternative it replaces is worse than it looks: a button
// per concern in the header, ending in four panels and no overview.
//
// Sections are declared in `sections()` below, and the instance section renders
// whatever `/api/settings` declares — it knows no setting by name. That is the
// acceptance criterion for the whole design: adding a setting is a declaration
// in `src/settings.ts`, and this file does not change.
//
// The risk it is designed against: an area that is mostly values you cannot
// change here teaches people to ignore it, and once ignored the editable
// remainder is missed too. A read-only mirror of an env file is worse than no
// page at all, because it looks like it should work. So non-editability carries
// a visible reason rather than a greyed-out field — knowing where a value comes
// from is most of what somebody opens this for.

import {
  Badge,
  Callout,
  el,
  Heading,
  Table,
  TableCell,
  TableHead,
  TableRow,
  Text,
} from './design-system';
import {
  areaSection,
  createAreaHandle,
  invalidateArea,
  showArea,
  wireAreaNav,
  type AreaNodes,
  type AreaSection,
} from './areaFrame';
import './styles/settings.css';
import { mountMemberAdmin, unmountMemberAdmin } from './memberAdmin';
import { LOCALE_CHANGED, mountAccount } from './accountSection';
import { t } from './i18n';
import { els, state, syncUrl } from './state';
import type { DeclaredSetting } from './types';

/**
 * A section id, which is also verbatim what `#settings=<id>` carries.
 *
 * One string rather than an id and a slug, so nothing has to map between them —
 * and English, like every other key in the hash (`view`, `item`, `mode`), even
 * though the labels beside them are German. A separate slug would also make this
 * module import-cycle with `state.ts`, which writes the hash.
 */
export type SettingsSection = 'instance' | 'members' | 'account';

type SectionDef = AreaSection<SettingsSection>;

/**
 * Where a value lives, in the words an operator would use.
 *
 * A function rather than the constant it was, because a constant is evaluated on
 * import — before `initLocale()` has run — which freezes the product default into
 * it and leaves the badges in one language whatever the reader picked. That is the
 * one way to misuse `t()` and it is why nothing calls it at module scope.
 */
const homeLabel = (home: DeclaredSetting['home']): string =>
  ({ env: t('settings.home.env'), build: t('settings.home.build'), db: t('settings.home.db') })[home];

/**
 * The refusals worth a sentence of their own, translated from the server's
 * codes — the same arrangement the membership screen already uses: the server
 * answers in English like everything written into the repository, the interface
 * is German, and anything unlisted falls back to the server's own message.
 */
const errorText = (): Record<string, string> => ({
  access_control_disabled: t('refusal.accessControlOff'),
  settings_unavailable: t('refusal.settings.unreadable'),
  forbidden: t('refusal.forbidden'),
});

async function apiJson(path: string): Promise<any> {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorText()[data.error] || data.message || data.error || `HTTP ${res.status}`);
  return data;
}

/**
 * One setting's value cell.
 *
 * Three cases, and the difference between the second and third is the whole
 * point of the read gate: „gesetzt" without a value means the instance has one
 * and this page may not show it, while „nicht gesetzt" means there is nothing to
 * show. Collapsing them would turn a withheld secret into a missing one and send
 * an operator configuring something that is already configured.
 */
function valueCell(s: DeclaredSetting): HTMLElement {
  if (s.value == null) {
    return s.set
      ? Text({ text: t('settings.set'), tone: 'muted', className: 'setting-value setting-secret' })
      : Text({ text: t('settings.unset'), tone: 'muted', className: 'setting-value' });
  }
  if (s.value === 'true') return Text({ text: t('settings.on'), tone: 'accent', className: 'setting-value' });
  if (s.value === 'false') return Text({ text: t('settings.off'), tone: 'muted', className: 'setting-value' });
  if (!s.value) return Text({ text: t('settings.empty'), tone: 'muted', className: 'setting-value' });
  // An unset variable that still has an effective value is the instance's
  // default — „editor" and „why does nothing say so" are two different facts,
  // and an operator looking for where a value is configured needs the second.
  return el('span', {}, [
    Text({ text: s.value, className: 'setting-value' }),
    !s.set && Text({ text: ` ${t('settings.default')}`, tone: 'muted', size: 'xs' }),
  ]);
}

/**
 * One row: label, variable name, value, and the badge naming where the value lives.
 *
 * The „Herkunft" column carried a sentence per group as well („In der Umgebung
 * dieser Instanz gesetzt, nicht hier.") plus the same sentence on every badge's
 * tooltip. The badge is the label for that fact; the sentence was explanation on top
 * of it (see „Interface text" in AGENTS.md).
 */
function settingRow(s: DeclaredSetting): HTMLElement {
  return TableRow({
    className: 'setting-row',
    children: [
      TableCell({
        primary: true,
        children: [
          Text({ text: s.label, className: 'setting-label' }),
          // The variable's own name, because that is what an operator searches
          // their hosting dashboard for — the label alone would not find it.
          Text({ text: s.key, tone: 'muted', size: 'xs', className: 'setting-key' }),
        ],
      }),
      TableCell({ children: valueCell(s) }),
      TableCell({
        children: Badge({
          label: homeLabel(s.home) ?? s.home,
          tone: s.home === 'env' ? 'neutral' : 'muted',
        }),
      }),
    ],
  });
}

function settingsGroups(settings: DeclaredSetting[]): HTMLElement[] {
  // Grouped by the declaration's own `group`, in first-appearance order, so a
  // new group needs no list here either.
  const groups = new Map<string, DeclaredSetting[]>();
  for (const s of settings) {
    const bucket = groups.get(s.group);
    if (bucket) bucket.push(s);
    else groups.set(s.group, [s]);
  }

  return [...groups].map(([group, rows]) => {
    const body = rows.map((s) => settingRow(s));
    return el('section', { class: 'setting-group' }, [
      Heading({ level: 3, text: group, className: 'setting-group-title' }),
      Table({
        className: 'setting-table',
        children: [
          TableHead({ columns: [t('settings.column.setting'), t('settings.column.value'), t('settings.origin')] }),
          el('tbody', {}, body),
        ],
      }),
    ]);
  });
}

async function mountInstance(root: HTMLElement): Promise<void> {
  root.replaceChildren(Text({ as: 'p', text: t('app.loading'), tone: 'muted', placeholder: true }));
  try {
    const { settings } = (await apiJson('/api/settings')) as { settings: DeclaredSetting[] };
    root.replaceChildren(
      ...(settings.length
        ? settingsGroups(settings)
        : [Callout({ tone: 'warning', text: t('settings.none') })]),
    );
  } catch (e) {
    root.replaceChildren(Callout({ text: e instanceof Error ? e.message : String(e) }));
  }
}

/**
 * The sections, built on call rather than held in a `const`.
 *
 * A module-scope array would evaluate `t()` on import — before `initLocale()` has
 * decided the language — and freeze the product default into the section list, so
 * the nav would stay English for a German reader while every section body followed
 * the setting. Nothing in this codebase calls `t()` at module scope, and this is
 * the file that first proved the rule was worth writing down (src/i18n/index.ts).
 *
 * The **ids** are not built here and never move: they are the hash, so they stay
 * English like every other key in the address (see „Sections" in docs/settings.md).
 */
const sections = (): readonly SectionDef[] => [
  { id: 'instance', label: t('settings.section.instance'), mount: mountInstance },
  { id: 'members', label: t('settings.section.members'), mount: mountMemberAdmin, unmount: unmountMemberAdmin },
  // „Konto" last, because the two before it are about the deployment and this one
  // is about the reader — and because it is the only section every instance can
  // offer, so putting it first would push what an operator opened the area for
  // below a control they may not have come for.
  { id: 'account', label: t('settings.section.account'), mount: mountAccount },
];

/** The first section's id, which the header button opens. Never translated. */
const FIRST_SECTION: SettingsSection = 'instance';

/** The section a hash value names, defaulting to the first (see `areaSection`). */
export function settingsSection(raw: string | undefined | null): SettingsSection {
  return areaSection(sections(), raw);
}

const handle = createAreaHandle<SettingsSection>();

function nodes(): AreaNodes {
  return {
    root: els.settings,
    nav: els.settingsNav,
    heading: els.settingsHeading,
    body: els.settingsBody,
  };
}

/**
 * Show the area on a section, or hide it when `null`.
 *
 * The timeline, the list, the detail panel and the controls that drive them go
 * away rather than sitting behind the area: this is a place you go, and a
 * half-visible timeline behind it invites clicking on something that is not
 * there. `+ Eintrag` goes with them, because it edits a timeline.
 *
 * Through a class on `<body>` and CSS, NOT by setting `hidden` on each element.
 * Every one of them owns its own `hidden` for its own reasons — `+ Eintrag` is
 * hidden on a read-only source, the detail panel when nothing is selected — and
 * writing over that on open means guessing what to restore on close. The guess
 * is wrong for exactly the case that matters: the button comes back on a
 * timeline that cannot be edited.
 */
export async function showSettings(section: SettingsSection | null): Promise<void> {
  await showArea(handle, nodes(), sections(), section, 'settings-open');
}

/**
 * Open a section, writing it into the hash so the area is linkable.
 *
 * The link is worth having even for somebody who cannot open it: `#settings` on
 * an instance with access control off answers with the reason, which is the
 * question that link was followed to ask.
 */
export function openSettings(section: SettingsSection): void {
  state.settingsSection = section;
  void showSettings(section);
  syncUrl();
}

export function closeSettings(): void {
  state.settingsSection = null;
  void showSettings(null);
  // The timeline was `display: none` while the area showed, so vis-timeline
  // could not size itself — the same redraw the list view needs on its way back.
  state.timeline?.redraw();
  syncUrl();
}

export function wireSettingsArea(): void {
  wireAreaNav<SettingsSection>(els.settingsNav, openSettings);
  els.settingsClose.addEventListener('click', () => closeSettings());
  els.settingsBtn.addEventListener('click', () => openSettings(FIRST_SECTION));
  // Switching language repaints the area, because everything in it — the section
  // nav, the „Herkunft" badges, this section's own heading — is text that just
  // changed. Repainting only the control that was clicked would leave a German
  // nav around an English page, which reads as the switch having half worked.
  //
  // The rest of the chrome behind the area is not repainted here: it is hidden
  // while the area is open, and it rebuilds from `t()` on the next render. What
  // it does not do is rebuild *now*, which is the known limit of this — see
  // „What a language change does not repaint" (docs/settings.md).
  window.addEventListener(LOCALE_CHANGED, () => {
    if (!state.settingsSection) return;
    invalidateArea(handle);
    void showSettings(state.settingsSection);
  });
}
