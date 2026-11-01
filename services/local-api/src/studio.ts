import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import type { MediaEdit } from "../../../packages/domain/src/media.js";
import { editSchema } from "../../../packages/domain/src/media.js";
import { publicationInputSchema, type PublicationInput, type StudioPublication, type StudioRender } from "../../../packages/domain/src/studio.js";
import type { WorkspaceContext } from "../../../packages/domain/src/workspace.js";
import { MediaEngine, type MediaEngineOptions } from "../../../packages/media-engine/src/index.js";
import { WorkspaceError } from "../../../packages/storage/src/config.js";
import type { WorkspaceStore } from "../../../packages/storage/src/store.js";
import type { CredentialVault } from "../../../packages/storage/src/vault.js";
import type { YouTubeService } from "./youtube.js";
import { YouTubePublishing, type UploadReply } from "./youtube-publishing.js";

export interface StudioOptions { engine?: MediaEngineOptions; publisher?: YouTubePublishing }
const code = (error: unknown) => error instanceof WorkspaceError ? error.code : error instanceof Error &&
  /^(invalid_media_container|external_media_reference|unsupported_media_extension|media_size_limit|invalid_media_probe|media_video_required|media_trim_out_of_bounds|media_caption_does_not_fit|media_tool_unavailable|media_ffmpeg_failed|media_ffprobe_failed|media_tool_timeout|media_tool_output_limit|media_source_changed|media_render_incomplete)(:|$)/.test(error.message)
  ? error.message.split(":")[0]! : "media_operation_failed";
