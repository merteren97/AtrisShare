import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { applySequenceOperations, defaultSequenceProfile, type SequenceSnapshot, type SequenceState, type SequenceOperation, type SequenceJob, type SequenceProposal } from "../../domain/src/sequence.js";
import type { WorkspaceContext } from "../../domain/src/workspace.js";
import type { StudioStore } from "./studio-store.js";
import type { StudioArtifact } from "../../domain/src/studio.js";
import { WorkspaceError } from "./config.js";
export const SEQUENCE_MIGRATION_SQL = `CREATE TABLE sequences (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(account_id,project_id), FOREIGN KEY(project_id,account_id) REFERENCES projects(id,account_id)) STRICT;
CREATE TABLE sequence_work (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(project_id,account_id) REFERENCES projects(id,account_id)) STRICT;
CREATE INDEX sequence_work_scope ON sequence_work(account_id,project_id,kind);`;
interface Stored { snapshot: SequenceSnapshot; history: SequenceState[] }
export class SequenceStore {
  constructor(private readonly db: DatabaseSync, private readonly studio: StudioStore) {}
  private transaction<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const value = fn(); this.db.exec("COMMIT"); return value; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  private read(context: WorkspaceContext): Stored {
    const c = this.studio.scope(context), row = this.db.prepare("SELECT data FROM sequences WHERE account_id=? AND project_id=?").get(c.accountId, c.projectId) as {data:string}|undefined;
    if (row) return JSON.parse(row.data) as Stored;
    const state: SequenceState = { profile: { ...defaultSequenceProfile }, clips: [] };
    const value: Stored = { snapshot: { ...state, schemaVersion: 1, id: randomUUID(), context: c, revision: 0, cursor: 0, historyLength: 1 }, history: [structuredClone(state)] };
    this.db.prepare("INSERT INTO sequences VALUES(?,?,?,?)").run(value.snapshot.id, c.accountId, c.projectId, JSON.stringify(value)); return value;
  }
  get(context: WorkspaceContext) { return this.transaction(() => this.read(context).snapshot); }
  private save(value: Stored) { this.db.prepare("UPDATE sequences SET data=? WHERE id=?").run(JSON.stringify(value), value.snapshot.id); this.db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,'local-user',?)").run(randomUUID(), value.snapshot.context.accountId, value.snapshot.context.projectId, "sequence.saved", value.snapshot.id, new Date().toISOString()); return value.snapshot; }
  private write(context: WorkspaceContext, revision: number, operations: SequenceOperation[]) {
    const value = this.read(context), current = value.snapshot; if (current.revision !== revision) throw new WorkspaceError(409, "revision_conflict");
    let state: SequenceState;
    try { state = applySequenceOperations({ profile: current.profile, clips: current.clips }, operations, id => this.studio.artifact(id, context)); }
    catch (e) { if (e instanceof WorkspaceError) throw e; throw new WorkspaceError(400, e instanceof Error && /^sequence_|^media_source_changed$/.test(e.message) ? e.message : "sequence_invalid_operation"); }
    value.history = [...value.history.slice(0, current.cursor + 1), state].slice(-201);
    value.snapshot = { ...current, ...state, revision: current.revision + 1, cursor: value.history.length - 1, historyLength: value.history.length }; return this.save(value);
  }
  apply(context: WorkspaceContext, revision: number, operations: SequenceOperation[]) { return this.transaction(() => this.write(context, revision, operations)); }
  history(context: WorkspaceContext, revision: number, direction: "undo" | "redo") { return this.transaction(() => { const value = this.read(context), s = value.snapshot; if (s.revision !== revision) throw new WorkspaceError(409, "revision_conflict"); const cursor = s.cursor + (direction === "undo" ? -1 : 1), state = value.history[cursor]; if (!state) throw new WorkspaceError(409, "sequence_history_bounds"); value.snapshot = { ...s, ...state, revision: s.revision + 1, cursor }; return this.save(value); }); }
  createWork<T extends SequenceJob | SequenceProposal>(value: T, kind: "render" | "proposal", owner: string): T {
    return this.transaction(()=>{
      this.studio.scope(value.context);
      if(value.state==="running"&&this.db.prepare("SELECT id FROM sequence_work WHERE account_id=? AND project_id=? AND kind=? AND json_extract(data,'$.state')='running' AND cancel_requested=0 AND lease_until>?").get(value.context.accountId,value.context.projectId,kind,Date.now()))throw new WorkspaceError(409,kind==="render"?"media_busy":"ai_busy");
      this.db.prepare("INSERT INTO sequence_work(id,account_id,project_id,kind,data,owner,lease_until) VALUES(?,?,?,?,?,?,?)").run(value.id,value.context.accountId,value.context.projectId,kind,JSON.stringify(value),owner,Date.now()+300000);return value;
    });
  }
  work<T extends SequenceJob | SequenceProposal>(id: string, context: WorkspaceContext, kind: "render" | "proposal"): T {
    this.studio.scope(context); const row = this.db.prepare("SELECT data,lease_until,cancel_requested FROM sequence_work WHERE id=? AND account_id=? AND project_id=? AND kind=?").get(id, context.accountId, context.projectId, kind) as {data:string;lease_until:number;cancel_requested:number}|undefined;
    if (!row) throw new WorkspaceError(404, "sequence_work_not_found"); const value = JSON.parse(row.data) as T;
    if (value.state === "running" && (row.cancel_requested || row.lease_until < Date.now())) { value.state = row.cancel_requested ? "cancelled" : "failed"; value.error = row.cancel_requested ? null : "sequence_interrupted"; } return value;
  }
  works<T extends SequenceJob | SequenceProposal>(context: WorkspaceContext, kind: "render" | "proposal"): T[] { this.studio.scope(context); return (this.db.prepare("SELECT id FROM sequence_work WHERE account_id=? AND project_id=? AND kind=? ORDER BY rowid DESC LIMIT 30").all(context.accountId, context.projectId, kind) as {id:string}[]).map(r => this.work<T>(r.id, context, kind)); }
  checkpoint(value: SequenceJob | SequenceProposal, owner: string) { this.studio.scope(value.context); if (!this.db.prepare("UPDATE sequence_work SET data=?,lease_until=? WHERE id=? AND owner=? AND cancel_requested=0 AND lease_until>?").run(JSON.stringify(value), Date.now() + 300000, value.id, owner, Date.now()).changes) throw new WorkspaceError(409, "sequence_work_cancelled"); }
  completeRender(job: SequenceJob, owner: string, artifact: StudioArtifact) {
    this.transaction(()=>{this.studio.scope(job.context);this.checkpoint(job,owner);this.db.prepare("INSERT INTO artifacts VALUES(?,?,?,?)").run(artifact.id,artifact.accountId,artifact.projectId,JSON.stringify(artifact));});
  }
  attachPreview(id:string, context:WorkspaceContext, jobId:string) {
    return this.transaction(()=>{const p=this.work<SequenceProposal>(id,context,"proposal"),job=this.work<SequenceJob>(jobId,context,"render");if(p.state!=="ready"||job.proposalId!==id)throw new WorkspaceError(409,"sequence_work_conflict");p.previewJobId=jobId;this.db.prepare("UPDATE sequence_work SET data=? WHERE id=? AND cancel_requested=0").run(JSON.stringify(p),id);return p;});
  }
  cancel(id: string, context: WorkspaceContext, kind: "render" | "proposal") { const work = this.work<SequenceJob | SequenceProposal>(id, context, kind); if (!["running", "ready"].includes(work.state)) throw new WorkspaceError(409, "sequence_work_conflict"); work.state = "cancelled"; work.error = null; this.db.prepare("UPDATE sequence_work SET data=?,cancel_requested=1,owner=NULL,lease_until=0 WHERE id=?").run(JSON.stringify(work), id); return work; }
  review(id: string, context: WorkspaceContext, action: "accept" | "reject") { return this.transaction(() => { const p = this.work<SequenceProposal>(id, context, "proposal"); if (p.state !== "ready") throw new WorkspaceError(409, "sequence_work_conflict"); if (action === "accept") this.write(context, p.baseSequenceRevision, p.operations); p.state = action === "accept" ? "accepted" : "rejected"; this.db.prepare("UPDATE sequence_work SET data=?,owner=NULL,lease_until=0 WHERE id=?").run(JSON.stringify(p), id); return p; }); }
}
