import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
import { ScheduleStore } from "../dist/packages/storage/src/schedule-store.js";
import { nextSlot, wallInstant, scheduleRuleSchema } from "../dist/packages/domain/src/scheduling.js";
import { consumeScheduledApproval } from "../dist/packages/storage/src/schedule-gate.js";
import { socialDigest } from "../dist/packages/storage/src/social-store.js";
import { SocialStore } from "../dist/packages/storage/src/social-store.js";
import { Worker } from "node:worker_threads";

const rule = (localStart, overrides = {}) => ({ frequency: "once", localStart, timeZone: "UTC", weekdays: [], missedPolicy: "ask", ...overrides });
const at = value => Date.parse(value);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "atrisshare-schedule-")), path = join(dir, "db.sqlite"), w = new WorkspaceStore(path);
  const db = new DatabaseSync(path); db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  let now = at("2027-01-01T08:00:00Z");
  const queue = new ScheduleStore(db, c => w.resolveContext(c), () => {}, () => now);
  const a = w.createAccount({ displayName: "Demo scope", platform: "youtube" }), b = w.createAccount({ displayName: "Other", platform: "x" });
  const p = w.createProject({ accountId: a.id, name: "Scoped", description: "" }), c = { accountId: a.id, projectId: p.id };
  const artifact = { id: randomUUID(), ...c, sha256: "a".repeat(64), bytes: 1234, mimeType: "video/mp4", filename: "owned.mp4", probe: null,
    kind: "source", sourceId: null, channelVideoId: null, createdAt: new Date(now).toISOString() };
  w.studio.addArtifact(artifact);
  const draft = () => w.studio.create({ context: c, artifactId: artifact.id, title: "Review me", description: "", visibility: "private", madeForKids: false, notifySubscribers: false }, a.destinationId);
  const create = (r = rule("2027-01-01T09:00")) => queue.create({ context: c, name: "Daily owned video", kind: "youtube", draftId: draft().id, rule: r });
  t.after(async () => { db.close(); w.close(); await rm(dir, { recursive: true, force: true }); });
  return { w, db, path, queue, c, a, b, artifact, draft, create, now: () => now, setNow: value => { now = typeof value === "number" ? value : at(value); } };
}

