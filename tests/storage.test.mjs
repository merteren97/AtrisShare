import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
import { SCHEMA_VERSION } from "../dist/packages/storage/src/migrations.js";
import { projectLifecycleGuard, watchProjectLifecycle } from "../dist/services/local-api/src/project-lifecycle.js";
import { resolveDataDirectory, redactSensitiveText } from "../dist/packages/storage/src/config.js";
import { createCredentialVault } from "../dist/packages/storage/src/vault.js";

const createAccount = (store, name = "Channel A") => store.createAccount({ displayName: name, platform: "youtube" });
const note = (context, text = "Keep a warm and concise tone.") => ({ context, kind: "brand-voice", text, reviewState: "confirmed" });
function fixture(t) {
  const store = new WorkspaceStore(":memory:");
  t.after(() => store.close());
  const a = createAccount(store);
  const b = createAccount(store, "Channel B");
  const p = store.createProject({ accountId: a.id, name: "Launch", description: "" });
  return { store, a, b, p, scope: { accountId: a.id, projectId: p.id } };
}

test("demo identities are explicit and project/account scopes cannot be mixed", t => {
  const { store, a, b, p, scope } = fixture(t);
  assert.equal(a.status, "demo");
  assert.match(a.destinationId, /^demo:youtube:/);
  assert.equal(store.resolveContext(scope).accountId, a.id);
  assert.throws(() => store.setContext({ accountId: b.id, projectId: p.id }), /context_not_found/);
  assert.throws(() => store.listMemory({ projectId: p.id }));
  assert.throws(() => store.createAccount({ displayName: "Forged", platform: "youtube", status: "connected" }));
});

test("account-wide, project and other-account memories stay isolated on list/update/delete", t => {
  const { store, a, b, p, scope } = fixture(t);
  const entry = store.createMemory(note(scope));
  store.createMemory(note({ accountId: a.id, projectId: null }, "Account preference"));
  store.createMemory(note({ accountId: b.id, projectId: null }, "Other account preference"));
  assert.equal(store.listMemory(scope).length, 1);
  assert.equal(store.listMemory({ accountId: a.id, projectId: null }).length, 1);
  const wrong = { accountId: b.id, projectId: null };
  assert.throws(() => store.updateMemory(entry.id, { ...note(wrong), expectedRevision: 1 }), /memory_not_found/);
  assert.throws(() => store.deleteMemory(entry.id, wrong, 1), /memory_not_found/);
  assert.throws(() => store.listMemory({ accountId: b.id, projectId: p.id }), /context_not_found/);
  assert.equal(store.listMemory(scope)[0].text, entry.text);
});

test("revision conflicts preserve newer edits and provenance; audit mutation is transactional", t => {
  const { store, scope } = fixture(t);
  const first = store.createMemory({ ...note(scope), reviewState: "suggested" });
  const updated = store.updateMemory(first.id, { ...note(scope, "Confirmed edit"), expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.provenance, first.provenance);
  const auditBefore = store.listAudit(scope).length;
  assert.throws(() => store.updateMemory(first.id, { ...note(scope, "Stale"), expectedRevision: 1 }), /revision_conflict/);
  assert.throws(() => store.deleteMemory(first.id, scope, 1), /revision_conflict/);
  assert.equal(store.listAudit(scope).length, auditBefore);
  assert.equal(store.listMemory(scope)[0].text, "Confirmed edit");
  store.deleteMemory(first.id, scope, 2);
  assert.equal(store.listMemory(scope).length, 0);
  assert.equal(store.listAudit(scope)[0].action, "memory.deleted");
  assert.ok(!JSON.stringify(store.listAudit(scope)).includes("Confirmed edit"));
});

test("SQLite migrations are idempotent and context/memory survive close and reopen", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "workspace.sqlite");
  let store = new WorkspaceStore(path);
  const account = createAccount(store);
  const project = store.createProject({ accountId: account.id, name: "Persistent", description: "Saved project" });
  const scope = { accountId: account.id, projectId: project.id };
  store.setContext(scope);
  const entry = store.createMemory(note(scope));
  store.close();
  store = new WorkspaceStore(path);
  try {
    assert.deepEqual(store.getContext(), scope);
    assert.equal(store.listProjects(account.id)[0].description, "Saved project");
    assert.deepEqual(store.listMemory(scope)[0], entry);
    assert.ok(store.listAudit(scope).some(e => e.action === "context.selected"));
  } finally { store.close(); }
});

