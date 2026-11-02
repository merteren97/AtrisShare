import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { socialAccountActionSchema, socialContextSchema, socialPayloadSchema, socialTargetSchema,
  type SocialAccount, type SocialAccountAction, type SocialConnection, type SocialContext, type SocialPayload,
  type SocialPost, type SocialProviderId, type SocialTarget } from "../../domain/src/social.js";
import type { StudioArtifact } from "../../domain/src/studio.js";
import { idSchema, type WorkspaceContext } from "../../domain/src/workspace.js";
import { redactSensitiveText, WorkspaceError } from "./config.js";
import { consumeScheduledApproval } from "./schedule-gate.js";

/** Run from the owning migration transaction; this module never changes user_version. */
export const SOCIAL_MIGRATION_SQL = `
CREATE TABLE social_configs(provider TEXT PRIMARY KEY,credential_ref TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE social_grants(provider TEXT NOT NULL,app_key TEXT NOT NULL,subject_id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(provider,app_key,subject_id)) STRICT;
CREATE TABLE social_connections(account_id TEXT PRIMARY KEY REFERENCES accounts(id),provider TEXT NOT NULL,
 destination_id TEXT NOT NULL,subject_id TEXT NOT NULL,app_key TEXT NOT NULL,grant_epoch INTEGER NOT NULL,
 config_revision INTEGER NOT NULL,credential_ref TEXT,token_revision INTEGER NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,
 UNIQUE(provider,destination_id)) STRICT;
CREATE TABLE social_posts(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),project_id TEXT NOT NULL,
 destination_id TEXT NOT NULL,data TEXT NOT NULL,session_ref TEXT,owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
 dispatch_revoked INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_revoked IN(0,1)),
 FOREIGN KEY(project_id,account_id) REFERENCES projects(id,account_id)) STRICT;
CREATE INDEX social_posts_scope ON social_posts(account_id,project_id);
`;
type Row = { data: string; credential_ref: string | null; revision: number; token_revision: number; config_revision: number;
  app_key: string; grant_epoch: number; owner: string | null; lease_until: number; session_ref: string | null; dispatch_revoked: number };
