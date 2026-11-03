import { z } from "zod";
import { idSchema } from "./workspace.js";
import { mediaProbeSchema } from "./media.js";
import { scheduleBindingSchema } from "./scheduling.js";

export const socialProviderSchema = z.enum(["x", "linkedin", "tiktok"]);
export type SocialProviderId = z.infer<typeof socialProviderSchema>;
export const socialContextSchema = z.object({ accountId: idSchema, projectId: idSchema }).strict();
export type SocialContext = z.infer<typeof socialContextSchema>;
export const socialDestinationSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_:.-]+$/);
export const socialTargetSchema = socialContextSchema.extend({ destinationId: socialDestinationSchema }).strict();
export type SocialTarget = z.infer<typeof socialTargetSchema>;
const opaque = z.string().min(1).max(2048).regex(/^[^\s\u0000-\u001f]+$/);
export const socialConfigSchema = z.object({
  provider: socialProviderSchema, clientId: opaque, clientSecret: opaque.optional(),
  callbackPort: z.number().int().min(0).max(65535).default(0),
  nativePkceEnabled: z.boolean().default(false), loopbackApproved: z.boolean().default(false),
  organizationAccess: z.boolean().default(false), publicApp: z.boolean().default(false),
  audited: z.boolean().default(false)
}).strict().superRefine((v, c) => {
  if (v.provider === "x" && (v.clientSecret || v.callbackPort < 1024)) c.addIssue({ code: "custom", message: "X requires a public native client and a fixed registered port" });
  if (v.provider === "tiktok" && !v.clientSecret) c.addIssue({ code: "custom", message: "TikTok requires a developer-owned client secret" });
  if (v.provider === "linkedin" && v.clientSecret) c.addIssue({ code: "custom", message: "This adapter supports enabled native PKCE only" });
});
export type SocialConfig = z.infer<typeof socialConfigSchema>;
export function socialScopes(config: SocialConfig): string[] {
  if (config.provider === "x") return ["tweet.read", "users.read", "tweet.write", "media.write", "offline.access"];
  if (config.provider === "tiktok") return ["user.info.basic", "video.publish"];
  return ["openid", "profile", "w_member_social", ...(config.organizationAccess ? ["r_organization_admin", "w_organization_social", "r_organization_social"] : [])];
}
export function socialSetupBlock(config: SocialConfig): string | null {
  if (config.provider === "linkedin" && !config.nativePkceEnabled) return "social_linkedin_native_not_enabled";
  if (config.provider === "x" && !config.loopbackApproved) return "social_x_redirect_not_approved";
  return null;
}
export interface SocialSetup { provider: SocialProviderId; configured: boolean; available: boolean; reason: string | null; scopes: string[]; audited: boolean; publicApp: boolean }
export interface SocialDestination { id: string; label: string; kind: "user" | "member" | "organization" }
export interface SocialAccount {
  accountId: string; provider: SocialProviderId; destinationId: string; displayName: string;
  destinationKind: SocialDestination["kind"]; subjectId: string; scopes: string[]; verifiedAt: string;
  status: "connected" | "reauth-required" | "disconnected"; revision: number;
}
/** Internal only. Never return this record over HTTP. */
export interface SocialConnection extends SocialAccount {
  credentialRef: string | null; tokenRevision: number; configRevision: number; appKey: string; grantEpoch: number;
}
export interface SocialSession {
  id: string; provider: SocialProviderId; state: "awaiting-browser" | "verifying" | "select-destination" | "connected" | "failed" | "cancelled" | "expired";
  expiresAt: string; browserOpened: boolean; destinations: SocialDestination[]; accountId: string | null; error: string | null;
}
export const socialStartSchema = z.object({ provider: socialProviderSchema, accountId: idSchema.optional(),
  expectedDestinationId: socialDestinationSchema.optional() }).strict();
export type SocialStart = z.infer<typeof socialStartSchema>;
export const socialAccountActionSchema = z.object({ accountId: idSchema, destinationId: socialDestinationSchema }).strict();
export type SocialAccountAction = z.infer<typeof socialAccountActionSchema>;
export const tikTokPrivacySchema = z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]);
export const tikTokCreatorSchema = z.object({ creator_nickname: z.string().min(1).max(255), creator_username: z.string().min(1).max(255),
  privacy_level_options: z.array(tikTokPrivacySchema).min(1).max(4), comment_disabled: z.boolean(), duet_disabled: z.boolean(),
  stitch_disabled: z.boolean(), max_video_post_duration_sec: z.number().int().positive().max(86400) });
export type TikTokCreator = z.infer<typeof tikTokCreatorSchema>;
export interface SocialCapabilities {
  provider: SocialProviderId; destinationId: string; verifiedAt: string;
  text: boolean; video: boolean; readback: boolean; reasons: string[];
  creator: TikTokCreator | null; maxBytes: number; maxDuration: number;
}
const text = z.string().max(10000).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u)
  .refine(v => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v));
