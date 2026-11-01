import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { editSchema, mediaProbeSchema } from "../../domain/src/media.js";
import type { MediaEdit, MediaProbe } from "../../domain/src/media.js";
import type { ClipSignals } from "../../domain/src/clips.js";

const MAX_BYTES = 2 * 1024 ** 3;
const MAX_TIME = 30 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Container = "mp4" | "webm";
type ToolStatus = { available: boolean; ffmpeg: boolean; ffprobe: boolean };
export interface MediaResult {
  id: string;
  filename: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  probe: MediaProbe | null;
}
export interface MediaEngineOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Trusted process injection for tests/hosts; production defaults to node:child_process. */
  spawn?: typeof nodeSpawn;
  /** Limits may only lower the hard ceilings (2 GiB, 30 minutes, 4 MiB). */
  maxImportBytes?: number;
  processTimeoutMs?: number;
  maxOutputBytes?: number;
}

function bounded(value: number | undefined, fallback: number, ceiling: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > ceiling) throw new Error("invalid_media_limit");
  return result;
}
function mediaId(id: string): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("invalid_media_id");
  return id.toLowerCase();
}
function safeFilename(filename: string): string {
  if (typeof filename !== "string") throw new Error("unsupported_media_extension");
  const base = (filename.split(/[\\/]/u).pop() ?? "").normalize("NFKC");
  const extension = extname(base).toLowerCase();
  if (![".mp4", ".mov", ".webm", ".mkv"].includes(extension)) throw new Error("unsupported_media_extension");
  const stem = base.slice(0, -extension.length).replace(/[<>:"|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "_")
    .replace(/^[.\s]+|[.\s]+$/gu, "").slice(0, 160) || "media";
  return `${/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(stem) ? "media_" : ""}${stem}${extension}`;
}
function abortError(): Error { return new DOMException("Media operation aborted", "AbortError"); }
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
class ToolUnavailable extends Error {
  constructor(tool: string) { super(`media_tool_unavailable: ${tool}`); }
}
function toolEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|temp|tmp|tmpdir)$/iu.test(key) && value !== undefined) env[key] = value;
  }
  return env;
}

/** Conservative default-font advances, including room for wide/fallback glyphs.
 * Only whitespace is normalized; punctuation and filter-like tokens stay literal.
 */
function captionLayout(caption: string, width: number, height: number) {
  const fontSize = Math.max(10, Math.min(24, Math.floor(width / 16), Math.floor(height / 18)));
  const margin = Math.max(4, Math.ceil(Math.min(width, height) * 0.04));
  const border = Math.max(2, Math.ceil(fontSize / 4));
  const spacing = Math.ceil(fontSize / 3);
  const available = width - 2 * (margin + border);
  const advance = (text: string) => Array.from(text).reduce((sum, char) =>
    sum + fontSize * (/^[\x20-\x7e]$/u.test(char) && !/[MW@%]/u.test(char) ? 1 : 1.5), 0);
  const lines: string[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const paragraph of caption.replace(/\r\n?/gu, "\n").split("\n")) {
    let line = "";
    for (const word of paragraph.trim().split(/[ \t]+/u).filter(Boolean)) {
      if (line && advance(`${line} ${word}`) <= available) { line += ` ${word}`; continue; }
      if (line) { lines.push(line); line = ""; }
      // Long unbroken words also wrap, without splitting a combining/emoji sequence.
      for (const { segment } of segmenter.segment(word)) {
        if (advance(segment) > available) throw new Error("media_caption_does_not_fit");
        if (line && advance(line + segment) > available) { lines.push(line); line = ""; }
        line += segment;
      }
    }
    lines.push(line);
  }
  // Reserve a bounded caption region and account for ascenders, descenders, spacing,
  // box padding and safe margins. Never silently drop text or shrink it indefinitely.
  const textHeight = lines.length * Math.ceil(fontSize * 1.5) + (lines.length - 1) * spacing;
  if (textHeight + 2 * border > Math.min(height * 0.6, height - 2 * margin)) throw new Error("media_caption_does_not_fit");
  return { text: lines.join("\n"), fontSize, margin, border, spacing };
}

