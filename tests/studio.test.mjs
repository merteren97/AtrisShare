import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { WorkspaceError } from "../dist/packages/storage/src/config.js";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
import { publicationDigest } from "../dist/packages/storage/src/studio-store.js";
import { MediaEngine } from "../dist/packages/media-engine/src/index.js";
import { startApi } from "../dist/services/local-api/src/server.js";
import { StudioService } from "../dist/services/local-api/src/studio.js";
import { YouTubeProvider } from "../dist/services/local-api/src/youtube-provider.js";
import { YouTubePublishing } from "../dist/services/local-api/src/youtube-publishing.js";

// Reuse the real, small container without executing another test file or requiring tools.
const mediaTests = await readFile(new URL("./media-engine.test.mjs", import.meta.url), "utf8");
const embedded = /const WEBM = Buffer\.from\("([A-Za-z0-9+/=]+)", "base64"\);/u.exec(mediaTests);
assert.ok(embedded, "media-engine.test.mjs must contain its embedded WebM fixture");
const WEBM = Buffer.from(embedded[1], "base64");
const SHA = createHash("sha256").update(WEBM).digest("hex");
const TOKEN = "controlled-access-token-never-public";
const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=controlled-private-session";
const VIDEO = "testVideo01";
const EDIT = { inSeconds: 0, outSeconds: 1, crop: "original", gainDb: 0, caption: "First" };
const engineOptions = directory => ({ ffmpegPath: join(directory, "absent-ffmpeg"), ffprobePath: join(directory, "absent-ffprobe") });
const input = (context, artifactId, extra = {}) => ({ context, artifactId, title: "Controlled upload", description: "A local integration test",
  visibility: "private", madeForKids: false, notifySubscribers: false, ...extra });
const isError = code => error => error instanceof WorkspaceError && error.code === code;
const gate = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function connect(store, letter = "A") {
  const accountId = randomUUID(), destinationId = `UC${letter.repeat(22)}`;
  const connection = store.connectYouTube({ accountId, destinationId, displayName: `Channel ${letter}`,
    providerSubjectId: `subject-${letter}`, credentialRef: `account:${randomUUID()}`,
    grantedScopes: ["openid", "https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"], expectedRevision: null });
  const project = store.createProject({ accountId, name: `Project ${letter}`, description: "" });
  return { connection, context: { accountId, projectId: project.id } };
}

function artifact(store, context, extra = {}) {
  // Independent SQL fixture keeps repository tests from depending on artifact registration.
  // The probe is explicit fixture data, not the result of an absent tool.
  const value = { id: randomUUID(), ...context, filename: "fixture.webm", sha256: SHA, bytes: WEBM.length,
    mimeType: "video/webm", probe: { duration: 4, width: 64, height: 48, hasAudio: false }, sourceId: null,
    channelVideoId: null, createdAt: new Date().toISOString(), ...extra };
  store.db.prepare("INSERT INTO artifacts(id,account_id,project_id,data) VALUES(?,?,?,?)")
    .run(value.id, value.accountId, value.projectId, JSON.stringify(value));
  return value;
}

async function database(t) {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-studio-"));
  const path = join(directory, "atris-share.sqlite");
  const store = new WorkspaceStore(path);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  const first = connect(store), second = connect(store, "B");
  const cleanup = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally { db.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
  });
  return { directory, path, store, db, cleanup, ...first, other: second.context };
}

function patchPublication(db, id, changes) {
  const row = db.prepare("SELECT data FROM publications WHERE id=?").get(id);
  const value = { ...JSON.parse(row.data), ...changes };
  db.prepare("UPDATE publications SET data=? WHERE id=?").run(JSON.stringify(value), id);
  return value;
}

async function settled(store, id, context) {
  // Wait for durable release as well as state: processing is checkpointed before task exit.
  for (let attempt = 0; attempt < 500; attempt++) {
    const db = store.db;
    const row = db.prepare("SELECT owner FROM publications WHERE id=?").get(id);
    if (row.owner === null) return store.studio.publication(id, context);
    await delay(10);
  }
  assert.fail(`Publication ${id} did not release its lease`);
}

class ControlledPublisher extends YouTubePublishing {
  calls = [];
  uploadReply = { state: "complete", videoId: VIDEO };
  queryReply = { state: "complete", videoId: VIDEO };
  processingReply = { state: "succeeded", url: `https://www.youtube.com/watch?v=${VIDEO}` };
  constructor() { super(async () => { throw new Error("Unexpected provider transport: remote effects forbidden"); }); }
  check(token, signal) { assert.equal(token, TOKEN); signal.throwIfAborted(); }
  async initiate(token, metadata, bytes, mimeType, signal) {
    this.check(token, signal); this.calls.push({ kind: "initiate", metadata, bytes, mimeType }); return SESSION;
  }
  async upload(token, url, bytes, offset, total, signal) {
    this.check(token, signal); assert.equal(url, SESSION);
    this.calls.push({ kind: "upload", bytes: Buffer.from(bytes), offset, total, signal });
    if (this.onUpload) return this.onUpload(signal);
    return this.uploadReply;
  }
  async query(token, url, bytes, signal) {
    this.check(token, signal); assert.equal(url, SESSION); this.calls.push({ kind: "query", bytes }); return this.queryReply;
  }
  async processing(token, videoId, signal) {
    this.check(token, signal); assert.equal(videoId, VIDEO); this.calls.push({ kind: "processing", videoId }); return this.processingReply;
  }
}

async function publishing(t) {
  const f = await database(t), publisher = new ControlledPublisher(), secrets = new Map(), verified = [];
  const vault = { status: { available: true, provider: "windows-dpapi" },
    async get(ref) { return secrets.get(ref) ?? null; }, async set(ref, value) { secrets.set(ref, value); }, async delete(ref) { secrets.delete(ref); } };
  const busy = new Set();
  const youtube = { before: null, guardChecks: 0, isBusy: accountId => busy.has(accountId), async withVerified(scope, callback) {
    if (busy.has(scope.accountId)) throw new WorkspaceError(409, "connection_conflict");
    busy.add(scope.accountId);
    try {
      verified.push({ ...scope });
      if (this.before) await this.before();
      const connection = f.store.getYouTubeConnection(scope.accountId, scope.destinationId);
      const guard = () => {
        this.guardChecks++;
        const current = f.store.getYouTubeConnection(scope.accountId, scope.destinationId);
        if (current.revision !== connection.revision || current.providerSubjectId !== connection.providerSubjectId ||
            current.credentialRef !== connection.credentialRef) throw new WorkspaceError(409, "connection_conflict");
        if (f.store.listAccounts().find(a => a.id === scope.accountId)?.status !== "connected") throw new WorkspaceError(409, "youtube_reauth_required");
      };
      guard();
      return await callback(TOKEN, new AbortController().signal, guard);
    } finally { busy.delete(scope.accountId); }
  } };
  const service = new StudioService(f.store, youtube, vault, f.directory, { engine: engineOptions(f.directory), publisher });
  f.cleanup.push(() => service.close());
  // Real streaming engine import + SQL registration isolates publisher behavior from
  // the separately tested service/API registration path. No fake media or tools.
  const result = await service.engine.import(randomUUID(), Readable.from([WEBM.subarray(0, 37), WEBM.subarray(37)]), "source.webm");
  const imported = artifact(f.store, f.context, result);
  return { ...f, service, publisher, youtube, vault, secrets, verified, imported };
}

