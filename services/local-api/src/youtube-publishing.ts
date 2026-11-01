import { z } from "zod";
import { channelIdSchema } from "../../../packages/domain/src/youtube.js";
import { WorkspaceError } from "../../../packages/storage/src/config.js";

export type UploadReply = { state: "incomplete"; offset: number } | { state: "complete"; videoId: string } | { state: "missing" };
const API = "https://www.googleapis.com/youtube/v3/";
const MAX_JSON = 1024 * 1024;
const videoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const pageTokenSchema = z.string().min(1).max(4096);
const timestampSchema = z.string().datetime({ offset: true });
const metadataSchema = z.object({
  title: z.string().min(1).max(100).refine(value => value.trim().length > 0 && !/[<>]/.test(value)),
  description: z.string().max(5000).refine(value => !/[<>]/.test(value)),
  visibility: z.enum(["private", "unlisted", "public"]), madeForKids: z.boolean(), notifySubscribers: z.boolean()
}).strict();
type Metadata = z.infer<typeof metadataSchema>;
const catalogSchema = z.object({
  items: z.array(z.object({
    snippet: z.object({ channelId: channelIdSchema, videoOwnerChannelId: channelIdSchema.optional(),
      title: z.string().max(1000), publishedAt: timestampSchema.optional(),
      thumbnails: z.record(z.string(), z.object({ url: z.string().max(4096) })).optional() }),
    contentDetails: z.object({ videoId: videoIdSchema, videoPublishedAt: timestampSchema.optional() })
  })).max(50), nextPageToken: pageTokenSchema.optional()
});

function invalid(): never { throw new WorkspaceError(502, "youtube_invalid_response"); }
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WorkspaceError(400, "youtube_invalid_request");
  return parsed.data;
}
function output<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : invalid();
}
function size(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new WorkspaceError(400, "youtube_invalid_request");
}
function session(value: string): string {
  // Check the original spelling as well as parsed components: no URL normalization,
  // credentials, ports, fragments, alternate paths, or extra/duplicate parameters.
  try {
    if (value.length > 8192 || !/^https:\/\/(www|youtube)\.googleapis\.com\/upload\/youtube\/v3\/videos\?[^#\s\\]+$/.test(value)) throw new Error();
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 2 || !keys.includes("uploadType") || !keys.includes("upload_id") ||
        url.searchParams.get("uploadType") !== "resumable" ||
        !/^[A-Za-z0-9_.~-]{1,4096}$/.test(url.searchParams.get("upload_id") ?? "")) throw new Error();
    return value;
  } catch { throw new WorkspaceError(502, "youtube_invalid_session"); }
}
function thumbnail(thumbnails: Record<string, { url: string }> | undefined): string | null {
  for (const key of ["medium", "default", "high", "standard", "maxres"]) {
    const value = thumbnails?.[key]?.url;
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
          (url.hostname === "i.ytimg.com" || url.hostname.endsWith(".ytimg.com") || url.hostname === "img.youtube.com")) return url.href;
    } catch { /* A thumbnail is optional; never pass an unsafe URL to the UI. */ }
  }
  return null;
}

