import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
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
      assert.equal(inspection.prepare("PRAGMA user_version").get().user_version, 10);
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
