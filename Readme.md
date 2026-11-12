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

Search/timeline return compact rows; `memory_get` returns full entries (keeps token use low).

## Setup
1. **Turso:** `turso db create lily-memory` → `turso db show lily-memory --url` → `turso db tokens create lily-memory`.
2. **Render:** new Web Service from this repo (or use `render.yaml`). Build: `npm install && npm run build`, start: `npm start`.
3. **Env vars:** copy `.env.example`. Required: `GITHUB_TOKEN`, `MCP_ADMIN_SECRET`, `MCP_BASE_URL`, `ALLOWED_REPOS`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
4. **claude.ai:** Settings → Connectors → Add custom connector → `https://<your-service>/mcp`, approve with the admin secret.
5. **Keep-alive:** the built-in self-ping runs every 10 min (`SELF_PING=false` to disable). An external pinger (UptimeRobot) on `/health` is a good second layer.

If Turso is missing/unreachable the GitHub tools still work and memory tools are simply not listed (see logs).

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

## Safety
- Secrets (GitHub/OpenAI-style keys, JWTs such as Turso tokens, private keys, `*_TOKEN=` values) are redacted before saving. Redaction is pattern-based — not a guarantee.
- Fields are capped at 8,000 characters.
- `ALLOWED_REPOS=*` lets the PAT reach every repo it can. Narrower: `Seizethewind/*,UmakraftCircle/*`.
- Optional nightly backup: set `BACKUP_REPO` (a **private** repo) → memories exported as JSONL via the GitHub API.

## Develop
`npm test` runs the memory tests (uses Node's built-in SQLite with FTS5 as a stand-in for libSQL).
`npm run build` compiles `src/` to `dist/`.
