import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { MediaEdit } from "../../../packages/domain/src/media.js";
import { OpenCodeBridge } from "../../../packages/ai-bridge/src/opencode.js";
import { aiProposalSchema, aiRequestSchema, aiScopeSchema, type AiRun } from "../../../packages/domain/src/ai.js";
import { publicationInputSchema } from "../../../packages/domain/src/studio.js";
import { idSchema, type WorkspaceContext } from "../../../packages/domain/src/workspace.js";
import { redactSensitiveText, WorkspaceError } from "../../../packages/storage/src/config.js";
import type { WorkspaceStore } from "../../../packages/storage/src/store.js";
import type { StudioService } from "./studio.js";
import type { TranscriptionService } from "./transcription.js";

export interface AiOptions { bridge?: Pick<OpenCodeBridge, "discover" | "propose">; transcription?: TranscriptionService }
type Scope = z.infer<typeof aiScopeSchema>;
type Setup = Awaited<ReturnType<OpenCodeBridge["discover"]>>;
interface Grant { scope: Scope; includeMemory: boolean; includeTranscript: boolean; expiresAt: number; proposals: Set<string>; renders: Set<string>; transcripts: Set<string> }
const cleanError = (error: unknown): string => error instanceof WorkspaceError ? error.code
  : error instanceof Error && /^ai_[a-z_]+$/.test(error.message) ? error.message : "ai_process_failed";
const stamp = () => new Date().toISOString();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sanitizedEdit = (edit: MediaEdit) => ({ ...edit, caption: redactSensitiveText(edit.caption),
  ...(edit.timedCaptions ? { timedCaptions: edit.timedCaptions.map(c => ({ ...c, text: redactSensitiveText(c.text) })) } : {}) });
