import { z } from "zod";
import { socialScopes, tikTokCreatorSchema, type SocialConfig, type SocialConnection, type SocialDestination,
  type SocialProviderId, type TikTokCreator } from "../../../packages/domain/src/social.js";
import { WorkspaceError } from "../../../packages/storage/src/config.js";

export const SOCIAL_API = { x: "https://api.x.com", linkedin: "https://api.linkedin.com", tiktok: "https://open.tiktokapis.com" } as const;
export class SocialRemoteError extends WorkspaceError {
  constructor(status: number, code: string, readonly uncertain = false, readonly retryAt: number | null = null) { super(status, code); }
}
export const socialTokenSchema = z.object({ accessToken: z.string().min(1).max(8192), refreshToken: z.string().min(1).max(8192).nullable(),
  expiresAt: z.number().finite(), refreshExpiresAt: z.number().finite().nullable(), scopes: z.array(z.string().min(1).max(255)).max(100),
  subjectHint: z.string().max(255).nullable() }).strict();
export type SocialTokens = z.infer<typeof socialTokenSchema>;
export const socialCredentialSchema = z.object({ config: z.object({ provider: z.enum(["x", "linkedin", "tiktok"]), clientId: z.string(), clientSecret: z.string().optional(),
  callbackPort: z.number(), nativePkceEnabled: z.boolean(), loopbackApproved: z.boolean(), organizationAccess: z.boolean(), publicApp: z.boolean(), audited: z.boolean() }).strict(),
  tokens: socialTokenSchema }).strict();
export type SocialCredential = z.infer<typeof socialCredentialSchema>;
export interface SocialIdentity { subject: string; destinations: SocialDestination[]; creator: TikTokCreator | null }
const identifier = z.string().min(1).max(255).regex(/^[A-Za-z0-9_.:-]+$/);
const numericId = z.string().regex(/^[0-9]{1,25}$/);
const label = z.string().min(1).max(1000);
const tokenReply = z.object({ access_token: z.string().min(1).max(8192), refresh_token: z.string().min(1).max(8192).optional(),
  expires_in: z.number().int().positive().max(366 * 86400), refresh_expires_in: z.number().int().positive().max(400 * 86400).optional(),
  scope: z.string().min(1).max(8192).optional(), open_id: identifier.optional() });