test("IANA DST: gaps skip, overlap first, half-hour and date-line transitions round-trip", () => {
  assert.equal(wallInstant("2027-03-14T02:30", "America/New_York"), null);
  assert.equal(new Date(wallInstant("2027-11-07T01:30", "America/New_York")).toISOString(), "2027-11-07T05:30:00.000Z");
  assert.equal(wallInstant("2027-03-28T02:30", "Europe/Berlin"), null);
  assert.equal(new Date(wallInstant("2027-10-31T02:30", "Europe/Berlin")).toISOString(), "2027-10-31T00:30:00.000Z");
  assert.equal(wallInstant("2027-10-03T02:15", "Australia/Lord_Howe"), null);
  assert.equal(new Date(wallInstant("2027-04-04T01:45", "Australia/Lord_Howe")).toISOString(), "2027-04-03T14:45:00.000Z");
  assert.equal(wallInstant("2011-12-30T12:00", "Pacific/Apia"), null);
  assert.equal(nextSlot(rule("2027-03-13T02:30", { frequency: "daily", timeZone: "America/New_York" }), at("2027-03-13T08:00Z")).dueAt, "2027-03-15T06:30:00.000Z");
});
test("weekly weekday and start boundary are independent from device timezone", () => {
  const r = rule("2027-01-04T09:00", { frequency: "weekly", timeZone: "Asia/Kathmandu", weekdays: [1, 5] });
  assert.equal(nextSlot(r, at("2027-01-01T00:00Z")).dueAt, "2027-01-04T03:15:00.000Z");
  assert.equal(nextSlot(r, at("2027-01-04T03:15Z")).dueAt, "2027-01-08T03:15:00.000Z");
  assert.equal(scheduleRuleSchema.safeParse(rule("2027-02-30T12:00")).success, false);
  assert.equal(scheduleRuleSchema.safeParse(rule("2027-01-01T09:00", { timeZone: "Imaginary/Zone" })).success, false);
  assert.equal(scheduleRuleSchema.safeParse(rule("2027-01-01T09:00", { frequency: "weekly", weekdays: [] })).success, false);
});
test("scheduling consumes a review draft; due time materializes one fresh immutable review, never approval", async t => {
  const f = await fixture(t), s = f.create();
  assert.equal(f.queue.snapshot(f.c).drafts.length, 0);
  assert.equal(f.queue.snapshot(f.c).occurrences[0].state, "scheduled");
  assert.equal(f.w.studio.publications(f.c).filter(p => p.state === "review").length, 0);
  f.setNow("2027-01-01T09:00Z"); f.queue.tick(); f.queue.tick();
  const o = f.queue.snapshot(f.c).occurrences[0], p = f.w.studio.publication(o.publicationId, f.c);
  assert.equal(o.state, "awaiting-approval"); assert.equal(p.state, "review"); assert.equal(p.approvalExpiresAt, null);
  assert.deepEqual(p.payload.scheduleBinding, { occurrenceId: o.id, dueAt: o.dueAt, reviewUntil: o.reviewUntil });
  assert.equal(f.w.studio.publications(f.c).filter(p => p.state === "review").length, 1);
  assert.equal(f.queue.snapshot(f.c).schedules[0].state, "completed");
  p.state = "succeeded";
  f.db.prepare("UPDATE publications SET data=? WHERE id=?").run(JSON.stringify(p), p.id); f.queue.tick();
  assert.equal(f.queue.snapshot(f.c).occurrences[0].state, "completed");
  assert.throws(() => f.queue.snapshot({ accountId: f.b.id, projectId: f.c.projectId }), /context_not_found/);
});
test("two runtimes/restart cannot duplicate occurrences or publications", async t => {
  const f = await fixture(t); f.create(rule("2027-01-01T09:00", { frequency: "daily" })); f.setNow("2027-01-01T09:00Z");
  const other = new WorkspaceStore(f.path), otherDb = new DatabaseSync(f.path);
  const otherQueue = new ScheduleStore(otherDb, c => other.resolveContext(c), () => {}, f.now);
  try { f.queue.tick(); otherQueue.tick(); f.queue.tick();
    const rows = f.db.prepare("SELECT schedule_id,due_at,generation,count(*) n FROM schedule_occurrences GROUP BY schedule_id,due_at,generation").all();
    assert.ok(rows.every(r => r.n === 1));
    assert.equal(f.w.studio.publications(f.c).filter(p => p.payload.scheduleBinding).length, 1);
  } finally { otherDb.close(); other.close(); }
});
test("competing worker threads materialize the same due slot only once", async t => {
  const f = await fixture(t); f.create();
  const barrier = new SharedArrayBuffer(8), state = new Int32Array(barrier);
  const workers = [0, 1].map(() => new Worker(new URL("./fixtures/scheduler-worker.mjs", import.meta.url), { workerData: { path: f.path, barrier, now: at("2027-01-01T09:00Z") } }));
  t.after(() => Promise.all(workers.map(w => w.terminate())));
  const done = workers.map(w => new Promise((resolve, reject) => { w.once("message", resolve); w.once("error", reject); }));
  const deadline = Date.now() + 10000;
  while (Atomics.load(state, 0) < 2) { if (Date.now() > deadline) throw new Error("Worker barrier timeout"); await new Promise(r => setTimeout(r, 5)); }
  Atomics.store(state, 1, 1); Atomics.notify(state, 1, 2); await Promise.all(done);
  assert.equal(f.w.studio.publications(f.c).filter(p => p.payload.scheduleBinding).length, 1);
  assert.equal(f.queue.dueReviews().length, 1);
});
test("past or numeric-offset rules are rejected without consuming a draft or changing a schedule", async t => {
  const f = await fixture(t), p = f.draft();
  for (const r of [rule("2020-01-01T09:00", { frequency: "daily" }), rule("2027-01-01T09:00", { timeZone: "+03:00" })]) {
    assert.throws(() => f.queue.create({ context: f.c, kind: "youtube", draftId: p.id, name: "Invalid", rule: r }));
    assert.equal(f.w.studio.publication(p.id, f.c).state, "review");
  }
  const s = f.create();
  assert.throws(() => f.queue.change(s.id, f.c, 1, "reschedule", rule("2020-01-01T09:00", { frequency: "weekly", weekdays: [1] })), /schedule_future_required/);
  assert.equal(f.queue.snapshot(f.c).schedules[0].revision, 1);
});
test("missed policy ask/skip, 24h expiry and long offline backlog never silently dispatch", async t => {
  const f = await fixture(t);
  f.create(rule("2027-01-01T09:00", { frequency: "daily" }));
  f.create(rule("2027-01-01T09:00", { missedPolicy: "skip" }));
  f.setNow("2027-01-01T10:00Z"); f.queue.tick();
  assert.deepEqual(f.queue.snapshot(f.c).occurrences.filter(o => o.dueAt.startsWith("2027-01-01")).map(o => o.state).sort(), ["awaiting-approval", "skipped"]);
  f.setNow("2027-03-01T12:00Z"); f.queue.tick();
  const snapshot = f.queue.snapshot(f.c);
  assert.equal(snapshot.occurrences.filter(o => o.state === "awaiting-approval").length, 0);
  assert.equal(snapshot.schedules.find(s => s.state === "active").missedThrough, "2027-03-01T12:00:00.000Z");
  assert.equal(snapshot.occurrences.filter(o => o.state === "scheduled")[0].dueAt, "2027-03-02T09:00:00.000Z");
  assert.ok(f.w.studio.publications(f.c).every(p => p.state === "cancelled"));
});
test("pause/resume same future slot produces a new occurrence generation, CAS rejects stale actions", async t => {
  const f = await fixture(t), s = f.create(), first = f.queue.snapshot(f.c).occurrences[0];
  const paused = f.queue.change(s.id, f.c, 1, "pause");
  assert.throws(() => f.queue.change(s.id, f.c, 1, "resume"), /revision_conflict/);
  const resumed = f.queue.change(s.id, f.c, paused.revision, "resume");
  const all = f.queue.snapshot(f.c).occurrences;
  assert.equal(resumed.nextDueAt, first.dueAt); assert.equal(all.length, 2); assert.equal(all.filter(o => o.state === "scheduled").length, 1);
  f.setNow("2027-01-01T09:00Z"); f.queue.tick();
  assert.notEqual(f.queue.dueReviews()[0].id, first.id);
});
test("scheduled approval is timing-bound, single-use and atomic with publication claim", async t => {
  const f = await fixture(t); f.create(); f.setNow("2027-01-01T09:00Z"); f.queue.tick();
  const o = f.queue.dueReviews()[0], p = f.w.studio.publication(o.publicationId, f.c), binding = p.payload.scheduleBinding;
  const consume = (b, time) => { f.db.exec("BEGIN IMMEDIATE"); try { consumeScheduledApproval(f.db, p.id, b, time); f.db.exec("COMMIT"); } catch (e) { f.db.exec("ROLLBACK"); throw e; } };
  assert.throws(() => consume(binding, at("2027-01-01T08:59Z")), /schedule_approval_stale/);
  assert.throws(() => consume({ ...binding, dueAt: "2027-01-01T08:00:00.000Z" }, at("2027-01-01T09:00Z")), /schedule_approval_stale/);
  assert.throws(() => consume(binding, at("2027-01-02T09:00Z")), /schedule_approval_stale/);
  assert.equal(f.queue.dueReviews().length, 1);
  consume(binding, at("2027-01-01T09:00Z")); assert.equal(f.queue.dueReviews().length, 0);
  assert.throws(() => consume(binding, at("2027-01-01T09:01Z")), /schedule_approval_stale/);
});
test("rescheduling/cancelling revokes outstanding review and cannot revive an old approval", async t => {
  const f = await fixture(t), s = f.create(rule("2027-01-01T09:00", { frequency: "daily" }));
  f.setNow("2027-01-01T09:00Z"); f.queue.tick(); const o = f.queue.dueReviews()[0];
  const next = f.queue.change(s.id, f.c, 1, "reschedule", rule("2027-01-01T11:00", { frequency: "daily" }));
  assert.equal(f.w.studio.publication(o.publicationId, f.c).state, "cancelled");
  assert.equal(f.queue.dueReviews().length, 0);
  assert.throws(() => f.w.studio.claim(o.publicationId, f.c, randomUUID(), f.w.studio.publication(o.publicationId, f.c).digest), /approval_stale/);
  f.queue.change(next.id, f.c, next.revision, "cancel"); f.setNow("2027-01-02T12:00Z"); f.queue.tick();
  assert.equal(f.queue.snapshot(f.c).occurrences.filter(o => o.state === "scheduled").length, 0);
});
test("social text occurrences retain exact target/payload and different recurrence approval digests", async t => {
  const f = await fixture(t), id = randomUUID();
  const payload = { version: 1, target: { ...f.c, destinationId: f.a.destinationId }, metadata: { provider: "x", text: "Explicit target", paidPartnership: false, madeWithAi: false },
    media: null, subjectId: "123", connectionRevision: 1, appKey: "b".repeat(64) };
  // Controlled internal fixture; live connections are separately tested in social.test.mjs.
  const p = { id, payload, digest: socialDigest(payload), state: "review" };
  f.db.prepare("INSERT INTO social_posts(id,account_id,project_id,destination_id,data) VALUES(?,?,?,?,?)").run(id, f.c.accountId, f.c.projectId, f.a.destinationId, JSON.stringify(p));
  f.queue.create({ context: f.c, name: "Text", kind: "social", draftId: id, rule: rule("2027-01-01T09:00", { frequency: "daily" }) });
  f.setNow("2027-01-01T09:00Z"); f.queue.tick();
  f.setNow("2027-01-02T09:00Z"); f.queue.tick();
  const values = f.db.prepare("SELECT data FROM social_posts WHERE id<>?").all(id).map(r => JSON.parse(r.data));
  assert.equal(values.length, 2); assert.notEqual(values[0].digest, values[1].digest);
  assert.deepEqual(values[0].payload.target, payload.target); assert.equal(values[0].payload.metadata.text, payload.metadata.text);
  assert.equal(values[0].state, "cancelled"); assert.equal(values[1].state, "review");
});

