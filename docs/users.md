# Users

Who belongs to an instance, what they may do, and how somebody gets in.

Part of the Zeitlines documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## What this replaces

A deployment used to have a door and no rooms. The auth gate let in every Google
account on a domain from `ALLOWED_EMAIL_DOMAINS`, and everyone who got in could
read and write every timeline. `app_users` (migration `0015`) was a display
directory that filled itself, deliberately *not* a membership list.

Now an **invitation is the only way in**, every member carries an instance-wide
**role**, and both reads and writes are authorized against it.

**Database instances only.** Membership lives in Postgres, so a deployment
serving only `data/*.json` has nothing to enforce against and says so rather than
refusing everybody (see „What happens without a database" below).

## The one switch

Everything here is off until an operator sets **`TIMELINES_ACCESS_CONTROL=true`**.
That is not timidity: every existing instance, every dev server and every
self-hosted deployment predates the member list, so enforcing on deploy would
refuse everybody the moment the code landed.

Only the exact string `true` enables it. `1`, `yes`, `TRUE` and a typo all leave
it off, because a switch that silently interprets is one nobody can reason about,
and the safe reading of „I do not understand this value" is „behave as before".

| Switch | The gate authorizes by | `/api/*` authorizes by |
| --- | --- | --- |
| off | `ALLOWED_EMAIL_DOMAINS` | nothing — everyone past the gate may do everything |
| on | the member list | the member's role |

The parse lives once in [`src/access.ts`](../src/access.ts) (`accessControlEnabled`),
because three runtimes read the variable from their own environment and must not
disagree about what it means.

## Roles

| Role | May |
| --- | --- |
| `viewer` | read every timeline, and keep **private saved views** of their own |
| `editor` | additionally write items, groups, phases, pricing — what everybody could do before — plus share a saved view with the instance and create one for somebody else |
| `admin` | additionally administer members: invite, change a role, suspend, restore, remove; and change or delete a saved view that belongs to somebody else |

**The saved-view rules are the one place a `viewer` writes**, and the exception is
deliberate: a saved view is display state, not timeline content, and a read-only
member who cannot keep „nur was überfällig ist, nach Owner gruppiert" under a name
has to rebuild it by hand every time, which is the whole thing the feature removes.
The narrower actions still cost more than `read` — publishing to the instance and
naming another owner need `write`, editing somebody else's view needs `manage` — and
all of them are enforced in the write path rather than in the interface. The full
model is „Gespeicherte Ansichten" (docs/editing.md).

Instance-wide, deliberately not per timeline. Per-timeline access is the next cut
and would make every read path timeline-aware; doing that before anything
enforced even the coarse rule would have been the harder thing first.

The rules are pure and live in one module, [`src/access.ts`](../src/access.ts),
imported by the browser, the Netlify edge function, the self-hosted server and
the Vite middleware. Four copies of a permission table is how one of them ends up
fixed and the others do not.

## The lifecycle of a membership

```
        invite               first sign-in
  (—) ───────────► invited ─────────────────► active ◄──────► suspended
                      │                          │      restore     │
                      │ withdraw                 │ remove           │ remove
                      ▼                          ▼                  ▼
                                        r e m o v e d
```

**Removal is a status, never a `DELETE`.** An item's `metadata.owner` stores an
address (see „Item owner" (docs/items.md)), so a deleted row would leave historical
attributions pointing at nothing. Display resolves every status; only `active`
members are offered in the owner picker.

`invited` is a promise rather than access: it opens the sign-in door and nothing
else. Letting it count as membership would hand full access to anybody an admin
has merely typed into the invite dialog.

## Invitations

An admin invites an address and picks a role. The server stores **only the
SHA-256 of the invitation token**, so a database read cannot yield a usable
invitation, and hands the plain token back **once**, in the response that created
it. The interface turns that into a link to copy.

**The token does not authorize.** The identity provider proves the address and
the membership row decides. Two consequences that look like bugs otherwise:

- Somebody who was invited gets in with their address whether or not they ever
  opened the link.
- An invitation is bound to the address it was sent to. Accepting under a
  different address does not exist.

What the token is for: the landing page, and recording *when* an invitation was
accepted. Acceptance itself happens on the first successful sign-in.

Invitations expire (14 days by default, `expiresInDays` overrides it). An expiry
that cannot be parsed does **not** expire an invitation — refusing on „I cannot
read this date" would turn a storage quirk into a lockout — and an expiry left on
an already-active row never refuses them, because accepting clears it.

Mail delivery is #51. Until then the copy-link is the delivery mechanism, and it
stays useful afterwards for an instance with no mail provider configured.

## The API

| Route | Needs | |
| --- | --- | --- |
| `/api/source/<id>/saved-view…` | `read` | the one write path below `write`; the finer rules are per row, see above |
| `GET /api/users` | `read` | the owner picker's directory: address and name |
| `GET /api/members` | `manage` | administration: roles, statuses, invitation state |
| `POST /api/members` | `manage` | invite or re-invite; returns the one-time token |
| `PATCH /api/members` | `manage` | role, status, or resend |
| `GET /api/me` | — | the caller's identity, plus role and status while the switch is on |
| `GET|PATCH /api/preferences` | `read` | the caller's own interface language — see „The language a person reads in" below |

Two paths on purpose. The same `GET` on one path would have meant different
things depending on who asked, and the authorization rule would have had to read
a query string to tell them apart.

The address travels in the **body**, not the path: an e-mail carries `@` and
dots, and the same reasoning already keeps dotted ids out of the pricing matrix's
paths. There is no `DELETE`, because removal is a status.

Two refusals worth knowing:

- **`last_admin` (409).** The last active admin cannot be demoted, suspended or
  removed. An instance without one cannot invite, cannot restore anybody, and is
  recoverable only through the bootstrap variable. The check counts the changed
  row under its *new* values, so promoting somebody in the same call that steps
  down is allowed.
- **`nothing_to_resend` (409).** Resending is only for a membership still
  awaiting acceptance.

## The language a person reads in

`app_users` carries one more column since migration `0025`: `language`, the
interface language this person chose. It lives here rather than in a table of its
own because this is already where per-person facts live, and one nullable column
does not earn a table.

**`read`, not `manage`.** It is the caller's own row. A `viewer` who could not set
their own language would be the role that most needs a readable interface being the
one that cannot choose it — the same reasoning that already lets a `viewer` keep
private saved views.

**NULL means „has not chosen", which is not „chose the default".** A row without a
value follows `TIMELINES_DEFAULT_LANGUAGE`, and it stops following it the moment
one is stored. That is why the column has no default and why clearing a choice is
a distinct act from picking the language the deployment happens to answer with.

**A deployment with no database still switches language.** There is nobody to
store a preference for, so the browser keeps it and the account section says so
(„Nur auf diesem Gerät"). `getUserLanguage` answers `null` there rather than
refusing, because refusing would make the setting unusable on exactly the
instances that are easiest to run.

The migration puts every person already in the directory on `de`, since that was
the only interface that existed before it. Somebody who joins afterwards has never
seen it and gets the deployment's own answer instead. `scripts/db/set-user-language.ts`
reports and changes all of this from a terminal.

## Where enforcement happens

Once, in [`scripts/db/http.ts`](../scripts/db/http.ts) (`authorize`), before any
route branch is chosen. Eleven per-branch checks would be eleven chances to
forget one, and the forgotten one is a write path.

A refusal is **403** with a message, kept apart from the gate's **401**. The
client sends the top window to the login on 401 only; a role refusal reusing that
status would send somebody in a circle, since they are already signed in.

„Not a member" and „wrong role" answer identically. The difference is only useful
to somebody probing which addresses exist.

**The role is not in the session cookie.** That cookie lives 30 days with sliding
renewal, so a suspension carried in it would be stale for weeks. The cookie
proves identity; the rights come from the row, read where a database connection
is open anyway. A suspension therefore takes effect on the very next request.

**Administration is never ungated, and the switch does not open it.** With access
control off there are no roles to decide with, so `/api/members` answers `503`
rather than being served: „the instance has not enabled this", not „you may not".
That check sits *above* the switch, because below it the early return has already
happened — which is exactly the bug that shipped and was fixed in `1ff0435`.

### Non-human callers

The MCP service token authenticates a program, so there is no membership row to
find. Its role comes from **`MCP_TOKEN_ROLE`**, default `editor`, which keeps
existing automations working unchanged on the day the switch is turned on. Set
`viewer` for a read-only agent. Per-user MCP access over OAuth is a membership
like any other and asks the same question the browser gate asks.

### What happens without a database

`GET /api/users` answers an empty directory (the truth for a checkout without
credentials), and `/api/members` answers `503`. Turning the switch on with no
database configured is a misconfiguration and says so — denying everybody would
brick such an instance with no explanation, and ignoring the switch would leave
an operator believing they had enabled something.

## The two ways to lock yourself out

Both are avoidable, and both are why the rollout below has an order.

**No admin.** Until one row carries `admin` with status `active`, nobody can
invite. **`TIMELINES_BOOTSTRAP_ADMIN`** names the address that is made an active
admin on sign-in, whatever state its row is in — created when missing, promoted
when it is an editor, restored when it is suspended or removed. That breadth is
the point: an instance that has been running already has its owner in
`app_users` (migration `0015` backfilled every past editor), so a rule that only
created a missing row would have signed the owner in as an editor into an
instance with **no admin at all**. Keep the variable set: it is the master key,
and it is what gets you back in.

**Emptying `ALLOWED_EMAIL_DOMAINS` too early.** While the switch is off, that
list is what `readSession` validates *every existing cookie* against. Clearing it
in that state invalidates every session at once. It stops being consulted only
once the switch is on.

## Rollout, in order

1. **Apply the migration** (`npm run db:migrate`). Everyone already in the
   directory becomes an `active` `editor`, so nothing changes. This is a
   deliberate manual step: a schema change does not happen as a side effect of a
   deploy.
2. **Set `TIMELINES_BOOTSTRAP_ADMIN`** to your own address. Your next sign-in
   makes that row an active admin; no SQL is needed, and it works whether or not
   the address is already in the directory.
3. **Review the member list.** Who should be `viewer`, who should be `removed`.
   The migration made everyone an editor, which is the old behaviour rather than
   a decision.
4. **Set `TIMELINES_ACCESS_CONTROL=true`.** From here the member list decides:
   an address without a row is refused at sign-in, whatever its domain.
5. **Retire `ALLOWED_EMAIL_DOMAINS`** together with the code that reads it, never
   before step 4.
6. **Close anonymous read access** (#53) last, because it is the only step that
   touches the browser.

Steps 1 to 4 are reversible by unsetting the switch. Step 5 is not, until the
variable is set again.

## Trying it locally

The dev server takes its identity from a `dev_user` cookie, and its `/api/me`
reports role and status exactly like the edge function does — without that the
membership screen could never be opened locally, and „works in production only"
is how a feature stops being verifiable before it ships.

```bash
npm run db:local:up
npm run db:reset
TIMELINES_ACCESS_CONTROL=true npm run dev:local
```

Then, per browser tab:

```js
document.cookie = 'dev_user=alice@example.com; path=/'; location.reload()
```

A fresh database has no members, so every request is refused until one exists.
Either set `TIMELINES_BOOTSTRAP_ADMIN` to that address, or insert the first row
by hand.

## The interface

An admin gets a „Benutzer" screen: the member list, an invite form, and per-row
actions. It is shown only to somebody who may `manage`, and that is an affordance
rather than a permission — every route enforces for itself, so hiding the button
only avoids offering people something that would refuse them.

It is a **section of the settings area** (`#settings=members`), not a screen of
its own — see [`docs/settings.md`](settings.md). It shipped as a dialog on its own
header button, and moving it is what kept the instance from growing a button per
concern. Nothing about the list changed in the move; what it lost is the modal,
its backdrop and the heading it used to draw for itself, all of which the area
now draws once for every section.

With `TIMELINES_ACCESS_CONTROL` off the section renders no member list at all,
only the sentence naming that variable. Roles exist in the table and decide
nothing while the switch is off, so a list there would imply an authority it does
not have.
