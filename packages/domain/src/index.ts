/** Runtime models plus future cross-platform contracts; unimplemented ports remain explicitly documented. */
export { editSchema, segmentSchema, mediaProbeSchema, type MediaEdit, type MediaProbe } from "./media.js";
export { publicationInputSchema, studioContextSchema, type StudioArtifact, type StudioPublication,
  type StudioTimeline, type StudioRender, type PublicationPayload, type PublicationInput } from "./studio.js";
export * from "./workspace.js";
export * from "./youtube.js";
export { aiScopeSchema, aiRequestSchema, aiProposalSchema, type AiRun } from "./ai.js";
export { transcriptSchema, transcriptSegmentSchema, transcriptionErrorSchema, type Transcript, type TranscriptSegment } from "./transcription.js";
export { clipOptionsSchema, clipRequestSchema, clipCorrectionSchema, clipRankingSchema, type ClipAnalysis, type ClipCandidate, type ClipSignals } from "./clips.js";
export const SOCIAL_PLATFORMS = ["youtube", "x", "tiktok", "linkedin"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export type IsoTimestamp = string;
export type AccountId = string;
export type ProjectId = string;

/** An OAuth identity and its exact publishing destination are distinct. */
export interface ConnectedAccount {
  id: AccountId;
  platform: SocialPlatform;
  providerSubjectId: string;
  destinationId: string;
  displayName: string;
  status: "connected" | "reauth-required" | "disconnected";
  grantedScopes: readonly string[];
  credentialRef: string;
  verifiedAt: IsoTimestamp;
}

/** Retrieved only for an explicit account/project; never contains raw tokens. */
export interface AccountMemoryEntry {
  id: string;
  accountId: AccountId;
  projectId: ProjectId | null;
  kind: "brand-voice" | "audience" | "decision" | "edit-history" | "publication";
  text: string;
  provenance: { sourceId: string; recordedAt: IsoTimestamp };
  reviewState: "suggested" | "confirmed";
}

export interface MediaArtifact {
  id: string;
  projectId: ProjectId;
  revision: number;
  sha256: string;
  localPath: string;
  kind: "source" | "proxy" | "transcript" | "render" | "thumbnail";
}

/** Per-destination snapshot; edits must create a new revision/digest. */
export interface PublicationIntent {
  id: string;
  projectId: ProjectId;
  accountId: AccountId;
  platform: SocialPlatform;
  destinationId: string;
  revision: number;
  format: "text" | "video" | "short-video";
  text: string;
  title: string | null;
  visibility: "public" | "unlisted" | "private";
  media: readonly { artifactId: string; revision: number; sha256: string }[];
  scheduledFor: IsoTimestamp | null;
  payloadDigest: string;
}

/** Approval is bound to the complete immutable intent, not a UI selection. */
export interface PublicationApproval {
  id: string;
  intentId: string;
  accountId: AccountId;
  destinationId: string;
  revision: number;
  payloadDigest: string;
  decision: "approved" | "rejected";
  decidedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  actorId: string;
}

/** Each recurring occurrence creates its own intent, job and approval request. */
export type ScheduleRule =
  | { kind: "once"; at: IsoTimestamp; timeZone: string }
  | {
      kind: "daily" | "weekly";
      timeZone: string;
      localTime: string;
      /** ISO weekday 1–7; daily rules use all days. */
      weekdays: readonly number[];
      startsOn: string;
      endsOn: string | null;
      missedRun: "skip" | "ask";
    };

export type PublicationJobState =
  | "scheduled"
  | "awaiting-approval"
  | "ready"
  | "publishing"
  | "published"
  | "rejected"
  | "expired"
  | "failed"
  | "reconciling"
  | "cancelled";

export interface PublicationJob {
  id: string;
  intentId: string;
  accountId: AccountId;
  state: PublicationJobState;
  dueAt: IsoTimestamp;
  approvalId: string | null;
  idempotencyKey: string;
  attemptCount: number;
  providerPublicationId: string | null;
}

export interface ConnectorCapabilities {
  platform: SocialPlatform;
  text: boolean;
  video: boolean;
  shortVideo: boolean;
  channelRead: boolean;
  remoteScheduling: boolean;
}

/** Satisfied by the gateway after trusted runtime checks, never by an AI client. */
export interface AuthorizedPublication {
  intent: PublicationIntent;
  approvalId: string;
  idempotencyKey: string;
}

/** Internal port. It must not be exposed as an MCP tool. */
export interface SocialConnector {
  readonly platform: SocialPlatform;
  capabilities(account: ConnectedAccount): Promise<ConnectorCapabilities>;
  verifyDestination(account: ConnectedAccount): Promise<{ destinationId: string; scopes: readonly string[] }>;
  publish(request: AuthorizedPublication): Promise<{ providerPublicationId: string }>;
}

export interface AiRuntimeAdapter {
  readonly id: string;
  probe(): Promise<{ installed: boolean; version: string | null; supportsMcp: boolean }>;
  discoverModels(profileId: string): Promise<readonly { id: string; label: string }[]>;
  start(request: {
    accountId: AccountId;
    projectId: ProjectId;
    profileId: string;
    modelId: string;
    prompt: string;
    allowedTools: readonly MediaToolName[];
  }): Promise<{ sessionId: string }>;
  cancel(sessionId: string): Promise<void>;
}

/** Planned tool vocabulary, not an implemented MCP server or tool registry. */
export const MEDIA_TOOL_NAMES = [
  "media.inspect",
  "media.transcribe",
  "clips.suggest",
  "timeline.propose",
  "render.preview",
  "draft.prepare",
  "publication.request-approval"
] as const;
export type MediaToolName = (typeof MEDIA_TOOL_NAMES)[number];

/** Manual editor and AI proposals use the same non-destructive operations. */
export type TimelineOperation =
  | { kind: "trim"; sourceArtifactId: string; startMs: number; endMs: number }
  | { kind: "crop"; aspectRatio: "9:16" | "16:9" | "1:1"; focusX: number; focusY: number }
  | { kind: "caption"; startMs: number; endMs: number; text: string }
  | { kind: "audio-gain"; decibels: number };

export interface EditProposal {
  id: string;
  projectId: ProjectId;
  baseTimelineRevision: number;
  operations: readonly TimelineOperation[];
  origin: "manual" | "ai";
  status: "proposed" | "accepted" | "rejected";
}

export interface ClipSuggestion {
  id: string;
  sourceArtifactId: string;
  startMs: number;
  endMs: number;
  rationale: string;
  evidence: readonly { atMs: number; transcriptExcerpt: string }[];
  score: number;
  modelId: string;
  analysisRevision: string;
}
