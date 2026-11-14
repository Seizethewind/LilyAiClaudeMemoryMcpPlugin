# lily-memory-mcp

Self-hosted MCP server for Claude: **GitHub read/write tools** (from `lily-github-mcp-bridge`) plus **persistent memory on Turso**.

Each memory entry = **your prompt + Claude's plan + the result**, and every entry belongs to exactly one **repository** (`owner/name`, case-insensitive). Repository names are unique, so there are no look-alike scopes: a typo like `acme/widgit` next to `acme/widget` is refused until Claude confirms it really is a new repository. `general` is the one scope for work that belongs to no repository.

## The flow
1. You ask for something.
2. Claude works out which repository it is about (and asks you if unclear), then calls `memory_start` with it: what was done there before, unfinished work, pinned notes. For a new repository it lists similar names instead.
3. Claude calls `memory_save` (repo + prompt + plan) → status `planned`, returns an id.
4. Claude does the work.
5. Claude calls `memory_update` (id + result + status `done|partial|failed`).
6. Next prompt: repeat. `memory_repos` shows which repositories have memory; `memory_search` / `memory_timeline` dig deeper (one repository or all).

The server sends these instructions to Claude automatically on connect.

## Tools
GitHub (unchanged): `get_file_contents`, `create_or_update_file`, `delete_file`, `list_branches`, `create_branch`, `push_files`.
Memory: `memory_start`, `memory_repos`, `memory_save`, `memory_update`, `memory_search`, `memory_timeline`, `memory_get`, plus removal and housekeeping: `memory_forget`, `memory_wipe_repo`, `memory_trash`, `memory_restore`, `memory_lock_repo`, `memory_rename_repo`.
Blueprint: `blueprint_get`, `blueprint_save`, `blueprint_history` (see below).
PandaStack (optional, see [PandaStack](#pandastack)): sandboxes (`sandbox_*`), `web_search` / `web_fetch`, volumes, databases, apps and a generic `pandastack_api`.

Search/timeline return compact rows; `memory_get` returns full entries (keeps token use low).

## Setup
1. **Turso:** `turso db create lily-memory` → `turso db show lily-memory --url` → `turso db tokens create lily-memory`.
2. **Render:** new Web Service from this repo (or use `render.yaml`). Build: `npm install && npm run build`, start: `npm start`.
3. **Env vars:** copy `.env.example`. Required: `GITHUB_TOKEN`, `MCP_ADMIN_SECRET`, `MCP_BASE_URL`, `ALLOWED_REPOS`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
4. **claude.ai:** Settings → Connectors → Add custom connector → `https://<your-service>/mcp`, approve with the admin secret.
5. **Keep-alive:** the built-in self-ping runs every 10 min (`SELF_PING=false` to disable). An external pinger (UptimeRobot) on `/health` is a good second layer.

If Turso is missing/unreachable the GitHub tools still work and memory tools are simply not listed (see logs).

## Blueprint
Memory entries log each request. The **Blueprint** is the one living document per repository, updated in place, that says what the repository *is*:

| Section | Holds |
|---|---|
| `overview` | what it is, stack, current state |
| `architecture` | structure, components, data flow, build/run/deploy |
| `implementation` | how the important parts work, in detail |
| `logic` | why it is built this way (only reasons that are actually known) |
| `tests` | how to run them, latest results with date/commit/command, what was *not* verified |
| `improvements` | ranked next steps, bugs, risks |

- `blueprint_get` returns an outline by default (cheap); pass `sections` for full text. `memory_start` reports whether a blueprint exists.
- `blueprint_save` replaces (`sections`) or extends (`append`) sections; secrets are redacted, each section is capped at 20,000 characters. Pass `based_on` (commit SHA) and `base_version` so a concurrent edit is refused instead of overwritten.
- Every save is snapshotted (last 10 per section, `blueprint_history`); to undo, save the old content again.
- Forgetting or wiping memory never touches a blueprint. Claude cannot delete one: only the admin page can (phrase `DELETE BLUEPRINT owner/name`, refused while the repository is locked).
- Stored in schema v3 (additive; existing databases upgrade automatically).

## Removing memory
Three levels, each more protected than the one before it:

| Level | How | Protection |
|---|---|---|
| One entry | `memory_forget` (repo + id) | Must match the entry's repository; pinned entries must be unpinned first. Goes to the **trash**. |
| One repository | `memory_wipe_repo` | Two steps: a preview (counts, newest titles, one-time token, exact phrase like `WIPE owner/name 12`), then a confirm call with token + phrase. Claude must show you the preview and get your explicit yes. Token is single-use, expires in 10 minutes and is void if the repository changed. Pinned entries are skipped unless `include_pinned`. Locked repositories are refused. Goes to the **trash**. |
| Everything | **Admin page only**: `https://<your-service>/admin/memory` | No MCP tool exists for it. Needs the admin secret typed in a browser (rate-limited, 15-minute session cookie, CSRF-protected) and the phrase `WIPE ALL MEMORY`. Skips locked repositories and pinned entries unless ticked. Goes to the **trash**. |

Things that make an accidental wipe recoverable:
- **Trash:** removed entries stay restorable (`memory_restore`, or the admin page) for `TRASH_RETENTION_DAYS` (default 30), then are erased for good. Only the admin page can empty the trash early (phrase `EMPTY TRASH`), so Claude cannot permanently destroy anything in one step.
- **Locks:** `memory_lock_repo` protects a repository against wipes and renames. Claude can lock; only you can unlock (admin page).
- **Audit log:** every removal, restore and lock is recorded (who, what, which repository, counts; never entry content). It is shown on the admin page.
- The nightly backup leaves out removed entries, so a restore within the day is not lost either. Backups already pushed stay in that repository's git history.

Upgrading from an older version is automatic: existing entries are kept; free-form project labels move to `general` (tagged `legacy-project:<old label>`), and old breakdown entries move under the repository they describe. Use `memory_rename_repo` to correct a name afterwards.

## PandaStack

[PandaStack](https://docs.pandastack.ai) runs disposable Firecracker microVMs. With a key set, Claude can boot one (about 0.2 s from a snapshot), run commands and headless Chromium/Playwright in it, and use the rest of the platform.

1. Create a token in the PandaStack dashboard (API Tokens) and set `PANDASTACK_API_KEY`. Nothing is registered without it.
2. Reconnect the connector so Claude sees the new tools.

**Several keys.** `PANDASTACK_API_KEY=k1,k2,k3` (any number) rotates in order: the first new job uses k1, the next k2, then k3, then k1 again. A sandbox, volume, snapshot, database or app stays with the key that created it, so follow-up calls use that key. A key that is rate limited, out of capacity or rejected is skipped for a while (10 minutes if rejected). Keys never appear in results or errors; `pandastack_status` shows slots (`key 2/3`) only. Keys from different accounts work too; lists (`sandbox_list`, `volume_list`, ...) merge all of them and show `key_slot`.

| Group | Tools |
|---|---|
| Status | `pandastack_status` |
| Sandboxes | `sandbox_create` (template, ttl, `from_snapshot`, `volumes`), `sandbox_list`, `sandbox_get`, `sandbox_delete`, `sandbox_exec`, `sandbox_logs`, `sandbox_templates` |
| Files | `sandbox_write_file`, `sandbox_read_file`, `sandbox_list_dir`, `sandbox_stat`, `sandbox_remove_path` |
| Ports | `sandbox_preview_url`, `sandbox_ports`, `sandbox_expose_port`, `sandbox_remove_port` |
| Lifecycle | `sandbox_pause`, `sandbox_resume`, `sandbox_hibernate`, `sandbox_wake`, `sandbox_lifecycle_get`, `sandbox_lifecycle_set` |
| Snapshots, forks | `sandbox_snapshot_create/list/get/delete`, `sandbox_fork`, `sandbox_fork_tree`, `sandbox_promote` |
| Templates | `sandbox_template_get`, `sandbox_template_build`, `sandbox_template_builds`, `sandbox_template_delete` |
| Volumes | `volume_create/list/get/delete` |
| Databases | `database_create/list/get/connection/query/delete` |
| Apps | `app_create/list/get/update/deploy/deploys/logs/rollback/delete` |
| Browser | `sandbox_browser_screenshot` |
| Web | `web_search`, `web_fetch` |
| Anything else | `pandastack_api` (any `/v1/...` endpoint) |

**Web search.** PandaStack has no search API of its own. `web_search` and `web_fetch` therefore run real headless Chromium inside a helper sandbox (one per API key, created on first use and reused; DuckDuckGo first, Bing as fallback). `web_search` can also read the text of the top results. It takes a few seconds per call, counts toward `SANDBOX_MAX_ACTIVE`, and a search engine may occasionally show a bot check.

**Endpoint confidence.** Sandboxes, exec, files, templates list and preview URLs follow PandaStack's documented REST reference. Snapshots, forks, lifecycle, ports, volumes, databases, apps and template builds use PandaStack's REST naming but were not tested against a live account; their request bodies are passed through, and `pandastack_api` can reach the endpoint directly if a path differs.

Guard rails (env vars, see `.env.example`):

- `SANDBOX_MAX_ACTIVE` (default 3) caps live sandboxes made by this bridge, all keys together, forks included. They are tagged `metadata.source = "lily-mcp"`, so the cap never counts or touches anything else in your account.
- Every sandbox has a lifetime: `SANDBOX_DEFAULT_TTL_SECONDS` (900), never above `SANDBOX_MAX_TTL_SECONDS` (3600). Helper sandboxes use the maximum and are re-created when they expire.
- `sandbox_exec` is capped at 300 s per call and output is cut at 20,000 characters per stream. `sandbox_read_file` is cut at 2 MB.
- Preview URLs are public to anyone holding the link; the tools say so every time.
- `pandastack_api` refuses anything outside `/v1/` and cannot create or fork sandboxes (so limits cannot be bypassed). `database_query` and `database_delete`, `volume_delete`, `app_delete` are marked destructive.
- Self-hosted PandaStack: set `PANDASTACK_API_URL` and `PANDASTACK_PREVIEW_HOST`.

## Safety
- Secrets (GitHub/OpenAI-style keys, JWTs such as Turso tokens, private keys, `*_TOKEN=` values) are redacted before saving. Redaction is pattern-based — not a guarantee.
- Fields are capped at 8,000 characters.
- `ALLOWED_REPOS` is the read allowlist (`owner/repo`, `owner/*`, or `*`; avoid `*`, which lets the PAT reach every repo it can). `WRITE_REPOS` (same syntax, defaults to `ALLOWED_REPOS`) limits where Claude may commit, delete or create branches.
- Writes straight to a repo's default branch are refused; Claude must `create_branch`, commit there and open a pull request. Set `ALLOW_DEFAULT_BRANCH_WRITES=true` to opt out.
- OAuth requires PKCE (S256 only), and an authorization code only works for the client and redirect URI it was issued to.
- Optional nightly backup: set `BACKUP_REPO` (a **private** repo) → memories exported as JSONL via the GitHub API.

## Develop
`npm test` runs the memory tests (uses Node's built-in SQLite with FTS5 as a stand-in for libSQL).
`npm run build` compiles `src/` to `dist/`.
