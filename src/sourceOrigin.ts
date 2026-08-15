// Whether the open timeline can be edited, in one line the reader can act on.
//
// „Why can I not drag this bar" was answerable only by noticing that no „+ Eintrag"
// button was there — an absence, which is the worst kind of explanation. So a
// read-only source says so beside its name.
//
// It used to name the origin as well („Datenbank", „Lokal") on every source,
// editable or not, and that half was already on screen twice: the switcher groups
// its list by origin under those exact words (`ORIGIN_LABEL` here and
// `GROUP_HEADING` in switcherRows.ts were the same two strings), so the pill
// repeated the heading of the group the open timeline sits in. Worse, it sat
// between the name and the gear that opens that timeline's settings and pushed
// the two apart. What is left is the part nothing else says, on the sources where
// there is something to say.
//
// DOM-free so the wording is unit-testable, and because the mapping is the part
// worth pinning.
//
// The badge is a label and stops there. It used to carry a tooltip per source kind
// as well („Statische Kopie: dieser Stand wurde beim Build erzeugt …", „Live aus der
// Datenbank. Änderungen anderer erscheinen sofort."), which is explanation nobody
// asked for on a control that already states its state.

import { t } from './i18n';

export type SourceOriginBadge = {
  /** Whether the pill is on screen at all. False leaves the name and its gear adjacent. */
  shown: boolean;
  label: string;
  /** `muted` while nothing can be changed here — see the note below. */
  tone: 'neutral' | 'muted';
};

/**
 * What the badge beside the timeline's name says. Read-only is the fact that
 * carries, and a reader who does not hover still has to get it, so it is a label.
 *
 * An editable source gets no badge. There is nothing to warn about, and the two
 * words it used to show are the switcher's own group headings.
 */
export function sourceOriginBadge(editable: boolean): SourceOriginBadge {
  if (editable) return { shown: false, label: '', tone: 'neutral' };
  return {
    shown: true,
    // Without the origin word: „Lokal · nur lesend" spent its first half on the
    // heading the switcher already puts above this timeline, and the half that
    // names the missing buttons had to compete with it.
    label: t('switcher.readOnly'),
    tone: 'muted',
  };
}
