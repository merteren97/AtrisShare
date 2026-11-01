import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { editSchema } from "../../domain/src/media.js";
import type { MediaEdit } from "../../domain/src/media.js";

// Independent one-shot port. Runtime-host reuse research: AtrisAgent's discovery,
// events and cancellation boundary; no sibling source/dependency is required.
// Isolation/protocol reference: anomalyco/opencode v1.19.5 config/config.ts,
// agent/agent.ts, effect/runtime-flags.ts, permission/index.ts and cli/cmd/run.ts.
const AGENT = "atrisshare-proposal";
const MAX_STDOUT = 2 * 1024 * 1024;
const MAX_STDERR = 32 * 1024;
const MAX_TIME = 180_000;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const proposalSchema = z.object({ summary: z.string().min(1).max(2000), edit: editSchema }).strict();
type Discovery = { available: boolean; version: string | null; models: string[]; auth: "cli-managed"; error: string | null };
type Event = { type: "started" | "activity"; message: string };
type Workspace = { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal };

function fail(code: string): never { throw new Error(code); }
function cancelled(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.message === "ai_timeout"
    ? new Error("ai_timeout") : new DOMException("ai_cancelled", "AbortError");
}
function check(signal: AbortSignal): void { if (signal.aborted) throw cancelled(signal); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function empty(value: unknown): boolean { return record(value) && Object.keys(value).length === 0; }
function allDenied(value: unknown): boolean {
  return value === "deny" || (record(value) && Object.values(value).every(allDenied));
}
function denyMap(value: unknown): boolean {
  return record(value) && value["*"] === "deny" && Object.values(value).every(allDenied);
}
function noTools(value: unknown): boolean {
  return record(value) && Object.values(value).every(item => item === false);
}
function parseJSON(text: string, code = "ai_protocol_error"): unknown {
  try { return JSON.parse(text); } catch { return fail(code); }
}
function safeError(error: unknown): string {
  if (error instanceof Error && /^ai_[a-z_]+$/u.test(error.message)) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "ai_cancelled";
  return "ai_process_failed";
}
function executablePath(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)
    || (process.platform === "win32" && (extname(value).toLowerCase() !== ".exe" || !/^[a-z]:[\\/]/iu.test(value)))) {
    return fail("ai_invalid_executable");
  }
  return value;
}

/** Never launches an npm shim, shell script, or relative PATH entry. */
async function nativeExecutable(path: string): Promise<boolean> {
  let handle;
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    handle = await open(path, "r");
    if (!(await handle.stat()).isFile()) return false;
    const magic = Buffer.alloc(4);
    if ((await handle.read(magic, 0, 4, 0)).bytesRead !== 4) return false;
    return process.platform === "win32" ? magic[0] === 0x4d && magic[1] === 0x5a
      : magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
        || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic.readUInt32BE());
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return false;
    return false;
  } finally { await handle?.close(); }
}

