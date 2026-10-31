import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AuditEvent, CreateAccountInput, CreateMemoryInput, CreateProjectInput, UpdateMemoryInput,
  WorkspaceAccount, WorkspaceContext, WorkspaceMemory, WorkspaceProject
} from "../../domain/src/workspace.js";
import { contextSchema, createAccountSchema, createMemorySchema, createProjectSchema, idSchema, updateMemorySchema } from "../../domain/src/workspace.js";
import { redactSensitiveText, WorkspaceError } from "./config.js";
import { migrate } from "./migrations.js";
import type { YouTubeConnection } from "../../domain/src/youtube.js";
import { channelIdSchema } from "../../domain/src/youtube.js";

type Row = Record<string, string | number | null>;
const now = () => new Date().toISOString();
const accountFrom = (r: Row): WorkspaceAccount => ({
  id: String(r.id), displayName: String(r.display_name), platform: r.platform as WorkspaceAccount["platform"],
  destinationId: String(r.destination_id), status: r.status as WorkspaceAccount["status"], createdAt: String(r.created_at),
  ...(r.provider_subject_id ? { connection: { providerSubjectId: String(r.provider_subject_id),
    grantedScopes: JSON.parse(String(r.granted_scopes)) as string[], verifiedAt: String(r.verified_at) } } : {})
});
const projectFrom = (r: Row): WorkspaceProject => ({
  id: String(r.id), accountId: String(r.account_id), name: String(r.name), description: String(r.description), createdAt: String(r.created_at)
});
const memoryFrom = (r: Row): WorkspaceMemory => ({
  id: String(r.id), accountId: String(r.account_id), projectId: r.project_id as string | null,
  kind: r.kind as WorkspaceMemory["kind"], text: String(r.text), reviewState: r.review_state as WorkspaceMemory["reviewState"],
  revision: Number(r.revision), provenance: { sourceId: String(r.source_id), origin: "manual", recordedAt: String(r.recorded_at) }, updatedAt: String(r.updated_at)
});

