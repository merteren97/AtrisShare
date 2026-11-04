import { randomUUID } from "node:crypto";
import { transcriptContextSchema, transcriptionErrorSchema, type Transcript } from "../../../packages/domain/src/transcription.js";
import { idSchema, type WorkspaceContext } from "../../../packages/domain/src/workspace.js";
import { TranscriptionEngine } from "../../../packages/media-engine/src/transcription.js";
import { WorkspaceError } from "../../../packages/storage/src/config.js";
import type { WorkspaceStore } from "../../../packages/storage/src/store.js";
import type { TranscriptStore } from "../../../packages/storage/src/transcript-store.js";
import type { StudioService } from "./studio.js";
import { projectLifecycleGuard } from "./project-lifecycle.js";

export interface TranscriptionOptions { engine?: Pick<TranscriptionEngine, "status" | "transcribe"> }
export type TranscriptionStatus = Awaited<ReturnType<TranscriptionEngine["status"]>>;
const stamp = () => new Date().toISOString();
function cleanError(error: unknown): Transcript["error"] {
  const message = error instanceof WorkspaceError ? error.code : error instanceof Error ? error.message : "";
  // Tool-unavailable is the sole engine code with a diagnostic suffix. Never persist it.
  const parsed = transcriptionErrorSchema.safeParse(/^transcription_tool_unavailable: (ffmpeg|whisper)$/u.test(message)
    ? "transcription_tool_unavailable" : message);
  return parsed.success ? parsed.data : "transcription_failed";
}

export class TranscriptionService {
  private readonly engine: Pick<TranscriptionEngine, "status" | "transcribe">;
  private readonly transcripts: TranscriptStore;
  private readonly owner = randomUUID();
  private readonly shutdown = new AbortController();
  private readonly tasks = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private discovery: Promise<TranscriptionStatus> | undefined;

