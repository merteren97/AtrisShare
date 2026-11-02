import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
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
export function dpapi(input: Buffer, operation: "Protect" | "Unprotect" | "RoundTrip", options: { spawn?: typeof spawn } = {}): Promise<Buffer> {
  if (!["Protect", "Unprotect", "RoundTrip"].includes(operation)) throw new Error("Invalid credential operation");
  const transform = operation === "RoundTrip"
    ? "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); $result=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);"
    : `$result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);`;
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); ${transform} [Console]::Out.Write([Convert]::ToBase64String($result));`;
  return new Promise((resolve, reject) => {
    const executable = win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const child = (options.spawn ?? spawn)(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"]
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: string | null = null;
    // Cold PowerShell/.NET startup can exceed 8s on a loaded hosted Windows
    // runner. A single startup probe now performs both DPAPI operations; its
    // bounded 15s budget fits inside the native runtime's 20s readiness wait.
    const timeout = setTimeout(() => { failure = "OS credential operation timed out"; child.kill(); }, 15000);
    child.on("error", () => { clearTimeout(timeout); reject(new Error("OS credential operation failed")); });
    child.stdin.on("error", () => { /* A failed child is reported by exit/error. */ });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) { failure ??= "OS credential operation failed"; child.kill(); } else chunks.push(chunk);
    });
    child.on("close", code => {
      clearTimeout(timeout);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      const decoded = Buffer.from(text, "base64");
      if (failure || code !== 0 || !decoded.length || decoded.toString("base64") !== text) reject(new Error(failure ?? "OS credential operation failed"));
      else resolve(decoded);
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
    if (!(await dpapi(probe, "RoundTrip")).equals(probe)) return new UnavailableVault();
    return new WindowsDpapiVault(join(dataDirectory, "vault"));
  } catch { return new UnavailableVault(); }
}