async function apiFixture(t, options = {}) {
  const f = await database(t);
  const api = await startApi({ dataDirectory: f.directory, vaultStatus: { available: false, provider: "unavailable" }, studio: { engine: engineOptions(f.directory) }, ...options });
  f.cleanup.push(() => api.close());
  const call = (path, options = {}) => fetch(`${api.origin}${path}`, { ...options, headers: { Authorization: `Bearer ${api.token}`, ...options.headers } });
  return { ...f, api, call };
}

function pauseSnapshot(f, stage) {
  const entered = gate(), release = gate(), original = f.service.snapshotBytes.bind(f.service);
  // TypeScript's private method is available at runtime. Keep the real snapshot/hash
  // and file read, then pause their completion at the asynchronous dispatch boundary.
  f.service.snapshotBytes = async (...args) => {
    const snapshot = await original(...args);
    if (stage === "snapshot") {
      entered.resolve(); await release.promise;
    } else {
      const read = snapshot.file.read.bind(snapshot.file);
      snapshot.file.read = async (...readArgs) => {
        const result = await read(...readArgs);
        entered.resolve(); await release.promise;
        return result;
      };
    }
    return snapshot;
  };
  f.cleanup.push(() => release.resolve());
  return { entered: entered.promise, release: () => release.resolve() };
}