export class WorkspaceStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try { migrate(this.db); } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private audit(scope: WorkspaceContext, action: string, entityId: string): void {
    this.db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,'local-user',?)")
      .run(randomUUID(), scope.accountId, scope.projectId, action, entityId, now());
  }
  listAccounts(): WorkspaceAccount[] {
    return (this.db.prepare(`SELECT a.*, c.provider_subject_id, c.granted_scopes, c.verified_at FROM accounts a
      LEFT JOIN youtube_connections c ON c.account_id=a.id ORDER BY a.created_at, a.id`).all() as Row[]).map(accountFrom);
  }
  getYouTubeConnection(accountId: string, destinationId: string): YouTubeConnection {
    idSchema.parse(accountId); channelIdSchema.parse(destinationId);
    const row = this.db.prepare(`SELECT c.* FROM youtube_connections c JOIN accounts a ON a.id=c.account_id
      WHERE c.account_id=? AND c.destination_id=? AND a.destination_id=c.destination_id AND a.platform='youtube'`).get(accountId, destinationId) as Row | undefined;
    if (!row) throw new WorkspaceError(404, "youtube_account_not_found");
    return { accountId, destinationId, providerSubjectId: String(row.provider_subject_id), credentialRef: row.credential_ref as string | null,
      grantedScopes: JSON.parse(String(row.granted_scopes)) as string[], verifiedAt: String(row.verified_at), revision: Number(row.revision) };
  }
  /** Only a server-verified identity may reach this internal repository method. */
  connectYouTube(input: { accountId: string; destinationId: string; displayName: string; providerSubjectId: string;
    credentialRef: string; grantedScopes: string[]; expectedRevision: number | null }): YouTubeConnection {
    idSchema.parse(input.accountId); channelIdSchema.parse(input.destinationId);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM youtube_connections WHERE destination_id=?").get(input.destinationId) as Row | undefined;
      if (input.expectedRevision === null) {
        if (existing || this.db.prepare("SELECT id FROM accounts WHERE id=?").get(input.accountId)) throw new WorkspaceError(409, "youtube_already_connected");
        this.db.prepare("INSERT INTO accounts VALUES(?,?,'youtube',?,'connected',?)")
          .run(input.accountId, redactSensitiveText(input.displayName).slice(0, 100), input.destinationId, now());
        this.db.prepare("INSERT INTO youtube_connections VALUES(?,?,?,?,?,?,1)").run(input.accountId, input.providerSubjectId,
          input.destinationId, input.credentialRef, JSON.stringify(input.grantedScopes), now());
      } else {
        const previous = this.getYouTubeConnection(input.accountId, input.destinationId);
        if (previous.revision !== input.expectedRevision) throw new WorkspaceError(409, "connection_conflict");
        if (previous.providerSubjectId !== input.providerSubjectId) throw new WorkspaceError(409, "youtube_identity_mismatch");
        this.db.prepare("UPDATE youtube_connections SET credential_ref=?,granted_scopes=?,verified_at=?,revision=revision+1 WHERE account_id=?")
          .run(input.credentialRef, JSON.stringify(input.grantedScopes), now(), input.accountId);
        this.db.prepare("UPDATE accounts SET status='connected',display_name=? WHERE id=?")
          .run(redactSensitiveText(input.displayName).slice(0, 100), input.accountId);
      }
      this.audit({ accountId: input.accountId, projectId: null }, "youtube.connected", input.accountId);
      if (!this.getContext()) this.saveContext({ accountId: input.accountId, projectId: null });
      return this.getYouTubeConnection(input.accountId, input.destinationId);
    });
  }
  setYouTubeStatus(connection: YouTubeConnection, status: "reauth-required" | "disconnected"): void {
    this.transaction(() => {
      const current = this.getYouTubeConnection(connection.accountId, connection.destinationId);
      if (current.revision !== connection.revision) throw new WorkspaceError(409, "connection_conflict");
      this.db.prepare("UPDATE accounts SET status=? WHERE id=?").run(status, connection.accountId);
      this.db.prepare(`UPDATE youtube_connections SET revision=revision+1${status === "disconnected" ? ",credential_ref=NULL" : ""} WHERE account_id=?`).run(connection.accountId);
      this.audit({ accountId: connection.accountId, projectId: null }, `youtube.${status}`, connection.accountId);
    });
  }
  recordYouTubeRevocation(providerSubjectId: string): void {
    this.transaction(() => {
      const rows = this.db.prepare(`SELECT c.account_id FROM youtube_connections c JOIN accounts a ON a.id=c.account_id
        WHERE c.provider_subject_id=? AND a.status<>'disconnected'`).all(providerSubjectId) as Row[];
      for (const row of rows) {
        const accountId = String(row.account_id);
        this.db.prepare("UPDATE accounts SET status='reauth-required' WHERE id=?").run(accountId);
        this.db.prepare("UPDATE youtube_connections SET revision=revision+1 WHERE account_id=?").run(accountId);
        this.audit({ accountId, projectId: null }, "youtube.grant-revoked", accountId);
      }
    });
  }
  createAccount(value: CreateAccountInput): WorkspaceAccount {
    const input = createAccountSchema.parse(value);
    return this.transaction(() => {
      const id = randomUUID();
      const account: WorkspaceAccount = { id, displayName: redactSensitiveText(input.displayName), platform: input.platform,
        destinationId: `demo:${input.platform}:${id}`, status: "demo", createdAt: now() };
      this.db.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)").run(id, account.displayName, account.platform, account.destinationId, "demo", account.createdAt);
      this.audit({ accountId: id, projectId: null }, "account.created", id);
      if (!this.getContext()) this.saveContext({ accountId: id, projectId: null });
      return account;
    });
  }
  resolveContext(value: WorkspaceContext): WorkspaceContext {
    const scope = contextSchema.parse(value);
    if (!this.db.prepare("SELECT id FROM accounts WHERE id=?").get(scope.accountId)) throw new WorkspaceError(404, "context_not_found");
    if (scope.projectId !== null && !this.db.prepare("SELECT id FROM projects WHERE id=? AND account_id=?").get(scope.projectId, scope.accountId)) {
      throw new WorkspaceError(404, "context_not_found");
    }
    return scope;
  }
  getContext(): WorkspaceContext | null {
    const r = this.db.prepare("SELECT * FROM context WHERE singleton=1").get() as Row | undefined;
    return r ? { accountId: String(r.account_id), projectId: r.project_id as string | null } : null;
  }
  private saveContext(scope: WorkspaceContext): void {
    this.db.prepare("INSERT INTO context VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET account_id=excluded.account_id,project_id=excluded.project_id")
      .run(scope.accountId, scope.projectId);
  }
  setContext(value: WorkspaceContext): WorkspaceContext {
    return this.transaction(() => {
      const scope = this.resolveContext(value);
      this.saveContext(scope);
      this.audit(scope, "context.selected", scope.projectId ?? scope.accountId);
      return scope;
    });
  }
  listProjects(accountId: string): WorkspaceProject[] {
    this.resolveContext({ accountId, projectId: null });
    return (this.db.prepare("SELECT * FROM projects WHERE account_id=? ORDER BY created_at DESC, id").all(accountId) as Row[]).map(projectFrom);
  }
  createProject(value: CreateProjectInput): WorkspaceProject {
    const input = createProjectSchema.parse(value);
    return this.transaction(() => {
      this.resolveContext({ accountId: input.accountId, projectId: null });
      const project: WorkspaceProject = { id: randomUUID(), accountId: input.accountId, name: redactSensitiveText(input.name),
        description: redactSensitiveText(input.description), createdAt: now() };
      this.db.prepare("INSERT INTO projects VALUES(?,?,?,?,?)").run(project.id, project.accountId, project.name, project.description, project.createdAt);
      this.audit({ accountId: project.accountId, projectId: project.id }, "project.created", project.id);
      return project;
    });
  }
  listMemory(value: WorkspaceContext): WorkspaceMemory[] {
    const scope = this.resolveContext(value);
    return (this.db.prepare("SELECT * FROM memory WHERE account_id=? AND project_id IS ? ORDER BY updated_at DESC, id").all(scope.accountId, scope.projectId) as Row[]).map(memoryFrom);
  }
  createMemory(value: CreateMemoryInput): WorkspaceMemory {
    const input = createMemorySchema.parse(value);
    return this.transaction(() => {
      const scope = this.resolveContext(input.context);
      const stamp = now();
      const entry: WorkspaceMemory = { id: randomUUID(), ...scope, kind: input.kind, text: redactSensitiveText(input.text),
        reviewState: input.reviewState, revision: 1, provenance: { sourceId: randomUUID(), origin: "manual", recordedAt: stamp }, updatedAt: stamp };
      this.db.prepare("INSERT INTO memory VALUES(?,?,?,?,?,?,?,?,?,?)").run(entry.id, scope.accountId, scope.projectId,
        entry.kind, entry.text, entry.reviewState, 1, entry.provenance.sourceId, stamp, stamp);
      this.audit(scope, "memory.created", entry.id);
      return entry;
    });
  }
  private findMemory(id: string, scope: WorkspaceContext, revision: number): WorkspaceMemory {
    idSchema.parse(id);
    const row = this.db.prepare("SELECT * FROM memory WHERE id=? AND account_id=? AND project_id IS ?").get(id, scope.accountId, scope.projectId) as Row | undefined;
    if (!row) throw new WorkspaceError(404, "memory_not_found");
    const entry = memoryFrom(row);
    if (entry.revision !== revision) throw new WorkspaceError(409, "revision_conflict");
    return entry;
  }
  updateMemory(id: string, value: UpdateMemoryInput): WorkspaceMemory {
    const input = updateMemorySchema.parse(value);
    return this.transaction(() => {
      const scope = this.resolveContext(input.context);
      const previous = this.findMemory(id, scope, input.expectedRevision);
      const entry = { ...previous, kind: input.kind, text: redactSensitiveText(input.text), reviewState: input.reviewState, revision: previous.revision + 1, updatedAt: now() };
      this.db.prepare("UPDATE memory SET kind=?,text=?,review_state=?,revision=?,updated_at=? WHERE id=? AND account_id=? AND project_id IS ?")
        .run(entry.kind, entry.text, entry.reviewState, entry.revision, entry.updatedAt, id, scope.accountId, scope.projectId);
      this.audit(scope, "memory.updated", id);
      return entry;
    });
  }
  deleteMemory(id: string, value: WorkspaceContext, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new WorkspaceError(400, "invalid_revision");
    this.transaction(() => {
      const scope = this.resolveContext(value);
      this.findMemory(id, scope, revision);
      this.db.prepare("DELETE FROM memory WHERE id=? AND account_id=? AND project_id IS ?").run(id, scope.accountId, scope.projectId);
      this.audit(scope, "memory.deleted", id);
    });
  }
  listAudit(value: WorkspaceContext): AuditEvent[] {
    const scope = this.resolveContext(value);
    return (this.db.prepare("SELECT * FROM audit WHERE account_id=? AND project_id IS ? ORDER BY recorded_at DESC,rowid DESC LIMIT 50").all(scope.accountId, scope.projectId) as Row[]).map(r => ({
      id: String(r.id), accountId: String(r.account_id), projectId: r.project_id as string | null,
      action: String(r.action), entityId: String(r.entity_id), actor: "local-user", recordedAt: String(r.recorded_at)
    }));
  }
}
