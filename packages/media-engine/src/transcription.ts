import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join } from "node:path";

const MAX_DURATION = 2 * 60 * 60;
const PCM_RATE = 16000 * 2;
const MAX_WAV = (MAX_DURATION + 1) * PCM_RATE + 1024 * 1024;
const MAX_JSON = 32 * 1024 ** 2;
const MAX_LOG = 2 * 1024 ** 2;
const REQUIRED_FLAGS = ["--model", "--file", "--output-json-full", "--output-file", "--language", "--print-progress", "--threads", "--no-gpu"];

export interface TranscriptionEngineOptions {
  ffmpegPath?: string;
  whisperPath?: string;
  modelPath?: string;
  /** Trusted host/test injection; production uses node:child_process. */
  spawn?: typeof nodeSpawn;
}
export interface TranscriptionResult {
  language: string;
  segments: { start: number; end: number; text: string }[];
  /** Complete decoded audio duration, including silence; never inferred from speech. */
  duration: number;
}
type Status = { available: boolean; ffmpeg: boolean; whisper: boolean; model: boolean };
type Tool = "ffmpeg" | "whisper";

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|temp|tmp|tmpdir)$/iu.test(key) && value !== undefined) env[key] = value;
  }
  return env;
}
function aborted(): Error { return new DOMException("Transcription aborted", "AbortError"); }
function failure(code: string): Error { return new Error(`transcription_${code}`); }

/** Native executable discovery only. Windows cwd/PATHEXT scripts are not searched. */
async function executable(configured: string, tool: Tool): Promise<string> {
  if (!configured || /[\u0000-\u001f]/u.test(configured)
    || (process.platform === "win32" && extname(configured) && extname(configured).toLowerCase() !== ".exe")) {
    throw failure(`tool_unavailable: ${tool}`);
  }
  const candidates = isAbsolute(configured) ? [configured] : !/[\\/]/u.test(configured)
    ? (Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "")
      .split(delimiter).filter(part => isAbsolute(part)).map(part => join(part,
        process.platform === "win32" && !extname(configured) ? `${configured}.exe` : configured)) : [];
  for (const path of candidates) {
    try {
      if (!(await lstat(path)).isFile()) continue;
      await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return path;
    } catch { /* next PATH entry */ }
  }
  throw failure(`tool_unavailable: ${tool}`);
}

async function modelAvailable(path: string | undefined): Promise<boolean> {
  if (!path || !isAbsolute(path)) return false;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16 || stat.size > 8 * 1024 ** 3) return false;
    const file = await open(path, "r");
    try {
      const header = Buffer.alloc(4);
      return (await file.read(header, 0, 4, 0)).bytesRead === 4 && header.toString("ascii") === "lmgg";
    } finally { await file.close(); }
  } catch { return false; }
}

async function container(path: string): Promise<"mov" | "matroska"> {
  if (!isAbsolute(path)) throw failure("invalid_source");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16 || stat.size > 2 * 1024 ** 3) throw failure("invalid_source");
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(16);
    if ((await file.read(head, 0, 16, 0)).bytesRead !== 16) throw failure("invalid_source");
    if (head.toString("ascii", 4, 8) === "ftyp") return "mov";
    if (head.readUInt32BE() === 0x1a45dfa3) return "matroska";
    throw failure("invalid_source");
  } finally { await file.close(); }
}

