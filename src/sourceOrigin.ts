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
// worth pinning: the label is what a user reads, the title is what they read when
// the label is not enough.

import type { SourceKind, SourceLive } from './types';

export type SourceOriginBadge = {
  /** Whether the pill is on screen at all. False leaves the name and its gear adjacent. */
  shown: boolean;
  label: string;
  /** `muted` while nothing can be changed here — see the note below. */
  tone: 'neutral' | 'muted';
  /** The long form, as a tooltip. */
  title: string;
};

const LIVE_NOTE: Record<SourceLive, string> = {
  realtime: 'Änderungen anderer erscheinen sofort.',
  poll: 'Änderungen anderer erscheinen beim nächsten Abruf.',
  none: 'Änderungen anderer erscheinen erst beim Neuladen.',
};

/**
 * What the badge beside the timeline's name says. Read-only is the fact that
 * carries, so it is in the label rather than only in the tooltip: it explains
 * every affordance that is missing, and a reader who does not hover never gets
 * that explanation.
 *
 * An editable source gets no badge. There is nothing to warn about, and the two
 * words it used to show are the switcher's own group headings.
 */
export function sourceOriginBadge(
  kind: SourceKind,
  editable: boolean,
  live: SourceLive,
): SourceOriginBadge {
  if (editable) {
    return {
      shown: false,
      label: '',
      tone: 'neutral',
      // Kept even while nothing shows it, because where a source writes to is the
      // one thing an editable source has to be able to answer, and the caller
      // decides where that answer goes.
      title:
        kind === 'db'
          ? `Live aus der Datenbank. ${LIVE_NOTE[live]}`
          : 'Eine Datei oder ein Ordner auf diesem Rechner. Änderungen werden dorthin geschrieben.',
    };
  }
  return {
    shown: true,
    // Without the origin word: „Lokal · nur lesend" spent its first half on the
    // heading the switcher already puts above this timeline, and the half that
    // explains the missing buttons had to compete with it.
    label: 'Nur lesend',
    tone: 'muted',
    title:
      kind === 'db'
        ? 'Aus der Datenbank geladen, hier aber nicht bearbeitbar.'
        : 'Statische Kopie: dieser Stand wurde beim Build erzeugt und kann hier nicht bearbeitet werden.',
  };
}
