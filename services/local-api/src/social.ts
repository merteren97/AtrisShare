import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { socialAccountActionSchema, socialConfigSchema, socialDraftSchema, socialMediaSchema, socialScopes, socialSetupBlock, socialStartSchema,
  socialXTextWeight, type SocialAccountAction, type SocialCapabilities, type SocialConfig, type SocialConnection, type SocialDraft,
  type SocialPost, type SocialProviderId, type SocialSession, type SocialSetup, type SocialStart, type SocialTarget } from "../../../packages/domain/src/social.js";
import { idSchema } from "../../../packages/domain/src/workspace.js";
import { SocialStore } from "../../../packages/storage/src/social-store.js";
import { WorkspaceError } from "../../../packages/storage/src/config.js";
import type { CredentialVault } from "../../../packages/storage/src/vault.js";
import { openSocialAuthorizationBrowser } from "./social-browser.js";
import { SocialProvider, SocialRemoteError, socialCredentialSchema, type SocialCredential } from "./social-provider.js";
import { SocialPublishing, type SocialMediaSnapshot } from "./social-publishing.js";

export interface SocialOptions {
  provider?: SocialProvider; publisher?: SocialPublishing; openBrowser?: (url: string) => Promise<boolean>; now?: () => number;
  /** Local, internal artifact resolver. Never supplied through HTTP. */
  mediaPath: (artifactId: string) => string;
  /** Optional official twitter-text parseTweet(...).valid adapter; default is conservative. */
  validateXText?: (text: string) => boolean;
  xTextMetrics?: (text: string) => { weightedLength: number; valid: boolean };
}
interface Pending {
  view: SocialSession; config: SocialConfig; configRevision: number; appKey: string; fenceEpoch: number;
  state: string; verifier: string; url: string; redirect: string; server: Server; timer: ReturnType<typeof setTimeout>;
  abort: AbortController; credentialRef: string | null; subject: string | null; previous: SocialConnection | null; accountId: string;
}
const PROVIDERS: SocialProviderId[] = ["x", "linkedin", "tiktok"];
const safeCode = (e: unknown) => e instanceof WorkspaceError && /^(social_[a-z_]+|vault_unavailable|runtime_closing)$/.test(e.code) ? e.code : "social_operation_failed";
const appKey = (c: SocialConfig) => createHash("sha256").update(`${c.provider}\0${c.clientId}`).digest("hex");
export class SocialService {
  private readonly provider: SocialProvider;
  private readonly publisher: SocialPublishing;
  private readonly clock: () => number;
  private readonly browser: (url: string) => Promise<boolean>;
  private readonly shutdown = new AbortController();
  private readonly pending = new Map<string, Pending>();
  private readonly configuring = new Set<SocialProviderId>();
  private readonly accountLocks = new Set<string>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly tasks = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private readonly checked = new Map<string, number>();
  private readonly owner = randomUUID();
  constructor(readonly store: SocialStore, private readonly vault: CredentialVault, private readonly options: SocialOptions) {
    this.clock = options.now ?? Date.now; this.provider = options.provider ?? new SocialProvider(fetch, this.clock);
    this.publisher = options.publisher ?? new SocialPublishing(this.provider); this.browser = options.openBrowser ?? openSocialAuthorizationBrowser;
  }
  private ready(): void {
    if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing");
    if (!this.vault.status.available) throw new WorkspaceError(409, "vault_unavailable");
  }
  private async tracked<T>(work: () => Promise<T>): Promise<T> { const p = work(); this.operations.add(p); try { return await p; } finally { this.operations.delete(p); } }
  private async config(provider: SocialProviderId): Promise<{ config: SocialConfig; revision: number }> {
    this.ready(); const record = this.store.config(provider);
    if (!record) throw new WorkspaceError(409, "social_not_configured");
    try {
      const raw = await this.vault.get(record.ref);
      if (!raw || raw.length > 32 * 1024) throw new Error();
      const config = socialConfigSchema.parse(JSON.parse(raw));
      if (config.provider !== provider || this.store.config(provider)?.revision !== record.revision) throw new Error();
      return { config, revision: record.revision };
    } catch { throw new WorkspaceError(409, "social_config_unavailable"); }
  }
  async setup(): Promise<SocialSetup[]> {
    return Promise.all(PROVIDERS.map(async provider => {
      try { const { config } = await this.config(provider), reason = socialSetupBlock(config);
        return { provider, configured: true, available: !reason && !this.configuring.has(provider), reason, scopes: socialScopes(config), audited: config.audited, publicApp: config.publicApp };
      } catch (e) { return { provider, configured: !!this.store.config(provider), available: false, reason: safeCode(e), scopes: [], audited: false, publicApp: false }; }
    }));
  }
  async configure(value: SocialConfig): Promise<SocialSetup[]> {
    this.ready(); const c = socialConfigSchema.parse(value);
    if (this.configuring.has(c.provider) || [...this.pending.values()].some(p => p.config.provider === c.provider && ["awaiting-browser", "verifying", "select-destination"].includes(p.view.state))) throw new WorkspaceError(409, "social_session_active");
    this.configuring.add(c.provider);
    try { await this.tracked(async () => {
      const previous = this.store.config(c.provider), ref = `account:${randomUUID()}`;
      try { await this.vault.set(ref, JSON.stringify(c)); this.ready(); this.store.saveConfig(c.provider, ref, previous?.revision ?? null); }
      catch (e) { await this.vault.delete(ref).catch(() => undefined); throw e instanceof WorkspaceError ? e : new WorkspaceError(503, "social_config_save_failed"); }
      if (previous) await this.vault.delete(previous.ref).catch(() => undefined);
    }); } finally { this.configuring.delete(c.provider); }
    return this.setup();
  }
  accounts() { return this.store.accounts(); }
  textMetrics(text: string) { const result = this.options.xTextMetrics?.(text); return { weightedLength: result?.weightedLength ?? socialXTextWeight(text), maxWeightedLength: 280, valid: result?.valid ?? socialXTextWeight(text) <= 280 }; }
  async start(value: SocialStart): Promise<SocialSession> {
    this.ready(); const input = socialStartSchema.parse(value);
    // Reserve the provider before the first await so two starts cannot race a fixed callback port.
    if (this.configuring.has(input.provider)) throw new WorkspaceError(409, "social_session_active");
    this.configuring.add(input.provider);
    try { return await this.tracked(async () => {
      for (const p of this.pending.values()) if (p.config.provider === input.provider && ["awaiting-browser", "verifying", "select-destination"].includes(this.status(p.view.id).state)) throw new WorkspaceError(409, "social_session_active");
      const { config, revision } = await this.config(input.provider), block = socialSetupBlock(config);
      if (block) throw new WorkspaceError(409, block);
      if (input.accountId && !input.expectedDestinationId) throw new WorkspaceError(400, "social_destination_required");
      const previous = input.accountId ? this.store.connection({ accountId: input.accountId, destinationId: input.expectedDestinationId! }) : null;
      if (previous && (previous.provider !== input.provider || previous.appKey !== appKey(config))) throw new WorkspaceError(409, "social_identity_mismatch");
      const abort = new AbortController();
      const state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
      const id = randomUUID();
      const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
        const p = this.pending.get(id);
        const sendResult = (status: number) => {
          res.writeHead(status, { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
          res.end("<!doctype html><html lang=en><meta charset=utf-8><title>AtrisShare</title><h1>AtrisShare</h1><p>Return to AtrisShare to review the connection result. You can close this tab.</p><p lang=tr>Bağlantı sonucunu görmek için AtrisShare’e dönün.</p></html>");
        };
        if (!p || req.method !== "GET" || (req.url?.length ?? 0) > 8192 || req.headers.host !== new URL(p.redirect).host || req.headers.origin) { sendResult(400); return; }
        const u = new URL(req.url ?? "/", p.redirect);
        if (u.pathname === "/result") { sendResult(200); return; }
        if (u.pathname !== new URL(p.redirect).pathname) { sendResult(404); return; }
        void this.tracked(() => this.callback(p, u.searchParams, input.expectedDestinationId)).then(() => {
          res.writeHead(303, { Location: "/result", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); res.end();
        }).catch(() => sendResult(400));
      });
      server.on("clientError", (_e, socket) => socket.destroy());
      try {
        await new Promise<void>((resolve, reject) => { const fail = () => reject(new WorkspaceError(409, "social_callback_port_unavailable"));
          server.once("error", fail); server.listen(config.callbackPort, "127.0.0.1", () => { server.off("error", fail); resolve(); }); });
        this.ready();
      } catch (e) { server.close(); throw e; }
      server.on("error", () => { abort.abort(); });
      const port = (server.address() as {port:number}).port;
      const redirect = `http://127.0.0.1:${port}/oauth/social/${input.provider}/callback`;
      const url = new URL(input.provider === "x" ? "https://x.com/i/oauth2/authorize" : input.provider === "linkedin" ? "https://www.linkedin.com/oauth/native-pkce/authorization" : "https://www.tiktok.com/v2/auth/authorize/");
      url.search = new URLSearchParams({ [input.provider === "tiktok" ? "client_key" : "client_id"]: config.clientId, response_type: "code", redirect_uri: redirect,
        scope: socialScopes(config).join(input.provider === "tiktok" ? "," : " "), state,
        code_challenge: createHash("sha256").update(verifier).digest(input.provider === "tiktok" ? "hex" : "base64url"), code_challenge_method: "S256" }).toString();
      const view: SocialSession = { id, provider: input.provider, state: "awaiting-browser", expiresAt: new Date(this.clock() + 600_000).toISOString(), browserOpened: false, destinations: [], accountId: null, error: null };
      const timer = setTimeout(() => { const p = this.pending.get(id); if (p) void this.finish(p, "expired"); }, 600_000); timer.unref();
      const p: Pending = { view, config, configRevision: revision, appKey: appKey(config), fenceEpoch: this.store.epoch(input.provider, appKey(config), "*"),
        state, verifier, url: url.href, redirect, server, timer, abort, credentialRef: null, subject: null, previous, accountId: previous?.accountId ?? randomUUID() };
      // Bound terminal history in a long-lived desktop runtime.
      if (this.pending.size >= 30) for (const [key, old] of this.pending) if (!["awaiting-browser", "verifying", "select-destination"].includes(old.view.state)) { this.pending.delete(key); break; }
      this.pending.set(id, p); return this.reopen(id);
    }); } finally { this.configuring.delete(input.provider); }
  }
  private current(p: Pending): void {
    this.ready();
    if (p.abort.signal.aborted || this.clock() >= Date.parse(p.view.expiresAt) || this.store.config(p.config.provider)?.revision !== p.configRevision ||
      this.store.epoch(p.config.provider, p.appKey, "*") !== p.fenceEpoch) throw new WorkspaceError(409, "social_session_expired");
  }
  private async finish(p: Pending, state: SocialSession["state"], error: string | null = null): Promise<void> {
    p.view.state = state; p.view.error = error; p.state = ""; p.verifier = ""; p.url = ""; p.abort.abort(); clearTimeout(p.timer);
    p.server.close(); p.server.closeIdleConnections();
    const ref = p.credentialRef; p.credentialRef = null; if (ref) await this.vault.delete(ref).catch(() => undefined);
  }
  status(id: string): SocialSession {
    idSchema.parse(id); const p = this.pending.get(id); if (!p) throw new WorkspaceError(404, "social_session_not_found");
    if (["awaiting-browser", "verifying", "select-destination"].includes(p.view.state) && this.clock() >= Date.parse(p.view.expiresAt)) void this.finish(p, "expired");
    return structuredClone(p.view);
  }
  async cancelSession(id: string) { this.status(id); const p = this.pending.get(id)!; if (["awaiting-browser", "verifying", "select-destination"].includes(p.view.state)) await this.finish(p, "cancelled"); return this.status(id); }
  async reopen(id: string): Promise<SocialSession> {
    this.status(id); const p = this.pending.get(id)!; this.current(p);
    if (p.view.state !== "awaiting-browser") throw new WorkspaceError(409, "social_session_consumed");
    p.view.browserOpened = await this.browser(p.url).catch(() => false); return this.status(id);
  }
  private async callback(p: Pending, query: URLSearchParams, expected?: string): Promise<void> {
    this.current(p);
    if (p.view.state !== "awaiting-browser" || query.getAll("state").length !== 1 || !timingSafeEqual(createHash("sha256").update(query.get("state") ?? "").digest(), createHash("sha256").update(p.state).digest())) throw new WorkspaceError(400, "social_invalid_state");
    const verifier = p.verifier; p.state = ""; p.verifier = ""; p.url = ""; p.view.state = "verifying";
    try {
      if (query.has("error")) throw new WorkspaceError(409, "social_consent_denied");
      if (query.getAll("code").length !== 1 || !query.get("code") || query.get("code")!.length > 4096 || query.has("iss")) throw new WorkspaceError(400, "social_invalid_callback");
      const tokens = await this.provider.tokens(p.config, { code: query.get("code")!, code_verifier: verifier, redirect_uri: p.redirect, grant_type: "authorization_code" }, p.abort.signal);
      this.current(p);
      const identity = await this.provider.identity(p.config, tokens, p.abort.signal); this.current(p);
      if (p.previous && identity.subject !== p.previous.subjectId) throw new WorkspaceError(409, "social_identity_mismatch");
      if (expected && !identity.destinations.some(d => d.id === expected)) throw new WorkspaceError(409, "social_destination_mismatch");
      const ref = `account:${randomUUID()}`;
      try { await this.vault.set(ref, JSON.stringify({ config: p.config, tokens })); this.current(p);
        if (p.view.state !== "verifying") throw new WorkspaceError(409, "social_session_consumed");
        p.credentialRef = ref;
      } catch (e) { await this.vault.delete(ref).catch(() => undefined); throw e; }
      p.subject = identity.subject; p.view.destinations = identity.destinations.filter(d => !expected || d.id === expected); p.view.state = "select-destination";
    } catch (e) { if (p.view.state === "verifying") await this.finish(p, "failed", safeCode(e)); }
  }
  async selectDestination(id: string, destinationId: string): Promise<SocialSession> {
    return this.tracked(async () => {
      this.status(id); const p = this.pending.get(id)!; this.current(p);
      if (p.view.state !== "select-destination" || !p.credentialRef || !p.view.destinations.some(d => d.id === destinationId)) throw new WorkspaceError(409, "social_destination_mismatch");
      // Consume selection before awaits. A second authenticated request cannot connect twice.
      p.view.state = "verifying";
      try {
        const credential = await this.readCredential(p.credentialRef); this.current(p);
        const identity = await this.provider.identity(credential.config, credential.tokens, p.abort.signal); this.current(p);
        const destination = identity.destinations.find(d => d.id === destinationId);
        if (!destination || identity.subject !== p.subject || p.view.state !== "verifying") throw new WorkspaceError(409, "social_identity_mismatch");
        const c = this.store.connect({ accountId: p.accountId, provider: p.config.provider, destinationId, displayName: destination.label,
          destinationKind: destination.kind, subjectId: identity.subject, scopes: credential.tokens.scopes, verifiedAt: new Date(this.clock()).toISOString(),
          configRevision: p.configRevision, appKey: p.appKey, grantEpoch: this.store.epoch(p.config.provider, p.appKey, identity.subject), credentialRef: p.credentialRef }, p.previous);
        p.credentialRef = null; p.view.accountId = c.accountId;
        await this.finish(p, "connected");
        if (p.previous?.credentialRef) await this.vault.delete(p.previous.credentialRef).catch(() => undefined);
      } catch (e) { if (p.view.state === "verifying") await this.finish(p, "failed", safeCode(e)); }
      return this.status(id);
    });
  }
  private async readCredential(ref: string | null): Promise<SocialCredential> {
    if (!ref) throw new WorkspaceError(409, "social_reauth_required");
    try { const raw = await this.vault.get(ref); if (!raw || raw.length > 32 * 1024) throw new Error(); return socialCredentialSchema.parse(JSON.parse(raw)); }
    catch { throw new WorkspaceError(409, "social_reauth_required"); }
  }
  private async fresh(value: SocialAccountAction, signal: AbortSignal): Promise<{ connection: SocialConnection; credential: SocialCredential }> {
    this.ready(); const input = socialAccountActionSchema.parse({ accountId: value.accountId, destinationId: value.destinationId });
    if (this.store.rateLimited(input.accountId)) throw new WorkspaceError(429, "social_rate_limited");
    if (this.accountLocks.has(input.accountId)) throw new WorkspaceError(409, "social_account_busy");
    this.accountLocks.add(input.accountId);
    let captured: SocialConnection | null = null;
    try {
      let c = this.store.connection(input); this.store.assertConnection(c);
      captured = c;
      let credential = await this.readCredential(c.credentialRef); this.store.assertConnection(c); signal.throwIfAborted();
      if (appKey(credential.config) !== c.appKey || credential.config.provider !== c.provider || !socialScopes(credential.config).every(s => credential.tokens.scopes.includes(s))) throw new WorkspaceError(409, "social_missing_scope");
      if (credential.tokens.expiresAt <= this.clock() + 60_000) {
        if (!credential.tokens.refreshToken || (credential.tokens.refreshExpiresAt !== null && credential.tokens.refreshExpiresAt <= this.clock())) throw new WorkspaceError(409, "social_reauth_required");
        const refreshOwner = randomUUID(), refreshAbort = new AbortController();
        this.store.claimRefresh(c, refreshOwner);
        const heartbeat = setInterval(() => { try { this.store.renewRefresh(c, refreshOwner); } catch { refreshAbort.abort(); } }, 20_000);
        try {
          const tokens = await this.provider.tokens(credential.config, { grant_type: "refresh_token", refresh_token: credential.tokens.refreshToken }, AbortSignal.any([signal, refreshAbort.signal]), credential.tokens);
          credential = { config: credential.config, tokens }; this.store.assertConnection(c); signal.throwIfAborted(); refreshAbort.signal.throwIfAborted();
          this.store.renewRefresh(c, refreshOwner);
          const ref = `account:${randomUUID()}`, previousRef = c.credentialRef;
          try { await this.vault.set(ref, JSON.stringify(credential)); this.store.assertConnection(c); signal.throwIfAborted(); refreshAbort.signal.throwIfAborted(); this.store.renewRefresh(c, refreshOwner); c = this.store.rotate(c, ref); captured = c; }
          catch (e) { await this.vault.delete(ref).catch(() => undefined); throw e; }
          if (previousRef) await this.vault.delete(previousRef).catch(() => undefined);
        } finally { clearInterval(heartbeat); this.store.releaseRefresh(c, refreshOwner); }
      }
      await this.provider.verify(credential.config, credential.tokens, c, signal); this.store.assertConnection(c); signal.throwIfAborted();
      return { connection: c, credential };
    } catch (e) {
      if (e instanceof SocialRemoteError && (e.retryAt || e.status === 429)) this.store.rateLimit(input.accountId, e.retryAt ?? this.clock() + 60000);
      if (captured && e instanceof WorkspaceError && ["social_reauth_required", "social_missing_scope", "social_identity_mismatch", "social_destination_permission_lost"].includes(e.code)) {
        const current = this.store.connection(input);
        if (current.revision === captured.revision && current.tokenRevision === captured.tokenRevision && current.credentialRef === captured.credentialRef) this.store.fenceGrant(captured);
      }
      throw e;
    } finally { this.accountLocks.delete(input.accountId); }
  }
  async verify(value: SocialAccountAction): Promise<SocialCapabilities> { return this.tracked(async () => this.capabilitiesFrom(await this.fresh(value, this.shutdown.signal), this.shutdown.signal)); }
  private async capabilitiesFrom(v: {connection:SocialConnection;credential:SocialCredential}, signal: AbortSignal): Promise<SocialCapabilities> {
    const { connection: c, credential: {config, tokens} } = v;
    const reasons: string[] = []; let creator = null;
    if (c.provider === "tiktok") {
      if (!config.publicApp) reasons.push("social_tiktok_public_app_required");
      creator = await this.provider.creator(tokens.accessToken, signal); this.store.assertConnection(c);
      if (!config.audited && !creator.privacy_level_options.includes("FOLLOWER_OF_CREATOR")) reasons.push("social_tiktok_private_account_required");
    }
    return { provider: c.provider, destinationId: c.destinationId, verifiedAt: new Date(this.clock()).toISOString(), text: c.provider !== "tiktok",
      video: !reasons.length, readback: c.provider === "x" || (c.provider === "linkedin" && c.destinationKind === "organization" && tokens.scopes.includes("r_organization_social")), reasons, creator,
      maxBytes: c.provider === "x" ? 8 * 1024 ** 3 : c.provider === "linkedin" ? 500 * 1024 ** 2 : 4 * 1024 ** 3,
      maxDuration: creator?.max_video_post_duration_sec ?? (c.provider === "x" ? 1200 : 1800) };
  }
  async disconnect(value: SocialAccountAction, revoke: boolean): Promise<{ disconnected: true; remoteRevoked: boolean }> {
    this.ready(); const input = socialAccountActionSchema.parse({ accountId: value.accountId, destinationId: value.destinationId }), c = this.store.connection(input);
    if (revoke && c.provider === "linkedin") throw new WorkspaceError(409, "social_linkedin_remote_revoke_unavailable");
    // Disconnect preempts dispatch, including in another local runtime.
    this.store.fenceGrant(c);
    return this.tracked(async () => {
      if (revoke && c.credentialRef) {
        const saved = await this.readCredential(c.credentialRef);
        await this.provider.revoke(saved.config, c.provider === "x" ? saved.tokens.refreshToken ?? saved.tokens.accessToken : saved.tokens.accessToken, this.shutdown.signal);
        this.store.fenceGrant(c); // Fence reconnects that finished while revocation was in flight.
      }
      this.ready(); this.store.disconnect(c);
      if (c.credentialRef) await this.vault.delete(c.credentialRef).catch(() => undefined);
      return { disconnected: true, remoteRevoked: revoke };
    });
  }
  async create(value: SocialDraft): Promise<SocialPost> {
    this.ready(); const input = socialDraftSchema.parse(value);
    return this.tracked(async () => {
      this.store.scope(input.target);
      const verified = await this.fresh(input.target, this.shutdown.signal), capabilities = await this.capabilitiesFrom(verified, this.shutdown.signal);
      this.validate(input, capabilities, verified.credential.config);
      const media = input.media ? (() => {
        const a = this.store.artifact(input.media!.artifactId, this.store.scope(input.media!.context));
        return socialMediaSchema.parse({ ...input.media, sha256: a.sha256, bytes: a.bytes, mimeType: a.mimeType, probe: a.probe });
      })() : null;
      if (media && (media.bytes > capabilities.maxBytes || media.probe.duration > capabilities.maxDuration ||
        (input.metadata.provider === "linkedin" && (media.mimeType !== "video/mp4" || media.probe.duration < 3 || media.bytes < 75_000)) ||
        (input.metadata.provider === "x" && media.probe.duration < .5) ||
        (input.metadata.provider === "tiktok" && (media.probe.width < 360 || media.probe.height < 360 || media.probe.width > 4096 || media.probe.height > 4096)))) throw new WorkspaceError(400, "social_media_constraints");
      return this.store.create({ version: 1, target: input.target, metadata: input.metadata, media, subjectId: verified.connection.subjectId,
        connectionRevision: verified.connection.revision, appKey: verified.connection.appKey });
    });
  }
  private validate(input: SocialDraft, cap: SocialCapabilities, config: SocialConfig): void {
    if (input.metadata.provider !== cap.provider || (input.media ? !cap.video : !cap.text)) throw new WorkspaceError(409, cap.reasons[0] ?? "social_operation_unsupported");
    const m = input.metadata;
    if (m.provider === "x" && m.text && !(this.options.validateXText ? this.options.validateXText(m.text) : socialXTextWeight(m.text) <= 280)) throw new WorkspaceError(400, "social_text_limit");
    if (m.provider === "linkedin" && input.target.destinationId.startsWith("urn:li:organization:") && m.visibility !== "PUBLIC") throw new WorkspaceError(400, "social_privacy_changed");
    if (m.provider === "tiktok") {
      const c = cap.creator;
      if (!c || !c.privacy_level_options.includes(m.privacy) || (!config.audited && m.privacy !== "SELF_ONLY") ||
        (m.allowComment && c.comment_disabled) || (m.allowDuet && c.duet_disabled) || (m.allowStitch && c.stitch_disabled)) throw new WorkspaceError(409, "social_privacy_changed");
    }
  }
  posts(target: SocialTarget) {
    const posts = this.store.posts(target);
    for (const p of posts) if (p.state === "processing" && !this.tasks.has(p.id) && (this.checked.get(p.id) ?? 0) + 15_000 < this.clock()) {
      this.checked.set(p.id, this.clock());
      try { this.reconcile(p.id, target); } catch { /* Another owner may be reading the same receipt. */ }
    }
    return posts;
  }
  approve(id: string, target: SocialTarget, digest: string, tiktokConsent = false): SocialPost {
    this.ready();
    if (this.store.post(id, target).payload.metadata.provider === "tiktok" && !tiktokConsent) throw new WorkspaceError(409, "social_tiktok_consent_required");
    const p = this.store.claim(id, target, this.owner, digest); this.launch(p, false); return p;
  }
  reconcile(id: string, target: SocialTarget): SocialPost {
    this.ready(); const p = this.store.claim(id, target, this.owner, null); this.launch(p, true); return p;
  }
  stop(id: string, target: SocialTarget): SocialPost { const p = this.store.stop(id, target); this.tasks.get(id)?.abort.abort(); return p; }
  private launch(p: SocialPost, reconcile: boolean): void {
    const abort = new AbortController();
    const promise = Promise.resolve().then(() => this.dispatch(p, AbortSignal.any([abort.signal, this.shutdown.signal]), reconcile)).finally(() => this.tasks.delete(p.id));
    this.tasks.set(p.id, { abort, promise }); void promise.catch(() => undefined);
  }
  private async snapshot(p: SocialPost, signal: AbortSignal): Promise<SocialMediaSnapshot | null> {
    const media = p.payload.media; if (!media) return null;
    const artifact = this.store.artifact(media.artifactId, this.store.scope(media.context));
    if (artifact.sha256 !== media.sha256 || artifact.bytes !== media.bytes || artifact.kind === "proxy" || artifact.kind === "preview") throw new WorkspaceError(409, "social_media_changed");
    const directory = await mkdtemp(join(tmpdir(), "atris-social-"));
    let file;
    try {
      file = await open(join(directory, "snapshot"), "wx+", 0o600);
      const source = await open(this.options.mediaPath(media.artifactId), "r"), hash = createHash("sha256");
      try {
        const stat = await source.stat(); if (!stat.isFile() || stat.size !== media.bytes) throw new WorkspaceError(409, "social_media_changed");
        for (let offset = 0; offset < media.bytes;) {
          signal.throwIfAborted(); const b = Buffer.alloc(Math.min(1024 * 1024, media.bytes - offset));
          if ((await source.read(b, 0, b.length, offset)).bytesRead !== b.length) throw new WorkspaceError(409, "social_media_changed");
          hash.update(b); let written = 0;
          while (written < b.length) { const n = (await file.write(b, written, b.length - written, offset + written)).bytesWritten; if (!n) throw new Error(); written += n; }
          offset += b.length;
        }
        if (hash.digest("hex") !== media.sha256) throw new WorkspaceError(409, "social_media_changed");
      } finally { await source.close(); }
      const snapshot = file;
      return { async read(offset, length) { signal.throwIfAborted(); const b = Buffer.alloc(length); if ((await snapshot.read(b, 0, length, offset)).bytesRead !== length) throw new WorkspaceError(409, "social_media_changed"); return b; },
        async close() { await snapshot.close(); await rm(directory, { recursive: true, force: true }); } };
    } catch (e) { await file?.close(); await rm(directory, { recursive: true, force: true }); throw e; }
  }
  private async dispatch(p: SocialPost, signal: AbortSignal, reconcile: boolean): Promise<void> {
    const heartbeat = setInterval(() => { try { this.store.checkpoint(p, this.owner); } catch { this.tasks.get(p.id)?.abort.abort(); } }, 20_000);
    let snapshot: SocialMediaSnapshot | null = null;
    const checkpoint = () => this.store.checkpoint(p, this.owner);
    try {
      if (reconcile) {
        const v = await this.fresh(p.payload.target, signal);
        if (v.connection.subjectId !== p.payload.subjectId || v.connection.appKey !== p.payload.appKey || v.connection.provider !== p.payload.metadata.provider || v.connection.destinationId !== p.payload.target.destinationId) throw new WorkspaceError(409, "social_identity_mismatch");
        await this.publisher.reconcile(p, v.credential.tokens.accessToken, v.credential.tokens.scopes, signal, checkpoint);
      } else {
        this.store.assertDispatch(p, this.owner);
        snapshot = await this.snapshot(p, signal); this.store.assertDispatch(p, this.owner);
        let capabilityCache: SocialCapabilities | null = null;
        const authorize = async (publishing = false) => {
          signal.throwIfAborted(); this.store.assertDispatch(p, this.owner);
          const v = await this.fresh(p.payload.target, signal);
          // Creator-info has a 20/min cap. Refresh at initialization and the final
          // publish boundary, while identity/roles and local fences are checked for EVERY chunk.
          const cap = !capabilityCache || publishing ? await this.capabilitiesFrom(v, signal) : capabilityCache;
          capabilityCache = cap;
          this.validate({ target: p.payload.target, metadata: p.payload.metadata, media: p.payload.media }, cap, v.credential.config);
          if (p.payload.media && (p.payload.media.bytes > cap.maxBytes || p.payload.media.probe.duration > cap.maxDuration)) throw new WorkspaceError(409, "social_media_constraints");
          signal.throwIfAborted(); this.store.assertDispatch(p, this.owner); return v.credential.tokens.accessToken;
        };
        await this.publisher.publish(p, snapshot, authorize, () => { signal.throwIfAborted(); this.store.assertDispatch(p, this.owner); }, signal, checkpoint);
      }
    } catch (e) {
      p.error = safeCode(e);
      if (e instanceof SocialRemoteError && (e.retryAt || e.status === 429)) this.store.rateLimit(p.payload.target.accountId, e.retryAt ?? this.clock() + 60000);
      p.state = reconcile || (e instanceof SocialRemoteError && e.uncertain) || p.receipt.postIds.length || p.receipt.jobId ? "uncertain" : "failed";
    } finally {
      clearInterval(heartbeat); await snapshot?.close().catch(() => undefined);
      try { this.store.checkpoint(p, this.owner, true); }
      catch (e) { if (!(e instanceof WorkspaceError && e.code === "social_post_busy")) throw e; /* An expired/lost lease must not overwrite a new owner. */ }
    }
  }
  async wait(id: string, target: SocialTarget): Promise<SocialPost> { await this.tasks.get(id)?.promise; return this.store.post(id, target); }
  async close(): Promise<void> {
    this.shutdown.abort(); for (const task of this.tasks.values()) task.abort.abort();
    await Promise.allSettled([...this.pending.values()].map(p => this.finish(p, ["connected", "failed", "cancelled", "expired"].includes(p.view.state) ? p.view.state : "cancelled")));
    for (const p of this.pending.values()) p.server.closeAllConnections();
    await Promise.allSettled([...this.tasks.values()].map(t => t.promise)); await Promise.allSettled([...this.operations]);
  }
}
