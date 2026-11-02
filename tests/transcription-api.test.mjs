import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { aiRequestSchema } from "../dist/packages/domain/src/ai.js";
import { YOUTUBE_SCOPES } from "../dist/packages/domain/src/youtube.js";
import { MediaEngine } from "../dist/packages/media-engine/src/index.js";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
import { startApi } from "../dist/services/local-api/src/server.js";
import { YouTubeProvider } from "../dist/services/local-api/src/youtube-provider.js";
import { YouTubePublishing } from "../dist/services/local-api/src/youtube-publishing.js";

// Reuse only fixture bytes, never import (and execute) another test suite. This is
// a real small container; audio/probe replies and speech below are synthetic.
const embedded = /const WEBM = Buffer\.from\("([A-Za-z0-9+/=]+)", "base64"\);/u.exec(
  await readFile(new URL("./media-engine.test.mjs", import.meta.url), "utf8"));
assert.ok(embedded, "the small real WebM fixture must exist");
const WEBM = Buffer.from(embedded[1], "base64");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const SHA = hash(WEBM), MODEL = "controlled/transcript-model";
const STATUS = { available: true, ffmpeg: true, whisper: true, model: true };
const PROBE = { duration: 4, width: 320, height: 240, hasAudio: true };
const RESULT = { language: "en", duration: 4, segments: [{ start: .25, end: 2.5, text: "SCOPED_SPEECH" }] };
const EDIT = { inSeconds: 0, outSeconds: 4, crop: "original", gainDb: 0, caption: "" };
const BASE_TOOLS = ["media_inspect", "timeline_read", "media_transcribe", "transcript_status", "transcript_cancel",
  "timeline_propose", "render_preview", "render_status", "publication_request"];
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const query = context => new URLSearchParams(context);
const transcriptRoute = (a, context) => `/api/media/${a.id}/transcript?${query(context)}`;
const sourcePath = (f, a) => join(f.directory, "media", `${a.id}.mp4`);
const scope = (f, a) => ({ context: f.context, artifactId: a.id, destinationId: f.destinationId });
const request = (f, a, extra = {}) => ({ ...scope(f, a), model: MODEL, prompt: "Keep the opening",
  includeMemory: false, allowRemote: true, ...extra });

async function response(reply, status, code) {
  const text = await reply.text();
  assert.equal(reply.status, status, `${reply.url}: ${text}`);
  const value = JSON.parse(text);
  if (code) assert.deepEqual(value, { error: code });
  return value;
}
async function until(read, predicate = Boolean, label = "controlled local operation") {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}
function privateResult(value, forbidden) {
  const text = JSON.stringify(value);
  for (const secret of forbidden) assert.ok(!text.includes(secret), `private sentinel escaped: ${secret}`);
}
class ControlledEngine {
  calls = [];
  discoveries = 0;
  statusValue = STATUS;
  result = RESULT;
  async status() { this.discoveries++; return this.statusValue; }
  async transcribe(path, progress, signal) {
    const call = { path, progress, signal }; this.calls.push(call);
    if (this.handler) return this.handler(call);
    progress(.25);
    return structuredClone(this.result);
  }
}
class ControlledBridge {
  calls = [];
  async discover(signal) {
    signal.throwIfAborted();
    return { available: true, version: "controlled-local", models: [MODEL], auth: "cli-managed", error: null };
  }
  async propose(input, event, signal) {
    signal.throwIfAborted(); this.calls.push(input); event({ type: "started", message: "controlled" });
    return { summary: "Controlled proposal", edit: structuredClone(EDIT), sessionId: "controlled-session" };
  }
}
function connect(store, letter) {
  const accountId = randomUUID(), destinationId = `UC${letter.repeat(22)}`;
  const connection = store.connectYouTube({ accountId, destinationId, displayName: `Channel ${letter}`,
    providerSubjectId: `synthetic-subject-${letter}`, credentialRef: `account:${randomUUID()}`,
    grantedScopes: ["openid"], expectedRevision: null });
  return { context: { accountId, projectId: store.createProject({ accountId, name: letter, description: "" }).id },
    destinationId, connection };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-transcription-api-"));
  const path = join(directory, "atris-share.sqlite"), store = new WorkspaceStore(path);
  const first = connect(store, "A"), other = connect(store, "B");
  const sibling = { accountId: first.context.accountId,
    projectId: store.createProject({ accountId: first.context.accountId, name: "Sibling", description: "" }).id };
  const engine = new ControlledEngine(), bridge = new ControlledBridge(), probe = { ...PROBE };
  const children = [], probes = [], cleanup = [], releases = [], secrets = new Map(), vaultCalls = [];
  const forbidden = async () => { assert.fail("No provider, OAuth network, browser or live inference is allowed"); };
  const options = { dataDirectory: directory, transcription: { engine }, ai: { bridge },
    credentialVault: { status: { available: true, provider: "windows-dpapi" },
      async get(ref) { vaultCalls.push(["get", ref]); return secrets.get(ref) ?? null; },
      async set(ref, value) { vaultCalls.push(["set", ref]); secrets.set(ref, value); },
      async delete(ref) { vaultCalls.push(["delete", ref]); secrets.delete(ref); } },
    youtube: { client: null, provider: new YouTubeProvider(forbidden), openBrowser: forbidden },
    studio: { publisher: new YouTubePublishing(forbidden), engine: {
      ffmpegPath: "controlled-ffmpeg", ffprobePath: "controlled-ffprobe",
      spawn(tool, args, spawnOptions) {
        assert.equal(spawnOptions.shell, false); assert.equal(spawnOptions.windowsHide, true);
        assert.ok(Object.keys(spawnOptions.env).every(key => /^(path|systemroot|temp|tmp|tmpdir)$/iu.test(key)));
        assert.equal(tool, "controlled-ffprobe");
        assert.ok(args.includes("-show_entries"), "only fresh local inspection is expected");
        probes.push(args);
        const data = { format: { duration: String(probe.duration) }, streams: [
          { codec_type: "video", width: probe.width, height: probe.height },
          ...(probe.hasAudio ? [{ codec_type: "audio" }] : [])] };
        // Real child lifecycle through the trusted spawn port, not a shell/FFmpeg invocation.
        const child = spawn(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify(data))})`], spawnOptions);
        children.push(child); return child;
      }
    } } };
  let api = await startApi(options);
  t.after(async () => {
    for (const release of releases) release();
    try {
      for (const close of cleanup.reverse()) await close();
      await api.close();
      for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null, "owned probe child is reaped");
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  });
  return { directory, path, store, ...first, other: other.context, sibling, engine, bridge, probe, probes,
    options, cleanup, releases, secrets, vaultCalls,
    get api() { return api; },
    async restart() { await api.close(); api = await startApi(options); },
    call(route, init = {}, token = api.token) {
      return fetch(`${api.origin}${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
    },
    json(route, value, token = api.token) {
      return this.call(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }, token);
    }
  };
}
async function imported(f, context = f.context) {
  const a = await response(await f.call(`/api/media/import?${new URLSearchParams({ ...context, filename: "local-source.webm" })}`,
    { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: WEBM }), 201);
  assert.equal(a.sha256, SHA); assert.equal(a.bytes, WEBM.length); assert.deepEqual(a.probe, f.probe);
  assert.deepEqual(await readFile(sourcePath(f, a)), WEBM);
  return a;
}
function blocking(f) {
  const release = gate(); f.releases.push(release.resolve);
  f.engine.handler = async call => { await release.promise; call.progress(1); return structuredClone(f.engine.result); };
  return release;
}
const start = async (f, a, context = f.context) => response(await f.json(`/api/media/${a.id}/transcribe`, { context }), 202);
const done = (f, run, context = f.context) => until(() => f.store.transcripts.get(run.id, context), value => value.state !== "running", "transcript completion");
async function transcribed(f, a, result = RESULT, context = f.context) {
  f.engine.result = result;
  const run = await start(f, a, context), saved = await done(f, run, context);
  assert.equal(saved.state, "succeeded", JSON.stringify(saved)); return saved;
}
async function ready(f, a, extra = {}) {
  const run = await response(await f.json("/api/ai/runs", request(f, a, extra)), 202);
  const saved = await until(() => f.store.studio.aiRun(run.id, f.context), value => value.state !== "running", "AI proposal");
  assert.equal(saved.state, "ready", JSON.stringify(saved)); return saved;
}
function patchArtifact(f, a, changes) {
  f.store.db.prepare("UPDATE artifacts SET data=? WHERE id=?").run(JSON.stringify({ ...a, ...changes }), a.id);
}
const mint = async (f, a, extra = {}) => response(await f.json("/api/ai/grants", { ...scope(f, a), includeMemory: false, ...extra }), 201);
const mcp = (f, grant, tool, args = {}) => f.json("/api/mcp/call", { tool, arguments: args }, grant.token);