/** Bounded random-access container inspection; never asks a demuxer to sniff a playlist. */
async function containerOf(path: string, signal?: AbortSignal): Promise<Container> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 16 || stat.size > MAX_BYTES) throw new Error("invalid_media_container");
    const bytes = async (at: number, length: number): Promise<Buffer> => {
      signal?.throwIfAborted();
      if (at < 0 || length < 0 || at + length > stat.size || length > 65536) throw new Error("invalid_media_container");
      const buffer = Buffer.alloc(length);
      const result = await file.read(buffer, 0, length, at);
      if (result.bytesRead !== length) throw new Error("invalid_media_container");
      return buffer;
    };
    const head = await bytes(0, 16);
    let budget = 100000;
    if (head.toString("ascii", 4, 8) === "ftyp") {
      let ftyp = false, movie = false, data = false, track = false;
      const groups = new Set(["moov", "trak", "mdia", "minf", "dinf", "stbl", "mvex", "moof", "traf"]);
      const boxes = async (start: number, end: number, depth: number): Promise<void> => {
        if (depth > 12) throw new Error("invalid_media_container");
        for (let at = start; at < end;) {
          if (--budget < 0 || at + 8 > end) throw new Error("invalid_media_container");
          const header = await bytes(at, 8);
          let size = header.readUInt32BE(0), prefix = 8;
          const kind = header.toString("latin1", 4, 8);
          if (size === 1) {
            const wide = (await bytes(at + 8, 8)).readBigUInt64BE();
            if (wide > BigInt(stat.size)) throw new Error("invalid_media_container");
            size = Number(wide); prefix = 16;
          } else if (size === 0) size = end - at;
          if (size < prefix || at + size > end) throw new Error("invalid_media_container");
          const body = at + prefix, finish = at + size;
          if (kind === "cmov" || kind === "rmra" || kind === "rmda") throw new Error("external_media_reference");
          if (kind === "ftyp" && depth === 0) {
            if (size - prefix < 8 || size - prefix > 4096) throw new Error("invalid_media_container");
            const brands = await bytes(body, size - prefix);
            const allowed = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "mp41", "mp42", "avc1", "dash", "M4V ", "qt  "]);
            for (let i = 0; i + 4 <= brands.length; i += 4) if (i !== 4 && allowed.has(brands.toString("latin1", i, i + 4))) ftyp = true;
          }
          if (kind === "moov" && depth === 0) movie = true;
          if (kind === "mdat" && depth === 0 && size > prefix) data = true;
          if (kind === "trak" && depth === 1) track = true;
          if (kind === "dref") {
            if (body + 8 > finish) throw new Error("invalid_media_container");
            const full = await bytes(body, 8);
            const count = full.readUInt32BE(4);
            let entry = body + 8;
            if (count < 1 || count > 1024) throw new Error("invalid_media_container");
            for (let i = 0; i < count; i++) {
              if (entry + 12 > finish) throw new Error("invalid_media_container");
              const ref = await bytes(entry, 12);
              // Only a self-contained URL data entry. URNs, aliases and location strings are forbidden.
              if (ref.readUInt32BE(0) !== 12 || ref.toString("ascii", 4, 8) !== "url " || ref.readUInt32BE(8) !== 1) throw new Error("external_media_reference");
              entry += 12;
            }
            if (entry !== finish) throw new Error("invalid_media_container");
          }
          if (groups.has(kind)) await boxes(body, finish, depth + 1);
          at = finish;
        }
      };
      await boxes(0, stat.size, 0);
      if (!ftyp || !movie || !data || !track) throw new Error("invalid_media_container");
      return "mp4";
    }
    if (head.readUInt32BE() === 0x1a45dfa3) {
      const element = async (at: number, end: number) => {
        const header = await bytes(at, Math.min(12, end - at));
        const vint = (offset: number, identifier: boolean): { value: number; length: number; unknown: boolean } => {
          const first = header[offset];
          if (!first) throw new Error("invalid_media_container");
          let length = 1, mask = 0x80;
          while (!(first & mask)) { length++; mask >>= 1; }
          if (length > (identifier ? 4 : 8) || offset + length > header.length) throw new Error("invalid_media_container");
          let value = BigInt(identifier ? first : first & (mask - 1));
          for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(header[offset + i]!);
          const unknown = !identifier && value === (1n << BigInt(length * 7)) - 1n;
          if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid_media_container");
          return { value: Number(value), length, unknown };
        };
        if (--budget < 0) throw new Error("invalid_media_container");
        const id = vint(0, true), size = vint(id.length, false), body = at + id.length + size.length;
        const finish = size.unknown ? end : body + size.value;
        if (finish > end || finish < body) throw new Error("invalid_media_container");
        return { id: id.value, body, end: finish, unknown: size.unknown };
      };
      const header = await element(0, stat.size);
      if (header.unknown || header.end > 4096) throw new Error("invalid_media_container");
      let webm = false;
      for (let at = header.body; at < header.end;) {
        const item = await element(at, header.end);
        if (item.unknown) throw new Error("invalid_media_container");
        if (item.id === 0x4282) webm = (await bytes(item.body, item.end - item.body)).toString() === "webm";
        at = item.end;
      }
      const segment = await element(header.end, stat.size);
      if (!webm || segment.id !== 0x18538067 || segment.end !== stat.size) throw new Error("invalid_media_container");
      const groups = new Set([0x1549a966, 0x1043a770, 0x45b9, 0xb6]);
      const references = new Set([0x7384, 0x3c83ab, 0x3e83bb, 0x3cb923, 0x3eb923, 0x6e67]);
      const clusterChildren = new Set([0xe7, 0xa7, 0xab, 0x5854, 0xa3, 0xa0, 0xaf, 0xec, 0xbf]);
      let tracks = false, cluster = false;
      const elements = async (start: number, end: number, depth: number): Promise<void> => {
        if (depth > 12) throw new Error("invalid_media_container");
        for (let at = start; at < end;) {
          const item = await element(at, end);
          if (references.has(item.id)) throw new Error("external_media_reference");
          if (depth === 0 && item.id === 0x1654ae6b && item.end > item.body) tracks = true;
          if (depth === 0 && item.id === 0x1f43b675 && item.end > item.body) cluster = true;
          if (item.unknown && !(depth === 0 && item.id === 0x1f43b675 && tracks)) throw new Error("invalid_media_container");
          if (item.unknown) {
            // An unknown-sized live cluster ends at the next segment-level element. Walk its
            // length-delimited children, rather than letting it hide later reference metadata.
            let next = item.body;
            while (next < end) {
              const child = await element(next, end);
              if (!clusterChildren.has(child.id)) break;
              if (child.unknown) throw new Error("invalid_media_container");
              next = child.end;
            }
            at = next;
            continue;
          }
          if (groups.has(item.id)) await elements(item.body, item.end, depth + 1);
          at = item.end;
        }
      };
      await elements(segment.body, segment.end, 0);
      if (!tracks || !cluster) throw new Error("invalid_media_container");
      return "webm";
    }
    throw new Error("invalid_media_container");
  } finally { await file.close(); }
}