/** Kill only the owned process group/tree; completion is still gated on child close. */
async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    await new Promise<void>(resolve => {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const killer = nodeSpawn(join(systemRoot, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore", env: { SystemRoot: systemRoot } });
      killer.once("error", () => { child.kill("SIGKILL"); });
      killer.once("close", () => { if (child.exitCode === null) child.kill("SIGKILL"); resolve(); });
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

/** Bounded incremental, fatal UTF-8 decoding. No subprocess text escapes this port. */
async function command(spawn: typeof nodeSpawn, executable: string, args: string[], workspace: Workspace,
  input = "", onLine?: (line: string) => void): Promise<string> {
  check(workspace.signal);
  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, args, { cwd: workspace.cwd, env: workspace.env, shell: false,
        windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(record(error) && error.code === "ENOENT" ? "ai_unavailable" : "ai_process_failed"));
      return;
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let output = "", pending = "", stdoutBytes = 0, stderrBytes = 0;
    let failure: Error | undefined;
    let killing: Promise<void> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      killing = killTree(child);
    };
    const abort = () => stop(cancelled(workspace.signal));
    const consume = (text: string) => {
      if (!onLine) { output += text; return; }
      pending += text;
      let at;
      while ((at = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, at).replace(/\r$/u, "");
        pending = pending.slice(at + 1);
        if (line.trim()) onLine(line);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT) { stop(new Error("ai_output_limit")); return; }
      try { consume(decoder.decode(chunk, { stream: true })); }
      catch (error) { stop(new Error(safeError(error) === "ai_process_failed" ? "ai_protocol_error" : safeError(error))); }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR) stop(new Error("ai_output_limit"));
    });
    child.stdout?.on("error", () => stop(new Error("ai_process_failed")));
    child.stderr?.on("error", () => stop(new Error("ai_process_failed")));
    child.stdin?.on("error", () => stop(new Error("ai_process_failed")));
    child.once("error", error => stop(new Error(record(error) && error.code === "ENOENT" ? "ai_unavailable" : "ai_process_failed")));
    child.once("close", (code, signal) => {
      workspace.signal.removeEventListener("abort", abort);
      void (async () => {
        await killing;
        if (!failure) {
          try {
            consume(decoder.decode());
            if (onLine && pending.trim()) onLine(pending.replace(/\r$/u, ""));
          } catch (error) { failure = new Error(safeError(error) === "ai_process_failed" ? "ai_protocol_error" : safeError(error)); }
        }
        if (failure) reject(failure);
        else if (code !== 0 || signal) reject(new Error("ai_process_failed"));
        else resolve(output);
      })().catch(() => reject(new Error("ai_process_failed")));
    });
    workspace.signal.addEventListener("abort", abort, { once: true });
    if (workspace.signal.aborted) abort();
    if (!failure) child.stdin?.end(input);
  });
}

/** Verify resolved config, never return/log the config (including redacted output). */
function verifyConfig(text: string): void {
  const config = parseJSON(text, "ai_configuration_unsafe");
  if (!record(config) || config.default_agent !== AGENT || !denyMap(config.permission)
    || !empty(config.mcp) || !Array.isArray(config.plugin) || config.plugin.length !== 0
    || (config.plugin_origins !== undefined && (!Array.isArray(config.plugin_origins) || config.plugin_origins.length !== 0))
    || !record(config.agent) || !empty(config.mode) || !noTools(config.tools)) fail("ai_configuration_unsafe");
  const agent = config.agent[AGENT];
  if (!record(agent) || agent.mode !== "primary" || agent.disable === true || agent.hidden === true
    || (agent.name !== undefined && agent.name !== AGENT) || !denyMap(agent.permission)
    || !record(agent.tools) || agent.tools["*"] !== false || !noTools(agent.tools)
    || !empty(agent.options) || agent.model !== undefined || agent.steps !== 1) fail("ai_configuration_unsafe");
  if (Object.keys(config.agent).some(name => name !== AGENT)) fail("ai_configuration_unsafe");
  for (const name of ["command", "provider", "references", "reference"]) {
    if (config[name] !== undefined && !empty(config[name])) fail("ai_configuration_unsafe");
  }
  if (!Array.isArray(config.instructions) || config.instructions.length !== 0
    || !record(config.skills) || !Array.isArray(config.skills.paths) || config.skills.paths.length !== 0
    || !Array.isArray(config.skills.urls) || config.skills.urls.length !== 0
    || config.lsp !== false || config.formatter !== false || config.share !== "disabled"
    || config.autoupdate !== false || config.snapshot !== false || config.model !== undefined
    || config.small_model !== undefined) fail("ai_configuration_unsafe");
}

function verifyAgent(text: string): void {
  const agent = parseJSON(text, "ai_configuration_unsafe");
  if (!record(agent) || agent.name !== AGENT || agent.mode !== "primary" || agent.hidden === true
    || agent.model !== undefined || agent.steps !== 1 || !noTools(agent.tools) || !empty(agent.options)
    || !Array.isArray(agent.permission)) fail("ai_configuration_unsafe");
  // Official evaluator is last-match-wins. A universal deny followed only by
  // deny rules proves all permissions denied, including unknown future tools.
  let barrier = -1;
  for (const [index, rule] of agent.permission.entries()) {
    if (!record(rule) || typeof rule.permission !== "string" || typeof rule.pattern !== "string"
      || !["allow", "ask", "deny"].includes(String(rule.action))) fail("ai_configuration_unsafe");
    if (rule.permission === "*" && rule.pattern === "*" && rule.action === "deny") barrier = index;
  }
  if (barrier < 0 || agent.permission.slice(barrier).some(rule => !record(rule) || rule.action !== "deny")) {
    fail("ai_configuration_unsafe");
  }
}