async function sdkClient(f, grant) {
  const entry = fileURLToPath(new URL("../dist/services/mcp-server/src/index.js", import.meta.url));
  assert.deepEqual(grant.command, { command: process.execPath, args: [entry] });
  const transport = new StdioClientTransport({ ...grant.command, stderr: "pipe", env: {
    ATRIS_SHARE_MCP_ORIGIN: grant.origin, ATRIS_SHARE_MCP_GRANT: grant.token,
    ATRIS_SHARE_API_TOKEN: "unused-regular-bearer-sentinel" } });
  const client = new Client({ name: "transcription-api-regression", version: "1.0.0" });
  let stderr = "";
  transport.stderr.on("data", chunk => { stderr += chunk; });
  const errors = []; client.onerror = error => errors.push(error.message);
  f.cleanup.push(async () => {
    const pid = transport.pid; await client.close();
    if (pid !== null) await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, Boolean, "stdio child exit");
    assert.equal(stderr, "", "stdio diagnostics must not expose grant/private responses"); assert.deepEqual(errors, []);
  });
  await client.connect(transport); return client;
}
async function sdkTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.content.length, 1); assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}
async function sdkError(client, name, args, code) {
  assert.deepEqual(await client.callTool({ name, arguments: args }),
    { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code }) }] });
}

test("transcription HTTP requires session auth, exact scope and managed IDs, never caller paths", async t => {
  const f = await fixture(t), a = await imported(f), route = `/api/media/${a.id}/transcribe`;
  for (const [url, init] of [["/api/transcription/setup", {}], [transcriptRoute(a, f.context), {}],
    [route, { method: "POST" }], [`/api/transcripts/${randomUUID()}/cancel`, { method: "POST" }]]) {
    await response(await f.call(url, init, "invalid-session"), 401, "unauthorized");
  }
  await response(await f.call(transcriptRoute(a, f.context)), 200);
  assert.equal(await response(await f.call(transcriptRoute(a, f.context)), 200), null);
  for (const value of [{}, { context: { accountId: f.context.accountId } }, { context: { ...f.context, projectId: null } },
    { context: { ...f.context, path: "C:\\private\\source.wav" } }, { context: f.context, path: sourcePath(f, a) },
    { context: f.context, source: "file:///private.wav" }, { context: f.context, engine: "remote" }]) {
    await response(await f.json(route, value), 400, "invalid_input");
  }
  await response(await f.json("/api/media/not-a-managed-id/transcribe", { context: f.context }), 400, "invalid_input");
  await response(await f.call(`/api/media/${a.id}/transcript`), 400, "context_required");
  for (const context of [f.other, f.sibling]) {
    await response(await f.json(route, { context }), 404, "artifact_not_found");
    await response(await f.call(transcriptRoute(a, context)), 404, "artifact_not_found");
  }
  for (const kind of ["proxy", "preview"]) {
    patchArtifact(f, a, { kind, sourceId: randomUUID() });
    await response(await f.json(route, { context: f.context }), 409, "transcription_scope_mismatch");
  }
  patchArtifact(f, a, {});
  assert.equal(f.engine.discoveries, 0); assert.deepEqual(f.engine.calls, []);
  const release = blocking(f), run = await start(f, a);
  for (const context of [f.other, f.sibling]) {
    await response(await f.json(`/api/transcripts/${run.id}/cancel`, { context }), 404, "transcript_not_found");
  }
  await response(await f.json(`/api/transcripts/${run.id}/cancel`, { context: f.context, path: "private" }), 400, "invalid_input");
  assert.equal(f.store.db.prepare("SELECT cancel_requested FROM transcripts WHERE id=?").get(run.id).cancel_requested, 0);
  release.resolve(); await done(f, run);
});

