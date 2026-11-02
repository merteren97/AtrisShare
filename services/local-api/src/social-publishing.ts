import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { SocialPost } from "../../../packages/domain/src/social.js";
import { WorkspaceError } from "../../../packages/storage/src/config.js";
import { SocialProvider, SocialRemoteError, socialOutput, socialUploadUrl } from "./social-provider.js";

export interface SocialMediaSnapshot { read(offset: number, length: number): Promise<Buffer>; close(): Promise<void> }
const numericId = z.string().regex(/^[0-9]{1,25}$/);
const videoUrn = z.string().max(255).regex(/^urn:li:video:[A-Za-z0-9_-]+$/);
const postUrn = z.string().max(255).regex(/^urn:li:(ugcPost|share):[0-9]+$/);
const processing = z.object({ state: z.enum(["pending", "in_progress", "succeeded", "failed"]), check_after_secs: z.number().int().min(0).max(3600).optional() });
export function linkedinPlainText(text: string): string { return text.replace(/[|{}@\[\]()<>#\\*_~]/g, "\\$&"); }
export function tikTokChunkPlan(bytes: number, chunk = 16 * 1024 ** 2): { chunkSize: number; count: number } {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 4 * 1024 ** 3) throw new WorkspaceError(400, "social_media_constraints");
  return bytes < chunk ? { chunkSize: bytes, count: 1 } : { chunkSize: chunk, count: Math.floor(bytes / chunk) };
}
/** Provider uploads and post creation are distinct writes; read-only reconciliation never creates a post. */
export class SocialPublishing {
  constructor(private readonly provider: SocialProvider,
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<void> = async (ms, signal) => { await sleep(ms, undefined, { signal }); }) {}
  async publish(p: SocialPost, media: SocialMediaSnapshot | null, authorize: (publishing?: boolean) => Promise<string>, guard: () => void,
    signal: AbortSignal, save: () => void): Promise<void> {
    // No retries here. Even malformed successful mutation responses can hide a committed remote write.
    try {
      if (p.payload.metadata.provider === "x") await this.x(p, media, authorize, guard, signal, save);
      else if (p.payload.metadata.provider === "linkedin") await this.linkedin(p, media, authorize, guard, signal, save);
      else await this.tiktok(p, media, authorize, guard, signal, save);
    } catch (e) {
      if (e instanceof SocialRemoteError && ["social_invalid_response", "social_invalid_upload_url"].includes(e.code)) throw new SocialRemoteError(e.status, e.code, true);
      throw e;
    }
  }
  private async x(p: SocialPost, media: SocialMediaSnapshot | null, auth: (publishing?: boolean) => Promise<string>, guard: () => void, signal: AbortSignal, save: () => void) {
    const m = p.payload.metadata; if (m.provider !== "x") throw new Error();
    let token = "";
    if (p.payload.media && !(p.receipt.mediaId && p.receipt.providerState === "MEDIA_READY")) {
      if (!media) throw new WorkspaceError(409, "social_media_changed");
      const info = p.payload.media; token = await auth(); guard();
      const init = socialOutput(z.object({ data: z.object({ id: numericId }) }), (await this.provider.api("x", "/2/media/upload/initialize", token, "POST",
        { media_type: info.mimeType, total_bytes: info.bytes, media_category: "tweet_video" }, signal, true)).value);
      p.receipt.mediaId = init.data.id; save();
      for (let offset = 0, segment = 0; offset < info.bytes; segment++) {
        const chunk = await media.read(offset, Math.min(4 * 1024 ** 2, info.bytes - offset));
        token = await auth(); guard();
        const form = new FormData(); form.set("segment_index", String(segment)); form.set("media", new Blob([new Uint8Array(chunk)], { type: "application/octet-stream" }), "chunk");
        await this.provider.request(`https://api.x.com/2/media/upload/${init.data.id}/append`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }, signal, true, false);
        offset += chunk.length; p.progress = offset / info.bytes * .85; save();
      }
      token = await auth(); guard();
      let status = socialOutput(z.object({ data: z.object({ processing_info: processing.optional() }) }),
        (await this.provider.api("x", `/2/media/upload/${init.data.id}/finalize`, token, "POST", undefined, signal, true)).value).data.processing_info;
      for (let check = 0; status && ["pending", "in_progress"].includes(status.state) && check < 12; check++) {
        p.receipt.providerState = status.state; save();
        await this.wait(Math.max(1, Math.min(status.check_after_secs ?? 2, 30)) * 1000, signal);
        status = socialOutput(z.object({ data: z.object({ processing_info: processing }) }),
          (await this.provider.api("x", `/2/media/upload?command=STATUS&media_id=${init.data.id}`, token, "GET", undefined, signal)).value).data.processing_info;
      }
      if (status?.state === "failed") throw new WorkspaceError(409, "social_processing_failed");
      if (status && status.state !== "succeeded") { p.state = "processing"; p.receipt.providerState = status.state; save(); return; }
    }
    token = await auth(true); guard();
    p.receipt.providerState = "POST_DISPATCHING"; save(); guard();
    const result = socialOutput(z.object({ data: z.object({ id: numericId }) }), (await this.provider.api("x", "/2/tweets", token, "POST", {
      text: m.text, paid_partnership: m.paidPartnership, made_with_ai: m.madeWithAi,
      ...(p.receipt.mediaId ? { media: { media_ids: [p.receipt.mediaId] } } : {})
    }, signal, true)).value);
    p.receipt.postIds = [result.data.id]; p.receipt.publicUrl = `https://x.com/i/web/status/${result.data.id}`;
    p.receipt.providerState = "POST_CREATED"; p.state = "succeeded"; p.progress = 1; save();
  }
  private async linkedin(p: SocialPost, media: SocialMediaSnapshot | null, auth: (publishing?: boolean) => Promise<string>, guard: () => void, signal: AbortSignal, save: () => void) {
    const m = p.payload.metadata; if (m.provider !== "linkedin") throw new Error();
    let token = "";
    if (p.payload.media && !(p.receipt.mediaId && p.receipt.providerState === "MEDIA_READY")) {
      if (!media) throw new WorkspaceError(409, "social_media_changed");
      const info = p.payload.media; token = await auth(); guard();
      const init = socialOutput(z.object({ value: z.object({ video: videoUrn, uploadToken: z.string().max(8192), uploadUrlsExpireAt: z.number().finite(),
        uploadInstructions: z.array(z.object({ firstByte: z.number().int().nonnegative(), lastByte: z.number().int().nonnegative(), uploadUrl: z.string().max(8192) })).min(1).max(2000) }) }),
        (await this.provider.api("linkedin", "/rest/videos?action=initializeUpload", token, "POST", { initializeUploadRequest: {
          owner: p.payload.target.destinationId, fileSizeBytes: info.bytes, uploadCaptions: false, uploadThumbnail: false
        } }, signal, true)).value).value;
      p.receipt.mediaId = init.video; save();
      const parts: string[] = []; let offset = 0;
      for (const instruction of init.uploadInstructions) {
        const length = instruction.lastByte - instruction.firstByte + 1;
        if (instruction.firstByte !== offset || length <= 0 || length > 8 * 1024 ** 2 || instruction.lastByte >= info.bytes) throw new SocialRemoteError(502, "social_invalid_response", true);
        const chunk = await media.read(offset, length); await auth(); guard();
        const result = await this.provider.request(socialUploadUrl("linkedin", instruction.uploadUrl), { method: "PUT", headers: {
          "Content-Type": "application/octet-stream", "Content-Length": String(length) }, body: new Uint8Array(chunk) }, signal, true, false);
        const tag = result.headers.get("etag");
        if (!tag || tag.length > 8192 || /[\r\n]/.test(tag)) throw new SocialRemoteError(502, "social_invalid_response", true);
        parts.push(tag.replace(/^"|"$/g, "")); offset += length; p.progress = offset / info.bytes * .85; save();
      }
      if (offset !== info.bytes) throw new SocialRemoteError(502, "social_invalid_response", true);
      token = await auth(); guard();
      await this.provider.api("linkedin", "/rest/videos?action=finalizeUpload", token, "POST", { finalizeUploadRequest: {
        video: init.video, uploadToken: init.uploadToken, uploadedPartIds: parts
      } }, signal, true, false);
      let state = "PROCESSING";
      for (let check = 0; check < 12; check++) {
        const video = socialOutput(z.object({ id: videoUrn, owner: z.string(), status: z.enum(["WAITING_UPLOAD", "PROCESSING", "AVAILABLE", "PROCESSING_FAILED"]) }),
          (await this.provider.api("linkedin", `/rest/videos/${encodeURIComponent(init.video)}`, token, "GET", undefined, signal)).value);
        if (video.id !== init.video || video.owner !== p.payload.target.destinationId) throw new SocialRemoteError(409, "social_destination_mismatch");
        state = video.status; p.receipt.providerState = state; save();
        if (state === "AVAILABLE" || state === "PROCESSING_FAILED") break;
        await this.wait(2000, signal);
      }
      if (state === "PROCESSING_FAILED") throw new WorkspaceError(409, "social_processing_failed");
      if (state !== "AVAILABLE") { p.state = "processing"; save(); return; }
    }
    token = await auth(true); guard();
    p.receipt.providerState = "POST_DISPATCHING"; save(); guard();
    const response = await this.provider.api("linkedin", "/rest/posts", token, "POST", {
      author: p.payload.target.destinationId, commentary: linkedinPlainText(m.text), visibility: m.visibility,
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: m.reshareDisabled,
      ...(p.receipt.mediaId ? { content: { media: { id: p.receipt.mediaId, title: m.title } } } : {})
    }, signal, true, false);
    const id = socialOutput(postUrn, response.headers.get("x-restli-id"));
    p.receipt.postIds = [id]; p.receipt.publicUrl = `https://www.linkedin.com/feed/update/${id}/`;
    p.receipt.providerState = "POST_ACCEPTED"; p.state = "accepted"; p.progress = 1; save();
  }
  private async tiktok(p: SocialPost, media: SocialMediaSnapshot | null, auth: (publishing?: boolean) => Promise<string>, guard: () => void, signal: AbortSignal, save: () => void) {
    const m = p.payload.metadata, info = p.payload.media;
    if (m.provider !== "tiktok" || !media || !info) throw new WorkspaceError(400, "social_media_required");
    const plan = tikTokChunkPlan(info.bytes); let token = await auth(true); guard();
    const init = socialOutput(z.object({ data: z.object({ publish_id: z.string().min(1).max(64), upload_url: z.string().max(8192) }) }),
      (await this.provider.api("tiktok", "/v2/post/publish/video/init/", token, "POST", {
        post_info: { title: m.text, privacy_level: m.privacy, disable_comment: !m.allowComment, disable_duet: !m.allowDuet, disable_stitch: !m.allowStitch,
          brand_content_toggle: m.brandedContent, brand_organic_toggle: m.ownBrand, is_aigc: m.madeWithAi },
        source_info: { source: "FILE_UPLOAD", video_size: info.bytes, chunk_size: plan.chunkSize, total_chunk_count: plan.count }
      }, signal, true)).value).data;
    p.receipt.jobId = init.publish_id; save();
    for (let i = 0, offset = 0; i < plan.count; i++) {
      const length = i === plan.count - 1 ? info.bytes - offset : plan.chunkSize;
      const chunk = await media.read(offset, length); token = await auth(i === plan.count - 1); guard();
      const r = await this.provider.request(socialUploadUrl("tiktok", init.upload_url), { method: "PUT", headers: {
        "Content-Type": info.mimeType, "Content-Length": String(length), "Content-Range": `bytes ${offset}-${offset + length - 1}/${info.bytes}`
      }, body: new Uint8Array(chunk) }, signal, true, false);
      if (r.status !== (i === plan.count - 1 ? 201 : 206)) throw new SocialRemoteError(502, "social_invalid_response", true);
      offset += length; p.progress = offset / info.bytes; save();
    }
    p.state = "processing"; p.receipt.providerState = "PROCESSING_UPLOAD"; save();
    await this.reconcile(p, token, [], signal, save);
  }
  async reconcile(p: SocialPost, token: string, scopes: string[], signal: AbortSignal, save: () => void): Promise<void> {
    const provider = p.payload.metadata.provider;
    if (provider === "tiktok" && p.receipt.jobId) {
      const data = socialOutput(z.object({ data: z.object({ status: z.enum(["PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD", "SEND_TO_USER_INBOX", "PUBLISH_COMPLETE", "FAILED"]),
        fail_reason: z.string().max(255).optional(), publicaly_available_post_id: z.array(z.union([numericId, z.number().int().safe().nonnegative().transform(String)])).max(100).optional(), uploaded_bytes: z.number().int().nonnegative().optional() }) }),
        (await this.provider.api("tiktok", "/v2/post/publish/status/fetch/", token, "POST", { publish_id: p.receipt.jobId }, signal)).value).data;
      p.receipt.providerState = data.status; p.receipt.postIds = data.publicaly_available_post_id ?? p.receipt.postIds;
      p.state = data.status === "PUBLISH_COMPLETE" ? "succeeded" : data.status === "FAILED" ? "failed" : "processing";
      // Never echo provider free text/fail_reason; remote strings are not trusted diagnostics.
      p.error = data.status === "FAILED" ? "social_processing_failed" : null; save(); return;
    }
    const postId = p.receipt.postIds[0];
    if (!postId && p.receipt.providerState === "POST_DISPATCHING") {
      p.state = "uncertain"; p.error = "social_receipt_missing"; save(); return;
    }
    if (provider === "x" && postId) {
      const data = socialOutput(z.object({ data: z.object({ id: numericId, author_id: numericId }) }),
        (await this.provider.api("x", `/2/tweets/${socialOutput(numericId, postId)}?tweet.fields=author_id,created_at`, token, "GET", undefined, signal)).value).data;
      if (data.id !== postId || data.author_id !== p.payload.target.destinationId) throw new WorkspaceError(409, "social_destination_mismatch");
      p.state = "succeeded"; p.error = null; p.receipt.providerState = "POST_VERIFIED"; save(); return;
    }
    if (provider === "linkedin" && postId) {
      const canRead = p.payload.target.destinationId.startsWith("urn:li:organization:") ? scopes.includes("r_organization_social") : scopes.includes("r_member_social");
      if (!canRead) { p.state = "accepted"; p.error = "social_readback_unavailable"; save(); return; }
      const data = socialOutput(z.object({ id: postUrn, author: z.string(), lifecycleState: z.enum(["DRAFT", "PUBLISH_REQUESTED", "PUBLISHED", "PUBLISH_FAILED"]) }),
        (await this.provider.api("linkedin", `/rest/posts/${encodeURIComponent(socialOutput(postUrn, postId))}?viewContext=AUTHOR`, token, "GET", undefined, signal)).value);
      if (data.id !== postId || data.author !== p.payload.target.destinationId) throw new WorkspaceError(409, "social_destination_mismatch");
      p.state = data.lifecycleState === "PUBLISHED" ? "succeeded" : data.lifecycleState === "PUBLISH_FAILED" ? "failed" : "processing";
      p.receipt.providerState = data.lifecycleState; p.error = p.state === "failed" ? "social_processing_failed" : null; save(); return;
    }
    if (p.receipt.mediaId && provider !== "tiktok") {
      if (provider === "x") {
        const data = socialOutput(z.object({ data: z.object({ processing_info: processing }) }),
          (await this.provider.api("x", `/2/media/upload?command=STATUS&media_id=${socialOutput(numericId, p.receipt.mediaId)}`, token, "GET", undefined, signal)).value).data;
        p.receipt.providerState = data.processing_info.state;
      } else {
        const data = socialOutput(z.object({ id: videoUrn, owner: z.string(), status: z.enum(["AVAILABLE", "WAITING_UPLOAD", "PROCESSING", "PROCESSING_FAILED"]) }),
          (await this.provider.api("linkedin", `/rest/videos/${encodeURIComponent(socialOutput(videoUrn, p.receipt.mediaId))}`, token, "GET", undefined, signal)).value);
        if (data.owner !== p.payload.target.destinationId || data.id !== p.receipt.mediaId) throw new WorkspaceError(409, "social_destination_mismatch");
        p.receipt.providerState = data.status;
      }
      const state = p.receipt.providerState;
      p.state = ["succeeded", "AVAILABLE"].includes(state ?? "") ? "accepted" : ["failed", "PROCESSING_FAILED"].includes(state ?? "") ? "failed" : "uncertain";
      p.error = p.state === "accepted" ? "social_media_ready_reapproval_required" : p.state === "failed" ? "social_processing_failed" : "social_upload_uncertain";
      if (p.state === "accepted") p.receipt.providerState = "MEDIA_READY";
      save(); return;
    }
    p.state = "uncertain"; p.error = "social_receipt_missing"; save();
  }
}
