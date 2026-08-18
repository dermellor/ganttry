// The settings area of the open timeline: what is true of the document as a whole,
// rather than of the instance around it or of one item inside it.
//
// It exists because that level had no place at all. A timeline's name, its
// description and the dimension it opens with could only be changed with database
// access or a file editor, although all three are ordinary document configuration
// and the API has accepted them for as long as there has been an API.
//
// A route rather than a panel or a dialog, for the reason the instance area is one:
// this grows a section per concern (field definitions are #84, plugins #85), and a
// dialog is the wrong size for that. It shares its frame and its section mechanics
// with the instance area (see src/areaFrame.ts) and keeps its own hash key, because
// which area is open is a statement about levels — see
// docs/information-architecture.md.

import {
  Button,
  Callout,
  Field,
  Heading,
  Select,
  setSelectOptions,
  Text,
  TextArea,
  TextInput,
  el,
} from './design-system';
import './styles/settings.css';
import {
  areaSection,
  createAreaHandle,
  showArea,
  wireAreaNav,
  type AreaNodes,
  type AreaSection,
} from './areaFrame';
import { els, state, syncUrl } from './state';
import {
  graphGroupChoices,
  groupByChoices,
  groupOrderChoices,
  timelineMetaDraft,
  timelineMetaPatch,
} from './timelineMeta';
import { apiUpdateMeta } from './editor';
import { mountFieldsSection, unmountFields } from './fieldsSection';
import { mountPluginsSection } from './pluginsSection';
import { filterBuildForDisplay, renderTimeline, timelineItems } from './render';
import { UNGROUPED } from './buildItems';
import { t } from './i18n';

/**
 * A section id, which is also verbatim what `#timeline-settings=<id>` carries.
 * English like every other key in the hash, though the labels beside them are
 * German.
 */
export type TimelineSection = 'general' | 'fields' | 'plugins' | 'export';

const handle = createAreaHandle<TimelineSection>();

function nodes(): AreaNodes {
  return {
    root: els.tlSettings,
    nav: els.tlSettingsNav,
    heading: els.tlSettingsHeading,
    body: els.tlSettingsBody,
  };
}

/**
 * `notice` survives a re-mount. The form rebuilds itself after a save so its
 * „current" values are the stored ones, and that replaced the status element along
 * with everything else — a save that answers with silence reads as a save that
 * failed.
 */
