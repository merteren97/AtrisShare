import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { ZodError } from "zod";
import {
  APP_VERSION, contextSchema, createAccountSchema, createMemorySchema, createProjectSchema,
  deleteMemorySchema, idSchema, updateMemorySchema, type VaultStatus, type WorkspaceContext
} from "../../../packages/domain/src/workspace.js";
import { resolveDataDirectory, WorkspaceError } from "../../../packages/storage/src/config.js";
import { WorkspaceStore } from "../../../packages/storage/src/store.js";
import { createCredentialVault } from "../../../packages/storage/src/vault.js";

export interface ApiOptions {
  dataDirectory?: string;
  token?: string;
  port?: number;
  allowedOrigins?: string[];
  /** Only used by tests that intentionally exercise unavailable vault behavior. */
  vaultStatus?: VaultStatus;
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
  const vault = options.vaultStatus ?? (await createCredentialVault(directory)).status;
  const store = new WorkspaceStore(join(directory, "atris-share.sqlite"));
  let origin = "";
  let closePromise: Promise<void> | undefined;
  const send = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  };
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const handle = async () => {
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
      if ([...url.searchParams.keys()].some(key => /token|secret|authorization/i.test(key))) throw new WorkspaceError(400, "credentials_in_url");
      const received = createHash("sha256").update(request.headers.authorization ?? "").digest();
      if (!timingSafeEqual(received, expected)) throw new WorkspaceError(401, "unauthorized");
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /api/workspace") {
        const context = store.getContext();
        send(response, 200, { accounts: store.listAccounts(), context, projects: context ? store.listProjects(context.accountId) : [],
          vault, dataDirectory: directory, version: APP_VERSION });
      } else if (route === "POST /api/accounts") {
        send(response, 201, store.createAccount(createAccountSchema.parse(await body(request))));
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
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  function close(): Promise<void> {
    closePromise ??= new Promise<void>((resolve, reject) => {
      server.close(error => { store.close(); if (error) reject(error); else resolve(); });
      server.closeIdleConnections();
    });
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
