Single Source of Truth lies in `AGENTS.md`.
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
- **Live-Preview aus Worktree:** ein Dev-Server aus dem Main-Checkout sieht
  Worktree-Edits nicht. Vor visueller Verifikation aus einem Worktree entweder
  einen zweiten Server aus dem Worktree starten (`npm run dev:worktree`) oder
  vorher mergen. Zwei Fallen kosten sonst eine Runde gegen fremden Code:
  `preview_start` startet im Launch-Verzeichnis der Session (also im
  Main-Checkout, ohne das zu sagen), und HMR lässt die laufende vis-Instanz
  stehen, was wie ein Daten- oder Filterproblem aussieht.
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
- **Push ist immer ein separater, expliziter Schritt.** Committen und Pushen
  niemals als eine Aktion bündeln, niemals automatisch mit dem Commit pushen
  (globale Regel „Never git push without asking"). Erst committen; der Push
  erfolgt danach als eigener Schritt, wenn der User ihn bestätigt.