test("database rejects future schema and foreign-key violations independently of repositories", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "workspace.sqlite");
  const store = new WorkspaceStore(path);
  const a = createAccount(store);
  const b = createAccount(store, "B");
  const project = store.createProject({ accountId: a.id, name: "A project", description: "" });
  store.close();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  assert.throws(() => db.prepare("INSERT INTO context VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET account_id=excluded.account_id,project_id=excluded.project_id").run(b.id, project.id), /FOREIGN KEY/);
  db.exec("PRAGMA user_version=99");
  db.close();
  assert.throws(() => new WorkspaceStore(path), /newer/);
});

test("Phase 1 schema upgrade preserves every dependent row and keeps foreign keys enforced", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-v1-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "workspace.sqlite");
  const old = new DatabaseSync(path);
  old.exec(await readFile(new URL("./fixtures/workspace-v1.sql", import.meta.url), "utf8"));
  const accountId = randomUUID(), projectId = randomUUID(), memoryId = randomUUID(), sourceId = randomUUID(), auditId = randomUUID();
  const stamp = "2026-11-01T00:00:00.000Z";
  old.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)").run(accountId, "My demo", "youtube", `demo:youtube:${accountId}`, "demo", stamp);
  old.prepare("INSERT INTO projects VALUES(?,?,?,?,?)").run(projectId, accountId, "Existing project", "Keep this", stamp);
  old.prepare("INSERT INTO memory VALUES(?,?,?,?,?,?,?,?,?,?)").run(memoryId, accountId, projectId, "decision", "Existing note", "confirmed", 3, sourceId, stamp, stamp);
  old.prepare("INSERT INTO context VALUES(1,?,?)").run(accountId, projectId);
  old.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?)").run(auditId, accountId, projectId, "memory.created", memoryId, "local-user", stamp);
  old.close();
  const store = new WorkspaceStore(path);
  try {
    assert.equal(store.listAccounts()[0].status, "demo");
    assert.deepEqual(store.getContext(), { accountId, projectId });
    assert.equal(store.listProjects(accountId)[0].description, "Keep this");
    assert.equal(store.listMemory({ accountId, projectId })[0].revision, 3);
    assert.equal(store.listMemory({ accountId, projectId })[0].provenance.sourceId, sourceId);
    assert.equal(store.listAudit({ accountId, projectId })[0].id, auditId);
    const other = createAccount(store, "Other");
    assert.throws(() => store.setContext({ accountId: other.id, projectId }), /context_not_found/);
    const inspection = new DatabaseSync(path);
    try {
      assert.equal(inspection.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
      assert.equal(store.listProjects(accountId)[0].revision, 1);
      assert.equal(store.listProjects(accountId)[0].updatedAt, stamp);
      assert.equal(store.listProjects(accountId)[0].deletedAt, null);
      assert.deepEqual(inspection.prepare("PRAGMA foreign_key_check").all(), []);
      assert.ok(inspection.prepare("PRAGMA foreign_key_list(memory)").all().every(row => row.table !== "accounts_next"));
    } finally { inspection.close(); }
  } finally { store.close(); }
});