test("setup projects booleans only; unavailable/throwing engines expose no secrets and create no job", async t => {
  const f = await fixture(t), a = await imported(f);
  f.engine.statusValue = { ...STATUS, path: f.directory, modelPath: "C:\\private\\model.bin", token: "synthetic-status-secret" };
  assert.deepEqual(await response(await f.call("/api/transcription/setup"), 200), STATUS);
  f.engine.statusValue = { ...f.engine.statusValue, model: false };
  assert.deepEqual(await response(await f.call("/api/transcription/setup"), 200), { ...STATUS, available: false, model: false });
  await response(await f.json(`/api/media/${a.id}/transcribe`, { context: f.context }), 409, "transcription_unavailable");
  f.engine.status = async () => { throw new Error("Bearer synthetic-status-secret C:\\private\\model.bin"); };
  await response(await f.call("/api/transcription/setup"), 409, "transcription_unavailable");
  assert.equal(f.store.transcripts.latest(a.id, f.context), null); assert.deepEqual(f.engine.calls, []);
});

for (const invalidation of ["revoked", "expired"]) {
  test(`MCP grant ${invalidation} during transcription setup cannot claim or launch a job`, { timeout: 10_000 }, async t => {
    const f = await fixture(t), a = await imported(f), grant = await mint(f, a), entered = gate(), release = gate();
    f.releases.push(release.resolve);
    f.engine.status = async () => { entered.resolve(); await release.promise; return STATUS; };
    const probes = f.probes.length, pending = mcp(f, grant, "media_transcribe");
    await entered.promise;
    assert.equal(f.store.transcripts.latest(a.id, f.context), null);
    try {
      if (invalidation === "revoked") {
        await response(await f.json("/api/ai/grants/revoke", { context: f.context, token: grant.token }), 200);
      } else {
        t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
        t.mock.timers.tick(30 * 60_000);
      }
      release.resolve();
      await response(await pending, 401, "mcp_grant_invalid");
      assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM transcripts").get().n, 0, "Revalidation precedes durable claim");
      assert.equal(f.probes.length, probes); assert.deepEqual(f.engine.calls, []);
    } finally { release.resolve(); if (invalidation === "expired") t.mock.timers.reset(); }
  });
}

test("HTTP transcript JSON rejects escaped lone surrogates but round-trips maximum-length valid emoji", async t => {
  const f = await fixture(t), a = await imported(f);
  const malformed = JSON.parse(JSON.stringify({ ...RESULT, segments: [{ start: 0, end: 4, text: "\ud800".repeat(200_000) }] }));
  assert.ok(Buffer.byteLength(JSON.stringify(malformed)) > 1024 * 1024);
  f.engine.result = malformed;
  const failed = await done(f, await start(f, a));
  assert.equal(failed.state, "failed"); assert.equal(failed.error, "transcription_invalid_output");
  assert.deepEqual(failed.segments, []);
  assert.deepEqual(await response(await f.call(transcriptRoute(a, f.context)), 200), failed);
  const text = "😀".repeat(100_000);
  const saved = await transcribed(f, a, { ...RESULT, segments: [{ start: 0, end: 4, text }] });
  const reply = await f.call(transcriptRoute(a, f.context)), bytes = Buffer.from(await reply.arrayBuffer());
  assert.equal(reply.status, 200); assert.ok(bytes.length < 1024 * 1024);
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), saved);
  assert.equal(saved.segments[0].text, text);
});

test("async HTTP jobs use fresh inspection and managed bytes, deduplicate active starts, persist redacted speech across restart", async t => {
  const f = await fixture(t), a = await imported(f), b = await imported(f), release = blocking(f);
  f.engine.result = { ...RESULT, segments: [{ start: .25, end: 2.5, text: "Hello\u0000\nBearer synthetic-speech-secret api_key=synthetic-key" }] };
  const probes = f.probes.length, run = await start(f, a);
  assert.equal(run.state, "running"); assert.deepEqual(run.segments, []); assert.equal(run.sourceSha256, SHA);
  assert.equal((await start(f, a)).id, run.id);
  await response(await f.json(`/api/media/${b.id}/transcribe`, { context: f.context }), 409, "transcription_busy");
  await until(() => f.engine.calls.length);
  assert.equal(f.probes.length, probes + 1, "the job must inspect independently of import/stored probe");
  assert.equal(f.engine.calls[0].path, sourcePath(f, a));
  assert.deepEqual(Object.keys(f.engine.calls[0]).sort(), ["path", "progress", "signal"]);
  release.resolve(); const saved = await done(f, run);
  assert.equal(saved.state, "succeeded"); assert.equal(saved.progress, 1);
  assert.deepEqual(saved.segments, [{ start: .25, end: 2.5, text: "Hello Bearer [REDACTED] api_key=[REDACTED]" }]);
  const exposed = await response(await f.call(transcriptRoute(a, f.context)), 200);
  assert.deepEqual(exposed, saved);
  privateResult(exposed, [f.api.token, f.connection.credentialRef, f.directory, "synthetic-speech-secret", "synthetic-key"]);
  const row = f.store.db.prepare("SELECT data,lease_until FROM transcripts WHERE id=?").get(run.id);
  assert.equal(row.lease_until, 0); privateResult(row, ["synthetic-speech-secret", "synthetic-key"]);
  const calls = f.engine.calls.length; await f.restart();
  assert.deepEqual(await response(await f.call(transcriptRoute(a, f.context)), 200), saved);
  assert.equal(f.engine.calls.length, calls, "restart/read must not replay speech work");
  assert.deepEqual(await readFile(sourcePath(f, a)), WEBM);
  assert.deepEqual((await readdir(join(f.directory, "media"))).sort(), [`${a.id}.mp4`, `${b.id}.mp4`].sort());
  assert.deepEqual(f.store.listMemory(f.context), []); assert.deepEqual(f.store.studio.renders(f.context), []);
});