export const socialMetadataSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("x"), text, paidPartnership: z.boolean(), madeWithAi: z.boolean() }).strict(),
  z.object({ provider: z.literal("linkedin"), text, title: z.string().max(200), visibility: z.enum(["PUBLIC", "CONNECTIONS"]), reshareDisabled: z.boolean() }).strict(),
  z.object({ provider: z.literal("tiktok"), text: text.refine(v => v.length <= 2200), privacy: tikTokPrivacySchema,
    allowComment: z.boolean(), allowDuet: z.boolean(), allowStitch: z.boolean(), disclosure: z.boolean(),
    ownBrand: z.boolean(), brandedContent: z.boolean(), madeWithAi: z.boolean(), musicConsent: z.literal(true),
    brandedConsent: z.boolean() }).strict()
]).superRefine((v, c) => {
  if (v.provider === "tiktok" && ((v.disclosure && !v.ownBrand && !v.brandedContent) ||
    (!v.disclosure && (v.ownBrand || v.brandedContent)) || (v.brandedContent && (v.privacy === "SELF_ONLY" || !v.brandedConsent)))) {
    c.addIssue({ code: "custom", message: "TikTok disclosure consent or visibility is invalid" });
  }
  if (v.provider === "linkedin" && (!v.text.trim() || v.text.length > 3000)) c.addIssue({ code: "custom", message: "LinkedIn commentary required, at most 3000 characters" });
});
export type SocialMetadata = z.infer<typeof socialMetadataSchema>;
export const socialMediaInputSchema = z.object({ context: socialContextSchema, artifactId: idSchema }).strict();
export const socialDraftSchema = z.object({ target: socialTargetSchema, metadata: socialMetadataSchema,
  media: socialMediaInputSchema.nullable() }).strict().superRefine((v, c) => {
  if (v.metadata.provider === "tiktok" && !v.media) c.addIssue({ code: "custom", message: "TikTok requires video" });
  if (v.metadata.provider === "x" && !v.media && !v.metadata.text.trim()) c.addIssue({ code: "custom", message: "Text or media required" });
});
export type SocialDraft = z.infer<typeof socialDraftSchema>;
export const socialMediaSchema = socialMediaInputSchema.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(16 * 1024 ** 3),
  mimeType: z.enum(["video/mp4", "video/webm", "video/quicktime"]), probe: mediaProbeSchema }).strict();
export const socialPayloadSchema = z.object({ version: z.literal(1), target: socialTargetSchema, metadata: socialMetadataSchema,
  media: socialMediaSchema.nullable(), subjectId: socialDestinationSchema, connectionRevision: z.number().int().positive(),
   appKey: z.string().regex(/^[a-f0-9]{64}$/), scheduleBinding: scheduleBindingSchema.optional() }).strict();
export type SocialPayload = z.infer<typeof socialPayloadSchema>;
export type SocialPostState = "review" | "uploading" | "processing" | "accepted" | "succeeded" | "failed" | "uncertain" | "cancelled";
export interface SocialReceipt { jobId: string | null; mediaId: string | null; postIds: string[]; providerState: string | null; publicUrl: string | null }
export interface SocialPost {
  id: string; payload: SocialPayload; digest: string; state: SocialPostState; receipt: SocialReceipt;
  approvalExpiresAt: string | null; progress: number; error: string | null; createdAt: string; updatedAt: string; dispatchRevoked: boolean;
}
export const socialPostActionSchema = z.object({ target: socialTargetSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), tiktokConsent: z.literal(true).optional() }).strict();
/** Conservative standalone validation: URLs/compound emoji may be over-counted, never shortened heuristically. */
export function socialXTextWeight(value: string): number {
  return [...value.normalize("NFC")].reduce((sum, ch) => { const n = ch.codePointAt(0)!;
    return sum + (n <= 0x10ff || (n >= 0x2000 && n <= 0x200d) || (n >= 0x2010 && n <= 0x201f) || (n >= 0x2032 && n <= 0x2037) ? 1 : 2); }, 0);
}

export const socialTextRequestSchema = z.object({
  requestId: idSchema, context: socialContextSchema, target: socialTargetSchema,
  modelId: z.string().max(384).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u),
  instruction: text.trim().min(1).max(2000), text, includeMemory: z.boolean(), allowRemote: z.literal(true)
}).strict().superRefine((v, c) => {
  if (v.context.accountId !== v.target.accountId || v.context.projectId !== v.target.projectId) {
    c.addIssue({ code: "custom", message: "Text assistance context must be the explicit target project" });
  }
});
export type SocialTextRequest = z.infer<typeof socialTextRequestSchema>;
export const socialTextCancelSchema = z.object({ requestId: idSchema, context: socialContextSchema, target: socialTargetSchema }).strict();
export interface SocialTextSetup {
  available: boolean; version: string | null; models: string[]; auth: "cli-managed"; error: string | null;
  catalog?: { state: "current" | "stale"; refreshedAt: string | null };
  maxTextChars: number; maxInstructionChars: number; maxOutputChars: number;
  memoryScope: "target-project-confirmed-only";
}
/** Ephemeral immutable suggestion. It is not a publication, approval, timeline edit or credential. */
export interface SocialTextSuggestion {
  readonly version: 1; readonly id: string; readonly context: Readonly<SocialContext>; readonly target: Readonly<SocialTarget>;
  readonly provider: SocialProviderId; readonly modelId: string; readonly text: string; readonly summary: string;
  readonly sourceTextDigest: string; readonly instructionDigest: string; readonly includeMemory: boolean;
  readonly memoryDigest: string; readonly memoryCount: number; readonly memoryTruncated: boolean;
  readonly sessionId: string | null; readonly createdAt: string; readonly digest: string;
}
