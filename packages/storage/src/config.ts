import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function resolveDataDirectory(override = process.env.ATRIS_SHARE_DATA_DIR): string {
  if (override) {
    if (!isAbsolute(override)) throw new Error("ATRIS_SHARE_DATA_DIR must be absolute");
    return resolve(override);
  }
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "AtrisShare");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "AtrisShare");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "AtrisShare");
}

/** Defense in depth for diagnostics/user notes; audit events never store note text. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[REDACTED]")
    .replace(/\b((?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|client[_-]?secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

export class WorkspaceError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
