// The settings area of the open timeline: what is true of the document as a whole,
// rather than of the instance around it or of one item inside it.
//
// It exists because that level had no place at all. A timeline's name, its
// description and the dimension it opens with could only be changed with database
// access or a file editor, although all three are ordinary document configuration
// and the API has accepted them for as long as there has been an API.
//
// A route rather than a panel or a dialog, for the reason the instance area is one:
// it grows a section per concern — its name and default grouping, its field
// definitions, the plugins it uses — and a dialog is the wrong size for that. It
// shares its frame and its section mechanics
// with the instance area (see src/areaFrame.ts) and keeps its own hash key, because
// which area is open is a statement about levels — see
// docs/information-architecture.md.

import {
  Button,
  Callout,
  Field,
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
import { groupByChoices, timelineMetaDraft, timelineMetaPatch } from './timelineMeta';
import { apiUpdateMeta } from './editor';
import { mountFieldsSection, unmountFields } from './fieldsSection';
import { mountPluginsSection, unmountPlugins } from './pluginsSection';
import { renderTimeline } from './render';

/**
 * A section id, which is also verbatim what `#timeline-settings=<id>` carries.
 * English like every other key in the hash, though the labels beside them are
 * German.
 */
export type TimelineSection = 'general' | 'fields' | 'plugins';

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
 * The one thing a read-only source may not do here, said once with its reason
 * instead of a page of dead inputs. Same rule as the instance area: an area that is
 * mostly values you cannot change teaches people to ignore it, so non-editability
 * carries a visible reason.
 */
function readOnlyNote(): HTMLElement {
  return Callout({
    tone: 'warning',
    text:
      'Diese Timeline ist hier nicht bearbeitbar, deshalb sind die Werte nur zu lesen. ' +
      'Woran das liegt, steht im Badge neben ihrem Namen.',
  });
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
      Callout({ text: 'Keine Timeline geladen. Öffne eine und komm zurück.' }),
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

  const status = Text({
    as: 'p',
    text: notice,
    tone: 'muted',
    size: 'xs',
    // Announced, because the only signal that a save worked is this line.
    attrs: { id: 'tl-save-status', role: 'status' },
  });
  const save = Button({
    label: 'Speichern',
    variant: 'outline',
    attrs: { id: 'tl-save', hidden: !editable },
  });

  save.addEventListener('click', () => {
    const patch = timelineMetaPatch(current, {
      name: name.value,
      description: description.value,
      groupBy: groupBy.value,
    });
    // „Nothing changed" is said rather than swallowed: a save button that answers a
    // click with silence reads as a save that failed.
    if (!patch) {
      status.textContent = 'Keine Änderung.';
      return;
    }
    status.textContent = 'Wird gespeichert …';
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
        mountGeneral(root, 'Gespeichert.');
      })
      .catch((e: unknown) => {
        status.textContent = e instanceof Error ? e.message : String(e);
        save.disabled = false;
      });
  });

  root.replaceChildren(
    el('div', { class: 'settings-form' }, [
      editable ? null : readOnlyNote(),
      Field({ label: 'Name', control: name, htmlFor: 'tl-name' }),
      Field({
        label: 'Beschreibung',
        hint: 'optional',
        control: description,
        htmlFor: 'tl-description',
      }),
      Field({
        label: 'Gruppierung beim Öffnen',
        hint: 'Vorgabe',
        control: groupBy,
        htmlFor: 'tl-groupby',
      }),
      // The one thing about this field that is not obvious, and it is the reason
      // somebody would hesitate to touch it: it does not overrule anybody.
      Text({
        as: 'p',
        text: 'Wer selbst gruppiert, behält seine Wahl: die Vorgabe gilt für alle, die noch keine getroffen haben.',
        tone: 'muted',
        size: 'xs',
      }),
      el('div', { class: 'settings-actions' }, [save, status]),
    ]),
  );
}

const SECTIONS: readonly AreaSection<TimelineSection>[] = [
  { id: 'general', label: 'Allgemein', mount: mountGeneral },
  { id: 'fields', label: 'Felder', mount: mountFieldsSection, unmount: unmountFields },
  { id: 'plugins', label: 'Plugins', mount: mountPluginsSection, unmount: unmountPlugins },
];

/** The section a hash value names, defaulting to the first. */
export function timelineSection(raw: string | undefined | null): TimelineSection {
  return areaSection(SECTIONS, raw);
}

export async function showTimelineSettings(section: TimelineSection | null): Promise<void> {
  await showArea(handle, nodes(), SECTIONS, section, 'tl-settings-open');
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
  els.tlSettingsBtn.addEventListener('click', () => openTimelineSettings(SECTIONS[0].id));
}
