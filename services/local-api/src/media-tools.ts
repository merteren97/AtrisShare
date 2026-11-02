import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import { MediaEngine } from "../../../packages/media-engine/src/index.js";
import { WorkspaceError } from "../../../packages/storage/src/config.js";

const toolPath = (name: string) => z.string().trim().max(2048).refine(value => !value ||
  isAbsolute(value) && !/[\u0000-\u001f]/u.test(value) && basename(value).toLowerCase() === `${name}${process.platform === "win32" ? ".exe" : ""}`);
export const mediaToolsSchema = z.object({ ffmpegPath: toolPath("ffmpeg"), ffprobePath: toolPath("ffprobe") }).strict();
type Paths = z.infer<typeof mediaToolsSchema>;
const empty: Paths = { ffmpegPath: "", ffprobePath: "" };

/** User-selected executable locations, never downloads or shell commands. Applied at next startup. */
export class MediaTools {
  private saved = { ...empty };
  private active = { ...empty };
  private invalid = false;
  private saving = false;
  constructor(private readonly directory: string) {}
  async load() {
    try {
      const path = join(this.directory, "media-tools.json");
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error("invalid_config");
      this.saved = mediaToolsSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) this.invalid = true;
    }
    this.active = { ...this.saved };
    return this.options();
  }
  options() {
    return { ...(this.active.ffmpegPath ? { ffmpegPath: this.active.ffmpegPath } : {}),
      ...(this.active.ffprobePath ? { ffprobePath: this.active.ffprobePath } : {}) };
  }
  view() { return { ...this.saved, restartRequired: JSON.stringify(this.saved) !== JSON.stringify(this.active), configurationError: this.invalid }; }
  async save(value: Paths) {
    if (this.saving) throw new WorkspaceError(409, "media_tools_busy");
    this.saving = true;
    const temporary = join(this.directory, `media-tools-${randomUUID()}.tmp`);
    try {
      const paths = mediaToolsSchema.parse(value);
      for (const path of [paths.ffmpegPath, paths.ffprobePath].filter(Boolean)) {
        const stat = await lstat(path).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink()) throw new WorkspaceError(400, "media_tools_invalid_path");
      }
      const engine = new MediaEngine(this.directory, {
        ...(paths.ffmpegPath ? { ffmpegPath: paths.ffmpegPath } : {}), ...(paths.ffprobePath ? { ffprobePath: paths.ffprobePath } : {})
      });
      const status = await engine.status();
      if (paths.ffmpegPath && !status.ffmpeg || paths.ffprobePath && !status.ffprobe) throw new WorkspaceError(400, "media_tools_invalid_executable");
      await writeFile(temporary, JSON.stringify(paths), { flag: "wx", mode: 0o600 });
      await rename(temporary, join(this.directory, "media-tools.json"));
      this.saved = paths; this.invalid = false;
      return this.view();
    } finally { await rm(temporary, { force: true }).catch(() => {}); this.saving = false; }
  }
}
