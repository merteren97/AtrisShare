import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { applySequenceOperations, legacySequenceClips, sequenceOperationSchema, type SequenceClip, type SequenceSnapshot, type SequenceOperation, type SequenceJob, type SequenceProposal } from "../../../packages/domain/src/sequence.js";
import { studioContextSchema } from "../../../packages/domain/src/studio.js";
import { idSchema, type WorkspaceContext } from "../../../packages/domain/src/workspace.js";
import type { WorkspaceStore } from "../../../packages/storage/src/store.js";
import { WorkspaceError, redactSensitiveText } from "../../../packages/storage/src/config.js";
import type { StudioService } from "./studio.js";
import { OpenCodeBridge } from "../../../packages/ai-bridge/src/opencode.js";
import { safeAiError } from "../../../packages/ai-bridge/src/diagnostics.js";
import { projectLifecycleGuard, watchProjectLifecycle } from "./project-lifecycle.js";

export const sequenceProposalRequestSchema = z.object({ context: studioContextSchema, expectedRevision: z.number().int().nonnegative(), model: z.string().min(1).max(200), instruction: z.string().trim().min(1).max(4000), scope: z.enum(["sequence", "selected"]), selectedClipIds: z.array(idSchema).max(128), allowRemote: z.literal(true) }).strict();
const stamp = () => new Date().toISOString();
const snapshotDigest = (s: SequenceSnapshot) => createHash("sha256").update(JSON.stringify({ profile: s.profile, clips: s.clips, revision: s.revision })).digest("hex");
const mediaError = (e: unknown) => e instanceof WorkspaceError ? e.code : e instanceof Error && /^media_[a-z_]+(?::|$)/.test(e.message) ? e.message.split(":")[0]! : "media_operation_failed";
export class SequenceService {
  private readonly owner = randomUUID();
  private readonly shutdown = new AbortController();
  private readonly tasks = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  constructor(private readonly store: WorkspaceStore, private readonly studio: StudioService, private readonly bridge: Pick<OpenCodeBridge, "discover" | "proposeSequence"> = new OpenCodeBridge(),private readonly rememberModel?: (context:WorkspaceContext,model:string)=>Promise<void>) {}
  get(context: WorkspaceContext) { return this.store.sequences.get(context); }
  jobs(context: WorkspaceContext) { return this.store.sequences.works<SequenceJob>(context, "render"); }
  proposals(context: WorkspaceContext) { return this.store.sequences.works<SequenceProposal>(context, "proposal"); }
  private ready() { if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing"); }
  private snapshot(context: WorkspaceContext, revision: number) { this.ready(); const s = this.get(context); if (s.revision !== revision) throw new WorkspaceError(409, "revision_conflict"); return s; }
  private async verify(s: SequenceSnapshot, signal: AbortSignal) {
    for (const id of new Set(s.clips.map(c => c.sourceArtifactId))) {
      const source = this.store.studio.artifact(id, s.context);
      if (s.clips.some(c => c.sourceArtifactId === id && c.sourceSha256 !== source.sha256) || !await this.studio.engine.verify(id, source.sha256, signal)) throw new WorkspaceError(409, "media_source_changed");
    }
  }
  async apply(context: WorkspaceContext, revision: number, operations: SequenceOperation[]) {
    const guard = projectLifecycleGuard(this.store, context), s = this.snapshot(context, revision);
    const state = this.compile(s,operations);
    await this.verify({...s, ...state}, this.shutdown.signal); guard(); this.ready(); return this.store.sequences.apply(context, revision, operations);
  }
  private compile(s:SequenceSnapshot,operations:SequenceOperation[]) {
    try{return applySequenceOperations({profile:s.profile,clips:s.clips},operations,id=>this.store.studio.artifact(id,s.context));}
    catch(e){if(e instanceof WorkspaceError)throw e;throw new WorkspaceError(400,e instanceof Error&&/^sequence_[a-z_]+$|^media_source_changed$/.test(e.message)?e.message:"sequence_invalid_operation");}
  }
  private sanitized(operations:SequenceOperation[]) {
    const clip=(c:SequenceClip)=>({...c,caption:redactSensitiveText(c.caption),...(c.timedCaptions?{timedCaptions:c.timedCaptions.map(c=>({...c,text:redactSensitiveText(c.text)}))}:{})});
    return operations.map(op=>sequenceOperationSchema.parse(op.type==="setCaption"?{...op,caption:redactSensitiveText(op.caption)}:op.type==="appendClips"?{...op,clips:op.clips.map(clip)}:op.type==="insertClip"?{...op,clip:clip(op.clip)}:op));
  }
  async legacy(context: WorkspaceContext, revision: number, artifactId: string) {
    const s = this.snapshot(context, revision), a = this.store.studio.artifact(artifactId, context), t = this.store.studio.timeline(artifactId, context);
    return this.apply(context, revision, [{type: "appendClips", clips: legacySequenceClips(a, t.edits[t.cursor], s.profile.fps, randomUUID)}]);
  }
  private launch(value: SequenceJob | SequenceProposal, kind: "render" | "proposal", work: (signal: AbortSignal, assertActive: () => void) => Promise<void>) {
    this.ready(); this.store.sequences.createWork(value, kind, this.owner);
    const abort = new AbortController(), lifecycle = watchProjectLifecycle(this.store, value.context, abort), signal = AbortSignal.any([abort.signal, this.shutdown.signal]);
    const promise = Promise.resolve().then(async () => {
      const timer = setInterval(() => { try { this.store.sequences.checkpoint(value, this.owner); } catch { abort.abort(); } }, 1000);
      try { await work(signal, () => { signal.throwIfAborted(); lifecycle.assertActive(); this.store.sequences.checkpoint(value, this.owner); }); }
      catch (e) { value.state = signal.aborted ? "cancelled" : "failed"; if ("artifactId" in value) value.artifactId=null; value.error = signal.aborted ? null : kind === "proposal" ? e instanceof WorkspaceError ? e.code : safeAiError(e) : mediaError(e); }
      finally { clearInterval(timer); lifecycle.dispose(); try { this.store.sequences.checkpoint(value, this.owner); } catch { /* Durable cancellation/deletion wins. */ } }
    }).finally(() => this.tasks.delete(value.id)); this.tasks.set(value.id, {abort, promise}); void promise.catch(() => {});
    return structuredClone(value);
  }
  render(context: WorkspaceContext, revision: number, kind: "preview" | "export", proposalId?: string) {
    let s = this.snapshot(context, revision);
    if (this.jobs(context).some(j => j.state === "running")) throw new WorkspaceError(409, "media_busy");
    if (proposalId) { const p = this.store.sequences.work<SequenceProposal>(proposalId, context, "proposal"); if (p.state !== "ready" || p.baseSequenceRevision !== revision || kind !== "preview") throw new WorkspaceError(409, "revision_conflict"); s = {...s, ...applySequenceOperations({profile:s.profile,clips:s.clips}, p.operations, id => this.store.studio.artifact(id, context))}; }
    if (!s.clips.length) throw new WorkspaceError(409, "sequence_empty");
    const job: SequenceJob = {id:randomUUID(),context:s.context,sequenceId:s.id,sequenceRevision:revision,snapshotDigest:snapshotDigest(s),snapshot:structuredClone(s),kind,proposalId:proposalId ?? null,state:"running",progress:0,artifactId:null,error:null,createdAt:stamp()};
    const result = this.launch(job, "render", async (signal, assertActive) => {
      const outputId = randomUUID(); let registered = false;
      try {
        await this.verify(s, signal); assertActive();
        const sources = [...new Set(s.clips.map(c => c.sourceArtifactId))].map(id => { const a = this.store.studio.artifact(id,context); if (!a.probe) throw new WorkspaceError(409,"sequence_bounds"); return {id,sha256:a.sha256,probe:a.probe}; });
        const preview = structuredClone(s); if (kind === "preview") { const factor = Math.min(1, 960 / s.profile.width, 540 / s.profile.height); preview.profile.width = Math.max(128, Math.floor(s.profile.width * factor / 2) * 2); preview.profile.height = Math.max(128, Math.floor(s.profile.height * factor / 2) * 2); }
        const output = await this.studio.engine.renderSequence(outputId,preview,sources,p => { job.progress = p; },signal);
        await this.verify(s, signal); assertActive();
        job.artifactId = outputId; job.state = "succeeded"; job.progress = 1;
        this.store.sequences.completeRender(job,this.owner,{...output,accountId:s.context.accountId,projectId:s.context.projectId,kind,sourceId:null,channelVideoId:null,createdAt:stamp(),filename:`sequence-r${revision}-${kind}-${job.id.slice(0,6)}.mp4`,sequence:{id:s.id,revision,digest:job.snapshotDigest,sources:sources.map(({id,sha256})=>({id,sha256}))}});
        registered = true;
      } finally { if (!registered) await this.studio.engine.remove(outputId).catch(() => {}); }
    });
    if (proposalId) this.store.sequences.attachPreview(proposalId,context,job.id);
    return result as SequenceJob;
  }
  async cancel(id: string, context: WorkspaceContext, kind: "render" | "proposal") { this.store.sequences.cancel(id,context,kind); const task = this.tasks.get(id); task?.abort.abort(); await task?.promise; return this.store.sequences.work(id,context,kind); }
  externalProposal(context: WorkspaceContext, revision: number, operations: SequenceOperation[], summary: string, allowedSourceIds: string[]) {
    operations=this.sanitized(operations);summary=z.string().min(1).max(2000).parse(redactSensitiveText(summary));
    const s = this.snapshot(context,revision), next = applySequenceOperations({profile:s.profile,clips:s.clips},operations,id=>this.store.studio.artifact(id,context));
    // Restrict reads as well as writes to the explicit source capability.
    if ([...s.clips,...next.clips].some(c=>!allowedSourceIds.includes(c.sourceArtifactId))) throw new WorkspaceError(403,"mcp_scope_forbidden");
    const p: SequenceProposal = {id:randomUUID(),context:s.context,baseSequenceRevision:revision,sourceIds:allowedSourceIds,state:"ready",summary:redactSensitiveText(summary),operations,error:null,previewJobId:null,model:"external-mcp",createdAt:stamp()};
    return this.store.sequences.createWork(p,"proposal",this.owner);
  }
  async propose(value: z.infer<typeof sequenceProposalRequestSchema>) {
    const input = sequenceProposalRequestSchema.parse(value), guard = projectLifecycleGuard(this.store,input.context), s = this.snapshot(input.context,input.expectedRevision);
    const selected = new Set(input.selectedClipIds);
    if (input.scope === "selected" && (!selected.size || [...selected].some(id=>!s.clips.some(c=>c.id===id)))) throw new WorkspaceError(400,"sequence_selection_required");
    const setup = await this.bridge.discover(this.shutdown.signal); guard(); this.snapshot(input.context,input.expectedRevision);
    if (!setup.available) throw new WorkspaceError(409,setup.error ?? "ai_unavailable");
    if (!setup.models.includes(input.model)) throw new WorkspaceError(400,"ai_model_unavailable");
    if ([...this.tasks.keys()].length >= 2) throw new WorkspaceError(409,"ai_busy");
    const sources = this.store.studio.artifacts(input.context).filter(a=>a.kind !== "preview" && a.kind !== "proxy" && a.probe);
    const p: SequenceProposal = {id:randomUUID(),context:s.context,baseSequenceRevision:s.revision,sourceIds:sources.map(a=>a.id),state:"running",summary:null,operations:[],error:null,previewJobId:null,model:input.model,createdAt:stamp()};
    return this.launch(p,"proposal",async(signal,assertActive)=>{
      await this.verify(s,signal); assertActive();
      const result = await this.bridge.proposeSequence({model:input.model,prompt:JSON.stringify({task:"Propose non-destructive sequence operations. Return only {summary,operations}. No tools, publication authority or filesystem access. Media/frame/audio/transcript bytes are NOT provided. Do not claim visual understanding.",clock:"All inFrame/outFrame/atFrame are SOURCE frames at profile.fps; split atFrame is absolute source frame; gaps use output frames. move index is final zero-based index.",operationSchema:z.toJSONSchema(sequenceOperationSchema),snapshot:{...s,clips:s.clips.map(({timedCaptions,...c})=>({...c,caption:redactSensitiveText(c.caption)}))},sources:sources.map(a=>({id:a.id,sha256:a.sha256,filename:redactSensitiveText(a.filename),probe:a.probe})),scope:input.scope,selectedClipIds:input.selectedClipIds,instruction:redactSensitiveText(input.instruction)})},signal);
      assertActive();
      const operations = this.sanitized(result.operations);
      if (input.scope === "selected" && operations.some(op=>!("clipId" in op) || !selected.has(op.clipId) || op.type === "moveClip")) throw new WorkspaceError(400,"ai_selection_scope");
      const next = applySequenceOperations({profile:s.profile,clips:s.clips},operations,id=>{ if (!p.sourceIds.includes(id)) throw new WorkspaceError(403,"ai_scope_mismatch"); return this.store.studio.artifact(id,input.context); });
      await this.verify({...s,...next},signal); assertActive(); p.operations = operations; p.summary = z.string().min(1).max(2000).parse(redactSensitiveText(result.summary)); p.state = "ready";
      await this.rememberModel?.(p.context,p.model).catch(()=>{});assertActive();
    }) as SequenceProposal;
  }
  async review(id: string, context: WorkspaceContext, action: "accept" | "reject") {
    const guard = projectLifecycleGuard(this.store,context), p = this.store.sequences.work<SequenceProposal>(id,context,"proposal");
    if (action === "accept") { const s = this.snapshot(context,p.baseSequenceRevision), next = applySequenceOperations({profile:s.profile,clips:s.clips},p.operations,id=>this.store.studio.artifact(id,context)); await this.verify({...s,...next},this.shutdown.signal); }
    guard(); this.ready(); return this.store.sequences.review(id,context,action);
  }
  async close() { this.shutdown.abort(); for (const t of this.tasks.values()) t.abort.abort(); await Promise.allSettled([...this.tasks.values()].map(t=>t.promise)); }
}