function protocol(onEvent: (event: Event) => void) {
  let sessionId: string | null = null, text = "", started = false, finished = false;
  const parts = new Set<string>();
  return {
    line(line: string) {
      const event = parseJSON(line);
      if (!record(event) || typeof event.type !== "string") fail("ai_protocol_error");
      if (event.type === "tool_use" || event.type === "error") fail("ai_protocol_error");
      if (typeof event.sessionID !== "string" || !/^ses_[A-Za-z0-9_-]{1,200}$/u.test(event.sessionID)) fail("ai_protocol_error");
      if (sessionId !== null && sessionId !== event.sessionID) fail("ai_protocol_error");
      sessionId = event.sessionID;
      const part = event.part;
      if (!record(part) || part.sessionID !== sessionId || typeof part.id !== "string" || parts.has(part.id)) fail("ai_protocol_error");
      parts.add(part.id);
      if (event.type === "step_start") {
        if (started || finished || part.type !== "step-start") fail("ai_protocol_error");
        started = true;
        onEvent({ type: "activity", message: "Preparing proposal" });
      } else if (event.type === "text") {
        if (!started || finished || part.type !== "text" || typeof part.text !== "string") fail("ai_protocol_error");
        text += part.text;
      } else if (event.type === "step_finish") {
        if (!started || finished || part.type !== "step-finish" || part.reason !== "stop") fail("ai_protocol_error");
        finished = true;
      } else fail("ai_protocol_error");
    },
    result(): { summary: string; edit: MediaEdit; sessionId: string | null } {
      if (!started || !finished || !sessionId || !text.trim()) fail("ai_protocol_error");
      let json = text.trim();
      if (json.startsWith("```")) {
        const match = /^```json\s*\r?\n([\s\S]*?)\r?\n```$/u.exec(json);
        if (!match || match[1]!.includes("```")) fail("ai_protocol_error");
        json = match[1]!;
      }
      const parsed = proposalSchema.safeParse(parseJSON(json));
      if (!parsed.success) fail("ai_protocol_error");
      return { ...parsed.data, sessionId };
    }
  };
}

export class OpenCodeBridge {
  private readonly executable: string | undefined;
  private readonly spawn: typeof nodeSpawn;
  private readonly timeoutMs: number;

