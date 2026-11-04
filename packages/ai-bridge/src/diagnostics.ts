import type { AiDiagnostic } from "../../domain/src/ai.js";

const CODES = new Set(["ai_unavailable", "ai_invalid_executable", "ai_invalid_timeout", "ai_invalid_catalog_directory", "ai_invalid_input",
  "ai_version_unsupported", "ai_configuration_unsafe", "ai_catalog_invalid", "ai_catalog_refresh_failed", "ai_model_unavailable",
  "ai_auth_required", "ai_access_denied", "ai_quota_exceeded", "ai_network_error", "ai_timeout", "ai_cancelled",
  "ai_protocol_error", "ai_invalid_proposal", "ai_output_limit", "ai_cleanup_failed", "ai_process_failed"]);

export function safeAiError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "ai_cancelled";
  return error instanceof Error && CODES.has(error.message) ? error.message : "ai_process_failed";
}

export function errorCategory(code: string): AiDiagnostic["category"] {
  if (code === "ai_auth_required") return "authentication";
  if (["ai_access_denied", "ai_model_unavailable"].includes(code)) return "access";
  if (code === "ai_quota_exceeded") return "quota";
  if (code === "ai_network_error") return "network";
  if (code === "ai_timeout") return "timeout";
  if (code === "ai_cancelled") return "cancelled";
  if (code === "ai_version_unsupported") return "version";
  if (code === "ai_configuration_unsafe") return "configuration";
  if (["ai_unavailable", "ai_invalid_executable"].includes(code)) return "installation";
  if (["ai_protocol_error", "ai_invalid_proposal", "ai_output_limit", "ai_catalog_invalid"].includes(code)) return "protocol";
  return "process";
}

/** Bounded CLI text is examined only inside the port and is never returned/stored/logged. */
export function classifyCliFailure(value: unknown, fallback = "ai_process_failed"): string {
  const text = typeof value === "string" ? value.slice(0, 32 * 1024) : "";
  if (/\b(?:429|rate[ _-]?limit|quota|insufficient_quota|resource_exhausted)\b/iu.test(text)) return "ai_quota_exceeded";
  if (/\b(?:401|unauthorized|ProviderAuthError|APIKeyNotFoundError|authentication[ _-]?(?:required|failed)|invalid[ _-]?(?:api[ _-]?key|token)|api[ _-]?key(?: is)?[ _-]?(?:missing|not found)|not (?:authenticated|logged in)|no credentials)\b/iu.test(text)) return "ai_auth_required";
  if (/\b(?:403|forbidden|ProviderModelNotFoundError|permission[ _-]?denied|access[ _-]?denied|model[ _-]?(?:not[ _-]?found|not[ _-]?available)|not authorized)\b/iu.test(text)) return "ai_access_denied";
  if (/\b(?:econnreset|econnrefused|enotfound|eai_again|etimedout|fetch failed|network error|tls|certificate|proxy error)\b/iu.test(text)) return "ai_network_error";
  return fallback;
}

export class AiBridgeError extends Error {
  constructor(code: string, public readonly exitCode: number | null = null, public readonly diagnostic?: AiDiagnostic) { super(CODES.has(code) ? code : "ai_process_failed"); }
}