  constructor(private readonly store: WorkspaceStore, private readonly studio: StudioService, options: TranscriptionOptions = {}) {
    this.engine = options.engine ?? new TranscriptionEngine();
    this.transcripts = store.transcripts;
  }
  private ready(): void { if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing"); }
  async setup(): Promise<TranscriptionStatus> {
    this.ready();
    this.discovery ??= Promise.resolve().then(() => this.engine.status()).then(status => ({
      available: status.available === true && status.ffmpeg === true && status.whisper === true && status.model === true,
      ffmpeg: status.ffmpeg === true, whisper: status.whisper === true, model: status.model === true
    })).catch(() => { throw new WorkspaceError(409, "transcription_unavailable"); })
      .finally(() => { this.discovery = undefined; });
    return this.discovery;
  }
  private source(artifactId: string, context: WorkspaceContext) {
    idSchema.parse(artifactId);
    const scope = transcriptContextSchema.parse(context); this.store.studio.scope(scope);
    const artifact = this.store.studio.artifact(artifactId, scope);
    if (artifact.kind === "proxy" || artifact.kind === "preview") throw new WorkspaceError(409, "transcription_scope_mismatch");
    return { scope, artifact };
  }
  latest(artifactId: string, context: WorkspaceContext): Transcript | null {
    const { scope } = this.source(artifactId, context); return this.transcripts.latest(artifactId, scope);
  }
  async start(artifactId: string, context: WorkspaceContext, authorize?: () => void): Promise<Transcript> {
    this.ready(); this.source(artifactId, context);
    const assertActive = projectLifecycleGuard(this.store,context);
    authorize?.();
    const status = await this.setup(); this.ready(); assertActive();
    authorize?.();
    if (!status.available) throw new WorkspaceError(409, "transcription_unavailable");
    const { scope, artifact } = this.source(artifactId, context);
    const existing = this.transcripts.latest(artifactId, scope);
    if (existing?.state === "running") return existing;
    if (this.tasks.size) throw new WorkspaceError(409, "transcription_busy");
    const at = stamp();
    let run: Transcript;
    try {
      run = this.transcripts.create({ id: randomUUID(), ...scope, artifactId, sourceSha256: artifact.sha256,
        state: "running", progress: 0, language: null, segments: [], duration: null, error: null, createdAt: at, updatedAt: at }, this.owner);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "transcription_busy") {
        const active = this.transcripts.latest(artifactId, scope);
        if (active?.state === "running") return active;
      }
      throw error;
    }
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, this.shutdown.signal]);
    const promise = Promise.resolve().then(() => this.transcribe(run, abort, signal)).finally(() => this.tasks.delete(run.id));
    this.tasks.set(run.id, { abort, promise }); void promise.catch(() => undefined);
    return structuredClone(run);
  }
  private async transcribe(run: Transcript, abort: AbortController, signal: AbortSignal): Promise<void> {
    let renewed = Date.now(), written = 0, timedOut = false;
    const guard = () => { signal.throwIfAborted(); this.transcripts.assertActive(run.id, this.owner); };
    const saved = () => { run.updatedAt = stamp(); this.transcripts.save(run, this.owner); written = Date.now(); };
    const heartbeat = setInterval(() => {
      try {
        guard();
        if (Date.now() - renewed >= 30_000) { saved(); renewed = Date.now(); }
      } catch { abort.abort(); }
    }, 1000);
    const deadline = setTimeout(() => { timedOut = true; abort.abort(); }, 40 * 60_000);
    try {
      guard();
      const { artifact } = this.source(run.artifactId, { accountId: run.accountId, projectId: run.projectId });
      if (artifact.sha256 !== run.sourceSha256 || !await this.studio.engine.verify(artifact.id, run.sourceSha256, signal)) {
        throw new WorkspaceError(409, "media_source_changed");
      }
      guard();
      const probe = await this.studio.engine.inspect(artifact.id, signal);
      guard();
      if (!probe.hasAudio) throw new WorkspaceError(409, "transcription_no_audio");
      if (!Number.isFinite(probe.duration) || probe.duration <= 0) throw new WorkspaceError(409, "transcription_invalid_source");
      if (probe.duration > 7200) throw new WorkspaceError(409, "transcription_unsupported_duration_limit_7200s");
      // Only a scope-checked managed studio path reaches the local engine. No context/caption is passed.
      const result = await this.engine.transcribe(this.studio.engine.path(artifact.id), progress => {
        if (signal.aborted || !Number.isFinite(progress) || progress < 0 || progress > 1 || progress <= run.progress) return;
        try {
          guard(); run.progress = progress;
          if (Date.now() - written >= 1000) saved();
        } catch { abort.abort(); }
      }, signal);
      guard();
      if (!await this.studio.engine.verify(artifact.id, run.sourceSha256, signal)) throw new WorkspaceError(409, "media_source_changed");
      guard();
      const current = this.source(run.artifactId, { accountId: run.accountId, projectId: run.projectId }).artifact;
      if (current.sha256 !== run.sourceSha256) throw new WorkspaceError(409, "media_source_changed");
      // Project known fields only; the store sanitizes text and validates post-redaction bounds.
      run.state = "succeeded"; run.progress = 1;
      run.language = result.language; run.segments = result.segments; run.duration = result.duration;
      saved();
    } catch (error) {
      run.state = timedOut ? "failed" : signal.aborted || error instanceof WorkspaceError && error.code === "transcription_cancelled" ? "cancelled" : "failed";
      run.language = null; run.segments = []; run.duration = null;
      run.error = timedOut ? "transcription_timeout" : run.state === "cancelled" ? null : cleanError(error);
      // Lost/expired owners cannot overwrite a newer job or resurrect a terminal record.
      try { saved(); } catch { /* Durable lease expiry is exposed as transcript_interrupted. */ }
    } finally { clearInterval(heartbeat); clearTimeout(deadline); }
  }
  async cancel(id: string, context: WorkspaceContext): Promise<Transcript> {
    const scope = transcriptContextSchema.parse(context), run = this.transcripts.get(id, scope);
    this.source(run.artifactId, scope);
    const pending = this.transcripts.requestCancel(id, scope), task = this.tasks.get(id);
    if (!task) return pending;
    task.abort.abort(); await task.promise;
    return this.transcripts.get(id, scope);
  }
  async close(): Promise<void> {
    this.shutdown.abort();
    for (const task of this.tasks.values()) task.abort.abort();
    await Promise.allSettled([...this.tasks.values()].map(task => task.promise));
    if (this.discovery) await this.discovery.catch(() => undefined);
  }
}