test("v2 to v3 migration preserves connected identities, credentials references and every dependent row", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-studio-v2-")), path = join(directory, "workspace.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = new DatabaseSync(path);
  // Frozen v1 tables plus the v2 changes, independent of the migration being tested.
  old.exec((await readFile(new URL("./fixtures/workspace-v1.sql", import.meta.url), "utf8"))
    .replace("CHECK(status='demo')", "CHECK(status IN ('demo','connected','reauth-required','disconnected'))"));
  old.exec(`CREATE TABLE youtube_connections (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id), provider_subject_id TEXT NOT NULL,
    destination_id TEXT NOT NULL UNIQUE, credential_ref TEXT UNIQUE, granted_scopes TEXT NOT NULL,
    verified_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0)
  ) STRICT; PRAGMA user_version=2;`);
  const accountId = randomUUID(), projectId = randomUUID(), memoryId = randomUUID(), sourceId = randomUUID(), auditId = randomUUID();
  const stamp = "2026-11-01T00:00:00.000Z", destination = `UC${"A".repeat(22)}`, ref = `account:${randomUUID()}`;
  old.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)").run(accountId, "Existing connected channel", "youtube", destination, "connected", stamp);
  old.prepare("INSERT INTO projects VALUES(?,?,?,?,?)").run(projectId, accountId, "Existing project", "Preserved description", stamp);
  old.prepare("INSERT INTO youtube_connections VALUES(?,?,?,?,?,?,?)").run(accountId, "existing-subject", destination, ref, '["openid"]', stamp, 7);
  old.prepare("INSERT INTO memory VALUES(?,?,?,?,?,?,?,?,?,?)").run(memoryId, accountId, projectId, "decision", "Preserved note", "confirmed", 4, sourceId, stamp, stamp);
  old.prepare("INSERT INTO context VALUES(1,?,?)").run(accountId, projectId);
  old.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?)").run(auditId, accountId, projectId, "memory.created", memoryId, "local-user", stamp);
  const tables = ["accounts", "projects", "youtube_connections", "memory", "context", "audit"];
  const before = tables.map(table => old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  for (const row of before[tables.indexOf("projects")]) Object.assign(row,{revision:1,updated_at:row.created_at,deleted_at:null});
  old.close();
  for (let reopen = 0; reopen < 2; reopen++) {
    const store = new WorkspaceStore(path), inspection = new DatabaseSync(path);
    try {
      assert.equal(inspection.prepare("PRAGMA user_version").get().user_version, 12);
      assert.deepEqual(tables.map(table => inspection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
      assert.deepEqual(inspection.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(store.getYouTubeConnection(accountId, destination).revision, 7);
      assert.equal(store.getYouTubeConnection(accountId, destination).credentialRef, ref);
      assert.deepEqual(store.getContext(), { accountId, projectId });
      assert.deepEqual(store.studio.artifacts({ accountId, projectId }), []);
      assert.equal(store.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    } finally { inspection.close(); store.close(); }
  }
});

test("managed artifacts enforce account/project scope and database foreign keys", async t => {
  const { store, db, context, other } = await database(t), a = artifact(store, context);
  const sibling = { accountId: context.accountId, projectId: store.createProject({ accountId: context.accountId, name: "Sibling", description: "" }).id };
  for (const wrong of [other, sibling]) {
    assert.deepEqual(store.studio.artifacts(wrong), []);
    assert.throws(() => store.studio.artifact(a.id, wrong), isError("artifact_not_found"));
    assert.throws(() => store.studio.timeline(a.id, wrong), isError("artifact_not_found"));
    assert.throws(() => store.studio.link(a.id, wrong, VIDEO), isError("artifact_not_found"));
    assert.throws(() => store.studio.create(input(wrong, a.id), "forged"), isError("artifact_not_found"));
  }
  assert.throws(() => store.studio.artifacts({ accountId: context.accountId, projectId: null }));
  assert.throws(() => store.studio.artifacts({ accountId: other.accountId, projectId: context.projectId }), isError("context_not_found"));
  assert.throws(() => store.studio.artifact("../escape", context));
  assert.throws(() => db.prepare("INSERT INTO publications(id,account_id,project_id,artifact_id,data) VALUES(?,?,?,?,?)")
    .run(randomUUID(), other.accountId, other.projectId, a.id, "{}"), /FOREIGN KEY/u);
  assert.throws(() => db.prepare("INSERT INTO artifacts VALUES(?,?,?,?)").run(randomUUID(), other.accountId, context.projectId, "{}"), /FOREIGN KEY/u);
  assert.throws(() => db.prepare("INSERT INTO renders VALUES(?,?,?,?,?,?,?)")
    .run(randomUUID(), other.accountId, other.projectId, a.id, "{}", "worker", Date.now() + 300_000), /FOREIGN KEY/u);
  const derived = artifact(store, context, { sourceId: a.id });
  assert.equal(store.studio.artifact(derived.id, context).sourceId, a.id);
  assert.equal(store.studio.link(a.id, context, VIDEO).channelVideoId, VIDEO);
});

test("artifact registration accepts managed metadata and rejects a source from another scope", async t => {
  const { store, db, context, other } = await database(t), a = artifact(store, context);
  const value = { ...a, id: randomUUID(), sourceId: a.id };
  assert.deepEqual(store.studio.addArtifact(value), value);
  assert.throws(() => store.studio.addArtifact({ ...value, ...other, id: randomUUID() }), isError("artifact_not_found"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM artifacts").get().n, 2);
});

test("canonical digest ignores key order and binds destination, scope, metadata and artifact bytes/hash", async t => {
  const { store, context } = await database(t), a = artifact(store, context);
  const p = store.studio.create(input(context, a.id), `UC${"A".repeat(22)}`);
  assert.equal(p.digest, publicationDigest(Object.fromEntries(Object.entries(p.payload).reverse())));
  assert.equal(p.payload.sha256, SHA); assert.equal(p.payload.bytes, WEBM.length);
  for (const [key, value] of Object.entries({ version: 2, accountId: randomUUID(), projectId: randomUUID(), destinationId: `UC${"B".repeat(22)}`,
    artifactId: randomUUID(), sha256: "0".repeat(64), bytes: WEBM.length + 1, mimeType: "video/mp4", title: "Changed",
    description: "Changed", visibility: "public", madeForKids: true, notifySubscribers: true })) {
    assert.notEqual(publicationDigest({ ...p.payload, [key]: value }), p.digest, `${key} must be approval-bound`);
  }
  assert.equal(p.approvalExpiresAt, null); assert.equal(p.state, "review");
});

test("approval rejects stale/tampered digests, is one-use and review cancellation cannot be replayed", async t => {
  const { store, db, context, other } = await database(t), a = artifact(store, context), p = store.studio.create(input(context, a.id), "destination");
  const audit = store.listAudit(context).length;
  assert.throws(() => store.studio.claim(p.id, context, "worker", "0".repeat(64)), isError("approval_stale"));
  assert.throws(() => store.studio.claim(p.id, other, "worker", p.digest), isError("publication_not_found"));
  patchPublication(db, p.id, { payload: { ...p.payload, title: "Mutated after review" } });
  assert.throws(() => store.studio.claim(p.id, context, "worker", p.digest), isError("approval_stale"));
  assert.equal(store.listAudit(context).length, audit);
  patchPublication(db, p.id, { payload: p.payload });
  const claimed = store.studio.claim(p.id, context, "worker", p.digest);
  assert.equal(claimed.state, "uploading");
  assert.throws(() => store.studio.claim(p.id, context, "worker2", p.digest), isError("approval_stale"));
  assert.throws(() => store.studio.cancel(p.id, context), isError("publication_busy"));
  store.studio.checkpoint({ ...claimed, state: "uncertain" }, "worker", true);
  assert.throws(() => store.studio.claim(p.id, context, "worker2", p.digest), isError("approval_stale"));
  const cancelled = store.studio.create(input(context, a.id), "destination");
  assert.equal(store.studio.cancel(cancelled.id, context).state, "cancelled");
  assert.throws(() => store.studio.claim(cancelled.id, context, "worker", cancelled.digest), isError("approval_stale"));
  assert.throws(() => store.studio.claim(cancelled.id, context, "worker", null), isError("publication_busy"));
});

test("two actual workers race one durable approval: exactly one claims it", async t => {
  const { store, path, context, cleanup } = await database(t), a = artifact(store, context), p = store.studio.create(input(context, a.id), "destination");
  const module = new URL("../dist/packages/storage/src/store.js", import.meta.url).href;
  const workers = ["worker-a", "worker-b"].map(owner => new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const {WorkspaceStore}=await import(${JSON.stringify(module)}); const store=new WorkspaceStore(workerData.path);
      parentPort.once('message',()=>{let result;try{const p=store.studio.claim(workerData.id,workerData.context,workerData.owner,workerData.digest);
        result={state:p.state};}catch(e){result={error:e.code};}finally{store.close();}parentPort.postMessage(result);});
      parentPort.postMessage('ready');})().catch(e=>{throw e;});`,
    { eval: true, workerData: { path, context, owner, id: p.id, digest: p.digest } }));
  cleanup.push(() => Promise.all(workers.map(worker => worker.terminate())));
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); })));
  const results = await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
    worker.once("message", resolve); worker.once("error", reject); worker.postMessage("claim");
  })));
  assert.equal(results.filter(result => result.state === "uploading").length, 1);
  assert.deepEqual(results.filter(result => result.error).map(result => result.error), ["approval_stale"]);
  assert.equal(store.listAudit(context).filter(event => event.action === "publication.approved").length, 1);
});

test("lease boundary and release prevent stale owners from checkpointing or replacing sessions", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T00:00:00Z") });
  const { store, path, context, cleanup } = await database(t), second = new WorkspaceStore(path);
  // A second real connection participates in the lease race.
  cleanup.push(() => second.close());
  const a = artifact(store, context), p = store.studio.create(input(context, a.id), "destination");
  const claimed = store.studio.claim(p.id, context, "old", p.digest);
  assert.equal(Date.parse(claimed.approvalExpiresAt) - Date.now(), 600_000);
  store.studio.setSession(p.id, "old", "account:original");
  t.mock.timers.tick(299_999);
  assert.equal(store.studio.publication(p.id, context).state, "uploading");
  assert.throws(() => second.studio.claim(p.id, context, "new", null), isError("publication_busy"));
  t.mock.timers.tick(1);
  assert.equal(store.studio.publication(p.id, context).state, "uncertain");
  for (const operation of [() => store.studio.session(p.id, "old"), () => store.studio.setSession(p.id, "old", "bad"),
    () => store.studio.checkpoint(claimed, "old", true)]) assert.throws(operation, isError("publication_busy"));
  const recovered = second.studio.claim(p.id, context, "new", null);
  assert.equal(second.studio.session(p.id, "new"), "account:original");
  assert.throws(() => store.studio.checkpoint({ ...claimed, state: "succeeded" }, "old", true), isError("publication_busy"));
  second.studio.setSession(p.id, "new", "account:winner");
  second.studio.checkpoint(recovered, "new", true);
  assert.throws(() => second.studio.setSession(p.id, "new", "late"), isError("publication_busy"));
  store.studio.claim(p.id, context, "third", null);
  assert.equal(store.studio.session(p.id, "third"), "account:winner");
});

test("timeline CAS, undo/redo bounds, branching and new-history replacement survive restart", async t => {
  const { store, path, context, other } = await database(t), a = artifact(store, context);
  assert.deepEqual(store.studio.timeline(a.id, context), { revision: 0, cursor: -1, edits: [] });
  assert.throws(() => store.studio.edit(a.id, context, 0, undefined, "undo"), isError("timeline_bounds"));
  let timeline = store.studio.edit(a.id, context, 0, EDIT);
  assert.equal(timeline.revision, 1);
  assert.throws(() => store.studio.edit(a.id, context, 0, { ...EDIT, caption: "Stale" }), isError("revision_conflict"));
  assert.throws(() => store.studio.edit(a.id, other, 1, EDIT), isError("artifact_not_found"));
  assert.throws(() => store.studio.edit(a.id, context, 1, { ...EDIT, outSeconds: 5 }), isError("timeline_bounds"));
  const next = { ...EDIT, caption: "Second" }, branch = { ...EDIT, caption: "Branch" };
  timeline = store.studio.edit(a.id, context, 1, next);
  timeline = store.studio.edit(a.id, context, 2, undefined, "undo");
  assert.deepEqual(timeline, { revision: 3, cursor: 0, edits: [EDIT, next] });
  timeline = store.studio.edit(a.id, context, 3, undefined, "redo");
  assert.deepEqual(timeline, { revision: 4, cursor: 1, edits: [EDIT, next] });
  assert.throws(() => store.studio.edit(a.id, context, 4, undefined, "redo"), isError("timeline_bounds"));
  store.studio.edit(a.id, context, 4, undefined, "undo");
  timeline = store.studio.edit(a.id, context, 5, branch);
  assert.deepEqual(timeline, { revision: 6, cursor: 1, edits: [EDIT, branch] });
  assert.throws(() => store.studio.edit(a.id, context, 6, undefined, "redo"), isError("timeline_bounds"));
  store.studio.edit(a.id, context, 6, undefined, "undo");
  store.studio.edit(a.id, context, 7, undefined, "undo");
  const fresh = { ...EDIT, caption: "New history" };
  timeline = store.studio.edit(a.id, context, 8, fresh);
  assert.deepEqual(timeline, { revision: 9, cursor: 0, edits: [fresh] });
  const reopened = new WorkspaceStore(path);
  try { assert.deepEqual(reopened.studio.timeline(a.id, context), timeline); }
  finally { reopened.close(); }
  assert.equal(store.studio.artifact(a.id, context).sha256, SHA);
});

test("render heartbeat storage failure aborts the owned task, persists failure and awaits output cleanup", { timeout: 10_000 }, async t => {
  const f = await database(t), entered = gate(), removing = gate(), release = gate();
  const service = new StudioService(f.store, {}, {}, f.directory, { engine: engineOptions(f.directory) });
  f.cleanup.push(() => service.close(), () => release.resolve());
  const a = artifact(f.store, f.context), timeline = f.store.studio.edit(a.id, f.context, 0, EDIT);
  let outputId, renderSignal;
  t.mock.method(service.engine, "verify", async () => true);
  const encode = t.mock.method(service.engine, "render", (sourceId, id, edit, progress, signal) => {
    assert.equal(sourceId, a.id); assert.deepEqual(edit, EDIT);
    outputId = id; renderSignal = signal;
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      entered.resolve();
    });
  });
  const remove = t.mock.method(service.engine, "remove", async () => { removing.resolve(); await release.promise; });
  const originalSave = f.store.studio.saveRender.bind(f.store.studio);
  const save = t.mock.method(f.store.studio, "saveRender", (render, owner) => {
    if (render.state === "running") throw new Error("Controlled heartbeat storage failure");
    return originalSave(render, owner);
  });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const render = service.render(a.id, f.context, timeline.revision), key = `render:${render.id}`;
  await entered.promise;
  const task = service.tasks.get(key);
  assert.ok(task); assert.equal(renderSignal.aborted, false); assert.equal(save.mock.callCount(), 0);
  assert.doesNotThrow(() => t.mock.timers.tick(30_000));
  assert.equal(task.abort.signal.aborted, true); assert.equal(renderSignal.aborted, true);
  await removing.promise;
  assert.equal(service.tasks.get(key), task, "output cleanup must remain tracked before task exit");
  assert.deepEqual(remove.mock.calls.map(call => call.arguments), [[outputId]]);
  release.resolve();
  await task.promise;
  assert.equal(service.tasks.has(key), false);
  const result = f.store.studio.render(render.id, f.context);
  assert.equal(result.state, "failed"); assert.equal(result.error, "media_storage_unavailable"); assert.equal(result.artifactId, null);
  assert.equal(encode.mock.callCount(), 1); assert.equal(save.mock.callCount(), 2);
  t.mock.timers.tick(30_000);
  assert.equal(save.mock.callCount(), 2, "the failed render must clear its heartbeat");
  assert.deepEqual(f.store.studio.artifacts(f.context).map(value => value.id), [a.id]);
  assert.deepEqual(f.store.listMemory(f.context), []);
});

test("binary API import requires authentication/valid scope, rejects bad bytes and registers real media", async t => {
  const f = await apiFixture(t), { api, call } = f;
  const query = new URLSearchParams({ ...f.context, filename: "source.webm" });
  const path = `/api/media/import?${query}`;
  assert.equal((await fetch(`${api.origin}${path}`, { method: "POST", body: WEBM })).status, 401);
  assert.equal((await call(path, { method: "POST", body: WEBM, headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await call("/api/media/import?filename=source.webm", { method: "POST", body: WEBM })).status, 400);
  assert.equal((await call(`/api/media/import?filename=source.webm&accountId=${f.other.accountId}&projectId=${f.context.projectId}`, { method: "POST", body: WEBM })).status, 404);
  const bad = await call(path, { method: "POST", body: Buffer.from(`not-media ${TOKEN} ${SESSION}`) });
  assert.equal(bad.status, 400); assert.deepEqual(await bad.json(), { error: "invalid_media_container" });
  assert.deepEqual(f.store.studio.artifacts(f.context), []);
  const imported = await call(path, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: WEBM });
  assert.equal(imported.status, 201, await imported.clone().text());
  const a = await imported.json();
  assert.equal(a.sha256, SHA); assert.equal(a.bytes, WEBM.length); assert.equal(a.mimeType, "video/webm"); assert.equal(a.probe, null);
  assert.deepEqual(await readFile(join(f.directory, "media", `${a.id}.mp4`)), WEBM);
  assert.deepEqual(await readdir(join(f.directory, "media")), [`${a.id}.mp4`]);
});

test("binary content endpoint isolates scope, returns exact real media bytes and exposes no credentials", async t => {
  const f = await apiFixture(t), { api, call } = f;
  const engine = new MediaEngine(f.directory, engineOptions(f.directory));
  const result = await engine.import(randomUUID(), Readable.from([WEBM]), "source.webm");
  const a = artifact(f.store, f.context, result);
  const content = `/api/media/${a.id}/content?${new URLSearchParams(f.context)}`;
  assert.equal((await fetch(`${api.origin}${content}`)).status, 401);
  assert.equal((await call(`/api/media/${a.id}/content?${new URLSearchParams(f.other)}`)).status, 404);
  assert.equal((await call(`/api/media/${a.id}/content`)).status, 400);
  assert.equal((await call(`${content}&token=${api.token}`)).status, 400);
  const response = await call(content);
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "video/webm");
  assert.equal(response.headers.get("content-length"), String(WEBM.length));
  assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), WEBM);
  const snapshot = await (await call(`/api/studio?${new URLSearchParams(f.context)}`)).json();
  const audit = await (await call(`/api/audit?${new URLSearchParams(f.context)}`)).json();
  const exposed = JSON.stringify({ a, snapshot, audit, headers: [...response.headers] });
  for (const secret of [api.token, TOKEN, SESSION, f.connection.credentialRef]) assert.ok(!exposed.includes(secret));
  assert.equal(snapshot.artifacts.length, 1); assert.deepEqual(snapshot.tools, { available: false, ffmpeg: false, ffprobe: false });
  const publication = await call("/api/publications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input(f.context, a.id)) });
  assert.equal(publication.status, 201);
  const p = await publication.json();
  const post = (action, body) => call(`/api/publications/${p.id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("approve", { context: f.other, digest: p.digest })).status, 404);
  assert.equal((await post("approve", { context: f.context, digest: "0".repeat(64) })).status, 409);
  assert.equal((await post("cancel", { context: f.context })).status, 202);
  assert.equal((await post("approve", { context: f.context, digest: p.digest })).status, 409);
});

test("catalog pageToken reaches account lookup while credential query parameters remain forbidden", async t => {
  const f = await apiFixture(t, { vaultStatus: { available: true, provider: "windows-dpapi" } });
  const query = new URLSearchParams({ accountId: randomUUID(), destinationId: f.connection.destinationId, pageToken: "next-page+/=" });
  const catalog = `/api/youtube/catalog?${query}`;
  const response = await f.call(catalog);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "youtube_account_not_found" });
  for (const key of ["token", "access_token", "refreshToken", "clientSecret", "Authorization", "PageToken"]) {
    const rejected = await f.call(`${catalog}&${new URLSearchParams({ [key]: "controlled-value" })}`);
    assert.equal(rejected.status, 400, key);
    assert.deepEqual(await rejected.json(), { error: "credentials_in_url" }, key);
  }
  const wrongRoute = await f.call(`/api/studio?${new URLSearchParams({ ...f.context, pageToken: "next-page" })}`);
  assert.equal(wrongRoute.status, 400);
  assert.deepEqual(await wrongRoute.json(), { error: "credentials_in_url" });
});

test("timeline HTTP routes enforce CAS and explicit scope and persist undo/redo branches", async t => {
  const f = await apiFixture(t), a = artifact(f.store, f.context), path = `/api/media/${a.id}/timeline`;
  const get = () => f.call(`${path}?${new URLSearchParams(f.context)}`);
  const edit = (expectedRevision, value = EDIT, context = f.context) => f.call(path, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context, expectedRevision, edit: value }) });
  const move = (direction, expectedRevision) => f.call(`${path}/${direction}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: f.context, expectedRevision }) });
  assert.equal((await f.call(path)).status, 400);
  assert.deepEqual(await (await get()).json(), { revision: 0, cursor: -1, edits: [] });
  assert.equal((await edit(0, EDIT, f.other)).status, 404);
  assert.equal((await edit(0)).status, 200);
  assert.equal((await edit(0)).status, 409);
  assert.equal((await move("undo", 1)).status, 200);
  assert.equal((await move("redo", 2)).status, 200);
  assert.equal((await move("redo", 3)).status, 409);
  assert.equal((await move("undo", 3)).status, 200);
  const fresh = { ...EDIT, caption: "HTTP branch" };
  assert.equal((await edit(4, fresh)).status, 200);
  assert.equal((await move("redo", 5)).status, 409);
  const expected = { revision: 5, cursor: 0, edits: [fresh] };
  assert.deepEqual(await (await get()).json(), expected);
  await f.api.close();
  const reopened = new WorkspaceStore(f.path);
  try { assert.deepEqual(reopened.studio.timeline(a.id, f.context), expected); }
  finally { reopened.close(); }
});

test("controlled publish imports real bytes, approves once, persists receipt, reconciles processing and creates one scoped memory", async t => {
  const f = await publishing(t), p = await f.service.create(input(f.context, f.imported.id));
  assert.equal(f.imported.probe, null); assert.equal(f.imported.sha256, SHA);
  assert.deepEqual(f.publisher.calls, []); assert.equal(f.store.listMemory(f.context).length, 0);
  f.store.setContext(f.other); // Selection is not authorization and cannot redirect a bound job.
  const approved = f.service.approve(p.id, f.context, p.digest);
  assert.equal(approved.state, "uploading"); assert.ok(Date.parse(approved.approvalExpiresAt) > Date.now());
  let result = await settled(f.store, p.id, f.context);
  assert.equal(result.state, "processing"); assert.equal(result.videoId, VIDEO); assert.equal(result.progress, 1);
  assert.equal(f.store.listMemory(f.context).length, 0);
  assert.deepEqual(f.publisher.calls.map(call => call.kind), ["initiate", "upload"]);
  const [initiation, upload] = f.publisher.calls;
  assert.deepEqual(initiation.metadata, { title: p.payload.title, description: p.payload.description, visibility: "private", madeForKids: false, notifySubscribers: false });
  assert.equal(initiation.bytes, WEBM.length); assert.equal(initiation.mimeType, "video/webm");
  assert.deepEqual(upload.bytes, WEBM); assert.equal(upload.offset, 0); assert.equal(upload.total, WEBM.length);
  assert.equal([...f.secrets.values()][0], SESSION);
  assert.throws(() => f.service.approve(p.id, f.context, p.digest), isError("approval_stale"));
  f.service.reconcile(p.id, f.context);
  result = await settled(f.store, p.id, f.context);
  assert.equal(result.state, "succeeded"); assert.equal(result.error, null);
  const memories = f.store.listMemory(f.context);
  assert.equal(memories.length, 1); assert.equal(memories[0].kind, "publication"); assert.equal(memories[0].reviewState, "confirmed");
  assert.ok(memories[0].text.includes(VIDEO)); assert.ok(memories[0].text.includes(p.payload.destinationId));
  assert.equal(f.store.listMemory(f.other).length, 0);
  assert.throws(() => f.service.reconcile(p.id, f.context), isError("publication_busy"));
  assert.deepEqual(f.publisher.calls.map(call => call.kind), ["initiate", "upload", "processing"]);
  assert.ok(f.verified.every(scope => scope.accountId === f.context.accountId && scope.destinationId === f.connection.destinationId));
  const persisted = f.db.prepare("SELECT data,session_ref FROM publications WHERE id=?").get(p.id);
  assert.match(persisted.session_ref, /^account:[0-9a-f-]{36}$/u);
  const publicData = JSON.stringify({ result, memories, audit: f.store.listAudit(f.context), artifacts: f.store.studio.artifacts(f.context), persisted });
  for (const secret of [TOKEN, SESSION, f.connection.credentialRef]) assert.ok(!publicData.includes(secret));
  await f.service.close();
  const reopened = new WorkspaceStore(f.path);
  try { assert.equal(reopened.studio.publication(p.id, f.context).state, "succeeded"); assert.equal(reopened.listMemory(f.context).length, 1); }
  finally { reopened.close(); }
});

test("lost final response stays uncertain; restart queries the saved session and never initiates/uploads twice", async t => {
  const f = await publishing(t);
  f.publisher.onUpload = () => { throw new WorkspaceError(502, "youtube_upload_uncertain"); };
  const p = await f.service.create(input(f.context, f.imported.id));
  f.service.approve(p.id, f.context, p.digest);
  let result = await settled(f.store, p.id, f.context);
  assert.equal(result.state, "uncertain"); assert.equal(result.error, "youtube_upload_uncertain"); assert.equal(result.videoId, null);
  assert.equal(f.store.listMemory(f.context).length, 0);
  await f.service.close();
  const restarted = new StudioService(f.store, f.youtube, f.vault, f.directory, { engine: engineOptions(f.directory), publisher: f.publisher });
  f.cleanup.push(() => restarted.close());
  restarted.reconcile(p.id, f.context);
  result = await settled(f.store, p.id, f.context);
  assert.equal(result.state, "processing"); assert.equal(result.videoId, VIDEO);
  restarted.reconcile(p.id, f.context);
  assert.equal((await settled(f.store, p.id, f.context)).state, "succeeded");
  assert.deepEqual(f.publisher.calls.map(call => call.kind), ["initiate", "upload", "query", "processing"]);
  assert.equal(f.store.listMemory(f.context).length, 1);
});

test("same-account concurrent approvals across projects leave the second publication in review", { timeout: 10_000 }, async t => {
  const f = await publishing(t), entered = gate(), release = gate();
  f.cleanup.push(() => release.resolve());
  const original = f.publisher.initiate.bind(f.publisher);
  f.publisher.initiate = async (...args) => {
    const session = await original(...args);
    entered.resolve(); await release.promise;
    return session;
  };
  const sibling = { accountId: f.context.accountId, projectId: f.store.createProject({ accountId: f.context.accountId, name: "Sibling", description: "" }).id };
  const first = await f.service.create(input(f.context, f.imported.id));
  // Both projects may review the same bytes independently; the upload lock is account-wide.
  const second = f.store.studio.create(input(sibling, artifact(f.store, sibling).id), f.connection.destinationId);
  f.service.approve(first.id, f.context, first.digest);
  // No launched task has entered withVerified yet: this must be fenced by the durable claim.
  assert.equal(f.youtube.isBusy(f.context.accountId), false);
  assert.throws(() => f.service.approve(second.id, sibling, second.digest), isError("publication_busy"));
  await entered.promise;
  assert.equal(f.youtube.isBusy(f.context.accountId), true);
  assert.throws(() => f.service.approve(second.id, sibling, second.digest), isError("publication_busy"));
  assert.deepEqual(f.store.studio.publication(second.id, sibling), second);
  const row = f.db.prepare("SELECT owner,lease_until FROM publications WHERE id=?").get(second.id);
  assert.equal(row.owner, null); assert.equal(row.lease_until, 0);
  assert.equal(f.store.listAudit(sibling).filter(event => event.action === "publication.approved").length, 0);
  release.resolve();
  assert.equal((await settled(f.store, first.id, f.context)).state, "processing");
  assert.equal(f.youtube.isBusy(f.context.accountId), false);
  assert.deepEqual(f.publisher.calls.map(call => call.kind), ["initiate", "upload"]);
});

test("cancel immediately after approval fences the task before its launch microtask", { timeout: 10_000 }, async t => {
  const f = await publishing(t), p = await f.service.create(input(f.context, f.imported.id));
  f.service.approve(p.id, f.context, p.digest);
  assert.deepEqual(f.verified, []);
  const cancelled = f.service.cancel(p.id, f.context);
  assert.equal(cancelled.state, "uncertain"); assert.equal(cancelled.error, "publication_dispatch_stopped");
  assert.equal(f.db.prepare("SELECT dispatch_revoked FROM publications WHERE id=?").get(p.id).dispatch_revoked, 1);
  const result = await settled(f.store, p.id, f.context);
  assert.equal(result.state, "uncertain"); assert.equal(result.videoId, null);
  assert.equal(f.db.prepare("SELECT session_ref FROM publications WHERE id=?").get(p.id).session_ref, null);
  assert.deepEqual(f.publisher.calls, []);
  assert.deepEqual(f.store.listMemory(f.context), []);
});

for (const when of ["active upload", "uncertain upload"]) {
  test(`cancel of ${when} persists dispatch_revoked; reconciliation only queries across restart`, { timeout: 10_000 }, async t => {
    const f = await publishing(t), entered = gate();
    let uploadSignal;
    f.publisher.onUpload = signal => {
      uploadSignal = signal; entered.resolve();
      if (when === "uncertain upload") throw new WorkspaceError(502, "youtube_upload_uncertain");
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const p = await f.service.create(input(f.context, f.imported.id));
    f.service.approve(p.id, f.context, p.digest);
    await entered.promise;
    if (when === "uncertain upload") await settled(f.store, p.id, f.context);
    assert.throws(() => f.service.cancel(p.id, f.other), isError("publication_not_found"));
    assert.equal(f.db.prepare("SELECT dispatch_revoked FROM publications WHERE id=?").get(p.id).dispatch_revoked, 0);
    assert.equal(f.service.cancel(p.id, f.context).error, "publication_dispatch_stopped");
    if (when === "active upload") assert.equal(uploadSignal.aborted, true);
    assert.equal((await settled(f.store, p.id, f.context)).state, "uncertain");
    assert.equal(f.db.prepare("SELECT dispatch_revoked FROM publications WHERE id=?").get(p.id).dispatch_revoked, 1);
    f.publisher.queryReply = { state: "incomplete", offset: 0 };
    f.service.reconcile(p.id, f.context);
    let result = await settled(f.store, p.id, f.context);
    assert.equal(result.state, "uncertain"); assert.equal(result.error, "publication_dispatch_stopped");
    await f.service.close();
    const reopened = new WorkspaceStore(f.path);
    f.cleanup.push(() => reopened.close());
    const restarted = new StudioService(reopened, f.youtube, f.vault, f.directory, { engine: engineOptions(f.directory), publisher: f.publisher });
    f.cleanup.push(() => restarted.close());
    assert.equal(reopened.db.prepare("SELECT dispatch_revoked FROM publications WHERE id=?").get(p.id).dispatch_revoked, 1);
    f.publisher.queryReply = { state: "incomplete", offset: WEBM.length - 1 };
    restarted.reconcile(p.id, f.context);
    result = await settled(reopened, p.id, f.context);
    assert.equal(result.state, "uncertain"); assert.equal(result.error, "publication_dispatch_stopped");
    assert.deepEqual(f.publisher.calls.map(call => call.kind), ["initiate", "upload", "query", "query"]);
    assert.deepEqual(reopened.listMemory(f.context), []);
    assert.throws(() => restarted.approve(p.id, f.context, p.digest), isError("approval_stale"));
    // Stopping dispatch must still allow recovery of a receipt for bytes already sent.
    f.publisher.queryReply = { state: "complete", videoId: VIDEO };
    restarted.reconcile(p.id, f.context);
    result = await settled(reopened, p.id, f.context);
    assert.equal(result.state, "processing"); assert.equal(result.videoId, VIDEO);
    restarted.reconcile(p.id, f.context);
    assert.equal((await settled(reopened, p.id, f.context)).state, "succeeded");
    assert.equal(reopened.listMemory(f.context).length, 1);
    assert.equal(reopened.db.prepare("SELECT dispatch_revoked FROM publications WHERE id=?").get(p.id).dispatch_revoked, 1);
    assert.deepEqual(f.publisher.calls.map(call => call.kind), ["initiate", "upload", "query", "query", "query", "processing"]);
  });
}

for (const elapsed of [599_999, 600_000]) {
  test(`approval TTL is exact at ${elapsed}ms, using the actual generated expiry`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T00:00:00Z") });
    const f = await publishing(t), ready = gate();
    f.youtube.before = () => ready.promise;
    const p = await f.service.create(input(f.context, f.imported.id));
    const approved = f.service.approve(p.id, f.context, p.digest);
    assert.equal(Date.parse(approved.approvalExpiresAt), Date.now() + 600_000);
    t.mock.timers.tick(elapsed);
    // Isolate approval expiry from the independent five-minute worker lease.
    f.db.prepare("UPDATE publications SET lease_until=? WHERE id=?").run(Date.now() + 300_000, p.id);
    ready.resolve();
    const result = await settled(f.store, p.id, f.context);
    if (elapsed === 600_000) {
      assert.equal(result.state, "uncertain"); assert.equal(result.error, "approval_expired"); assert.deepEqual(f.publisher.calls, []);
    } else {
      assert.equal(result.state, "processing"); assert.deepEqual(f.publisher.calls.map(call => call.kind), ["initiate", "upload"]);
    }
  });
}

for (const stage of ["snapshot", "read"]) {
  for (const elapsed of [599_999, 600_000]) {
    test(`dispatch rechecks exact approval TTL at ${elapsed}ms after asynchronous ${stage}`, { timeout: 10_000 }, async t => {
      t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T00:00:00Z") });
      const f = await publishing(t), paused = pauseSnapshot(f, stage);
      const p = await f.service.create(input(f.context, f.imported.id));
      const approved = f.service.approve(p.id, f.context, p.digest);
      assert.equal(Date.parse(approved.approvalExpiresAt) - Date.now(), 600_000);
      await paused.entered;
      const checks = f.youtube.guardChecks;
      assert.deepEqual(f.publisher.calls.map(call => call.kind), stage === "snapshot" ? [] : ["initiate"]);
      t.mock.timers.tick(elapsed);
      // Keep the independent worker lease valid while exercising only approval expiry.
      f.db.prepare("UPDATE publications SET lease_until=? WHERE id=?").run(Date.now() + 300_000, p.id);
      paused.release();
      const result = await settled(f.store, p.id, f.context);
      assert.ok(f.youtube.guardChecks > checks, "dispatch must invoke the supplied guard after the await");
      if (elapsed === 600_000) {
        assert.equal(result.state, "uncertain"); assert.equal(result.error, "approval_expired");
        assert.deepEqual(f.publisher.calls.map(call => call.kind), stage === "snapshot" ? [] : ["initiate"]);
      } else {
        assert.equal(result.state, "processing");
        assert.deepEqual(f.publisher.calls.map(call => call.kind), ["initiate", "upload"]);
        assert.deepEqual(f.publisher.calls.find(call => call.kind === "upload").bytes, WEBM);
      }
    });
  }

  for (const change of ["revision", "status"]) {
    test(`supplied account guard fences ${change} changes during asynchronous ${stage}`, { timeout: 10_000 }, async t => {
      const f = await publishing(t), paused = pauseSnapshot(f, stage);
      const p = await f.service.create(input(f.context, f.imported.id));
      f.service.approve(p.id, f.context, p.digest);
      await paused.entered;
      const checks = f.youtube.guardChecks;
      if (change === "revision") f.db.prepare("UPDATE youtube_connections SET revision=revision+1 WHERE account_id=?").run(f.context.accountId);
      else f.db.prepare("UPDATE accounts SET status='disconnected' WHERE id=?").run(f.context.accountId);
      paused.release();
      const result = await settled(f.store, p.id, f.context);
      assert.ok(f.youtube.guardChecks > checks, "a stale callback-entry check must not authorize dispatch");
      assert.equal(result.state, "uncertain");
      assert.equal(result.error, change === "revision" ? "connection_conflict" : "youtube_reauth_required");
      assert.deepEqual(f.publisher.calls.map(call => call.kind), stage === "snapshot" ? [] : ["initiate"]);
      assert.deepEqual(f.store.listMemory(f.context), []);
    });
  }
}

test("expired persisted approval cannot resume bytes, but a final receipt may be recovered without another approval", async t => {
  const f = await publishing(t);
  f.publisher.onUpload = () => { throw new WorkspaceError(502, "youtube_upload_uncertain"); };
  const p = await f.service.create(input(f.context, f.imported.id));
  f.service.approve(p.id, f.context, p.digest); await settled(f.store, p.id, f.context);
  patchPublication(f.db, p.id, { approvalExpiresAt: new Date(Date.now() - 1).toISOString() });
  f.publisher.queryReply = { state: "incomplete", offset: 0 };
  f.service.reconcile(p.id, f.context);
  let result = await settled(f.store, p.id, f.context);
  assert.equal(result.state, "uncertain"); assert.equal(result.error, "approval_expired");
  f.publisher.queryReply = { state: "complete", videoId: VIDEO };
  f.service.reconcile(p.id, f.context);
  result = await settled(f.store, p.id, f.context);
  assert.equal(result.state, "processing"); assert.equal(result.videoId, VIDEO);
  assert.deepEqual(f.publisher.calls.map(call => call.kind), ["initiate", "upload", "query", "query"]);
});

for (const missing of ["database-ref", "vault-secret", "provider-session"]) {
  test(`reconciliation with missing ${missing} never reinitiates an uncertain upload`, async t => {
    const f = await publishing(t);
    f.publisher.onUpload = () => { throw new WorkspaceError(502, "youtube_upload_uncertain"); };
    const p = await f.service.create(input(f.context, f.imported.id));
    f.service.approve(p.id, f.context, p.digest); await settled(f.store, p.id, f.context);
    if (missing === "database-ref") f.db.prepare("UPDATE publications SET session_ref=NULL WHERE id=?").run(p.id);
    if (missing === "vault-secret") f.secrets.clear();
    if (missing === "provider-session") f.publisher.queryReply = { state: "missing" };
    f.service.reconcile(p.id, f.context);
    const result = await settled(f.store, p.id, f.context);
    assert.equal(result.state, "uncertain");
    assert.equal(result.error, missing === "provider-session" ? "youtube_session_missing" : "youtube_upload_uncertain");
    assert.equal(f.publisher.calls.filter(call => call.kind === "initiate").length, 1);
    assert.equal(f.publisher.calls.filter(call => call.kind === "upload").length, 1);
    assert.equal(f.store.listMemory(f.context).length, 0);
  });
}

test("same-length hash tamper is rejected both before review and between approval and upload", async t => {
  const f = await publishing(t), path = f.service.engine.path(f.imported.id), changed = Buffer.from(WEBM);
  changed[changed.length - 1] ^= 1;
  await writeFile(path, changed);
  await assert.rejects(f.service.create(input(f.context, f.imported.id)), isError("media_source_changed"));
  assert.deepEqual(f.store.studio.publications(f.context), []);
  await writeFile(path, WEBM);
  const p = await f.service.create(input(f.context, f.imported.id));
  await writeFile(path, changed);
  f.service.approve(p.id, f.context, p.digest);
  const result = await settled(f.store, p.id, f.context);
  assert.equal(result.state, "uncertain"); assert.equal(result.error, "media_source_changed");
  assert.deepEqual(f.publisher.calls, []); assert.equal(f.secrets.size, 0);
});

test("upload sends the approved snapshot when the managed source is replaced with same-length bytes during initiation", { timeout: 10_000 }, async t => {
  const f = await publishing(t), entered = gate(), release = gate();
  f.cleanup.push(() => release.resolve());
  const original = f.publisher.initiate.bind(f.publisher);
  f.publisher.initiate = async (...args) => {
    const session = await original(...args);
    entered.resolve(); await release.promise;
    return session;
  };
  const p = await f.service.create(input(f.context, f.imported.id));
  f.service.approve(p.id, f.context, p.digest);
  await entered.promise;
  const changed = Buffer.from(WEBM);
  changed[changed.length - 1] ^= 1;
  const path = f.service.engine.path(f.imported.id);
  await writeFile(path, changed);
  assert.equal(changed.length, p.payload.bytes);
  assert.notEqual(createHash("sha256").update(changed).digest("hex"), p.payload.sha256);
  const checks = f.youtube.guardChecks;
  release.resolve();
  const result = await settled(f.store, p.id, f.context);
  assert.equal(result.state, "processing"); assert.equal(result.videoId, VIDEO);
  assert.ok(f.youtube.guardChecks > checks, "the supplied guard must run again before the chunk");
  assert.deepEqual(f.publisher.calls.map(call => call.kind), ["initiate", "upload"]);
  assert.deepEqual(f.publisher.calls[1].bytes, WEBM);
  assert.deepEqual(await readFile(path), changed);
});

test("account revocation after review and cross-account approval cannot publish or create memory", async t => {
  const f = await publishing(t), p = await f.service.create(input(f.context, f.imported.id));
  assert.throws(() => f.service.approve(p.id, f.other, p.digest), isError("publication_not_found"));
  f.store.setYouTubeStatus(f.connection, "disconnected");
  await assert.rejects(f.service.create(input(f.context, f.imported.id)), isError("youtube_reauth_required"));
  f.service.approve(p.id, f.context, p.digest);
  const result = await settled(f.store, p.id, f.context);
  assert.equal(result.state, "uncertain"); assert.equal(result.error, "youtube_reauth_required");
  assert.deepEqual(f.publisher.calls, []); assert.deepEqual(f.store.listMemory(f.context), []);
});

test("destination drift after review cannot redirect an approved payload to a different channel", async t => {
  const f = await publishing(t), p = await f.service.create(input(f.context, f.imported.id));
  const changed = `UC${"C".repeat(22)}`;
  f.db.prepare("UPDATE accounts SET destination_id=? WHERE id=?").run(changed, f.context.accountId);
  f.db.prepare("UPDATE youtube_connections SET destination_id=? WHERE account_id=?").run(changed, f.context.accountId);
  f.service.approve(p.id, f.context, p.digest);
  const result = await settled(f.store, p.id, f.context);
  assert.equal(result.payload.destinationId, f.connection.destinationId);
  assert.equal(result.digest, p.digest);
  assert.equal(result.state, "uncertain"); assert.equal(result.error, "youtube_account_not_found");
  assert.deepEqual(f.publisher.calls, []);
  assert.equal(f.store.listMemory(f.context).length, 0);
  assert.throws(() => f.service.reconcile(p.id, f.other), isError("publication_not_found"));
});

test("close aborts and awaits an active upload, durably releases it and prevents new work", { timeout: 10_000 }, async t => {
  const f = await publishing(t), entered = gate();
  let uploadSignal;
  f.publisher.onUpload = signal => new Promise((resolve, reject) => {
    uploadSignal = signal;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    entered.resolve();
  });
  const p = await f.service.create(input(f.context, f.imported.id));
  f.service.approve(p.id, f.context, p.digest);
  await entered.promise;
  await f.service.close();
  assert.equal(uploadSignal.aborted, true);
  const result = await settled(f.store, p.id, f.context);
  assert.equal(result.state, "uncertain"); assert.equal(result.videoId, null);
  assert.equal(f.store.listMemory(f.context).length, 0);
  assert.throws(() => f.service.approve(p.id, f.context, p.digest), isError("runtime_closing"));
  assert.throws(() => f.service.reconcile(p.id, f.context), isError("runtime_closing"));
  await assert.rejects(f.service.import(f.context, Readable.from([WEBM]), "source.webm", new AbortController().signal), isError("runtime_closing"));
  assert.deepEqual(f.publisher.calls.map(call => call.kind), ["initiate", "upload"]);
});

test("API close aborts a pending YouTube refresh while Studio awaits it and releases the publication lease", { timeout: 10_000 }, async t => {
  const entered = gate(), secrets = new Map(), publisher = new ControlledPublisher();
  let refreshSignal, rejectRefresh, refreshCalls = 0, abortObserved = false;
  const provider = new class extends YouTubeProvider {
    constructor() { super(async () => { throw new Error("Unexpected provider transport: remote effects forbidden"); }); }
    async tokens(client, fields, signal) {
      assert.equal(client.clientId, "controlled-test.apps.googleusercontent.com");
      assert.deepEqual(fields, { grant_type: "refresh_token", refresh_token: "controlled-refresh-token" });
      refreshCalls++; refreshSignal = signal;
      return new Promise((resolve, reject) => {
        rejectRefresh = reject;
        signal.throwIfAborted();
        signal.addEventListener("abort", () => { abortObserved = true; reject(signal.reason); }, { once: true });
        entered.resolve();
      });
    }
  }();
  const vault = { status: { available: true, provider: "windows-dpapi" },
    async get(ref) { return secrets.get(ref) ?? null; }, async set(ref, value) { secrets.set(ref, value); }, async delete(ref) { secrets.delete(ref); } };
  const f = await apiFixture(t, { credentialVault: vault, youtube: { client: null, provider },
    studio: { publisher, engine: engineOptions(tmpdir()) } });
  // Unblock teardown even if a sequential-close regression leaves refresh pending.
  f.cleanup.push(() => rejectRefresh?.(new Error("Test cleanup")));
  secrets.set(f.connection.credentialRef, JSON.stringify({ clientId: "controlled-test.apps.googleusercontent.com",
    accessToken: TOKEN, refreshToken: "controlled-refresh-token", expiresAt: Date.now() + 3600_000, scopes: f.connection.grantedScopes }));
  const imported = await f.call(`/api/media/import?${new URLSearchParams({ ...f.context, filename: "source.webm" })}`,
    { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: WEBM });
  assert.equal(imported.status, 201, await imported.clone().text());
  const a = await imported.json();
  assert.equal(a.sha256, SHA); assert.equal(a.bytes, WEBM.length);
  const post = (path, body) => f.call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const draft = await post("/api/publications", input(f.context, a.id));
  assert.equal(draft.status, 201, await draft.clone().text());
  const p = await draft.json();
  assert.equal(p.state, "review");
  const approved = await post(`/api/publications/${p.id}/approve`, { context: f.context, digest: p.digest });
  assert.equal(approved.status, 202, await approved.clone().text());
  assert.equal((await approved.json()).state, "uploading");
  await entered.promise;
  assert.equal(refreshCalls, 1); assert.equal(refreshSignal.aborted, false); assert.equal(abortObserved, false);
  assert.ok(f.db.prepare("SELECT owner FROM publications WHERE id=?").get(p.id).owner);
  assert.deepEqual(publisher.calls, []);
  const deadline = new AbortController();
  try {
    await Promise.race([f.api.close(), delay(1000, undefined, { signal: deadline.signal }).then(() => {
      assert.fail("API close must abort YouTube refresh without waiting for Studio to finish first");
    })]);
  } finally { deadline.abort(); }
  assert.equal(refreshSignal.aborted, true); assert.equal(abortObserved, true);
  const row = f.db.prepare("SELECT owner,lease_until FROM publications WHERE id=?").get(p.id);
  assert.equal(row.owner, null); assert.equal(row.lease_until, 0);
  const result = f.store.studio.publication(p.id, f.context);
  assert.equal(result.state, "uncertain"); assert.equal(result.videoId, null);
  assert.deepEqual(publisher.calls, []); assert.deepEqual(f.store.listMemory(f.context), []);
});