/** Official API transport only; tokens/session URLs stay inside the local runtime. No automatic retries. */
export class YouTubePublishing {
  constructor(private readonly transport: typeof fetch = fetch) {}
  async verifyVideo(token: string, destinationId: string, videoId: string, signal: AbortSignal): Promise<void> {
    input(channelIdSchema, destinationId); input(videoIdSchema, videoId);
    const query = new URLSearchParams({ part: "snippet", id: videoId });
    await this.request(`${API}videos?${query}`, token, {}, signal, false, async (response, bounded) => {
      await this.check(response);
      const value = output(z.object({ items: z.array(z.object({ id: videoIdSchema, snippet: z.object({ channelId: channelIdSchema }) })).length(1) }), await this.json(response, bounded));
      if (value.items[0]!.id !== videoId || value.items[0]!.snippet.channelId !== destinationId) throw new WorkspaceError(409, "youtube_channel_mismatch");
    });
  }
  private async request<T>(url: string, token: string, init: RequestInit, signal: AbortSignal,
    uncertain: boolean, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    try {
      bounded.throwIfAborted();
      const response = await this.transport(url, { ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` }, redirect: "error", signal: bounded });
      // Also reject synthetic/manual redirect responses; 308 is a resumable receipt,
      // not permission to follow a Location header.
      if (response.redirected || (response.status >= 300 && response.status < 400 && response.status !== 308)) {
        await response.body?.cancel().catch(() => undefined);
        throw new WorkspaceError(502, "youtube_redirect_rejected");
      }
      const result = await consume(response, bounded);
      bounded.throwIfAborted();
      return result;
    } catch (error) {
      if (!bounded.aborted && error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(502, uncertain ? "youtube_upload_uncertain" : "youtube_unavailable");
    }
  }
  private async json(response: Response, signal: AbortSignal): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) return invalid();
    const chunks: Uint8Array[] = [];
    let length = 0;
    const abort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const declared = response.headers.get("Content-Length");
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON)) return invalid();
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        length += value.length;
        if (length > MAX_JSON) return invalid();
        chunks.push(value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
      catch { return invalid(); }
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => undefined);
    }
  }
  private async check(response: Response, uncertain = false): Promise<void> {
    if (response.ok) return;
    // Do not parse or echo provider error messages (which may contain credentials,
    // metadata, or session URLs). Status alone maps to a bounded local code.
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) throw new WorkspaceError(409, "youtube_reauth_required");
    if (response.status === 403) throw new WorkspaceError(403, "youtube_access_denied");
    if (response.status === 429) throw new WorkspaceError(429, "youtube_rate_limited");
    if (uncertain && (response.status === 408 || response.status >= 500)) throw new WorkspaceError(502, "youtube_upload_uncertain");
    throw new WorkspaceError(502, "youtube_request_failed");
  }
  async catalog(token: string, destinationId: string, pageToken: string | null, signal: AbortSignal): Promise<{
    items: { id: string; title: string; publishedAt: string; thumbnail: string | null }[]; nextPageToken: string | null
  }> {
    input(channelIdSchema, destinationId);
    if (pageToken !== null) input(pageTokenSchema, pageToken);
    const query = new URLSearchParams({ part: "contentDetails", id: destinationId, maxResults: "1" });
    const playlist = await this.request(`${API}channels?${query}`, token, {}, signal, false, async (response, bounded) => {
      await this.check(response);
      const channels = output(z.object({ items: z.array(z.object({ id: channelIdSchema,
        contentDetails: z.object({ relatedPlaylists: z.object({ uploads: z.string().regex(/^[A-Za-z0-9_-]{1,150}$/) }) })
      })).length(1), nextPageToken: z.string().optional() }), await this.json(response, bounded));
      const channel = channels.items[0]!;
      if (channel.id !== destinationId || channels.nextPageToken) return invalid();
      return channel.contentDetails.relatedPlaylists.uploads;
    });
    const list = new URLSearchParams({ part: "snippet,contentDetails", playlistId: playlist, maxResults: "50",
      ...(pageToken === null ? {} : { pageToken }) });
    return this.request(`${API}playlistItems?${list}`, token, {}, signal, false, async (response, bounded) => {
      await this.check(response);
      const result = output(catalogSchema, await this.json(response, bounded));
      return { items: result.items.filter(item => item.snippet.channelId === destinationId &&
        item.snippet.videoOwnerChannelId === destinationId && item.contentDetails.videoPublishedAt !== undefined)
        .map(item => ({ id: item.contentDetails.videoId, title: item.snippet.title,
          publishedAt: item.contentDetails.videoPublishedAt!, thumbnail: thumbnail(item.snippet.thumbnails) })),
      nextPageToken: result.nextPageToken ?? null };
    });
  }
  async initiate(token: string, metadata: Metadata, bytes: number, mimeType: string, signal: AbortSignal): Promise<string> {
    const value = input(metadataSchema, metadata);
    size(bytes);
    if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeType) || mimeType.length > 150) {
      throw new WorkspaceError(400, "youtube_invalid_request");
    }
    const query = new URLSearchParams({ uploadType: "resumable", part: "snippet,status", notifySubscribers: String(value.notifySubscribers) });
    return this.request(`https://www.googleapis.com/upload/youtube/v3/videos?${query}`, token, { method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(bytes), "X-Upload-Content-Type": mimeType },
      body: JSON.stringify({ snippet: { title: value.title, description: value.description },
        status: { privacyStatus: value.visibility, selfDeclaredMadeForKids: value.madeForKids } })
    }, signal, true, async response => {
      await this.check(response, true);
      await response.body?.cancel().catch(() => undefined);
      if (response.status !== 200 && response.status !== 201) return invalid();
      return session(response.headers.get("Location") ?? "");
    });
  }
  private async reply(response: Response, total: number, signal: AbortSignal): Promise<UploadReply> {
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined);
      return { state: "missing" };
    }
    if (response.status === 308) {
      await response.body?.cancel().catch(() => undefined);
      const range = response.headers.get("Range");
      if (range === null) return { state: "incomplete", offset: 0 };
      const match = /^bytes=0-(0|[1-9]\d*)$/.exec(range);
      if (!match) return invalid();
      const offset = Number(match[1]) + 1;
      if (!Number.isSafeInteger(offset) || offset <= 0 || offset > total) return invalid();
      return { state: "incomplete", offset };
    }
    await this.check(response, true);
    if (response.status !== 200 && response.status !== 201) return invalid();
    const result = output(z.object({ id: videoIdSchema }), await this.json(response, signal));
    return { state: "complete", videoId: result.id };
  }
  async query(token: string, sessionUrl: string, bytes: number, signal: AbortSignal): Promise<UploadReply> {
    const url = session(sessionUrl);
    size(bytes);
    return this.request(url, token, { method: "PUT", headers: { "Content-Length": "0", "Content-Range": `bytes */${bytes}` } },
      signal, true, (response, bounded) => this.reply(response, bytes, bounded));
  }
  async upload(token: string, sessionUrl: string, buffer: Buffer, offset: number, total: number, signal: AbortSignal): Promise<UploadReply> {
    const url = session(sessionUrl);
    size(total);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || !Number.isSafeInteger(offset) || offset < 0 ||
        offset >= total || buffer.length > total - offset) throw new WorkspaceError(400, "youtube_invalid_request");
    // A Uint8Array copy is a DOM-compatible BodyInit with no shared backing buffer.
    return this.request(url, token, { method: "PUT", body: new Uint8Array(buffer),
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(buffer.length),
        "Content-Range": `bytes ${offset}-${offset + buffer.length - 1}/${total}` }
    }, signal, true, (response, bounded) => this.reply(response, total, bounded));
  }
  async processing(token: string, videoId: string, signal: AbortSignal): Promise<{ state: "processing" | "succeeded" | "failed"; url: string }> {
    input(videoIdSchema, videoId);
    const query = new URLSearchParams({ part: "processingDetails,status", id: videoId });
    return this.request(`${API}videos?${query}`, token, {}, signal, false, async (response, bounded) => {
      await this.check(response);
      const result = output(z.object({ items: z.array(z.object({ id: videoIdSchema,
        processingDetails: z.object({ processingStatus: z.enum(["processing", "succeeded", "failed", "terminated"]) }).optional(),
        status: z.object({ uploadStatus: z.enum(["uploaded", "processed", "failed", "rejected", "deleted"]) })
      })).max(1) }), await this.json(response, bounded));
      const video = result.items[0];
      if (video && video.id !== videoId) return invalid();
      const processing = video?.processingDetails?.processingStatus;
      const failed = !video || ["failed", "terminated"].includes(processing ?? "") || ["failed", "rejected", "deleted"].includes(video.status.uploadStatus);
      return { state: failed ? "failed" : processing === "succeeded" ? "succeeded" : "processing",
        url: `https://www.youtube.com/watch?v=${videoId}` };
    });
  }
}
