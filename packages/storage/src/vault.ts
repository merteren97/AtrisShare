import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VaultStatus } from "../../domain/src/workspace.js";

/** Internal credential port. No vault methods are exposed over HTTP or frontend IPC. */
export interface CredentialVault {
  readonly status: VaultStatus;
  get(reference: string): Promise<string | null>;
  set(reference: string, secret: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

class UnavailableVault implements CredentialVault {
  readonly status: VaultStatus = { available: false, provider: "unavailable" };
  async get(): Promise<never> { throw new Error("OS credential vault unavailable"); }
  async set(): Promise<never> { throw new Error("OS credential vault unavailable"); }
  async delete(): Promise<never> { throw new Error("OS credential vault unavailable"); }
}

/** DPAPI CurrentUser; secrets travel over stdin, never command arguments or plaintext files. */
function dpapi(input: Buffer, operation: "Protect" | "Unprotect"): Promise<Buffer> {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result));`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"]
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timeout = setTimeout(() => child.kill(), 8000);
    child.on("error", () => { clearTimeout(timeout); reject(new Error("OS credential operation failed")); });
    child.stdin.on("error", () => { /* A failed child is reported by exit/error. */ });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) child.kill(); else chunks.push(chunk);
    });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code !== 0 || bytes > 256 * 1024) reject(new Error("OS credential operation failed"));
      else resolve(Buffer.from(Buffer.concat(chunks).toString().trim(), "base64"));
    });
    child.stdin.end(input.toString("base64"));
  });
}

class WindowsDpapiVault implements CredentialVault {
  readonly status: VaultStatus = { available: true, provider: "windows-dpapi" };
  constructor(private readonly directory: string) {}
  private path(reference: string): string {
    if (!/^account:[0-9a-f-]{36}$/.test(reference)) throw new Error("Invalid credential reference");
    return join(this.directory, `${createHash("sha256").update(reference).digest("hex")}.dpapi`);
  }
  async get(reference: string): Promise<string | null> {
    const path = this.path(reference);
    let encrypted: Buffer;
    try { encrypted = await readFile(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Credential read failed"); }
    if (encrypted.length > 128 * 1024) throw new Error("Invalid credential record");
    return (await dpapi(encrypted, "Unprotect")).toString("utf8");
  }
  async set(reference: string, secret: string): Promise<void> {
    const destination = this.path(reference);
    if (!secret || Buffer.byteLength(secret) > 32 * 1024) throw new Error("Invalid credential size");
    const encrypted = await dpapi(Buffer.from(secret, "utf8"), "Protect");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 }); await rename(temporary, destination); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  async delete(reference: string): Promise<void> {
    await unlink(this.path(reference)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw new Error("Credential deletion failed"); });
  }
}

export async function createCredentialVault(dataDirectory: string): Promise<CredentialVault> {
  if (process.platform !== "win32") return new UnavailableVault();
  try {
    const probe = Buffer.from(randomUUID());
    const encrypted = await dpapi(probe, "Protect");
    if (!(await dpapi(encrypted, "Unprotect")).equals(probe)) return new UnavailableVault();
    return new WindowsDpapiVault(join(dataDirectory, "vault"));
  } catch { return new UnavailableVault(); }
}
