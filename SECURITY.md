# Security Policy

## Supported versions

Ganttry has no tagged releases yet. Only the current `main` branch is supported;
fixes land there.

## Reporting a vulnerability

Please report privately, not as a public issue: open a
[security advisory](https://github.com/dermellor/ganttry/security/advisories/new)
on this repository. That keeps the report visible only to the maintainers until a
fix is out.

Useful in a report: what an attacker can reach, the deployment shape it applies
to (self-hosted with your own Postgres, or the Netlify deploy with the auth gate
and Supabase), and a way to reproduce it.

## Deployment-dependent by design

Whether something is a vulnerability here often depends on how an instance is
configured, so it helps to name the configuration you tested.

- **The auth gate is opt-in.** `AUTH_REQUIRED=true` activates it; without it the
  deploy is ungated. An ungated instance being readable is a configuration
  choice, not a flaw.
- **`ALLOWED_EMAIL_DOMAINS` is empty by default** and fails closed, so nobody
  passes sign-in until it is set. A bypass of that domain check *is* a
  vulnerability.
- **The service-role key is server-side only.** It lives in `TIMELINES_SUPABASE_SERVICE_KEY`
  (or `TIMELINES_DATABASE_URL`) and is used by the Vite dev middleware and the
  Netlify edge functions. If it ever reaches a client bundle, that is a
  vulnerability, so please report it.
- **The Supabase anon key is deliberately public** when realtime is enabled.
  `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are build-time variables baked
  into the browser bundle to drive live collaboration, and the anon SELECT
  policies make timeline *reads* available to anyone holding that key. This is a
  documented trade-off ([`docs/database.md`](docs/database.md) → „Realtime"), which is why realtime is opt-in
  per environment. Finding the key in the bundle is expected; finding a *write*
  path through it is not.
- **`MCP_API_TOKEN` bypasses the auth gate** by design, so that the MCP server
  can reach the API without a browser login. Weaknesses in how that token is
  compared or scoped are in scope.

## Not vulnerabilities

- Missing rate limits on the local dev server (`npm run dev` is not meant to be
  exposed).
- The 7 known type errors reported by `npm run typecheck`.
