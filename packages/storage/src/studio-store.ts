import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { studioContextSchema, publicationInputSchema, type PublicationInput, type PublicationPayload,
  type StudioArtifact, type StudioPublication, type StudioRender, type StudioTimeline } from "../../domain/src/studio.js";
import { editSchema, type MediaEdit } from "../../domain/src/media.js";
import type { WorkspaceContext } from "../../domain/src/workspace.js";
import { idSchema } from "../../domain/src/workspace.js";
import { WorkspaceError } from "./config.js";
import type { AiRun } from "../../domain/src/ai.js";

type Row = { data: string; session_ref?: string | null; owner?: string | null; lease_until?: number };
/** Stable field order, fixed schema version, no client-provided canonical bytes. */
export function publicationDigest(payload: PublicationPayload): string {
  return createHash("sha256").update(JSON.stringify({ version: payload.version, accountId: payload.accountId,
    projectId: payload.projectId, destinationId: payload.destinationId, artifactId: payload.artifactId,
    sha256: payload.sha256, bytes: payload.bytes, mimeType: payload.mimeType, title: payload.title,
    description: payload.description, visibility: payload.visibility, madeForKids: payload.madeForKids,
    notifySubscribers: payload.notifySubscribers })).digest("hex");
}
export class StudioStore {
  constructor(private readonly db: DatabaseSync, private readonly resolve: (scope: WorkspaceContext) => WorkspaceContext,
    private readonly audit: (scope: WorkspaceContext, action: string, id: string) => void) {}
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  scope(value: WorkspaceContext) { const scope = studioContextSchema.parse(value); this.resolve(scope); return scope; }
  artifacts(scope: WorkspaceContext): StudioArtifact[] {
    const c = this.scope(scope);
    return (this.db.prepare("SELECT data FROM artifacts WHERE account_id=? AND project_id=? ORDER BY rowid DESC").all(c.accountId, c.projectId) as Row[]).map(r => JSON.parse(r.data) as StudioArtifact);
  }
  artifact(id: string, scope: WorkspaceContext): StudioArtifact {
    idSchema.parse(id); const c = this.scope(scope);
    const row = this.db.prepare("SELECT data FROM artifacts WHERE id=? AND account_id=? AND project_id=?").get(id, c.accountId, c.projectId) as Row | undefined;
    if (!row) throw new WorkspaceError(404, "artifact_not_found");
    return JSON.parse(row.data) as StudioArtifact;
  }
  addArtifact(artifact: StudioArtifact): StudioArtifact {
    return this.transaction(() => {
      const scope = this.scope({ accountId: artifact.accountId, projectId: artifact.projectId }); idSchema.parse(artifact.id);
      if (artifact.sourceId) this.artifact(artifact.sourceId, scope);
      this.db.prepare("INSERT INTO artifacts VALUES(?,?,?,?)").run(artifact.id, artifact.accountId, artifact.projectId, JSON.stringify(artifact));
      this.audit(scope, "media.imported", artifact.id); return artifact;
    });
  }
  link(id: string, scope: WorkspaceContext, videoId: string): StudioArtifact {
    return this.transaction(() => {
      const artifact = { ...this.artifact(id, scope), channelVideoId: videoId };
      this.db.prepare("UPDATE artifacts SET data=? WHERE id=?").run(JSON.stringify(artifact), id);
      this.audit(scope, "media.linked", id); return artifact;
    });
  }
  attachProxy(id: string, scope: WorkspaceContext, proxyId: string, sha256: string): StudioArtifact {
    return this.transaction(() => {
      const artifact = this.artifact(id, scope), proxy = this.artifact(proxyId, scope);
      if (artifact.sha256 !== sha256 || proxy.sourceId !== id || proxy.kind !== "proxy" || proxy.sourceSha256 !== sha256) throw new WorkspaceError(409, "media_source_changed");
      const next = { ...artifact, proxyId };
      this.db.prepare("UPDATE artifacts SET data=? WHERE id=?").run(JSON.stringify(next), id);
      this.audit(scope, "media.proxy-created", id); return next;
    });
  }
  timeline(id: string, scope: WorkspaceContext): StudioTimeline {
    this.artifact(id, scope);
    const row = this.db.prepare("SELECT data FROM timelines WHERE artifact_id=?").get(id) as Row | undefined;
    return row ? JSON.parse(row.data) as StudioTimeline : { revision: 0, cursor: -1, edits: [] };
  }
  edit(id: string, scope: WorkspaceContext, revision: number, edit?: MediaEdit, direction?: "undo" | "redo"): StudioTimeline {
    return this.transaction(() => this.writeEdit(id, scope, revision, edit, direction));
  }
  private writeEdit(id: string, scope: WorkspaceContext, revision: number, edit?: MediaEdit, direction?: "undo" | "redo"): StudioTimeline {
      const timeline = this.timeline(id, scope), artifact = this.artifact(id, scope);
      if (timeline.revision !== revision) throw new WorkspaceError(409, "revision_conflict");
      if (direction) {
        const cursor = timeline.cursor + (direction === "undo" ? -1 : 1);
        if (cursor < -1 || cursor >= timeline.edits.length) throw new WorkspaceError(409, "timeline_bounds");
        timeline.cursor = cursor;
      } else {
        const value = editSchema.parse(edit);
        if (!artifact.probe || value.outSeconds > artifact.probe.duration + .001) throw new WorkspaceError(400, "timeline_bounds");
        if (timeline.edits.length >= 200) throw new WorkspaceError(409, "timeline_history_full");
        timeline.edits = [...timeline.edits.slice(0, timeline.cursor + 1), value]; timeline.cursor++;
      }
      timeline.revision++;
      this.db.prepare("INSERT INTO timelines VALUES(?,?) ON CONFLICT(artifact_id) DO UPDATE SET data=excluded.data").run(id, JSON.stringify(timeline));
      this.audit(scope, "timeline.saved", id); return timeline;
  }
  createAiRun(run: AiRun, owner: string): AiRun {
    return this.transaction(() => {
      const artifact = this.artifact(run.artifactId, run.context);
      if (artifact.sha256 !== run.sourceSha256) throw new WorkspaceError(409, "media_source_changed");
      if (run.state === "running" && this.db.prepare("SELECT id FROM ai_runs WHERE account_id=? AND project_id=? AND artifact_id=? AND json_extract(data,'$.state')='running' AND lease_until>?").get(run.context.accountId, run.context.projectId, run.artifactId, Date.now())) throw new WorkspaceError(409, "ai_busy");
      this.db.prepare("INSERT INTO ai_runs(id,account_id,project_id,artifact_id,data,owner,lease_until) VALUES(?,?,?,?,?,?,?)").run(run.id, run.context.accountId, run.context.projectId, run.artifactId,
        JSON.stringify(run), owner, run.state === "running" ? Date.now() + 300_000 : 0);
      this.audit(run.context, "ai.requested", run.id); return run;
    });
  }
  aiRun(id: string, scope: WorkspaceContext): AiRun {
    idSchema.parse(id); const c = this.scope(scope);
    const row = this.db.prepare("SELECT data,lease_until,cancel_requested FROM ai_runs WHERE id=? AND account_id=? AND project_id=?").get(id, c.accountId, c.projectId) as (Row & {cancel_requested:number}) | undefined;
    if (!row) throw new WorkspaceError(404, "ai_run_not_found");
    const run = JSON.parse(row.data) as AiRun;
    return run.state === "running" && (row.lease_until ?? 0) <= Date.now() ? { ...run, state: "failed", error: "ai_interrupted" }
      : run.state === "running" && row.cancel_requested ? { ...run, cancelRequested: true } : run;
  }
  aiRuns(artifactId: string, scope: WorkspaceContext): AiRun[] {
    this.artifact(artifactId, scope);
    return (this.db.prepare("SELECT id FROM ai_runs WHERE artifact_id=? ORDER BY rowid DESC LIMIT 30").all(artifactId) as {id:string}[]).map(row => this.aiRun(row.id, scope));
  }
  saveAiRun(run: AiRun, owner: string): void {
    this.transaction(() => {
      this.assertAiOwner(run.id, owner);
      const row = this.db.prepare("SELECT cancel_requested FROM ai_runs WHERE id=?").get(run.id) as {cancel_requested:number};
      if (row.cancel_requested) {
        if (run.state === "running") throw new WorkspaceError(409, "ai_cancelled");
        Object.assign(run, { state: "cancelled", summary: null, edit: null, error: null, cancelRequested: true });
      }
      this.db.prepare("UPDATE ai_runs SET data=?,lease_until=? WHERE id=? AND owner=?")
        .run(JSON.stringify(run), run.state === "running" ? Date.now() + 300_000 : 0, run.id, owner);
    });
  }
  private assertAiOwner(id: string, owner: string): void {
    if (!this.db.prepare("SELECT id FROM ai_runs WHERE id=? AND owner=? AND json_extract(data,'$.state')='running' AND lease_until>?").get(id, owner, Date.now())) throw new WorkspaceError(409, "ai_run_conflict");
  }
  assertAiActive(id: string, owner: string): void {
    this.assertAiOwner(id, owner);
    if ((this.db.prepare("SELECT cancel_requested FROM ai_runs WHERE id=?").get(id) as {cancel_requested:number}).cancel_requested) throw new WorkspaceError(409, "ai_cancelled");
  }
  requestAiCancel(id: string, scope: WorkspaceContext): AiRun {
    return this.transaction(() => {
      const run = this.aiRun(id, scope);
      if (run.state !== "running") throw new WorkspaceError(409, "ai_run_conflict");
      this.db.prepare("UPDATE ai_runs SET cancel_requested=1 WHERE id=?").run(id);
      this.audit(scope, "ai.cancel-requested", id); return { ...run, cancelRequested: true };
    });
  }
  reviewAiRun(id: string, scope: WorkspaceContext, action: "accept" | "reject"): AiRun {
    return this.transaction(() => {
      const run = this.aiRun(id, scope);
      if (run.state !== "ready" || !run.edit) throw new WorkspaceError(409, "ai_run_conflict");
      if (action === "accept") {
        const artifact = this.artifact(run.artifactId, scope);
        if (artifact.sha256 !== run.sourceSha256) throw new WorkspaceError(409, "media_source_changed");
        this.writeEdit(run.artifactId, scope, run.baseRevision, run.edit);
      }
      run.state = action === "accept" ? "accepted" : "rejected";
      this.db.prepare("UPDATE ai_runs SET data=? WHERE id=?").run(JSON.stringify(run), id);
      this.audit(scope, `ai.${run.state}`, id); return run;
    });
  }
  attachAiPreview(id: string, scope: WorkspaceContext, renderId: string): AiRun {
    return this.transaction(() => {
      const run = this.aiRun(id, scope);
      if (run.state !== "ready") throw new WorkspaceError(409, "ai_run_conflict");
      const render = this.render(renderId, scope);
      if (render.sourceId !== run.artifactId || render.kind !== "preview") throw new WorkspaceError(409, "ai_run_conflict");
      run.previewRenderId = renderId;
      this.db.prepare("UPDATE ai_runs SET data=? WHERE id=?").run(JSON.stringify(run), id); return run;
    });
  }
  publications(scope: WorkspaceContext): StudioPublication[] {
    const c = this.scope(scope);
    return (this.db.prepare("SELECT data,owner,lease_until FROM publications WHERE account_id=? AND project_id=? ORDER BY rowid DESC").all(c.accountId, c.projectId) as Row[])
      .map(row => this.view(row));
  }
  private view(row: Row): StudioPublication {
    const value = JSON.parse(row.data) as StudioPublication;
    if (value.state === "uploading" && (row.lease_until ?? 0) <= Date.now()) return { ...value, state: "uncertain", error: "publication_interrupted" };
    return value;
  }
  publication(id: string, scope: WorkspaceContext): StudioPublication {
    idSchema.parse(id); const c = this.scope(scope);
    const row = this.db.prepare("SELECT data,owner,lease_until FROM publications WHERE id=? AND account_id=? AND project_id=?").get(id, c.accountId, c.projectId) as Row | undefined;
    if (!row) throw new WorkspaceError(404, "publication_not_found"); return this.view(row);
  }
  create(value: PublicationInput, destinationId: string): StudioPublication {
    const input = publicationInputSchema.parse(value);
    return this.transaction(() => {
      const a = this.artifact(input.artifactId, input.context);
      const payload: PublicationPayload = { version: 1, ...input.context, destinationId, artifactId: a.id, sha256: a.sha256,
        bytes: a.bytes, mimeType: a.mimeType, title: input.title, description: input.description, visibility: input.visibility,
        madeForKids: input.madeForKids, notifySubscribers: input.notifySubscribers };
      const p: StudioPublication = { id: randomUUID(), context: input.context, revision: 1, payload, digest: publicationDigest(payload),
        state: "review", approvalExpiresAt: null, progress: 0, videoId: null, error: null, createdAt: new Date().toISOString() };
      this.db.prepare("INSERT INTO publications(id,account_id,project_id,artifact_id,data) VALUES(?,?,?,?,?)").run(p.id, input.context.accountId, input.context.projectId, a.id, JSON.stringify(p));
      this.audit(p.context, "publication.requested", p.id); return p;
    });
  }
  claim(id: string, scope: WorkspaceContext, owner: string, digest: string | null): StudioPublication {
    return this.transaction(() => {
      const p = this.publication(id, scope);
      if (this.db.prepare("SELECT id FROM publications WHERE account_id=? AND id<>? AND owner IS NOT NULL AND lease_until>?").get(scope.accountId, id, Date.now())) throw new WorkspaceError(409, "publication_busy");
      if (digest !== null) {
        if (p.state !== "review" || p.digest !== digest || publicationDigest(p.payload) !== digest) throw new WorkspaceError(409, "approval_stale");
        p.approvalExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString(); p.state = "uploading";
      } else if (!["uncertain", "processing"].includes(p.state)) throw new WorkspaceError(409, "publication_busy");
      const result = this.db.prepare("UPDATE publications SET owner=?,lease_until=?,data=? WHERE id=? AND (owner IS NULL OR lease_until<=?)")
        .run(owner, Date.now() + 300_000, JSON.stringify(p), id, Date.now());
      if (!result.changes) throw new WorkspaceError(409, "publication_busy");
      this.audit(scope, digest === null ? "publication.reconciling" : "publication.approved", id); return p;
    });
  }
  checkpoint(p: StudioPublication, owner: string, release = false): void {
    const result = this.db.prepare("UPDATE publications SET data=?,owner=?,lease_until=? WHERE id=? AND owner=? AND lease_until>?")
      .run(JSON.stringify(p), release ? null : owner, release ? 0 : Date.now() + 300_000, p.id, owner, Date.now());
    if (!result.changes) throw new WorkspaceError(409, "publication_busy");
  }
  session(id: string, owner: string): string | null {
    const row = this.db.prepare("SELECT session_ref FROM publications WHERE id=? AND owner=? AND lease_until>?").get(id, owner, Date.now()) as Row | undefined;
    if (!row) throw new WorkspaceError(409, "publication_busy"); return row.session_ref ?? null;
  }
  setSession(id: string, owner: string, ref: string): void {
    if (!this.db.prepare("UPDATE publications SET session_ref=? WHERE id=? AND owner=? AND lease_until>?").run(ref, id, owner, Date.now()).changes) throw new WorkspaceError(409, "publication_busy");
  }
  revokeDispatch(id: string, scope: WorkspaceContext): void {
    this.transaction(() => {
      const p = this.publication(id, scope);
      if (!["uploading", "uncertain"].includes(p.state)) throw new WorkspaceError(409, "publication_busy");
      this.db.prepare("UPDATE publications SET dispatch_revoked=1 WHERE id=?").run(id);
      this.audit(scope, "publication.dispatch-stopped", id);
    });
  }
  assertDispatch(id: string, owner: string): void {
    const row = this.db.prepare("SELECT dispatch_revoked FROM publications WHERE id=? AND owner=? AND lease_until>?").get(id, owner, Date.now()) as {dispatch_revoked:number} | undefined;
    if (!row) throw new WorkspaceError(409, "publication_busy");
    if (row.dispatch_revoked) throw new WorkspaceError(409, "publication_dispatch_stopped");
  }
  cancel(id: string, scope: WorkspaceContext): StudioPublication {
    return this.transaction(() => {
      const p = this.publication(id, scope);
      if (p.state !== "review") throw new WorkspaceError(409, "publication_busy");
      p.state = "cancelled"; this.db.prepare("UPDATE publications SET data=? WHERE id=?").run(JSON.stringify(p), id);
      this.audit(scope, "publication.cancelled", id); return p;
    });
  }
  addRender(scope: WorkspaceContext, render: StudioRender, owner: string): void {
    this.artifact(render.sourceId, scope);
    this.db.prepare("INSERT INTO renders VALUES(?,?,?,?,?,?,?)").run(render.id, scope.accountId, scope.projectId, render.sourceId, JSON.stringify(render), owner, Date.now() + 300_000);
  }
  render(id: string, scope: WorkspaceContext): StudioRender {
    idSchema.parse(id); const c = this.scope(scope);
    const row = this.db.prepare("SELECT data,lease_until FROM renders WHERE id=? AND account_id=? AND project_id=?").get(id, c.accountId, c.projectId) as Row | undefined;
    if (!row) throw new WorkspaceError(404, "render_not_found");
    const value = JSON.parse(row.data) as StudioRender;
    return value.state === "running" && (row.lease_until ?? 0) < Date.now() ? { ...value, state: "failed", error: "render_interrupted" } : value;
  }
  renders(scope: WorkspaceContext): StudioRender[] {
    const c = this.scope(scope);
    return (this.db.prepare("SELECT id FROM renders WHERE account_id=? AND project_id=? ORDER BY rowid DESC LIMIT 30").all(c.accountId, c.projectId) as {id:string}[]).map(r => this.render(r.id, scope));
  }
  saveRender(render: StudioRender, owner: string): void {
    if (!this.db.prepare("UPDATE renders SET data=?,lease_until=? WHERE id=? AND owner=?").run(JSON.stringify(render), Date.now() + 300_000, render.id, owner).changes) throw new WorkspaceError(409, "render_busy");
  }
}
