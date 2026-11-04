import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { editSchema } from "../../../packages/domain/src/media.js";
import { APP_VERSION } from "../../../packages/domain/src/workspace.js";
import { sequenceOperationSchema } from "../../../packages/domain/src/sequence.js";

const RESPONSE_LIMIT = 1024 * 1024;
const HTTP_TIMEOUT_MS = 30_000;
const emptyArguments = z.object({}).strict();
const toolSchemas = {
  sequence_sources: emptyArguments,
  sequence_read: emptyArguments,
  sequence_propose: z.object({expectedRevision:z.number().int().nonnegative(),summary:z.string().min(1).max(2000),operations:z.array(sequenceOperationSchema).min(1).max(128)}).strict(),
  sequence_preview: z.object({proposalId:z.string().uuid()}).strict(),
  sequence_render_status: z.object({jobId:z.string().uuid()}).strict(),
  sequence_render_cancel: z.object({jobId:z.string().uuid()}).strict(),
  sequence_export: z.object({expectedRevision:z.number().int().nonnegative()}).strict(),
  media_inspect: emptyArguments,
  timeline_read: emptyArguments,
  memory_read: emptyArguments,
  media_transcribe: emptyArguments,
  transcript_status: emptyArguments,
  transcript_read: z.object({ offset: z.number().int().min(0).max(10_000).default(0), limit: z.number().int().min(1).max(100).default(100) }).strict(),
  transcript_cancel: z.object({ transcriptId: z.string().uuid() }).strict(),
  timeline_propose: z.object({
    summary: z.string().min(1).max(2000),
    baseRevision: z.number().int().nonnegative(),
    edit: editSchema
  }).strict(),
  render_preview: z.object({ proposalId: z.string().uuid() }).strict(),
  render_status: z.object({ renderId: z.string().uuid() }).strict(),
  publication_request: z.object({
    title: z.string().min(1).max(100),
    description: z.string().max(5000),
    visibility: z.enum(["private", "unlisted", "public"]),
    madeForKids: z.boolean(),
    notifySubscribers: z.boolean()
  }).strict()
};
type ToolName = keyof typeof toolSchemas;

const capabilitiesSchema = z.object({
  tools: z.array(z.string().min(1).max(100)).max(100),
  expiresAt: z.string().datetime({ offset: true }),
  scope: z.object({
    accountId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    artifactId: z.string().min(1).max(200).optional(),
    sequenceId: z.string().uuid().optional(), sourceIds:z.array(z.string().uuid()).max(128).optional(),
    destinationId: z.string().min(1).max(200)
  }).strict(),
  includeMemory: z.boolean(), includeTranscript: z.boolean().default(false)
}).strict().refine(value=>Boolean(value.scope.artifactId)!==Boolean(value.scope.sequenceId&&value.scope.sourceIds?.length),"Explicit artifact or sequence capability required");

type ErrorCode = "mcp_invalid_configuration" | "mcp_capabilities_invalid" | "mcp_grant_expired"
  | "mcp_grant_rejected" | "mcp_http_error" | "mcp_http_timeout" | "mcp_response_limit"
  | "mcp_response_invalid" | "mcp_tool_unavailable" | "mcp_invalid_arguments" | "mcp_closed"
  | "mcp_start_failed";

class McpFailure extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}

function errorCode(error: unknown): ErrorCode {
  return error instanceof McpFailure ? error.code : "mcp_start_failed";
}

function toolError(code: ErrorCode): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: code }) }], isError: true };
}

function configuration(env: NodeJS.ProcessEnv): { origin: string; grant: string } {
  const origin = env.ATRIS_SHARE_MCP_ORIGIN;
  const grant = env.ATRIS_SHARE_MCP_GRANT;
  // Match the original string: URL normalization must not admit alternate hosts,
  // credentials, a trailing slash, encoded paths, queries or fragments.
  if (!origin || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(origin)
    || Number(origin.slice(origin.lastIndexOf(":") + 1)) > 65535
    || !grant || !/^[a-fA-F0-9]{64}$/u.test(grant)) {
    throw new McpFailure("mcp_invalid_configuration");
  }
  return { origin, grant };
}

/** Grant-only HTTP boundary; response bodies and remote error messages are never logged. */
class GrantApi {
  constructor(private readonly origin: string, private readonly grant: string,
    private readonly lifetime: AbortSignal) {}

