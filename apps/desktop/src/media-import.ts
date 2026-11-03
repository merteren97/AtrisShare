import { invoke, isTauri } from "@tauri-apps/api/core";
import type { WorkspaceContext } from "../../../packages/domain/src/workspace.js";
import { ApiError, binaryRequest } from "./api";
import type { StudioArtifact } from "./Studio";

export type ImportSource = File | string;
export interface ImportEntry { name: string; state: "queued" | "importing" | "imported" | "failed"; error?: unknown }
export const importName = (source: ImportSource): string => typeof source === "string" ? source.split(/[\\/]/).pop() ?? source : source.name;

export async function importMedia(source: ImportSource, context: WorkspaceContext, signal: AbortSignal): Promise<StudioArtifact> {
  signal.throwIfAborted();
  const name = importName(source);
  if (!/\.(mp4|mov|webm|mkv)$/i.test(name)) throw new ApiError("invalid_media_extension");
  if (typeof source !== "string" && source.size > 2 * 1024 ** 3) throw new ApiError("media_too_large");
  if (typeof source === "string") {
    if (!isTauri()) throw new ApiError("invalid_media_file");
    return invoke<StudioArtifact>("native_import_media", { path: source, accountId: context.accountId, projectId: context.projectId });
  }
  const query = new URLSearchParams({ accountId: context.accountId, projectId: context.projectId ?? "", filename: name });
  return binaryRequest<StudioArtifact>(`/api/media/import?${query}`, source, signal);
}