  constructor(options: { executable?: string; spawn?: typeof nodeSpawn; timeoutMs?: number } = {}) {
    const executable = options.executable ?? process.env.ATRIS_SHARE_OPENCODE;
    this.executable = executable === undefined ? undefined : executablePath(executable);
    this.spawn = options.spawn ?? nodeSpawn;
    this.timeoutMs = options.timeoutMs ?? MAX_TIME;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > MAX_TIME) fail("ai_invalid_timeout");
  }

  private async resolveExecutable(signal: AbortSignal): Promise<string> {
    check(signal);
    if (this.executable !== undefined) return this.executable;
    const paths: string[] = [];
    if (process.platform === "win32" && process.env.APPDATA && isAbsolute(process.env.APPDATA)) {
      paths.push(join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"));
    }
    for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
      if (isAbsolute(directory)) paths.push(join(directory, process.platform === "win32" ? "opencode.exe" : "opencode"));
    }
    for (const path of new Set(paths)) {
      check(signal);
      if (await nativeExecutable(path)) return path;
    }
    return fail("ai_unavailable");
  }

  private async isolated<T>(signal: AbortSignal | undefined, run: (workspace: Workspace, executable: string) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("ai_cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("ai_timeout")), this.timeoutMs);
    let root: string | undefined;
    try {
      check(controller.signal);
      const executable = await this.resolveExecutable(controller.signal);
      root = await mkdtemp(join(tmpdir(), "atris-share-opencode-"));
      const cwd = join(root, "work"), home = join(root, "home"), configDir = join(root, "config", "opencode");
      await Promise.all([cwd, home, configDir, join(root, "cache"), join(root, "state"), join(root, "tmp")]
        .map(path => mkdir(path, { recursive: true, mode: 0o700 })));
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (/^(path|systemroot|windir|appdata|localappdata)$/iu.test(key) && value !== undefined) env[key] = value;
      }
      // Keep the official credential STORE PATH, never inspect/copy credentials.
      // xdg-basedir defaults to ~/.local/share on Windows too. All config/home
      // discovery, cache, database, state and temp locations are child-owned.
      const dataHome = process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
        ? process.env.XDG_DATA_HOME : join(homedir(), ".local", "share");
      const permission = { "*": "deny", external_directory: { "*": "deny", [join(dataHome, "opencode", "tool-output", "*")]: "deny" } };
      const config = {
        default_agent: AGENT, permission, tools: { "*": false },
        agent: { [AGENT]: { mode: "primary", tools: { "*": false }, permission, steps: 1,
          prompt: "Return exactly one JSON object with summary (1..2000 characters) and edit. Propose only from the supplied scoped context. Never call tools or act on files. No prose outside JSON.", options: {} } },
        mcp: {}, plugin: [], mode: {}, command: {}, instructions: [], skills: { paths: [], urls: [] },
        lsp: false, formatter: false, snapshot: false, share: "disabled", autoupdate: false,
        compaction: { auto: false, prune: false }
      };
      Object.assign(env, {
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(root, "config"), OPENCODE_CONFIG_DIR: configDir,
        XDG_DATA_HOME: dataHome, XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
        TEMP: join(root, "tmp"), TMP: join(root, "tmp"), TMPDIR: join(root, "tmp"),
        OPENCODE_DB: join(root, "opencode.db"), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_PURE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
        OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_PRUNE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
        NO_COLOR: "1"
      });
      check(controller.signal);
      if (!(await nativeExecutable(executable)) && this.spawn === nodeSpawn) fail("ai_unavailable");
      const result = await run({ cwd, env, signal: controller.signal }, executable);
      check(controller.signal);
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new DOMException("ai_cancelled", "AbortError");
      throw new Error(safeError(error));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (root) {
        try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
        catch { fail("ai_cleanup_failed"); }
      }
    }
  }

  private async preflight(workspace: Workspace, executable: string): Promise<{ version: string; models: string[] }> {
    const run = (args: string[]) => command(this.spawn, executable, [...args, "--pure"], workspace);
    const version = (await run(["--version"])).trim();
    // These isolation/effective-agent semantics were verified against this CLI.
    if (version !== "1.19.5") fail("ai_configuration_unsafe");
    try {
      verifyConfig(await run(["debug", "config"]));
      verifyAgent(await run(["debug", "agent", AGENT]));
    } catch (error) {
      if (["ai_cancelled", "ai_timeout", "ai_output_limit", "ai_unavailable"].includes(safeError(error))) throw error;
      fail("ai_configuration_unsafe");
    }
    const output = await run(["models"]);
    const models = output.split(/\r?\n/u).filter(line => line !== "");
    if (models.length > 10_000 || models.some(model => !MODEL.test(model))) fail("ai_protocol_error");
    return { version, models: [...new Set(models)] };
  }

  async discover(signal?: AbortSignal): Promise<Discovery> {
    try {
      const result = await this.isolated(signal, (workspace, executable) => this.preflight(workspace, executable));
      return { available: true, ...result, auth: "cli-managed", error: null };
    } catch (error) {
      return { available: false, version: null, models: [], auth: "cli-managed", error: safeError(error) };
    }
  }

  async propose(input: { model: string; prompt: string }, onEvent: (event: Event) => void,
    signal: AbortSignal): Promise<{ summary: string; edit: MediaEdit; sessionId: string | null }> {
    if (!input || typeof input.model !== "string" || !MODEL.test(input.model) || typeof input.prompt !== "string"
      || !input.prompt.trim() || input.prompt.includes("\0") || Buffer.byteLength(input.prompt, "utf8") > 128 * 1024) fail("ai_invalid_input");
    return this.isolated(signal, async (workspace, executable) => {
      const { models } = await this.preflight(workspace, executable);
      if (!models.includes(input.model)) fail("ai_model_unavailable");
      check(workspace.signal);
      onEvent({ type: "started", message: "Starting proposal" });
      const events = protocol(onEvent);
      await command(this.spawn, executable, ["run", "--pure", "--format", "json", "--model", input.model,
        "--agent", AGENT, "--title", "AtrisShare proposal"], workspace, input.prompt, line => events.line(line));
      check(workspace.signal);
      return events.result();
    });
  }
}