test("WAL initialization waits for a rollback-journal writer and preserves data and foreign keys", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-wal-lock-"));
  let worker;
  t.after(async () => {
    await worker?.terminate();
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "workspace.sqlite");
  const seed = new WorkspaceStore(path);
  let account, project, scope, entry;
  try {
    account = createAccount(seed);
    project = seed.createProject({ accountId: account.id, name: "Persistent", description: "Before lock" });
    scope = { accountId: account.id, projectId: project.id };
    seed.setContext(scope);
    entry = seed.createMemory(note(scope));
  } finally { seed.close(); }
  const setup = new DatabaseSync(path);
  try { assert.equal(setup.prepare("PRAGMA journal_mode=DELETE").get().journal_mode, "delete"); }
  finally { setup.close(); }

  // The holder cannot release until the main thread observes a real WAL error.
  // Its timer runs in another thread while WorkspaceStore's synchronous open waits.
  const release = new Int32Array(new SharedArrayBuffer(4));
  worker = new Worker(`
    const assert = require('node:assert/strict');
    const { DatabaseSync } = require('node:sqlite');
    const { parentPort, workerData } = require('node:worker_threads');
    const release = new Int32Array(workerData.release);
    const db = new DatabaseSync(workerData.path);
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE projects SET description=? WHERE id=?').run('Committed by lock holder', workerData.projectId);
      parentPort.postMessage('locked');
      assert.notEqual(Atomics.wait(release, 0, 0, 10000), 'timed-out', 'main thread never observed the WAL lock');
      Atomics.wait(release, 0, 1, 100);
      db.exec('COMMIT');
      Atomics.store(release, 0, 2);
    } finally { db.close(); }
  `, { eval: true, workerData: { path, projectId: project.id, release: release.buffer } });
  assert.deepEqual(await once(worker, "message"), ["locked"]);

  const exec = DatabaseSync.prototype.exec;
  const busyErrors = [];
  let migrationDb;
  const observation = t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
    if (/PRAGMA journal_mode\s*=\s*WAL/i.test(sql)) migrationDb = this;
    try { return exec.call(this, sql); }
    catch (error) {
      if (/PRAGMA journal_mode\s*=\s*WAL/i.test(sql)) {
        busyErrors.push({ code: error.code, errcode: error.errcode, errstr: error.errstr });
        if (Atomics.compareExchange(release, 0, 0, 1) === 0) Atomics.notify(release, 0);
      }
      throw error;
    }
  });
  const started = performance.now();
  let store;
  try { store = new WorkspaceStore(path); }
  finally { observation.mock.restore(); }
  const elapsed = performance.now() - started;
  try {
    const [exitCode] = await once(worker, "exit");
    assert.equal(exitCode, 0);
    assert.ok(elapsed >= 100, "open must wait for the lock holder's 100 ms delay");
    assert.equal(Atomics.load(release, 0), 2, "open must succeed after the holder commits");
    assert.ok(busyErrors.length > 0, "exercise the WAL retry with a real SQLite error");
    for (const error of busyErrors) {
      assert.equal(error.code, "ERR_SQLITE_ERROR");
      assert.equal(error.errcode, 5, "Node exposes SQLITE_BUSY as numeric errcode, not code");
    }
    t.diagnostic(`Observed WAL lock error: ${JSON.stringify(busyErrors[0])}`);
    assert.deepEqual(store.getContext(), scope);
    assert.deepEqual(store.listMemory(scope), [entry]);
    assert.equal(store.listProjects(account.id)[0].description, "Committed by lock holder");
    assert.ok(store.listAudit(scope).some(event => event.action === "memory.created"));
    // Check the actual migrated connection: another connection has its own FK setting.
    assert.equal(migrationDb.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(migrationDb.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.deepEqual(migrationDb.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => migrationDb.prepare("UPDATE projects SET account_id=? WHERE id=?").run(randomUUID(), project.id), /FOREIGN KEY/);
    assert.equal(store.listProjects(account.id)[0].id, project.id);
    assert.ok(createAccount(store, "After lock").id);
  } finally { store.close(); }
});