/** Read bounded RIFF chunks, not the entire (up to 230 MB) PCM file. */
async function wavDuration(path: string): Promise<number> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 44 || stat.size > MAX_WAV) throw failure("invalid_audio");
    const read = async (at: number, length: number) => {
      const buffer = Buffer.alloc(length);
      if (at + length > stat.size || (await file.read(buffer, 0, length, at)).bytesRead !== length) throw failure("invalid_audio");
      return buffer;
    };
    const header = await read(0, 12);
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8) !== "WAVE"
      || header.readUInt32LE(4) + 8 !== stat.size) throw failure("invalid_audio");
    let formatted = false, data: number | undefined, chunks = 0;
    for (let at = 12; at < stat.size;) {
      if (++chunks > 1024) throw failure("invalid_audio");
      const chunk = await read(at, 8), size = chunk.readUInt32LE(4), kind = chunk.toString("ascii", 0, 4);
      if (at + 8 + size + (size % 2) > stat.size) throw failure("invalid_audio");
      if (kind === "fmt ") {
        if (formatted || size < 16) throw failure("invalid_audio");
        const fmt = await read(at + 8, 16);
        if (fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1 || fmt.readUInt32LE(4) !== 16000
          || fmt.readUInt32LE(8) !== PCM_RATE || fmt.readUInt16LE(12) !== 2 || fmt.readUInt16LE(14) !== 16) throw failure("invalid_audio");
        formatted = true;
      } else if (kind === "data") {
        if (data !== undefined || size % 2) throw failure("invalid_audio");
        data = size;
      }
      at += 8 + size + (size % 2);
    }
    if (!formatted || !data) throw failure("no_audio");
    const duration = data / PCM_RATE;
    // Extraction includes one sentinel second: never silently transcribe a truncated source.
    if (duration > MAX_DURATION) throw failure("unsupported_duration_limit_7200s");
    return duration;
  } finally { await file.close(); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("invalid_output");
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): number {
  if (typeof value !== "string") throw failure("invalid_timestamps");
  const match = /^(\d{2}):([0-5]\d):([0-5]\d)[,.](\d{3})$/u.exec(value);
  if (!match) throw failure("invalid_timestamps");
  return Number(match[1]) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number(match[4]);
}
async function transcript(path: string, duration: number): Promise<TranscriptionResult> {
  const file = await open(path, "r");
  let parsed: unknown;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_JSON) throw failure("output_limit");
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw failure("invalid_output");
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))); }
    catch { throw failure("invalid_output"); }
  } finally { await file.close(); }
  const root = object(parsed), language = object(root.result).language;
  if (typeof language !== "string" || !/^[a-z]{2,3}$/u.test(language)
    || !Array.isArray(root.transcription) || root.transcription.length > 50000) throw failure("invalid_output");
  let previousEnd = 0, textSize = 0;
  const segments = root.transcription.map((entry: unknown) => {
    const segment = object(entry), offsets = object(segment.offsets), times = object(segment.timestamps);
    const from = offsets.from, to = offsets.to;
    if (typeof from !== "number" || typeof to !== "number" || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)
      || timestamp(times.from) !== from || timestamp(times.to) !== to
      || from < 0 || to <= from || from / 1000 < previousEnd || from / 1000 >= duration
      // Whisper's segment clock has 10 ms precision. Only its final rounding is clamped.
      || to / 1000 > duration + 0.02) throw failure("invalid_timestamps");
    if (typeof segment.text !== "string" || segment.text.length > 32000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(segment.text)) throw failure("invalid_output");
    const text = segment.text.replace(/\s+/gu, " ").trim();
    if (!text || (textSize += text.length) > 2 * 1024 ** 2) throw failure("invalid_output");
    previousEnd = Math.min(to / 1000, duration);
    return { start: from / 1000, end: previousEnd, text };
  });
  // Deliberately project only transcript fields. CLI params/model/source paths never reach UI.
  return { language, segments, duration };
}

/** Local-only whisper.cpp CLI adapter. No downloads, cloud calls or bundled dependencies.
 * sourcePath MUST be an immutable managed file already validated by MediaEngine.import;
 * the signature sniff below selects a closed demuxer, not a replacement import validator.
 * Audio longer than two hours is explicitly unsupported. Progress is 0..1, using only
 * whisper.cpp's actual progress messages; extraction/loading stays indeterminate at 0.
 */
export class TranscriptionEngine {
  private readonly ffmpeg: string;
  private readonly whisper: string;
  private readonly model: string | undefined;
  private readonly spawn: typeof nodeSpawn;
  private cached: { value: Status; until: number } | undefined;
  private pending: Promise<Status> | undefined;

  constructor(options: TranscriptionEngineOptions = {}) {
    this.ffmpeg = options.ffmpegPath ?? process.env.ATRIS_SHARE_FFMPEG ?? "ffmpeg";
    this.whisper = options.whisperPath ?? process.env.ATRIS_SHARE_WHISPER_CLI ?? "whisper-cli";
    this.model = options.modelPath ?? process.env.ATRIS_SHARE_WHISPER_MODEL;
    this.spawn = options.spawn ?? nodeSpawn;
  }

