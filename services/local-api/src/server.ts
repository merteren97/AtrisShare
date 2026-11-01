import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { z, ZodError } from "zod";
import {
  APP_VERSION, contextSchema, createAccountSchema, createMemorySchema, createProjectSchema,
  deleteMemorySchema, idSchema, updateMemorySchema, type VaultStatus, type WorkspaceContext
} from "../../../packages/domain/src/workspace.js";
import { resolveDataDirectory, WorkspaceError } from "../../../packages/storage/src/config.js";
import { WorkspaceStore } from "../../../packages/storage/src/store.js";
import { createCredentialVault, type CredentialVault } from "../../../packages/storage/src/vault.js";
import { startYouTubeSchema, youtubeAccountSchema } from "../../../packages/domain/src/youtube.js";
import { YouTubeService, type YouTubeOptions } from "./youtube.js";
import { StudioService, type StudioOptions } from "./studio.js";
import { publicationInputSchema, studioContextSchema } from "../../../packages/domain/src/studio.js";
import { editSchema } from "../../../packages/domain/src/media.js";
import { aiRequestSchema, aiScopeSchema } from "../../../packages/domain/src/ai.js";
import { AiService, type AiOptions } from "./ai.js";
import { TranscriptionService, type TranscriptionOptions } from "./transcription.js";
import { googleDesktopClientSchema } from "./youtube-provider.js";

export interface ApiOptions {
  dataDirectory?: string;
  token?: string;
  port?: number;
  allowedOrigins?: string[];
  /** Only used by tests that intentionally exercise unavailable vault behavior. */
  vaultStatus?: VaultStatus;
  /** Internal integration-test dependencies, not HTTP/runtime configuration. */
  credentialVault?: CredentialVault;
  youtube?: YouTubeOptions;
  studio?: StudioOptions;
  ai?: AiOptions;
  transcription?: TranscriptionOptions;
}
export const NATIVE_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
const MAX_BODY = 32 * 1024;
async function body(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
  if (contentType !== "application/json") throw new WorkspaceError(415, "json_required");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    request.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BODY) { chunks.length = 0; reject(new WorkspaceError(413, "body_too_large")); }
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (length > MAX_BODY) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
      catch { reject(new WorkspaceError(400, "invalid_json")); }
    });
    request.on("error", () => reject(new WorkspaceError(400, "invalid_request")));
    request.on("aborted", () => reject(new WorkspaceError(400, "invalid_request")));
  });
}
function queryContext(url: URL): WorkspaceContext {
  if (!url.searchParams.has("accountId") || !url.searchParams.has("projectId")) throw new WorkspaceError(400, "context_required");
  return contextSchema.parse({ accountId: url.searchParams.get("accountId"), projectId: url.searchParams.get("projectId") || null });
}