  async request(path: "/api/mcp/capabilities" | "/api/mcp/call", body?: object,
    cancelled?: AbortSignal): Promise<z.infer<ReturnType<typeof z.json>>> {
    const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
    const signal = AbortSignal.any([this.lifetime, timeout, ...(cancelled ? [cancelled] : [])]);
    let response: Response | undefined;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${this.grant}`, Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal
      });
      if (response.status === 401 || response.status === 403) throw new McpFailure("mcp_grant_rejected");
      if (!response.ok) throw new McpFailure("mcp_http_error");
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > RESPONSE_LIMIT) throw new McpFailure("mcp_response_limit");
      if (!response.body) throw new McpFailure("mcp_response_invalid");
      const reader = response.body.getReader();
      // Keep cancellation attached while consuming the body, including after
      // fetch has resolved its headers. Cancelling settles a pending read even
      // when the upstream never sends another chunk.
      const cancelReader = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancelReader, { once: true });
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > RESPONSE_LIMIT) throw new McpFailure("mcp_response_limit");
          chunks.push(value);
        }
      } finally {
        signal.removeEventListener("abort", cancelReader);
        // Cancellation of the underlying source may itself stall; cleanup
        // must never delay the bounded error returned to the MCP caller.
        cancelReader();
        reader.releaseLock();
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        return z.json().parse(JSON.parse(text));
      } catch {
        throw new McpFailure("mcp_response_invalid");
      }
    } catch (error) {
      if (error instanceof McpFailure) throw error;
      if (this.lifetime.aborted || cancelled?.aborted) throw new McpFailure("mcp_closed");
      if (timeout.aborted) throw new McpFailure("mcp_http_timeout");
      throw new McpFailure("mcp_http_error");
    } finally {
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }
}

/** Import-safe entrypoint. The caller owns close(); stdio EOF also closes this instance. */
export async function startMcp(env: NodeJS.ProcessEnv = process.env): Promise<{ close: () => Promise<void> }> {
  const { origin, grant } = configuration(env);
  const lifetime = new AbortController();
  // Buffer the initial handshake while HTTP discovery runs, while still observing
  // owner EOF immediately (even if discovery has not returned any headers).
  const input = new PassThrough();
  const api = new GrantApi(origin, grant, lifetime.signal);
  const server = new McpServer({ name: "atris-share", version: APP_VERSION },
    { capabilities: { tools: {} }, maxToolInputElements: 256 });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    process.stdin.off("end", onEnd);
    process.off("SIGTERM", onEnd);
    process.off("SIGINT", onEnd);
    process.stdin.unpipe(input);
    process.stdin.pause();
    input.destroy();
    await server.close();
  };
  const onEnd = () => { void close().catch(() => {}); };
  process.stdin.once("end", onEnd);
  process.once("SIGTERM", onEnd);
  process.once("SIGINT", onEnd);
  process.stdin.pipe(input);
  try {
    const parsed = capabilitiesSchema.safeParse(await api.request("/api/mcp/capabilities"));
    if (!parsed.success) throw new McpFailure("mcp_capabilities_invalid");
    const capabilities = parsed.data;
    const expiresAt = Date.parse(capabilities.expiresAt);
    if (expiresAt <= Date.now()) throw new McpFailure("mcp_grant_expired");
    const allowed = new Set<ToolName>();
    const invoke = async (name: string, args: unknown, signal: AbortSignal): Promise<CallToolResult> => {
      if (!allowed.has(name as ToolName)) return toolError("mcp_tool_unavailable");
      if (expiresAt <= Date.now()) return toolError("mcp_grant_expired");
      const parsedArgs = toolSchemas[name as ToolName].safeParse(args ?? {});
      if (!parsedArgs.success) return toolError("mcp_invalid_arguments");
      try {
        const result = await api.request("/api/mcp/call", { tool: name, arguments: parsedArgs.data }, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(errorCode(error));
      }
    };
    for (const [name, schema] of Object.entries(toolSchemas)) {
      if (!capabilities.tools.includes(name) || (name === "memory_read" && !capabilities.includeMemory) || (name === "transcript_read" && !capabilities.includeTranscript)) continue;
      allowed.add(name as ToolName);
      server.registerTool(name, { inputSchema: schema }, (args: unknown, extra: { signal: AbortSignal }) =>
        invoke(name, args, extra.signal));
    }
    if (allowed.size === 0) server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    // Public SDK dispatch hook keeps unknown-tool and strict-Zod errors bounded:
    // the SDK's default validation messages can echo caller-controlled fields.
    server.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
      invoke(request.params.name, request.params.arguments, extra.signal));
    server.server.onclose = onEnd;
    if (closed) throw new McpFailure("mcp_closed");
    await server.connect(new StdioServerTransport(input, process.stdout, { maxBufferSize: RESPONSE_LIMIT }));
    return { close };
  } catch (error) {
    await close().catch(() => {});
    throw new McpFailure(errorCode(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startMcp().catch(error => {
    if (errorCode(error) === "mcp_closed") return;
    process.stderr.write(`${errorCode(error)}\n`);
    process.exitCode = 1;
  });
}