  private async run(tool: Tool, args: string[], options: {
    signal?: AbortSignal; cwd?: string; timeout: number; stderr?: (text: string) => void;
  }): Promise<string> {
    options.signal?.throwIfAborted();
    const path = await executable(tool === "ffmpeg" ? this.ffmpeg : this.whisper, tool);
    options.signal?.throwIfAborted();
    return new Promise((resolveRun, reject) => {
      const child = this.spawn(path, args, { shell: false, windowsHide: true, env: environment(),
        stdio: ["ignore", "pipe", "pipe"], ...(options.cwd ? { cwd: options.cwd } : {}) });
      let count = 0, output = "", errors = "", stopped: Error | undefined;
      const stop = (error: Error) => { stopped ??= error; child.kill("SIGKILL"); };
      const abort = () => stop(aborted());
      const timer = setTimeout(() => stop(failure("tool_timeout")), options.timeout);
      options.signal?.addEventListener("abort", abort, { once: true });
      const collect = (chunk: Buffer, stdout: boolean) => {
        count += chunk.length;
        if (count > MAX_LOG) { stop(failure("tool_output_limit")); return; }
        if (stopped) return;
        const text = chunk.toString("utf8");
        if (stdout) output += text;
        else {
          errors += text;
          try { options.stderr?.(text); } catch { stop(failure("invalid_progress")); }
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => collect(chunk, true));
      child.stderr?.on("data", (chunk: Buffer) => collect(chunk, false));
      child.once("error", () => { stopped ??= failure(`tool_unavailable: ${tool}`); });
      // close, not exit/kill: both pipes and child are reaped before temp cleanup.
      child.once("close", code => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (stopped) reject(stopped);
        else if (code !== 0) reject(failure(tool === "ffmpeg" && /matches no streams|does not contain any stream/iu.test(errors)
          ? "no_audio" : `${tool}_failed`));
        else resolveRun(output + errors);
      });
      if (options.signal?.aborted) abort();
    });
  }

  private async whisperAvailable(signal?: AbortSignal): Promise<boolean> {
    const help = await this.run("whisper", ["--help"], { timeout: 5000, ...(signal ? { signal } : {}) });
    return REQUIRED_FLAGS.every(flag => help.includes(flag));
  }

  async status(): Promise<Status> {
    if (this.cached && this.cached.until > Date.now()) return { ...this.cached.value };
    this.pending ??= Promise.all([
      this.run("ffmpeg", ["-version"], { timeout: 5000 }).then(text => text.startsWith("ffmpeg version ")).catch(() => false),
      this.whisperAvailable().catch(() => false), modelAvailable(this.model)
    ]).then(([ffmpeg, whisper, model]) => {
      const value = { available: ffmpeg && whisper && model, ffmpeg, whisper, model };
      this.cached = { value, until: Date.now() + 15000 };
      return value;
    }).finally(() => { this.pending = undefined; });
    return { ...await this.pending };
  }

  async transcribe(sourcePath: string, onProgress: (p: number) => void, signal: AbortSignal): Promise<TranscriptionResult> {
    signal.throwIfAborted();
    if (!(await modelAvailable(this.model))) throw failure("model_unavailable_absolute_path_required");
    const format = await container(sourcePath).catch(() => { throw failure("invalid_source"); });
    signal.throwIfAborted();
    if (!(await this.whisperAvailable(signal))) throw failure("whisper_incompatible");
    const workspace = await mkdtemp(join(tmpdir(), "atris-share-transcription-"));
    let previous = -1;
    const report = (value: number) => {
      if (value <= previous) return;
      previous = value;
      try { onProgress(value); } catch { /* observers cannot strand a child */ }
    };
    let result: TranscriptionResult;
    try {
      signal.throwIfAborted();
      report(0);
      await this.run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-xerror", "-max_alloc", "268435456",
        "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-f", format,
        ...(format === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
        "-threads", "2", "-probesize", "8388608", "-analyzeduration", "10000000", "-i", sourcePath,
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
        "-af", "aresample=async=1:first_pts=0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        "-t", String(MAX_DURATION + 1), "-fs", String(MAX_WAV), "-threads", "2", "-filter_threads", "2", "-f", "wav", "-n", "audio.wav"],
      { signal, cwd: workspace, timeout: 5 * 60 * 1000 });
      signal.throwIfAborted();
      const duration = await wavDuration(join(workspace, "audio.wav")).catch(error => {
        if (error instanceof Error && error.message.startsWith("transcription_")) throw error;
        throw failure("invalid_audio");
      });
      let pending = "";
      await this.run("whisper", ["--model", this.model!, "--file", "audio.wav", "--output-json-full", "--output-file", "transcript",
        "--language", "auto", "--threads", "4", "--no-gpu", "--print-progress"],
      { signal, cwd: workspace, timeout: 30 * 60 * 1000, stderr: text => {
        pending += text;
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        if (pending.length > 8192) throw failure("invalid_progress");
        for (const line of lines) {
          const match = /^whisper_print_progress_callback: progress =\s*(\d{1,3})%$/u.exec(line);
          if (match && Number(match[1]) < 100) report(Number(match[1]) / 100);
        }
      } });
      signal.throwIfAborted();
      try { result = await transcript(join(workspace, "transcript.json"), duration); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith("transcription_")) throw error;
        throw failure("invalid_output");
      }
      signal.throwIfAborted();
    } finally { await rm(workspace, { recursive: true, force: true }); }
    signal.throwIfAborted();
    report(1);
    signal.throwIfAborted();
    return result;
  }
}
