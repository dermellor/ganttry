// Where the open timeline comes from, in one line the reader can act on.
//
// The viewer knew all of this and said none of it: whether a timeline is served
// live from a database or as a built copy, and whether it can be edited at all.
// „Why can I not drag this bar" was answerable only by noticing that no „+ Eintrag"
// button was there — an absence, which is the worst kind of explanation.
//
// DOM-free so the wording is unit-testable, and because the mapping is the part
// worth pinning: the label is what a user reads, the title is what they read when
// the label is not enough.

import type { SourceKind, SourceLive } from './types';

export type SourceOriginBadge = {
  label: string;
  /** `muted` while nothing can be changed here — see the note below. */
  tone: 'neutral' | 'muted';
  /** The long form, as a tooltip. */
  title: string;
};

const ORIGIN_LABEL: Record<SourceKind, string> = {
  db: 'Datenbank',
  // Not „Datei": a local source is a JSON file *or* a directory of Markdown notes,
  // and the client is deliberately not told which (see docs/local-sources.md). A
  // label that names one of the two is wrong half the time.
  local: 'Lokal',
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
 */
export function sourceOriginBadge(
  kind: SourceKind,
  editable: boolean,
  live: SourceLive,
): SourceOriginBadge {
  const origin = ORIGIN_LABEL[kind] ?? kind;
  if (!editable) {
    return {
      label: `${origin} · nur lesend`,
      tone: 'muted',
      title:
        kind === 'db'
          ? 'Aus der Datenbank geladen, hier aber nicht bearbeitbar.'
          : 'Statische Kopie: dieser Stand wurde beim Build erzeugt und kann hier nicht bearbeitet werden.',
    };
  }
  return {
    label: origin,
    tone: 'neutral',
    title:
      kind === 'db'
        ? `Live aus der Datenbank. ${LIVE_NOTE[live]}`
        : 'Eine Datei oder ein Ordner auf diesem Rechner. Änderungen werden dorthin geschrieben.',
  };
}