export function socialDigest(value: SocialPayload): string {
  // Zod produces canonical field order and rejects injected metadata before hashing.
  return createHash("sha256").update(JSON.stringify(socialPayloadSchema.parse(value))).digest("hex");
}
export class SocialStore {
  constructor(private readonly db: DatabaseSync, private readonly resolve: (scope: WorkspaceContext) => WorkspaceContext,
    private readonly audit: (scope: WorkspaceContext, action: string, id: string) => void,
    readonly artifact: (id: string, scope: WorkspaceContext) => StudioArtifact, private readonly clock: () => number = Date.now) {}
  private tx<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const v = fn(); this.db.exec("COMMIT"); return v; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  private stamp() { return new Date(this.clock()).toISOString(); }
  scope(value: SocialContext): SocialContext { const c = socialContextSchema.parse({ accountId: value.accountId, projectId: value.projectId }); this.resolve(c); return c; }
  config(provider: SocialProviderId): { ref: string; revision: number } | null {
    const r = this.db.prepare("SELECT credential_ref,revision FROM social_configs WHERE provider=?").get(provider) as {credential_ref:string;revision:number} | undefined;
    return r ? { ref: r.credential_ref, revision: r.revision } : null;
  }
  saveConfig(provider: SocialProviderId, ref: string, previous: number | null): void {
    this.tx(() => {
      if ((this.config(provider)?.revision ?? null) !== previous) throw new WorkspaceError(409, "social_config_conflict");
      this.db.prepare("INSERT INTO social_configs VALUES(?,?,1) ON CONFLICT(provider) DO UPDATE SET credential_ref=excluded.credential_ref,revision=revision+1").run(provider, ref);
      // A new configuration cannot silently authorize an existing connection or approval.
      this.db.prepare("UPDATE accounts SET status='reauth-required' WHERE id IN(SELECT account_id FROM social_connections WHERE provider=?) AND status='connected'").run(provider);
    });
  }
  epoch(provider: SocialProviderId, appKey: string, subject: string): number {
    return (this.db.prepare("SELECT epoch FROM social_grants WHERE provider=? AND app_key=? AND subject_id=?").get(provider, appKey, subject) as {epoch:number} | undefined)?.epoch ?? 0;
  }
  /** Fence every destination sharing this grant before awaiting remote revocation. */
  fenceGrant(c: SocialConnection): void {
    this.tx(() => {
      this.db.prepare("INSERT INTO social_grants VALUES(?,?,?,1) ON CONFLICT(provider,app_key,subject_id) DO UPDATE SET epoch=epoch+1").run(c.provider, c.appKey, c.subjectId);
      this.db.prepare("INSERT INTO social_grants VALUES(?,?,?,1) ON CONFLICT(provider,app_key,subject_id) DO UPDATE SET epoch=epoch+1").run(c.provider, c.appKey, "*");
      this.db.prepare("UPDATE accounts SET status='reauth-required' WHERE id IN(SELECT account_id FROM social_connections WHERE provider=? AND app_key=? AND subject_id=?) AND status<>'disconnected'").run(c.provider, c.appKey, c.subjectId);
      this.audit({ accountId: c.accountId, projectId: null }, "social.grant-fenced", c.accountId);
    });
  }
  accounts(): SocialAccount[] {
    return (this.db.prepare("SELECT account_id,destination_id FROM social_connections ORDER BY rowid DESC").all() as {account_id:string;destination_id:string}[]).map(r => this.publicAccount(this.connection({ accountId: r.account_id, destinationId: r.destination_id })));
  }
  publicAccount(c: SocialConnection): SocialAccount {
    const { accountId, provider, destinationId, displayName, destinationKind, subjectId, scopes, verifiedAt, status, revision } = c;
    return { accountId, provider, destinationId, displayName, destinationKind, subjectId, scopes, verifiedAt, status, revision };
  }
  connection(value: SocialAccountAction): SocialConnection {
    const v = socialAccountActionSchema.parse({ accountId: value.accountId, destinationId: value.destinationId });
    const r = this.db.prepare(`SELECT s.*,a.status FROM social_connections s JOIN accounts a ON a.id=s.account_id
      WHERE s.account_id=? AND s.destination_id=? AND a.platform=s.provider AND a.destination_id=s.destination_id`).get(v.accountId, v.destinationId) as (Row & {status:SocialAccount["status"]}) | undefined;
    if (!r) throw new WorkspaceError(404, "social_account_not_found");
    const c = { ...JSON.parse(r.data) as SocialAccount, credentialRef: r.credential_ref, tokenRevision: r.token_revision,
      configRevision: r.config_revision, revision: r.revision, appKey: r.app_key, grantEpoch: r.grant_epoch, status: r.status };
    if (c.status === "connected" && (this.epoch(c.provider, c.appKey, c.subjectId) !== c.grantEpoch || this.config(c.provider)?.revision !== c.configRevision)) c.status = "reauth-required";
    return c;
  }
  assertConnection(c: SocialConnection): void {
    const current = this.connection(c);
    if (current.status !== "connected" || current.revision !== c.revision || current.subjectId !== c.subjectId || current.appKey !== c.appKey) throw new WorkspaceError(409, "social_connection_changed");
  }
  connect(c: Omit<SocialConnection, "revision" | "tokenRevision" | "status">, previous: SocialConnection | null): SocialConnection {
    return this.tx(() => {
      if (this.config(c.provider)?.revision !== c.configRevision || this.epoch(c.provider, c.appKey, c.subjectId) !== c.grantEpoch) throw new WorkspaceError(409, "social_connection_changed");
      if (previous) {
        const current = this.connection(previous);
        if (current.revision !== previous.revision || current.subjectId !== c.subjectId || current.appKey !== c.appKey || current.destinationId !== c.destinationId) throw new WorkspaceError(409, "social_connection_changed");
      } else if (this.db.prepare("SELECT id FROM accounts WHERE id=? OR destination_id=?").get(c.accountId, c.destinationId)) throw new WorkspaceError(409, "social_already_connected");
      const account: SocialAccount = { accountId: c.accountId, provider: c.provider, destinationId: c.destinationId, displayName: redactSensitiveText(c.displayName).slice(0, 100),
        destinationKind: c.destinationKind, subjectId: c.subjectId, scopes: c.scopes, verifiedAt: c.verifiedAt, status: "connected", revision: (previous?.revision ?? 0) + 1 };
      if (!previous) this.db.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)").run(c.accountId, account.displayName, c.provider, c.destinationId, "connected", this.stamp());
      else this.db.prepare("UPDATE accounts SET status='connected',display_name=? WHERE id=?").run(account.displayName, c.accountId);
      this.db.prepare(`INSERT INTO social_connections VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
        credential_ref=excluded.credential_ref,token_revision=token_revision+1,config_revision=excluded.config_revision,
        grant_epoch=excluded.grant_epoch,revision=excluded.revision,data=excluded.data`).run(c.accountId, c.provider, c.destinationId, c.subjectId, c.appKey, c.grantEpoch,
        c.configRevision, c.credentialRef, previous ? previous.tokenRevision + 1 : 1, account.revision, JSON.stringify(account));
      this.audit({ accountId: c.accountId, projectId: null }, "social.connected", c.accountId); return this.connection(c);
    });
  }
  rotate(c: SocialConnection, ref: string): SocialConnection {
    return this.tx(() => {
      this.assertConnection(c);
      if (!this.db.prepare("UPDATE social_connections SET credential_ref=?,token_revision=token_revision+1 WHERE account_id=? AND token_revision=? AND credential_ref IS ?")
        .run(ref, c.accountId, c.tokenRevision, c.credentialRef).changes) throw new WorkspaceError(409, "social_connection_changed");
      return this.connection(c);
    });
  }
  claimRefresh(c: SocialConnection, owner: string): void {
    this.tx(() => {
      this.assertConnection(c);
      const current = this.connection(c);
      if (current.tokenRevision !== c.tokenRevision || current.credentialRef !== c.credentialRef) throw new WorkspaceError(409, "social_connection_changed");
      const result = this.db.prepare(`INSERT INTO social_refresh_leases VALUES(?,?,?,?,?) ON CONFLICT(provider,app_key,subject_id)
        DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until WHERE social_refresh_leases.lease_until<=?`)
        .run(c.provider, c.appKey, c.subjectId, owner, this.clock() + 120_000, this.clock());
      if (!result.changes) throw new WorkspaceError(409, "social_account_busy");
    });
  }
  renewRefresh(c: SocialConnection, owner: string): void {
    if (!this.db.prepare("UPDATE social_refresh_leases SET lease_until=? WHERE provider=? AND app_key=? AND subject_id=? AND owner=? AND lease_until>?")
      .run(this.clock() + 120_000, c.provider, c.appKey, c.subjectId, owner, this.clock()).changes) throw new WorkspaceError(409, "social_connection_changed");
  }
  releaseRefresh(c: SocialConnection, owner: string): void {
    this.db.prepare("DELETE FROM social_refresh_leases WHERE provider=? AND app_key=? AND subject_id=? AND owner=?").run(c.provider, c.appKey, c.subjectId, owner);
  }
  rateLimited(accountId: string): boolean {
    return !!this.db.prepare("SELECT account_id FROM social_cooldowns WHERE account_id=? AND until_ms>?").get(accountId, this.clock());
  }
  rateLimit(accountId: string, until: number): void {
    const bounded = Math.max(this.clock() + 1000, Math.min(until, this.clock() + 86400_000));
    this.db.prepare("INSERT INTO social_cooldowns VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET until_ms=max(until_ms,excluded.until_ms)").run(accountId, bounded);
  }
  disconnect(c: SocialConnection): void {
    this.tx(() => {
      const current = this.connection(c);
      if (current.revision !== c.revision || current.credentialRef !== c.credentialRef) throw new WorkspaceError(409, "social_connection_changed");
      this.db.prepare("UPDATE accounts SET status='disconnected' WHERE id=?").run(c.accountId);
      this.db.prepare("UPDATE social_connections SET credential_ref=NULL,revision=revision+1 WHERE account_id=?").run(c.accountId);
      this.audit({ accountId: c.accountId, projectId: null }, "social.disconnected", c.accountId);
    });
  }
  create(payload: SocialPayload): SocialPost {
    const v = socialPayloadSchema.parse(payload);
    return this.tx(() => {
      this.scope(v.target); const c = this.connection(v.target); this.assertConnection(c);
      if (c.revision !== v.connectionRevision || c.subjectId !== v.subjectId || c.appKey !== v.appKey || c.provider !== v.metadata.provider) throw new WorkspaceError(409, "social_connection_changed");
      if (v.media) { const a = this.artifact(v.media.artifactId, this.scope(v.media.context)); if (a.sha256 !== v.media.sha256 || a.bytes !== v.media.bytes || a.kind === "proxy" || a.kind === "preview") throw new WorkspaceError(409, "social_media_changed"); }
      const stamp = this.stamp();
      const p: SocialPost = { id: randomUUID(), payload: v, digest: socialDigest(v), state: "review", receipt: { jobId: null, mediaId: null, postIds: [], providerState: null, publicUrl: null },
        approvalExpiresAt: null, progress: 0, error: null, createdAt: stamp, updatedAt: stamp, dispatchRevoked: false };
      this.db.prepare("INSERT INTO social_posts(id,account_id,project_id,destination_id,data) VALUES(?,?,?,?,?)").run(p.id, v.target.accountId, v.target.projectId, v.target.destinationId, JSON.stringify(p));
      this.audit(v.target, "social.draft-created", p.id); return p;
    });
  }
  private row(id: string, target: SocialTarget): Row {
    idSchema.parse(id); const t = socialTargetSchema.parse(target); this.scope(t);
    const r = this.db.prepare("SELECT * FROM social_posts WHERE id=? AND account_id=? AND project_id=? AND destination_id=?").get(id, t.accountId, t.projectId, t.destinationId) as Row | undefined;
    if (!r) throw new WorkspaceError(404, "social_post_not_found"); return r;
  }
  post(id: string, target: SocialTarget): SocialPost {
    const r = this.row(id, target), p = JSON.parse(r.data) as SocialPost;
    p.dispatchRevoked = !!r.dispatch_revoked;
    if (p.state === "uploading" && r.lease_until <= this.clock()) { p.state = "uncertain"; p.error = "social_dispatch_interrupted"; }
    return p;
  }
  posts(target: SocialTarget): SocialPost[] {
    const t = socialTargetSchema.parse(target); this.scope(t); this.connection(t);
    return (this.db.prepare("SELECT id FROM social_posts WHERE account_id=? AND project_id=? AND destination_id=? ORDER BY rowid DESC LIMIT 100").all(t.accountId, t.projectId, t.destinationId) as {id:string}[]).map(r => this.post(r.id, t));
  }
  claim(id: string, target: SocialTarget, owner: string, digest: string | null): SocialPost {
    return this.tx(() => {
      const p = this.post(id, target), r = this.row(id, target);
      if (r.owner && r.lease_until > this.clock()) throw new WorkspaceError(409, "social_post_busy");
      if (this.db.prepare("SELECT id FROM social_posts WHERE account_id=? AND id<>? AND owner IS NOT NULL AND lease_until>?").get(target.accountId, id, this.clock())) throw new WorkspaceError(409, "social_post_busy");
      if (digest !== null) {
        const mediaReady = p.state === "accepted" && p.receipt.providerState === "MEDIA_READY" && p.receipt.mediaId && !p.receipt.postIds.length && !p.receipt.jobId;
        if ((p.state !== "review" && !mediaReady) || r.dispatch_revoked || p.digest !== digest || socialDigest(p.payload) !== digest) throw new WorkspaceError(409, "social_approval_stale");
        consumeScheduledApproval(this.db, id, p.payload.scheduleBinding, this.clock(), p.state !== "review");
        const c = this.connection(target); this.assertConnection(c);
        if (c.revision !== p.payload.connectionRevision || c.subjectId !== p.payload.subjectId || c.appKey !== p.payload.appKey) throw new WorkspaceError(409, "social_connection_changed");
        p.state = "uploading"; p.error = null; p.approvalExpiresAt = new Date(this.clock() + 600_000).toISOString();
      } else if (!["processing", "uncertain", "accepted"].includes(p.state)) throw new WorkspaceError(409, "social_post_not_reconcilable");
      this.db.prepare("UPDATE social_posts SET data=?,owner=?,lease_until=? WHERE id=?").run(JSON.stringify(p), owner, this.clock() + 90_000, id);
      this.audit(target, digest === null ? "social.reconcile" : "social.approved", id); return p;
    });
  }
  assertDispatch(p: SocialPost, owner: string): void {
    const r = this.row(p.id, p.payload.target), stored = JSON.parse(r.data) as SocialPost;
    if (r.owner !== owner || r.lease_until <= this.clock() || r.dispatch_revoked) throw new WorkspaceError(409, "social_dispatch_stopped");
    if (!stored.approvalExpiresAt || this.clock() >= Date.parse(stored.approvalExpiresAt)) throw new WorkspaceError(409, "social_approval_expired");
    if (stored.digest !== p.digest || socialDigest(stored.payload) !== p.digest) throw new WorkspaceError(409, "social_approval_stale");
    const c = this.connection(p.payload.target); this.assertConnection(c);
    if (c.revision !== p.payload.connectionRevision || c.subjectId !== p.payload.subjectId || c.appKey !== p.payload.appKey) throw new WorkspaceError(409, "social_connection_changed");
  }
  checkpoint(p: SocialPost, owner: string, release = false): void {
    const r = this.row(p.id, p.payload.target), saved = JSON.parse(r.data) as SocialPost;
    if (saved.digest !== p.digest || socialDigest(p.payload) !== saved.digest || p.approvalExpiresAt !== saved.approvalExpiresAt) throw new WorkspaceError(409, "social_approval_stale");
    p.updatedAt = this.stamp(); p.dispatchRevoked = !!r.dispatch_revoked;
    if (!this.db.prepare("UPDATE social_posts SET data=?,owner=?,lease_until=? WHERE id=? AND owner=? AND lease_until>?")
      .run(JSON.stringify(p), release ? null : owner, release ? 0 : this.clock() + 90_000, p.id, owner, this.clock()).changes) throw new WorkspaceError(409, "social_post_busy");
  }
  session(p: SocialPost, owner: string): string | null { const r = this.row(p.id, p.payload.target); if (r.owner !== owner || r.lease_until <= this.clock()) throw new WorkspaceError(409, "social_post_busy"); return r.session_ref; }
  setSession(p: SocialPost, owner: string, ref: string | null): void {
    if (!this.db.prepare("UPDATE social_posts SET session_ref=? WHERE id=? AND owner=? AND lease_until>?").run(ref, p.id, owner, this.clock()).changes) throw new WorkspaceError(409, "social_post_busy");
  }
  stop(id: string, target: SocialTarget): SocialPost {
    return this.tx(() => {
      const p = this.post(id, target);
      if (p.state === "review") { p.state = "cancelled"; this.db.prepare("UPDATE social_posts SET data=? WHERE id=?").run(JSON.stringify(p), id); }
      this.db.prepare("UPDATE social_posts SET dispatch_revoked=1 WHERE id=?").run(id); p.dispatchRevoked = true;
      this.audit(target, "social.dispatch-stopped", id); return p;
    });
  }
}
