import { z } from "zod";
import { studioContextSchema } from "./studio.js";
import { editSchema } from "./media.js";
import { idSchema } from "./workspace.js";

export const clipOptionsSchema = z.object({
  minSeconds: z.number().finite().min(2).max(180), targetSeconds: z.number().finite().min(2).max(180),
  maxSeconds: z.number().finite().min(2).max(180), count: z.number().int().min(1).max(8),
  model: z.string().min(1).max(400).nullable(), includeTranscript: z.boolean(), includeHistory: z.boolean()
}).strict().refine(v => v.minSeconds <= v.targetSeconds && v.targetSeconds <= v.maxSeconds)
  .refine(v => !v.model || v.includeTranscript, { message: "AI ranking requires explicit transcript consent" });
export const clipRequestSchema = z.object({ context: studioContextSchema, destinationId: z.string().min(1).max(300),
  artifactId: idSchema, options: clipOptionsSchema }).strict();
export const clipRankingSchema = z.object({ ranking: z.array(z.object({ id: idSchema,
  reason: z.string().trim().min(1).max(600) }).strict()).min(1).max(8) }).strict();
export const clipCorrectionSchema = z.object({ context: studioContextSchema, expectedRevision: z.number().int().nonnegative(),
  candidateId: idSchema, edit: editSchema }).strict();
export interface ClipSignals { scenes: number[]; silences: { start: number; end: number }[] }
export interface ClipCandidate {
  id: string; score: number; reason: string | null; edit: z.infer<typeof editSchema>;
  evidence: { start: number; end: number; partialSpeech: boolean; segmentTimes: { start: number; end: number }[];
    segmentIndices: number[]; excerpt: string; scenes: number[]; speechRatio: number; historyOverlap: number; sentenceBoundary: boolean };
  renderId: string | null; artifactId: string | null; publicationId: string | null;
  renderError?: string | null;
}
export interface ClipAnalysis {
  id: string; context: z.infer<typeof studioContextSchema>; destinationId: string; artifactId: string;
  sourceSha256: string; transcriptId: string; transcriptSha256: string; language: string;
  baseRevision: number; revision: number; algorithm: "clips-v1"; options: z.infer<typeof clipOptionsSchema>;
  state: "running" | "ready" | "failed" | "cancelled"; stage: "analysis" | "render";
  candidates: ClipCandidate[]; signals: ClipSignals; history: { revision: number; channelVideoId: string | null };
  sessionId: string | null; truncated: boolean; error: string | null; createdAt: string; cancelRequested?: boolean;
}