// Timed captions may contain locally recognized speech. Never disclose them through
// the metadata/current-timeline path; transcript_read/context has its own consent.
const metadataEdit = (edit: MediaEdit) => { const { timedCaptions, ...value } = edit; return { ...value, caption: redactSensitiveText(edit.caption) }; };
export class AiService {
  private readonly bridge: Pick<OpenCodeBridge, "discover" | "propose">;
  private readonly owner = randomUUID();
  private readonly shutdown = new AbortController();
  private readonly tasks = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private readonly grants = new Map<string, Grant>();
  private discovery: { promise: Promise<Setup>; refresh: boolean } | undefined;
  private readonly discoveries = new Set<Promise<Setup>>();
  private discoveryGeneration = 0;
  private cached: { value: Setup; until: number } | undefined;
  private readonly transcription: TranscriptionService | undefined;
  constructor(private readonly store: WorkspaceStore, private readonly studio: StudioService, options: AiOptions = {}) {
    this.bridge = options.bridge ?? new OpenCodeBridge();
    this.transcription = options.transcription;
  }
  async setup(refresh = false): Promise<Setup> {
    this.ready();
    if (this.discovery && (!refresh || this.discovery.refresh)) return structuredClone(await this.discovery.promise);
    if (!refresh && this.cached && this.cached.until > Date.now()) return structuredClone(this.cached.value);
    const previous = this.discovery?.promise, generation = ++this.discoveryGeneration;
    // A force refresh arriving during an ordinary read must run after it, rather
    // than joining the cached read or allowing its older result to win later.
    const promise = Promise.resolve().then(async () => {
      if (previous) await previous.catch(() => undefined);
      this.ready();
      const value = await this.bridge.discover(this.shutdown.signal, { refresh });
      this.ready();
      if (generation === this.discoveryGeneration) this.cached = { value: structuredClone(value), until: Date.now() + (value.available ? 60_000 : 5000) };
      return value;
    }).finally(() => {
      this.discoveries.delete(promise);
      if (this.discovery?.promise === promise) this.discovery = undefined;
    });
    this.discovery = { promise, refresh }; this.discoveries.add(promise);
    return structuredClone(await promise);
  }
  private ready() { if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing"); }
  private scope(value: { context: WorkspaceContext; destinationId: string; artifactId: string }) {
    const scope = aiScopeSchema.parse(value); this.store.studio.scope(scope.context);
    const account = this.store.listAccounts().find(a => a.id === scope.context.accountId);
    if (!account || account.destinationId !== scope.destinationId) throw new WorkspaceError(409, "ai_scope_mismatch");
    const artifact = this.store.studio.artifact(scope.artifactId, scope.context);
    if (artifact.kind === "proxy" || artifact.kind === "preview") throw new WorkspaceError(409, "ai_scope_mismatch");
    return { scope, account, artifact };
  }
  private memory(context: WorkspaceContext) {
    return [...this.store.listMemory({ accountId: context.accountId, projectId: null }), ...this.store.listMemory(context)]
      .filter(note => note.reviewState === "confirmed").slice(0, 12).map(note => ({ kind: note.kind, text: redactSensitiveText(note.text).slice(0, 650) }));
  }
  runs(artifactId: string, context: WorkspaceContext) { return this.store.studio.aiRuns(artifactId, context); }
  private newRun(scope: Scope, model: string, prompt: string, includeMemory: boolean, includeTranscript = false): AiRun {
    const { artifact } = this.scope(scope);
    if (!artifact.probe) throw new WorkspaceError(409, "ai_media_unprobed");
    return { id: randomUUID(), ...scope, sourceSha256: artifact.sha256, baseRevision: this.store.studio.timeline(artifact.id, scope.context).revision,
      model, prompt: redactSensitiveText(prompt), includeMemory, includeTranscript, state: "running", summary: null, edit: null, error: null,
      events: [], createdAt: stamp(), sessionId: null, previewRenderId: null };
  }
  private transcript(scope: Scope) {
    const result = this.transcription?.latest(scope.artifactId, scope.context);
    const { artifact } = this.scope(scope);
    if (!result || result.state !== "succeeded" || result.sourceSha256 !== artifact.sha256) throw new WorkspaceError(409, "transcript_not_ready");
    return result;
  }
  private transcriptContext(run: AiRun) {
    if (!run.includeTranscript) return null;
    const value = this.transcript({ context: { accountId: run.context.accountId, projectId: run.context.projectId! }, artifactId: run.artifactId, destinationId: run.destinationId });
    let remaining = 16_000;
    const segments = [];
    for (const segment of value.segments) {
      if (remaining <= 0 || segments.length >= 150) break;
      const text = redactSensitiveText(segment.text).slice(0, remaining);
      segments.push({ start: segment.start, end: segment.end, text }); remaining -= text.length;
    }
    return { language: value.language, duration: value.duration, sourceSha256: value.sourceSha256, segments, truncated: segments.length < value.segments.length || remaining === 0 };
  }
  private prepared(run: AiRun) {
    const { artifact, account } = this.scope({ context: run.context, artifactId: run.artifactId, destinationId: run.destinationId });
    const timeline = this.store.studio.timeline(run.artifactId, run.context);
    const current = timeline.edits[timeline.cursor];
    return JSON.stringify({
      task: "Propose a non-destructive video edit. Never use tools or access files. Return exactly one JSON object with summary and edit, no additional fields or prose.",
      format: { summary: "short explanation", edit: { inSeconds: 0, outSeconds: artifact.probe!.duration, crop: "original|vertical|square", gainDb: 0, caption: "literal static caption", segments: "optional ordered non-overlapping [{inSeconds,outSeconds}] inside envelope; max 32" } },
      rules: ["All times are source seconds. Range ends must not exceed source duration.", "If segments are supplied, inSeconds/outSeconds enclose them. Gaps remove footage.", "crop must be exactly original, vertical or square; gainDb between -60 and 24; caption max 2000 characters.", "No approval or publication authority. No media/audio/frame bytes are attached."],
      context: { account: redactSensitiveText(account.displayName), destinationId: run.destinationId, projectId: run.context.projectId,
        artifactId: artifact.id, filename: redactSensitiveText(artifact.filename), probe: artifact.probe,
         baseRevision: run.baseRevision, currentEdit: current ? metadataEdit(current) : null,
         timedCaptionCount: current?.timedCaptions?.length ?? 0 },
      confirmedNotes: run.includeMemory ? this.memory(run.context) : [], transcript: this.transcriptContext(run), request: run.prompt
    });
  }
  async start(value: z.infer<typeof aiRequestSchema>): Promise<AiRun> {
    this.ready(); const input = aiRequestSchema.parse(value);
    this.scope({ context: input.context, artifactId: input.artifactId, destinationId: input.destinationId });
    const setup = await this.setup(); this.ready();
    if (!setup.available) throw new WorkspaceError(409, setup.error ?? "ai_unavailable");
    if (!setup.models.includes(input.model)) throw new WorkspaceError(400, "ai_model_unavailable");
    if (this.tasks.size >= 2) throw new WorkspaceError(409, "ai_busy");
    const run = this.newRun({ context: input.context, artifactId: input.artifactId, destinationId: input.destinationId }, input.model, input.prompt, input.includeMemory, input.includeTranscript);
    if (run.includeTranscript && !await this.studio.engine.verify(run.artifactId, run.sourceSha256, this.shutdown.signal)) throw new WorkspaceError(409, "media_source_changed");
    this.ready();
    const prompt = this.prepared(run);
    if (this.tasks.size >= 2) throw new WorkspaceError(409, "ai_busy");
    this.store.studio.createAiRun(run, this.owner);
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, this.shutdown.signal]);
    const promise = Promise.resolve().then(async () => {
      const heartbeat = setInterval(() => { try { this.store.studio.assertAiActive(run.id, this.owner); this.store.studio.saveAiRun(run, this.owner); } catch { abort.abort(); } }, 1000);
      try {
        const result = await this.bridge.propose({ model: run.model, prompt }, event => {
          if (signal.aborted) return;
          try { this.store.studio.assertAiActive(run.id, this.owner); } catch { abort.abort(); return; }
          run.events = [...run.events, { message: event.type, at: stamp() }].slice(-20);
          this.store.studio.saveAiRun(run, this.owner);
        }, signal);
        signal.throwIfAborted();
        const parsed = aiProposalSchema.safeParse({ summary: redactSensitiveText(result.summary), edit: sanitizedEdit(result.edit) });
        if (!parsed.success) throw new WorkspaceError(400, "ai_invalid_proposal");
        const proposal = parsed.data;
        const { artifact } = this.scope({ context: run.context, artifactId: run.artifactId, destinationId: run.destinationId });
        if (artifact.sha256 !== run.sourceSha256 || !await this.studio.engine.verify(artifact.id, run.sourceSha256, signal)) throw new WorkspaceError(409, "media_source_changed");
        if (!artifact.probe || proposal.edit.outSeconds > artifact.probe.duration) throw new WorkspaceError(400, "ai_invalid_proposal");
        signal.throwIfAborted();
        this.store.studio.assertAiActive(run.id, this.owner);
        run.summary = proposal.summary; run.edit = proposal.edit;
        run.sessionId = result.sessionId; run.state = "ready";
      } catch (error) { run.state = signal.aborted ? "cancelled" : "failed"; run.error = signal.aborted ? null : cleanError(error); }
      finally { clearInterval(heartbeat); this.store.studio.saveAiRun(run, this.owner); }
    }).finally(() => this.tasks.delete(run.id));
    this.tasks.set(run.id, { abort, promise }); void promise.catch(() => undefined); return run;
  }
  async cancel(id: string, context: WorkspaceContext) {
    const run = this.store.studio.aiRun(id, context), task = this.tasks.get(id);
    if (run.state !== "running") throw new WorkspaceError(409, "ai_run_conflict");
    const pending = this.store.studio.requestAiCancel(id, context);
    if (!task) return pending;
    task.abort.abort(); await task.promise; return this.store.studio.aiRun(id, context);
  }
  async review(id: string, context: WorkspaceContext, action: "accept" | "reject") {
    const run = this.store.studio.aiRun(id, context);
    const { artifact } = this.scope({ context, artifactId: run.artifactId, destinationId: run.destinationId });
    if (action === "accept" && !await this.studio.engine.verify(artifact.id, run.sourceSha256)) throw new WorkspaceError(409, "media_source_changed");
    this.ready(); return this.store.studio.reviewAiRun(id, context, action);
  }
  preview(id: string, context: WorkspaceContext) {
    const run = this.store.studio.aiRun(id, context);
    this.scope({ context, artifactId: run.artifactId, destinationId: run.destinationId });
    if (run.state !== "ready" || !run.edit) throw new WorkspaceError(409, "ai_run_conflict");
    const render = this.studio.renderCandidate(run.artifactId, context, run.edit, run.baseRevision, run.sourceSha256);
    return { run: this.store.studio.attachAiPreview(id, context, render.id), render };
  }
  createGrant(value: Scope & { includeMemory: boolean; includeTranscript?: boolean }, origin: string) {
    this.ready();
    const input = aiScopeSchema.extend({ includeMemory: z.boolean(), includeTranscript: z.boolean().default(false) }).strict().parse(value);
    const scope: Scope = { context: input.context, artifactId: input.artifactId, destinationId: input.destinationId };
    this.scope(scope);
    for (const [key, grant] of this.grants) if (grant.expiresAt <= Date.now()) this.grants.delete(key);
    if (this.grants.size >= 32) throw new WorkspaceError(409, "mcp_grant_limit");
    const token = randomBytes(32).toString("hex");
    const grant: Grant = { scope, includeMemory: input.includeMemory, includeTranscript: input.includeTranscript, expiresAt: Date.now() + 30 * 60_000, proposals: new Set(), renders: new Set(), transcripts: new Set() };
    this.grants.set(digest(token), grant);
    const candidates = [new URL("./mcp.mjs", import.meta.url), new URL("../../mcp-server/src/index.js", import.meta.url)];
    const entry = candidates.map(url => fileURLToPath(url)).concat([
      resolve("dist/services/mcp-server/src/index.js"), resolve("../../dist/services/mcp-server/src/index.js")
    ]).find(path => existsSync(path));
    if (!entry) { this.grants.delete(digest(token)); throw new WorkspaceError(409, "mcp_runtime_unavailable"); }
    return { origin, token, expiresAt: new Date(grant.expiresAt).toISOString(), tools: this.tools(grant), command: { command: process.execPath, args: [entry] } };
  }
  revokeGrant(token: string, context: WorkspaceContext) {
    const key = digest(z.string().regex(/^[a-f0-9]{64}$/).parse(token)), grant = this.grants.get(key);
    this.store.studio.scope(context);
    if (!grant || grant.scope.context.accountId !== context.accountId || grant.scope.context.projectId !== context.projectId) throw new WorkspaceError(404, "mcp_grant_not_found");
    this.grants.delete(key); return { revoked: true };
  }
  private tools(grant: Grant) { return ["media_inspect", "timeline_read", ...(grant.includeMemory ? ["memory_read"] : []),
    ...(this.transcription ? ["media_transcribe", "transcript_status", "transcript_cancel", ...(grant.includeTranscript ? ["transcript_read"] : [])] : []),
    "timeline_propose", "render_preview", "render_status", "publication_request"]; }
  private grant(authorization: string): Grant {
    this.ready();
    if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) throw new WorkspaceError(401, "mcp_grant_invalid");
    const key = digest(authorization.slice(7)), grant = this.grants.get(key);
    if (!grant || grant.expiresAt <= Date.now()) { this.grants.delete(key); throw new WorkspaceError(401, "mcp_grant_invalid"); }
    this.scope(grant.scope); return grant;
  }
  capabilities(authorization: string) {
    const grant = this.grant(authorization);
    return { tools: this.tools(grant), expiresAt: new Date(grant.expiresAt).toISOString(), scope: {
      ...grant.scope.context, artifactId: grant.scope.artifactId, destinationId: grant.scope.destinationId }, includeMemory: grant.includeMemory, includeTranscript: grant.includeTranscript };
  }
  async call(authorization: string, value: unknown) {
    const grant = this.grant(authorization), { scope } = grant;
    const input = z.object({ tool: z.string().max(100), arguments: z.record(z.string(), z.unknown()) }).strict().parse(value);
    if (!this.tools(grant).includes(input.tool)) throw new WorkspaceError(403, "mcp_tool_forbidden");
    if (["media_transcribe", "transcript_status", "transcript_read", "transcript_cancel"].includes(input.tool)) {
      if (!this.transcription) throw new WorkspaceError(409, "transcription_unavailable");
      if (input.tool === "transcript_cancel") {
        const args = z.object({ transcriptId: idSchema }).strict().parse(input.arguments);
        if (!grant.transcripts.has(args.transcriptId)) throw new WorkspaceError(403, "mcp_scope_forbidden");
        const record = await this.transcription.cancel(args.transcriptId, scope.context);
        return { ...record, segments: [] };
      }
      if (input.tool === "transcript_read") {
        const args = z.object({ offset: z.number().int().min(0).max(10_000).default(0), limit: z.number().int().min(1).max(100).default(100) }).strict().parse(input.arguments);
        const record = this.transcript(scope);
        if (!await this.studio.engine.verify(scope.artifactId, record.sourceSha256)) throw new WorkspaceError(409, "media_source_changed");
        this.grant(authorization);
        if (this.scope(scope).artifact.sha256 !== record.sourceSha256) throw new WorkspaceError(409, "media_source_changed");
        const end = Math.min(record.segments.length, args.offset + args.limit);
        return { ...record, segments: record.segments.slice(args.offset, end), nextOffset: end < record.segments.length ? end : null };
      }
      z.object({}).strict().parse(input.arguments);
      if (input.tool === "media_transcribe") {
        const record = await this.transcription.start(scope.artifactId, scope.context, () => { this.grant(authorization); }); grant.transcripts.add(record.id);
        return { ...record, segments: [] };
      }
      const record = this.transcription.latest(scope.artifactId, scope.context);
      return record ? { ...record, segments: [] } : null;
    }
    if (["media_inspect", "timeline_read", "memory_read"].includes(input.tool)) {
      z.object({}).strict().parse(input.arguments);
      if (input.tool === "media_inspect") {
        const a = this.store.studio.artifact(scope.artifactId, scope.context);
        return { id: a.id, filename: a.filename, sha256: a.sha256, bytes: a.bytes, probe: a.probe };
      }
      if (input.tool === "timeline_read") {
        const timeline = this.store.studio.timeline(scope.artifactId, scope.context);
        return { ...timeline, edits: timeline.edits.map(metadataEdit),
          ...(timeline.edits.some(e => e.timedCaptions?.length) ? { timedCaptionsOmitted: true } : {}) };
      }
      return this.memory(scope.context);
    }
    if (input.tool === "timeline_propose") {
      const value = aiProposalSchema.extend({ baseRevision: z.number().int().nonnegative() }).strict().parse(input.arguments);
      const run = this.newRun(scope, "external-mcp", "MCP edit proposal", grant.includeMemory, grant.includeTranscript);
      const artifact = this.store.studio.artifact(scope.artifactId, scope.context);
      if (run.baseRevision !== value.baseRevision) throw new WorkspaceError(409, "revision_conflict");
      if (!artifact.probe || value.edit.outSeconds > artifact.probe.duration) throw new WorkspaceError(400, "ai_invalid_proposal");
      const sanitized = aiProposalSchema.safeParse({ summary: redactSensitiveText(value.summary), edit: sanitizedEdit(value.edit) });
      if (!sanitized.success) throw new WorkspaceError(400, "ai_invalid_proposal");
      run.state = "ready"; run.summary = sanitized.data.summary; run.edit = sanitized.data.edit;
      const created = this.store.studio.createAiRun(run, this.owner); grant.proposals.add(run.id); return created;
    }
    if (input.tool === "render_preview") {
      const args = z.object({ proposalId: idSchema }).strict().parse(input.arguments);
      if (!grant.proposals.has(args.proposalId)) throw new WorkspaceError(403, "mcp_scope_forbidden");
      const result = this.preview(args.proposalId, scope.context); grant.renders.add(result.render.id); return result;
    }
    if (input.tool === "render_status") {
      const args = z.object({ renderId: idSchema }).strict().parse(input.arguments);
      if (!grant.renders.has(args.renderId)) throw new WorkspaceError(403, "mcp_scope_forbidden");
      return this.store.studio.render(args.renderId, scope.context);
    }
    const fields = publicationInputSchema.omit({ context: true, artifactId: true }).strict().parse(input.arguments);
    // Requesting a review draft is the only publication tool. Approval remains UI-only.
    return this.studio.create({ context: scope.context, artifactId: scope.artifactId, ...fields });
  }
  async close() {
    this.shutdown.abort(); this.grants.clear();
    for (const task of this.tasks.values()) task.abort.abort();
    await Promise.allSettled([...this.tasks.values()].map(task => task.promise));
    await Promise.allSettled(this.discoveries);
  }
}