export function socialOutput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new SocialRemoteError(502, "social_invalid_response"); return parsed.data;
}
/** Preserve remote int64 IDs without matching numbers inside JSON strings. */
export function parseSocialJson(text: string): unknown {
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token.startsWith('"') || !/^-?\d+$/.test(token)) return token;
    return Number.isSafeInteger(Number(token)) ? token : JSON.stringify(token);
  })) as unknown;
}
const TIKTOK_CODES: Record<string, string> = {
  access_token_invalid: "social_reauth_required", scope_not_authorized: "social_missing_scope", invalid_grant: "social_reauth_required",
  invalid_publish_id: "social_receipt_missing", token_not_authorized_for_specified_publish_id: "social_destination_mismatch",
  rate_limit_exceeded: "social_rate_limited", spam_risk_too_many_posts: "social_daily_cap", reached_active_user_cap: "social_creator_cap",
  spam_risk_user_banned_from_posting: "social_posting_banned", privacy_level_option_mismatch: "social_privacy_changed",
  unaudited_client_can_only_post_to_private_accounts: "social_tiktok_audit_required", url_ownership_unverified: "social_url_not_verified",
  invalid_param: "social_invalid_metadata", invalid_request: "social_invalid_request"
};
export function socialUploadUrl(provider: SocialProviderId, raw: string): string {
  try {
    if (raw.length > 8192 || /[\s\\]/.test(raw)) throw new Error();
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash) throw new Error();
    const allowed = provider === "linkedin" ? u.hostname === "www.linkedin.com" && u.pathname.startsWith("/dms-uploads/")
      : provider === "tiktok" && /^(?:open-upload|upload\.[a-z]{2})\.tiktokapis\.com$/.test(u.hostname) && /^\/(video|upload)\/$/.test(u.pathname);
    if (!allowed) throw new Error(); return raw;
  } catch { throw new SocialRemoteError(502, "social_invalid_upload_url"); }
}
export class SocialProvider {
  constructor(private readonly transport: typeof fetch = fetch, private readonly clock: () => number = Date.now) {}
  async request(url: string, init: RequestInit, signal: AbortSignal, uncertain = false, readJson = true): Promise<{ value: unknown; headers: Headers; status: number }> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    let response: Response | null = null;
    try {
      bounded.throwIfAborted();
      response = await this.transport(url, { ...init, redirect: "error", signal: bounded });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new SocialRemoteError(502, "social_redirect_rejected", uncertain);
      let value: unknown = null;
      if (readJson || !response.ok) {
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        const abort = () => { void reader?.cancel().catch(() => undefined); };
        bounded.addEventListener("abort", abort, { once: true });
        try {
          const length = response.headers.get("Content-Length");
          if (length && (!/^\d+$/.test(length) || Number(length) > 1024 * 1024)) throw new Error();
          if (reader) while (true) { bounded.throwIfAborted(); const part = await reader.read(); if (part.done) break;
            size += part.value.length; if (size > 1024 * 1024) throw new Error(); chunks.push(part.value); }
          bounded.throwIfAborted();
          if (size) { try { value = parseSocialJson(Buffer.concat(chunks).toString("utf8")); } catch { if (response.ok && readJson) throw new Error(); } }
          else if (response.ok && readJson) throw new Error();
        } finally { bounded.removeEventListener("abort", abort); await reader?.cancel().catch(() => undefined); }
      } else await response.body?.cancel();
      bounded.throwIfAborted();
      const envelope = z.object({ error: z.union([z.string(), z.object({ code: z.string() })]).optional() }).safeParse(value);
      const errorCode = envelope.success ? typeof envelope.data.error === "string" ? envelope.data.error : envelope.data.error?.code : undefined;
      if (!response.ok || (errorCode && errorCode !== "ok")) {
        const reset = Number(response.headers.get("x-rate-limit-reset")), retry = Number(response.headers.get("retry-after"));
        const retryAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Number.isFinite(retry) && retry > 0 ? this.clock() + Math.min(retry, 86400) * 1000 : null;
        const code = errorCode && TIKTOK_CODES[errorCode] || (response.status === 401 ? "social_reauth_required" : response.status === 403 ? "social_access_denied" : response.status === 429 ? "social_rate_limited" : response.status >= 500 ? "social_unavailable" : "social_request_failed");
        throw new SocialRemoteError(response.status >= 400 ? response.status : 409, code, uncertain && (response.status >= 500 || response.status === 408), retryAt);
      }
      return { value, headers: response.headers, status: response.status };
    } catch (e) {
      await response?.body?.cancel().catch(() => undefined);
      if (e instanceof SocialRemoteError) throw e;
      throw new SocialRemoteError(502, "social_unavailable", uncertain);
    }
  }
  async api(provider: SocialProviderId, path: string, token: string, method: "GET" | "POST", body: unknown,
    signal: AbortSignal, uncertain = false, readJson = true) {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new WorkspaceError(400, "social_invalid_request");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" };
    if (provider === "linkedin") Object.assign(headers, { "LinkedIn-Version": "202610", "X-Restli-Protocol-Version": "2.0.0" });
    return this.request(`${SOCIAL_API[provider]}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, signal, uncertain, readJson);
  }
  async tokens(config: SocialConfig, fields: Record<string, string>, signal: AbortSignal, previous?: SocialTokens): Promise<SocialTokens> {
    const url = config.provider === "x" ? "https://api.x.com/2/oauth2/token" : config.provider === "linkedin"
      ? "https://www.linkedin.com/oauth/v2/accessToken" : "https://open.tiktokapis.com/v2/oauth/token/";
    const body = new URLSearchParams({ [config.provider === "tiktok" ? "client_key" : "client_id"]: config.clientId,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}), ...fields });
    const { value } = await this.request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, signal);
    const v = socialOutput(tokenReply, value);
    const scopes = v.scope ? [...new Set(v.scope.split(/[\s,]+/).filter(Boolean))].sort() : previous?.scopes;
    // Native LinkedIn's documented token response can omit scope. The native grant is all-or-nothing.
    const granted = scopes ?? (config.provider === "linkedin" ? socialScopes(config) : null);
    if (!granted || !socialScopes(config).every(s => granted.includes(s))) throw new SocialRemoteError(409, "social_missing_scope");
    if (config.provider !== "linkedin" && !v.refresh_token && !previous?.refreshToken) throw new SocialRemoteError(409, "social_refresh_missing");
    return { accessToken: v.access_token, refreshToken: v.refresh_token ?? previous?.refreshToken ?? null, expiresAt: this.clock() + v.expires_in * 1000,
      refreshExpiresAt: v.refresh_expires_in ? this.clock() + v.refresh_expires_in * 1000 : previous?.refreshExpiresAt ?? null,
      scopes: granted, subjectHint: v.open_id ?? previous?.subjectHint ?? null };
  }
  async identity(config: SocialConfig, tokens: SocialTokens, signal: AbortSignal): Promise<SocialIdentity> {
    if (config.provider === "x") {
      const r = socialOutput(z.object({ data: z.object({ id: numericId, name: label, username: label }) }), (await this.api("x", "/2/users/me", tokens.accessToken, "GET", undefined, signal)).value);
      return { subject: r.data.id, destinations: [{ id: r.data.id, label: `${r.data.name} (@${r.data.username})`, kind: "user" }], creator: null };
    }
    if (config.provider === "tiktok") {
      const r = socialOutput(z.object({ data: z.object({ user: z.object({ open_id: identifier, display_name: label }) }) }),
        (await this.api("tiktok", "/v2/user/info/?fields=open_id,display_name", tokens.accessToken, "GET", undefined, signal)).value);
      if (tokens.subjectHint !== r.data.user.open_id) throw new SocialRemoteError(409, "social_identity_mismatch");
      return { subject: r.data.user.open_id, destinations: [{ id: r.data.user.open_id, label: r.data.user.display_name, kind: "user" }], creator: null };
    }
    const user = socialOutput(z.object({ sub: identifier, name: label }), (await this.api("linkedin", "/v2/userinfo", tokens.accessToken, "GET", undefined, signal)).value);
    const destinations: SocialDestination[] = [{ id: `urn:li:person:${user.sub}`, label: user.name, kind: "member" }];
    if (config.organizationAccess) {
      // Fail closed on incomplete pagination; never pick the first organization implicitly.
      let start = 0; let complete = false;
      for (let page = 0; page < 20; page++) {
        const result = socialOutput(z.object({ elements: z.array(z.object({ organization: identifier.optional(), organizationTarget: identifier.optional(),
          roleAssignee: identifier, role: z.string().max(100), state: z.string().max(100) })).max(100),
          paging: z.object({ links: z.array(z.object({ rel: z.string(), href: z.string().max(4096) })).optional() }).optional() }),
          (await this.api("linkedin", `/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100&start=${start}`, tokens.accessToken, "GET", undefined, signal)).value);
        for (const acl of result.elements) {
          const id = acl.organization ?? acl.organizationTarget;
          if (acl.roleAssignee !== `urn:li:person:${user.sub}` || acl.state !== "APPROVED" || !["ADMINISTRATOR", "CONTENT_ADMINISTRATOR", "CONTENT_ADMIN"].includes(acl.role)) continue;
          if (!id || !/^urn:li:organization:\d+$/.test(id)) throw new SocialRemoteError(502, "social_invalid_response");
          if (!destinations.some(d => d.id === id)) destinations.push({ id, label: id, kind: "organization" });
        }
        if (!result.paging?.links?.some(l => l.rel === "next")) { complete = true; break; }
        start += 100;
      }
      if (!complete) throw new SocialRemoteError(502, "social_incomplete_destinations");
    }
    return { subject: user.sub, destinations, creator: null };
  }
  async creator(token: string, signal: AbortSignal): Promise<TikTokCreator> {
    const v = socialOutput(z.object({ data: tikTokCreatorSchema }), (await this.api("tiktok", "/v2/post/publish/creator_info/query/", token, "POST", undefined, signal)).value); return v.data;
  }
  async verify(config: SocialConfig, tokens: SocialTokens, connection: SocialConnection, signal: AbortSignal): Promise<SocialIdentity> {
    const identity = await this.identity(config, tokens, signal);
    if (identity.subject !== connection.subjectId) throw new SocialRemoteError(409, "social_identity_mismatch");
    if (!identity.destinations.some(d => d.id === connection.destinationId)) throw new SocialRemoteError(403, "social_destination_permission_lost");
    return identity;
  }
  async revoke(config: SocialConfig, token: string, signal: AbortSignal): Promise<void> {
    if (config.provider === "linkedin") throw new WorkspaceError(409, "social_linkedin_remote_revoke_unavailable");
    const url = config.provider === "x" ? "https://api.x.com/2/oauth2/revoke" : "https://open.tiktokapis.com/v2/oauth/revoke/";
    await this.request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
      [config.provider === "x" ? "client_id" : "client_key"]: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}), token
    }) }, signal, false, false);
  }
}
