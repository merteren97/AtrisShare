import { z } from "zod";

export const APP_VERSION = "0.1.0-preview.1";
export const idSchema = z.uuid();
export const platformSchema = z.enum(["youtube", "x", "tiktok", "linkedin"]);
const nameSchema = z.string().trim().min(1).max(100);
export const contextSchema = z.object({ accountId: idSchema, projectId: idSchema.nullable() }).strict();
export const createAccountSchema = z.object({ displayName: nameSchema, platform: platformSchema }).strict();
export const createProjectSchema = z.object({
  accountId: idSchema, name: nameSchema, description: z.string().trim().max(500).default("")
}).strict();
export const memoryKindSchema = z.enum(["brand-voice", "audience", "decision", "edit-history", "publication"]);
export const reviewStateSchema = z.enum(["suggested", "confirmed"]);
const memoryFields = {
  kind: memoryKindSchema,
  text: z.string().trim().min(1).max(4000),
  reviewState: reviewStateSchema
};
export const createMemorySchema = z.object({ context: contextSchema, ...memoryFields }).strict();
export const updateMemorySchema = z.object({
  context: contextSchema, ...memoryFields, expectedRevision: z.number().int().positive()
}).strict();
export const deleteMemorySchema = z.object({
  context: contextSchema, expectedRevision: z.number().int().positive()
}).strict();

export type WorkspaceContext = z.infer<typeof contextSchema>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;

export interface WorkspaceAccount {
  id: string;
  displayName: string;
  platform: z.infer<typeof platformSchema>;
  destinationId: string;
  status: "demo" | "connected" | "reauth-required" | "disconnected";
  createdAt: string;
  connection?: { providerSubjectId: string; grantedScopes: string[]; verifiedAt: string };
}
export interface WorkspaceProject {
  id: string;
  accountId: string;
  name: string;
  description: string;
  createdAt: string;
}
export interface WorkspaceMemory {
  id: string;
  accountId: string;
  projectId: string | null;
  kind: z.infer<typeof memoryKindSchema>;
  text: string;
  reviewState: z.infer<typeof reviewStateSchema>;
  revision: number;
  provenance: { sourceId: string; origin: "manual"; recordedAt: string };
  updatedAt: string;
}
export interface AuditEvent {
  id: string;
  accountId: string;
  projectId: string | null;
  action: string;
  entityId: string;
  actor: "local-user";
  recordedAt: string;
}
export interface VaultStatus {
  available: boolean;
  provider: "windows-dpapi" | "unavailable";
}
export interface WorkspaceSnapshot {
  accounts: WorkspaceAccount[];
  context: WorkspaceContext | null;
  projects: WorkspaceProject[];
  vault: VaultStatus;
  dataDirectory: string;
  version: string;
}
export interface RuntimeConfig { origin: string; token: string }
