import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { startYouTubeSchema, youtubeAccountSchema, YOUTUBE_SCOPES,
  type StartYouTubeInput, type YouTubeAccountInput, type YouTubeConnection, type YouTubeSession, type YouTubeSetup } from "../../../packages/domain/src/youtube.js";
import { WorkspaceError } from "../../../packages/storage/src/config.js";
import type { WorkspaceStore } from "../../../packages/storage/src/store.js";
import type { CredentialVault } from "../../../packages/storage/src/vault.js";
import { openAuthorizationBrowser } from "./open-browser.js";
import { desktopClientFromEnv, googleDesktopClientSchema, YouTubeProvider, type GoogleDesktopClient, type GoogleTokens } from "./youtube-provider.js";

const SESSION_TTL = 10 * 60_000;
// Reserved app-client record, NOT an account grant or a copy-on-write credential generation.
// Shared by runtimes for this workspace; last encrypted app-config write wins.
const LOCAL_CLIENT_REF = "account:bd18cc87-827d-4cb4-a1e2-9bfab2b48ec6";
const MAX_LOCAL_CLIENT_LENGTH = 2048;
export interface LocalYouTubeSetup extends YouTubeSetup {
  configuredSource?: "env" | "local" | "none";
  configurationError?: "youtube_config_invalid" | "youtube_config_load_failed";
}
const credentialSchema = z.object({
  clientId: z.string(), clientSecret: z.string().optional(), accessToken: z.string().min(1), refreshToken: z.string().min(1),
  expiresAt: z.number(), scopes: z.array(z.string())
}).strict();
type Credential = z.infer<typeof credentialSchema>;
interface Pending {
  view: YouTubeSession;
  state: string;
  verifier: string;
  authorizationUrl: string;
  accountId: string;
  previous: YouTubeConnection | null;
  abort: AbortController;
}
export interface YouTubeOptions {
  client?: GoogleDesktopClient | null;
  /** Internal test seams; never configurable through HTTP/environment. */
  provider?: YouTubeProvider;
  openBrowser?: (url: string) => Promise<boolean>;
  now?: () => number;
}
export class YouTubeService {
  private client: GoogleDesktopClient | null;
  private readonly fallbackClient: GoogleDesktopClient | null;
  private configuredSource: "env" | "local" | "none";
  private configurationError: LocalYouTubeSetup["configurationError"];
  private configLock = false;
  private readonly provider: YouTubeProvider;
  private readonly openBrowser: (url: string) => Promise<boolean>;
  private readonly clock: () => number;
  private pending: Pending | null = null;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();
  private readonly accountLocks = new Set<string>();
  constructor(private readonly store: WorkspaceStore, private readonly vault: CredentialVault, options: YouTubeOptions = {}) {
    this.client = options.client === undefined ? desktopClientFromEnv() : options.client;
    this.fallbackClient = this.client;
    this.configuredSource = this.client ? "env" : "none";
    this.provider = options.provider ?? new YouTubeProvider();
    this.openBrowser = options.openBrowser ?? openAuthorizationBrowser;
    this.clock = options.now ?? Date.now;
  }
  setup(): LocalYouTubeSetup {
    return { configured: this.client !== null, available: this.client !== null && this.vault.status.available && !this.configLock && !this.shutdown.signal.aborted,
      scopes: YOUTUBE_SCOPES, configuredSource: this.configuredSource, ...(this.configurationError ? { configurationError: this.configurationError } : {}) };
  }
  private lockConfig(): void {
    if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing");
    if (this.configLock) throw new WorkspaceError(409, "youtube_configuring");
    this.assertNoActiveSession();
    this.configLock = true;
  }
  private assertNoActiveSession(): void {
    if (this.pending && ["awaiting-browser", "verifying"].includes(this.view(this.pending).state)) throw new WorkspaceError(409, "youtube_session_active");
  }
  /** Await during API startup, before listening. Missing local config uses the environment fallback. */
  async loadLocalClient(): Promise<void> {
    this.lockConfig();
    try {
      await this.tracked(async () => {
        let client = this.fallbackClient;
        let source: "env" | "local" | "none" = client ? "env" : "none";
        let error: LocalYouTubeSetup["configurationError"];
        if (this.vault.status.available) {
          try {
            const saved = await this.vault.get(LOCAL_CLIENT_REF);
            if (saved !== null) {
              // Bound before parsing; never propagate JSON/Zod/vault diagnostics or record contents.
              const parsed = saved.length <= MAX_LOCAL_CLIENT_LENGTH ? googleDesktopClientSchema.safeParse(JSON.parse(saved)) : null;
              if (!parsed?.success) { client = null; source = "none"; error = "youtube_config_invalid"; }
              else { client = parsed.data; source = "local"; }
            }
          } catch (failure) {
            client = null; source = "none";
            error = failure instanceof SyntaxError ? "youtube_config_invalid" : "youtube_config_load_failed";
          }
        }
        if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing");
        this.assertNoActiveSession();
        this.client = client; this.configuredSource = source; this.configurationError = error;
      });
    } finally { this.configLock = false; }
  }
  /** Saves only Desktop OAuth app configuration; returns readiness, never client credentials. */
  async configure(input: { clientId: string; clientSecret?: string }): Promise<LocalYouTubeSetup> {
    this.lockConfig();
    try {
      await this.tracked(async () => {
        if (!this.vault.status.available) throw new WorkspaceError(409, "vault_unavailable");
        const parsed = googleDesktopClientSchema.safeParse(input);
        if (!parsed.success) throw new WorkspaceError(400, "youtube_invalid_client_config");
        try { await this.vault.set(LOCAL_CLIENT_REF, JSON.stringify(parsed.data)); }
        catch { throw new WorkspaceError(503, "youtube_config_save_failed"); }
        // The lock blocks start() across the encrypted write. Recheck before activating in memory.
        // If closing during the write, persisted config may load next startup, but is never activated here.
        if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing");
        this.assertNoActiveSession();
        this.client = parsed.data; this.configuredSource = "local"; this.configurationError = undefined;
      });
    } finally { this.configLock = false; }
    return this.setup();
  }
  isBusy(accountId: string): boolean { return this.accountLocks.has(accountId); }
  private ready(): GoogleDesktopClient {
    if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing");
    if (this.configLock) throw new WorkspaceError(409, "youtube_configuring");
    if (!this.vault.status.available) throw new WorkspaceError(409, "vault_unavailable");
    if (!this.client) throw new WorkspaceError(409, "youtube_not_configured");
    return this.client;
  }
  private view(pending: Pending): YouTubeSession {
    if (["awaiting-browser", "verifying"].includes(pending.view.state) && this.clock() >= Date.parse(pending.view.expiresAt)) {
      this.finish(pending, "expired", "youtube_session_expired");
    }
    return { ...pending.view };
  }
  private finish(pending: Pending, state: YouTubeSession["state"], error: string | null = null): void {
    pending.view.state = state; pending.view.error = error;
    pending.state = ""; pending.verifier = ""; pending.authorizationUrl = "";
    pending.abort.abort();
  }
  private session(id: string): Pending {
    if (!this.pending || this.pending.view.id !== id) throw new WorkspaceError(404, "youtube_session_not_found");
    this.view(this.pending);
    return this.pending;
  }
  status(id: string): YouTubeSession { return this.view(this.session(id)); }
  cancel(id: string): YouTubeSession {
    const pending = this.session(id);
    if (["awaiting-browser", "verifying"].includes(pending.view.state)) this.finish(pending, "cancelled");
    return this.view(pending);
  }
  async reopen(id: string): Promise<YouTubeSession> {
    const pending = this.session(id);
    if (pending.view.state !== "awaiting-browser") throw new WorkspaceError(409, "youtube_session_consumed");
    pending.view.browserOpened = await this.openBrowser(pending.authorizationUrl).catch(() => false);
    return this.view(pending);
  }
  async start(value: StartYouTubeInput, origin: string): Promise<YouTubeSession> {
    const client = this.ready();
    const input = startYouTubeSchema.parse(value);
    const previous = input.accountId ? this.store.getYouTubeConnection(input.accountId, input.expectedChannelId) : null;
    if (!previous && this.store.listAccounts().some(account => account.destinationId === input.expectedChannelId)) throw new WorkspaceError(409, "youtube_already_connected");
    if (this.pending && ["awaiting-browser", "verifying"].includes(this.view(this.pending).state)) throw new WorkspaceError(409, "youtube_session_active");
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: `${origin}/oauth/youtube/callback`,
      response_type: "code", scope: YOUTUBE_SCOPES.join(" "), state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      access_type: "offline", prompt: "consent select_account", ...(previous ? { login_hint: previous.providerSubjectId } : {}) }).toString();
    const pending: Pending = { view: { id: randomUUID(), expectedChannelId: input.expectedChannelId, state: "awaiting-browser",
      expiresAt: new Date(this.clock() + SESSION_TTL).toISOString(), accountId: previous?.accountId ?? null, error: null, browserOpened: false },
      state, verifier, authorizationUrl: url.href, accountId: input.accountId ?? randomUUID(), previous, abort: new AbortController() };
    this.pending = pending;
    return this.reopen(pending.view.id);
  }
  private async tracked<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation(); this.operations.add(promise);
    try { return await promise; } finally { this.operations.delete(promise); }
  }
  async callback(query: URLSearchParams, origin: string): Promise<void> {
    return this.tracked(async () => {
      const pending = this.pending;
      const state = query.get("state") ?? "";
      if (!pending || this.view(pending).state !== "awaiting-browser" || query.getAll("state").length !== 1 ||
          !timingSafeEqual(createHash("sha256").update(state).digest(), createHash("sha256").update(pending.state).digest())) {
        throw new WorkspaceError(400, "youtube_invalid_state");
      }
      const verifier = pending.verifier;
      pending.state = ""; pending.verifier = ""; pending.authorizationUrl = "";
      pending.view.state = "verifying"; // Consume before the first await; callback replay cannot exchange twice.
      try {
        if (query.has("error")) throw new WorkspaceError(409, "youtube_consent_denied");
        if (query.getAll("code").length !== 1 || !query.get("code") || (query.get("code")?.length ?? 0) > 8192 ||
            (query.has("iss") && query.get("iss") !== "https://accounts.google.com")) throw new WorkspaceError(400, "youtube_invalid_callback");
        const client = this.ready();
        const tokens = await this.provider.tokens(client, { code: query.get("code")!, code_verifier: verifier,
          redirect_uri: `${origin}/oauth/youtube/callback`, grant_type: "authorization_code" }, pending.abort.signal);
        const scopes = this.provider.scopes(tokens);
        if (!tokens.refresh_token) throw new WorkspaceError(409, "youtube_refresh_missing");
        const identity = await this.provider.identity(tokens.access_token, pending.abort.signal);
        const channel = identity.channels.find(item => item.id === pending.view.expectedChannelId);
        if (!channel) throw new WorkspaceError(409, "youtube_channel_mismatch");
        if (pending.previous && pending.previous.providerSubjectId !== identity.subject) throw new WorkspaceError(409, "youtube_identity_mismatch");
        if (this.view(pending).state !== "verifying") return;
        const credential = this.credential(client, tokens, scopes, tokens.refresh_token);
        await this.persist(pending.accountId, channel.id, channel.title, identity.subject, credential, pending.previous,
          () => this.view(pending).state === "verifying" && !this.shutdown.signal.aborted);
        pending.view.accountId = pending.accountId;
        this.finish(pending, "connected");
      } catch (error) {
        if (pending.view.state === "verifying") this.finish(pending, "failed", error instanceof WorkspaceError ? error.code : "youtube_operation_failed");
      }
    });
  }
  private credential(client: GoogleDesktopClient, tokens: GoogleTokens, scopes: string[], refreshToken: string): Credential {
    return { ...client, accessToken: tokens.access_token, refreshToken, expiresAt: this.clock() + tokens.expires_in * 1000, scopes };
  }
  private async persist(accountId: string, destinationId: string, displayName: string, subject: string, credential: Credential,
    previous: YouTubeConnection | null, valid: () => boolean): Promise<YouTubeConnection> {
    // Copy-on-write vault generations prevent concurrent refresh/disconnect from overwriting a winner's credentials.
    const ref = `account:${randomUUID()}`;
    await this.vault.set(ref, JSON.stringify(credential));
    let connection: YouTubeConnection;
    try {
      if (!valid()) throw new WorkspaceError(409, "connection_conflict");
      connection = this.store.connectYouTube({ accountId, destinationId, displayName, providerSubjectId: subject, credentialRef: ref,
        grantedScopes: credential.scopes, expectedRevision: previous?.revision ?? null });
    } catch (error) { await this.vault.delete(ref).catch(() => undefined); throw error; }
    if (previous?.credentialRef) await this.vault.delete(previous.credentialRef).catch(() => undefined);
    return connection;
  }
  private async locked<T>(value: YouTubeAccountInput, operation: (connection: YouTubeConnection, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.shutdown.signal.aborted) throw new WorkspaceError(503, "runtime_closing");
    if (!this.vault.status.available) throw new WorkspaceError(409, "vault_unavailable");
    const input = youtubeAccountSchema.parse(value);
    if (this.accountLocks.has(input.accountId)) throw new WorkspaceError(409, "connection_conflict");
    this.accountLocks.add(input.accountId);
    try { return await this.tracked(() => operation(this.store.getYouTubeConnection(input.accountId, input.destinationId), this.shutdown.signal)); }
    finally { this.accountLocks.delete(input.accountId); }
  }
  private async readCredential(connection: YouTubeConnection): Promise<Credential> {
    if (!connection.credentialRef) throw new WorkspaceError(409, "youtube_reauth_required");
    try {
      const value = await this.vault.get(connection.credentialRef);
      return credentialSchema.parse(JSON.parse(value ?? "null"));
    } catch { throw new WorkspaceError(409, "youtube_reauth_required"); }
  }
  private assertCurrent(connection: YouTubeConnection, signal: AbortSignal): void {
    if (signal.aborted) throw new WorkspaceError(503, "runtime_closing");
    const current = this.store.getYouTubeConnection(connection.accountId, connection.destinationId);
    if (current.accountId !== connection.accountId || current.destinationId !== connection.destinationId ||
        current.revision !== connection.revision || current.providerSubjectId !== connection.providerSubjectId ||
        current.credentialRef !== connection.credentialRef) {
      throw new WorkspaceError(409, "connection_conflict");
    }
    if (this.store.listAccounts().find(item => item.id === connection.accountId)?.status !== "connected") {
      throw new WorkspaceError(409, "youtube_reauth_required");
    }
  }
  private async verified<T>(value: YouTubeAccountInput, singleChannel: boolean,
    operation: (accessToken: string, signal: AbortSignal, guard: () => void) => Promise<T>): Promise<T> {
    return this.locked(value, async (connection, signal) => {
      this.assertCurrent(connection, signal);
      let accessToken: string;
      let guard: () => void;
      try {
        const saved = await this.readCredential(connection);
        this.assertCurrent(connection, signal);
        const client: GoogleDesktopClient = { clientId: saved.clientId, ...(saved.clientSecret ? { clientSecret: saved.clientSecret } : {}) };
        const tokens = await this.provider.tokens(client, { grant_type: "refresh_token", refresh_token: saved.refreshToken }, signal);
        this.assertCurrent(connection, signal);
        const scopes = this.provider.scopes(tokens, saved.scopes);
        const identity = await this.provider.identity(tokens.access_token, signal);
        this.assertCurrent(connection, signal);
        const channel = identity.channels.find(item => item.id === connection.destinationId);
        if (!channel || (singleChannel && identity.channels.length !== 1)) throw new WorkspaceError(409, "youtube_channel_mismatch");
        if (identity.subject !== connection.providerSubjectId) throw new WorkspaceError(409, "youtube_identity_mismatch");
        const persisted = await this.persist(connection.accountId, connection.destinationId, channel.title, identity.subject,
          this.credential(client, tokens, scopes, tokens.refresh_token ?? saved.refreshToken), connection,
          () => { this.assertCurrent(connection, signal); return true; });
        // persist also awaits old-generation cleanup. Another runtime may have fenced
        // this connection during that await; never hand its token to the operation.
        guard = () => this.assertCurrent(persisted, signal);
        guard();
        accessToken = tokens.access_token;
      } catch (error) {
        if (error instanceof WorkspaceError && ["youtube_reauth_required", "youtube_missing_scope", "youtube_channel_mismatch", "youtube_identity_mismatch", "youtube_access_denied"].includes(error.code)) {
          this.store.setYouTubeStatus(connection, "reauth-required");
        }
        throw error;
      }
      // Keep the account lock and shutdown tracking through the entire callback.
      // Operation errors are not identity failures and must not mutate account status.
      return operation(accessToken, signal, guard);
    });
  }
  async verify(value: YouTubeAccountInput): Promise<{ verified: true }> {
    return this.verified(value, false, async () => ({ verified: true }));
  }
  /** Internal credential boundary. Never expose the callback token through HTTP/UI.
   * Call guard synchronously after awaits, immediately before initiation and each chunk. */
  async withVerified<T>(value: YouTubeAccountInput,
    operation: (accessToken: string, signal: AbortSignal, guard: () => void) => Promise<T>): Promise<T> {
    return this.verified(value, true, operation);
  }
  async disconnect(value: YouTubeAccountInput, revoke: boolean): Promise<{ disconnected: true }> {
    return this.locked(value, async (connection, signal) => {
      // Fence in-flight refresh/reconnect before any external await. On revoke failure,
      // retain the encrypted credential for an explicit retry, but block account use.
      this.store.setYouTubeStatus(connection, "reauth-required");
      let fenced = this.store.getYouTubeConnection(connection.accountId, connection.destinationId);
      if (revoke && fenced.credentialRef) {
        const saved = await this.readCredential(fenced);
        await this.provider.revoke(saved.refreshToken, signal);
        if (signal.aborted) throw new WorkspaceError(503, "runtime_closing");
        // Google revokes the project grant, potentially affecting other channels.
        // Also fence any reconnect/refresh that completed during the remote request.
        this.store.recordYouTubeRevocation(fenced.providerSubjectId);
        const latest = this.store.getYouTubeConnection(fenced.accountId, fenced.destinationId);
        if (latest.credentialRef !== fenced.credentialRef) throw new WorkspaceError(409, "connection_conflict");
        fenced = latest;
      }
      if (signal.aborted) throw new WorkspaceError(503, "runtime_closing");
      if (fenced.credentialRef) await this.vault.delete(fenced.credentialRef);
      this.store.setYouTubeStatus(fenced, "disconnected");
      return { disconnected: true };
    });
  }
  async close(): Promise<void> {
    this.shutdown.abort();
    if (this.pending && ["awaiting-browser", "verifying"].includes(this.pending.view.state)) this.finish(this.pending, "cancelled");
    await Promise.allSettled([...this.operations]);
  }
}
