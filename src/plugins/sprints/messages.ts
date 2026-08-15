// This plugin's interface text, in the two languages the host ships.
//
// The contract is „Text in more than one language" (docs/plugin-authoring.md).
// Its **agent-facing** text is not here and is not translated: a tool's notes and
// refusals are English like the rest of the tool surface (docs/mcp.md), and they
// live at the site that produces them, in `tools.ts`.
//
// **Nothing here is a stored value.** Two sets in this plugin look like labels and
// are not, and both stay exactly where they are:
//
//   - `hoch` / `mittel` / `niedrig` in `fields.ts` — the confidence values, which
//     already sit in item `metadata` on real timelines. Translating them orphans
//     every item carrying one.
//   - the four sprint state ids (`planned`, `active`, `closed`, `cancelled`) —
//     stored on the row. Only the *labels* below move; the ids never do.
//
// `src/i18n/storedValues.test.ts` holds that line.

import { pluginMessages } from '../../pluginHost/api';

export const t = pluginMessages('dev.zeitlines.sprints', {
  en: {
    // The sprint row and its form
    'sprint': 'Sprint',
    'sprint.create': 'Create sprint',
    'sprint.edit': 'Edit sprint',
    'sprint.close': 'Close sprint',
    'sprint.closing': 'Closing …',
    'sprint.editDone': 'Finish editing',
    'sprint.name': 'Name',
    'sprint.goal': 'Sprint goal',
    'sprint.note': 'Note',
    'sprint.status': 'Status',
    'sprint.firstDay': 'First day',
    'sprint.lastDay': 'Last day',
    'sprint.capacity': 'Capacity',
    'sprint.capacityUnit': 'Capacity unit',
    'sprint.unit': 'Unit',
    'sprint.byDate': 'Sprint by date',
    'sprint.untitled': '(untitled)',
    'sprint.current': 'current',
    'save': 'Save',
    'cancel': 'Cancel',

    // The four states, as labels. The ids stay English and stored.
    'state.planned': 'planned',
    'state.active': 'active',
    'state.closed': 'closed',
    'state.cancelled': 'cancelled',

    // The three capacity units, as labels.
    'unit.points': 'Points',
    'unit.hours': 'Hours',
    'unit.items': 'Entries',
    'unit.storyPoints': 'Story points',

    // Empty and warning states
    'empty.noSprint': 'No sprint on this timeline yet.',
    'empty.noSprintYet': 'No sprint created yet.',
    'empty.noSprintReadOnly': 'No sprint created yet. This timeline takes no changes from the interface.',
    'empty.noneActive': 'No sprint is active.',
    'empty.noMembers': 'No entry is assigned to this sprint.',
    'empty.noHistory': 'No history is stored for this closed sprint.',
    'warn.noGoal': 'This sprint is active and has no sprint goal.',
    'warn.noEstimate': 'no usable estimate',
    'warn.noBurndown': 'Without a start and an end there is no day axis, so this sprint draws no burndown.',

    // Refusals from the form and from a concurrent edit
    'refusal.nameMissing': 'A sprint needs a name.',
    'refusal.activeNeedsDays': 'An active sprint needs a first and a last day.',
    'refusal.lastBeforeFirst': 'The last day lies before the first.',
    'refusal.rowDeleted': 'The row has since been deleted.',
    'refusal.unreadable': 'The sprint can no longer be read.',
    'refusal.windowChanged': 'The period has since been changed.',
    'refusal.capacityChanged': 'The capacity has since been changed.',
    'refusal.closeRunning': 'A close is still running.',
    'refusal.closeUnfinished': 'The close is therefore not finished.',
    'refusal.alreadyCreated': 'has since been created. „Create sprint" once more',
    'close.skipped.one': '{count} entry has no id and appears in no history row',
    'close.skipped.other': '{count} entries have no id and appear in no history row',
    'refusal.closeAborted': 'Close aborted. {written} of {total} entries are in the history, then „{item}" failed ({error}). No report written, the status is not set.',
    'refusal.closeAbortedTail': 'Closing again does not write the existing rows twice.',
    'warn.overlap': 'The windows of „{a}" and „{b}" overlap ({from} to {to}).',
    'warn.closeUnfinished': 'The close of „{name}" is unfinished: {written}, status „{state}".',
    'warn.windowPast.one': '„{name}" is „{state}", and its window ended on {end} ({count} day ago).',
    'warn.windowPast.other': '„{name}" is „{state}", and its window ended on {end} ({count} days ago).',
  },
  de: {
    'sprint': 'Sprint',
    'sprint.create': 'Sprint anlegen',
    'sprint.edit': 'Sprint bearbeiten',
    'sprint.close': 'Sprint abschließen',
    'sprint.closing': 'Wird abgeschlossen …',
    'sprint.editDone': 'Bearbeiten beenden',
    'sprint.name': 'Name',
    'sprint.goal': 'Sprint-Ziel',
    'sprint.note': 'Notiz',
    'sprint.status': 'Status',
    'sprint.firstDay': 'Erster Tag',
    'sprint.lastDay': 'Letzter Tag',
    'sprint.capacity': 'Kapazität',
    'sprint.capacityUnit': 'Einheit der Kapazität',
    'sprint.unit': 'Einheit',
    'sprint.byDate': 'Sprint nach Datum',
    'sprint.untitled': '(ohne Titel)',
    'sprint.current': 'aktuell',
    'save': 'Speichern',
    'cancel': 'Abbrechen',

    'state.planned': 'geplant',
    'state.active': 'aktiv',
    'state.closed': 'abgeschlossen',
    'state.cancelled': 'abgebrochen',

    'unit.points': 'Punkte',
    'unit.hours': 'Stunden',
    'unit.items': 'Einträge',
    'unit.storyPoints': 'Story Points',

    'empty.noSprint': 'In dieser Zeitleiste gibt es noch keinen Sprint.',
    'empty.noSprintYet': 'Noch kein Sprint angelegt.',
    'empty.noSprintReadOnly':
      'Noch kein Sprint angelegt. Diese Zeitleiste nimmt aus der Oberfläche keine Änderungen an.',
    'empty.noneActive': 'Kein Sprint ist aktiv.',
    'empty.noMembers': 'Diesem Sprint ist kein Eintrag zugeordnet.',
    'empty.noHistory': 'Zu diesem abgeschlossenen Sprint ist kein Verlauf gespeichert.',
    'warn.noGoal': 'Dieser Sprint ist aktiv und hat kein Sprint-Ziel.',
    'warn.noEstimate': 'keine verwertbare Schätzung',
    'warn.noBurndown':
      'Ohne Anfang und Ende gibt es keine Tagesachse, deshalb zeichnet dieser Sprint kein Burndown.',

    'refusal.nameMissing': 'Ein Sprint braucht einen Namen.',
    'refusal.activeNeedsDays': 'Ein aktiver Sprint braucht einen ersten und einen letzten Tag.',
    'refusal.lastBeforeFirst': 'Der letzte Tag liegt vor dem ersten.',
    'refusal.rowDeleted': 'Die Zeile ist inzwischen gelöscht.',
    'refusal.unreadable': 'Der Sprint ist nicht mehr zu lesen.',
    'refusal.windowChanged': 'Der Zeitraum ist inzwischen geändert worden.',
    'refusal.capacityChanged': 'Die Kapazität ist inzwischen geändert worden.',
    'refusal.closeRunning': 'Ein Abschluss läuft noch.',
    'refusal.closeUnfinished': 'Der Abschluss ist damit nicht fertig.',
    'refusal.alreadyCreated': 'ist inzwischen angelegt. Noch einmal „Sprint anlegen" wählen',
    'close.skipped.one': '{count} Eintrag hat keine Id und steht in keiner Historienzeile',
    'close.skipped.other': '{count} Einträge haben keine Id und stehen in keiner Historienzeile',
    'refusal.closeAborted': 'Abschluss abgebrochen. {written} von {total} Einträgen stehen in der Historie, dann schlug „{item}" fehl ({error}). Kein Report geschrieben, der Status ist nicht gesetzt.',
    'refusal.closeAbortedTail': 'Ein erneuter Abschluss schreibt die vorhandenen Zeilen nicht doppelt.',
    'warn.overlap': 'Die Fenster von „{a}" und „{b}" überlappen sich ({from} bis {to}).',
    'warn.closeUnfinished': 'Abschluss von „{name}" ist unfertig: {written}, Status „{state}".',
    'warn.windowPast.one': '„{name}" steht auf „{state}", das Fenster endete am {end} (vor {count} Tag).',
    'warn.windowPast.other': '„{name}" steht auf „{state}", das Fenster endete am {end} (vor {count} Tagen).',
  },
});