test("fresh FFprobe reply overrides stored audio metadata and failures return no speech/diagnostics", async t => {
  const f = await fixture(t), a = await imported(f);
  f.probe.hasAudio = false;
  const failed = await done(f, await start(f, a));
  assert.equal(failed.error, "transcription_no_audio"); assert.equal(failed.state, "failed"); assert.deepEqual(failed.segments, []);
  assert.deepEqual(f.engine.calls, []);
  f.probe.hasAudio = true; patchArtifact(f, a, { probe: { ...PROBE, hasAudio: false } });
  assert.equal((await transcribed(f, a)).state, "succeeded");
  f.engine.handler = async () => { throw new Error(`Bearer synthetic-engine-secret ${f.directory}`); };
  const error = await done(f, await start(f, a));
  assert.equal(error.error, "transcription_failed"); assert.deepEqual(error.segments, []);
  privateResult(await response(await f.call(transcriptRoute(a, f.context)), 200), ["synthetic-engine-secret", f.directory]);
});

test("pending HTTP cancel is projected for the UI, waits for engine exit and fences late speech/progress", { timeout: 10_000 }, async t => {
  const f = await fixture(t), a = await imported(f), release = blocking(f), run = await start(f, a);
  await until(() => f.engine.calls.length); const call = f.engine.calls[0];
  let settled = false;
  const cancelling = f.json(`/api/transcripts/${run.id}/cancel`, { context: f.context }).then(value => { settled = true; return value; });
  await until(() => call.signal.aborted);
  assert.equal(settled, false, "abort is not proof of owned task exit");
  const pending = await response(await f.call(transcriptRoute(a, f.context)), 200);
  assert.equal(pending.state, "running"); assert.equal(pending.cancelRequested, true); assert.deepEqual(pending.segments, []);
  assert.equal(f.store.db.prepare("SELECT cancel_requested FROM transcripts WHERE id=?").get(run.id).cancel_requested, 1);
  call.progress(.9); release.resolve();
  const cancelled = await response(await cancelling, 200);
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.error, null); assert.deepEqual(cancelled.segments, []);
  call.progress(1);
  assert.deepEqual(await response(await f.call(transcriptRoute(a, f.context)), 200), cancelled);
  const row = f.store.db.prepare("SELECT data,lease_until FROM transcripts WHERE id=?").get(run.id);
  assert.equal(row.lease_until, 0); privateResult(row, ["SCOPED_SPEECH"]);
  await response(await f.json(`/api/transcripts/${run.id}/cancel`, { context: f.context }), 409, "transcription_conflict");
  await f.restart();
  assert.deepEqual(await response(await f.call(transcriptRoute(a, f.context)), 200), cancelled);
});

