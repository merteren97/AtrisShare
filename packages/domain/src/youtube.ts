import { z } from "zod";
import { idSchema } from "./workspace.js";

export const YOUTUBE_SCOPES = ["openid", "https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"] as const;
export const channelIdSchema = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/);
export const startYouTubeSchema = z.object({
  expectedChannelId: channelIdSchema,
  accountId: idSchema.optional()
}).strict();
export const youtubeAccountSchema = z.object({ accountId: idSchema, destinationId: channelIdSchema }).strict();
export type StartYouTubeInput = z.infer<typeof startYouTubeSchema>;
export type YouTubeAccountInput = z.infer<typeof youtubeAccountSchema>;
export interface YouTubeSetup {
  configured: boolean;
  available: boolean;
  scopes: readonly string[];
}
export interface YouTubeSession {
  id: string;
  expectedChannelId: string;
  state: "awaiting-browser" | "verifying" | "connected" | "failed" | "cancelled" | "expired";
  expiresAt: string;
  accountId: string | null;
  error: string | null;
  browserOpened: boolean;
}

/** Internal persistence record, never returned by the local API. */
export interface YouTubeConnection {
  accountId: string;
  providerSubjectId: string;
  destinationId: string;
  credentialRef: string | null;
  grantedScopes: string[];
  verifiedAt: string;
  revision: number;
}
