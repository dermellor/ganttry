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
//
// **Why some keys are long, and what their prefix claims.** „Interface text"
// (AGENTS.md) allows one category to be a full sentence, and
// `scripts/ci/check-ui-text.mjs` — which reads this file, not only the core's —
// reads a key's prefix as that claim:
//
//   `refusal.`  the software declined, or reports the result of what it did.
//               It covers a *result* too: `refusal.closeDone` reports a close that
//               worked.
//   `warn.`     a fault found in the **data** and reported rather than resolved:
//               two windows overlapping, a history row pointing at a sprint that
//               is gone. Naming both things it found takes a sentence.
//   `*.aria`    the accessible name of a graphic, which has to carry the figures
//               the picture shows.
//
// What must not carry a prefix is an ordinary label bought room with it: everything
// a person reads as the name of a control, a column or a figure is above, short,
// and stays that way. The split between `refusal.` and `warn.` for data faults is
// not perfectly drawn here — some faults arrived under `refusal.` before `warn.`
// was a claim the checker understood — and it is left alone rather than churned,
// because both are exempt and renaming them buys nothing but a diff.

import { pluginMessages } from '../../pluginHost/api';

export const t = pluginMessages('dev.zeitlines.sprints', {
  en: {
    // What the manifest declares, in the reader's language. A manifest holds no
    // functions and cannot call `t()`, so the host looks these up here and falls
    // back to the literal in `manifest.ts` — see `manifestText` in
    // `src/pluginHost/messages.ts`. Both happen to read the same in English and
    // German, and they are declared anyway: leaving them out would make the next
    // plugin's author think the seam does not exist.
    'manifest.name': 'Sprints',
    'manifest.view.board': 'Sprint',

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
    'sprint.closedOn': 'Closed on {day}',
    'sprint.capacitySuggestion': 'Suggestion from the last closed sprints: {value}.',
    'save': 'Save',
    'cancel': 'Cancel',

    // The item fields this plugin contributes. “Confidence” is the word the practice
    // uses and is deliberately the same in both languages — see `fields.ts`.
    'field.confidence': 'Confidence',

    // The four states, as labels. The ids stay English and stored.
    'state.planned': 'planned',
    'state.active': 'active',
    'state.closed': 'closed',
    'state.cancelled': 'cancelled',

    // The three capacity units, as labels.
    'unit.points': 'Points',
    'unit.hours': 'Hours',
    'unit.items': 'Entries',
    // Capitalised in both languages: it is the name of the estimate field (“Story
    // Points”), which `fields.test.ts` pins, rather than a unit written in prose.
    'unit.storyPoints': 'Story Points',
    'unit.asConfigured': 'as configured ({unit})',

    // The window line under the sprint's name, and where the window came from.
    'window.range': '{from} to {to}',
    'window.endFromLength': '{range} (end from the sprint length)',
    'window.fromRaster': '{range} (from the configured cadence)',

    // The four number boxes.
    'figure.scope': 'Scope ({unit})',
    'figure.completed': 'Completed',
    'figure.remaining': 'Remaining',
    'figure.capacity': 'Capacity ({unit})',

    // The burndown: its two legend keys and the label a screen reader reads.
    'chart.plan': 'Plan',
    'chart.frozen': 'Frozen',
    'chart.frozenOn': 'Frozen on {day}',
    'chart.reconstructed': 'Reconstructed',
    'chart.aria': 'Burndown {name}: {days} days, scope {scope} {unit}, remaining {remaining}.',

    // The item table.
    'items.entry': 'Entry',
    'items.estimate': 'Estimate ({unit})',
    'items.note': 'Note',
    'items.carriedIn': 'carried over from “{from}”',

    // Counted nouns, as their own keys so a sentence can hold the phrase instead of
    // declining a noun *and* a verb around a number. “1 history rows are written” is
    // what a single sentence with a count in the middle produces, in both languages.
    'close.rows.one': '{count} history row',
    'close.rows.other': '{count} history rows',
    'close.ofEntries.one': '{count} entry',
    'close.ofEntries.other': '{count} entries',
    'close.written.withReport': '{rows} and report written',
    'close.written.noReport': '{rows} written, no report',

    // Results the app's status line carries.
    'status.created': 'Sprint “{name}” created',
    'status.saved': 'Sprint “{name}” saved',

    // Empty and warning states
    'empty.noSprint': 'No sprint on this timeline yet.',
    'empty.noSprintYet': 'No sprint created yet.',
    'empty.noneActive': 'No sprint is active.',
    'empty.noMembers': 'No entry is assigned to this sprint.',
    'empty.noHistory': 'No history is stored for this closed sprint.',
    'warn.noGoal': 'This sprint is active and has no sprint goal.',
    'warn.noEstimate': 'no usable estimate',
    'warn.noBurndown': 'Without a start and an end there is no day axis, so this sprint draws no burndown.',
    'warn.outsideWindow': 'Dates outside the sprint ({from} to {to})',

    // Refusals from the form and from a concurrent edit
    'refusal.nameMissing': 'A sprint needs a name.',
    'refusal.unknownState': '“{value}” is not a status. Possible are: {known}.',
    'refusal.secondActive':
      '“{name}” is already active. A timeline has at most one active sprint: close or cancel “{name}” first.',
    'refusal.capacityNotDecimal': '“{value}” is not a decimal number, for example 20 or 20.5.',
    'refusal.capacityBelowMinimum': 'The capacity has to be at least {min}.',
    'refusal.createFailed': 'Creating the sprint failed: {error}',
    'refusal.saveFailed': 'Saving failed: {error}',
    'refusal.activeNeedsDays': 'An active sprint needs a first and a last day.',
    'refusal.lastBeforeFirst': 'The last day lies before the first.',
    'refusal.rowDeleted': 'The row has since been deleted.',
    'refusal.unreadable': 'The sprint can no longer be read.',
    'refusal.windowChanged': 'The period has since been changed.',
    'refusal.capacityChanged': 'The capacity has since been changed.',
    'refusal.closeRunning': 'A close is still running.',
    'refusal.closeUnfinished': 'The close is therefore not finished.',
    'refusal.alreadyCreated': '“{id}” has since been created. “Create sprint” once more.',
    'refusal.stateChanged': 'The sprint is “{state}” by now.',
    'refusal.stateNowIs': 'The sprint is “{state}”; closing again sets it.',
    'warn.skipped.one': '{count} entry has no id and appears in no history row',
    'warn.skipped.other': '{count} entries have no id and appear in no history row',
    'refusal.closeAborted': 'Close aborted. {written} of {total} entries are in the history, then “{item}” failed ({error}). No report written, the status is not set.',
    'refusal.closeAbortedTail': 'Closing again does not write the existing rows twice.',
    'refusal.reportNotWritten':
      'Close aborted. {rows} written, the report is not ({error}). The status is not set; closing again is safe.',
    'refusal.statusNotSetReason': 'History and report are written, the status is not: {reason}',
    'refusal.statusNotSetError': 'History and report are written, the status is not ({error}).',
    'refusal.closeDone': 'Sprint “{name}” closed: {done} of {entries} finished, {carried} {unit} carried over.',

    // What reading the rows found: each is only reachable in data nobody wrote through
    // this interface — a hand-edited file, an import, a close that stopped halfway.
    'refusal.duplicateRowId':
      'The id “{rowId}” appears in “{collection}” more than once; the first row is read.',
    'refusal.severalReports':
      'There is more than one report for one sprint ({rowIds}); the first is read.',
    'refusal.severalActive': 'Several sprints are “{state}”: {names}.',
    'refusal.closedBeforeStart':
      '“{name}” was closed on {closedOn}, before its own start on {start}.',
    'refusal.passWithoutSprint':
      'A history row names the sprint “{sprintId}”, which does not exist (entry “{itemId}”).',
    'refusal.reportMissing': 'No report is stored for “{name}”, so there are no figures for it.',
    // Not a word-for-word rendering of the German: „daher in keiner Summe" maps to
    // „and therefore in no sum", which is not a sentence anybody writes in English.
    // The rule the message carries is what has to survive, not its word order.
    'refusal.noEstimateSum': 'No usable estimate, so counted in no total: {items}.',
    'refusal.frozenOutside': 'The frozen history holds days outside the sprint window: {days}.',
    'refusal.windowTooLong':
      'The window of this sprint is longer than {days} days. No day axis is drawn for that: a sprint lasts a month or less.',
    'warn.overlap': 'The windows of “{a}” and “{b}” overlap ({from} to {to}).',
    'warn.closeUnfinished': 'The close of “{name}” is unfinished: {written}, status “{state}”.',
    'warn.windowPast.one': '“{name}” is “{state}”, and its window ended on {end} ({count} day ago).',
    'warn.windowPast.other': '“{name}” is “{state}”, and its window ended on {end} ({count} days ago).',
  },
  de: {
    'manifest.name': 'Sprints',
    'manifest.view.board': 'Sprint',
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
    'sprint.closedOn': 'Abgeschlossen am {day}',
    'sprint.capacitySuggestion': 'Vorschlag aus den letzten abgeschlossenen Sprints: {value}.',
    'save': 'Speichern',
    'cancel': 'Abbrechen',

    'field.confidence': 'Confidence',

    'state.planned': 'geplant',
    'state.active': 'aktiv',
    'state.closed': 'abgeschlossen',
    'state.cancelled': 'abgebrochen',

    'unit.points': 'Punkte',
    'unit.hours': 'Stunden',
    'unit.items': 'Einträge',
    'unit.storyPoints': 'Story Points',
    'unit.asConfigured': 'wie konfiguriert ({unit})',

    'window.range': '{from} bis {to}',
    'window.endFromLength': '{range} (Ende aus der Sprintlänge)',
    'window.fromRaster': '{range} (aus dem Raster der Konfiguration)',

    'figure.scope': 'Umfang ({unit})',
    'figure.completed': 'Abgeschlossen',
    'figure.remaining': 'Offen',
    'figure.capacity': 'Kapazität ({unit})',

    'chart.plan': 'Plan',
    'chart.frozen': 'Eingefroren',
    'chart.frozenOn': 'Eingefroren am {day}',
    'chart.reconstructed': 'Rekonstruiert',
    'chart.aria': 'Burndown {name}: {days} Tage, Umfang {scope} {unit}, offen {remaining}.',

    'items.entry': 'Eintrag',
    'items.estimate': 'Schätzung ({unit})',
    'items.note': 'Hinweis',
    'items.carriedIn': 'aus „{from}" übertragen',

    'close.rows.one': '{count} Historienzeile',
    'close.rows.other': '{count} Historienzeilen',
    'close.ofEntries.one': '{count} Eintrag',
    'close.ofEntries.other': '{count} Einträgen',
    'close.written.withReport': '{rows} und Bericht geschrieben',
    'close.written.noReport': '{rows} geschrieben, kein Bericht',

    'status.created': 'Sprint „{name}" angelegt',
    'status.saved': 'Sprint „{name}" gespeichert',

    'empty.noSprint': 'In dieser Zeitleiste gibt es noch keinen Sprint.',
    'empty.noSprintYet': 'Noch kein Sprint angelegt.',
    'empty.noneActive': 'Kein Sprint ist aktiv.',
    'empty.noMembers': 'Diesem Sprint ist kein Eintrag zugeordnet.',
    'empty.noHistory': 'Zu diesem abgeschlossenen Sprint ist kein Verlauf gespeichert.',
    'warn.noGoal': 'Dieser Sprint ist aktiv und hat kein Sprint-Ziel.',
    'warn.noEstimate': 'keine verwertbare Schätzung',
    'warn.noBurndown':
      'Ohne Anfang und Ende gibt es keine Tagesachse, deshalb zeichnet dieser Sprint kein Burndown.',
    'warn.outsideWindow': 'Termine außerhalb des Sprints ({from} bis {to})',

    'refusal.nameMissing': 'Ein Sprint braucht einen Namen.',
    'refusal.unknownState': '„{value}" ist kein Status. Möglich sind: {known}.',
    'refusal.secondActive':
      '„{name}" ist bereits aktiv. Eine Zeitleiste hat höchstens einen aktiven Sprint: erst „{name}" abschließen oder abbrechen.',
    'refusal.capacityNotDecimal': '„{value}" ist keine Dezimalzahl, zum Beispiel 20 oder 20.5.',
    'refusal.capacityBelowMinimum': 'Die Kapazität muss mindestens {min} betragen.',
    'refusal.createFailed': 'Sprint anlegen fehlgeschlagen: {error}',
    'refusal.saveFailed': 'Speichern fehlgeschlagen: {error}',
    'refusal.activeNeedsDays': 'Ein aktiver Sprint braucht einen ersten und einen letzten Tag.',
    'refusal.lastBeforeFirst': 'Der letzte Tag liegt vor dem ersten.',
    'refusal.rowDeleted': 'Die Zeile ist inzwischen gelöscht.',
    'refusal.unreadable': 'Der Sprint ist nicht mehr zu lesen.',
    'refusal.windowChanged': 'Der Zeitraum ist inzwischen geändert worden.',
    'refusal.capacityChanged': 'Die Kapazität ist inzwischen geändert worden.',
    'refusal.closeRunning': 'Ein Abschluss läuft noch.',
    'refusal.closeUnfinished': 'Der Abschluss ist damit nicht fertig.',
    'refusal.alreadyCreated': '„{id}" ist inzwischen angelegt. Noch einmal „Sprint anlegen" wählen.',
    'refusal.stateChanged': 'Der Sprint steht inzwischen auf „{state}".',
    'refusal.stateNowIs': 'Der Sprint steht auf „{state}"; ein erneuter Abschluss setzt ihn.',
    'warn.skipped.one': '{count} Eintrag hat keine Id und steht in keiner Historienzeile',
    'warn.skipped.other': '{count} Einträge haben keine Id und stehen in keiner Historienzeile',
    'refusal.closeAborted': 'Abschluss abgebrochen. {written} von {total} Einträgen stehen in der Historie, dann schlug „{item}" fehl ({error}). Kein Report geschrieben, der Status ist nicht gesetzt.',
    'refusal.closeAbortedTail': 'Ein erneuter Abschluss schreibt die vorhandenen Zeilen nicht doppelt.',
    'refusal.reportNotWritten':
      'Abschluss abgebrochen. {rows} geschrieben, der Report nicht ({error}). Der Status ist nicht gesetzt; ein erneuter Abschluss ist gefahrlos.',
    'refusal.statusNotSetReason': 'Historie und Report sind geschrieben, der Status nicht: {reason}',
    'refusal.statusNotSetError': 'Historie und Report sind geschrieben, der Status nicht ({error}).',
    'refusal.closeDone': 'Sprint „{name}" abgeschlossen: {done} von {entries} fertig, {carried} {unit} übernommen.',

    'refusal.duplicateRowId':
      'Die Id „{rowId}" kommt in „{collection}" mehrfach vor; gelesen wird die erste Zeile.',
    'refusal.severalReports':
      'Für einen Sprint liegen mehrere Berichte vor ({rowIds}); gelesen wird der erste.',
    'refusal.severalActive': 'Mehrere Sprints stehen auf „{state}": {names}.',
    'refusal.closedBeforeStart':
      '„{name}" ist am {closedOn} abgeschlossen worden, also vor seinem eigenen Beginn am {start}.',
    'refusal.passWithoutSprint':
      'Eine Historienzeile verweist auf den Sprint „{sprintId}", den es nicht gibt (Eintrag „{itemId}").',
    'refusal.reportMissing':
      'Zu „{name}" ist kein Bericht gespeichert, deshalb gibt es keine Zahlen dazu.',
    'refusal.noEstimateSum': 'Ohne verwertbare Schätzung, daher in keiner Summe: {items}.',
    'refusal.frozenOutside':
      'Der eingefrorene Verlauf enthält Tage außerhalb des Sprintzeitraums: {days}.',
    'refusal.windowTooLong':
      'Der Zeitraum dieses Sprints ist länger als {days} Tage. Dafür wird keine Tagesachse gezeichnet: ein Sprint dauert einen Monat oder weniger.',
    'warn.overlap': 'Die Fenster von „{a}" und „{b}" überlappen sich ({from} bis {to}).',
    'warn.closeUnfinished': 'Abschluss von „{name}" ist unfertig: {written}, Status „{state}".',
    'warn.windowPast.one': '„{name}" steht auf „{state}", das Fenster endete am {end} (vor {count} Tag).',
    'warn.windowPast.other': '„{name}" steht auf „{state}", das Fenster endete am {end} (vor {count} Tagen).',
  },
});