test("concurrent first launches serialize migrations and preserve all writers", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-concurrent-"));
  const workers = [];
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.terminate()));
    await rm(directory, { recursive: true, force: true });
  });
  const module = new URL("../dist/packages/storage/src/store.js", import.meta.url).href;
  const names = ["A", "B", "C", "D"];
  for (let round = 0; round < 3; round++) {
    const path = join(directory, `workspace-${round}.sqlite`);
    const gate = new Int32Array(new SharedArrayBuffer(4));
    let ready = 0;
    await Promise.all(names.map(name => new Promise((resolve, reject) => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { WorkspaceStore } = await import(${JSON.stringify(module)});
          const gate = new Int32Array(workerData.gate);
          parentPort.postMessage('ready');
          if (Atomics.wait(gate, 0, 0, 10000) === 'timed-out') throw new Error('launch gate timed out');
          const store = new WorkspaceStore(workerData.path);
          try { store.createAccount({ displayName: workerData.name, platform: 'youtube' }); }
          finally { store.close(); }
        })().catch(error => { throw error; });
      `, { eval: true, workerData: { path, name, gate: gate.buffer } });
      workers.push(worker);
      worker.once("message", () => {
        if (++ready === names.length) {
          Atomics.store(gate, 0, 1);
          Atomics.notify(gate, 0);
        }
      });
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code} in round ${round}`)));
    })));
    const store = new WorkspaceStore(path);
    try { assert.deepEqual(store.listAccounts().map(account => account.displayName).sort(), names); }
    finally { store.close(); }
  }
});

test("diagnostics/notes redact recognizable secrets and data overrides must be absolute", t => {
  const { store, scope } = fixture(t);
  const secret = "sk-1234567890abcdefghijklmnop";
  const entry = store.createMemory(note(scope, `Never include Bearer abc123 or api_key=private or ${secret}`));
  assert.ok(!entry.text.includes(secret));
  assert.ok(!entry.text.includes("abc123"));
  assert.ok(!JSON.stringify(store.listAudit(scope)).includes("private"));
  assert.equal(redactSensitiveText("A calm tone"), "A calm tone");
  assert.throws(() => resolveDataDirectory("./data"), /absolute/);
});

test("project revisions, scope, trash and restore are durable across two windows", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-project-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "workspace.sqlite"), first = new WorkspaceStore(path), second = new WorkspaceStore(path);
  try {
    const account = createAccount(first), other = createAccount(first, "Other");
    const project = first.createProject({ accountId: account.id, name: "Original", description: "Keep me" });
    const scope = { accountId: account.id, projectId: project.id }, input = { context: scope, expectedRevision: 1 };
    const sibling = first.createProject({ accountId: account.id, name: "Sibling", description: "" });
    first.setContext(scope); const memory = first.createMemory(note(scope));
    const initialGuard = projectLifecycleGuard(second, scope);
    const update = first.updateProject(project.id, { ...input, name: "Renamed", description: "New description" });
    assert.equal(update.revision, 2); initialGuard(); // Rename does not revoke grants.
    assert.equal(second.listProjects(account.id).find(p => p.id === project.id).name, "Renamed");
    assert.throws(() => second.updateProject(project.id, { ...input, name: "Stale", description: "" }), /revision_conflict/);
    assert.throws(() => second.trashProject(project.id, input), /revision_conflict/);
    assert.throws(() => first.updateProject(project.id, { ...input, expectedRevision: 2, context: { accountId: other.id, projectId: project.id }, name: "Wrong", description: "" }), /project_not_found/);
    assert.throws(() => first.trashProject(project.id, { ...input, expectedRevision: 2, context: { accountId: account.id, projectId: sibling.id } }), /context_not_found/);
    assert.throws(() => first.updateProject(project.id, { ...input, expectedRevision: 2, name: " ", description: "" }));
    assert.throws(() => first.updateProject(project.id, { ...input, expectedRevision: 2, name: "x", description: "x".repeat(501) }));
    const trashed = first.trashProject(project.id, { ...input, expectedRevision: 2 });
    assert.equal(trashed.revision, 3); assert.ok(trashed.deletedAt);
    assert.deepEqual(second.getContext(), { accountId: account.id, projectId: null });
    assert.deepEqual(second.listProjects(account.id).map(p => p.id), [sibling.id]);
    assert.deepEqual(second.listProjects(account.id, "trashed"), [trashed]);
    for (const read of [() => second.resolveContext(scope), () => second.listMemory(scope), () => second.studio.artifacts(scope), () => second.schedules.snapshot(scope), () => second.setContext(scope), initialGuard]) assert.throws(read, /context_not_found/);
    assert.throws(() => second.restoreProject(project.id, { ...input, expectedRevision: 2 }), /revision_conflict/);
    assert.throws(() => second.restoreProject(project.id, { ...input, expectedRevision: 3, context: { accountId: other.id, projectId: project.id } }), /project_not_found/);
    const restored = second.restoreProject(project.id, { ...input, expectedRevision: 3 });
    assert.equal(restored.revision, 4); assert.equal(restored.deletedAt, null);
    assert.equal(restored.description, "New description");
    assert.deepEqual(first.listMemory(scope), [memory]);
    assert.deepEqual(first.getContext(), { accountId: account.id, projectId: null });
    assert.throws(initialGuard, /context_not_found/, "pre-trash grants stay invalid after restore");
    projectLifecycleGuard(first, scope)();
    assert.ok(first.listAudit(scope).some(e => e.action === "project.trashed"));
  } finally { first.close(); second.close(); }
  const reopened = new WorkspaceStore(path);
  try { assert.equal(reopened.listProjects(reopened.getContext().accountId).find(p => p.name === "Renamed").revision, 4); }
  finally { reopened.close(); }
});

