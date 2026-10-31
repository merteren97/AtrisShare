import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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

test("concurrent first launches serialize migrations and preserve both writers", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-concurrent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "workspace.sqlite");
  const module = new URL("../dist/packages/storage/src/store.js", import.meta.url).href;
  await Promise.all(["A", "B"].map(name => new Promise((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); (async()=>{ const {WorkspaceStore}=await import(${JSON.stringify(module)}); const store=new WorkspaceStore(workerData.path); store.createAccount({displayName:workerData.name,platform:'youtube'}); store.close(); parentPort.postMessage('ok'); })().catch(e=>{throw e;});`, { eval: true, workerData: { path, name } });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => { if (code !== 0) reject(new Error(`Worker exited ${code}`)); });
  })));
  const store = new WorkspaceStore(path);
  try { assert.equal(store.listAccounts().length, 2); }
  finally { store.close(); }
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
