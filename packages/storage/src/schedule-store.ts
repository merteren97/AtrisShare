import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createScheduleSchema, futureStart, nextSlot, scheduleRuleSchema, type Schedule, type ScheduleRule, type ScheduleKind, type Occurrence } from "../../domain/src/scheduling.js";
import type { WorkspaceContext } from "../../domain/src/workspace.js";
import { idSchema } from "../../domain/src/workspace.js";
import { studioContextSchema, type PublicationPayload, type StudioPublication } from "../../domain/src/studio.js";
import type { SocialPayload, SocialPost } from "../../domain/src/social.js";
import { publicationDigest } from "./studio-store.js";
import { socialDigest } from "./social-store.js";
import { redactSensitiveText, WorkspaceError } from "./config.js";

type Row = { id: string; data: string; template: string };
type Template = { kind: "youtube"; payload: PublicationPayload } | { kind: "social"; payload: SocialPayload };
const REVIEW_MS = 86400_000;
export class ScheduleStore {
  constructor(private readonly db: DatabaseSync, private readonly resolve: (c: WorkspaceContext) => WorkspaceContext,
    private readonly audit: (c: WorkspaceContext, action: string, id: string) => void, private readonly clock: () => number = Date.now) {}
  private tx<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const v = fn(); this.db.exec("COMMIT"); return v; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  private scope(context: WorkspaceContext) { const c = studioContextSchema.parse(context); this.resolve(c); return c; }
  private table(kind: ScheduleKind) { return kind === "youtube" ? "publications" : "social_posts"; }
  private row(id: string, context: WorkspaceContext): Row {
    idSchema.parse(id); const c = this.scope(context);
    const row = this.db.prepare("SELECT * FROM schedules WHERE id=? AND account_id=? AND project_id=?").get(id, c.accountId, c.projectId) as Row | undefined;
    if (!row) throw new WorkspaceError(404, "schedule_not_found"); return row;
  }
  private save(s: Schedule) { this.db.prepare("UPDATE schedules SET data=? WHERE id=?").run(JSON.stringify(s), s.id); }
  private saveOccurrence(o: Occurrence) { this.db.prepare("UPDATE schedule_occurrences SET data=?,publication_id=? WHERE id=?").run(JSON.stringify(o), o.publicationId, o.id); }
  private addSlot(s: Schedule, slot: { dueAt: string; localTime: string }): void {
    const o: Occurrence = { id: randomUUID(), scheduleId: s.id, context: s.context, destinationId: s.destinationId, kind: s.kind,
      dueAt: slot.dueAt, localTime: slot.localTime, timeZone: s.rule.timeZone, reviewUntil: new Date(Date.parse(slot.dueAt) + REVIEW_MS).toISOString(),
      state: "scheduled", publicationId: null, error: null, missed: false };
    this.db.prepare("INSERT INTO schedule_occurrences VALUES(?,?,?,?,?,?,?,?)").run(o.id, s.id, s.context.accountId, s.context.projectId, o.dueAt, s.revision, null, JSON.stringify(o));
  }
  create(value: unknown): Schedule {
    const input = createScheduleSchema.parse(value);
    return this.tx(() => {
      const c = this.scope(input.context), now = this.clock(), slot = nextSlot(input.rule, now);
      if (!slot || !futureStart(input.rule, now)) throw new WorkspaceError(400, "schedule_future_required");
      if ((this.db.prepare("SELECT count(*) n FROM schedules WHERE account_id=? AND project_id=? AND json_extract(data,'$.state') IN('active','paused')").get(c.accountId, c.projectId) as { n: number }).n >= 100) throw new WorkspaceError(409, "schedule_capacity");
      const table = this.table(input.kind);
      const r = this.db.prepare(`SELECT data FROM ${table} WHERE id=? AND account_id=? AND project_id=?`).get(input.draftId, c.accountId, c.projectId) as Row | undefined;
      if (!r) throw new WorkspaceError(404, "publication_not_found");
      const p = JSON.parse(r.data) as StudioPublication | SocialPost;
      if (p.state !== "review" || p.payload.scheduleBinding) throw new WorkspaceError(409, "schedule_draft_required");
      const payload = p.payload;
      const destinationId = input.kind === "youtube" ? (payload as PublicationPayload).destinationId : (payload as SocialPayload).target.destinationId;
      const s: Schedule = { id: randomUUID(), name: redactSensitiveText(input.name), context: c, destinationId, kind: input.kind, rule: input.rule,
        revision: 1, state: "active", nextDueAt: slot.dueAt, createdAt: new Date(now).toISOString() };
      this.db.prepare("INSERT INTO schedules VALUES(?,?,?,?,?)").run(s.id, c.accountId, c.projectId, JSON.stringify(s), JSON.stringify({ kind: input.kind, payload }));
      this.db.prepare(`UPDATE ${table} SET data=json_set(data,'$.state','cancelled') WHERE id=?`).run(input.draftId);
      this.addSlot(s, slot); this.audit(c, "schedule.created", s.id); return s;
    });
  }
  private cancelPending(s: Schedule): void {
    const rows = this.db.prepare("SELECT data FROM schedule_occurrences WHERE schedule_id=? AND json_extract(data,'$.state') IN('scheduled','awaiting-approval','blocked')").all(s.id) as Row[];
    for (const row of rows) { const o = JSON.parse(row.data) as Occurrence; this.endOccurrence(o, "cancelled"); }
  }
  change(id: string, context: WorkspaceContext, revision: number, action: "pause" | "resume" | "cancel" | "reschedule", rule?: ScheduleRule): Schedule {
    return this.tx(() => {
      const s = JSON.parse(this.row(id, context).data) as Schedule;
      if (s.revision !== revision) throw new WorkspaceError(409, "revision_conflict");
      if (s.state === "cancelled" || (action === "pause" && s.state !== "active") || (action === "resume" && s.state !== "paused")) throw new WorkspaceError(409, "schedule_state_conflict");
      if (action === "reschedule") { s.rule = scheduleRuleSchema.parse(rule); if (!futureStart(s.rule, this.clock())) throw new WorkspaceError(400, "schedule_future_required"); }
      this.cancelPending(s); s.revision++; s.nextDueAt = null;
      s.state = action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "active";
      if (s.state === "active") {
        // A new generation gets a fresh occurrence and timing-bound digest, including the same future wall slot.
        const slot = nextSlot(s.rule, this.clock());
        if (!slot) throw new WorkspaceError(400, "schedule_future_required");
        s.nextDueAt = slot.dueAt; this.addSlot(s, slot);
      }
      this.save(s); this.audit(s.context, `schedule.${action}`, id); return s;
    });
  }
  private endOccurrence(o: Occurrence, state: "expired" | "cancelled" | "skipped") {
    if (o.publicationId) this.db.prepare(`UPDATE ${this.table(o.kind)} SET data=json_set(data,'$.state','cancelled') WHERE id=? AND json_extract(data,'$.state')='review'`).run(o.publicationId);
    o.state = state; this.saveOccurrence(o);
  }
  skip(id: string, context: WorkspaceContext): Occurrence {
    return this.tx(() => {
      idSchema.parse(id); const c = this.scope(context);
      const row = this.db.prepare("SELECT data FROM schedule_occurrences WHERE id=? AND account_id=? AND project_id=?").get(id, c.accountId, c.projectId) as Row | undefined;
      if (!row) throw new WorkspaceError(404, "occurrence_not_found");
      const o = JSON.parse(row.data) as Occurrence;
      if (!["scheduled", "awaiting-approval", "blocked"].includes(o.state)) throw new WorkspaceError(409, "schedule_state_conflict");
      this.endOccurrence(o, "skipped"); this.audit(c, "schedule.skipped", id); return o;
    });
  }
  /** Only local SQL work is retried by the next tick. No provider call or automatic approval lives here. */
  tick(): void {
    this.tx(() => {
      const now = this.clock();
      const reviews = this.db.prepare("SELECT data FROM schedule_occurrences WHERE json_extract(data,'$.state') IN('awaiting-approval','dispatched')").all() as Row[];
      for (const row of reviews) {
        const o = JSON.parse(row.data) as Occurrence;
        const p = this.db.prepare(`SELECT data FROM ${this.table(o.kind)} WHERE id=?`).get(o.publicationId) as Row | undefined;
        const publication = p ? JSON.parse(p.data) as { state: string; receipt?: { postIds: string[] } } : null;
        if (publication && ["succeeded", "failed", "cancelled"].includes(publication.state) || publication?.state === "accepted" && publication.receipt?.postIds.length) {
          o.state = publication?.state === "cancelled" ? "cancelled" : "completed"; this.saveOccurrence(o);
        } else if (publication && publication.state !== "review") { o.state = "dispatched"; this.saveOccurrence(o); }
        else if (o.state === "awaiting-approval" && now >= Date.parse(o.reviewUntil)) this.endOccurrence(o, "expired");
      }
      const due = this.db.prepare("SELECT * FROM schedules WHERE json_extract(data,'$.state')='active' AND json_extract(data,'$.nextDueAt')<=? ORDER BY json_extract(data,'$.nextDueAt') LIMIT 100").all(new Date(now).toISOString()) as Row[];
      for (const row of due) {
        const s = JSON.parse(row.data) as Schedule, template = JSON.parse(row.template) as Template;
        const r = this.db.prepare("SELECT data FROM schedule_occurrences WHERE schedule_id=? AND due_at=? AND generation=?").get(s.id, s.nextDueAt, s.revision) as Row | undefined;
        if (!r) throw new WorkspaceError(500, "schedule_slot_missing");
        const o = JSON.parse(r.data) as Occurrence;
        if (o.state === "scheduled") {
          o.missed = now - Date.parse(o.dueAt) > 60_000;
          if (now >= Date.parse(o.reviewUntil)) this.endOccurrence(o, "expired");
          else if (o.missed && s.rule.missedPolicy === "skip") this.endOccurrence(o, "skipped");
          else {
            const id = randomUUID(), binding = { occurrenceId: o.id, dueAt: o.dueAt, reviewUntil: o.reviewUntil };
            if (template.kind === "youtube") {
              const payload: PublicationPayload = { ...template.payload, scheduleBinding: binding };
              const p: StudioPublication = { id, context: s.context, revision: 1, payload, digest: publicationDigest(payload), state: "review", approvalExpiresAt: null,
                progress: 0, videoId: null, error: null, createdAt: new Date(now).toISOString() };
              this.db.prepare("INSERT INTO publications(id,account_id,project_id,artifact_id,data) VALUES(?,?,?,?,?)").run(id, s.context.accountId, s.context.projectId, payload.artifactId, JSON.stringify(p));
            } else {
              const payload: SocialPayload = { ...template.payload, scheduleBinding: binding };
              // Same-principal reauthorization updates a NEW review only, never an issued digest or destination.
              const current = this.db.prepare("SELECT s.*,a.status FROM social_connections s JOIN accounts a ON a.id=s.account_id WHERE s.account_id=? AND s.destination_id=?").get(s.context.accountId, s.destinationId) as { data: string; revision: number; app_key: string; subject_id: string; provider: string; status: string } | undefined;
              if (current && current.status === "connected" && current.subject_id === payload.subjectId && current.app_key === payload.appKey && current.provider === payload.metadata.provider) payload.connectionRevision = current.revision;
              const p: SocialPost = { id, payload, digest: socialDigest(payload), state: "review", approvalExpiresAt: null, progress: 0,
                receipt: { jobId: null, mediaId: null, postIds: [], providerState: null, publicUrl: null }, error: null,
                createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), dispatchRevoked: false };
              this.db.prepare("INSERT INTO social_posts(id,account_id,project_id,destination_id,data) VALUES(?,?,?,?,?)").run(id, s.context.accountId, s.context.projectId, s.destinationId, JSON.stringify(p));
            }
            o.publicationId = id; o.state = "awaiting-approval"; this.saveOccurrence(o); this.audit(s.context, "schedule.review-due", o.id);
          }
        }
        // Collapse offline backlog explicitly; never burst through past recurrences or create auto-approved work.
        if (now - Date.parse(o.dueAt) >= REVIEW_MS) s.missedThrough = new Date(now).toISOString();
        const slot = s.rule.frequency === "once" ? null : nextSlot(s.rule, now);
        s.nextDueAt = slot?.dueAt ?? null; s.state = slot ? "active" : "completed";
        if (slot) this.addSlot(s, slot); this.save(s);
      }
    });
  }
  snapshot(context: WorkspaceContext) {
    const c = this.scope(context);
    const schedules = (this.db.prepare(`SELECT data FROM schedules WHERE account_id=? AND project_id=? AND json_extract(data,'$.state') IN('active','paused')
      UNION ALL SELECT data FROM (SELECT data FROM schedules WHERE account_id=? AND project_id=? AND json_extract(data,'$.state') NOT IN('active','paused') ORDER BY rowid DESC LIMIT 200)`).all(c.accountId, c.projectId, c.accountId, c.projectId) as Row[]).map(r => JSON.parse(r.data) as Schedule);
    const occurrences = (this.db.prepare(`SELECT data FROM schedule_occurrences WHERE account_id=? AND project_id=? AND json_extract(data,'$.state') IN('scheduled','awaiting-approval','blocked','dispatched')
      UNION ALL SELECT data FROM (SELECT data FROM schedule_occurrences WHERE account_id=? AND project_id=? AND json_extract(data,'$.state') NOT IN('scheduled','awaiting-approval','blocked','dispatched') ORDER BY due_at DESC LIMIT 300)`).all(c.accountId, c.projectId, c.accountId, c.projectId) as Row[]).map(r => {
      const o = JSON.parse(r.data) as Occurrence;
      if (o.publicationId) { const p = this.db.prepare(`SELECT data FROM ${this.table(o.kind)} WHERE id=?`).get(o.publicationId) as Row | undefined; if (p) o.publicationState = (JSON.parse(p.data) as { state: string }).state; }
      return o;
    });
    const drafts: { kind: ScheduleKind; id: string; label: string; destinationId: string }[] = [];
    for (const kind of ["youtube", "social"] as const) for (const r of this.db.prepare(`SELECT id,data FROM ${this.table(kind)} WHERE account_id=? AND project_id=? AND json_extract(data,'$.state')='review' ORDER BY rowid DESC LIMIT 100`).all(c.accountId, c.projectId) as Row[]) {
      const p = JSON.parse(r.data) as StudioPublication | SocialPost;
      if (p.payload.scheduleBinding) continue;
      drafts.push({ kind, id: r.id, label: kind === "youtube" ? (p.payload as PublicationPayload).title : (p.payload as SocialPayload).metadata.text.slice(0, 100), destinationId: kind === "youtube" ? (p.payload as PublicationPayload).destinationId : (p.payload as SocialPayload).target.destinationId });
    }
    return { schedules, occurrences, drafts, runningOnly: true as const };
  }
  dueReviews(): Occurrence[] {
    return (this.db.prepare("SELECT data FROM schedule_occurrences WHERE json_extract(data,'$.state')='awaiting-approval' ORDER BY due_at LIMIT 100").all() as Row[]).map(r => JSON.parse(r.data) as Occurrence);
  }
  notificationPage(after?: { dueAt: string; id: string }) {
    const rows = (after ? this.db.prepare("SELECT data FROM schedule_occurrences WHERE json_extract(data,'$.state')='awaiting-approval' AND (due_at>? OR (due_at=? AND id>?)) ORDER BY due_at,id LIMIT 101").all(after.dueAt, after.dueAt, after.id)
      : this.db.prepare("SELECT data FROM schedule_occurrences WHERE json_extract(data,'$.state')='awaiting-approval' ORDER BY due_at,id LIMIT 101").all()) as Row[];
    const occurrences = rows.slice(0, 100).map(r => JSON.parse(r.data) as Occurrence), last = occurrences.at(-1);
    return { occurrences, next: rows.length > 100 && last ? { dueAt: last.dueAt, id: last.id } : null };
  }
  processingReceipts() {
    const result: { id: string; kind: ScheduleKind; context: WorkspaceContext; destinationId: string }[] = [];
    for (const kind of ["youtube", "social"] as const) for (const row of this.db.prepare(`SELECT id,account_id,project_id,data FROM ${this.table(kind)} WHERE json_extract(data,'$.state')='processing' LIMIT 100`).all() as unknown as { id: string; account_id: string; project_id: string; data: string }[]) {
      const p = JSON.parse(row.data) as StudioPublication | SocialPost;
      if (kind === "youtube" && !(p as StudioPublication).videoId) continue;
      result.push({ id: row.id, kind, context: { accountId: row.account_id, projectId: row.project_id }, destinationId: kind === "youtube" ? (p.payload as PublicationPayload).destinationId : (p.payload as SocialPayload).target.destinationId });
    }
    return result;
  }
}
