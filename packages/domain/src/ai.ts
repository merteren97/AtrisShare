import { z } from "zod";
import { editSchema, type MediaEdit } from "./media.js";
import { studioContextSchema } from "./studio.js";
import { idSchema, type WorkspaceContext } from "./workspace.js";

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
