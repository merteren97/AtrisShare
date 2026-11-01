import type { DatabaseSync } from "node:sqlite";
import type { ClipAnalysis } from "../../domain/src/clips.js";
import { idSchema, type WorkspaceContext } from "../../domain/src/workspace.js";
import { WorkspaceError } from "./config.js";
import type { StudioStore } from "./studio-store.js";

type Row = { data: string; owner: string; lease_until: number; cancel_requested: number };
const conflict = () => new WorkspaceError(409, "clip_conflict");
export class ClipStore {
  constructor(private readonly db: DatabaseSync, private readonly studio: StudioStore) {}
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private row(id: string, context: WorkspaceContext): Row {
    idSchema.parse(id); const c = this.studio.scope(context);
    const row = this.db.prepare("SELECT * FROM clip_analyses WHERE id=? AND account_id=? AND project_id=?").get(id, c.accountId, c.projectId) as Row | undefined;
    if (!row) throw new WorkspaceError(404, "clip_not_found"); return row;
  }
  get(id: string, context: WorkspaceContext): ClipAnalysis {
    const row = this.row(id, context), run = JSON.parse(row.data) as ClipAnalysis;
    return run.state === "running" && row.lease_until <= Date.now() ? { ...run, state: "failed", error: "clip_interrupted" }
      : row.cancel_requested ? { ...run, cancelRequested: true } : run;
  }
  list(artifactId: string, context: WorkspaceContext): ClipAnalysis[] {
    this.studio.artifact(artifactId, context);
    return (this.db.prepare("SELECT id FROM clip_analyses WHERE artifact_id=? ORDER BY rowid DESC LIMIT 20").all(artifactId) as { id: string }[]).map(r => this.get(r.id, context));
  }
  create(run: ClipAnalysis, owner: string): void {
    this.transaction(() => {
      this.snapshot(run);
      this.available();
      this.db.prepare("INSERT INTO clip_analyses VALUES(?,?,?,?,?,?,?,0)").run(run.id, run.context.accountId, run.context.projectId, run.artifactId, JSON.stringify(run), owner, Date.now() + 300_000);
    });
  }
  private available() {
    if (this.db.prepare("SELECT id FROM clip_analyses WHERE json_extract(data,'$.state')='running' AND lease_until>? LIMIT 1").get(Date.now())) throw new WorkspaceError(409, "clip_busy");
  }
  private snapshot(run: ClipAnalysis) {
    if (this.studio.artifact(run.artifactId, run.context).sha256 !== run.sourceSha256) throw new WorkspaceError(409, "media_source_changed");
    if (this.studio.timeline(run.artifactId, run.context).revision !== run.baseRevision) throw new WorkspaceError(409, "revision_conflict");
    const account = this.db.prepare("SELECT destination_id FROM accounts WHERE id=?").get(run.context.accountId) as { destination_id: string } | undefined;
    if (account?.destination_id !== run.destinationId) throw new WorkspaceError(409, "clip_scope_mismatch");
  }
  assertActive(run: ClipAnalysis, owner: string) {
    const row = this.row(run.id, run.context), value = JSON.parse(row.data) as ClipAnalysis;
    if (row.owner !== owner || row.lease_until <= Date.now() || value.state !== "running") throw conflict();
    if (row.cancel_requested) throw new WorkspaceError(409, "clip_cancelled");
  }
  save(run: ClipAnalysis, owner: string) {
    this.transaction(() => {
      const row = this.row(run.id, run.context), previous = JSON.parse(row.data) as ClipAnalysis;
      if (row.owner !== owner || row.lease_until <= Date.now() || previous.state !== "running" || previous.revision !== run.revision) throw conflict();
      if (row.cancel_requested) Object.assign(run, { state: "cancelled", cancelRequested: true, error: null });
      this.db.prepare("UPDATE clip_analyses SET data=?,lease_until=? WHERE id=?").run(JSON.stringify(run), run.state === "running" ? Date.now() + 300_000 : 0, run.id);
    });
  }
  mutate(id: string, context: WorkspaceContext, revision: number, change: (run: ClipAnalysis) => void): ClipAnalysis {
    return this.transaction(() => {
      const run = this.get(id, context);
      if (run.state !== "ready" || run.revision !== revision) throw conflict();
      this.snapshot(run);
      change(run); run.revision++;
      this.db.prepare("UPDATE clip_analyses SET data=? WHERE id=?").run(JSON.stringify(run), id); return run;
    });
  }
  claim(id: string, context: WorkspaceContext, revision: number, owner: string): ClipAnalysis {
    return this.transaction(() => {
      this.available(); const run = this.get(id, context);
      if (run.state !== "ready" || run.revision !== revision) throw conflict();
      this.snapshot(run);
      run.state = "running"; run.stage = "render"; run.error = null; run.revision++;
      this.db.prepare("UPDATE clip_analyses SET data=?,owner=?,lease_until=?,cancel_requested=0 WHERE id=?").run(JSON.stringify(run), owner, Date.now() + 300_000, id); return run;
    });
  }
  /** Called only inside StudioStore.create's publication transaction; failure rolls both writes back. */
  attachDraftInTransaction(id: string, context: WorkspaceContext, revision: number, candidateId: string, artifactId: string, publicationId: string) {
    const run = this.get(id, context), candidate = run.candidates.find(c => c.id === candidateId);
    this.snapshot(run);
    if (run.state !== "ready" || run.revision !== revision || !candidate || candidate.artifactId !== artifactId || candidate.publicationId
      || this.studio.timeline(run.artifactId, context).revision !== run.baseRevision) throw conflict();
    candidate.publicationId = publicationId; run.revision++;
    this.db.prepare("UPDATE clip_analyses SET data=? WHERE id=?").run(JSON.stringify(run), id);
  }
  cancel(id: string, context: WorkspaceContext): ClipAnalysis {
    return this.transaction(() => {
      const run = this.get(id, context); if (run.state !== "running") throw conflict();
      this.db.prepare("UPDATE clip_analyses SET cancel_requested=1 WHERE id=?").run(id); return { ...run, cancelRequested: true };
    });
  }
}
