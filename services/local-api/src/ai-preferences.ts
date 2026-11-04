import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { aiModelSchema, type AiModelPreference } from "../../../packages/domain/src/ai.js";

const preferenceSchema = z.object({ profileId: z.string().regex(/^[a-f0-9]{64}$/u), model: aiModelSchema,
  provider: z.string().max(128), succeededAt: z.string().datetime() }).strict()
  .refine(value => value.provider === value.model.split("/")[0]);
const writes = new Map<string, Promise<void>>();

/** No credentials or config. Account + executable/version/official-auth-store profile only. */
export class AiPreferences {
  private readonly memory = new Map<string, AiModelPreference>();
  readonly mode: "disk" | "session";
  constructor(private readonly directory?: string) {
    if (directory !== undefined && !isAbsolute(directory)) throw new Error("ai_invalid_preference_directory");
    this.mode = directory ? "disk" : "session";
  }
  private key(accountId: string, profileId: string) { return createHash("sha256").update(JSON.stringify([accountId, profileId])).digest("hex"); }
  async read(accountId: string, profileId: string): Promise<AiModelPreference | null> {
    const key = this.key(accountId, profileId);
    if (!this.directory) return this.memory.get(key) ?? null;
    let handle;
    try {
      const path = join(this.directory, `${key}.json`), entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4096) throw new Error("ai_preference_invalid");
      handle = await open(path, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) throw new Error("ai_preference_invalid");
      const bytes = Buffer.alloc(4097), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 4096) throw new Error("ai_preference_invalid");
      const parsed = preferenceSchema.safeParse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
      if (!parsed.success || parsed.data.profileId !== profileId) throw new Error("ai_preference_invalid");
      return parsed.data;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw new Error("ai_preference_invalid");
    } finally { await handle?.close(); }
  }
  async save(accountId: string, value: AiModelPreference) {
    const parsed = preferenceSchema.parse(value), key = this.key(accountId, parsed.profileId);
    if (!this.directory) { this.memory.set(key, parsed); return; }
    const path = join(this.directory, `${key}.json`);
    const task = (writes.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const previous = await this.read(accountId, parsed.profileId).catch(() => null);
      if (previous && previous.succeededAt > parsed.succeededAt) return;
      await this.publish(key, parsed);
    });
    writes.set(path, task);
    try { await task; } finally { if (writes.get(path) === task) writes.delete(path); }
  }
  private async publish(key: string, parsed: AiModelPreference) {
    if (!this.directory) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(parsed)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, join(this.directory, `${key}.json`));
    } finally { await rm(temporary, { force: true }); }
  }
}
