import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;
export function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version > SCHEMA_VERSION) throw new Error("Database is newer than this application");
    if (row.user_version === SCHEMA_VERSION) { db.exec("COMMIT"); return; }
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, platform TEXT NOT NULL,
        destination_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status='demo'), created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL,
        description TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(id, account_id)
      ) STRICT;
      CREATE TABLE memory (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), project_id TEXT,
        kind TEXT NOT NULL, text TEXT NOT NULL, review_state TEXT NOT NULL CHECK(review_state IN ('suggested','confirmed')),
        revision INTEGER NOT NULL DEFAULT 1, source_id TEXT NOT NULL, recorded_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id, account_id) REFERENCES projects(id, account_id)
      ) STRICT;
      CREATE INDEX memory_scope ON memory(account_id, project_id, updated_at);
      CREATE TABLE context (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), account_id TEXT NOT NULL REFERENCES accounts(id), project_id TEXT,
        FOREIGN KEY(project_id, account_id) REFERENCES projects(id, account_id)
      ) STRICT;
      CREATE TABLE audit (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), project_id TEXT,
        action TEXT NOT NULL, entity_id TEXT NOT NULL, actor TEXT NOT NULL CHECK(actor='local-user'), recorded_at TEXT NOT NULL,
        FOREIGN KEY(project_id, account_id) REFERENCES projects(id, account_id)
      ) STRICT;
      CREATE INDEX audit_scope ON audit(account_id, project_id, recorded_at);
      PRAGMA user_version=1;
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