test("social MEDIA_READY reapproval checks schedule expiry/generation and failed claims roll back consumption", async t => {
  const f = await fixture(t), social = new SocialStore(f.db, c => f.w.resolveContext(c), () => {}, (id, c) => f.w.studio.artifact(id, c), f.now);
  social.saveConfig("x", "fixture-config", null);
  const a = social.connect({ accountId: randomUUID(), provider: "x", destinationId: "123456", subjectId: "123456", appKey: "c".repeat(64), grantEpoch: 0,
    displayName: "Scoped", destinationKind: "user", scopes: ["tweet.write"], verifiedAt: new Date(f.now()).toISOString(), credentialRef: "fixture-token", configRevision: 1 }, null);
  const project = f.w.createProject({ accountId: a.accountId, name: "Social", description: "" }), target = { accountId: a.accountId, projectId: project.id, destinationId: a.destinationId };
  const draft = social.create({ version: 1, target, metadata: { provider: "x", text: "Claim", paidPartnership: false, madeWithAi: false }, media: null, subjectId: a.subjectId, connectionRevision: a.revision, appKey: a.appKey });
  const schedule = f.queue.create({ context: { accountId: target.accountId, projectId: target.projectId }, kind: "social", draftId: draft.id, name: "Media", rule: rule("2027-01-01T09:00") });
  f.setNow("2027-01-01T09:00Z"); f.queue.tick();
  const occurrence = f.queue.dueReviews()[0], post = social.post(occurrence.publicationId, target);
  const competing = social.create({ ...draft.payload, metadata: { ...draft.payload.metadata, text: "Other" } });
  social.claim(competing.id, target, "busy", competing.digest);
  assert.throws(() => social.claim(post.id, target, "owner", post.digest), /social_post_busy/);
  assert.equal(f.queue.dueReviews().length, 1);
  const busy = social.post(competing.id, target); social.checkpoint(busy, "busy", true);
  let claimed = social.claim(post.id, target, "owner", post.digest);
  claimed.state = "accepted"; claimed.receipt.providerState = "MEDIA_READY"; claimed.receipt.mediaId = "7788"; social.checkpoint(claimed, "owner", true);
  claimed = social.claim(post.id, target, "owner", post.digest); // same review window, same generation
  claimed.state = "accepted"; social.checkpoint(claimed, "owner", true);
  f.queue.change(schedule.id, schedule.context, 1, "cancel");
  assert.throws(() => social.claim(post.id, target, "owner", post.digest), /schedule_approval_stale/);
  f.setNow("2027-01-02T09:01Z");
  assert.throws(() => social.claim(post.id, target, "owner", post.digest), /schedule_approval_stale/);
  assert.equal(social.post(post.id, target).state, "accepted");
});