test("trash atomically fences workers, cancels future schedules and keeps files and accepted receipts", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-project-work-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "workspace.sqlite"), store = new WorkspaceStore(path);
  const db = new DatabaseSync(path);
  try {
    const account = createAccount(store), p = store.createProject({ accountId: account.id, name: "Work", description: "" });
    const scope = { accountId: account.id, projectId: p.id }, sourceId = randomUUID(), stamp = new Date().toISOString();
    await writeFile(join(directory, "source.mp4"), "preserved source bytes");
    store.studio.addArtifact({ id: sourceId, ...scope, filename: "source.mp4", sha256: "a".repeat(64), bytes: 22, mimeType: "video/mp4", probe: null, sourceId: null, channelVideoId: null, createdAt: stamp });
    const ids = {};
    for (const table of ["ai_runs", "transcripts", "clip_analyses"]) {
      const id = ids[table] = randomUUID();
      db.prepare(`INSERT INTO ${table}(id,account_id,project_id,artifact_id,data,owner,lease_until) VALUES(?,?,?,?,?,?,?)`)
        .run(id, account.id, p.id, sourceId, JSON.stringify({ id, state: "running", summary: null, edit: null }), "old-worker", Date.now() + 300000);
    }
    const render = { id: randomUUID(), sourceId, kind: "export", state: "running", progress: 0, error: null, artifactId: null };
    store.studio.addRender(scope, render, "old-worker");
    const draft = store.studio.create({ context: scope, artifactId: sourceId, title: "Future review", description: "", visibility: "private", madeForKids: false, notifySubscribers: false }, account.destinationId);
    const start = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) + "T09:00";
    const schedule = store.schedules.create({ context: scope, name: "Future", kind: "youtube", draftId: draft.id,
      rule: { frequency: "daily", localStart: start, timeZone: "UTC", weekdays: [], missedPolicy: "ask" } });
    const acceptedId = randomUUID(), receipt = { ...draft, id: acceptedId, state: "processing", videoId: "remote-receipt" };
    db.prepare("INSERT INTO publications(id,account_id,project_id,artifact_id,data) VALUES(?,?,?,?,?)").run(acceptedId, account.id, p.id, sourceId, JSON.stringify(receipt));
    // A dependent-row error must roll back job cancellation and project/context edits together.
    db.exec("CREATE TRIGGER reject_trash BEFORE UPDATE OF deleted_at ON projects BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    assert.throws(() => store.trashProject(p.id, { context: scope, expectedRevision: 1 }), /injected failure/);
    assert.equal(store.studio.render(render.id, scope).state, "running");
    db.exec("DROP TRIGGER reject_trash");
    const deleted = store.trashProject(p.id, { context: scope, expectedRevision: 1 });
    store.schedules.tick();
    assert.deepEqual(store.schedules.notificationPage().occurrences, []);
    store.restoreProject(p.id, { context: scope, expectedRevision: deleted.revision });
    assert.equal(store.studio.render(render.id, scope).state, "cancelled");
    assert.throws(() => store.studio.saveRender({ ...render, state: "succeeded" }, "old-worker"), /render_busy/);
    assert.throws(() => store.studio.assertAiActive(ids.ai_runs, "old-worker"), /ai_run_conflict/);
    assert.throws(() => store.transcripts.assertActive(ids.transcripts, "old-worker"));
    for (const table of ["ai_runs", "transcripts", "clip_analyses"]) {
      const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(ids[table]);
      assert.equal(JSON.parse(row.data).state, "cancelled"); assert.equal(row.cancel_requested, 1); assert.equal(row.lease_until, 0);
    }
    const queue = store.schedules.snapshot(scope);
    assert.equal(queue.schedules.find(s => s.id === schedule.id).state, "cancelled");
    assert.equal(queue.schedules[0].nextDueAt, null); assert.ok(queue.occurrences.every(o => o.state === "cancelled"));
    assert.equal(store.studio.publication(acceptedId, scope).videoId, "remote-receipt");
    assert.equal(store.studio.publication(acceptedId, scope).state, "processing");
    assert.equal(db.prepare("SELECT dispatch_revoked FROM publications WHERE id=?").get(acceptedId).dispatch_revoked, 1);
    assert.equal(await readFile(join(directory, "source.mp4"), "utf8"), "preserved source bytes");
    assert.equal(store.studio.artifacts(scope)[0].id, sourceId);
  } finally { db.close(); store.close(); }
});

