import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { MediaEngine, type MediaEngineOptions } from "../../../packages/media-engine/src/index.js";

// Pinned upstream release assets and SHA-256 digests, including full license/source notices.
// Never resolve "latest" or accept a download location from an HTTP caller.
const BASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/";
interface Asset { name: string; file: string; sha256: string; size: number; gzip?: boolean }
const LICENSE = "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903";
const assets: Record<string, Asset[]> = {
  "win32-x64": [
    { name: "ffmpeg-win32-x64.gz", file: "ffmpeg.exe", gzip: true, sha256: "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00", size: 82797568 },
    { name: "ffprobe-win32-x64.gz", file: "ffprobe.exe", gzip: true, sha256: "3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4", size: 82668032 },
    { name: "win32-x64.LICENSE", file: "LICENSE", sha256: LICENSE, size: 35147 },
    { name: "win32-x64.README", file: "README", sha256: "a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311", size: 39494 }
  ],
  "linux-x64": [
    { name: "ffmpeg-linux-x64.gz", file: "ffmpeg", gzip: true, sha256: "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99", size: 79826272 },
    { name: "ffprobe-linux-x64.gz", file: "ffprobe", gzip: true, sha256: "4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d", size: 79665792 },
    { name: "linux-x64.LICENSE", file: "LICENSE", sha256: LICENSE, size: 35147 },
    { name: "linux-x64.README", file: "README", sha256: "72f4b1b06d419d22ace6e7cc75f06826f90737345aa0b1736158929f4aacc537", size: 2235 }
  ]
};
interface Options {
  /** Internal test seams; never exposed as runtime/HTTP configuration. */
  fetch?: typeof fetch;
  assets?: Asset[];
  probe?: (paths: MediaEngineOptions) => Promise<{ ffmpeg: boolean; ffprobe: boolean; available: boolean }>;
}
export class ManagedMediaTools {
  private readonly directory: string;
  private readonly files: Asset[] | undefined;
  private readonly shutdown = new AbortController();
  private paths: MediaEngineOptions = {};
  private pending: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private state: "preparing" | "ready" | "retrying" | "unsupported" = "preparing";
  constructor(dataDirectory: string, private readonly options: Options = {}) {
    this.directory = join(dataDirectory, "tools", `ffmpeg-b6.1.1-${process.platform}-${process.arch}`);
    this.files = options.assets ?? assets[`${process.platform}-${process.arch}`];
  }
  private probe(paths: MediaEngineOptions) {
    return this.options.probe ? this.options.probe(paths) : new MediaEngine(this.directory, paths).status();
  }
  async initialize(existing: MediaEngineOptions) {
    const status = await this.probe(existing);
    this.paths = { ...existing };
    if (status.available) { this.state = "ready"; return this.paths; }
    if (!this.files) { this.state = "unsupported"; return this.paths; }
    // Engines keep these stable paths from startup. Atomic installation makes the
    // tools available to their next status check without replacing a running engine.
    if (!status.ffmpeg) this.paths.ffmpegPath = join(this.directory, this.files[0]!.file);
    if (!status.ffprobe) this.paths.ffprobePath = join(this.directory, this.files[1]!.file);
    await this.readyDirectory();
    // Remove damaged cached files before consumers can execute the stable paths.
    for (const asset of this.files) {
      if (!await this.valid(asset)) await rm(join(this.directory, asset.file), { force: true });
    }
    void this.retry();
    return this.paths;
  }
  view() { return { state: this.state }; }
  retry(): Promise<void> {
    if (this.shutdown.signal.aborted || this.state === "unsupported" || this.state === "ready") return Promise.resolve();
    if (this.pending) return this.pending;
    clearTimeout(this.timer);
    this.state = "preparing";
    this.pending = this.install().then(() => { this.state = "ready"; }).catch(() => {
      if (!this.shutdown.signal.aborted) {
        this.state = "retrying";
        this.timer = setTimeout(() => { void this.retry(); }, 60_000).unref();
      }
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async valid(asset: Asset) {
    const path = join(this.directory, asset.file);
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== asset.size) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex") === asset.sha256;
  }
  private async download(asset: Asset) {
    if (await this.valid(asset)) return;
    const temporary = join(this.directory, `.${asset.file}-${randomUUID()}.partial`);
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(180_000)]);
    try {
      const response = await (this.options.fetch ?? fetch)(`${BASE}${asset.name}`, { signal });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("media_download_failed"); }
      let bytes = 0, compressed = 0;
      const hash = createHash("sha256");
      const inputLimit = new Transform({ transform(chunk: Buffer, _encoding, done) {
        compressed += chunk.length;
        done(compressed > 64 * 1024 * 1024 ? new Error("media_download_limit") : null, chunk);
      } });
      const verify = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > asset.size) { done(new Error("media_download_limit")); return; }
        hash.update(chunk); done(null, chunk);
      } });
      const input = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
      if (asset.gzip) await pipeline(input, inputLimit, createGunzip(), verify, output, { signal });
      else await pipeline(input, inputLimit, verify, output, { signal });
      if (bytes !== asset.size || hash.digest("hex") !== asset.sha256) throw new Error("media_download_integrity");
      await chmod(temporary, asset.gzip ? 0o700 : 0o600);
      await rename(temporary, join(this.directory, asset.file));
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  private async install() {
    await this.readyDirectory();
    // Notices first; never execute an unverified or partially downloaded binary.
    for (const asset of [...this.files!.slice(2), ...this.files!.slice(0, 2)]) {
      this.shutdown.signal.throwIfAborted();
      await this.download(asset);
    }
    this.shutdown.signal.throwIfAborted();
    if (!(await this.probe(this.paths)).available) throw new Error("media_tools_unavailable");
  }
  private async readyDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid_tools_directory");
  }
  async close() { clearTimeout(this.timer); this.shutdown.abort(); await this.pending; }
}
