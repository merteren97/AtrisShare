import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { transcriptContextSchema, transcriptSchema } from "../dist/packages/domain/src/transcription.js";
import { MediaEngine } from "../dist/packages/media-engine/src/index.js";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
import { TranscriptStore } from "../dist/packages/storage/src/transcript-store.js";
import { TranscriptionService } from "../dist/services/local-api/src/transcription.js";

// Real imported container/hash and real SQLite. Probe replies and speech are controlled,
// not claims of real FFmpeg audio inspection or whisper/LLM inference. No remote tools.
const mediaTests = await readFile(new URL("./media-engine.test.mjs", import.meta.url), "utf8");
const WEBM = Buffer.from(/const WEBM = Buffer\.from\("([A-Za-z0-9+/=]+)", "base64"\);/u.exec(mediaTests)[1], "base64");
const SHA = createHash("sha256").update(WEBM).digest("hex");
const RESULT = { language: "en", duration: 4, segments: [{ start: 0, end: 2, text: "Local speech" }] };
const STATUS = { available: true, ffmpeg: true, whisper: true, model: true };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const errorCode = code => error => error.code === code;
async function until(read, predicate = Boolean) {
  for (let n = 0; n < 500; n++) { const value = await read(); if (predicate(value)) return value; await delay(10); }
  assert.fail("Controlled transcription timed out");
}
async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Owned inspection child did not stop promptly")), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
class ControlledEngine {
  calls = [];
  discoveries = 0;
  statusValue = STATUS;
  async status() { this.discoveries++; return this.statusValue; }
  async transcribe(path, progress, signal) {
    const call = { path, progress, signal }; this.calls.push(call);
    if (this.handler) return this.handler(call);
    progress(0); progress(.25); progress(1);
    return structuredClone(RESULT);
  }
}
function context(store, name) {
  const accountId = store.createAccount({ displayName: name, platform: "youtube" }).id;
  return { accountId, projectId: store.createProject({ accountId, name, description: "" }).id };
}
function attach(store) {
  // Main owns migration 5 and WorkspaceStore attachment. The isolated branch uses
  // precisely that table contract; no production migration is changed by these tests.
  store.db.exec(`CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
    data TEXT NOT NULL, owner TEXT, lease_until INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(artifact_id,account_id,project_id) REFERENCES artifacts(id,account_id,project_id)
  ) STRICT`);
  store.transcripts = new TranscriptStore(store.db, scope => store.resolveContext(scope), (id, scope) => store.studio.artifact(id, scope));
  return store;
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-transcript-")), path = join(directory, "workspace.sqlite");
  const store = attach(new WorkspaceStore(path)), scope = context(store, "First"), other = context(store, "Other");
  const sibling = { accountId: scope.accountId, projectId: store.createProject({ accountId: scope.accountId, name: "Sibling", description: "" }).id };
  const probe = { duration: 4, width: 320, height: 240, hasAudio: true }, children = [], services = [], stores = [store];
  const inspection = { hold: false, child: null, ready: gate(), closed: false };
  let probes = 0;
  const media = new MediaEngine(directory, { spawn(_tool, args, options) {
    assert.equal(options.shell, false);
    assert.ok(args.includes("-show_entries"), "Only the controlled local ffprobe port is allowed");
    probes++;
    const data = { format: { duration: String(probe.duration) }, streams: [
      { codec_type: "video", width: probe.width, height: probe.height }, ...(probe.hasAudio ? [{ codec_type: "audio" }] : [])
    ] };
    const child = spawn(process.execPath, ["-e", inspection.hold
      ? 'process.stdout.write("inspection-ready\\n"); setInterval(() => {}, 1000)'
      : `console.log(${JSON.stringify(JSON.stringify(data))})`], options);
    if (inspection.hold) {
      inspection.child = child;
      child.stdout.once("data", () => inspection.ready.resolve());
      child.once("close", () => { inspection.closed = true; });
    }
    children.push(child); return child;
  } });
  const studio = { engine: media }, engine = new ControlledEngine();
  const service = (database = store, adapter = engine) => {
    const value = new TranscriptionService(database, studio, { engine: adapter }); services.push(value); return value;
  };
  const api = service();
  t.after(async () => {
    try {
      // Failure-only cleanup also works against a regression that forgets the probe signal.
      if (inspection.child && !inspection.closed) inspection.child.kill("SIGKILL");
      for (const api of services) await api.close();
      for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null, "Controlled child is reaped");
    } finally { for (const database of stores) database.close(); await rm(directory, { recursive: true, force: true }); }
  });
  const f = { directory, path, store, scope, other, sibling, media, studio, engine, api, service, probe, inspection, children,
    get probes() { return probes; },
    reopen() { const database = attach(new WorkspaceStore(path)); stores.push(database); return database; },
    async artifact(scopeOverride = scope, extra = {}) {
      const id = randomUUID(), imported = await media.import(id, Readable.from([WEBM]), "private-caption.webm");
      return store.studio.addArtifact({ ...imported, ...scopeOverride, kind: "source", sourceId: null, channelVideoId: null,
        createdAt: new Date().toISOString(), ...extra });
    },
    done(id) { return until(() => store.transcripts.get(id, scope), value => value.state !== "running"); }
  };
  return f;
}
function record(f, artifact, extra = {}) {
  const at = new Date().toISOString();
  return { id: randomUUID(), ...f.scope, artifactId: artifact.id, sourceSha256: artifact.sha256, state: "running", progress: 0,
    language: null, segments: [], duration: null, error: null, createdAt: at, updatedAt: at, ...extra };
}
function success(run, extra = {}) { return { ...run, ...structuredClone(RESULT), state: "succeeded", progress: 1, ...extra }; }
function patchArtifact(f, artifact, changes) {
  f.store.db.prepare("UPDATE artifacts SET data=? WHERE id=?").run(JSON.stringify({ ...artifact, ...changes }), artifact.id);
}
function blocking(engine) {
  const release = gate(), aborted = gate();
  engine.handler = async call => {
    call.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    await release.promise; return structuredClone(RESULT);
  };
  return { release, aborted };
}

