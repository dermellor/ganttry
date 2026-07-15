Single Source of Truth lies in `AGENTS.md`.
@AGENTS.md

## Claude-Code-specific overrides

- **Branch-/Commit-Workflow (Session-Start):** Sobald absehbar ist, dass eine
  Session Code ändert, VOR der ersten `Edit`/`Write`-Operation den User per
  interaktiver Frage (`AskUserQuestion`) den Integrationspfad wählen lassen:
  **(a) direkt auf `main`** (Kleinkram, low-risk) oder **(b) Worktree + Branch +
  GitHub-Issue + PR** (größere/riskantere Features). Für die Änderungsarbeit
  `isolation: "worktree"` nutzen, damit parallele Sessions sich nicht
  verschränken. Die Frage entfällt nur, wenn der User den Modus in der Nachricht
  bereits explizit genannt hat. Begründung + Kriterien: `AGENTS.md` →
  „Branching, Commits & Session Isolation".
- **Live-Preview aus Worktree (Pool 31200–31209, PM2 nie stoppen):** Der
  Vite-Dev-Server (PM2) läuft aus dem Main-Checkout auf 3120 und sieht
  Worktree-Edits nicht. Braucht eine Aufgabe visuelle Verifikation, den
  Worktree-Server auf einem fünfstelligen Preview-Port aus dem Pool **31200–31209**
  starten (`npm run dev:worktree`, Default 31200; für weitere parallele Previews
  `WT_PORT=31201 npm run dev:worktree` usw.). In Claude Code die Launch-Configs
  `vite-worktree` / `vite-worktree-2` / `vite-worktree-3`. **Niemals PM2 stoppen**,
  um 3120 freizumachen (reißt `timelines.localhost` für andere Sessions weg).
  Preview dann unter `http://localhost:31200` (bzw. der gewählte Port). Alternativ
  erst nach `main` mergen und dort prüfen. Details: `AGENTS.md` → „Ports →
  Worktree-Live-Preview".
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