test("quiet async work observes a trash/restore cycle and disposes its lifecycle watcher", async t => {
  const { store, p, scope } = fixture(t), abort = new AbortController(), disposed = new AbortController();
  const watching = watchProjectLifecycle(store, scope, abort), stopped = watchProjectLifecycle(store, scope, disposed);
  t.after(() => { watching.dispose(); stopped.dispose(); });
  stopped.dispose();
  const invalidGrant = projectLifecycleGuard(store, scope, "mcp_grant_invalid", 401);
  const deleted = store.trashProject(p.id, { context: scope, expectedRevision: 1 });
  store.restoreProject(p.id, { context: scope, expectedRevision: deleted.revision });
  assert.throws(invalidGrant, error => error.status === 401 && error.code === "mcp_grant_invalid");
  assert.throws(watching.assertActive, /context_not_found/);
  let deadline;
  try {
    await Promise.race([once(abort.signal, "abort"), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("quiet task not aborted")), 3000); })]);
  } finally { clearTimeout(deadline); }
  assert.equal(disposed.signal.aborted, false);
});

test("OS vault fails closed or performs encrypted Windows DPAPI round trip", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-vault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vault = await createCredentialVault(directory);
  const ref = `account:${randomUUID()}`;
  if (process.platform !== "win32") {
    assert.equal(vault.status.available, false);
    await assert.rejects(vault.set(ref, "synthetic-test-secret"), /unavailable/);
    return;
  }
  assert.equal(vault.status.available, true, "Windows acceptance requires working DPAPI, not a mock");
  assert.equal(await vault.get(ref), null);
  await vault.set(ref, "synthetic-test-secret");
  assert.equal(await vault.get(ref), "synthetic-test-secret");
  const { createHash } = await import("node:crypto");
  const encrypted = await readFile(join(directory, "vault", `${createHash("sha256").update(ref).digest("hex")}.dpapi`));
  assert.ok(!encrypted.includes(Buffer.from("synthetic-test-secret")));
  await vault.set(ref, "replacement-test-secret");
  assert.equal(await vault.get(ref), "replacement-test-secret");
  await vault.delete(ref);
  assert.equal(await vault.get(ref), null);
  await assert.rejects(vault.get("../../escape"), /reference/);
});
