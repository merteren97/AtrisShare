import { z } from "zod";
import { contextSchema, idSchema, type WorkspaceContext } from "./workspace.js";
import type { MediaEdit, MediaProbe } from "./media.js";

export const studioContextSchema = contextSchema.extend({ projectId: idSchema }).strict();
export const publicationInputSchema = z.object({
  context: studioContextSchema, artifactId: idSchema,
  title: z.string().trim().min(1).max(100).regex(/^[^<>\u0000-\u001f]*$/u),
  description: z.string().max(5000).regex(/^[^<>\u0000]*$/u),
  visibility: z.enum(["private", "unlisted", "public"]),
  madeForKids: z.boolean(), notifySubscribers: z.boolean()
}).strict();
export type PublicationInput = z.infer<typeof publicationInputSchema>;
export interface StudioArtifact {
  id: string; accountId: string; projectId: string; filename: string; sha256: string; bytes: number;
  mimeType: string; probe: MediaProbe | null; sourceId: string | null; channelVideoId: string | null; createdAt: string;
}
export interface PublicationPayload {
  version: 1; accountId: string; projectId: string; destinationId: string; artifactId: string; sha256: string;
  bytes: number; mimeType: string; title: string; description: string; visibility: "private" | "unlisted" | "public";
  madeForKids: boolean; notifySubscribers: boolean;
}
export interface StudioPublication {
  id: string; context: WorkspaceContext; revision: 1; payload: PublicationPayload; digest: string;
  state: "review" | "uploading" | "uncertain" | "processing" | "succeeded" | "failed" | "cancelled";
  approvalExpiresAt: string | null; progress: number; videoId: string | null; error: string | null; createdAt: string;
}
export interface StudioTimeline { revision: number; cursor: number; edits: MediaEdit[] }
export interface StudioRender {
  id: string; sourceId: string; state: "running" | "succeeded" | "failed" | "cancelled";
  progress: number; error: string | null; artifactId: string | null;
}
