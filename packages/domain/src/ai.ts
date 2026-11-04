import { z } from "zod";
import { editSchema, type MediaEdit } from "./media.js";
import { studioContextSchema } from "./studio.js";
import { idSchema, type WorkspaceContext } from "./workspace.js";

export const aiModelSchema = z.string().max(384).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u);
export const aiConnectionScopeSchema = z.object({ context: studioContextSchema }).strict();
export const aiConnectionTestSchema = aiConnectionScopeSchema.extend({ model: aiModelSchema, allowRemote: z.literal(true) }).strict();
export const aiDiagnosticSchema = z.object({
  stage: z.enum(["discovery", "version", "configuration", "catalog", "inference", "protocol"]),
  category: z.enum(["none", "installation", "authentication", "access", "quota", "network", "timeout", "version", "configuration", "protocol", "cancelled", "process"]),
  exitCode: z.number().int().nullable(), durationMs: z.number().int().nonnegative(),
  requestId: z.string().uuid(), version: z.string().max(64).nullable(),
}).strict();
export type AiDiagnostic = z.infer<typeof aiDiagnosticSchema>;
export interface AiConnectionTest {
  id: string; model: string; profileId: string; state: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string; completedAt: string | null; error: string | null; diagnostic: AiDiagnostic | null;
}
export interface AiModelPreference { profileId: string; model: string; provider: string; succeededAt: string }
export interface AiConnectionStatus {
  profileId: string | null;
  authentication: "unverified" | "verified-by-inference" | "required";
  catalogSource: "general-catalog";
  preference: AiModelPreference | null; preferenceAvailable: boolean;
  lastTest: AiConnectionTest | null;
  persistence: "disk" | "session"; preferenceError: string | null;
}

export const aiScopeSchema = z.object({ context: studioContextSchema, destinationId: z.string().min(1).max(160), artifactId: idSchema }).strict();
export const aiRequestSchema = aiScopeSchema.extend({ model: z.string().min(1).max(384).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/),
  prompt: z.string().trim().min(1).max(4000), includeMemory: z.boolean(), includeTranscript: z.boolean().default(false), allowRemote: z.literal(true) }).strict();
export const aiProposalSchema = z.object({ summary: z.string().trim().min(1).max(2000), edit: editSchema }).strict();
export interface AiRun {
  id: string; context: WorkspaceContext; artifactId: string; destinationId: string; sourceSha256: string;
  baseRevision: number; model: string; prompt: string; includeMemory: boolean;
  state: "running" | "ready" | "accepted" | "rejected" | "failed" | "cancelled";
  summary: string | null; edit: MediaEdit | null; error: string | null;
  events: { message: string; at: string }[]; createdAt: string; sessionId: string | null; previewRenderId: string | null;
  cancelRequested?: boolean;
  includeTranscript?: boolean;
}