function mountGeneral(root: HTMLElement, notice = ''): void {
  const view = state.activeView;
  const file = state.activeSourceFile;
  if (!view || !file) {
    root.replaceChildren(
      Callout({ text: t('timeline.none') }),
    );
    return;
  }

  const editable = state.activeSourceEditable;
  const current = timelineMetaDraft(view, file);

  const name = TextInput({ id: 'tl-name', value: current.name, disabled: !editable });
  const description = TextArea({
    id: 'tl-description',
    value: current.description,
    rows: 3,
    disabled: !editable,
  });
  const groupBy = Select({ id: 'tl-groupby', disabled: !editable });
  setSelectOptions(groupBy, groupByChoices(file).map((c) => ({ value: c.value, label: c.label })));
  groupBy.value = current.groupBy;

  const groupOrder = Select({ id: 'tl-grouporder', disabled: !editable });
  setSelectOptions(groupOrder, groupOrderChoices());
  groupOrder.value = current.groupOrder;

  // A read-only source shows these disabled rather than hiding them: a setting that
  // is read by the code and shown nowhere is the bug #137 was filed for, and „you
  // may not change this here" is a different statement from „this does not exist".
  // The **unfiltered** build's groups, not the displayed ones: which groups a
  // timeline has is a property of the timeline, and reading the filtered set would
  // drop the option for a group the reader has switched off right now — the same
  // reasoning `groupByChoices` follows one field above.
  const discovered = state.activeBuild?.groups ?? [];
  const bandRootGroup = Select({ id: 'tl-graph-roots', disabled: !editable });
  setSelectOptions(
    bandRootGroup,
    graphGroupChoices(file, discovered, current.bandRootGroup, UNGROUPED),
  );
  bandRootGroup.value = current.bandRootGroup;

  const referenceGroup = Select({ id: 'tl-graph-refs', disabled: !editable });
  setSelectOptions(
    referenceGroup,
    graphGroupChoices(file, discovered, current.referenceGroup, UNGROUPED),
  );
  referenceGroup.value = current.referenceGroup;

  const status = Text({
    as: 'p',
    text: notice,
    tone: 'muted',
    size: 'xs',
    // Announced, because the only signal that a save worked is this line.
    attrs: { id: 'tl-save-status', role: 'status' },
  });
  const save = Button({
    label: t('form.save'),
    variant: 'outline',
    attrs: { id: 'tl-save', hidden: !editable },
  });

  save.addEventListener('click', () => {
    const patch = timelineMetaPatch(current, {
      name: name.value,
      description: description.value,
      groupBy: groupBy.value,
      groupOrder: groupOrder.value,
      bandRootGroup: bandRootGroup.value,
      referenceGroup: referenceGroup.value,
    });
    // „Nothing changed" is said rather than swallowed: a save button that answers a
    // click with silence reads as a save that failed.
    if (!patch) {
      status.textContent = t('timeline.noChange');
      return;
    }
    status.textContent = t('form.saving');
    save.disabled = true;
    void apiUpdateMeta(view.source.id, patch)
      .then(async () => {
        // The name is shown in three places off two different sources (the picker,
        // the status line, the export), so the whole view is re-rendered rather than
        // each of them patched by hand. It also re-reads the file, which is what
        // makes a second save diff against what the server actually stored.
        await renderTimeline(view);
        // Re-mount so the form's „current" values are the stored ones: without it a
        // second save would diff against the state before the first. The
        // confirmation is handed to the new form rather than written into the old
        // one, which the re-mount would throw away.
        mountGeneral(root, t('timeline.saved'));
      })
      .catch((e: unknown) => {
        status.textContent = e instanceof Error ? e.message : String(e);
        save.disabled = false;
      });
  });

  root.replaceChildren(
    el('div', { class: 'settings-form' }, [
      // A read-only source shows disabled inputs and no save button. What says so in
      // words is the „Nur lesend" badge beside the timeline's name, once, and this
      // section adds nothing to it.
      Field({ label: t('form.name'), control: name, htmlFor: 'tl-name' }),
      Field({
        label: t('form.description'),
        hint: t('field.optional'),
        control: description,
        htmlFor: 'tl-description',
      }),
      Field({
        label: t('timeline.settings.grouping'),
        hint: t('form.preset'),
        control: groupBy,
        htmlFor: 'tl-groupby',
      }),
      Field({
        label: t('timeline.settings.groupOrder'),
        control: groupOrder,
        htmlFor: 'tl-grouporder',
      }),
      // A heading rather than „Graph: …" twice in the labels: the two settings
      // below only steer that one presentation, and naming it once is what lets
      // each label be about its group instead of repeating where it lands.
      Heading({ level: 3, text: t('timeline.settings.graph'), className: 'setting-group-title' }),
      Field({
        label: t('timeline.settings.graph.bandRoots'),
        control: bandRootGroup,
        htmlFor: 'tl-graph-roots',
      }),
      Field({
        label: t('timeline.settings.graph.references'),
        control: referenceGroup,
        htmlFor: 'tl-graph-refs',
      }),
      el('div', { class: 'settings-actions' }, [save, status]),
    ]),
  );
}

/**
 * The HTML export: one self-contained file of this timeline, to send to somebody
 * who has no access to the instance.
 *
 * It sits here rather than in the presentation bar, where it was an outline
 * button beside „+ Eintrag" and drawn exactly like it. That said the two are
 * reached for about equally often, and they are not: one is how a timeline gets
 * filled, the other is taken out a handful of times in a timeline's life.
 *
 * It exports the timeline's current filter, which is what the button did from the
 * same state. The section is the button and its status line; it carries no prose
 * about what lands in the file (see „Interface text" in AGENTS.md).
 */
