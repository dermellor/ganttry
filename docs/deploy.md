# Deploy

The Netlify deploy, its auth gate, and JIRA linking.

Part of the Ganttry documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## JIRA linking

The edit form has a **JIRA** field for linking issues to an item. Type two or
more characters to get an autosuggest dropdown (live query against JIRA Cloud's
issue picker); pick a suggestion or paste a key like `PROJ-123` and press Enter.
Linked issues render as removable chips, and the detail panel (live, exported,
and read-only Netlify) shows them as clickable `…/browse/<KEY>` links.

Links are stored per item in `metadata.jira` as `[{ "key": "PROJ-123",
"summary": "…" }]` — the summary is cached so links stay readable without a live
JIRA call. Because it lives in `metadata`, it round-trips through the
`timeline_items.metadata` jsonb column unchanged.

**How the autosuggest is served:**

- **Locally:** Vite dev middleware `GET /api/jira/search?q=` (in `vite.config.ts`)
  proxies the issue picker. Credentials come from the shared cascade
  (`process.env` → `.env.local` → `TIMELINES_ENV_FILE`, see „Credential cascade" (docs/database.md)):
  `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (Atlassian API token). Without them the field
  still works for pasting raw keys — only the live search is disabled.
- **Production (Netlify):** the `jira-api` Edge Function
  (`netlify/edge-functions/jira-api.ts`) proxies the same picker behind the
  auth gate, using a shared service-account token. Activated by
  `JIRA_ENABLED=true` plus `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`
  (runtime-only env vars in the dashboard — the token is a secret).

The picker-response parsing is shared by both runtimes in
`scripts/jira/picker.ts`. Browse-link rendering uses the public, build-time
`VITE_JIRA_BASE_URL` (empty by default → keys render as plain text).

## Deploy: Netlify

A stripped-down static deploy runs on Netlify. Config-as-code lives in
[`netlify.toml`](../netlify.toml); instance-specific values and secrets go in the
Netlify dashboard (Site settings → Environment variables).

### What gets deployed

- **File sources:** committed `data/*.json`, scoped to `data/<subdir>/` when
  `TIMELINES_SOURCES_SUBDIR` is set (dashboard).
- **DB timelines:** discovered from the DB at build time (`collectDbSources`),
  scoped by the same `TIMELINES_SOURCES_SUBDIR` used as an **id namespace prefix**
  (e.g. subdir `acme` → all `acme/…` timelines). No committed stubs; if the build
  can reach the DB but the list query fails, the build fails loudly.
- **Notes scan:** off when `TIMELINES_STATIC_ONLY=true`, which then also drops the
  notes-driven views. It is a per-deploy policy choice and therefore a dashboard
  variable, not committed in `netlify.toml`: an instance that does serve notes
  leaves it unset.
- **Editing** is live when the Supabase env vars are set (see „Postgres as the
  data source → Production setup"): the `timelines-api` edge function serves
  DB-backed timelines editable. Without those vars, the DB read fails and the
  viewer surfaces an error — there is no static content fallback (see „Principle:
  no emergency or fallback data").

To add a deploy-visible file source: drop the JSON into the scanned `data/`
folder, commit, push. DB timelines appear automatically once they exist in the DB
under the deploy's namespace.

### Auth gate (Netlify Edge Function)

[`netlify/edge-functions/auth.ts`](../netlify/edge-functions/auth.ts) gates every
request with Google OAuth restricted to an allowed-domain whitelist, adapted to a
static Vite site:

1. `/auth/login` → redirect to Google with `hd=<allowed domain>`, signed state cookie.
2. `/auth/callback` → token exchange → `userinfo` → domain check → signed
   session cookie (HMAC-SHA256, `HttpOnly; Secure; SameSite=Lax`).
3. Any other page navigation without a valid session → 302 to
   `/auth/login?redirect=…`; an `/api/*` call without a valid session → `401`
   JSON (`{ "error": "session_expired" }`) so the SPA fails loud instead of the
   fetch chasing a cross-origin login redirect and the edit silently vanishing.
   The client (`apiJson` / `loadSource` in [`src/editor.ts`](../src/editor.ts))
   catches the `401` and sends the top window to the login, preserving the view.

**Sliding session (no silent expiry).** The session cookie is **not** a fixed
one-shot token. Its base lifetime is 30 days (`SESSION_MAX_AGE` in
[`_shared/session.ts`](../netlify/edge-functions/_shared/session.ts)), but the gate
re-issues the cookie with a fresh expiry whenever an authenticated request lands
in the **second half** of its life (`SESSION_RENEW_THRESHOLD`, via `ctx.next()`
on the way out). An actively used session is therefore continually topped up and
never expires from under the user; the 30-day base only bites after a genuine
stretch of inactivity. This replaced the old fixed 24 h token, which logged
active users out mid-edit exactly 24 h after login.

Set `AUTH_REQUIRED=true` in the Netlify dashboard to activate the gate; leave
unset/`false` for local previews. Required runtime env vars:

| Var                     | Where                  | Notes                                            |
| ----------------------- | ---------------------- | ------------------------------------------------ |
| `AUTH_REQUIRED`         | dashboard              | `true` to gate the site                          |
| `GOOGLE_CLIENT_ID`      | dashboard              | OAuth web client                                 |
| `GOOGLE_CLIENT_SECRET`  | dashboard (secret)     | OAuth client secret                              |
| `AUTH_SECRET`           | dashboard (secret)     | `openssl rand -base64 32`                        |
| `ALLOWED_EMAIL_DOMAINS` | dashboard              | comma-separated allowed sign-in domains; code default empty (fail-closed). Set your own; the auth edge function reads it at runtime, so it must be a runtime env var (not just build-time in `netlify.toml`) |

### Google OAuth setup (one-time)

1. Google Cloud Console → APIs & Services → Credentials → **Create credentials → OAuth client ID** → Web application.
2. Authorized redirect URIs: `https://<your-netlify-site>.netlify.app/auth/callback` (and any custom domain).
3. Authorized JavaScript origins: the same origins without the path.
4. Paste the client ID and secret into Netlify env vars.

If the site moves to a new domain, add the new redirect URI in the Google
Cloud Console — otherwise the callback returns `redirect_uri_mismatch`.