test("active controls/actionable reviews survive history caps and paged reminders discover every due item", async t => {
  const f = await fixture(t), s = f.create();
  for (let i = 0; i < 205; i++) f.db.prepare("INSERT INTO schedules VALUES(?,?,?,?,?)").run(randomUUID(), f.c.accountId, f.c.projectId, JSON.stringify({ ...s, id: randomUUID(), state: "cancelled" }), "{}");
  const snapshot = f.queue.snapshot(f.c); assert.ok(snapshot.schedules.some(v => v.id === s.id));
  const base = snapshot.occurrences[0];
  for (let i = 0; i < 305; i++) {
    const id = randomUUID(), dueAt = new Date(at("2030-01-01T00:00Z") + i * 86400000).toISOString();
    f.db.prepare("INSERT INTO schedule_occurrences VALUES(?,?,?,?,?,?,?,?)").run(id, s.id, f.c.accountId, f.c.projectId, dueAt, 1, null, JSON.stringify({ ...base, id, dueAt, state: "cancelled" }));
  }
  assert.ok(f.queue.snapshot(f.c).occurrences.some(v => v.id === base.id));
  for (let i = 0; i < 105; i++) {
    const id = randomUUID(), dueAt = new Date(at("2027-01-01T00:00Z") + i * 60000).toISOString();
    f.db.prepare("INSERT INTO schedule_occurrences VALUES(?,?,?,?,?,?,?,?)").run(id, s.id, f.c.accountId, f.c.projectId, dueAt, 2, null, JSON.stringify({ ...base, id, dueAt, state: "awaiting-approval" }));
  }
  const first = f.queue.notificationPage(), second = f.queue.notificationPage(first.next);
  assert.equal(first.occurrences.length, 100); assert.equal(second.occurrences.length, 5); assert.equal(second.next, null);
  assert.equal(new Set([...first.occurrences, ...second.occurrences].map(o => o.id)).size, 105);
});
