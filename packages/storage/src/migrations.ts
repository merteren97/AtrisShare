import type { DatabaseSync } from "node:sqlite";
import { SOCIAL_MIGRATION_SQL } from "./social-store.js";

export const SCHEMA_VERSION = 10;
export function migrate(db: DatabaseSync): void {
  // SQLite's documented table-rebuild procedure. Foreign keys are checked before
  // commit and re-enabled on every exit; no dependent rows are dropped.
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;");
  // journal_mode can return SQLITE_BUSY immediately during simultaneous first
  // opens, even with busy_timeout installed. Retry only this pre-transaction
  // PRAGMA; never replay a partially executed migration or user mutation.
  const deadline = Date.now() + 5000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try { db.exec("PRAGMA journal_mode=WAL;"); break; }
    catch (error) {
      const sqliteCode = error && typeof error === "object" && "errcode" in error ? Number(error.errcode) & 0xff : 0;
      if (![5, 6].includes(sqliteCode) || Date.now() >= deadline) { db.exec("PRAGMA foreign_keys=ON"); throw error; }
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version > SCHEMA_VERSION) throw new Error("Database is newer than this application");
    if (row.user_version === SCHEMA_VERSION) { db.exec("COMMIT"); return; }
    if (row.user_version < 1) db.exec(`
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
    if (row.user_version < 2) db.exec(`
      CREATE TABLE accounts_next (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, platform TEXT NOT NULL,
        destination_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('demo','connected','reauth-required','disconnected')), created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO accounts_next SELECT * FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_next RENAME TO accounts;
      CREATE TABLE youtube_connections (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id), provider_subject_id TEXT NOT NULL,
        destination_id TEXT NOT NULL UNIQUE, credential_ref TEXT UNIQUE, granted_scopes TEXT NOT NULL,
        verified_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0)
      ) STRICT;
      PRAGMA user_version=2;
    `);
    if (row.user_version < 3) db.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), project_id TEXT NOT NULL,
        data TEXT NOT NULL, UNIQUE(id,account_id,project_id),
        FOREIGN KEY(project_id,account_id) REFERENCES projects(id,account_id)
      ) STRICT;
      CREATE TABLE timelines (
        artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id), data TEXT NOT NULL
      ) STRICT;
      CREATE TABLE publications (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), project_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL, data TEXT NOT NULL, session_ref TEXT, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        dispatch_revoked INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_revoked IN (0,1)),
        FOREIGN KEY(artifact_id,account_id,project_id) REFERENCES artifacts(id,account_id,project_id)
      ) STRICT;
      CREATE INDEX publications_scope ON publications(account_id,project_id);
      CREATE TABLE renders (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL, source_id TEXT NOT NULL,
        data TEXT NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
        FOREIGN KEY(source_id,account_id,project_id) REFERENCES artifacts(id,account_id,project_id)
      ) STRICT;
      PRAGMA user_version=3;
    `);
    if (row.user_version < 4) db.exec(`
      CREATE TABLE ai_runs (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
        data TEXT NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
        FOREIGN KEY(artifact_id,account_id,project_id) REFERENCES artifacts(id,account_id,project_id)
      ) STRICT;
      CREATE INDEX ai_runs_scope ON ai_runs(account_id,project_id,artifact_id);
      PRAGMA user_version=4;
    `);
    if (row.user_version < 5) db.exec(`
      CREATE TABLE transcripts (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
        data TEXT NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
        FOREIGN KEY(artifact_id,account_id,project_id) REFERENCES artifacts(id,account_id,project_id)
      ) STRICT;
      CREATE INDEX transcripts_scope ON transcripts(account_id,project_id,artifact_id);
      PRAGMA user_version=5;
    `);
    if (row.user_version < 6) db.exec(`
      CREATE TABLE clip_analyses (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
        data TEXT NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
        FOREIGN KEY(artifact_id,account_id,project_id) REFERENCES artifacts(id,account_id,project_id)
      ) STRICT;
      CREATE INDEX clips_scope ON clip_analyses(account_id,project_id,artifact_id);
      PRAGMA user_version=6;
    `);
    if (row.user_version < 7) db.exec(`
      CREATE TABLE schedules(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),project_id TEXT NOT NULL,data TEXT NOT NULL,template TEXT NOT NULL,
        FOREIGN KEY(project_id,account_id) REFERENCES projects(id,account_id)) STRICT;
      CREATE INDEX schedules_scope ON schedules(account_id,project_id);
      CREATE TABLE schedule_occurrences(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES schedules(id),account_id TEXT NOT NULL,
        project_id TEXT NOT NULL,due_at TEXT NOT NULL,generation INTEGER NOT NULL,publication_id TEXT UNIQUE,data TEXT NOT NULL,
        UNIQUE(schedule_id,due_at,generation),FOREIGN KEY(project_id,account_id) REFERENCES projects(id,account_id)) STRICT;
      CREATE INDEX occurrences_scope ON schedule_occurrences(account_id,project_id,due_at);
      PRAGMA user_version=7;
    `);
    if (row.user_version < 8) { db.exec(SOCIAL_MIGRATION_SQL); db.exec("PRAGMA user_version=8"); }
    if (row.user_version < 9) db.exec(`CREATE TABLE social_refresh_leases(provider TEXT NOT NULL,app_key TEXT NOT NULL,subject_id TEXT NOT NULL,
      owner TEXT NOT NULL,lease_until INTEGER NOT NULL,PRIMARY KEY(provider,app_key,subject_id)) STRICT;
      CREATE TABLE social_cooldowns(account_id TEXT PRIMARY KEY REFERENCES accounts(id),until_ms INTEGER NOT NULL) STRICT;
      PRAGMA user_version=9;`);
    if (row.user_version < 10) db.exec(`
      CREATE TABLE accounts_next (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, platform TEXT NOT NULL,
        destination_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('demo','local','connected','reauth-required','disconnected')), created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO accounts_next SELECT * FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_next RENAME TO accounts;
      PRAGMA user_version=10;
    `);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec("PRAGMA foreign_keys=ON"); }
}
