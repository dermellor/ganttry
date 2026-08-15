// German, typed as a total record over the reference catalogue — a key added to
// `messages.en.ts` and forgotten here does not compile.
//
// **The wording is the wording that shipped.** Every string here was lifted from
// the call site it used to sit at, unchanged, including its punctuation and its
// ellipses. That is the whole acceptance criterion for a German reader: this
// change gives them a setting they did not have, and nothing else. A tidier
// phrasing spotted in passing is a separate change with its own reason, because
// bundling one into a 300-string move makes both unreviewable — nobody can tell a
// deliberate rewording from a transcription slip in that diff.
//
// The rules for what may be here at all, and why `refusal.` is exempt from the
// eight-word limit, are in the header of `messages.en.ts`.

import type { EN } from './messages.en.ts';

export const DE: Record<keyof typeof EN, string> = {
  // ── Chrome: the header, the menu, the shell ──────────────────────────────
  'app.menu': 'Menü',
  'app.search': 'Suchen…',
  'app.settings': 'Einstellungen',
  'app.settings.timeline': 'Einstellungen dieser Timeline',
  'app.settings.close': 'Einstellungen schließen',
  'app.settings.timeline.close': 'Timeline-Einstellungen schließen',
  'app.signOut': 'Abmelden',
  'app.noInstanceActions': 'Keine Instanz-Aktionen',
  'app.loadingConfig': 'Lade Konfiguration…',
  'app.loading': 'Wird geladen …',
  'app.plugins.state': 'Installierte Plugins und ihr Zustand',

  // ── The timeline switcher ────────────────────────────────────────────────
  'switcher.open': 'geöffnet',
  'switcher.noMatch': 'Keine Timeline passt dazu.',
  'switcher.readOnly': 'Nur lesend',

  // ── Items ────────────────────────────────────────────────────────────────
  'item.create': '+ Eintrag',
  'item.create.aria': 'Neuen Eintrag hinzufügen',
  'item.new': 'Neuer Eintrag',
  'item.delete': 'Eintrag löschen',
  'item.children.show': 'Untereinträge einblenden',
  'item.children.hide': 'Untereinträge ausblenden',
  'item.children': 'Untereinträge',
  'item.parent': 'Übergeordnet',
  'item.search': 'Eintrag suchen…',
  'item.background.edit': 'Hintergrund-Eintrag bearbeiten',
  'item.selectedBy': 'hat diesen Eintrag ausgewählt',
  'item.unsaved': 'noch nicht gespeichert',
  'item.count.one': '{count} Eintrag',
  'item.count.other': '{count} Einträge',

  // ── The item form ────────────────────────────────────────────────────────
  'form.save': 'Speichern',
  'form.cancel': 'Abbrechen',
  'form.delete': 'Löschen',
  'form.close': 'Schließen',
  'form.add': 'hinzufügen…',
  'form.select': 'Auswählen…',
  'form.noValue': 'kein Wert',
  'form.noIcon': 'kein Icon',
  'form.noIcon.option': '— kein Icon —',
  'form.endEmpty': 'leer = Ende nutzen',
  'form.milestoneOnly': 'nur ohne End-Datum',
  'form.dateTime': 'Datum & Uhrzeit',
  'form.dependsOn': 'Hängt ab von',
  'form.metadata': 'Weitere Metadaten (JSON)',
  'form.jira.search': 'Ticket oder Key, z. B. PROJ-123…',
  'form.owner.search': 'Person suchen…',
  'form.owner.unreachable': 'Benutzerverzeichnis nicht erreichbar',
  'form.owner.empty': 'Noch keine Benutzer erfasst',
  'form.moveUp': 'Nach oben',
  'form.moveDown': 'Nach unten',

  // ── Custom fields ────────────────────────────────────────────────────────
  'field.key': 'Schlüssel',
  'field.label': 'Bezeichnung',
  'field.add': '+ Feld',
  'field.none': 'Noch keine eigenen Felder.',
  'field.contextMenu': 'Auch im Rechtsklick-Menü anbieten',
  'field.options.hint': 'einer pro Zeile: wert = Beschriftung #farbe',
  'field.optional': 'optional',

  // ── Filter, grouping, presentation ───────────────────────────────────────
  'view.grouping': 'Gruppieren',
  'view.filter': 'Filter',
  'view.presentation': 'Darstellung',
  'view.filterValues': 'Filterwerte',
  'view.areas': 'Bereiche',
  'view.timeline': 'Timeline',
  'view.list': 'Liste',
  'view.graph': 'Graph',
  'app.timelines': 'Timelines',
  'app.online': 'Online',
  'app.plugins': 'Plugins',
  'filter.all': 'Alle Werte',
  'filter.count.one': '1 Wert',
  'filter.count.other': '{count} Werte',
  'filter.emptyBucket': 'Ohne {field}',
  'group.default': 'Gruppe (Standard)',
  'view.empty': 'Keine Einträge in dieser View.',
  'view.empty.filtered': 'Keine Einträge, die die Filter passieren lassen.',

  // ── Saved views ──────────────────────────────────────────────────────────
  'savedView.plural': 'Gespeicherte Ansichten',
  'savedView.name': 'Name der Ansicht',
  'savedView.name.new': 'Name der neuen Ansicht',
  'savedView.shared': 'Für alle Mitglieder dieser Instanz sichtbar',
  'savedView.saveCurrent': 'Aktuelle Einstellung speichern…',
  'savedView.leave': 'Ansicht verlassen',
  'savedView.close': 'Ansicht-Einstellungen schließen',

  // ── The timeline's own settings ──────────────────────────────────────────
  'timeline.settings.grouping': 'Gruppierung beim Öffnen',
  'timeline.settings.export': 'Als HTML herunterladen',
  'timeline.none': 'Keine Timeline geladen.',
  'timeline.noChange': 'Keine Änderung.',
  'timeline.saved': 'Gespeichert.',

  // ── The instance settings area ───────────────────────────────────────────
  'settings.section.instance': 'Instanz',
  'settings.section.members': 'Benutzer',
  'settings.section.account': 'Konto',
  'settings.none': 'Diese Instanz deklariert keine Einstellungen.',
  'settings.unset': 'nicht gesetzt',
  'settings.set': 'gesetzt',
  'settings.default': '(Standard)',
  'settings.column.setting': 'Einstellung',
  'settings.column.value': 'Wert',
  'settings.origin': 'Herkunft',
  'settings.on': 'an',
  'settings.off': 'aus',
  'settings.empty': 'leer',
  'settings.home.env': 'Umgebung',
  'settings.home.build': 'Build',
  'settings.home.db': 'Datenbank',

  // ── The declared settings, by variable ───────────────────────────────────
  'setting.group.access': 'Zugang',
  'setting.group.automation': 'Automation',
  'setting.group.data': 'Daten',
  'setting.TIMELINES_ACCESS_CONTROL': 'Zugriffskontrolle',
  'setting.TIMELINES_BOOTSTRAP_ADMIN': 'Master-Key (erster Administrator)',
  'setting.AUTH_REQUIRED': 'Anmeldung erforderlich',
  'setting.ALLOWED_EMAIL_DOMAINS': 'Erlaubte Anmelde-Domains',
  'setting.TIMELINES_TRUSTED_IDENTITY_HEADER': 'Identitäts-Header des Proxys',
  'setting.TIMELINES_ALLOWED_EMAIL_DOMAINS': 'Erlaubte Domains hinter dem Proxy',
  'setting.MCP_TOKEN_ROLE': 'Rolle der Service-Token',
  'setting.MCP_API_TOKEN': 'Service-Token',
  'setting.TIMELINES_DATABASE_URL': 'Postgres-Verbindung',
  'setting.TIMELINES_SUPABASE_URL': 'Supabase-Projekt',
  'setting.TIMELINES_SUPABASE_SERVICE_KEY': 'Supabase-Service-Key',
  'setting.TIMELINES_DB_LIVE': 'Live-Updates',
  'setting.TIMELINES_DATA_DIR': 'Datenverzeichnis',
  'setting.TIMELINES_SOURCES_SUBDIR': 'Gebaute Datenquellen',
  'setting.TIMELINES_DEFAULT_LANGUAGE': 'Vorgabesprache',

  // ── The account section: the first writable setting ──────────────────────
  'account.language': 'Sprache',
  // The two language names stay in their own language in both catalogues: a
  // German reader looking for English finds „English", not „Englisch", and the
  // reverse holds. This is the one pair of labels that must not be translated.
  'account.language.de': 'Deutsch',
  'account.language.en': 'English',
  'account.local': 'Nur auf diesem Gerät',

  // ── Members ──────────────────────────────────────────────────────────────
  'members.invite': 'E-Mail-Adresse einladen',
  'members.none': 'Noch niemand eingeladen.',
  'members.inviteLink': 'Einladungslink für',

  // ── Plugins ──────────────────────────────────────────────────────────────
  'plugin.active': 'in dieser Timeline aktiv',
  'plugin.inactive': 'nicht aktiv',
  'plugin.disabled': 'für diese Instanz abgeschaltet',
  'plugin.versionMismatch': 'passt nicht zu dieser Host-Version',
  'plugin.manifestInvalid': 'das Manifest ist nicht mehr gültig',
  'plugin.originUnsupported': 'die Herkunft des Codes wird nicht unterstützt',
  'plugin.unreachable': 'der Code ist nicht erreichbar',
  'plugin.checksumMismatch': 'der Code weicht von seiner Prüfsumme ab',
  'plugin.codeMismatch': 'der Code passt nicht zum Manifest',
  'plugin.loadFailed': 'das Laden ist gescheitert',
  'plugin.unloadable': 'kann nicht geladen werden',

  // ── The graph ────────────────────────────────────────────────────────────
  'graph.dependency': 'Abhängigkeit',
  'graph.parent': 'Übergeordnet',

  // ── Connection ───────────────────────────────────────────────────────────
  'sync.noApi': 'keine Verbindung zur API',
  'sync.offline': 'keine Verbindung',
  'sync.conflict': 'Konflikt: extern geändert, lade neu…',

  // ── Refusals and results ─────────────────────────────────────────────────
  'refusal.field.keyMissing': 'Ohne Schlüssel kann das Feld nichts speichern.',
  'refusal.field.keyShape': 'Der Schlüssel darf nur Buchstaben, Ziffern, „-" und „_" enthalten und muss mit einem Buchstaben beginnen.',
  'refusal.field.keyReserved': '„{key}" hat schon ein eigenes Feld im Formular.',
  'refusal.field.keyFromPlugin': '„{key}" kommt von einem Plugin. Ein gespeichertes Feld darauf würde nie erscheinen.',
  'refusal.field.keyTaken': '„{key}" ist schon vergeben (Feld {index}).',
  'refusal.field.labelMissing': 'Ohne Bezeichnung weiß niemand, was das Feld meint.',
  'refusal.field.optionsMissing': 'Eine Auswahl ohne Werte kann nichts auswählen.',
  'refusal.settings.unreadable': 'Diese Laufzeit kann ihre eigene Konfiguration nicht lesen.',
  'refusal.forbidden': 'Dafür fehlen dir die Rechte.',
  'refusal.accessControlOff':
    'Die Zugriffskontrolle ist auf dieser Instanz aus: TIMELINES_ACCESS_CONTROL=true schaltet sie ein.',
  'refusal.members.lastAdmin': 'Das würde die Instanz ohne aktiven Administrator zurücklassen.',
  'refusal.members.nothingToResend': 'Diese Mitgliedschaft wartet auf keine Einladung.',
  'refusal.members.needsDatabase': 'Für Mitgliedschaften braucht diese Instanz eine Datenbank.',
  'refusal.members.off': 'Die Benutzerverwaltung ist auf dieser Instanz nicht eingeschaltet.',
  'refusal.members.unreadable': 'Die Mitgliederliste ist nicht lesbar. Vermutlich fehlt die Migration.',
  'refusal.members.invalid': 'Diese Eingabe ist nicht gültig.',
  'refusal.members.notAMember': 'Diese Adresse ist kein Mitglied.',
  'refusal.members.linkCopy': 'Link markiert — mit Strg/Cmd+C kopieren.',
  'refusal.metadata.invalid': 'Metadata JSON ungültig — Änderung nicht übernommen.',
  'refusal.conflict.item': 'Dieser Eintrag wurde extern geändert — beim Speichern wird neu geladen.',
  'refusal.account.saveFailed': 'Nicht gespeichert.',
  'refusal.account.saved': 'Gespeichert.',
};