test("transcription domain requires explicit project and exact bounded result fields", () => {
  const scope = { accountId: randomUUID(), projectId: randomUUID() };
  assert.deepEqual(transcriptContextSchema.parse(scope), scope);
  for (const invalid of [{ ...scope, projectId: null }, { accountId: scope.accountId }, { ...scope, path: "private" }]) {
    assert.equal(transcriptContextSchema.safeParse(invalid).success, false);
  }
  const at = new Date().toISOString(), value = { id: randomUUID(), ...scope, artifactId: randomUUID(), sourceSha256: SHA,
    state: "succeeded", progress: 1, ...RESULT, error: null, createdAt: at, updatedAt: at };
  assert.equal(transcriptSchema.safeParse(value).success, true);
  assert.equal(transcriptSchema.safeParse({ ...value, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00.001Z" }).success, true);
  for (const invalid of [{ ...value, path: "private" }, { ...value, progress: 1.1 }, { ...value, duration: null },
    { ...value, language: "../en" }, { ...value, error: "private stderr" }, { ...value, segments: [{ start: 2, end: 1, text: "bad" }] },
    { ...value, segments: [{ start: 0, end: 5, text: "bad" }] }, { ...value, segments: [{ start: 0, end: 1, text: "x".repeat(200001) }] },
    { ...value, segments: [{ start: 0, end: 2, text: "first" }, { start: 1, end: 3, text: "overlap" }] },
    { ...value, segments: Array.from({ length: 10001 }, () => ({ start: 0, end: 1, text: "x" })) }]) {
    assert.equal(transcriptSchema.safeParse(invalid).success, false);
  }
});

test("transcript schema rejects lone UTF-16 surrogates after JSON transport, preserving valid emoji at the text limit", () => {
  const at = new Date().toISOString(), value = { id: randomUUID(), accountId: randomUUID(), projectId: randomUUID(),
    artifactId: randomUUID(), sourceSha256: SHA, state: "succeeded", progress: 1, ...RESULT,
    error: null, createdAt: at, updatedAt: at };
  const transport = text => {
    const bytes = Buffer.from(JSON.stringify({ ...value, segments: [{ start: 0, end: 4, text }] }), "utf8");
    return { bytes, parsed: JSON.parse(bytes.toString("utf8")) };
  };
  for (const text of ["\ud800", "\udfff", "before\ud800after", "😀\udc00", "\ud800".repeat(200_000)]) {
    const { bytes, parsed } = transport(text);
    assert.equal(parsed.segments[0].text, text, "JSON escapes preserve lone surrogates instead of replacing them");
    if (text.length === 200_000) assert.ok(bytes.length > 1024 * 1024, "Escaped surrogates bypass a UTF-16-length-only bound");
    assert.equal(transcriptSchema.safeParse(parsed).success, false);
  }
  for (const text of ["😀🎙️🚀", "😀".repeat(100_000)]) {
    const { bytes, parsed } = transport(text);
    assert.ok(bytes.length < 1024 * 1024);
    assert.equal(transcriptSchema.parse(parsed).segments[0].text, text);
  }
});

test("local setup and immediate durable claim; fresh probe, managed path, text-only success and reopen", async t => {
  const f = await fixture(t), a = await f.artifact();
  assert.equal(f.api.latest(a.id, f.scope), null);
  assert.deepEqual(await f.api.setup(), STATUS);
  const hold = blocking(f.engine), run = await f.api.start(a.id, f.scope);
  assert.equal(run.state, "running");
  assert.equal(f.store.transcripts.get(run.id, f.scope).state, "running");
  await until(() => f.engine.calls.length);
  assert.equal(f.engine.calls[0].path, f.media.path(a.id));
  assert.deepEqual(Object.keys(f.engine.calls[0]).sort(), ["path", "progress", "signal"]);
  assert.equal(f.probes, 2, "Import and actual job inspect are independent");
  hold.release.resolve();
  const done = await f.done(run.id);
  assert.deepEqual({ language: done.language, segments: done.segments, duration: done.duration }, RESULT);
  assert.equal(done.state, "succeeded"); assert.equal(done.progress, 1);
  assert.equal(await f.media.verify(a.id, SHA), true);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get().n, 1);
  assert.deepEqual(await readdir(join(f.directory, "media")), [`${a.id}.mp4`]);
  await f.api.close();
  const reopened = f.reopen(), nextEngine = new ControlledEngine(), next = f.service(reopened, nextEngine);
  assert.deepEqual(next.latest(a.id, f.scope), done);
  await delay(20); assert.equal(nextEngine.calls.length, 0, "No replay on reopen/read");
});

test("setup absence/failure is bounded and makes no claim; shutdown during availability prevents launch", async t => {
  const f = await fixture(t), a = await f.artifact();
  f.engine.statusValue = { ...STATUS, model: false };
  await assert.rejects(f.api.start(a.id, f.scope), errorCode("transcription_unavailable"));
  assert.equal(f.api.latest(a.id, f.scope), null); assert.equal(f.engine.calls.length, 0);
  f.engine.status = async () => { throw new Error("stderr C:\\private\\model Bearer secret"); };
  await assert.rejects(f.api.setup(), error => error.code === "transcription_unavailable" && !error.message.includes("private"));
  const availability = gate(); f.engine.status = () => availability.promise;
  const starting = f.api.start(a.id, f.scope), closing = f.api.close();
  availability.resolve(STATUS);
  await assert.rejects(starting, errorCode("runtime_closing")); await closing;
  assert.equal(f.api.latest(a.id, f.scope), null);
});

test("all operations enforce strict account/project scope and reject proxy/preview sources before engine use", async t => {
  const f = await fixture(t), a = await f.artifact();
  const hold = blocking(f.engine), run = await f.api.start(a.id, f.scope);
  await until(() => f.engine.calls.length);
  for (const scope of [f.other, f.sibling]) {
    await assert.rejects(f.api.start(a.id, scope), errorCode("artifact_not_found"));
    assert.throws(() => f.api.latest(a.id, scope), errorCode("artifact_not_found"));
    assert.throws(() => f.store.transcripts.get(run.id, scope), errorCode("transcript_not_found"));
    assert.throws(() => f.store.transcripts.requestCancel(run.id, scope), errorCode("transcript_not_found"));
    await assert.rejects(f.api.cancel(run.id, scope), errorCode("transcript_not_found"));
  }
  for (const scope of [{ ...f.scope, projectId: null }, { ...f.scope, path: "/private" }]) {
    await assert.rejects(f.api.start(a.id, scope)); assert.throws(() => f.store.transcripts.latest(a.id, scope));
    assert.throws(() => f.store.transcripts.get(run.id, scope));
  }
  hold.release.resolve(); await f.done(run.id);
  for (const kind of ["proxy", "preview"]) {
    const derived = await f.artifact(f.scope, { kind, sourceId: a.id });
    await assert.rejects(f.api.start(derived.id, f.scope), errorCode("transcription_scope_mismatch"));
    assert.throws(() => f.store.transcripts.create(record(f, derived), "owner"), errorCode("transcription_scope_mismatch"));
  }
  assert.equal(f.engine.calls.length, 1);
});

test("one host claim across runtimes, repeated active artifact returns existing, and no duplicate task", async t => {
  const f = await fixture(t), a = await f.artifact(), b = await f.artifact();
  const hold = blocking(f.engine);
  const [one, two] = await Promise.all([f.api.start(a.id, f.scope), f.api.start(a.id, f.scope)]);
  assert.equal(one.id, two.id);
  const secondStore = f.reopen(), secondEngine = new ControlledEngine(), second = f.service(secondStore, secondEngine);
  assert.equal((await second.start(a.id, f.scope)).id, one.id);
  await assert.rejects(f.api.start(b.id, f.scope), errorCode("transcription_busy"));
  await assert.rejects(second.start(b.id, f.scope), errorCode("transcription_busy"));
  assert.throws(() => secondStore.transcripts.create(record(f, a), "other-owner"), errorCode("transcription_busy"));
  await until(() => f.engine.calls.length); assert.equal(secondEngine.calls.length, 0);
  hold.release.resolve(); await f.done(one.id);
  const next = await second.start(b.id, f.scope); assert.notEqual(next.id, one.id); await f.done(next.id);
});

test("simultaneous independent processes atomically claim only one job in real SQLite", async t => {
  const f = await fixture(t), a = await f.artifact();
  const modules = { store: new URL("../dist/packages/storage/src/store.js", import.meta.url).href,
    transcripts: new URL("../dist/packages/storage/src/transcript-store.js", import.meta.url).href };
  const ready = [], results = [], exits = [], workers = [];
  for (let n = 0; n < 2; n++) {
    const input = { path: f.path, record: record(f, a), owner: `process-${n}` };
    const script = `
      import { WorkspaceStore } from ${JSON.stringify(modules.store)};
      import { TranscriptStore } from ${JSON.stringify(modules.transcripts)};
      const input = ${JSON.stringify(input)};
      const store = new WorkspaceStore(input.path);
      const transcripts = new TranscriptStore(store.db, scope => store.resolveContext(scope), (id, scope) => store.studio.artifact(id, scope));
      process.once('message', () => {
        let result;
        try { result = { id: transcripts.create(input.record, input.owner).id }; }
        catch (error) { result = { error: error.code ?? error.message }; }
        store.close(); process.send(result, () => process.disconnect());
      });
      process.send({ ready: true });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    f.children.push(child); workers.push(child);
    ready.push(new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); }));
    results.push(new Promise(resolve => { child.on("message", value => { if (!value.ready) resolve(value); }); }));
    exits.push(new Promise(resolve => child.once("close", resolve)));
  }
  await Promise.all(ready); workers.forEach(worker => worker.send({ start: true }));
  const values = await Promise.all(results); await Promise.all(exits);
  assert.equal(values.filter(value => value.id).length, 1);
  assert.deepEqual(values.find(value => value.error), { error: "transcription_busy" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM transcripts").get().n, 1);
});

test("source hash is checked before inference, after inference, and against current artifact metadata", async t => {
  const f = await fixture(t), a = await f.artifact();
  await writeFile(f.media.path(a.id), Buffer.from("tampered"));
  let run = await f.api.start(a.id, f.scope), done = await f.done(run.id);
  assert.equal(done.error, "media_source_changed"); assert.equal(f.engine.calls.length, 0);
  await writeFile(f.media.path(a.id), WEBM);
  f.engine.handler = async () => { await writeFile(f.media.path(a.id), Buffer.from("late mutation")); return RESULT; };
  run = await f.api.start(a.id, f.scope); done = await f.done(run.id);
  assert.equal(done.state, "failed"); assert.equal(done.error, "media_source_changed"); assert.deepEqual(done.segments, []);
  await writeFile(f.media.path(a.id), WEBM);
  f.engine.handler = async () => { patchArtifact(f, a, { sha256: "a".repeat(64) }); return RESULT; };
  run = await f.api.start(a.id, f.scope); done = await f.done(run.id);
  assert.equal(done.error, "media_source_changed"); assert.deepEqual(done.segments, []);
});

test("actual source probe rejects no audio even when stored probe claims audio, and accepts fresh audio over stale metadata", async t => {
  const f = await fixture(t), a = await f.artifact();
  f.probe.hasAudio = false;
  const run = await f.api.start(a.id, f.scope), failed = await f.done(run.id);
  assert.equal(failed.state, "failed"); assert.equal(failed.error, "transcription_no_audio"); assert.equal(f.engine.calls.length, 0);
  f.probe.hasAudio = true; patchArtifact(f, a, { probe: null });
  const next = await f.api.start(a.id, f.scope); assert.equal((await f.done(next.id)).state, "succeeded");
});

test("actual duration must be known, positive and within the supported limit", async t => {
  const f = await fixture(t), a = await f.artifact();
  for (const duration of [NaN, 0, 7201]) {
    f.probe.duration = duration;
    const run = await f.api.start(a.id, f.scope), done = await f.done(run.id);
    assert.equal(done.state, "failed"); assert.deepEqual(done.segments, []);
    assert.equal(done.error, duration === 7201 ? "transcription_unsupported_duration_limit_7200s" : "transcription_failed");
  }
  assert.equal(f.engine.calls.length, 0);
});

test("progress uses actual finite monotonic 0..1 values and throttles DB writes", async t => {
  const f = await fixture(t), a = await f.artifact(), hold = blocking(f.engine);
  const original = f.store.transcripts.save.bind(f.store.transcripts); let writes = 0;
  f.store.transcripts.save = (...args) => { writes++; return original(...args); };
  const run = await f.api.start(a.id, f.scope); await until(() => f.engine.calls.length);
  const { progress } = f.engine.calls[0];
  for (const invalid of [NaN, Infinity, -1, 1.1]) progress(invalid);
  assert.equal(f.store.transcripts.get(run.id, f.scope).progress, 0);
  progress(.2); for (let n = 21; n <= 90; n++) progress(n / 100); progress(.1);
  assert.equal(f.store.transcripts.get(run.id, f.scope).progress, .2); assert.equal(writes, 1);
  await delay(1050); progress(.95);
  assert.equal(f.store.transcripts.get(run.id, f.scope).progress, .95); assert.equal(writes, 2);
  hold.release.resolve(); assert.equal((await f.done(run.id)).progress, 1); assert.equal(writes, 3);
});

test("owner/lease CAS, immutable scope/hash, and terminal records cannot be overwritten", async t => {
  const f = await fixture(t), a = await f.artifact(), owner = "original-owner";
  const run = f.store.transcripts.create(record(f, a), owner);
  assert.throws(() => f.store.transcripts.assertActive(run.id, "other-owner"), errorCode("transcription_conflict"));
  assert.throws(() => f.store.transcripts.save(success(run), "other-owner"), errorCode("transcription_conflict"));
  for (const changes of [{ artifactId: randomUUID() }, { accountId: f.other.accountId }, { projectId: f.sibling.projectId },
    { sourceSha256: "a".repeat(64) }, { createdAt: new Date(0).toISOString() }]) {
    assert.throws(() => f.store.transcripts.save({ ...run, ...changes }, owner), errorCode("transcription_conflict"));
  }
  const succeeded = success(run); f.store.transcripts.save(succeeded, owner);
  assert.throws(() => f.store.transcripts.save(run, owner), errorCode("transcription_conflict"));
  assert.throws(() => f.store.transcripts.requestCancel(run.id, f.scope), errorCode("transcription_conflict"));
  assert.equal(f.store.transcripts.get(run.id, f.scope).state, "succeeded");
});

test("expired running views fail interrupted after reopen; old owner fenced and fresh retry is explicit", async t => {
  const f = await fixture(t), a = await f.artifact();
  const run = f.store.transcripts.create(record(f, a), "dead-owner");
  f.store.db.prepare("UPDATE transcripts SET lease_until=? WHERE id=?").run(Date.now() - 1, run.id);
  const reopened = f.reopen(), next = f.service(reopened, new ControlledEngine());
  const interrupted = next.latest(a.id, f.scope);
  assert.equal(interrupted.state, "failed"); assert.equal(interrupted.error, "transcript_interrupted");
  assert.throws(() => f.store.transcripts.save(success(run), "dead-owner"), errorCode("transcription_conflict"));
  assert.throws(() => reopened.transcripts.requestCancel(run.id, f.scope), errorCode("transcription_conflict"));
  await delay(30); assert.equal(f.engine.calls.length, 0);
  assert.equal(JSON.parse(f.store.db.prepare("SELECT data FROM transcripts WHERE id=?").get(run.id).data).state, "running", "View never replays or rewrites expired work");
  const retry = await next.start(a.id, f.scope); assert.notEqual(retry.id, run.id); await f.done(retry.id);
  assert.equal(f.store.transcripts.get(run.id, f.scope).error, "transcript_interrupted");
});

test("durable cancel blocks progress and converts late success to cancelled without persisting text", async t => {
  const f = await fixture(t), a = await f.artifact(), owner = "owner";
  const run = f.store.transcripts.create(record(f, a), owner), other = f.reopen();
  other.transcripts.requestCancel(run.id, f.scope);
  assert.equal(f.store.db.prepare("SELECT cancel_requested FROM transcripts WHERE id=?").get(run.id).cancel_requested, 1);
  assert.throws(() => f.store.transcripts.assertActive(run.id, owner), errorCode("transcription_cancelled"));
  assert.throws(() => f.store.transcripts.save({ ...run, progress: .5 }, owner), errorCode("transcription_cancelled"));
  const late = success(run, { segments: [{ start: 0, end: 1, text: "PRIVATE LATE TEXT" }] });
  f.store.transcripts.save(late, owner);
  assert.equal(late.state, "cancelled"); assert.deepEqual(late.segments, []);
  assert.ok(!f.store.db.prepare("SELECT data FROM transcripts WHERE id=?").get(run.id).data.includes("PRIVATE LATE TEXT"));
});

test("same-runtime cancel waits for controlled child close before settling and releases host slot", async t => {
  const f = await fixture(t), a = await f.artifact(), stop = gate(), aborted = gate(); let exited = false;
  f.engine.handler = call => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); f.children.push(child);
    child.once("error", reject);
    child.once("close", () => { exited = true; reject(new DOMException("aborted", "AbortError")); });
    call.signal.addEventListener("abort", () => { aborted.resolve(); void stop.promise.then(() => child.kill()); }, { once: true });
  });
  const run = await f.api.start(a.id, f.scope); await until(() => f.engine.calls.length);
  let settled = false; const cancelling = f.api.cancel(run.id, f.scope).then(value => { settled = true; return value; });
  await aborted.promise; await delay(30); assert.equal(settled, false); assert.equal(exited, false);
  stop.resolve(); const cancelled = await cancelling;
  assert.equal(exited, true); assert.equal(cancelled.state, "cancelled"); assert.deepEqual(cancelled.segments, []);
  f.engine.handler = undefined;
  const next = await f.api.start(a.id, f.scope); assert.equal((await f.done(next.id)).state, "succeeded");
});

for (const action of ["cancel", "close"]) {
  test(`${action} during fresh actual inspection kills and reaps its owned probe before settling`, { timeout: 10_000 }, async t => {
    const f = await fixture(t), a = await f.artifact(), signals = [];
    const verify = f.media.verify.bind(f.media), inspect = f.media.inspect.bind(f.media);
    t.mock.method(f.media, "verify", (id, sha, signal) => { signals.push(signal); return verify(id, sha, signal); });
    t.mock.method(f.media, "inspect", (id, signal) => { signals.push(signal); return inspect(id, signal); });
    // Import already completed its separate preflight probe. Only the job's fresh
    // inspect now enters a harmless, genuinely running child through trusted spawn.
    f.inspection.hold = true;
    const run = await f.api.start(a.id, f.scope);
    await f.inspection.ready.promise;
    const child = f.inspection.child;
    assert.equal(f.probes, 2); assert.equal(child.exitCode, null); assert.equal(f.inspection.closed, false);
    assert.equal(signals.length, 2); assert.ok(signals[0] instanceof AbortSignal); assert.equal(signals[0], signals[1]);
    assert.equal(signals[0].aborted, false); assert.equal(f.engine.calls.length, 0);
    const result = await promptly(action === "cancel" ? f.api.cancel(run.id, f.scope) : f.api.close());
    assert.equal(signals[0].aborted, true);
    assert.equal(child.killed, true); assert.equal(f.inspection.closed, true, "Settlement must await child close, not just kill()");
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.throws(() => process.kill(child.pid, 0), error => error.code === "ESRCH", "No orphan probe process remains");
    const cancelled = f.store.transcripts.get(run.id, f.scope);
    assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.error, null); assert.deepEqual(cancelled.segments, []);
    if (result) assert.deepEqual(result, cancelled);
    const row = f.store.db.prepare("SELECT data,lease_until FROM transcripts WHERE id=?").get(run.id);
    assert.equal(row.lease_until, 0); assert.ok(!row.data.includes("Local speech"));
    f.inspection.hold = false;
    if (action === "cancel") {
      const retry = await f.api.start(a.id, f.scope);
      assert.notEqual(retry.id, run.id); assert.equal((await f.done(retry.id)).state, "succeeded");
    } else await assert.rejects(f.api.start(a.id, f.scope), errorCode("runtime_closing"));
    await f.api.close();
    assert.deepEqual(f.reopen().transcripts.get(run.id, f.scope), cancelled, "Old jobs stay cancelled across retry/close/reopen");
  });
}

test("cross-runtime cancellation reaches a quiet engine via heartbeat and cannot be replaced by late output", async t => {
  const f = await fixture(t), a = await f.artifact(), hold = blocking(f.engine);
  const run = await f.api.start(a.id, f.scope); await until(() => f.engine.calls.length);
  const secondStore = f.reopen(), second = f.service(secondStore, new ControlledEngine());
  assert.equal((await second.cancel(run.id, f.scope)).state, "running", "Foreign runtime records a request without claiming child exit");
  await hold.aborted.promise;
  assert.equal(f.engine.calls[0].signal.aborted, true);
  hold.release.resolve(); const done = await f.done(run.id);
  assert.equal(done.state, "cancelled"); assert.equal(done.error, null); assert.deepEqual(done.segments, []);
});

test("cancellation during final hash verification wins over late successful engine result", async t => {
  const f = await fixture(t), a = await f.artifact(), verifying = gate(), finish = gate();
  const verify = f.media.verify.bind(f.media); let count = 0;
  f.media.verify = async (...args) => { count++; if (count === 2) { verifying.resolve(); await finish.promise; } return verify(...args); };
  const run = await f.api.start(a.id, f.scope); await verifying.promise;
  let settled = false; const cancel = f.api.cancel(run.id, f.scope).then(value => { settled = true; return value; });
  await delay(20); assert.equal(settled, false);
  finish.resolve(); const done = await cancel;
  assert.equal(done.state, "cancelled"); assert.deepEqual(done.segments, []);
});

test("close waits for task exit, persists cancellation, and rejects new work", async t => {
  const f = await fixture(t), a = await f.artifact(), hold = blocking(f.engine);
  const run = await f.api.start(a.id, f.scope); await until(() => f.engine.calls.length);
  let closed = false; const closing = f.api.close().then(() => { closed = true; });
  await hold.aborted.promise; await delay(20); assert.equal(closed, false);
  hold.release.resolve(); await closing;
  assert.equal(f.store.transcripts.get(run.id, f.scope).state, "cancelled");
  await assert.rejects(f.api.start(a.id, f.scope), errorCode("runtime_closing"));
  await assert.rejects(f.api.setup(), errorCode("runtime_closing"));
});

test("service deadline aborts and awaits the engine, then records only a bounded timeout code", async t => {
  const f = await fixture(t), a = await f.artifact(), entered = gate(), hold = blocking(f.engine);
  const handler = f.engine.handler;
  f.engine.handler = call => { entered.resolve(); return handler(call); };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = await f.api.start(a.id, f.scope); await entered.promise;
  try {
    t.mock.timers.tick(40 * 60_000);
    await hold.aborted.promise;
    assert.equal(f.store.transcripts.get(run.id, f.scope).state, "running", "Abort is not proof that the child exited");
  } finally { t.mock.timers.reset(); hold.release.resolve(); }
  const done = await f.done(run.id);
  assert.equal(done.state, "failed"); assert.equal(done.error, "transcription_timeout"); assert.deepEqual(done.segments, []);
});

test("text is sanitized/redacted before persistence; post-redaction expansion and aggregate bounds fail closed", async t => {
  const f = await fixture(t), a = await f.artifact();
  f.engine.handler = async () => ({ ...RESULT, segments: [{ start: 0, end: 4,
    text: "\u202eHello\u0000\nBearer secret-private api_key=private-key sk-abcdefghijklmnop ghp_abcdefghijklmnopqrs -----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----" }] });
  const run = await f.api.start(a.id, f.scope), done = await f.done(run.id);
  assert.equal(done.state, "succeeded");
  assert.match(done.segments[0].text, /Hello Bearer \[REDACTED\] api_key=\[REDACTED\]/u);
  const data = f.store.db.prepare("SELECT data FROM transcripts WHERE id=?").get(run.id).data;
  for (const secret of ["secret-private", "private-key", "sk-abcdefghijklmnop", "ghp_abcdefghijklmnopqrs", "-----BEGIN", "\u202e", "\u0000"]) assert.ok(!data.includes(secret), secret);
  const owner = "bounds-owner";
  for (const segments of [
    [{ start: 0, end: 4, text: "password=x ".repeat(18000) }], // 198k raw, expands beyond 200k.
    [{ start: 0, end: 2, text: "a".repeat(100001) }, { start: 2, end: 4, text: "b".repeat(100000) }],
    Array.from({ length: 10001 }, (_, n) => ({ start: n / 10000, end: (n + 1) / 10000, text: "x" }))
  ]) {
    const next = f.store.transcripts.create(record(f, a), owner);
    assert.throws(() => f.store.transcripts.save(success(next, { segments }), owner), errorCode("transcription_invalid_output"));
    f.store.transcripts.save({ ...next, state: "failed", error: "transcription_invalid_output" }, owner);
  }
});

test("invalid engine results fail bounded without partial transcript or diagnostics", async t => {
  const f = await fixture(t), a = await f.artifact();
  for (const result of [{ ...RESULT, language: "C:\\private\\model" }, { ...RESULT, duration: null },
    { ...RESULT, segments: [{ start: 0, end: 6, text: "out of bounds" }] }, { ...RESULT, segments: [{ start: 0, end: 1, text: "x".repeat(200001) }] }]) {
    f.engine.handler = async () => result;
    const run = await f.api.start(a.id, f.scope), done = await f.done(run.id);
    assert.equal(done.state, "failed"); assert.equal(done.error, "transcription_invalid_output"); assert.deepEqual(done.segments, []);
  }
  for (const [message, code] of [["transcription_tool_timeout", "transcription_tool_timeout"],
    ["transcription_tool_unavailable: whisper", "transcription_tool_unavailable"],
    ["transcription_whisper_failed: C:\\private\\model Bearer secret", "transcription_failed"],
    ["ENOENT /private/source.wav", "transcription_failed"]]) {
    f.engine.handler = async () => { throw new Error(message); };
    const run = await f.api.start(a.id, f.scope), done = await f.done(run.id);
    assert.equal(done.state, "failed"); assert.equal(done.error, code);
    assert.ok(!JSON.stringify(done).includes("private"));
  }
});

test("heartbeat renews a quiet job lease at 30 seconds without poll-driven progress writes", async t => {
  const f = await fixture(t), a = await f.artifact(), hold = blocking(f.engine);
  const run = await f.api.start(a.id, f.scope); await until(() => f.engine.calls.length);
  const originalNow = Date.now, originalSave = f.store.transcripts.save.bind(f.store.transcripts); let writes = 0;
  f.store.transcripts.save = (...args) => { writes++; return originalSave(...args); };
  const initial = f.store.db.prepare("SELECT lease_until FROM transcripts WHERE id=?").get(run.id).lease_until;
  try {
    const shifted = originalNow() + 31000; Date.now = () => shifted;
    await until(() => writes > 0);
    assert.equal(writes, 1);
    assert.ok(f.store.db.prepare("SELECT lease_until FROM transcripts WHERE id=?").get(run.id).lease_until > initial + 30000);
    assert.equal(f.store.transcripts.get(run.id, f.scope).progress, 0);
  } finally { Date.now = originalNow; hold.release.resolve(); }
  assert.equal((await f.done(run.id)).state, "succeeded");
});
