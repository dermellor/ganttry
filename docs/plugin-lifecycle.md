# Plugin lifecycle

How a plugin gets onto an instance, onto a timeline, and off both again.

This chapter covers [issue #13](https://github.com/zeitlines/zeitlines/issues/13).
For where a plugin's *data* lives, read
[`plugin-storage.md`](plugin-storage.md); for the seams a plugin plugs into,
[`architecture.md`](architecture.md).

## Two levels, deliberately separate

| | Where it lives | What it means |
| --- | --- | --- |
| **Installed** | `installed_plugins` (migration 0020) | this instance has the plugin's code and granted it capabilities |
| **Enabled** | `timeline_plugins` (migration 0012) | this one timeline uses it, with this config |

A plugin has to be installed before it can be enabled anywhere, and disabling it
on a timeline says nothing about the install. Keeping them apart is what makes
„switch this off here" a cheap, reversible act and „remove this from the
instance" the deliberate one.

**Neither operation discards data.** Only uninstalling with an explicit
`purgeData` does, and it has to be confirmed. The reasoning is that a plugin's
rows are usually the expensive part — a pricing model represents work nobody
wants to redo — while turning the plugin off is something people try in order to
see what happens.

## What the registry stores, and why the manifest is in it

```
plugin_id, version, api_version,
artifact_kind ('builtin' | 'url' | 'package' | 'vendored'), artifact, integrity,
capabilities, manifest, enabled, installed_at, updated_at, updated_by
```

Two of those columns carry more weight than they look:

**`manifest` is stored rather than re-derived.** The host must be able to list,
verify and version-check a plugin *without executing it*, and the write path
enforces a plugin's declared collections against this very copy. Keeping the
manifest that was validated at install time is what keeps those checks working
when the artifact's origin is unreachable — an air-gapped instance is a
requirement, not an edge case.

**`capabilities` is what was GRANTED, not what the plugin claims.** A plugin that
later declares more does not get more. Installing with fewer than the manifest
declares is refused rather than silently narrowed, for the same reason
`register()` refuses an invalid manifest: a plugin running with less access than
it believes it has fails somewhere far from the cause.

`artifact_kind: 'builtin'` is the truthful label for a plugin that shipped inside
the build. There is no artifact to refetch, and calling it anything else would
invite a reinstall of something that was never fetched.

### Where the manifest comes from

Two sources, in order:

1. **The registry**, authoritative once it holds anything at all.
2. **What the build shipped**, which is the fallback and the only source on an
   instance with no registry.

The switch is „is the registry empty", not „does the registry know this id".
Per-id fallback would make uninstalling a built-in plugin impossible: it would
reappear the moment its row was gone. Migration 0017 seeds a row for every plugin
already in use, so an existing deployment never sits in the ambiguous state where
the rule matters — without that seed it would come back from the migration with
an empty registry and a write path refusing every plugin as „not installed",
which is a self-inflicted outage.

A row may legitimately carry no manifest (that is what the seed writes). Such a
row defers to the build, which is why the interface shows a real name and version
for a seeded built-in rather than a bare id.

## A filesystem-only instance

`listInstalledPlugins` returns nothing there and the install writes answer `501`.
That is a statement rather than a gap: „installed" is instance state about
*code* — which artifact was fetched, what hash pins it, which capabilities an
operator granted — and a bare data directory has nowhere to record it and no
loader to act on it. Such an instance can genuinely only run the plugins its build
shipped with. Reporting success would list a plugin as installed that nothing
could ever load. The vendored / offline install path is
[#14](https://github.com/zeitlines/zeitlines/issues/14), which is also where the
loader that would use it arrives.

**Enablement per timeline is implemented on every source kind**, because it is
data on the timeline — the same argument that put the generic store on the repo
seam rather than in Postgres. On a local source the refs go into the file, or
into a directory's `timeline.json`.

## Decisions already settled for the catalogue

There is no catalogue yet — it is
[#15](https://github.com/zeitlines/zeitlines/issues/15), and it was deliberately
blocked until a real second plugin existed to design against. Three questions are
answered, and they are written down here rather than rediscovered later.

**Ids are reverse-DNS** (`com.acme.sprints`), enforced by the manifest validator.
The reasoning is with the rule, in
[`src/pluginHost/manifest.ts`](../src/pluginHost/manifest.ts).

**The instance fetches a catalogue server-side, not from the browser.** A
catalogue is a JSON index somewhere on the internet, and somebody has to download
it. If the page did, the Content-Security-Policy would apply: reading an index
from `plugins.example.com` would mean adding that origin to
`PLUGIN_ALLOWED_ORIGINS` and redeploying **before** an operator can see what is
in it — granting network access to a source they have not looked at. Fetching it
server-side removes that ordering, and it keeps the origin allowlist governing
only where **code** may come from, which is the security-relevant question,
instead of also governing where a list of names may be read from. A purely static
deploy has no server and therefore no catalogue browsing; it loses nothing,
because dropping a directory into `plugins/` is already its install path.

**A yanked version keeps running, and warns.** A plugin can be pulled from a
catalogue after people have installed it — a security bug, a mistake, an
abandoned project. Stopping it on those instances would let a catalogue somebody
else controls switch off a working part of an instance remotely, which is exactly
the central authority this design avoids. Saying nothing would leave an operator
running something withdrawn for a reason. So: it keeps running, the plugin panel
carries the warning next to the other refusal reasons, and a **new** install of a
yanked version is refused — the difference between protecting those who do not
have it and punishing those who do.

## Where an artifact may come from

An artifact that is fetched has to be **pinned** — a `url` install without an
integrity hash is refused, because „version 1.2.0" would otherwise name whatever
that URL serves today — and it has to come from an origin the instance's
Content-Security-Policy allows:

```bash
PLUGIN_ALLOWED_ORIGINS=https://plugins.example.com
```

**The install refuses an origin that is not on the list**, and that ordering is
the point rather than strictness. The policy is a response header, so it is
deployment configuration; installing from an origin it does not allow stores a
row that is guaranteed never to load, and the only symptom is a CSP violation in
the console of whoever opens the app next. The registry knows the URL and the
host knows its own policy, so the two questions are asked together. The refusal
names the variable and the origin, because „not allowed" alone sends an operator
looking for a bug instead of a missing line of configuration.

Two kinds are never asked: a **vendored** artifact is served from the deploy's own
origin by construction, and a **builtin** is not fetched at all. That is what makes
the air-gapped path need no CSP change (`plugins/README.md`).

A runtime that supplies no list at all has no installs refused by it. „The runtime
did not say" must not read as „nothing is allowed", or a caller that cannot see
the policy would be refused by a rule it cannot satisfy.

**What a pin buys, demonstrated:** with the hash stored, changing the artifact's
bytes at its origin makes the plugin refuse to load and the plugin panel say
„der Code weicht von seiner Prüfsumme ab". Everything else on the page keeps
working.

## Who may install

Installing is not editing. It loads third-party code into every session of the
instance and grants it capabilities over other people's timelines, so it cannot
share a permission with „may change an item".

This repository has no role model — the deploy gates on a sign-in domain, which
says „works here", not „runs the place". The honest v1 is therefore an explicit
list plus the server-side MCP token, defaulting to **nobody**:

```bash
PLUGIN_OPERATOR_EMAILS=alice@example.com,bob@example.com
```

Unset means no HTTP caller can install, fail-closed in the same way
`ALLOWED_EMAIL_DOMAINS` is. The MCP token counts as operator access, and that is
a deliberate equivalence rather than a loophole: it is a server-side secret only
whoever configured the deployment holds. Treating it as less would leave the
honest automation path — a script the operator runs — with no way in.

**This is where a role model becomes unavoidable.** A multi-tenant instance needs
per-tenant admins, an audit trail of who granted which capability, and a review
gate in front of the catalog ([#15](https://github.com/zeitlines/zeitlines/issues/15)).
A comma-separated env var is enough for one operator running their own deployment
and is deliberately not enough for anything larger.

Reading the registry is open to anyone past the auth gate: it is what the
interface shows, and hiding which plugins exist protects nothing.

## Version pinning, and a host that outgrows a plugin

An artifact declares the contract range it was built against (`^1`, `^1.2`).
Installing something this host cannot satisfy is refused **at install**, not at
every boot — the second reads as a broken plugin, and the reason is a scroll away
from where it is noticed.

For a plugin already installed when a host upgrade outgrows it, the split that
matters is **the contract stops the code, not the data**:

- its code does not load and its views do not appear;
- the row stays, so nothing is lost and a host downgrade or a plugin update fixes
  it;
- **its data rules keep being enforced.** The rows it stored have not changed
  shape, and the collections its manifest declares are still the right thing to
  validate them against. Refusing those too would mean a host upgrade silently
  turned a plugin's storage into something nothing checks.

The same three-way verdict is computed in one place
([`src/pluginHost/installed.ts`](../src/pluginHost/installed.ts)) because the
loader, the interface and the write path all need it and must not disagree —
three copies is how a plugin ends up invisible in the interface while its writes
still succeed.

## The instance-level off switch

`PATCH /api/plugins/<pluginId>` with `{ enabled }` stops a plugin everywhere
without discarding anything. While it is off:

- its code does not load;
- **its data stays readable but is not writable.** Reads stay open because before
  an uninstall is exactly when someone looks at the data, and an operator deciding
  about rows they cannot see is being asked to guess. Writes stop because „off"
  has to mean something.

## Uninstalling

`DELETE /api/plugins/<pluginId>?confirm=<pluginId>`, operator-only.

The confirmation is the plugin's own id echoed back rather than a boolean, which
is too easy to send by accident from a script iterating a list — and this is the
one operation that can delete data nothing else recovers.

`?purgeData=true` additionally deletes every row the plugin owned and strips the
item `metadata` keys it declared. **The default keeps them**, so an uninstall
meant as „stop running this" cannot silently discard a model, and the response
says which of the two happened.

The metadata half is the one that is easy to forget and impossible to clean up
later: without it a plugin's keys stay on every item that ever carried one, where
they surface as unexplained entries in the raw metadata box with nothing left
that knows what they meant.

## Routes

```
GET    /api/plugins                              the registry, with a verdict per plugin
POST   /api/plugins                              install                       (operator)
PATCH  /api/plugins/<pluginId>   { enabled }     instance-level off switch     (operator)
DELETE /api/plugins/<pluginId>?confirm=…         uninstall                     (operator)

GET    /api/source/<id>/plugin/<pluginId>        is it on for this timeline
PUT    /api/source/<id>/plugin/<pluginId>        enable / reconfigure
DELETE /api/source/<id>/plugin/<pluginId>        disable, keeping the rows
```

MCP mirrors all of it: `list_plugins`, `install_plugin`, `set_plugin_installed`,
`uninstall_plugin`, `enable_plugin`, `disable_plugin`. The full contract is in
[`openapi.yaml`](../openapi.yaml).

## How the state reaches the interface

The registry is both **served** (`GET /api/plugins`) and **baked into the built
config**, for the same reason plugin rows travel inside the timeline file: a
static deploy has no API to ask. The client prefers the API — a plugin installed
after the last build has to appear without one — and falls back to the built copy
when there is no API to answer.

That is not the „try the API, fall back to a stale file" pattern the project bans,
and the difference is what is being fetched: a list of *which plugins exist*, never
a timeline's content. A stale entry here shows one wrong row in a diagnostic list;
a stale timeline would be mistaken for live data.

The interface lists them behind **Plugins** in the footer: name, version, and
either whether this timeline uses the plugin or why it cannot run. It exists for
one question that otherwise has no answer — „why is that view not there?" — since
a plugin the host cannot load simply does not appear, and without somewhere to
look, a version mismatch and a broken plugin are indistinguishable from a bug in
the app.

The reason is shown in the interface's own language from a `reason` code, with the
server's full sentence on hover. The two have different readers: the code is for a
user of a German interface, the sentence carries the specifics (which version,
which manifest field) for logs and for whoever wrote the plugin.

## What is deliberately not here

- **Loading the code.** Nothing in this chapter runs a plugin from an artifact;
  the registry records what would be loaded. The loader, the isolation model, the
  integrity check and the CSP are in
  [`plugin-isolation.md`](plugin-isolation.md) — including why a plugin runs in the
  app's own realm and what protects an instance instead of a sandbox.
- **A catalog.** Distribution, an artifact format and version compatibility across
  a published index are [#15](https://github.com/zeitlines/zeitlines/issues/15).
  Nothing here makes a hosted catalog a precondition: an operator installs by
  posting a manifest, and an air-gapped instance stays possible.
