import { z } from "zod";
import { channelIdSchema, YOUTUBE_SCOPES } from "../../../packages/domain/src/youtube.js";
import { WorkspaceError } from "../../../packages/storage/src/config.js";

export interface GoogleDesktopClient { clientId: string; clientSecret?: string }
export const googleDesktopClientSchema = z.object({
  clientId: z.string().max(256).regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/).refine(value => !/\s/.test(value)),
  clientSecret: z.string().min(1).max(500).regex(/^[A-Za-z0-9_-]+$/).refine(value => !/\s/.test(value)).optional()
}).strict().transform((value): GoogleDesktopClient => ({ clientId: value.clientId, ...(value.clientSecret ? { clientSecret: value.clientSecret } : {}) }));
export function desktopClientFromEnv(): GoogleDesktopClient | null {
  const parsed = googleDesktopClientSchema.safeParse({ clientId: process.env.ATRIS_SHARE_YOUTUBE_CLIENT_ID,
    ...(process.env.ATRIS_SHARE_YOUTUBE_CLIENT_SECRET ? { clientSecret: process.env.ATRIS_SHARE_YOUTUBE_CLIENT_SECRET } : {}) });
  return parsed.success ? parsed.data : null;
}
export const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192), refresh_token: z.string().min(1).max(8192).optional(),
  token_type: z.literal("Bearer"), expires_in: z.number().int().positive().max(86400),
  scope: z.string().min(1).max(8192).optional()
});
export type GoogleTokens = z.infer<typeof tokenSchema>;
const channelSchema = z.object({ id: channelIdSchema, snippet: z.object({ title: z.string().min(1).max(1000) }) });

/** Fixed official endpoints only. Tests inject a transport, never runtime endpoint configuration. */
export class YouTubeProvider {
  constructor(private readonly transport: typeof fetch = fetch) {}
  private async request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      return await this.transport(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    } catch { throw new WorkspaceError(502, "youtube_unavailable"); }
  }
  private async json(response: Response): Promise<unknown> {
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 1024 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch { throw new WorkspaceError(502, "youtube_invalid_response"); }
  }
  async tokens(client: GoogleDesktopClient, fields: Record<string, string>, signal: AbortSignal): Promise<GoogleTokens> {
    const response = await this.request("https://oauth2.googleapis.com/token", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}), ...fields }) }, signal);
    const value = await this.json(response);
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(value);
      if (failure.success && failure.data.error === "invalid_grant") throw new WorkspaceError(409, "youtube_reauth_required");
      throw new WorkspaceError(502, "youtube_token_failed");
    }
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) throw new WorkspaceError(502, "youtube_invalid_response");
    return parsed.data;
  }
  scopes(tokens: GoogleTokens, previous?: string[]): string[] {
    const scopes = tokens.scope ? [...new Set(tokens.scope.split(/\s+/).filter(Boolean))].sort() : previous;
    if (!scopes || !YOUTUBE_SCOPES.every(scope => scopes.includes(scope))) throw new WorkspaceError(409, "youtube_missing_scope");
    return scopes;
  }
  async identity(accessToken: string, signal: AbortSignal): Promise<{ subject: string; channels: { id: string; title: string }[] }> {
    const init = { headers: { Authorization: `Bearer ${accessToken}` } };
    const user = await this.request("https://openidconnect.googleapis.com/v1/userinfo", init, signal);
    if (user.status === 401) throw new WorkspaceError(409, "youtube_reauth_required");
    if (!user.ok) throw new WorkspaceError(502, "youtube_identity_failed");
    const parsedUser = z.object({ sub: z.string().min(1).max(255) }).safeParse(await this.json(user));
    if (!parsedUser.success) throw new WorkspaceError(502, "youtube_invalid_response");
    const channels = await this.request("https://www.googleapis.com/youtube/v3/channels?part=id%2Csnippet&mine=true&maxResults=50", init, signal);
    if (channels.status === 401) throw new WorkspaceError(409, "youtube_reauth_required");
    if (channels.status === 403) throw new WorkspaceError(403, "youtube_access_denied");
    if (!channels.ok) throw new WorkspaceError(502, "youtube_unavailable");
    const parsedChannels = z.object({ items: z.array(channelSchema).max(50), nextPageToken: z.string().optional() }).safeParse(await this.json(channels));
    // Do not infer a destination when the provider returned an incomplete list.
    if (!parsedChannels.success || parsedChannels.data.nextPageToken) throw new WorkspaceError(502, "youtube_invalid_response");
    return { subject: parsedUser.data.sub, channels: parsedChannels.data.items.map(item => ({ id: item.id, title: item.snippet.title })) };
  }
  async revoke(token: string, signal: AbortSignal): Promise<void> {
    const response = await this.request("https://oauth2.googleapis.com/revoke", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }, signal);
    if (response.ok) { await response.body?.cancel(); return; }
    const error = z.object({ error: z.string() }).safeParse(await this.json(response));
    if (response.status === 400 && error.success && error.data.error === "invalid_token") return;
    throw new WorkspaceError(502, "youtube_revoke_failed");
  }
}
