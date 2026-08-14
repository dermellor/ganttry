`AGENTS.md` holds the conventions, the commands and an index. It is imported here
because it is small enough to carry in every session; the per-subsystem chapters in
`docs/` are deliberately **not** imported — read the one you need when a task
touches it.

@AGENTS.md

## Claude-Code-specific overrides

- **Branch-/Commit-Workflow (Session-Start):** Sobald absehbar ist, dass eine
  Session Code ändert, VOR der ersten `Edit`/`Write`-Operation den User per
  interaktiver Frage (`AskUserQuestion`) den Integrationspfad wählen lassen:
  **(a) direkt auf `main`** (Kleinkram, low-risk — Commit auf `main`, der Push
  ist ein separater expliziter Schritt danach) oder **(b) Worktree + Branch +
  GitHub-Issue + PR** (größere/riskantere Features). Für die Änderungsarbeit
  `isolation: "worktree"` nutzen, damit parallele Sessions sich nicht
  verschränken. Die Frage entfällt nur, wenn der User den Modus in der Nachricht
  bereits explizit genannt hat. Begründung + Kriterien: `AGENTS.md` →
  „Branching, Commits & Session Isolation".
- **Interface-Text (harte Grenze):** in die Oberfläche kommen nur Überschriften,
  Labels und Fehler-/Ergebnismeldungen. Keine Subline unter einem Feld, keine
  Notiz neben einem Control, keine erklärende Karte über einem Abschnitt, kein
  Tooltip, der ein Label wiederholt — auch nicht kurz, auch nicht `muted`. Wer
  eine Erklärung vermisst, formuliert das Label um oder fragt nach. Die Regel und
  was als Label gilt: `AGENTS.md` → „Interface text". Ein `PostToolUse`-Hook in
  `.claude/settings.json` fährt nach jedem `Edit`/`Write`
  `scripts/ci/check-ui-text.mjs` und bricht mit Exit 2 ab, sodass ein Verstoß in
  derselben Session auffällt und nicht erst in CI.
- **Live-Preview aus Worktree:** ein Dev-Server aus dem Main-Checkout sieht
  Worktree-Edits nicht. Vor visueller Verifikation aus einem Worktree entweder
  einen zweiten Server aus dem Worktree starten (`npm run dev:worktree`) oder
  vorher mergen. Zwei Fallen kosten sonst eine Runde gegen fremden Code:
  `preview_start` startet im Launch-Verzeichnis der Session (also im
  Main-Checkout, ohne das zu sagen), und HMR lässt die laufende vis-Instanz
  stehen, was wie ein Daten- oder Filterproblem aussieht.
  Dritte Falle: der In-App-Browser cacht pro Origin und ignoriert dabei
  `Cache-Control: no-cache`. Nach einer CSS-/JS-Änderung liefert er das alte
  Modul weiter, auch nach Hard-Reload und in einem frischen Tab — was wie ein
  nicht angewendeter Fix aussieht, während `curl` auf dieselbe URL die neue
  Datei zeigt. Was hilft, ist ein Neustart auf einem anderen `WT_PORT`. Und die
  Prüfung „greift meine Regel?" gehört an den berechneten Stil
  (`getComputedStyle`), nicht an das `hidden`-Property: das ist auch dann
  gesetzt, wenn eine `display`-Regel es überstimmt.
- **Lokales Setup:** falls `.claude/local-setup.md` existiert, sie lesen — dort
  stehen die host-spezifischen Details (Ports, Prozessmanager, Reverse Proxy) und
  der Verifikationsablauf für Worktree-Previews. Die Datei ist absichtlich nicht
  eingecheckt; ohne sie gelten nur die Regeln aus `AGENTS.md`.
- **Foreign-Work-Check:** Zu Beginn einer Änderungs-Session `git status` prüfen.
  Uncommittete Änderungen, die nicht von dieser Session stammen, NIEMALS blind
  mitcommitten — dem User melden und in einem frischen Worktree ab `HEAD`
  arbeiten.
- **Commit / Session-Ende (Done-Gate):** Wenn der User „commit", „committen" oder
  „wrap up" sagt, immer den `/wrap-up` Skill aufrufen. Niemals nur `git commit`
  allein. Eine Code-ändernde Session NIEMALS mit uncommitteten/ungepushten
  Task-Änderungen beenden: „done" = committed + gepusht + Deploy verifiziert
  (Netlify grün). Vor Session-Ende muss `git status` sauber sein (außer bewusst
  ge-`.gitignore`-ten Artefakten).
- **Neues Plugin:** immer den `/new-plugin` Skill aufrufen, nie direkt lospatchen.
  Er fährt [`docs/plugin-playbook.md`](docs/plugin-playbook.md) ab und hält die
  Stopps ein (Eignungs-Gate, Reichweiten-Recherche vor der Benennung, Spec,
  Testanleitung). Der Skill ist bewusst dünn: die Inhalte stehen im Playbook.
- **Push ist immer ein separater, expliziter Schritt.** Committen und Pushen
  niemals als eine Aktion bündeln, niemals automatisch mit dem Commit pushen
  (globale Regel „Never git push without asking"). Erst committen; der Push
  erfolgt danach als eigener Schritt, wenn der User ihn bestätigt.
