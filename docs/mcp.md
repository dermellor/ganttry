# MCP server

Reading and writing DB-backed timelines from an agent.

Part of the Ganttry documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
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
| `update_item`       | Patches an item (only the given fields; `metadata` is merged) |
| `delete_item`       | Removes an item by id                                         |
| `add_group`         | Adds a group                                                  |
| `update_group`      | Patches a group                                               |
| `delete_group`      | Removes a group                                               |
| `replace_timeline`  | Replaces a whole timeline (bulk)                              |
| `read_plugin_data`  | The rows one plugin owns on a timeline; one collection or all of them |
| `write_plugin_data` | One row of one collection: `put`, `patch`, `delete` or `move`  |
| `configure_plugin`  | Enables a plugin on a timeline, sets its config, or turns it off |

The granular item and group tools run read-modify-write: the server fetches the
timeline, mutates it in memory and writes it back with a PUT (bulk replace).
`dependsOn` and `owner` live under `metadata`; `owner` carries the e-mail of a
user from `list_users` (see „Item owner" (docs/items.md)), and a free-text name is stored but
renders as unlinked.

**The three plugin tools name no plugin.** There used to be thirteen tools for
one plugin's entities — `set_pricing`, `add_feature`, `set_tier_value` and the
rest — and that was the clearest form the old privilege took: authoring a
third-party plugin's data would have required editing this server first. What a
collection is called and what a row may contain now comes from the plugin's
manifest and is checked server-side, so the tools carry no schema of their own
(see „The generic store" (docs/plugin-storage.md)). They write one row per call,
straight to its endpoint, with no read-modify-write and no full dump; `ifMatch`
carries the row's lock counter so a concurrent edit answers 409 instead of being
overwritten. Bulk seeding is `replace_timeline` with `pluginData`.

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
