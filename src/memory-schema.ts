/** SQL for the memory database: base schema, full-text search, v2 (repositories, trash, audit) and v3 (Blueprint). */

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS memories (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     project    TEXT NOT NULL DEFAULT 'general',
     title      TEXT NOT NULL,
     prompt     TEXT NOT NULL,
     plan       TEXT,
     result     TEXT,
     status     TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','done','partial','failed')),
     tags       TEXT,
     pinned     INTEGER NOT NULL DEFAULT 0,
     supersedes INTEGER REFERENCES memories(id),
     deleted_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes)`,
  `CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `INSERT OR IGNORE INTO schema_versions(version) VALUES (1)`,
];

export const FTS_SQL = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
     title, prompt, plan, result, tags, content='memories', content_rowid='id'
   )`,
  `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
     INSERT INTO memories_fts(rowid,title,prompt,plan,result,tags)
     VALUES (new.id,new.title,new.prompt,new.plan,new.result,new.tags);
   END`,
  `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
     INSERT INTO memories_fts(memories_fts,rowid,title,prompt,plan,result,tags)
     VALUES ('delete',old.id,old.title,old.prompt,old.plan,old.result,old.tags);
   END`,
  `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
     INSERT INTO memories_fts(memories_fts,rowid,title,prompt,plan,result,tags)
     VALUES ('delete',old.id,old.title,old.prompt,old.plan,old.result,old.tags);
     INSERT INTO memories_fts(rowid,title,prompt,plan,result,tags)
     VALUES (new.id,new.title,new.prompt,new.plan,new.result,new.tags);
   END`,
];


// Schema v2: repository scope, trash, confirmations, audit. The legacy
// "project" column keeps its name but now always holds a canonical repository
// key ("owner/name", lowercase) or "general".
export const V2_SQL = [
  `ALTER TABLE memories ADD COLUMN delete_batch TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_memories_batch ON memories(delete_batch)`,
  `CREATE TABLE IF NOT EXISTS repos (
     repo           TEXT PRIMARY KEY,
     display        TEXT NOT NULL,
     locked         INTEGER NOT NULL DEFAULT 0,
     created_at     TEXT NOT NULL DEFAULT (datetime('now')),
     last_active_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS confirmations (
     token      TEXT PRIMARY KEY,
     action     TEXT NOT NULL,
     repo       TEXT NOT NULL,
     count      INTEGER NOT NULL,
     expires_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS memory_audit (
     id     INTEGER PRIMARY KEY AUTOINCREMENT,
     at     TEXT NOT NULL DEFAULT (datetime('now')),
     actor  TEXT NOT NULL,
     action TEXT NOT NULL,
     repo   TEXT,
     detail TEXT
   )`,
];

// Schema v3: one living Blueprint per repository (see the Blueprint section below).
export const V3_SQL = [
  `CREATE TABLE IF NOT EXISTS blueprints (
     repo       TEXT PRIMARY KEY,
     version    INTEGER NOT NULL DEFAULT 0,
     based_on   TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS blueprint_sections (
     repo       TEXT NOT NULL,
     section    TEXT NOT NULL,
     content    TEXT NOT NULL,
     version    INTEGER NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (repo, section)
   )`,
  `CREATE TABLE IF NOT EXISTS blueprint_revisions (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     repo     TEXT NOT NULL,
     section  TEXT NOT NULL,
     version  INTEGER NOT NULL,
     content  TEXT NOT NULL,
     based_on TEXT,
     note     TEXT,
     at       TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_blueprint_rev ON blueprint_revisions(repo, section, id)`,
];