function mountExport(root: HTMLElement): void {
  const view = state.activeView;
  if (!view || !state.activeBuild) {
    root.replaceChildren(
      Callout({ text: t('timeline.none') }),
    );
    return;
  }

  // Announced for the same reason the general section's is: while the file is
  // being built this line is the only thing saying the click arrived.
  const status = Text({
    as: 'p',
    text: '',
    tone: 'muted',
    size: 'xs',
    attrs: { id: 'tl-export-status', role: 'status' },
  });
  // Not gated on editability: exporting is reading, and a read-only timeline is
  // the one most likely to be passed on as a file.
  const run = Button({
    label: t('timeline.settings.export'),
    variant: 'outline',
    attrs: { id: 'tl-export' },
  });

  run.addEventListener('click', () => {
    if (!state.activeView || !state.activeBuild) return;
    run.disabled = true;
    status.textContent = t('export.generating');
    // The chunk carries vis-timeline and marked as raw text, so it is loaded on
    // the click rather than with the app — the same lazy import the button had.
    void import('./export')
      .then(async (m) => {
        const build = state.activeBuild!;
        const filtered = filterBuildForDisplay(build);
        // The export renders a vis-timeline too, so start-less items are left out
        // (they cannot be placed) — mirroring the timeline presentation.
        await m.exportTimelineHtml({
          view: state.activeView!,
          build: { ...build, items: timelineItems(filtered.items), groups: filtered.groups },
        });
        status.textContent = t('export.done');
      })
      .catch((e: unknown) => {
        status.textContent = t('refusal.export.failed', {
          message: e instanceof Error ? e.message : String(e),
        });
      })
      .finally(() => {
        run.disabled = false;
      });
  });

  root.replaceChildren(
    el('div', { class: 'settings-form' }, [el('div', { class: 'settings-actions' }, [run, status])]),
  );
}

/**
 * A function, not a constant. The section list *was* a module-scope constant with
 * `t()` in it — the exact bug `check-ui-text.mjs` grew a check for: filled on
 * import, before `initLocale()`, so the nav froze into one language while every
 * section body followed the setting. See „`t()` at module scope" in that script.
 */
function sections(): readonly AreaSection<TimelineSection>[] {
  return [
    { id: 'general', label: t('timeline.settings.general'), mount: mountGeneral },
    { id: 'fields', label: t('timeline.settings.fields'), mount: mountFieldsSection, unmount: unmountFields },
    { id: 'plugins', label: t('timeline.settings.plugins'), mount: mountPluginsSection },
    { id: 'export', label: t('timeline.settings.export.section'), mount: mountExport },
  ];
}

/** The section a hash value names, defaulting to the first. */
export function timelineSection(raw: string | undefined | null): TimelineSection {
  return areaSection(sections(), raw);
}

export async function showTimelineSettings(section: TimelineSection | null): Promise<void> {
  await showArea(handle, nodes(), sections(), section, 'tl-settings-open');
}

/**
 * Open a section, writing it into the hash so one timeline's settings can be
 * linked. Opening this closes the instance area: both replace the content, so two
 * open at once would stack two full-width surfaces on top of each other.
 */
export function openTimelineSettings(section: TimelineSection): void {
  if (state.settingsSection) {
    state.settingsSection = null;
    void import('./settingsArea').then((m) => m.showSettings(null));
  }
  state.tlSection = section;
  void showTimelineSettings(section);
  syncUrl();
}

export function closeTimelineSettings(): void {
  state.tlSection = null;
  void showTimelineSettings(null);
  // The timeline was `display: none` while the area showed, so vis-timeline could
  // not size itself — the same redraw the list view needs on its way back.
  state.timeline?.redraw();
  syncUrl();
}

export function wireTimelineSettings(): void {
  wireAreaNav<TimelineSection>(els.tlSettingsNav, openTimelineSettings);
  els.tlSettingsClose.addEventListener('click', () => closeTimelineSettings());
  els.tlSettingsBtn.addEventListener('click', () => openTimelineSettings(sections()[0].id));
}
