# Live-Preview aus einem Worktree verifizieren

Gilt, sobald eine Worktree-Session visuell prüfen will, was sie geändert hat.
Beide Fallen unten haben je eine komplette Verifikationsrunde gekostet, weil das
sichtbare Ergebnis plausibel aussah und trotzdem nicht der eigene Code war.

## Ports: PM2 nie stoppen

Der Vite-Dev-Server auf **3120** läuft unter PM2 aus dem **Main-Checkout** und
sieht Worktree-Edits nicht. Worktree-Previews laufen auf dem fünfstelligen Pool
**31200–31209**, PM2 bleibt parallel auf 3120. Niemals PM2 stoppen, um 3120
freizumachen: das reißt `ganttry.localhost` für alle anderen Sessions weg.
Ableitung des Pools: `AGENTS.md` → „Ports → Worktree-Live-Preview".

## Ablauf

1. **Server aus dem Worktree starten**, per Bash, mit dem Worktree als cwd:

   ```bash
   WT_PORT=31201 npm run dev:worktree
   ```

   **Nicht** `preview_start {name: "vite-worktree"}` dafür nehmen: das startet den
   Server im **Launch-Verzeichnis der Session**, also im Main-Checkout, und sagt
   das nirgends. Der Browser wird danach separat mit `preview_start {url: "…"}`
   angehängt.

2. **Prüfen, dass wirklich der Worktree-Code läuft** — vor dem ersten Klick:

   ```bash
   curl -s localhost:31201/src/<geänderte-datei>.ts | grep -c '<neues Symbol>'
   ```

   `0` Treffer = falscher Checkout. Gegenprobe, wenn im Main-Checkout fremde
   uncommittete Arbeit liegt: auf ein Symbol *daraus* grepen — findet man es, ist
   es sicher der falsche Server.

3. **Nach jedem Edit hart neu laden** (`location.reload()`), nicht auf HMR
   verlassen. Die vis-Timeline wird einmal pro Render aufgebaut; ein partielles
   HMR-Update lässt die laufende Instanz stehen. Symptom: neue Daten sind geladen
   (die Statuszeile zählt sie mit), aber das betreffende Item ist nicht im DOM —
   das sieht wie ein Daten- oder Filterproblem aus und ist keines.

4. Erst danach klicken/screenshotten.

## Am Ende

Server stoppen und den Worktree aufräumen, sobald die Änderungen auf `main` sind
(`git worktree remove`). Nach einem Merge den Main-Checkout resyncen, sonst
serviert PM2 auf 3120 weiter den alten Stand: `AGENTS.md` → „Branching, Commits &
Session Isolation".
