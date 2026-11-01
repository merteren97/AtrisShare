import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { clipOptionsSchema } from "../dist/packages/domain/src/clips.js";
import { discoverClips, clipCaptions } from "../dist/packages/domain/src/clip-discovery.js";
import { editSchema } from "../dist/packages/domain/src/media.js";
import { MediaEngine } from "../dist/packages/media-engine/src/index.js";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
import { ClipService } from "../dist/services/local-api/src/clips.js";
import { StudioService } from "../dist/services/local-api/src/studio.js";
import { startApi } from "../dist/services/local-api/src/server.js";

const OPTIONS = { minSeconds: 2, targetSeconds: 4, maxSeconds: 6, count: 3, model: null, includeTranscript: false, includeHistory: false };
const SEGMENTS = Array.from({ length: 6 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.8, text: `Bölüm ${i + 1} tamamlandı.` }));
const stamp = () => new Date().toISOString();
const code = value => error => error.code === value;
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(read, predicate = value => value.state !== "running") {
  for (let n = 0; n < 1000; n++) { const value = await read(); if (predicate(value)) return value; await delay(10); }
  assert.fail("clip operation did not finish");
}
function makeContext(store, name = "Clips") {
  const account = store.createAccount({ displayName: name, platform: "youtube" });
  return { account, context: { accountId: account.id, projectId: store.createProject({ accountId: account.id, name, description: "" }).id } };
}
async function fixture(t, { bridge, real = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-clips-")), path = join(directory, "workspace.sqlite");
  const store = new WorkspaceStore(path), { context, account } = makeContext(store), other = makeContext(store, "Other").context;
  const studio = new StudioService(store, {}, {}, directory), services = [], stores = [store];
  let signals = { scenes: [4, 8], silences: [{ start: 3, end: 5 }] };
  if (!real) studio.engine = { async verify() { return true; }, async analyze(_id, signal) { signal.throwIfAborted(); return structuredClone(signals); } };
  const transcription = { latest: (id, scope) => store.transcripts.latest(id, scope) };
  const service = (database = store, adapter = bridge) => { const value = new ClipService(database, studio, transcription, { bridge: adapter }); services.push(value); return value; };
  const api = service();
  t.after(async () => { for (const s of services) await s.close(); await studio.close(); for (const s of stores) s.close(); await rm(directory, { recursive: true, force: true }); });
  let artifact = store.studio.addArtifact({ id: randomUUID(), ...context, filename: "synthetic.mp4", sha256: "a".repeat(64), bytes: 100,
    mimeType: "video/mp4", kind: "source", sourceId: null, channelVideoId: null, probe: { duration: 12, width: 640, height: 360, hasAudio: true }, createdAt: stamp() });
  const transcript = () => {
    const at = stamp(), owner = randomUUID(), r = store.transcripts.create({ id: randomUUID(), ...context, artifactId: artifact.id,
      sourceSha256: artifact.sha256, state: "running", progress: 0, language: null, segments: [], duration: null, error: null, createdAt: at, updatedAt: at }, owner);
    Object.assign(r, { state: "succeeded", progress: 1, language: "tr", duration: 12, segments: SEGMENTS }); store.transcripts.save(r, owner); return r;
  };
  transcript();
  return { directory, path, store, context, account, other, studio, api, service, transcript,
    get artifact() { return artifact; }, set artifact(value) { artifact = value; },
    start(options = OPTIONS, extra = {}) { return api.start({ context, destinationId: account.destinationId, artifactId: artifact.id, options, ...extra }); },
    done(run) { return until(() => store.clips.get(run.id, context)); },
    reopen() { const s = new WorkspaceStore(path); stores.push(s); return s; }
  };
}

test("clip configuration enforces bounded duration/count and explicit AI transcript consent", () => {
  assert.equal(clipOptionsSchema.safeParse(OPTIONS).success, true);
  for (const invalid of [{ minSeconds: 0 }, { targetSeconds: 10 }, { maxSeconds: 181 }, { count: 9 }, { count: 1.5 }, { model: "fixture/model" }, { extra: true }]) {
    assert.equal(clipOptionsSchema.safeParse({ ...OPTIONS, ...invalid }).success, false);
  }
});
test("ranked candidates have actual evidence, valid bounds, nonduplicate windows and language-neutral sentence hints", () => {
  const transcript = { duration: 12, segments: SEGMENTS }, signals = { scenes: [4, 8], silences: [{ start: 3, end: 5 }] };
  const candidates = discoverClips(transcript, signals, OPTIONS, { inSeconds: 0, outSeconds: 4 }, randomUUID);
  assert.ok(candidates.length >= 2);
  for (const c of candidates) {
    assert.ok(editSchema.safeParse(c.edit).success); assert.ok(c.edit.outSeconds <= 12);
    assert.ok(c.edit.outSeconds - c.edit.inSeconds >= 2 && c.edit.outSeconds - c.edit.inSeconds <= 6);
    assert.equal(c.evidence.excerpt, c.evidence.segmentIndices.map(i => SEGMENTS[i].text).join(" "));
    assert.ok(c.evidence.speechRatio > 0); assert.equal(typeof c.evidence.sentenceBoundary, "boolean");
  }
  assert.ok(candidates.every((c, i) => !i || c.score <= candidates[i - 1].score));
  assert.ok(candidates.some(c => c.evidence.sentenceBoundary));
  assert.equal(discoverClips({ duration: 1, segments: SEGMENTS }, signals, OPTIONS, null, randomUUID).length, 0);
  assert.deepEqual(clipCaptions(transcript, 1, 4), [{ start: 1, end: 1.8, text: SEGMENTS[0].text }, { start: 2, end: 3.8, text: SEGMENTS[1].text }]);
});
test("timed captions and crop positions reject reversed, overlapping, unsafe or unbounded values", () => {
  const edit = { inSeconds: 0, outSeconds: 4, crop: "vertical", gainDb: 0, caption: "", cropX: 0, timedCaptions: [{ start: 0, end: 1, text: "Hello" }] };
  assert.equal(editSchema.safeParse(edit).success, true);
  for (const change of [{ cropX: NaN }, { cropX: -1 }, { cropX: 1.01 }, { timedCaptions: [{ start: 1, end: 0, text: "X" }] },
    { timedCaptions: [{ start: 0, end: 2, text: "A" }, { start: 1, end: 3, text: "B" }] }, { timedCaptions: [{ start: 0, end: 1, text: "A\nB" }] }]) {
    assert.equal(editSchema.safeParse({ ...edit, ...change }).success, false);
  }
});
test("local analysis is persistent, bound to transcript/hash/revision, and does not invoke AI", async t => {
  const f = await fixture(t, { bridge: { discover() { assert.fail("no AI for local analysis"); }, rankClips() { assert.fail(); } } });
  const run = await f.done(await f.start()); assert.equal(run.state, "ready"); assert.ok(run.candidates.length >= 2);
  assert.equal(run.options.model, null); assert.equal(run.language, "tr"); assert.equal(run.algorithm, "clips-v1");
  const reopened = f.reopen(); assert.deepEqual(reopened.clips.get(run.id, f.context), run);
  assert.throws(() => reopened.clips.get(run.id, f.other), code("clip_not_found"));
  assert.equal(reopened.clips.list(run.artifactId, f.context).length, 1);
  assert.equal(f.store.studio.timeline(f.artifact.id, f.context).revision, 0, "discovery never mutates the timeline");
  const c = run.candidates[0], edit = { ...c.edit, cropX: .8, timedCaptions: f.api.captions(run.id, f.context, c.id, c.edit.inSeconds, c.edit.outSeconds) };
  const corrected = await f.api.correct(run.id, { context: f.context, expectedRevision: 0, candidateId: c.id, edit });
  assert.equal(corrected.revision, 1); assert.deepEqual(corrected.candidates[0].edit, edit);
  await assert.rejects(f.api.correct(run.id, { context: f.context, expectedRevision: 0, candidateId: c.id, edit }), code("clip_conflict"));
  f.store.studio.edit(f.artifact.id, f.context, 0, c.edit);
  await assert.rejects(f.api.render(run.id, f.context, 1, [c.id]), code("revision_conflict"));
});
test("AI sees bounded opted-in excerpts, validates ranked IDs and records selected model/session", async t => {
  let prompt;
  const bridge = { async discover() { return { available: true, models: ["fixture/ranker"] }; }, async rankClips(input) {
    prompt = JSON.parse(input.prompt); return { ranking: prompt.candidates.slice(0, 2).reverse().map(c => ({ id: c.id, reason: "Cümle tamam; bağlamı kontrol et." })), sessionId: "ses_controlled_rank" };
  } };
  const f = await fixture(t, { bridge });
  const run = await f.done(await f.start({ ...OPTIONS, model: "fixture/ranker", includeTranscript: true }));
  assert.equal(run.state, "ready"); assert.equal(run.sessionId, "ses_controlled_rank"); assert.equal(run.candidates.length, 2);
  assert.ok(run.candidates[0].reason.includes("bağlam")); assert.ok(JSON.stringify(prompt).length < 32000);
  assert.ok(!JSON.stringify(prompt).includes(f.directory)); assert.equal(prompt.context.historyRevision, 0);
  assert.ok(prompt.candidates.every(c => typeof c.evidence.excerpt === "string"));
  bridge.rankClips = async () => ({ ranking: [{ id: randomUUID(), reason: "hallucination" }], sessionId: null });
  const bad = await f.done(await f.start({ ...OPTIONS, model: "fixture/ranker", includeTranscript: true }));
  assert.equal(bad.state, "failed"); assert.equal(bad.error, "clip_invalid_ranking"); assert.deepEqual(bad.candidates, []);
});
test("durable cross-runtime cancellation rejects late output; expired owner projects interrupted", async t => {
  const entered = gate(), release = gate();
  const f = await fixture(t); f.studio.engine.analyze = async () => { entered.resolve(); await release.promise; return { scenes: [], silences: [] }; };
  const run = await f.start(); await entered.promise;
  const reopened = f.reopen(), second = f.service(reopened);
  await assert.rejects(second.start({ context: f.context, destinationId: f.account.destinationId, artifactId: f.artifact.id, options: OPTIONS }), code("clip_busy"));
  await second.cancel(run.id, f.context); release.resolve();
  const terminal = await f.done(run); assert.equal(terminal.state, "cancelled"); assert.deepEqual(terminal.candidates, []);
  f.studio.engine.analyze = async () => { throw new Error("controlled"); };
  const interrupted = await f.start(); f.store.db.prepare("UPDATE clip_analyses SET lease_until=0 WHERE id=?").run(interrupted.id);
  assert.equal(reopened.clips.get(interrupted.id, f.context).error, "clip_interrupted");
});
test("source bytes and transcript revision are rechecked after analysis awaits", async t => {
  const f = await fixture(t); let verified = true; f.studio.engine.verify = async () => verified;
  f.studio.engine.analyze = async () => { verified = false; return { scenes: [], silences: [] }; };
  const run = await f.done(await f.start()); assert.equal(run.state, "failed"); assert.equal(run.error, "media_source_changed");
});

test("render failures leave candidates correctable and cancellation awaits the owned render cleanup", async t => {
  const f = await fixture(t), cleaned = gate(), entered = gate();
  let run = await f.done(await f.start()), calls = 0, state = "failed";
  f.studio.renderClip = (_id, _context, edit) => { calls++; return { id: randomUUID(), state: "running" }; };
  f.store.studio.render = id => ({ id, state, error: "media_caption_does_not_fit", artifactId: null });
  run = await f.done(await f.api.render(run.id, f.context, run.revision, run.candidates.slice(0, 2).map(c => c.id)));
  assert.equal(calls, 2); assert.equal(run.state, "ready"); assert.equal(run.error, "clip_render_failed");
  assert.equal(run.candidates[0].renderError, "media_caption_does_not_fit");
  run = await f.api.correct(run.id, { context: f.context, expectedRevision: run.revision, candidateId: run.candidates[0].id, edit: { ...run.candidates[0].edit, caption: "Short" } });
  assert.equal(run.candidates[0].renderError, null);
  state = "running"; f.studio.renderClip = () => { entered.resolve(); return { id: randomUUID(), state }; };
  f.studio.cancelRender = () => { state = "cancelled"; };
  f.studio.waitForRender = async () => { await cleaned.promise; };
  run = await f.api.render(run.id, f.context, run.revision, [run.candidates[0].id]); await entered.promise;
  let settled = false; const cancellation = f.api.cancel(run.id, f.context).then(value => { settled = true; return value; });
  await delay(20); assert.equal(settled, false, "UI cancel must await owned media cleanup");
  cleaned.resolve(); assert.equal((await cancellation).state, "cancelled");
});

test("v5 migration preserves source/transcript/context and adds independent scoped analyses", async t => {
  const f = await fixture(t), before = f.store.transcripts.latest(f.artifact.id, f.context);
  f.store.db.exec("DROP TABLE clip_analyses; PRAGMA user_version=5");
  const reopened = f.reopen();
  assert.equal(reopened.db.prepare("PRAGMA user_version").get().user_version, 6);
  assert.deepEqual(reopened.transcripts.latest(f.artifact.id, f.context), before);
  assert.deepEqual(reopened.studio.artifact(f.artifact.id, f.context), f.artifact);
  assert.deepEqual(reopened.clips.list(f.artifact.id, f.context), []);
  assert.deepEqual(reopened.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("publication attachment is atomic with candidate CAS; stale concurrent requests leave no orphan drafts", async t => {
  const f = await fixture(t); const run = await f.done(await f.start()), candidate = run.candidates[0];
  const output = f.store.studio.addArtifact({ ...f.artifact, id: randomUUID(), kind: "export", sourceId: f.artifact.id });
  f.store.clips.mutate(run.id, f.context, run.revision, value => { value.candidates[0].artifactId = output.id; value.candidates[0].renderId = randomUUID(); });
  f.store.db.prepare("UPDATE accounts SET status='connected' WHERE id=?").run(f.context.accountId);
  const outcomes = await Promise.allSettled([f.api.draft(run.id, f.context, 1, candidate.id, "First"), f.api.draft(run.id, f.context, 1, candidate.id, "Second")]);
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(f.store.studio.publications(f.context).length, 1);
  assert.equal(f.store.clips.get(run.id, f.context).revision, 2);
});

async function ffmpeg(args) {
  const child = spawn(process.env.ATRIS_SHARE_FFMPEG ?? "ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", ...args], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const output = [], errors = []; child.stdout.on("data", b => output.push(b)); child.stderr.on("data", b => errors.push(b));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
  assert.equal(status, 0, Buffer.concat(errors).toString()); return Buffer.concat(output);
}
async function sourceVideo(directory) {
  const path = join(directory, "signals.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=640x360:r=10:d=4[r];color=c=blue:s=640x360:r=10:d=4[b];color=c=green:s=640x360:r=10:d=4[g];[r][b][g]concat=n=3:v=1:a=0",
    "-f", "lavfi", "-i", "aevalsrc='if(between(t,3,5),0,0.3*sin(2*PI*440*t))':s=16000:d=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-threads", "2", "-y", path]);
  return readFile(path);
}
test("real FFmpeg scene/silence evidence, sequential multi-export, caption timing, immutable source and review-only drafts", async t => {
  const f = await fixture(t, { real: true });
  if (!(await f.studio.engine.status()).available) { t.skip("External FFmpeg/FFprobe unavailable"); return; }
  const bytes = await sourceVideo(f.directory), source = await f.studio.engine.import(randomUUID(), Readable.from([bytes]), "signals.mp4");
  f.artifact = f.store.studio.addArtifact({ ...source, ...f.context, kind: "source", sourceId: null, channelVideoId: null, createdAt: stamp() }); f.transcript();
  const signals = await f.studio.engine.analyze(f.artifact.id, new AbortController().signal);
  assert.ok(signals.scenes.some(v => Math.abs(v - 4) <= .5), JSON.stringify(signals));
  assert.ok(signals.scenes.some(v => Math.abs(v - 8) <= .5), JSON.stringify(signals));
  assert.ok(signals.silences.some(v => Math.abs(v.start - 3) < .2 && Math.abs(v.end - 5) < .2), JSON.stringify(signals));
  let run = await f.done(await f.start()); assert.equal(run.state, "ready", run.error);
  const first = run.candidates[0];
  run = await f.api.correct(run.id, { context: f.context, expectedRevision: run.revision, candidateId: first.id,
    edit: { ...first.edit, inSeconds: 0, outSeconds: 4, cropX: .2, timedCaptions: [{ start: 0, end: 1, text: "Actual timed caption" }] } });
  const rendered = await f.done(await f.api.render(run.id, f.context, run.revision, run.candidates.slice(0, 2).map(c => c.id)));
  assert.equal(rendered.state, "ready", rendered.error); assert.ok(rendered.candidates.slice(0, 2).every(c => c.artifactId));
  const exported = f.store.studio.artifact(rendered.candidates[0].artifactId, f.context);
  assert.equal(exported.kind, "export"); assert.ok(Math.abs(exported.probe.duration - 4) < .15);
  assert.equal(exported.probe.width * 16, exported.probe.height * 9); assert.equal(exported.probe.hasAudio, true);
  assert.equal(await f.studio.engine.verify(f.artifact.id, createHash("sha256").update(bytes).digest("hex")), true);
  const ink = async second => { const pixels = await ffmpeg(["-ss", String(second), "-i", f.studio.engine.path(exported.id), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]); return [...pixels].filter(v => v > 210).length; };
  assert.ok(await ink(.5) > 30, "actual glyphs visible during cue"); assert.equal(await ink(1.5), 0, "cue not burned outside its timestamp");
  await assert.rejects(f.api.draft(run.id, f.context, rendered.revision, first.id, "Clip"), code("youtube_reauth_required"));
  // Local synthetic account binding only: never OAuth or a provider call.
  f.store.db.prepare("UPDATE accounts SET status='connected' WHERE id=?").run(f.context.accountId);
  const pub = await f.api.draft(run.id, f.context, rendered.revision, first.id, "Clip");
  assert.equal(pub.state, "review"); assert.equal(pub.approvalExpiresAt, null); assert.equal(pub.payload.visibility, "private");
  assert.equal(pub.payload.destinationId, f.account.destinationId); assert.equal(pub.payload.sha256, exported.sha256);
  const after = f.store.clips.get(run.id, f.context);
  assert.equal((await f.api.draft(run.id, f.context, after.revision, first.id, "Clip")).id, pub.id);
  assert.equal(f.store.studio.publications(f.context).length, 1); assert.equal(f.store.studio.timeline(f.artifact.id, f.context).revision, 0);
});

test("authenticated clip API rejects missing context, injected options and MCP publication authority", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-clip-api-"));
  const api = await startApi({ dataDirectory: directory, vaultStatus: { available: false, backend: "unavailable" } });
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json" };
  assert.equal((await fetch(`${api.origin}/api/clips`)).status, 401);
  assert.equal((await fetch(`${api.origin}/api/clips`, { headers })).status, 400);
  assert.equal((await fetch(`${api.origin}/api/clips`, { method: "POST", headers, body: JSON.stringify({ options: OPTIONS }) })).status, 400);
  assert.equal((await fetch(`${api.origin}/api/mcp/call`, { method: "POST", headers, body: JSON.stringify({ tool: "clips_publish", arguments: {} }) })).status, 401);
  const account = await (await fetch(`${api.origin}/api/accounts`, { method: "POST", headers, body: JSON.stringify({ displayName: "Caption bounds", platform: "youtube" }) })).json();
  const project = await (await fetch(`${api.origin}/api/projects`, { method: "POST", headers, body: JSON.stringify({ accountId: account.id, name: "Large Unicode cues", description: "" }) })).json();
  const correction = { context: { accountId: account.id, projectId: project.id }, expectedRevision: 0, candidateId: randomUUID(), edit: {
    inSeconds: 0, outSeconds: 100, crop: "vertical", gainDb: 0, caption: "", timedCaptions: Array.from({ length: 100 }, (_, i) => ({ start: i, end: i + 1, text: "界".repeat(300) })) } };
  assert.ok(Buffer.byteLength(JSON.stringify(correction)) > 32 * 1024);
  const bounded = await fetch(`${api.origin}/api/clips/${randomUUID()}`, { method: "PUT", headers, body: JSON.stringify(correction) });
  assert.equal(bounded.status, 404); assert.equal((await bounded.json()).error, "clip_not_found", "valid maximum Unicode cues pass transport/schema before scoped lookup");
  const oversized = await fetch(`${api.origin}/api/clips/${randomUUID()}`, { method: "PUT", headers, body: JSON.stringify({ ...correction, padding: "x".repeat(128 * 1024) }) });
  assert.equal(oversized.status, 413);
});