export class StudioService {
  readonly engine: MediaEngine;
  private readonly publisher: YouTubePublishing;
  private readonly owner = randomUUID();
  private readonly shutdown = new AbortController();
  private readonly tasks = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private readonly reads = new Set<Promise<unknown>>();
  private readonly checked = new Map<string, number>();
  private imports = 0;
  constructor(private readonly store: WorkspaceStore, private readonly youtube: YouTubeService,
    private readonly vault: CredentialVault, directory: string, options: StudioOptions = {}) {
    this.engine = new MediaEngine(directory, options.engine); this.publisher = options.publisher ?? new YouTubePublishing();
  }
  async snapshot(context: WorkspaceContext) {
    const publications = this.store.studio.publications(context);
    for (const p of publications) {
      if (p.state === "processing" && !this.tasks.has(p.id) && (this.checked.get(p.id) ?? 0) + 15_000 < Date.now()) {
        this.checked.set(p.id, Date.now());
        try { this.reconcile(p.id, context); } catch { /* Another owner may be checking it. */ }
      }
    }
    return { artifacts: this.store.studio.artifacts(context).filter(a => a.kind !== "proxy" && a.kind !== "preview"), publications, renders: this.store.studio.renders(context), tools: await this.engine.status() };
  }
  async import(context: WorkspaceContext, input: Readable, filename: string, signal: AbortSignal) {
    const scope = this.store.studio.scope(context);
    if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing");
    if (this.imports >= 2) throw new WorkspaceError(409, "media_busy");
    this.imports++;
    const id = randomUUID();
    const operation = (async () => {
      try {
        const result = await this.engine.import(id, input, filename, AbortSignal.any([signal, this.shutdown.signal]));
        return this.store.studio.addArtifact({ ...result, ...scope, kind: "source", sourceId: null, channelVideoId: null, createdAt: new Date().toISOString() });
      } catch (error) { await this.engine.remove(id).catch(() => undefined); throw new WorkspaceError(400, code(error)); }
      finally { this.imports--; }
    })();
    this.reads.add(operation); try { return await operation; } finally { this.reads.delete(operation); }
  }
  async create(input: PublicationInput) {
    const value = publicationInputSchema.parse(input);
    const account = this.store.listAccounts().find(a => a.id === value.context.accountId);
    if (!account || account.platform !== "youtube" || account.status !== "connected") throw new WorkspaceError(409, "youtube_reauth_required");
    const artifact = this.store.studio.artifact(value.artifactId, value.context);
    if (artifact.kind === "proxy" || artifact.kind === "preview") throw new WorkspaceError(409, "media_proxy_not_publishable");
    if (!await this.engine.verify(artifact.id, artifact.sha256)) throw new WorkspaceError(409, "media_source_changed");
    return this.store.studio.create(value, account.destinationId);
  }
  private launch(id: string, work: (signal: AbortSignal) => Promise<void>) {
    if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing");
    const abort = new AbortController();
    // Delay execution until after the durable claim and task registration.
    const promise = Promise.resolve().then(() => work(AbortSignal.any([abort.signal, this.shutdown.signal])))
      .finally(() => this.tasks.delete(id));
    this.tasks.set(id, { abort, promise }); void promise.catch(() => undefined);
  }
  approve(id: string, context: WorkspaceContext, digest: string) {
    if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing");
    if (this.youtube.isBusy?.(context.accountId)) throw new WorkspaceError(409, "publication_busy");
    const p = this.store.studio.claim(id, context, this.owner, digest);
    this.launch(id, signal => this.upload(p, signal, false)); return p;
  }
  reconcile(id: string, context: WorkspaceContext) {
    if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing");
    if (this.youtube.isBusy?.(context.accountId)) throw new WorkspaceError(409, "publication_busy");
    const p = this.store.studio.claim(id, context, this.owner, null);
    this.launch(id, signal => this.upload(p, signal, true)); return p;
  }
  cancel(id: string, context: WorkspaceContext) {
    const p = this.store.studio.publication(id, context);
    if (p.state === "review") return this.store.studio.cancel(id, context);
    this.store.studio.revokeDispatch(id, context);
    this.tasks.get(id)?.abort.abort();
    return { ...p, state: "uncertain" as const, error: "publication_dispatch_stopped" };
  }
  private async snapshotBytes(p: StudioPublication, signal: AbortSignal) {
    const directory = await mkdtemp(join(tmpdir(), "atrisshare-upload-"));
    const snapshot = await open(join(directory, "snapshot"), "wx+", 0o600);
    try {
      const source = await open(this.engine.path(p.payload.artifactId), "r");
      const hash = createHash("sha256"); let offset = 0;
      try {
        if ((await source.stat()).size !== p.payload.bytes) throw new WorkspaceError(409, "media_source_changed");
        while (offset < p.payload.bytes) {
          signal.throwIfAborted();
          const buffer = Buffer.alloc(Math.min(1024 * 1024, p.payload.bytes - offset));
          const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
          if (bytesRead !== buffer.length) throw new WorkspaceError(409, "media_source_changed");
          hash.update(buffer);
          let written = 0;
          while (written < buffer.length) {
            const result = await snapshot.write(buffer, written, buffer.length - written, offset + written);
            if (!result.bytesWritten) throw new WorkspaceError(500, "media_operation_failed");
            written += result.bytesWritten;
          }
          offset += bytesRead;
        }
        if (hash.digest("hex") !== p.payload.sha256) throw new WorkspaceError(409, "media_source_changed");
      } finally { await source.close(); }
      return { file: snapshot, async close() { await snapshot.close(); await rm(directory, { recursive: true, force: true }); } };
    } catch (error) { await snapshot.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  }
  private async upload(p: StudioPublication, signal: AbortSignal, resume: boolean): Promise<void> {
    const heartbeat = setInterval(() => { try { this.store.studio.checkpoint(p, this.owner); } catch { this.tasks.get(p.id)?.abort.abort(); } }, 30_000);
    const saved = () => this.store.studio.checkpoint(p, this.owner);
    const consumeReply = (reply: UploadReply): number => {
      if (reply.state === "missing") throw new WorkspaceError(409, "youtube_session_missing");
      if (reply.state === "complete") { p.videoId = reply.videoId; p.state = "processing"; p.progress = 1; saved(); return p.payload.bytes; }
      p.progress = reply.offset / p.payload.bytes; saved(); return reply.offset;
    };
    try {
      await this.youtube.withVerified({ accountId: p.payload.accountId, destinationId: p.payload.destinationId }, async (token, youtubeSignal, guard = () => {}) => {
        const combined = AbortSignal.any([signal, youtubeSignal]); combined.throwIfAborted();
        if (p.videoId) {
          const result = await this.publisher.processing(token, p.videoId, combined);
          p.state = result.state; p.error = result.state === "failed" ? "youtube_processing_failed" : null; saved(); return;
        }
        let sessionUrl: string | null = null;
        const ref = this.store.studio.session(p.id, this.owner);
        if (ref) sessionUrl = await this.vault.get(ref);
        if (resume && !sessionUrl) throw new WorkspaceError(409, "youtube_upload_uncertain");
        let offset = 0;
        if (sessionUrl) offset = consumeReply(await this.publisher.query(token, sessionUrl, p.payload.bytes, combined));
        if (p.videoId) return;
        const validApproval = () => {
          combined.throwIfAborted();
          guard(); this.store.studio.assertDispatch(p.id, this.owner);
          if (!p.approvalExpiresAt || Date.now() >= Date.parse(p.approvalExpiresAt)) throw new WorkspaceError(409, "approval_expired");
        };
        validApproval();
        const snapshot = await this.snapshotBytes(p, combined);
        try {
          validApproval();
          if (!sessionUrl) {
          const { title, description, visibility, madeForKids, notifySubscribers } = p.payload;
          sessionUrl = await this.publisher.initiate(token, { title, description, visibility, madeForKids, notifySubscribers }, p.payload.bytes, p.payload.mimeType, combined);
          const sessionRef = `account:${randomUUID()}`;
          await this.vault.set(sessionRef, sessionUrl);
          this.store.studio.setSession(p.id, this.owner, sessionRef);
          }
          p.state = "uploading"; p.error = null; saved();
          const file = snapshot.file;
          if ((await file.stat()).size !== p.payload.bytes) throw new WorkspaceError(409, "media_source_changed");
          while (offset < p.payload.bytes && !p.videoId) {
            validApproval();
            const buffer = Buffer.alloc(Math.min(8 * 1024 * 1024, p.payload.bytes - offset));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
            if (bytesRead !== buffer.length) throw new WorkspaceError(409, "media_source_changed");
            validApproval();
            const next = consumeReply(await this.publisher.upload(token, sessionUrl, buffer, offset, p.payload.bytes, combined));
            if (next <= offset && !p.videoId) throw new WorkspaceError(409, "youtube_upload_uncertain");
            offset = next;
          }
          // A 308 acknowledging the final byte is not a final provider receipt.
          if (!p.videoId) throw new WorkspaceError(409, "youtube_upload_uncertain");
        } finally { await snapshot.close(); }
      });
    } catch (error) {
      p.state = p.videoId ? "processing" : "uncertain"; p.error = code(error);
    } finally {
      clearInterval(heartbeat);
      this.store.studio.checkpoint(p, this.owner, true);
    }
    if (p.state === "succeeded") {
      // The durable receipt precedes optional memory; repeated reconciliation cannot duplicate it.
      this.store.createMemory({ context: p.context, kind: "publication", reviewState: "confirmed",
        text: `YouTube · ${p.payload.title}\n${p.payload.destinationId}\nhttps://www.youtube.com/watch?v=${p.videoId}` });
    }
  }
  render(id: string, context: WorkspaceContext, expectedRevision: number): StudioRender {
    const timeline = this.store.studio.timeline(id, context);
    if (timeline.revision !== expectedRevision) throw new WorkspaceError(409, "revision_conflict");
    const edit = timeline.edits[timeline.cursor];
    if (!edit) throw new WorkspaceError(409, "timeline_empty");
    return this.startRender(id, context, "export", edit, expectedRevision);
  }
  proxy(id: string, context: WorkspaceContext): StudioRender {
    return this.startRender(id, context, "proxy", null, 0);
  }
  renderCandidate(id: string, context: WorkspaceContext, edit: MediaEdit, expectedRevision: number, sha256: string): StudioRender {
    const artifact = this.store.studio.artifact(id, context);
    if (artifact.sha256 !== sha256) throw new WorkspaceError(409, "media_source_changed");
    if (this.store.studio.timeline(id, context).revision !== expectedRevision) throw new WorkspaceError(409, "revision_conflict");
    const value = editSchema.parse(edit);
    if (!artifact.probe || value.outSeconds > artifact.probe.duration + .001) throw new WorkspaceError(400, "timeline_bounds");
    return this.startRender(id, context, "preview", value, expectedRevision);
  }
  private startRender(id: string, context: WorkspaceContext, kind: "export" | "proxy" | "preview", edit: MediaEdit | null, revision: number): StudioRender {
    if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing");
    if ([...this.tasks.keys()].some(key => key.startsWith("render:"))) throw new WorkspaceError(409, "media_busy");
    const artifact = this.store.studio.artifact(id, context);
    if (artifact.kind === "proxy") throw new WorkspaceError(409, "media_proxy_readonly");
    const render: StudioRender = { id: randomUUID(), sourceId: id, kind, state: "running", progress: 0, error: null, artifactId: null };
    this.store.studio.addRender(context, render, this.owner);
    this.launch(`render:${render.id}`, async signal => {
      const outputId = randomUUID();
      let registered = false;
      let heartbeatFailed = false;
      const heartbeat = setInterval(() => {
        try { this.store.studio.saveRender(render, this.owner); }
        catch { heartbeatFailed = true; this.tasks.get(`render:${render.id}`)?.abort.abort(); }
      }, 30_000);
      try {
        if (!await this.engine.verify(id, artifact.sha256, signal)) throw new WorkspaceError(409, "media_source_changed");
        const progress = (progress: number) => {
          render.progress = Math.max(0, Math.min(1, progress)); this.store.studio.saveRender(render, this.owner);
        };
        const result = kind === "proxy" ? await this.engine.proxy(id, outputId, progress, signal)
          : await this.engine.render(id, outputId, edit!, progress, signal);
        signal.throwIfAborted();
        if (!await this.engine.verify(id, artifact.sha256, signal)) throw new WorkspaceError(409, "media_source_changed");
        signal.throwIfAborted();
        this.store.studio.addArtifact({ ...result, filename: `${artifact.filename.replace(/\.[^.]+$/, "")}-${kind === "export" ? `edit-r${revision}` : kind}.mp4`, accountId: context.accountId, projectId: context.projectId!,
          kind, sourceId: id, sourceSha256: artifact.sha256, channelVideoId: artifact.channelVideoId, createdAt: new Date().toISOString() });
        registered = true;
        if (kind === "proxy") this.store.studio.attachProxy(id, context, outputId, artifact.sha256);
        render.state = "succeeded"; render.progress = 1; render.artifactId = outputId;
        try { if (kind === "export" && edit) this.store.createMemory({ context, kind: "edit-history", reviewState: "confirmed", text: `${artifact.filename} · timeline r${revision} · ${JSON.stringify(edit.segments ?? [{ inSeconds: edit.inSeconds, outSeconds: edit.outSeconds }])} · ${edit.crop} · ${edit.gainDb} dB` }); }
        catch { /* A completed artifact must survive an optional memory failure. */ }
      } catch (error) {
        if (!registered) await this.engine.remove(outputId).catch(() => undefined);
        render.state = heartbeatFailed ? "failed" : signal.aborted ? "cancelled" : "failed";
        render.error = heartbeatFailed ? "media_storage_unavailable" : signal.aborted ? null : code(error);
      } finally { clearInterval(heartbeat); this.store.studio.saveRender(render, this.owner); }
    }); return render;
  }
  cancelRender(id: string, context: WorkspaceContext) {
    const render = this.store.studio.render(id, context), task = this.tasks.get(`render:${id}`);
    if (render.state !== "running" || !task) throw new WorkspaceError(409, "render_not_running");
    task.abort.abort(); return render;
  }
  async catalog(accountId: string, destinationId: string, pageToken: string | null) {
    return this.youtube.withVerified({ accountId, destinationId }, (token, signal) => this.publisher.catalog(token, destinationId, pageToken, signal));
  }
  async link(id: string, context: WorkspaceContext, videoId: string) {
    this.store.studio.artifact(id, context);
    const account = this.store.listAccounts().find(a => a.id === context.accountId);
    if (!account) throw new WorkspaceError(404, "context_not_found");
    // Provider ownership verification uses videos.list, not a client-supplied catalog row.
    await this.youtube.withVerified({ accountId: account.id, destinationId: account.destinationId }, (token, signal) =>
      this.publisher.verifyVideo(token, account.destinationId, videoId, signal));
    return this.store.studio.link(id, context, videoId);
  }
  async close() {
    this.shutdown.abort(); for (const task of this.tasks.values()) task.abort.abort();
    await Promise.allSettled([...this.tasks.values()].map(t => t.promise));
    await Promise.allSettled([...this.reads]);
  }
}
