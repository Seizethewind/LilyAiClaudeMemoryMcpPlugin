# lily-memory-mcp

Self-hosted MCP server for Claude: **GitHub read/write tools** (from `lily-github-mcp-bridge`) plus **persistent memory on Turso**.

Each memory entry = **your prompt + Claude's plan + the result**.

## The flow
1. You ask for something.
2. Claude calls `memory_save` (prompt + plan) → status `planned`, returns an id.
3. Claude does the work.
4. Claude calls `memory_update` (id + result + status `done|partial|failed`).
5. Next prompt: repeat. Claude starts with `memory_search` / `memory_timeline` to recall.

The server sends these instructions to Claude automatically on connect.

## Tools
GitHub (unchanged): `get_file_contents`, `create_or_update_file`, `delete_file`, `list_branches`, `create_branch`, `push_files`.
Memory: `memory_save`, `memory_update`, `memory_search`, `memory_timeline`, `memory_get`, `memory_forget` (soft delete by default; `hard: true` erases the row).

Search/timeline return compact rows; `memory_get` returns full entries (keeps token use low).

## Setup
1. **Turso:** `turso db create lily-memory` → `turso db show lily-memory --url` → `turso db tokens create lily-memory`.
2. **Render:** new Web Service from this repo (or use `render.yaml`). Build: `npm install && npm run build`, start: `npm start`.
3. **Env vars:** copy `.env.example`. Required: `GITHUB_TOKEN`, `MCP_ADMIN_SECRET`, `MCP_BASE_URL`, `ALLOWED_REPOS`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
4. **claude.ai:** Settings → Connectors → Add custom connector → `https://<your-service>/mcp`, approve with the admin secret.
5. **Keep-alive:** the built-in self-ping runs every 10 min (`SELF_PING=false` to disable). An external pinger (UptimeRobot) on `/health` is a good second layer.

If Turso is missing/unreachable the GitHub tools still work and memory tools are simply not listed (see logs).

## Safety
- Secrets (GitHub/OpenAI-style keys, JWTs such as Turso tokens, private keys, `*_TOKEN=` values) are redacted before saving. Redaction is pattern-based — not a guarantee.
- Fields are capped at 8,000 characters.
- `ALLOWED_REPOS=*` lets the PAT reach every repo it can. Narrower: `Seizethewind/*,UmakraftCircle/*`.
- Optional nightly backup: set `BACKUP_REPO` (a **private** repo) → memories exported as JSONL via the GitHub API.

## Develop
`npm test` runs the memory tests (uses Node's built-in SQLite with FTS5 as a stand-in for libSQL).
`npm run build` compiles `src/` to `dist/`.
