# MCP server

Reading and writing DB-backed timelines from an agent.

Part of the Zeitlines documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## MCP server (Claude Code)

A stdio MCP server (`scripts/mcp/server.ts`) lets Claude Code read and
manipulate DB-backed timelines. It **always works against the live site**
(`TIMELINES_LIVE_URL`, **required**, with no default; the server aborts with a
clear message if the variable is missing): every read and write goes through
`/api/source(s)` → the `timelines-api` edge function → the DB. That keeps the DB
the single source of truth and makes changes immediately live.

**Only DB-backed timelines** are exposed. File-based sources are read-only on the
live site and therefore not manipulable here.

### Tools

| Tool                | Effect                                                        |
| ------------------- | ------------------------------------------------------------- |
| `list_timelines`    | Lists all DB timelines (id, name, description)                |
| `list_users`        | Lists the linkable users (email, name) for `metadata.owner`   |
| `get_timeline`      | A complete timeline (items + groups) by id                    |
| `add_item`          | Appends an item (required: `start`, `content`)                 |
| `update_item`       | Patches an item (only the given fields; `metadata` is merged, a `null` value removes its key) |
| `delete_item`       | Removes an item by id                                         |
| `add_group`         | Adds a group                                                  |
| `update_group`      | Patches a group                                               |
| `delete_group`      | Removes a group                                               |
| `replace_timeline`  | Replaces a whole timeline (bulk)                              |
| `set_pricing`       | Replaces the pricing model wholesale (bulk seed; automatically enables the `product-roadmap` plugin) |
| `add_/update_/delete_feature` | A single pricing feature (granular)                  |
| `move_feature`      | Reorders a feature (after/before another one)                 |
| `add_/update_/delete_tier`    | A single tier (granular)                            |
| `set_tier_value`    | One matrix cell (tier × feature); `false`/`null` deletes it; optional `availableFrom` (cell availability from a version) |
| `add_/update_/delete_highlight` | One card tile (granular)                          |
| `set_versions`      | Replaces the ordered version list                             |

The granular item and group tools run read-modify-write: the local server fetches
the timeline, mutates it in memory and writes it back with a PUT (bulk replace);
the remote one reads it to resolve the patch and then writes the single row.

**Why they read at all, on both servers.** The write underneath replaces a whole
column, and it has to: the viewer sends the complete `metadata` object on every
save and depends on the replace to drop a key the user emptied (see
`CLEARABLE_ITEM_FIELDS` in [`src/persistence.ts`](../src/persistence.ts)). Moving
the merge down into the endpoint would make removing the last tag impossible. So
the *patch* these two tools document is resolved against the current value first,
by one shared rule in [`scripts/mcp/patch.ts`](../scripts/mcp/patch.ts). The
remote `update_item` skipped that step and replaced `metadata` wholesale, which
silently dropped every key the caller had not resent, and `update_group` wrote
through an upsert that nulled an unmentioned `nestedGroups`.

`dependsOn` and `owner` live under `metadata`; `owner` carries the e-mail of a
user from `list_users` (see „Item owner" (docs/items.md)), and a free-text name is stored but
renders as unlinked. The granular **pricing** tools instead hit their row's
endpoint directly, with no read-modify-write and no full dump — details under
„Pricing" (docs/pricing.md).

### Auth: service-token bypass

The server attaches an `X-MCP-Token: <MCP_API_TOKEN>` header to every request.
The `timelines-api` edge function lets requests carrying a valid token through
without a Google login (comparing in constant time) and reaches the DB
server-side with the service key. MCP edits are attributed as `mcp` through
`updated_by`.

### Configuration

Server-side (locally, read through the cascade `process.env` → `.env.local` →
`TIMELINES_ENV_FILE`, see „Credential cascade" (docs/database.md)):

| Var                  | Meaning                                                      |
| -------------------- | ------------------------------------------------------------ |
| `MCP_API_TOKEN`      | Bypass token; must match the env var of the same name on the deploy |
| `TIMELINES_LIVE_URL` | Target site (**required**, e.g. `https://<site>.netlify.app`; no default) |

Registering it as a user-global MCP server (usable from any directory):

```bash
claude mcp add -s user timelines -- \
  <repo>/node_modules/.bin/tsx <repo>/scripts/mcp/server.ts
```

(Or directly as an `mcpServers.timelines` entry in `~/.claude.json`.)

### Netlify env (in addition to the Supabase vars)

| Var             | Where              | Notes                                                        |
| --------------- | ------------------ | ------------------------------------------------------------ |
| `MCP_API_TOKEN` | dashboard (secret) | Activates the bypass; identical to the local server's token   |

Prerequisites: `TIMELINES_SUPABASE_URL` / `TIMELINES_SUPABASE_SERVICE_KEY` **and**
`AUTH_REQUIRED=true` must be set, or `timelines-api` does not take effect. If
`MCP_API_TOKEN` is unset the bypass is inactive and the site stays gated behind
the Google login for everyone.
