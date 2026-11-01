import type { DatabaseSync } from "node:sqlite";
import { transcriptContextSchema, transcriptSchema, type Transcript } from "../../domain/src/transcription.js";
import type { StudioArtifact } from "../../domain/src/studio.js";
import { idSchema, type WorkspaceContext } from "../../domain/src/workspace.js";
import { redactSensitiveText, WorkspaceError } from "./config.js";

type Row = { data: string; owner: string | null; lease_until: number; cancel_requested: number };
const LEASE = 300_000;
const conflict = () => new WorkspaceError(409, "transcription_conflict");

function sanitized(record: Transcript): Transcript {
  // Bound raw input too, but enforce the public limits AFTER redaction (which can expand text).
  if (!Array.isArray(record.segments) || record.segments.length > 10_000) throw new WorkspaceError(400, "transcription_invalid_output");
  let rawLength = 0;
  const segments = record.segments.map(segment => {
    if (typeof segment.text !== "string" || (rawLength += segment.text.length) > 2_000_000) {
      throw new WorkspaceError(400, "transcription_invalid_output");
    }
    const text = redactSensitiveText(segment.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "")
      .replace(/\s+/gu, " ").trim());
    return { ...segment, text };
  });
  const parsed = transcriptSchema.safeParse({ ...record, segments });
  if (!parsed.success) throw new WorkspaceError(400, "transcription_invalid_output");
  return parsed.data;
}

export class TranscriptStore {
  constructor(private readonly db: DatabaseSync, private readonly resolve: (scope: WorkspaceContext) => WorkspaceContext,
    private readonly artifact: (id: string, scope: WorkspaceContext) => StudioArtifact) {}

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private scope(value: WorkspaceContext) {
    const scope = transcriptContextSchema.parse(value); this.resolve(scope); return scope;
  }
  private source(id: string, scope: WorkspaceContext): StudioArtifact {
    idSchema.parse(id);
    const artifact = this.artifact(id, scope);
    if (artifact.id !== id || artifact.accountId !== scope.accountId || artifact.projectId !== scope.projectId
      || artifact.kind === "proxy" || artifact.kind === "preview") throw new WorkspaceError(409, "transcription_scope_mismatch");
    return artifact;
  }
  private row(id: string, scope: WorkspaceContext): Row {
    idSchema.parse(id); const c = this.scope(scope);
    const row = this.db.prepare("SELECT data,owner,lease_until,cancel_requested FROM transcripts WHERE id=? AND account_id=? AND project_id=?")
      .get(id, c.accountId, c.projectId) as Row | undefined;
    if (!row) throw new WorkspaceError(404, "transcript_not_found");
    return row;
  }
  private view(row: Row): Transcript {
    const value = transcriptSchema.parse(JSON.parse(row.data));
    return value.state === "running" && row.lease_until <= Date.now()
      ? { ...value, state: "failed", error: "transcript_interrupted" }
      : value.state === "running" && row.cancel_requested ? { ...value, cancelRequested: true } : value;
  }
  create(record: Transcript, owner: string): Transcript {
    const value = sanitized(record);
    if (value.state !== "running" || value.progress !== 0 || !owner || owner.length > 200) throw conflict();
    return this.transaction(() => {
      const scope = this.scope({ accountId: value.accountId, projectId: value.projectId });
      if (this.source(value.artifactId, scope).sha256 !== value.sourceSha256) throw new WorkspaceError(409, "media_source_changed");
      // The DB-wide claim also fences independent runtimes sharing this host workspace.
      // BEGIN IMMEDIATE makes this check+insert atomic without owning a migration/index.
      if (this.db.prepare("SELECT id FROM transcripts WHERE json_extract(data,'$.state')='running' AND lease_until>? LIMIT 1").get(Date.now())) {
        throw new WorkspaceError(409, "transcription_busy");
      }
      this.db.prepare("INSERT INTO transcripts(id,account_id,project_id,artifact_id,data,owner,lease_until,cancel_requested) VALUES(?,?,?,?,?,?,?,0)")
        .run(value.id, value.accountId, value.projectId, value.artifactId, JSON.stringify(value), owner, Date.now() + LEASE);
      return value;
    });
  }
  get(id: string, scope: WorkspaceContext): Transcript { return this.view(this.row(id, scope)); }
  latest(artifactId: string, scope: WorkspaceContext): Transcript | null {
    const c = this.scope(scope); this.source(artifactId, c);
    const row = this.db.prepare("SELECT data,owner,lease_until,cancel_requested FROM transcripts WHERE artifact_id=? AND account_id=? AND project_id=? ORDER BY rowid DESC LIMIT 1")
      .get(artifactId, c.accountId, c.projectId) as Row | undefined;
    return row ? this.view(row) : null;
  }
  private owned(id: string, owner: string): Row {
    idSchema.parse(id);
    const row = this.db.prepare("SELECT data,owner,lease_until,cancel_requested FROM transcripts WHERE id=? AND owner=? AND lease_until>? AND json_extract(data,'$.state')='running'")
      .get(id, owner, Date.now()) as Row | undefined;
    if (!row) throw conflict();
    return row;
  }
  save(record: Transcript, owner: string): void {
    this.transaction(() => {
      const row = this.owned(record.id, owner), previous = transcriptSchema.parse(JSON.parse(row.data));
      for (const key of ["accountId", "projectId", "artifactId", "sourceSha256", "createdAt"] as const) {
        if (record[key] !== previous[key]) throw conflict();
      }
      this.scope({ accountId: previous.accountId, projectId: previous.projectId });
      if (row.cancel_requested && record.state === "running") throw new WorkspaceError(409, "transcription_cancelled");
      const value = sanitized(row.cancel_requested
        ? { ...record, state: "cancelled", language: null, segments: [], duration: null, error: null } : record);
      if (value.progress < previous.progress || Date.parse(value.updatedAt) < Date.parse(previous.updatedAt)) throw conflict();
      const result = this.db.prepare("UPDATE transcripts SET data=?,lease_until=? WHERE id=? AND owner=? AND lease_until>? AND json_extract(data,'$.state')='running'")
        .run(JSON.stringify(value), value.state === "running" ? Date.now() + LEASE : 0, value.id, owner, Date.now());
      if (!result.changes) throw conflict();
      Object.assign(record, value);
    });
  }
  requestCancel(id: string, scope: WorkspaceContext): Transcript {
    return this.transaction(() => {
      const row = this.row(id, scope), value = this.view(row);
      if (value.state !== "running") throw conflict();
      if (!this.db.prepare("UPDATE transcripts SET cancel_requested=1 WHERE id=? AND account_id=? AND project_id=? AND lease_until>? AND json_extract(data,'$.state')='running'")
         .run(id, value.accountId, value.projectId, Date.now()).changes) throw conflict();
      return { ...value, cancelRequested: true };
    });
  }
  assertActive(id: string, owner: string): void {
    if (this.owned(id, owner).cancel_requested) throw new WorkspaceError(409, "transcription_cancelled");
  }
}