/** Managed, immutable media. No shell, network demuxing, or bundled tool binaries. */
export class MediaEngine {
  private readonly directory: string;
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly spawn: typeof nodeSpawn;
  private readonly maxBytes: number;
  private readonly timeout: number;
  private readonly maxOutput: number;
  private statusCache: { value: ToolStatus; expiresAt: number } | undefined;
  private statusPending: Promise<ToolStatus> | undefined;

  constructor(dataDirectory: string, options: MediaEngineOptions = {}) {
    this.directory = join(resolve(dataDirectory), "media");
    this.ffmpeg = options.ffmpegPath ?? process.env.ATRIS_SHARE_FFMPEG ?? "ffmpeg";
    this.ffprobe = options.ffprobePath ?? process.env.ATRIS_SHARE_FFPROBE ?? "ffprobe";
    this.spawn = options.spawn ?? nodeSpawn;
    this.maxBytes = bounded(options.maxImportBytes, MAX_BYTES, MAX_BYTES);
    this.timeout = bounded(options.processTimeoutMs, MAX_TIME, MAX_TIME);
    this.maxOutput = bounded(options.maxOutputBytes, 1024 ** 2, 4 * 1024 ** 2);
  }

  path(id: string): string { return join(this.directory, `${mediaId(id)}.mp4`); }