test("another API runtime requests durable cancel and both UI reads project it before quiet owner exits", { timeout: 10_000 }, async t => {
  const f = await fixture(t), a = await imported(f), release = blocking(f), run = await start(f, a);
  await until(() => f.engine.calls.length);
  const second = await startApi(f.options); f.cleanup.push(() => second.close());
  const reply = await fetch(`${second.origin}/api/transcripts/${run.id}/cancel`, { method: "POST",
    headers: { Authorization: `Bearer ${second.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ context: f.context }) });
  const pending = await response(reply, 200);
  assert.equal(pending.state, "running"); assert.equal(pending.cancelRequested, true);
  for (const api of [f.api, second]) {
    const view = await response(await fetch(`${api.origin}${transcriptRoute(a, f.context)}`,
      { headers: { Authorization: `Bearer ${api.token}` } }), 200);
    assert.equal(view.state, "running"); assert.equal(view.cancelRequested, true);
  }
  await until(() => f.engine.calls[0].signal.aborted, Boolean, "owner heartbeat cancellation");
  release.resolve(); const saved = await done(f, run);
  assert.equal(saved.state, "cancelled"); assert.deepEqual(saved.segments, []);
});

for (const drift of ["bytes before inference", "bytes after inference", "metadata after inference"]) {
  test(`HTTP transcription rejects source ${drift} without persisting speech`, async t => {
    const f = await fixture(t), a = await imported(f);
    if (drift === "bytes before inference") await writeFile(sourcePath(f, a), Buffer.concat([WEBM, Buffer.from("tampered")]));
    else f.engine.handler = async () => {
      if (drift === "bytes after inference") await writeFile(sourcePath(f, a), Buffer.concat([WEBM, Buffer.from("late tamper")]));
      else patchArtifact(f, a, { sha256: "a".repeat(64) });
      return RESULT;
    };
    const saved = await done(f, await start(f, a));
    assert.equal(saved.state, "failed"); assert.equal(saved.error, "media_source_changed"); assert.deepEqual(saved.segments, []);
    assert.equal(f.engine.calls.length, drift === "bytes before inference" ? 0 : 1);
    privateResult(f.store.db.prepare("SELECT data FROM transcripts WHERE id=?").get(saved.id), ["SCOPED_SPEECH"]);
  });
}

test("restart exposes expired work as interrupted without replay and permits only an explicit retry", async t => {
  const f = await fixture(t), a = await imported(f), at = new Date().toISOString();
  const run = f.store.transcripts.create({ id: randomUUID(), ...f.context, artifactId: a.id, sourceSha256: SHA,
    state: "running", progress: 0, language: null, duration: null, segments: [], error: null, createdAt: at, updatedAt: at }, "dead-owner");
  f.store.db.prepare("UPDATE transcripts SET lease_until=0 WHERE id=?").run(run.id);
  await f.restart();
  const view = await response(await f.call(transcriptRoute(a, f.context)), 200);
  assert.equal(view.state, "failed"); assert.equal(view.error, "transcript_interrupted"); assert.deepEqual(f.engine.calls, []);
  assert.equal(JSON.parse(f.store.db.prepare("SELECT data FROM transcripts WHERE id=?").get(run.id).data).state, "running");
  await response(await f.json(`/api/transcripts/${run.id}/cancel`, { context: f.context }), 409, "transcription_conflict");
  const retry = await transcribed(f, a); assert.notEqual(retry.id, run.id);
});

test("includeTranscript defaults false; UI booleans are accepted and non-booleans rejected on runs and grants", async t => {
  const f = await fixture(t), a = await imported(f);
  assert.equal(aiRequestSchema.parse(request(f, a)).includeTranscript, false);
  assert.equal(aiRequestSchema.parse(request(f, a, { includeTranscript: true })).includeTranscript, true);
  for (const includeTranscript of [null, "true", "false", 0, 1, {}, []]) {
    await response(await f.json("/api/ai/runs", request(f, a, { includeTranscript })), 400, "invalid_input");
    await response(await f.json("/api/ai/grants", { ...scope(f, a), includeMemory: false, includeTranscript }), 400, "invalid_input");
  }
  for (const extra of [{}, { includeTranscript: false }]) {
    assert.equal((await ready(f, a, extra)).includeTranscript, false);
    assert.equal(JSON.parse(f.bridge.calls.at(-1).prompt).transcript, null);
    const grant = await mint(f, a, extra);
    assert.deepEqual(grant.tools, BASE_TOOLS);
    assert.equal((await response(await f.call("/api/mcp/capabilities", {}, grant.token), 200)).includeTranscript, false);
    await response(await mcp(f, grant, "transcript_read"), 403, "mcp_tool_forbidden");
  }
  await transcribed(f, a);
  assert.equal((await ready(f, a, { includeTranscript: true })).includeTranscript, true);
  assert.deepEqual(JSON.parse(f.bridge.calls.at(-1).prompt).transcript.segments, RESULT.segments);
  assert.ok((await mint(f, a, { includeTranscript: true })).tools.includes("transcript_read"));
});

for (const bound of ["segment count", "text length"]) {
  test(`AI transcript opt-in is scoped, timestamped, redacted and bounded by ${bound} with truncation metadata`, async t => {
    const f = await fixture(t), a = await imported(f);
    const distractors = [[await imported(f), f.context, "OTHER_SOURCE_SPEECH"],
      [await imported(f, f.sibling), f.sibling, "SIBLING_SPEECH"], [await imported(f, f.other), f.other, "OTHER_ACCOUNT_SPEECH"]];
    for (const [artifact, context, text] of distractors) {
      await transcribed(f, artifact, { ...RESULT, segments: [{ start: 0, end: 1, text }] }, context);
    }
    const segments = Array.from({ length: 205 }, (_, n) => ({ start: n / 100, end: (n + 1) / 100,
      text: n === 0 ? "SCOPED_SPEECH Bearer synthetic-prompt-secret" : `${n}:${"x".repeat(bound === "text length" ? 180 : 4)}` }));
    const saved = await transcribed(f, a, { ...RESULT, segments });
    f.store.setContext(f.other);
    for (const extra of [{}, { includeTranscript: false }]) {
      await ready(f, a, extra);
      const raw = f.bridge.calls.at(-1).prompt;
      assert.equal(JSON.parse(raw).transcript, null);
      privateResult(raw, ["SCOPED_SPEECH", "OTHER_SOURCE_SPEECH", "SIBLING_SPEECH", "OTHER_ACCOUNT_SPEECH"]);
    }
    await ready(f, a, { includeTranscript: true });
    const raw = f.bridge.calls.at(-1).prompt, prepared = JSON.parse(raw).transcript;
    assert.equal(prepared.language, "en"); assert.equal(prepared.duration, 4); assert.equal(prepared.sourceSha256, SHA);
    assert.equal(prepared.truncated, true); assert.ok(prepared.segments.length <= 150);
    const textLength = prepared.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    assert.ok(textLength <= 16_000);
    if (bound === "segment count") assert.equal(prepared.segments.length, 150);
    else assert.equal(textLength, 16_000);
    assert.match(prepared.segments[0].text, /SCOPED_SPEECH Bearer \[REDACTED\]/u);
    for (const [n, segment] of prepared.segments.entries()) {
      assert.equal(segment.start, segments[n].start); assert.equal(segment.end, segments[n].end);
      assert.ok(saved.segments[n].text.startsWith(segment.text));
    }
    privateResult(raw, ["synthetic-prompt-secret", "OTHER_SOURCE_SPEECH", "SIBLING_SPEECH", "OTHER_ACCOUNT_SPEECH",
      f.directory, f.api.token, f.connection.credentialRef, f.other.accountId, ...distractors.map(([artifact]) => artifact.id)]);
    assert.deepEqual(f.store.studio.timeline(a.id, f.context), { revision: 0, cursor: -1, edits: [] });
    assert.deepEqual(f.store.listMemory(f.context), []);
  });
}

test("explicit AI transcript inclusion requires succeeded work and current metadata AND managed-byte hashes", async t => {
  const f = await fixture(t), a = await imported(f);
  const include = () => f.json("/api/ai/runs", request(f, a, { includeTranscript: true }));
  await response(await include(), 409, "transcript_not_ready");
  const release = blocking(f), run = await start(f, a);
  await response(await include(), 409, "transcript_not_ready");
  release.resolve(); await done(f, run);
  const changed = Buffer.concat([WEBM, Buffer.from("source revision")]);
  await writeFile(sourcePath(f, a), changed);
  await response(await include(), 409, "media_source_changed");
  patchArtifact(f, a, { sha256: hash(changed), bytes: changed.length });
  await response(await include(), 409, "transcript_not_ready");
  assert.deepEqual(f.bridge.calls, []); assert.deepEqual(f.store.studio.aiRuns(a.id, f.context), []);
  await ready(f, a, { includeTranscript: false });
  assert.equal(JSON.parse(f.bridge.calls[0].prompt).transcript, null);
});

test("three transcript-enabled AI requests paused in real byte verification launch only two jobs", { timeout: 15_000 }, async t => {
  const f = await fixture(t), artifacts = [];
  for (let n = 0; n < 3; n++) { const a = await imported(f); await transcribed(f, a); artifacts.push(a); }
  const verifying = gate(), releaseVerify = gate(), releaseBridge = gate(), verified = [];
  f.releases.push(releaseVerify.resolve, releaseBridge.resolve);
  const verify = MediaEngine.prototype.verify;
  t.mock.method(MediaEngine.prototype, "verify", async function (...args) {
    const valid = await verify.apply(this, args);
    verified.push(args[0]);
    if (verified.length === 3) verifying.resolve();
    await releaseVerify.promise; return valid;
  });
  const propose = f.bridge.propose.bind(f.bridge);
  f.bridge.propose = async (...args) => {
    const proposal = await propose(...args);
    await releaseBridge.promise; return proposal;
  };
  const pending = artifacts.map(a => f.json("/api/ai/runs", request(f, a, { includeTranscript: true })));
  await verifying.promise;
  assert.deepEqual(new Set(verified), new Set(artifacts.map(a => a.id)));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM ai_runs").get().n, 0);
  assert.deepEqual(f.bridge.calls, []);
  releaseVerify.resolve();
  const replies = await Promise.all(pending), runs = [];
  assert.deepEqual(replies.map(reply => reply.status).sort(), [202, 202, 409]);
  for (const reply of replies) {
    if (reply.status === 202) runs.push(await response(reply, 202));
    else await response(reply, 409, "ai_busy");
  }
  await until(() => f.bridge.calls.length === 2);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM ai_runs").get().n, 2);
  assert.equal(new Set(runs.map(run => run.artifactId)).size, 2);
  for (const call of f.bridge.calls) assert.deepEqual(JSON.parse(call.prompt).transcript.segments, RESULT.segments);
  releaseBridge.resolve();
  for (const run of runs) {
    const saved = await until(() => f.store.studio.aiRun(run.id, f.context), value => value.state !== "running");
    assert.equal(saved.state, "ready");
  }
  assert.equal(f.bridge.calls.length, 2);
});

test("official MCP SDK uses fixed grants, hides speech in job/status, paginates opt-in reads and fences cancellation IDs", { timeout: 30_000 }, async t => {
  const f = await fixture(t), a = await imported(f), other = await imported(f, f.other);
  const without = await mint(f, a), grant = await mint(f, a, { includeTranscript: true });
  assert.notEqual(grant.token, f.api.token);
  const hidden = await sdkClient(f, without), client = await sdkClient(f, grant);
  assert.deepEqual((await hidden.listTools()).tools.map(tool => tool.name), BASE_TOOLS);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === "transcript_read"));
  await sdkError(hidden, "transcript_read", {}, "mcp_tool_unavailable");
  await response(await f.call("/api/mcp/capabilities"), 401, "mcp_grant_invalid");
  await response(await f.json("/api/mcp/call", { tool: "transcript_status", arguments: {} }), 401, "mcp_grant_invalid");
  await response(await f.call(transcriptRoute(a, f.context), {}, grant.token), 401, "unauthorized");
  f.store.setContext(f.other);
  assert.equal((await sdkTool(client, "media_inspect")).id, a.id);
  assert.equal(await sdkTool(client, "transcript_status"), null);
  for (const [tool, args] of [["media_transcribe", {}], ["transcript_status", {}], ["transcript_read", {}],
    ["transcript_cancel", { transcriptId: randomUUID() }]]) {
    for (const [key, value] of Object.entries({ context: f.other, accountId: f.other.accountId,
      projectId: f.sibling.projectId, artifactId: other.id, destinationId: "other", path: "C:\\private\\audio.wav" })) {
      await response(await mcp(f, grant, tool, { ...args, [key]: value }), 400, "invalid_input");
    }
    await sdkError(client, tool, { ...args, context: f.other }, "mcp_invalid_arguments");
  }
  const release = blocking(f);
  f.engine.result = { ...RESULT, segments: Array.from({ length: 205 }, (_, n) => ({ start: n / 100, end: (n + 1) / 100, text: `PAGINATED_SPEECH_${n}` })) };
  const run = await sdkTool(client, "media_transcribe");
  assert.equal(run.artifactId, a.id); assert.equal(run.accountId, f.context.accountId); assert.deepEqual(run.segments, []);
  await until(() => f.engine.calls.length);
  assert.deepEqual((await sdkTool(hidden, "transcript_status")).segments, []);
  await response(await mcp(f, without, "transcript_cancel", { transcriptId: run.id }), 403, "mcp_scope_forbidden");
  await response(await mcp(f, grant, "transcript_cancel", { transcriptId: randomUUID() }), 403, "mcp_scope_forbidden");
  release.resolve(); const saved = await done(f, run);
  for (const sdk of [client, hidden]) {
    const status = await sdkTool(sdk, "transcript_status");
    assert.equal(status.state, "succeeded"); assert.deepEqual(status.segments, []);
    privateResult(status, ["PAGINATED_SPEECH", grant.token, without.token, f.api.token, f.directory]);
  }
  const first = await sdkTool(client, "transcript_read");
  assert.deepEqual(first.segments, saved.segments.slice(0, 100)); assert.equal(first.nextOffset, 100);
  const second = await sdkTool(client, "transcript_read", { offset: first.nextOffset });
  assert.deepEqual(second.segments, saved.segments.slice(100, 200)); assert.equal(second.nextOffset, 200);
  const last = await sdkTool(client, "transcript_read", { offset: second.nextOffset, limit: 100 });
  assert.deepEqual(last.segments, saved.segments.slice(200)); assert.equal(last.nextOffset, null);
  assert.deepEqual((await sdkTool(client, "transcript_read", { offset: 7, limit: 2 })).segments, saved.segments.slice(7, 9));
  const empty = await sdkTool(client, "transcript_read", { offset: 999 });
  assert.deepEqual(empty.segments, []); assert.equal(empty.nextOffset, null);
  for (const args of [{ limit: 101 }, { limit: 0 }, { limit: "100" }, { offset: -1 }, { offset: .5 }, { offset: 10001 }]) {
    await sdkError(client, "transcript_read", args, "mcp_invalid_arguments");
    await response(await mcp(f, grant, "transcript_read", args), 400, "invalid_input");
  }
  // The default grant may request work but still never receives its speech.
  const stop = blocking(f), next = await sdkTool(hidden, "media_transcribe");
  assert.deepEqual(next.segments, []); assert.notEqual(next.id, run.id);
  await until(() => f.engine.calls.length === 2);
  await response(await mcp(f, grant, "transcript_cancel", { transcriptId: next.id }), 403, "mcp_scope_forbidden");
  const cancelling = sdkTool(hidden, "transcript_cancel", { transcriptId: next.id });
  await until(() => f.engine.calls[1].signal.aborted);
  assert.equal((await response(await f.call(transcriptRoute(a, f.context)), 200)).cancelRequested, true);
  stop.resolve(); const cancelled = await cancelling;
  assert.equal(cancelled.state, "cancelled"); assert.deepEqual(cancelled.segments, []);
  await response(await mcp(f, grant, "transcript_read"), 409, "transcript_not_ready");
  assert.equal(f.store.transcripts.latest(other.id, f.other), null);
  assert.deepEqual(f.bridge.calls, []);
  await response(await f.json("/api/ai/grants/revoke", { context: f.context, token: grant.token }), 200);
  await sdkError(client, "transcript_status", {}, "mcp_grant_rejected");
});

test("MCP transcript reads reject a changed source hash; expiry, revocation and restart invalidate grants", async t => {
  const f = await fixture(t), a = await imported(f); await transcribed(f, a);
  const grant = await mint(f, a, { includeTranscript: true });
  const changed = Buffer.concat([WEBM, Buffer.from("new source")]);
  await writeFile(sourcePath(f, a), changed); patchArtifact(f, a, { sha256: hash(changed), bytes: changed.length });
  await response(await mcp(f, grant, "transcript_read"), 409, "transcript_not_ready");
  // Even completed status is deliberately content-free when a source has drifted.
  assert.deepEqual((await response(await mcp(f, grant, "transcript_status"), 200)).segments, []);
  await response(await f.json("/api/ai/grants/revoke", { context: f.other, token: grant.token }), 404, "mcp_grant_not_found");
  await response(await f.json("/api/ai/grants/revoke", { context: f.context, token: grant.token }), 200);
  await response(await mcp(f, grant, "transcript_status"), 401, "mcp_grant_invalid");
  const expired = await mint(f, a);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    t.mock.timers.tick(30 * 60_000);
    await response(await mcp(f, expired, "transcript_status"), 401, "mcp_grant_invalid");
  } finally { t.mock.timers.reset(); }
  const prior = await mint(f, a); await f.restart();
  await response(await mcp(f, prior, "transcript_status"), 401, "mcp_grant_invalid");
});

test("MCP opt-in transcript_read verifies managed bytes as well as the stored source hash", async t => {
  const f = await fixture(t), a = await imported(f); await transcribed(f, a);
  const grant = await mint(f, a, { includeTranscript: true });
  await writeFile(sourcePath(f, a), Buffer.concat([WEBM, Buffer.from("unregistered byte drift")]));
  await response(await f.json("/api/ai/runs", request(f, a, { includeTranscript: true })), 409, "media_source_changed");
  await response(await mcp(f, grant, "transcript_read"), 409, "media_source_changed");
});

for (const drift of ["metadata hash", "revoked grant", "expired grant"]) {
  test(`MCP transcript_read returns no speech when ${drift} changes during byte verification`, { timeout: 10_000 }, async t => {
    const f = await fixture(t), a = await imported(f); await transcribed(f, a);
    const grant = await mint(f, a, { includeTranscript: true }), entered = gate(), release = gate();
    f.releases.push(release.resolve);
    const verify = MediaEngine.prototype.verify;
    t.mock.method(MediaEngine.prototype, "verify", async function (...args) {
      const valid = await verify.apply(this, args);
      assert.equal(valid, true); assert.equal(args[0], a.id); assert.equal(args[1], SHA);
      entered.resolve(); await release.promise; return valid;
    });
    const pending = mcp(f, grant, "transcript_read");
    await entered.promise;
    try {
      if (drift === "metadata hash") patchArtifact(f, a, { sha256: "a".repeat(64) });
      else if (drift === "revoked grant") {
        await response(await f.json("/api/ai/grants/revoke", { context: f.context, token: grant.token }), 200);
      } else {
        t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
        t.mock.timers.tick(30 * 60_000);
      }
      release.resolve();
      const error = await response(await pending, drift === "metadata hash" ? 409 : 401,
        drift === "metadata hash" ? "media_source_changed" : "mcp_grant_invalid");
      privateResult(error, ["SCOPED_SPEECH", grant.token, f.directory]);
      assert.deepEqual(f.store.transcripts.latest(a.id, f.context).segments, RESULT.segments, "Read rejection never mutates saved speech");
    } finally { release.resolve(); if (drift === "expired grant") t.mock.timers.reset(); }
  });
}

test("HTTP local OAuth client config uses only a fake vault, never returns credentials and is loaded before restart responds", async t => {
  // Independent of youtube-setup.test.mjs/provider fixtures and all real app config.
  const f = await fixture(t);
  const client = { clientId: "synthetic-http-desktop.apps.googleusercontent.com", clientSecret: "GOCSPX-synthetic-http-secret" };
  const unconfigured = { configured: false, available: false, configuredSource: "none", scopes: YOUTUBE_SCOPES };
  assert.deepEqual(await response(await f.call("/api/youtube"), 200), unconfigured);
  await response(await f.json("/api/youtube/config", client, "invalid-session"), 401, "unauthorized");
  assert.equal(f.secrets.size, 0); assert.equal(f.vaultCalls.filter(([op]) => op === "set").length, 0);
  const configured = { configured: true, available: true, configuredSource: "local", scopes: YOUTUBE_SCOPES };
  const saved = await response(await f.json("/api/youtube/config", client), 200);
  assert.deepEqual(saved, configured); privateResult(saved, Object.values(client));
  assert.equal(f.secrets.size, 1);
  const [[ref, stored]] = f.secrets;
  assert.match(ref, /^account:[0-9a-f-]{36}$/u); assert.deepEqual(JSON.parse(stored), client);
  assert.deepEqual(await response(await f.call("/api/youtube"), 200), configured);
  await f.restart();
  const immediate = await response(await f.call("/api/youtube"), 200);
  assert.deepEqual(immediate, configured); privateResult(immediate, [...Object.values(client), ref]);
  await response(await f.json("/api/youtube/config", { ...client, refreshToken: "synthetic-not-allowed" }), 400, "invalid_input");
  assert.equal(f.vaultCalls.filter(([op]) => op === "set").length, 1);
  assert.deepEqual(f.bridge.calls, []); assert.deepEqual(f.engine.calls, []);
});

test("frozen v4 to v5 migration preserves old ai_runs and cancel flags and attaches the real transcript store", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-transcript-v4-")), path = join(directory, "workspace.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  try {
    db.exec((await readFile(new URL("./fixtures/workspace-v1.sql", import.meta.url), "utf8"))
      .replace("CHECK(status='demo')", "CHECK(status IN ('demo','connected','reauth-required','disconnected'))"));
    // Frozen pre-transcript tables: do not manufacture v4 using the migration being tested.
    db.exec(`CREATE TABLE youtube_connections(account_id TEXT PRIMARY KEY REFERENCES accounts(id),provider_subject_id TEXT NOT NULL,
      destination_id TEXT NOT NULL UNIQUE,credential_ref TEXT UNIQUE,granted_scopes TEXT NOT NULL,verified_at TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
      CREATE TABLE artifacts(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),project_id TEXT NOT NULL,data TEXT NOT NULL,
        UNIQUE(id,account_id,project_id),FOREIGN KEY(project_id,account_id) REFERENCES projects(id,account_id)) STRICT;
      CREATE TABLE timelines(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),data TEXT NOT NULL) STRICT;
      CREATE TABLE publications(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),project_id TEXT NOT NULL,artifact_id TEXT NOT NULL,
        data TEXT NOT NULL,session_ref TEXT,owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,dispatch_revoked INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_revoked IN (0,1)),
        FOREIGN KEY(artifact_id,account_id,project_id) REFERENCES artifacts(id,account_id,project_id)) STRICT;
      CREATE INDEX publications_scope ON publications(account_id,project_id);
      CREATE TABLE renders(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,project_id TEXT NOT NULL,source_id TEXT NOT NULL,data TEXT NOT NULL,owner TEXT NOT NULL,lease_until INTEGER NOT NULL,
        FOREIGN KEY(source_id,account_id,project_id) REFERENCES artifacts(id,account_id,project_id)) STRICT;
      CREATE TABLE ai_runs(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,project_id TEXT NOT NULL,artifact_id TEXT NOT NULL,data TEXT NOT NULL,
        owner TEXT NOT NULL,lease_until INTEGER NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
        FOREIGN KEY(artifact_id,account_id,project_id) REFERENCES artifacts(id,account_id,project_id)) STRICT;
      CREATE INDEX ai_runs_scope ON ai_runs(account_id,project_id,artifact_id); PRAGMA user_version=4;`);
    const context = { accountId: randomUUID(), projectId: randomUUID() }, id = randomUUID(), at = "2026-10-01T00:00:00.000Z";
    db.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)").run(context.accountId, "Old account", "youtube", "old-destination", "demo", at);
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?)").run(context.projectId, context.accountId, "Old project", "Preserved", at);
    const a = { id, ...context, filename: "old.webm", sha256: SHA, bytes: WEBM.length, mimeType: "video/webm", probe: PROBE,
      sourceId: null, channelVideoId: null, createdAt: at };
    db.prepare("INSERT INTO artifacts VALUES(?,?,?,?)").run(id, context.accountId, context.projectId, JSON.stringify(a));
    db.prepare("INSERT INTO timelines VALUES(?,?)").run(id, JSON.stringify({ revision: 3, cursor: 0, edits: [EDIT] }));
    for (const [state, cancel] of [["ready", 0], ["running", 1]]) {
      const run = { id: randomUUID(), context, artifactId: id, destinationId: "old-destination", sourceSha256: SHA,
        baseRevision: 3, model: MODEL, prompt: "Old prompt", includeMemory: false, state, summary: state === "ready" ? "Old proposal" : null,
        edit: state === "ready" ? EDIT : null, error: null, events: [], createdAt: at, sessionId: null, previewRenderId: null };
      db.prepare("INSERT INTO ai_runs VALUES(?,?,?,?,?,?,?,?)").run(run.id, context.accountId, context.projectId, id,
        JSON.stringify(run), "legacy-owner", state === "running" ? Date.now() + 300_000 : 0, cancel);
    }
    const tables = ["accounts", "projects", "artifacts", "timelines", "ai_runs"];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    db.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new WorkspaceStore(path);
      try {
        assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 10);
        assert.equal(store.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
        assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
        assert.deepEqual(tables.map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
        assert.ok(store.transcripts); assert.equal(store.transcripts.latest(id, context), null);
        assert.equal(store.studio.aiRuns(id, context).find(run => run.state === "running").cancelRequested, true);
        for (const table of ["ai_runs", "transcripts"]) {
          const cancel = store.db.prepare(`PRAGMA table_info(${table})`).all().find(column => column.name === "cancel_requested");
          assert.equal(cancel.notnull, 1); assert.equal(cancel.dflt_value, "0");
        }
        assert.throws(() => store.db.prepare("INSERT INTO transcripts VALUES(?,?,?,?,?,?,?,?)")
          .run(randomUUID(), context.accountId, context.projectId, randomUUID(), "{}", "owner", 1, 0), /FOREIGN KEY/u);
      } finally { store.close(); }
    }
  } finally { if (db.isOpen) db.close(); }
});