export async function startApi(options: ApiOptions = {}) {
  const directory = resolveDataDirectory(options.dataDirectory);
  const token = options.token ?? randomBytes(32).toString("hex");
  if (token.length < 32) throw new Error("Runtime token is too short");
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const allowedOrigins = new Set(options.allowedOrigins ?? NATIVE_ORIGINS);
  const credentialVault: CredentialVault = options.credentialVault ?? (options.vaultStatus ? {
    status: options.vaultStatus,
    async get() { throw new Error("Vault unavailable"); }, async set() { throw new Error("Vault unavailable"); }, async delete() { throw new Error("Vault unavailable"); }
  } : await createCredentialVault(directory));
  const vault = credentialVault.status;
  const store = new WorkspaceStore(join(directory, "atris-share.sqlite"));
  const youtube = new YouTubeService(store, credentialVault, options.youtube);
  await youtube.loadLocalClient();
  const studio = new StudioService(store, youtube, credentialVault, directory, options.studio);
  const transcription = new TranscriptionService(store, studio, options.transcription);
  const ai = new AiService(store, studio, { ...options.ai, transcription });
  let origin = "";
  let closePromise: Promise<void> | undefined;
  const send = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  };
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    const handle = async () => {
      if (closePromise) throw new WorkspaceError(503, "runtime_closing");
      if (request.headers.host !== new URL(origin).host) throw new WorkspaceError(403, "host_forbidden");
      const requestOrigin = request.headers.origin;
      if (requestOrigin && !allowedOrigins.has(requestOrigin)) throw new WorkspaceError(403, "origin_forbidden");
      if (requestOrigin) {
        response.setHeader("Access-Control-Allow-Origin", requestOrigin);
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        response.writeHead(204); response.end(); return;
      }
      const url = new URL(request.url ?? "/", origin);
      // The sole unauthenticated callback uses one-use PKCE/state, not the runtime
      // bearer token. No arbitrary redirect, token response or caller text is rendered.
      if (request.method === "GET" && url.pathname === "/oauth/youtube/callback") {
        await youtube.callback(url.searchParams, origin);
        response.writeHead(303, { Location: "/oauth/youtube/result" }); response.end(); return;
      }
      if (request.method === "GET" && url.pathname === "/oauth/youtube/result") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
        response.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AtrisShare — YouTube</title><h1>AtrisShare</h1><p>Return to AtrisShare to see the connection result. You may close this tab.</p><p lang="tr">Bağlantı sonucunu görmek için AtrisShare’e dönün. Bu sekmeyi kapatabilirsiniz.</p></html>'); return;
      }
      if ([...url.searchParams.keys()].some(key => /token|secret|authorization/i.test(key) &&
        !(key === "pageToken" && url.pathname === "/api/youtube/catalog"))) throw new WorkspaceError(400, "credentials_in_url");
      // A short-lived MCP capability is accepted only on this dedicated surface.
      // It is never the desktop session bearer and grants no approval/vault access.
      if (url.pathname.startsWith("/api/mcp/")) {
        if (request.method === "GET" && url.pathname === "/api/mcp/capabilities") send(response, 200, ai.capabilities(request.headers.authorization ?? ""));
        else if (request.method === "POST" && url.pathname === "/api/mcp/call") send(response, 200, await ai.call(request.headers.authorization ?? "", await body(request)));
        else throw new WorkspaceError(404, "not_found");
        return;
      }
      const received = createHash("sha256").update(request.headers.authorization ?? "").digest();
      if (!timingSafeEqual(received, expected)) throw new WorkspaceError(401, "unauthorized");
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /api/workspace") {
        const context = store.getContext();
        send(response, 200, { accounts: store.listAccounts(), context, projects: context ? store.listProjects(context.accountId) : [],
          vault, dataDirectory: directory, version: APP_VERSION });
      } else if (route === "POST /api/accounts") {
        send(response, 201, store.createAccount(createAccountSchema.parse(await body(request))));
      } else if (route === "GET /api/youtube") {
        send(response, 200, youtube.setup());
      } else if (route === "POST /api/youtube/config") {
        send(response, 200, await youtube.configure(googleDesktopClientSchema.parse(await body(request))));
      } else if (route === "POST /api/youtube/sessions") {
        send(response, 201, await youtube.start(startYouTubeSchema.parse(await body(request)), origin));
      } else if (request.method === "GET" && /^\/api\/youtube\/sessions\/[^/]+$/.test(url.pathname)) {
        send(response, 200, youtube.status(idSchema.parse(url.pathname.split("/").at(-1))));
      } else if (request.method === "POST" && /^\/api\/youtube\/sessions\/[^/]+\/(cancel|open)$/.test(url.pathname)) {
        const id = idSchema.parse(url.pathname.split("/").at(-2));
        send(response, 200, url.pathname.endsWith("/cancel") ? youtube.cancel(id) : await youtube.reopen(id));
      } else if (route === "POST /api/youtube/verify") {
        send(response, 200, await youtube.verify(youtubeAccountSchema.parse(await body(request))));
      } else if (route === "POST /api/youtube/disconnect") {
        const input = youtubeAccountSchema.extend({ revoke: z.boolean() }).strict().parse(await body(request));
        send(response, 200, await youtube.disconnect({ accountId: input.accountId, destinationId: input.destinationId }, input.revoke));
      } else if (route === "GET /api/studio") {
        send(response, 200, await studio.snapshot(queryContext(url)));
      } else if (route === "GET /api/ai/setup") {
        send(response, 200, await ai.setup());
      } else if (route === "GET /api/ai/runs") {
        send(response, 200, ai.runs(idSchema.parse(url.searchParams.get("artifactId")), queryContext(url)));
      } else if (route === "POST /api/ai/runs") {
        send(response, 202, await ai.start(aiRequestSchema.parse(await body(request))));
      } else if (route === "POST /api/ai/grants") {
        const input = aiScopeSchema.extend({ includeMemory: z.boolean(), includeTranscript: z.boolean().default(false) }).strict().parse(await body(request));
        send(response, 201, ai.createGrant(input, origin));
      } else if (route === "POST /api/ai/grants/revoke") {
        const input = z.object({ context: studioContextSchema, token: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await body(request));
        send(response, 200, ai.revokeGrant(input.token, input.context));
      } else if (request.method === "POST" && /^\/api\/ai\/runs\/[^/]+\/(accept|reject|cancel|preview)$/.test(url.pathname)) {
        const id = idSchema.parse(url.pathname.split("/")[4]);
        const input = z.object({ context: studioContextSchema }).strict().parse(await body(request));
        if (url.pathname.endsWith("/cancel")) send(response, 200, await ai.cancel(id, input.context));
        else if (url.pathname.endsWith("/preview")) send(response, 202, ai.preview(id, input.context));
        else send(response, 200, await ai.review(id, input.context, url.pathname.endsWith("/accept") ? "accept" : "reject"));
      } else if (route === "POST /api/media/import") {
        if (Number(request.headers["content-length"] ?? 0) > 2 * 1024 ** 3) throw new WorkspaceError(413, "body_too_large");
        const filename = z.string().min(1).max(240).parse(url.searchParams.get("filename"));
        const abort = new AbortController(); const cancelled = () => abort.abort();
        request.on("aborted", cancelled); response.on("close", cancelled);
        request.setTimeout(120_000, cancelled);
        try { send(response, 201, await studio.import(queryContext(url), request, filename, abort.signal)); }
        finally { request.off("aborted", cancelled); response.off("close", cancelled); }
      } else if (route === "GET /api/transcription/setup") {
        send(response, 200, await transcription.setup());
      } else if (request.method === "POST" && /^\/api\/media\/[^/]+\/transcribe$/.test(url.pathname)) {
        const input = z.object({ context: studioContextSchema }).strict().parse(await body(request));
        send(response, 202, await transcription.start(idSchema.parse(url.pathname.split("/")[3]), input.context));
      } else if (request.method === "GET" && /^\/api\/media\/[^/]+\/transcript$/.test(url.pathname)) {
        send(response, 200, transcription.latest(idSchema.parse(url.pathname.split("/")[3]), queryContext(url)));
      } else if (request.method === "POST" && /^\/api\/transcripts\/[^/]+\/cancel$/.test(url.pathname)) {
        const input = z.object({ context: studioContextSchema }).strict().parse(await body(request));
        send(response, 200, await transcription.cancel(idSchema.parse(url.pathname.split("/")[3]), input.context));
      } else if (request.method === "GET" && /^\/api\/media\/[^/]+\/content$/.test(url.pathname)) {
        const artifact = store.studio.artifact(idSchema.parse(url.pathname.split("/")[3]), queryContext(url));
        // No bearer-bearing URLs. Browser playback uses a bounded authenticated Blob.
        if (artifact.bytes > 256 * 1024 ** 2) throw new WorkspaceError(413, "studio_blob_limit");
        response.writeHead(200, { "Content-Type": artifact.mimeType, "Content-Length": artifact.bytes, "Content-Disposition": "inline" });
        await pipeline(createReadStream(studio.engine.path(artifact.id)), response);
      } else if (route === "GET /api/youtube/catalog") {
        send(response, 200, await studio.catalog(idSchema.parse(url.searchParams.get("accountId")),
          z.string().parse(url.searchParams.get("destinationId")), z.string().max(4096).nullable().parse(url.searchParams.get("pageToken"))));
      } else if (request.method === "POST" && /^\/api\/media\/[^/]+\/link$/.test(url.pathname)) {
        const input = z.object({ context: studioContextSchema, videoId: z.string().regex(/^[\w-]{11}$/) }).strict().parse(await body(request));
        send(response, 200, await studio.link(idSchema.parse(url.pathname.split("/")[3]), input.context, input.videoId));
      } else if (/^\/api\/media\/[^/]+\/timeline(?:\/(undo|redo))?$/.test(url.pathname)) {
        const id = idSchema.parse(url.pathname.split("/")[3]);
        if (request.method === "GET" && url.pathname.endsWith("/timeline")) send(response, 200, store.studio.timeline(id, queryContext(url)));
        else if (request.method === "PUT" && url.pathname.endsWith("/timeline")) {
          const input = z.object({ context: studioContextSchema, expectedRevision: z.number().int().nonnegative(), edit: editSchema }).strict().parse(await body(request));
          send(response, 200, store.studio.edit(id, input.context, input.expectedRevision, input.edit));
        } else if (request.method === "POST" && /\/(undo|redo)$/.test(url.pathname)) {
          const input = z.object({ context: studioContextSchema, expectedRevision: z.number().int().nonnegative() }).strict().parse(await body(request));
          send(response, 200, store.studio.edit(id, input.context, input.expectedRevision, undefined, url.pathname.endsWith("/undo") ? "undo" : "redo"));
        } else throw new WorkspaceError(405, "method_not_allowed");
      } else if (request.method === "POST" && /^\/api\/media\/[^/]+\/proxy$/.test(url.pathname)) {
        const input = z.object({ context: studioContextSchema }).strict().parse(await body(request));
        send(response, 202, studio.proxy(idSchema.parse(url.pathname.split("/")[3]), input.context));
      } else if (request.method === "POST" && /^\/api\/media\/[^/]+\/render$/.test(url.pathname)) {
        const input = z.object({ context: studioContextSchema, expectedRevision: z.number().int().nonnegative() }).strict().parse(await body(request));
        send(response, 202, studio.render(idSchema.parse(url.pathname.split("/")[3]), input.context, input.expectedRevision));
      } else if (request.method === "POST" && /^\/api\/renders\/[^/]+\/cancel$/.test(url.pathname)) {
        const input = z.object({ context: studioContextSchema }).strict().parse(await body(request));
        send(response, 200, studio.cancelRender(idSchema.parse(url.pathname.split("/")[3]), input.context));
      } else if (route === "POST /api/publications") {
        send(response, 201, await studio.create(publicationInputSchema.parse(await body(request))));
      } else if (request.method === "POST" && /^\/api\/publications\/[^/]+\/(approve|cancel|reconcile)$/.test(url.pathname)) {
        const id = idSchema.parse(url.pathname.split("/")[3]);
        if (url.pathname.endsWith("/approve")) {
          const input = z.object({ context: studioContextSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await body(request));
          send(response, 202, studio.approve(id, input.context, input.digest));
        } else {
          const input = z.object({ context: studioContextSchema }).strict().parse(await body(request));
          send(response, 202, url.pathname.endsWith("/cancel") ? studio.cancel(id, input.context) : studio.reconcile(id, input.context));
        }
      } else if (route === "PUT /api/context") {
        send(response, 200, store.setContext(contextSchema.parse(await body(request))));
      } else if (route === "GET /api/projects") {
        send(response, 200, store.listProjects(idSchema.parse(url.searchParams.get("accountId"))));
      } else if (route === "POST /api/projects") {
        send(response, 201, store.createProject(createProjectSchema.parse(await body(request))));
      } else if (route === "GET /api/memory") {
        send(response, 200, store.listMemory(queryContext(url)));
      } else if (route === "POST /api/memory") {
        send(response, 201, store.createMemory(createMemorySchema.parse(await body(request))));
      } else if (request.method === "PATCH" && /^\/api\/memory\/[^/]+$/.test(url.pathname)) {
        send(response, 200, store.updateMemory(idSchema.parse(url.pathname.split("/").at(-1)), updateMemorySchema.parse(await body(request))));
      } else if (request.method === "DELETE" && /^\/api\/memory\/[^/]+$/.test(url.pathname)) {
        const input = deleteMemorySchema.parse(await body(request));
        store.deleteMemory(idSchema.parse(url.pathname.split("/").at(-1)), input.context, input.expectedRevision);
        send(response, 200, { deleted: true });
      } else if (route === "GET /api/audit") {
        send(response, 200, store.listAudit(queryContext(url)));
      } else if (route === "POST /api/internal/shutdown") {
        send(response, 200, { stopped: true });
        setImmediate(() => { void close(); });
      } else throw new WorkspaceError(404, "not_found");
    };
    void handle().catch(error => {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof WorkspaceError) send(response, error.status, { error: error.code });
      else if (error instanceof ZodError) send(response, 400, { error: "invalid_input" });
      else send(response, 500, { error: "operation_failed" });
    });
  });
   server.requestTimeout = 30 * 60_000; // bounded 2 GiB media streaming; JSON keeps its small size limit.
  server.headersTimeout = 10_000;
  function close(): Promise<void> {
    closePromise ??= Promise.all([ai.close(), transcription.close(), studio.close(), youtube.close()]).then(() => new Promise<void>((resolve, reject) => {
      server.close(error => { store.close(); if (error) reject(error); else resolve(); });
      server.closeIdleConnections();
    }));
    return closePromise;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") { reject(new Error("No loopback address")); return; }
        origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  } catch (error) { store.close(); throw error; }
  return { origin, token, close, server };
}