  private async ready(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid_media_directory");
  }
  private async existing(id: string): Promise<string> {
    const path = this.path(id);
    await this.ready();
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes) throw new Error("invalid_media_file");
    return path;
  }

  private run(tool: "ffmpeg" | "ffprobe", args: string[], options: {
    signal?: AbortSignal; cwd?: string; timeout?: number; stdout?: (text: string) => void;
  } = {}): Promise<string> {
    options.signal?.throwIfAborted();
    return new Promise((resolveRun, reject) => {
      const child = this.spawn(tool === "ffmpeg" ? this.ffmpeg : this.ffprobe, args, {
        shell: false, windowsHide: true, env: toolEnvironment(),
        stdio: ["ignore", "pipe", "pipe"], ...(options.cwd ? { cwd: options.cwd } : {})
      });
      let output = "", stderr = "", count = 0, failure: Error | undefined;
      const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
      const abort = () => stop(abortError());
      const timer = setTimeout(() => stop(new Error("media_tool_timeout")), Math.min(options.timeout ?? this.timeout, this.timeout));
      options.signal?.addEventListener("abort", abort, { once: true });
      const collect = (chunk: Buffer, standard: boolean) => {
        count += chunk.length;
        if (count > this.maxOutput) { stop(new Error("media_tool_output_limit")); return; }
        if (failure) return;
        const text = chunk.toString("utf8");
        if (standard) {
          output += text;
          try { options.stdout?.(text); } catch { stop(new Error("media_progress_failed")); }
        } else stderr += text;
      };
      child.stdout?.on("data", (chunk: Buffer) => collect(chunk, true));
      child.stderr?.on("data", (chunk: Buffer) => collect(chunk, false));
      child.once("error", error => {
        failure ??= isMissing(error) || ("code" in error && error.code === "EACCES") ? new ToolUnavailable(tool) : error;
      });
      // Wait for close, including after cancellation: callers may now safely remove partial files.
      child.once("close", code => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`media_${tool}_failed: ${stderr.trim().slice(-2000) || `exit ${code}`}`));
        else resolveRun(output);
      });
      if (options.signal?.aborted) abort();
    });
  }

  async status(): Promise<ToolStatus> {
    if (this.statusCache && this.statusCache.expiresAt > Date.now()) return { ...this.statusCache.value };
    if (!this.statusPending) {
      const check = async (tool: "ffmpeg" | "ffprobe") => {
        try { return (await this.run(tool, ["-version"], { timeout: 5000 })).startsWith(`${tool} version `); }
        catch { return false; }
      };
      this.statusPending = Promise.all([check("ffmpeg"), check("ffprobe")]).then(([ffmpeg, ffprobe]) => {
        const value = { available: ffmpeg && ffprobe, ffmpeg, ffprobe };
        // Failures expire too, allowing tools to recover without a poll-driven spawn loop.
        this.statusCache = { value, expiresAt: Date.now() + 15000 };
        return value;
      }).finally(() => { this.statusPending = undefined; });
    }
    return { ...await this.statusPending };
  }

  private inputArgs(container: Container): string[] {
    return ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-f", container === "mp4" ? "mov" : "matroska",
      ...(container === "mp4" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : [])];
  }
  private async probeFile(path: string, container: Container, signal?: AbortSignal, compatible = false): Promise<MediaProbe> {
    const output = await this.run("ffprobe", ["-v", "error", "-max_alloc", "268435456", ...this.inputArgs(container),
      "-probesize", "8388608", "-analyzeduration", "10000000", "-show_entries",
      `format=duration,start_time:stream=codec_type,width,height,duration${compatible ? ",codec_name,pix_fmt" : ""}:stream_tags=rotate:stream_side_data_list`, "-of", "json", path],
    { ...(signal ? { signal } : {}), timeout: 30000 });
    const result = JSON.parse(output) as { format?: { duration?: string; start_time?: string }; streams?: {
      codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; duration?: string;
      tags?: { rotate?: string }; side_data_list?: { rotation?: number }[];
    }[] };
    if (!Array.isArray(result.streams)) throw new Error("invalid_media_probe");
    const video = result.streams.find(stream => stream.codec_type === "video");
    if (!video) throw new Error("media_video_required");
    if (compatible && (video.codec_name !== "h264" || video.pix_fmt !== "yuv420p"
      || result.streams.some(stream => stream.codec_type === "audio" && stream.codec_name !== "aac"))) {
      throw new Error("media_output_incompatible");
    }
    const rotation = Number(video.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
    const rotated = Math.abs(rotation % 180) === 90;
    // The supported containers report their timeline end as format duration,
    // including any initial timestamp offset. Match FFmpeg's default input clock.
    const duration = result.format?.duration !== undefined
      ? Number(result.format.duration) - Number(result.format.start_time ?? 0) : Number(video.duration);
    return mediaProbeSchema.parse({ duration,
      width: rotated ? video.height : video.width, height: rotated ? video.width : video.height,
      hasAudio: result.streams.some(stream => stream.codec_type === "audio") });
  }

  async import(id: string, input: Readable, filename: string, signal?: AbortSignal): Promise<MediaResult> {
    id = mediaId(id);
    const destination = this.path(id), name = safeFilename(filename);
    signal?.throwIfAborted();
    await this.ready();
    const workspace = await mkdtemp(join(this.directory, ".import-"));
    const temporary = join(workspace, "input");
    const hash = createHash("sha256");
    let bytes = 0;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), MAX_TIME);
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.length;
        if (bytes > this.maxBytes) { callback(new Error("media_size_limit")); return; }
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(input, meter, createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal: combined });
      const container = await containerOf(temporary, combined);
      let probe: MediaProbe | null = null;
      try { probe = await this.probeFile(temporary, container, combined); }
      catch (error) { if (!(error instanceof ToolUnavailable)) throw error; }
      combined.throwIfAborted();
      // Hard-link publication is atomic and exclusive on both Windows and POSIX; rename overwrites.
      await link(temporary, destination);
      return { id, filename: name, sha256: hash.digest("hex"), bytes, mimeType: container === "mp4" ? "video/mp4" : "video/webm", probe };
    } finally {
      clearTimeout(timer);
      await rm(workspace, { recursive: true, force: true });
    }
  }

  async verify(id: string, sha256: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    mediaId(id);
    if (!/^[0-9a-f]{64}$/iu.test(sha256)) return false;
    try { return (await this.digest(await this.existing(id), signal)).sha256 === sha256.toLowerCase(); }
    catch (error) { if (isMissing(error)) return false; throw error; }
  }
  private async digest(path: string, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(createReadStream(path), new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
      bytes += chunk.length;
      if (bytes > this.maxBytes) { callback(new Error("media_size_limit")); return; }
      hash.update(chunk); callback();
    } }), { ...(signal ? { signal } : {}) });
    return { sha256: hash.digest("hex"), bytes };
  }
  async inspect(id: string, signal?: AbortSignal): Promise<MediaProbe> {
    signal?.throwIfAborted();
    const path = await this.existing(id);
    return this.probeFile(path, await containerOf(path, signal), signal);
  }

  /** Local, low-resolution scene cuts and silence intervals, in the source clock.
   * These are editing hints, not semantic/face/virality detection. No bytes leave the host.
   */
  async analyze(id: string, signal: AbortSignal): Promise<ClipSignals> {
    const source = await this.existing(id), container = await containerOf(source, signal);
    const probe = await this.probeFile(source, container, signal);
    if (probe.duration > 7200) throw new Error("clip_duration_limit");
    const common = ["-hide_banner", "-nostdin", "-v", "error", ...this.inputArgs(container), "-threads", "2", "-i", source];
    const text = await this.run("ffmpeg", [...common, "-an", "-vf",
      "scale=320:-2,fps=2,select='gt(scene,0.3)',metadata=mode=print:file=-", "-filter_threads", "2", "-f", "null", "-"], { signal });
    const scenes = [...text.matchAll(/pts_time:([\d.e+-]+)/gu)].map(m => Number(m[1]))
      .filter(t => Number.isFinite(t) && t >= 0 && t <= probe.duration).slice(0, 5000);
    const silences: ClipSignals["silences"] = [];
    if (probe.hasAudio) {
      const audio = await this.run("ffmpeg", [...common, "-vn", "-af",
        "aresample=async=1:first_pts=0,silencedetect=noise=-35dB:d=0.35:mono=0,ametadata=mode=print:file=-", "-f", "null", "-"], { signal });
      let start: number | null = null;
      for (const match of audio.matchAll(/lavfi\.silence_(start|end)=([\d.e+-]+)/gu)) {
        const time = Math.min(probe.duration, Math.max(0, Number(match[2])));
        if (!Number.isFinite(time)) throw new Error("clip_invalid_signals");
        if (match[1] === "start") start = time;
        else if (start !== null) { if (time > start) silences.push({ start, end: time }); start = null; }
      }
      if (start !== null && start < probe.duration) silences.push({ start, end: probe.duration });
    }
    signal.throwIfAborted(); return { scenes, silences };
  }

  async render(sourceId: string, outputId: string, edit: MediaEdit, onProgress: (p: number) => void, signal: AbortSignal): Promise<MediaResult> {
    sourceId = mediaId(sourceId); outputId = mediaId(outputId);
    if (sourceId === outputId) throw new Error("media_source_is_immutable");
    edit = editSchema.parse(edit);
    signal.throwIfAborted();
    const source = await this.existing(sourceId), destination = this.path(outputId);
    const container = await containerOf(source, signal);
    const probe = await this.probeFile(source, container, signal);
    if (edit.outSeconds > probe.duration) throw new Error("media_trim_out_of_bounds");
    let width = Math.floor(probe.width / 2) * 2, height = Math.floor(probe.height / 2) * 2;
    if (edit.crop === "square") width = height = Math.min(width, height);
    if (edit.crop === "vertical") {
      const unit = Math.floor(Math.min(width / 18, height / 32));
      width = unit * 18; height = unit * 32;
    }
    if (width < 2 || height < 2) throw new Error("media_dimensions_too_small");
    const caption = edit.caption ? captionLayout(edit.caption, width, height) : undefined;
    const segments = edit.segments;
    const duration = segments ? segments.reduce((sum, segment) => sum + segment.outSeconds - segment.inSeconds, 0)
      : edit.outSeconds - edit.inSeconds;
    const filters = [`crop=${width}:${height}:(iw-ow)*${edit.cropX ?? .5}:(ih-oh)/2`, "setsar=1"];
    if (caption) {
      filters.push(`drawtext=textfile=caption.txt:expansion=none:fontcolor=white:fontsize=${caption.fontSize}:line_spacing=${caption.spacing}:box=1:boxcolor=black@0.6:boxborderw=${caption.border}:x=(w-text_w)/2:y=h-text_h-${caption.margin + caption.border}`);
    }
    const cueFiles: { name: string; text: string }[] = [];
    let outputStart = 0;
    for (const range of segments ?? [{ inSeconds: edit.inSeconds, outSeconds: edit.outSeconds }]) {
      for (const cue of edit.timedCaptions ?? []) {
        const start = Math.max(range.inSeconds, cue.start), end = Math.min(range.outSeconds, cue.end);
        if (end <= start) continue;
        const layout = captionLayout(cue.text, width, height), name = `cue-${cueFiles.length}.txt`;
        cueFiles.push({ name, text: layout.text });
        filters.push(`drawtext=textfile=${name}:expansion=none:fontcolor=white:fontsize=${layout.fontSize}:line_spacing=${layout.spacing}:box=1:boxcolor=black@0.6:boxborderw=${layout.border}:x=(w-text_w)/2:y=h-text_h-${layout.margin + layout.border}:enable='gte(t,${outputStart + start - range.inSeconds})*lt(t,${outputStart + end - range.inSeconds})'`);
      }
      outputStart += range.outSeconds - range.inSeconds;
    }
    let args: string[];
    if (segments) {
      // FFmpeg removes the input container's start_time by default (no -copyts),
      // leaving both streams on the same source-relative clock. Fill absent audio
      // before splitting, including ranges entirely before/after its packets.
      // Bound tail padding to the envelope; each cut then subtracts the same origin
      // for A/V rather than independently moving its first frame/sample to zero.
      const graph: string[] = [];
      if (probe.hasAudio) graph.push(`[0:a:0]aresample=async=1:first_pts=0,apad,atrim=end=${edit.outSeconds}${segments.length > 1
        ? `,asplit=${segments.length}${segments.map((_, i) => `[a${i}]`).join("")}` : "[a0]"}`);
      if (segments.length > 1) {
        graph.push(`[0:v:0]split=${segments.length}${segments.map((_, i) => `[v${i}]`).join("")}`);
      }
      for (const [i, segment] of segments.entries()) {
        graph.push(`${segments.length > 1 ? `[v${i}]` : "[0:v:0]"}trim=start=${segment.inSeconds}:end=${segment.outSeconds},setpts=PTS-${segment.inSeconds}/TB[vt${i}]`);
        if (probe.hasAudio) graph.push(`[a${i}]atrim=start=${segment.inSeconds}:end=${segment.outSeconds},asetpts=PTS-${segment.inSeconds}/TB[at${i}]`);
      }
      graph.push(`${segments.map((_, i) => `[vt${i}]${probe.hasAudio ? `[at${i}]` : ""}`).join("")}concat=n=${segments.length}:v=1:a=${probe.hasAudio ? 1 : 0}[joinedv]${probe.hasAudio ? "[joineda]" : ""}`);
      graph.push(`[joinedv]${filters.join(",")}[video]`);
      if (probe.hasAudio) graph.push(`[joineda]volume=${edit.gainDb}dB[audio]`);
      args = ["-i", source, "-filter_complex", graph.join(";"), "-filter_complex_threads", "2", "-t", String(duration),
        "-map", "[video]", ...(probe.hasAudio ? ["-map", "[audio]"] : ["-an"])];
    } else {
      // Keep the original seek/single-clip path and its public behaviour intact.
      args = ["-ss", String(edit.inSeconds), "-i", source, "-t", String(duration), "-map", "0:v:0",
        ...(probe.hasAudio ? ["-map", "0:a:0", "-af", `volume=${edit.gainDb}dB`] : ["-an"]), "-vf", filters.join(",")];
    }
    return this.encode(outputId, destination, container, args, { duration, width, height, hasAudio: probe.hasAudio },
      onProgress, signal, ".render-", caption?.text, cueFiles);
  }

  /** Full-source playback proxy. Source seconds map directly to proxy seconds. */
  async proxy(sourceId: string, outputId: string, onProgress: (p: number) => void, signal: AbortSignal): Promise<MediaResult> {
    sourceId = mediaId(sourceId); outputId = mediaId(outputId);
    if (sourceId === outputId) throw new Error("media_source_is_immutable");
    signal.throwIfAborted();
    const source = await this.existing(sourceId), destination = this.path(outputId);
    const container = await containerOf(source, signal);
    const probe = await this.probeFile(source, container, signal);
    const factor = Math.min(1, 1280 / probe.width, 720 / probe.height);
    const width = Math.floor(probe.width * factor / 2) * 2, height = Math.floor(probe.height * factor / 2) * 2;
    if (width < 2 || height < 2) throw new Error("media_dimensions_too_small");
    // FFmpeg's input autorotation precedes scaling; scale retains display aspect
    // via SAR (including anamorphic inputs and even-pixel rounding). No fps,
    // tempo or independent timestamp resets: preserve the shared A/V clock/VFR.
    const args = ["-i", source, "-map", "0:v:0", ...(probe.hasAudio ? ["-map", "0:a:0"] : ["-an"]),
      "-vf", `scale=${width}:${height}`, "-vsync", "0"];
    return this.encode(outputId, destination, container, args, { ...probe, width, height }, onProgress, signal, ".proxy-");
  }

  private async encode(outputId: string, destination: string, container: Container, args: string[], expected: MediaProbe,
    onProgress: (p: number) => void, signal: AbortSignal, prefix: string, caption?: string, cueFiles: { name: string; text: string }[] = []): Promise<MediaResult> {
    const workspace = await mkdtemp(join(this.directory, prefix));
    const temporary = join(workspace, "output.mp4");
    let progress = -1, pending = "";
    const report = (value: number) => {
      if (value <= progress) return;
      progress = value;
      // Observers cannot interrupt publication or leave a child running by throwing.
      try { onProgress(value); } catch { /* host observer failure */ }
    };
    try {
      if (caption) await writeFile(join(workspace, "caption.txt"), caption, { flag: "wx", mode: 0o600 });
      for (const file of cueFiles) await writeFile(join(workspace, file.name), file.text, { flag: "wx", mode: 0o600 });
      // Keep long cue/concat graphs out of Windows' command-line length limit.
      if (cueFiles.length) {
        const at = args.findIndex(arg => arg === "-vf" || arg === "-filter_complex");
        if (at < 0 || !args[at + 1]) throw new Error("media_render_incomplete");
        await writeFile(join(workspace, "filters.txt"), args[at + 1]!, { flag: "wx", mode: 0o600 });
        args = [...args]; args[at] = args[at] === "-vf" ? "-filter_script:v" : "-filter_complex_script"; args[at + 1] = "filters.txt";
      }
      report(0);
      await this.run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-max_alloc", "268435456",
        ...this.inputArgs(container), "-threads", "2", ...args,
        "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
        ...(expected.hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ac", "2"] : []),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "-threads", "2",
        "-filter_threads", "2", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "-fs", String(this.maxBytes + 1), "-f", "mp4", "-n", temporary],
      { signal, cwd: workspace, stdout: text => {
        pending += text;
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        if (pending.length > 8192) throw new Error("invalid_media_progress");
        for (const line of lines) {
          const match = /^out_time_(?:us|ms)=(\d+)$/u.exec(line);
          if (match) report(Math.min(0.99, Number(match[1]) / 1e6 / expected.duration));
        }
      } });
      signal.throwIfAborted();
      const rendered = await this.probeFile(temporary, await containerOf(temporary, signal), signal, true);
      if (Math.abs(rendered.duration - expected.duration) > 0.5 || rendered.hasAudio !== expected.hasAudio
        || rendered.width !== expected.width || rendered.height !== expected.height) throw new Error("media_render_incomplete");
      const digest = await this.digest(temporary, signal);
      signal.throwIfAborted();
      await link(temporary, destination);
      report(1);
      return { id: outputId, filename: `${outputId}.mp4`, ...digest, mimeType: "video/mp4", probe: rendered };
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }

  async remove(id: string): Promise<void> {
    const path = this.path(id);
    await this.ready();
    try { await this.existing(id); await rm(path); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
}
