# Timelines

Generic timeline viewer for `~/_NOTIZEN`. Reads frontmatter dates from Markdown notes, builds timelines via [vis-timeline](https://visjs.github.io/vis-timeline/), and ships with a brand switcher (marcel-mellor / Acme).

## Ports

Belegt im 3120er-Block (siehe [`~/Development/PORTS.md`](../PORTS.md)).

| Port | Service                       |
| ---- | ----------------------------- |
| 3120 | Vite dev server (Timeline UI) |

URLs:

- `https://timelines.localhost` — primärer Zugang über Caddy (HTTPS, von PM2 verwaltet)
- `http://localhost:3120` — direkt auf Vite

Crasht bei Port-Konflikt (`strictPort: true`), kein Auto-Fallback.

## Architecture

Two-step:

1. **Build script** (`scripts/build-data.ts`) walks `~/_NOTIZEN`, parses YAML frontmatter (`gray-matter`), extracts dates, writes `public/data/notes.json` + a copy of the config.
2. **Static viewer** (Vite + TypeScript, `src/`) loads the JSON, applies the active view's filter, renders a vis-timeline, swaps brand tokens via CSS custom properties.

Electron wrapper can later embed the same `dist/` build.

## Data extraction

- **Date sources** (default order, configurable per view): `date` → `scheduled` → `created` → filename pattern.
- **Filename patterns**: `2026-01-09…`, `20210917…` (regex list in `timelines.config.json`).
- **Range items**: `duration` field (`7d`, `2w`, `90m`, ISO `P7D`) on top of start, OR explicit `end` / `until` field.
- **Skipped**: notes without any resolvable date are omitted.

## Standalone JSON timelines

Drop a `*.json` file into the project's `data/` folder. The build script copies it to `public/data/sources/<basename>.json` and adds it as an automatic view (`id: "src:<basename>"`). No config edit needed.

File shape:

```jsonc
{
  "name": "Projektplan 2026",            // optional, falls back to filename
  "description": "...",                  // optional
  "items": [
    {
      "id": "kickoff",                   // optional
      "start": "2026-01-15",
      "end": "2026-02-28",               // optional, OR
      "duration": "3w",                  // optional ("7d", "2w", "90m", number = ms)
      "content": "Kickoff",
      "group": "Phase 1",                // optional
      "title": "Tooltip text",           // optional
      "type": "point",                   // optional: point | range | background | box
      "body": "Markdown shown in detail panel",  // optional
      "metadata": { "owner": "Product Lead" }  // optional
    }
  ],
  "groups": [
    { "id": "Phase 1", "content": "Phase 1: Discovery" },
    {
      "id": "comm",
      "content": "Kommunikation",
      "nestedGroups": ["comm-product", "comm-tech"],  // optional: children rendered indented under parent, collapse-/expandierbar
      "showNested": true                              // optional, default true
    }
  ]                                      // optional, derived from items if missing
}
```

Items without `start` or `content` are skipped. Two reference files live in `data/`:

- `example-projektplan.json` — minimal 4-phase plan, single track per phase.
- `launch-roadmap.json` — 5 parallel tracks with `dependsOn` cross-references in `metadata`.

### Roadmap conventions

When generating a roadmap (whether for this project or invoked from elsewhere — see the global pointer in `~/.claude/CLAUDE.md`), follow these conventions so files stay consistent and easy to scan:

- **One file per roadmap.** Filename in kebab-case, no umlauts: `q3-roadmap-2026.json`, `feature-x-launch.json`. Becomes `src:<filename>` in the view list automatically.
- **Group IDs with sort prefix.** `1-strategy`, `2-design`, `3-engineering` — vis-timeline sorts groups alphanumerically; the prefix locks the row order.
- **Item IDs use track prefix + counter.** `S-1`, `D-2`, `E-3`, `M-4`, `O-5`. Short, easy to reference from `metadata.dependsOn`.
- **Milestones as `type: "point"`** with no `duration`/`end`. Phase backgrounds as `type: "background"` in their own group.
- **Dependencies live in `metadata.dependsOn: ["id1", "id2"]`.** The viewer renders curved Bezier arrows from each source item's right edge to the target's left edge as an SVG overlay. Off-screen sources/targets simply hide the arrow until they scroll into view. Make sure dependency target items have explicit `id`s so they can be referenced.
- **Bodies are Markdown.** Use them for owner notes, success criteria, links — they show up as the side panel content when the item is clicked.
- **Dates as `YYYY-MM-DD`** without time component unless precision matters. `duration` accepts `Nh|d|w|mo|y` or raw milliseconds.

## Editing JSON timelines

When the active view points to a `data/*.json` file, the viewer becomes editable:

- **Drag** an item left/right to move start, drag the right edge to resize, drag vertically to switch group. Persists on drop.
- **Double-click** on empty timeline space to add a new item (defaults: 1-week duration, current group, content "Neuer Eintrag"). Form opens for further edits.
- **Click** an item to open the edit form in the side panel: title, start/end, duration, group, type, body (Markdown), `dependsOn` IDs, owner, plus a free-form metadata JSON box. Save writes back; Delete removes the item.

Persistence path: viewer → `PUT /api/source/<id>` → middleware writes `data/<id>.json` → watcher copies to `public/data/sources/<id>.json`. The middleware lives in `vite.config.ts`; only available under `npm run dev`/`npm run dev:notes`. Builds (`npm run build`) and exported HTML have no edit endpoint.

## Configuration: `timelines.config.json`

```jsonc
{
  "notesDir": "~/_NOTIZEN",
  "defaultView": "all",
  "dateFields": ["date", "scheduled", "created"],
  "filenameDatePatterns": ["^(\\d{4})-(\\d{2})-(\\d{2})", "^(\\d{4})(\\d{2})(\\d{2})"],
  "views": [
    {
      "id": "kurzbeitraege",
      "name": "Kurzbeiträge",
      "filter": { "filenameContains": "Kurzbeitrag" },
      "dateFields": ["scheduled", "date", "created"],
      "groupBy": "status"
    }
  ]
}
```

### Filter clauses

| Key                 | Type                 | Effect                                            |
| ------------------- | -------------------- | ------------------------------------------------- |
| `filenameContains`  | string               | substring match on filename                       |
| `folder`            | string \| string[]   | folder path (or prefix) match                     |
| `status`            | string \| string[]   | match against `status` frontmatter                |
| `categories`        | string \| string[]   | intersect with `categories` frontmatter           |
| `tags`              | string \| string[]   | intersect with `tags` frontmatter                 |
| `draft`             | boolean              | match `draft: true/false`                         |
| `has`               | string \| string[]   | require frontmatter keys to be set                |
| `allOf` / `anyOf`   | FilterClause[]       | logical combinators                               |
| `not`               | FilterClause         | negation                                          |

### Grouping

`groupBy` is a frontmatter expression: `categories[0]`, `status`, `folder`, `topics[0]`, `tags[0]`. Notes without that field land in an `_ungrouped` bucket.

## Dev / Build

```bash
npm install
npm run dev     # build data + Vite + chokidar watcher on ~/_NOTIZEN
npm run build   # static dist
```

`npm run dev` rebuilds `notes.json` whenever a Markdown file changes.

## Brand switching

CSS custom properties in `src/styles/brands.css`. Body attribute `data-brand="marcel-mellor"` or `data-brand="Acme"` swaps:

- color tokens (bg, fg, accent, item-bg, item-border, …)
- typography (`ABCFavorit` vs. `PX Grotesk` + `Tiempos Headline`)
- mark radius (round vs. square)

Brand persists in `localStorage`. Acme fonts must be present at `public/fonts/acme/` (copy from `~/.claude/skills/graphics/fonts/acme/`).

Two build-time env vars control how the brand selector behaves:

| Var                  | Values                          | Effect                                              |
| -------------------- | ------------------------------- | --------------------------------------------------- |
| `VITE_BRAND_MODE`    | `select` (default) \| `fixed`   | `fixed` hides the dropdown and disables persistence |
| `VITE_DEFAULT_BRAND` | `marcel-mellor` \| `Acme`    | brand applied on first load (and locked in `fixed`) |

## Deploy: Netlify (Acme-internal instance)

A stripped-down, read-only deploy lives on Netlify for Acme colleagues. All
config-as-code lives in [`netlify.toml`](netlify.toml); secrets go into the
Netlify dashboard.

### What gets deployed

- Sources: `data/acme/*.json` only (`TIMELINES_SOURCES_SUBDIR=Acme`).
- Notes scan disabled (`TIMELINES_STATIC_ONLY=true`); no Markdown-driven views.
- Brand locked to Acme (`VITE_BRAND_MODE=fixed`, `VITE_DEFAULT_BRAND=Acme`).
- Editor is read-only — `loadSource()` falls back from `/api/source/<id>` to
  the static `/data/sources/<id>.json`, and `isEditableView()` returns false
  when the API isn't reachable.

To add a Acme-visible timeline locally: drop the JSON into `data/acme/`,
commit, push.

### Auth gate (Netlify Edge Function)

[`netlify/edge-functions/auth.ts`](netlify/edge-functions/auth.ts) gates every
request. Pattern mirrors `~/Development/sales-cockpit` (Google OAuth +
Acme-domain whitelist), but adapted to a static Vite site:

1. `/auth/login` → redirect to Google with `hd=Acme.de`, signed state cookie.
2. `/auth/callback` → token exchange → `userinfo` → domain check → signed
   session cookie (HMAC-SHA256, 24 h, `HttpOnly; Secure; SameSite=Lax`).
3. Any other path without a valid session → 302 to `/auth/login?redirect=…`.

Set `AUTH_REQUIRED=true` in the Netlify dashboard to activate the gate; leave
unset/`false` for local previews. Required runtime env vars:

| Var                     | Where                  | Notes                                            |
| ----------------------- | ---------------------- | ------------------------------------------------ |
| `AUTH_REQUIRED`         | dashboard              | `true` to gate the site                          |
| `GOOGLE_CLIENT_ID`      | dashboard              | OAuth web client                                 |
| `GOOGLE_CLIENT_SECRET`  | dashboard (secret)     | OAuth client secret                              |
| `AUTH_SECRET`           | dashboard (secret)     | `openssl rand -base64 32`                        |
| `ALLOWED_EMAIL_DOMAINS` | dashboard              | comma-separated, default `Acme.de,Acme.com` |

### Google OAuth setup (one-time)

1. Google Cloud Console → APIs & Services → Credentials → **Create credentials → OAuth client ID** → Web application.
2. Authorized redirect URIs: `https://<your-netlify-site>.netlify.app/auth/callback` (and any custom domain).
3. Authorized JavaScript origins: the same origins without the path.
4. Paste the client ID and secret into Netlify env vars.

If the site moves to a new domain, add the new redirect URI in the Google
Cloud Console — otherwise the callback returns `redirect_uri_mismatch`.
