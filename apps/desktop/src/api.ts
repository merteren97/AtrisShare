import { invoke, isTauri } from "@tauri-apps/api/core";
import type { RuntimeConfig } from "../../../packages/domain/src/workspace.js";

export class ApiError extends Error {
  constructor(public readonly code: string) { super(code); }
}
let runtime: Promise<RuntimeConfig> | undefined;
export function reconnect(): void { runtime = undefined; }
async function bootstrap(): Promise<RuntimeConfig> {
  const config: RuntimeConfig = isTauri()
    ? await invoke<RuntimeConfig>("runtime_config")
    : await fetch("/__atris/bootstrap", { headers: { "X-Atris-Bootstrap": "1" }, cache: "no-store" }).then(async r => {
        if (!r.ok) throw new ApiError("connection_failed");
        return r.json() as Promise<RuntimeConfig>;
      });
  const origin = new URL(config.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || !config.token || config.token.length < 32) {
    throw new ApiError("invalid_runtime");
  }
  return config;
}
export async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  runtime ??= bootstrap();
  const config = await runtime;
  const response = await fetch(`${config.origin}${path}`, {
    method, headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    cache: "no-store", ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {})
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({ error: "operation_failed" })) as { error?: string };
    throw new ApiError(result.error ?? "operation_failed");
  }
  return response.json() as Promise<T>;
}
