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
import { aiProposalSchema, aiRequestSchema, aiScopeSchema } from "../dist/packages/domain/src/ai.js";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
import { AiService } from "../dist/services/local-api/src/ai.js";
import { startApi } from "../dist/services/local-api/src/server.js";
import { StudioService } from "../dist/services/local-api/src/studio.js";
import { YouTubeProvider } from "../dist/services/local-api/src/youtube-provider.js";
import { YouTubePublishing } from "../dist/services/local-api/src/youtube-publishing.js";

// Read the embedded real container without importing (and running) another suite.
const mediaTests = await readFile(new URL("./media-engine.test.mjs", import.meta.url), "utf8");
const embedded = /const WEBM = Buffer\.from\("([A-Za-z0-9+/=]+)", "base64"\);/u.exec(mediaTests);
assert.ok(embedded, "media-engine.test.mjs must contain its small real WebM fixture");
const WEBM = Buffer.from(embedded[1], "base64");
const SHA = createHash("sha256").update(WEBM).digest("hex");
const MODEL = "controlled/local-model";
const PROBE = { duration: 4, width: 320, height: 240, hasAudio: false };
const EDIT = { inSeconds: 0, outSeconds: 4, crop: "original", gainDb: 0, caption: "",
  segments: [{ inSeconds: 0, outSeconds: 1 }, { inSeconds: 3, outSeconds: 4 }] };
const PUBLICATION = { title: "Human review only", description: "Local controlled test", visibility: "private",
  madeForKids: false, notifySubscribers: false };
const TOOLS = ["media_inspect", "timeline_read", "media_transcribe", "transcript_status", "transcript_cancel", "timeline_propose", "render_preview", "render_status", "publication_request"];
const gate = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

class ControlledBridge {
  discoveries = 0;
  calls = [];
  setup = { available: true, version: "controlled-test", models: [MODEL], auth: "cli-managed", error: null };
  async discover(signal) { signal.throwIfAborted(); this.discoveries++; return this.setup; }
  async propose(input, event, signal) {
    const call = { ...input, event, signal };
    this.calls.push(call);
    event({ type: "started", message: "controlled" });
    if (this.handler) return this.handler(call);
    event({ type: "activity", message: "controlled" });
    return { summary: "Keep the opening and closing source ranges", edit: structuredClone(EDIT), sessionId: "controlled-session" };
  }
}

// Real child lifecycle through MediaEngine's trusted process port. The source is
// real WebM; encoded bytes/probe responses are explicitly synthetic, not FFmpeg
// verification. No CLI discovery, model inference, provider or vault is used.
function controlledTools(records) {
  return { ffmpegPath: "controlled-ffmpeg", ffprobePath: "controlled-ffprobe", spawn(tool, args, options) {
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.ok(Object.keys(options.env).every(key => /^(path|systemroot|temp|tmp|tmpdir)$/iu.test(key)));
    const kind = tool === "controlled-ffmpeg" ? "ffmpeg" : "ffprobe";
    assert.ok(["controlled-ffmpeg", "controlled-ffprobe"].includes(tool));
    let script;
    if (args.includes("-version")) script = `console.log('${kind} version controlled');`;
    else if (kind === "ffprobe") script = `
      const fs=require('node:fs'); const file=${JSON.stringify(args.at(-1))};
      const p=fs.existsSync(file+'.json')?JSON.parse(fs.readFileSync(file+'.json','utf8')):${JSON.stringify(PROBE)};
      console.log(JSON.stringify({format:{duration:String(p.duration)},streams:[{codec_type:'video',codec_name:'h264',pix_fmt:'yuv420p',width:p.width,height:p.height}]}));`;
    else {
      const filter = args[args.indexOf("-vf") + 1] ?? "";
      const dimensions = /(?:scale|crop)=(\d+):(\d+)/u.exec(filter);
      const probe = { ...PROBE, duration: args.includes("-t") ? Number(args[args.indexOf("-t") + 1]) : 4,
        width: dimensions ? Number(dimensions[1]) : PROBE.width, height: dimensions ? Number(dimensions[2]) : PROBE.height };
      script = `
        const fs=require('node:fs'); const output=${JSON.stringify(args.at(-1))};
        function box(type,body){const h=Buffer.alloc(8);h.writeUInt32BE(body.length+8);h.write(type,4);return Buffer.concat([h,body]);}
        const bytes=Buffer.concat([box('ftyp',Buffer.from('isom\\0\\0\\0\\0isom')),box('moov',box('trak',Buffer.alloc(0))),box('mdat',Buffer.from('controlled-output'))]);
        fs.writeFileSync(output,bytes,{flag:'wx'});fs.writeFileSync(output+'.json',${JSON.stringify(JSON.stringify(probe))});
        console.log('out_time_us=1000000');`;
    }
    const child = spawn(process.execPath, ["-e", script], options);
    records.push({ kind, args, child });
    return child;
  } };
}

function connect(store, letter) {
  const accountId = randomUUID(), destinationId = `UC${letter.repeat(22)}`;
  const connection = store.connectYouTube({ accountId, destinationId, displayName: `Channel ${letter}`,
    providerSubjectId: `controlled-subject-${letter}`, credentialRef: `account:${randomUUID()}`,
    grantedScopes: ["openid", "https://www.googleapis.com/auth/youtube.upload"], expectedRevision: null });
  const project = store.createProject({ accountId, name: `Project ${letter}`, description: "" });
  return { context: { accountId, projectId: project.id }, destinationId, connection };
}

async function fixture(t, { tools = false, engine: engineOptions, bridge = new ControlledBridge() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-ai-")), path = join(directory, "atris-share.sqlite");
  const store = new WorkspaceStore(path), first = connect(store, "A"), other = connect(store, "B");
  const sibling = { accountId: first.context.accountId,
    projectId: store.createProject({ accountId: first.context.accountId, name: "Sibling", description: "" }).id };
  const children = [], cleanup = [];
  const engine = engineOptions ?? (tools ? controlledTools(children) : { ffmpegPath: join(directory, "absent-ffmpeg"), ffprobePath: join(directory, "absent-ffprobe") });
  const forbidden = async () => { assert.fail("Remote provider/vault effects are forbidden in AI integration tests"); };
  const options = { dataDirectory: directory, studio: { engine, publisher: new YouTubePublishing(forbidden) }, ai: { bridge },
    credentialVault: { status: { available: false, provider: "unavailable" }, get: forbidden, set: forbidden, delete: forbidden },
    youtube: { client: null, provider: new YouTubeProvider(forbidden), openBrowser: forbidden } };
  let api = await startApi(options);
  t.after(async () => {
    try {
      for (const close of cleanup.reverse()) await close();
      await api.close();
      for (const { child } of children) assert.ok(child.exitCode !== null || child.signalCode !== null, "owned media child must be reaped");
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  });
  const f = { directory, path, store, bridge, children, cleanup, ...first, other: other.context, sibling,
    get api() { return api; },
    async restart() { await api.close(); api = await startApi(options); },
    call(route, init = {}, token = api.token) {
      return fetch(`${api.origin}${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
    },
    json(route, value, method = "POST", token = api.token) {
      return this.call(route, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }, token);
    }
  };
  return f;
}

async function response(response, status, code) {
  const text = await response.text();
  assert.equal(response.status, status, `${response.url}: ${text}`);
  const value = JSON.parse(text);
  if (code) assert.deepEqual(value, { error: code });
  return value;
}
const query = context => new URLSearchParams(context);
const scope = (f, a) => ({ context: f.context, destinationId: f.destinationId, artifactId: a.id });
const request = (f, a, extra = {}) => ({ ...scope(f, a), model: MODEL, prompt: "Keep the opening and closing", includeMemory: false, allowRemote: true, ...extra });
const timeline = (f, a) => f.store.studio.timeline(a.id, f.context);
const review = (f, run, action, context = f.context) => f.json(`/api/ai/runs/${run.id}/${action}`, { context });
const mcp = (f, grant, tool, args = {}) => f.json("/api/mcp/call", { tool, arguments: args }, "POST", grant.token);
const mint = async (f, a, includeMemory = false) => response(await f.json("/api/ai/grants", { ...scope(f, a), includeMemory }), 201);

async function sdkClient(f, grant) {
  const entry = fileURLToPath(new URL("../dist/services/mcp-server/src/index.js", import.meta.url));
  assert.deepEqual(grant.command, { command: process.execPath, args: [entry] });
  const transport = new StdioClientTransport({ ...grant.command, stderr: "pipe",
    env: { ATRIS_SHARE_MCP_ORIGIN: grant.origin, ATRIS_SHARE_MCP_GRANT: grant.token,
      ATRIS_SHARE_API_TOKEN: "unused-regular-session-sentinel" } });
  const client = new Client({ name: "atris-share-ai-integration", version: "1.0.0" });
  let stderr = "";
  const errors = [];
  transport.stderr.on("data", chunk => { stderr += chunk; });
  client.onerror = error => errors.push(error.message);
  f.cleanup.push(async () => {
    const pid = transport.pid;
    await client.close();
    if (pid !== null) await until(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, Boolean, "owned SDK stdio child exit");
    assert.equal(stderr, "", "stdio server must not log credentials or private responses");
    assert.deepEqual(errors, [], "the actual server must emit valid MCP protocol messages");
  });
  await client.connect(transport);
  return client;
}

async function sdkTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

async function sdkError(client, name, args, code) {
  assert.deepEqual(await client.callTool({ name, arguments: args }),
    { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code }) }] });
}

async function imported(f, context = f.context) {
  const a = await response(await f.call(`/api/media/import?${new URLSearchParams({ ...context, filename: "source.webm" })}`,
    { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: WEBM }), 201);
  assert.equal(a.sha256, SHA); assert.equal(a.bytes, WEBM.length); assert.equal(a.mimeType, "video/webm");
  assert.deepEqual(await readFile(join(f.directory, "media", `${a.id}.mp4`)), WEBM);
  // Independent SQL probe fixture when ffprobe is intentionally absent. Never
  // claim these duration/dimensions were measured from the tiny real container.
  if (!a.probe) {
    a.probe = structuredClone(PROBE);
    f.store.db.prepare("UPDATE artifacts SET data=? WHERE id=?").run(JSON.stringify(a), a.id);
  }
  return a;
}

async function until(read, predicate, label) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}
async function ready(f, a, extra = {}) {
  const run = await response(await f.json("/api/ai/runs", request(f, a, extra)), 202);
  const result = await until(() => f.store.studio.aiRun(run.id, f.context), run => run.state !== "running", "AI proposal");
  assert.equal(result.state, "ready", JSON.stringify(result));
  return result;
}

test("timed speech captions cannot bypass transcript consent through current timeline or MCP reads", async t => {
  const f = await fixture(t), a = await imported(f);
  f.store.studio.edit(a.id, f.context, 0, { ...EDIT, cropX: .8, timedCaptions: [{ start: 0, end: 1, text: "SPEECH_LOCAL_ONLY" }] });
  await ready(f, a);
  assert.ok(!f.bridge.calls[0].prompt.includes("SPEECH_LOCAL_ONLY"));
  const prepared = JSON.parse(f.bridge.calls[0].prompt);
  assert.equal(prepared.context.timedCaptionCount, 1); assert.equal(prepared.context.currentEdit.cropX, .8);
  const grant = await mint(f, a), read = await response(await mcp(f, grant, "timeline_read"), 200);
  assert.equal(read.timedCaptionsOmitted, true); assert.ok(!JSON.stringify(read).includes("SPEECH_LOCAL_ONLY"));
  f.bridge.handler = async () => ({ summary: "Controlled cues", edit: { ...EDIT, timedCaptions: [{ start: 0, end: 1, text: "api_key=controlled_secret_value" }] }, sessionId: "controlled" });
  const next = await ready(f, a); assert.equal(next.edit.timedCaptions[0].text, "api_key=[REDACTED]");
});
const renderDone = (f, id) => until(() => f.store.studio.render(id, f.context), value => value.state !== "running", "render completion");
function patchArtifact(f, a, changes) {
  f.store.db.prepare("UPDATE artifacts SET data=? WHERE id=?").run(JSON.stringify({ ...f.store.studio.artifact(a.id, f.context), ...changes }), a.id);
}
function notes(f) {
  for (const [context, text, reviewState] of [[f.context, "PROJECT_CONFIRMED", "confirmed"],
    [{ accountId: f.context.accountId, projectId: null }, "ACCOUNT_CONFIRMED", "confirmed"],
    [f.context, "SUGGESTED_PRIVATE", "suggested"], [f.sibling, "SIBLING_PRIVATE", "confirmed"], [f.other, "OTHER_ACCOUNT_PRIVATE", "confirmed"]]) {
    f.store.createMemory({ context, kind: "brand-voice", text, reviewState });
  }
}

test("AI domain contracts require explicit project/destination, remote consent and a strict bounded proposal", () => {
  const context = { accountId: randomUUID(), projectId: randomUUID() }, artifactId = randomUUID();
  const value = { context, artifactId, destinationId: "controlled-destination", model: MODEL, prompt: "Trim", includeMemory: false, allowRemote: true };
  assert.deepEqual(aiRequestSchema.parse(value), { ...value, includeTranscript: false });
  assert.equal(aiScopeSchema.safeParse({ context, artifactId, destinationId: value.destinationId }).success, true);
  for (const invalid of [{ ...value, context: undefined }, { ...value, context: { ...context, projectId: null } },
    { ...value, destinationId: undefined }, { ...value, allowRemote: false }, { ...value, allowRemote: undefined },
    { ...value, includeMemory: undefined }, { ...value, model: "not-qualified" }, { ...value, prompt: " " },
    { ...value, prompt: "x".repeat(4001) }, { ...value, path: "vault" }, { ...value, context: { ...context, destinationId: "smuggled" } }]) {
    assert.equal(aiRequestSchema.safeParse(invalid).success, false);
  }
  assert.equal(aiProposalSchema.safeParse({ summary: "Split", edit: EDIT }).success, true);
  for (const invalid of [{ summary: "", edit: EDIT }, { summary: "x".repeat(2001), edit: EDIT },
    { summary: "Split", edit: EDIT, accept: true }, { summary: "Split", edit: { ...EDIT, tool: "publish" } }]) {
    assert.equal(aiProposalSchema.safeParse(invalid).success, false);
  }
});

test("manual split HTTP saves validate ranges/schema, CAS, undo/redo and branching across reopen", async t => {
  const f = await fixture(t), a = await imported(f), route = `/api/media/${a.id}/timeline`;
  const save = (revision, edit, context = f.context) => f.json(route, { context, expectedRevision: revision, edit }, "PUT");
  const move = (direction, revision) => f.json(`${route}/${direction}`, { context: f.context, expectedRevision: revision });
  assert.deepEqual(await response(await save(0, EDIT), 200), { revision: 1, cursor: 0, edits: [EDIT] });
  const before = timeline(f, a), audit = f.store.listAudit(f.context);
  const invalid = [[], [{ inSeconds: 1, outSeconds: 1 }], [...EDIT.segments].reverse(),
    [{ inSeconds: 0, outSeconds: 2 }, { inSeconds: 1, outSeconds: 3 }], [{ inSeconds: 0, outSeconds: 5 }],
    [{ inSeconds: 0, outSeconds: 1, artifactId: randomUUID() }],
    Array.from({ length: 33 }, (_, i) => ({ inSeconds: i / 10, outSeconds: (i + 1) / 10 }))];
  for (const segments of invalid) await response(await save(1, { ...EDIT, segments }), 400, "invalid_input");
  await response(await save(1, { ...EDIT, outSeconds: 5, segments: [{ inSeconds: 0, outSeconds: 5 }] }), 400, "timeline_bounds");
  await response(await save(0, EDIT), 409, "revision_conflict");
  await response(await save(1, EDIT, f.other), 404, "artifact_not_found");
  assert.deepEqual(timeline(f, a), before); assert.deepEqual(f.store.listAudit(f.context), audit);
  const second = { ...EDIT, gainDb: -6 }, branch = { ...EDIT, crop: "square" };
  await response(await save(1, second), 200);
  await response(await move("undo", 2), 200);
  await response(await move("redo", 3), 200);
  await response(await move("undo", 4), 200);
  await response(await save(5, branch), 200);
  await response(await move("redo", 6), 409, "timeline_bounds");
  const expected = { revision: 6, cursor: 1, edits: [EDIT, branch] };
  await f.restart();
  assert.deepEqual(await response(await f.call(`${route}?${query(f.context)}`), 200), expected);
  assert.deepEqual(await readFile(join(f.directory, "media", `${a.id}.mp4`)), WEBM);
});

test("frozen v3 to v4 migration preserves artifacts, timeline, publications, renders, identity, memory and audit", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-ai-v3-")), path = join(directory, "workspace.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  // Frozen pre-AI schema, independent of the migration under test.
  db.exec((await readFile(new URL("./fixtures/workspace-v1.sql", import.meta.url), "utf8"))
    .replace("CHECK(status='demo')", "CHECK(status IN ('demo','connected','reauth-required','disconnected'))"));
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
      FOREIGN KEY(source_id,account_id,project_id) REFERENCES artifacts(id,account_id,project_id)) STRICT; PRAGMA user_version=3;`);
  const accountId = randomUUID(), projectId = randomUUID(), id = randomUUID(), memoryId = randomUUID(), destination = `UC${"A".repeat(22)}`;
  const context = { accountId, projectId }, stamp = "2026-10-01T00:00:00.000Z", credential = `account:${randomUUID()}`;
  db.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)").run(accountId, "Existing channel", "youtube", destination, "connected", stamp);
  db.prepare("INSERT INTO projects VALUES(?,?,?,?,?)").run(projectId, accountId, "Existing project", "Keep", stamp);
  db.prepare("INSERT INTO youtube_connections VALUES(?,?,?,?,?,?,?)").run(accountId, "existing-subject", destination, credential, '["openid"]', stamp, 8);
  const a = { id, ...context, filename: "legacy.webm", sha256: SHA, bytes: WEBM.length, mimeType: "video/webm", probe: PROBE,
    sourceId: null, channelVideoId: null, createdAt: stamp }; // v3 has no kind/proxy fields.
  db.prepare("INSERT INTO artifacts VALUES(?,?,?,?)").run(id, accountId, projectId, JSON.stringify(a));
  const history = { revision: 7, cursor: 0, edits: [{ ...EDIT, segments: undefined }] };
  db.prepare("INSERT INTO timelines VALUES(?,?)").run(id, JSON.stringify(history));
  db.prepare("INSERT INTO publications VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), accountId, projectId, id,
    JSON.stringify({ state: "uncertain", payload: { artifactId: id, sha256: SHA }, approvalExpiresAt: stamp }), credential, "legacy-owner", 42, 1);
  db.prepare("INSERT INTO renders VALUES(?,?,?,?,?,?,?)").run(randomUUID(), accountId, projectId, id,
    JSON.stringify({ sourceId: id, state: "succeeded", artifactId: id }), "legacy-render", 43);
  db.prepare("INSERT INTO memory VALUES(?,?,?,?,?,?,?,?,?,?)").run(memoryId, accountId, projectId, "decision", "Preserved", "confirmed", 3, randomUUID(), stamp, stamp);
  db.prepare("INSERT INTO context VALUES(1,?,?)").run(accountId, projectId);
  db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?)").run(randomUUID(), accountId, projectId, "memory.created", memoryId, "local-user", stamp);
  const tables = ["accounts", "projects", "youtube_connections", "artifacts", "timelines", "publications", "renders", "memory", "context", "audit"];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  db.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = new WorkspaceStore(path);
    try {
      assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 10);
      assert.equal(store.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.deepEqual(tables.map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
      assert.deepEqual(store.studio.artifact(id, context), a);
      assert.deepEqual(store.studio.timeline(id, context), JSON.parse(JSON.stringify(history)));
      assert.deepEqual(store.studio.aiRuns(id, context), []);
      assert.equal(store.getYouTubeConnection(accountId, destination).credentialRef, credential);
      const cancel = store.db.prepare("PRAGMA table_info(ai_runs)").all().find(column => column.name === "cancel_requested");
      assert.ok(cancel); assert.equal(cancel.notnull, 1); assert.equal(cancel.dflt_value, "0");
      assert.deepEqual(store.db.prepare("PRAGMA table_info(renders)").all().map(column => column.name),
        ["id", "account_id", "project_id", "source_id", "data", "owner", "lease_until"]);
      assert.throws(() => store.db.prepare("INSERT INTO ai_runs(id,account_id,project_id,artifact_id,data,owner,lease_until) VALUES(?,?,?,?,?,?,?)")
        .run(randomUUID(), accountId, projectId, randomUUID(), "{}", "invalid", 0), /FOREIGN KEY/u);
    } finally { store.close(); }
  }
});

test("actual proxy service uses a trusted child, binds source/hash, filters the library and forbids proxy publishing", async t => {
  const f = await fixture(t, { tools: true }), a = await imported(f);
  await response(await f.json(`/api/media/${a.id}/proxy`, { context: f.other }), 404, "artifact_not_found");
  const job = await response(await f.json(`/api/media/${a.id}/proxy`, { context: f.context }), 202);
  const render = await renderDone(f, job.id);
  assert.equal(render.state, "succeeded", JSON.stringify(render)); assert.equal(render.kind, "proxy");
  const proxy = f.store.studio.artifact(render.artifactId, f.context), source = f.store.studio.artifact(a.id, f.context);
  assert.equal(proxy.kind, "proxy"); assert.equal(proxy.sourceId, a.id); assert.equal(proxy.sourceSha256, SHA);
  assert.equal(source.proxyId, proxy.id); assert.equal(source.sha256, SHA);
  assert.deepEqual(proxy.probe, PROBE); assert.equal(proxy.mimeType, "video/mp4");
  const content = await f.call(`/api/media/${proxy.id}/content?${query(f.context)}`);
  const bytes = Buffer.from(await content.arrayBuffer());
  assert.equal(content.status, 200); assert.equal(proxy.bytes, bytes.length);
  assert.equal(proxy.sha256, createHash("sha256").update(bytes).digest("hex"));
  const snapshot = await response(await f.call(`/api/studio?${query(f.context)}`), 200);
  assert.deepEqual(snapshot.artifacts.map(value => value.id), [a.id]);
  assert.ok(snapshot.renders.some(value => value.id === job.id && value.artifactId === proxy.id));
  await response(await f.call(`/api/media/${proxy.id}/content?${query(f.other)}`), 404, "artifact_not_found");
  await response(await f.json("/api/publications", { context: f.context, artifactId: proxy.id, ...PUBLICATION }), 409, "media_proxy_not_publishable");
  await response(await f.json("/api/ai/runs", request(f, proxy)), 409, "ai_scope_mismatch");
  assert.throws(() => f.store.studio.attachProxy(a.id, f.context, proxy.id, "0".repeat(64)), /media_source_changed/u);
  const audit = f.store.listAudit(f.context);
  for (const changes of [{ sourceSha256: "0".repeat(64) }, { sourceId: randomUUID() }, { kind: "source" }, { kind: "preview" }]) {
    patchArtifact(f, proxy, { ...proxy, ...changes });
    assert.throws(() => f.store.studio.attachProxy(a.id, f.context, proxy.id, SHA), /media_source_changed/u);
    assert.deepEqual(f.store.studio.artifact(a.id, f.context), source);
    assert.deepEqual(f.store.listAudit(f.context), audit);
  }
  assert.throws(() => f.store.studio.attachProxy(a.id, f.other, proxy.id, SHA), /artifact_not_found/u);
  assert.equal(f.children.filter(value => value.kind === "ffmpeg" && !value.args.includes("-version")).length, 1);
  assert.deepEqual(await readFile(join(f.directory, "media", `${a.id}.mp4`)), WEBM);
  assert.deepEqual(f.store.listMemory(f.context), []); assert.deepEqual(f.store.studio.publications(f.context), []);
});

test("proxy source-byte tampering fails before encode and leaves no output artifact or temporary directory", async t => {
  const f = await fixture(t, { tools: true }), a = await imported(f);
  await writeFile(join(f.directory, "media", `${a.id}.mp4`), Buffer.concat([WEBM, Buffer.from("changed")]));
  const render = await response(await f.json(`/api/media/${a.id}/proxy`, { context: f.context }), 202);
  const result = await renderDone(f, render.id);
  assert.equal(result.state, "failed"); assert.equal(result.error, "media_source_changed"); assert.equal(result.artifactId, null);
  assert.equal(f.children.filter(value => value.kind === "ffmpeg" && !value.args.includes("-version")).length, 0);
  assert.deepEqual(f.store.studio.artifacts(f.context).map(value => value.id), [a.id]);
  assert.deepEqual(await readdir(join(f.directory, "media")), [`${a.id}.mp4`]);
  assert.ok(!(await readdir(f.directory)).some(name => /^\.(?:proxy|render|import)-/u.test(name)));
});

test("AI HTTP start requires explicit scope/consent and discovered model, without launching invalid requests", async t => {
  const f = await fixture(t), a = await imported(f), value = request(f, a);
  for (const changes of [{ context: undefined }, { context: { ...f.context, projectId: null } }, { destinationId: undefined },
    { allowRemote: undefined }, { allowRemote: false }, { includeMemory: undefined }, { artifactId: undefined }, { approve: true }]) {
    await response(await f.json("/api/ai/runs", { ...value, ...changes }), 400, "invalid_input");
  }
  await response(await f.json("/api/ai/runs", { ...value, context: f.other }), 409, "ai_scope_mismatch");
  await response(await f.json("/api/ai/runs", { ...value, context: f.sibling }), 404, "artifact_not_found");
  await response(await f.json("/api/ai/runs", { ...value, destinationId: "different-destination" }), 409, "ai_scope_mismatch");
  assert.equal(f.bridge.discoveries, 0); assert.equal(f.bridge.calls.length, 0);
  assert.equal((await response(await f.call("/api/ai/setup"), 200)).available, true);
  await response(await f.json("/api/ai/runs", { ...value, model: "controlled/not-discovered" }), 400, "ai_model_unavailable");
  assert.equal(f.bridge.discoveries, 1); assert.equal(f.bridge.calls.length, 0);
  assert.deepEqual(f.store.studio.aiRuns(a.id, f.context), []);
});

test("unavailable model discovery creates no run or inference task", async t => {
  const bridge = new ControlledBridge(); bridge.setup = { ...bridge.setup, available: false, models: [], error: "ai_unavailable" };
  const f = await fixture(t, { bridge }), a = await imported(f);
  await response(await f.json("/api/ai/runs", request(f, a)), 409, "ai_unavailable");
  assert.equal(bridge.calls.length, 0); assert.deepEqual(f.store.studio.aiRuns(a.id, f.context), []);
});

test("prompt is bounded metadata only; memory is opt-in, confirmed and account/project isolated", async t => {
  const f = await fixture(t), a = await imported(f); notes(f);
  f.store.setContext(f.other);
  const first = await ready(f, a), raw = f.bridge.calls[0].prompt, prompt = JSON.parse(raw);
  assert.deepEqual(prompt.confirmedNotes, []);
  assert.equal(prompt.context.artifactId, a.id); assert.equal(prompt.context.destinationId, f.destinationId);
  assert.equal(prompt.context.projectId, f.context.projectId); assert.equal(prompt.context.baseRevision, 0);
  assert.deepEqual(prompt.context.probe, PROBE);
  for (const secret of [f.api.token, f.connection.credentialRef, f.directory, "PROJECT_CONFIRMED", "ACCOUNT_CONFIRMED",
    "SUGGESTED_PRIVATE", "SIBLING_PRIVATE", "OTHER_ACCOUNT_PRIVATE", WEBM.toString("base64")]) assert.ok(!raw.includes(secret), secret);
  await response(await review(f, first, "reject"), 200);
  await ready(f, a, { includeMemory: true });
  const opted = JSON.parse(f.bridge.calls[1].prompt);
  assert.deepEqual(opted.confirmedNotes.map(value => value.text).sort(), ["ACCOUNT_CONFIRMED", "PROJECT_CONFIRMED"]);
  const exposed = JSON.stringify({ opted, runs: f.store.studio.aiRuns(a.id, f.context), audit: f.store.listAudit(f.context) });
  for (const secret of [f.api.token, f.connection.credentialRef, f.directory, "SUGGESTED_PRIVATE", "SIBLING_PRIVATE", "OTHER_ACCOUNT_PRIVATE"])
    assert.ok(!exposed.includes(secret), secret);
  assert.deepEqual(timeline(f, a), { revision: 0, cursor: -1, edits: [] });
  assert.equal(f.store.listMemory(f.context).length, 2, "AI proposals must not silently create memory");
});

test("saved timeline captions are redacted in the prepared bridge prompt even with memory disabled", async t => {
  const f = await fixture(t), a = await imported(f), secret = "synthetic-timeline-secret";
  const edit = { ...EDIT, caption: `Opening Bearer ${secret}; closing` };
  await response(await f.json(`/api/media/${a.id}/timeline`, { context: f.context, expectedRevision: 0, edit }, "PUT"), 200);
  const before = timeline(f, a), run = await ready(f, a, { includeMemory: false });
  assert.equal(run.includeMemory, false);
  const raw = f.bridge.calls[0].prompt, prepared = JSON.parse(raw);
  assert.equal(prepared.context.baseRevision, 1);
  assert.deepEqual(prepared.context.currentEdit, { ...edit, caption: "Opening Bearer [REDACTED]; closing" });
  assert.deepEqual(prepared.confirmedNotes, []);
  assert.ok(!raw.includes(secret), "saved caption credentials must not reach the bridge");
  assert.deepEqual(timeline(f, a), before, "preparing a prompt must preserve the saved human edit");
});

for (const transport of ["bridge", "MCP"]) {
  test(`${transport} rejects a valid caption when redaction expands it beyond 2000 characters`, async t => {
    const proposal = { summary: "Controlled bounded caption", edit: { ...EDIT, caption: `${"x".repeat(1991)} Bearer a` } };
    assert.equal(proposal.edit.caption.length, 2000);
    assert.equal(aiProposalSchema.safeParse(proposal).success, true, "the incoming proposal must be valid before redaction");
    assert.ok(`${"x".repeat(1991)} Bearer [REDACTED]`.length > 2000);
    const bridge = new ControlledBridge();
    bridge.handler = async () => ({ ...proposal, sessionId: "controlled-caption" });
    const f = await fixture(t, { bridge }), a = await imported(f), before = timeline(f, a);
    if (transport === "bridge") {
      const run = await response(await f.json("/api/ai/runs", request(f, a)), 202);
      const saved = await until(() => f.store.studio.aiRun(run.id, f.context), value => value.state !== "running", "redaction bounds failure");
      assert.equal(saved.state, "failed"); assert.equal(saved.error, "ai_invalid_proposal");
      assert.equal(saved.edit, null); assert.equal(saved.summary, null);
      await response(await review(f, run, "accept"), 409, "ai_run_conflict");
    } else {
      const grant = await mint(f, a), audit = f.store.listAudit(f.context);
      await response(await mcp(f, grant, "timeline_propose", { ...proposal, baseRevision: 0 }), 400, "ai_invalid_proposal");
      assert.deepEqual(f.store.studio.aiRuns(a.id, f.context), []);
      assert.deepEqual(f.store.listAudit(f.context), audit);
    }
    assert.ok(f.store.studio.aiRuns(a.id, f.context).every(run => run.state !== "ready"));
    assert.deepEqual(timeline(f, a), before);
    assert.deepEqual(f.store.listMemory(f.context), []); assert.deepEqual(f.store.studio.renders(f.context), []);
  });
}

test("ready proposals cannot auto-apply; accept is atomic with timeline and same-base CAS permits one winner", async t => {
  const f = await fixture(t), a = await imported(f), first = await ready(f, a), second = await ready(f, a);
  assert.equal(first.baseRevision, 0); assert.equal(second.baseRevision, 0);
  assert.equal(first.sourceSha256, SHA); assert.deepEqual(first.edit, EDIT);
  assert.deepEqual(timeline(f, a), { revision: 0, cursor: -1, edits: [] });
  const audit = f.store.listAudit(f.context);
  // Force the *second* durable write to fail, proving acceptance rolls back its
  // timeline write and timeline audit instead of partially applying the proposal.
  f.store.db.exec("CREATE TRIGGER fail_ai_accept BEFORE UPDATE ON ai_runs WHEN json_extract(NEW.data,'$.state')='accepted' BEGIN SELECT RAISE(ABORT,'controlled acceptance failure'); END;");
  await response(await review(f, first, "accept"), 500, "operation_failed");
  assert.deepEqual(timeline(f, a), { revision: 0, cursor: -1, edits: [] });
  assert.equal(f.store.studio.aiRun(first.id, f.context).state, "ready");
  assert.deepEqual(f.store.listAudit(f.context), audit);
  f.store.db.exec("DROP TRIGGER fail_ai_accept");
  const replies = await Promise.all([review(f, first, "accept"), review(f, second, "accept")]);
  assert.deepEqual(replies.map(value => value.status).sort(), [200, 409]);
  const results = await Promise.all(replies.map(value => value.json()));
  assert.equal(results.find(value => value.error)?.error, "revision_conflict");
  assert.deepEqual(timeline(f, a), { revision: 1, cursor: 0, edits: [EDIT] });
  const winner = results.find(value => value.state === "accepted"), loser = winner.id === first.id ? second : first;
  const stable = timeline(f, a), stableAudit = f.store.listAudit(f.context);
  await response(await review(f, winner, "accept"), 409, "ai_run_conflict");
  await response(await review(f, winner, "reject"), 409, "ai_run_conflict");
  assert.deepEqual(timeline(f, a), stable); assert.deepEqual(f.store.listAudit(f.context), stableAudit);
  await response(await review(f, loser, "reject"), 200);
  await response(await review(f, loser, "accept"), 409, "ai_run_conflict");
  await f.restart();
  assert.equal(f.store.studio.aiRun(winner.id, f.context).state, "accepted");
  assert.equal(f.store.studio.aiRun(loser.id, f.context).state, "rejected");
  assert.deepEqual(timeline(f, a), stable);
  assert.equal(f.store.listAudit(f.context).filter(value => value.action === "ai.accepted").length, 1);
  assert.deepEqual(f.store.listMemory(f.context), []); assert.deepEqual(f.store.studio.publications(f.context), []);
});

for (const change of ["manual edit", "source bytes", "source hash", "destination", "other account", "sibling project"]) {
  test(`accept rejects ${change} drift without changing the ready proposal, timeline or audit`, async t => {
    const f = await fixture(t), a = await imported(f), run = await ready(f, a);
    if (change === "manual edit") f.store.studio.edit(a.id, f.context, 0, { ...EDIT, gainDb: -3 });
    if (change === "source bytes") await writeFile(join(f.directory, "media", `${a.id}.mp4`), Buffer.concat([WEBM, Buffer.from("tampered")]));
    if (change === "source hash") patchArtifact(f, a, { sha256: "0".repeat(64) });
    if (change === "destination") f.store.db.prepare("UPDATE accounts SET destination_id=? WHERE id=?").run(`UC${"C".repeat(22)}`, f.context.accountId);
    const before = timeline(f, a), audit = f.store.listAudit(f.context);
    const context = change === "other account" ? f.other : change === "sibling project" ? f.sibling : f.context;
    const code = change === "manual edit" ? "revision_conflict" : change === "destination" ? "ai_scope_mismatch"
      : ["other account", "sibling project"].includes(change) ? "ai_run_not_found" : "media_source_changed";
    await response(await review(f, run, "accept", context), code === "ai_run_not_found" ? 404 : 409, code);
    assert.deepEqual(timeline(f, a), before); assert.deepEqual(f.store.listAudit(f.context), audit);
    assert.equal(f.store.studio.aiRun(run.id, f.context).state, "ready");
    if (context !== f.context) {
      await response(await f.call(`/api/ai/runs?${new URLSearchParams({ ...context, artifactId: a.id })}`), 404, "artifact_not_found");
      await response(await review(f, run, "reject", context), 404, "ai_run_not_found");
    }
  });
}

test("reject is terminal and never writes the manual timeline or memory", async t => {
  const f = await fixture(t), a = await imported(f), run = await ready(f, a);
  assert.equal((await response(await review(f, run, "reject"), 200)).state, "rejected");
  const audit = f.store.listAudit(f.context);
  for (const action of ["reject", "accept", "preview", "cancel"]) await response(await review(f, run, action), 409, "ai_run_conflict");
  assert.deepEqual(timeline(f, a), { revision: 0, cursor: -1, edits: [] });
  assert.deepEqual(f.store.listAudit(f.context), audit); assert.deepEqual(f.store.listMemory(f.context), []);
});

for (const invalid of ["schema", "source range", "source changed while running"]) {
  test(`controlled bridge ${invalid} result is failed, never applied`, async t => {
    const bridge = new ControlledBridge(), entered = gate(), release = gate();
    bridge.handler = async () => { entered.resolve(); await release.promise;
      return { summary: "Controlled invalid proposal", edit: invalid === "schema" ? { ...EDIT, path: "vault" }
        : invalid === "source range" ? { ...EDIT, outSeconds: 5 } : EDIT, sessionId: "controlled" }; };
    const f = await fixture(t, { bridge }), a = await imported(f);
    f.cleanup.push(() => release.resolve());
    const run = await response(await f.json("/api/ai/runs", request(f, a)), 202); await entered.promise;
    if (invalid === "source changed while running") await writeFile(join(f.directory, "media", `${a.id}.mp4`), Buffer.from("tampered"));
    release.resolve();
    const result = await until(() => f.store.studio.aiRun(run.id, f.context), run => run.state !== "running", "invalid proposal failure");
    assert.equal(result.state, "failed"); assert.equal(result.edit, null);
    assert.deepEqual(timeline(f, a), { revision: 0, cursor: -1, edits: [] });
    await response(await review(f, run, "accept"), 409, invalid === "source changed while running" ? "media_source_changed" : "ai_run_conflict");
  });
}

for (const action of ["cancel", "close"]) {
  test(`${action} awaits the bridge and ignores late callbacks/results with no orphan task or lease`, { timeout: 10_000 }, async t => {
    const bridge = new ControlledBridge(), entered = gate(), release = gate();
    bridge.handler = async call => { entered.resolve(call); await release.promise;
      call.event({ type: "activity", message: "late private callback" });
      return { summary: "Late result must not become ready", edit: EDIT, sessionId: "late" }; };
    const f = await fixture(t, { bridge }), a = await imported(f); f.cleanup.push(() => release.resolve());
    const run = await response(await f.json("/api/ai/runs", request(f, a)), 202), call = await entered.promise;
    await response(await f.json("/api/ai/runs", request(f, a)), 409, "ai_busy");
    const events = f.store.studio.aiRun(run.id, f.context).events;
    let finished = false;
    const closing = (action === "close" ? f.api.close() : review(f, run, "cancel")).then(value => { finished = true; return value; });
    await until(() => call.signal.aborted, Boolean, "bridge abort");
    assert.equal(finished, false, "shutdown/cancel must await the owned bridge task");
    release.resolve();
    const result = await closing;
    if (action === "cancel") assert.equal((await response(result, 200)).state, "cancelled");
    const saved = f.store.studio.aiRun(run.id, f.context);
    assert.equal(saved.state, "cancelled"); assert.equal(saved.edit, null); assert.deepEqual(saved.events, events);
    const durable = f.store.db.prepare("SELECT data,lease_until FROM ai_runs WHERE id=?").get(run.id);
    assert.equal(durable.lease_until, 0); assert.equal(JSON.parse(durable.data).state, "cancelled");
    call.event({ type: "activity", message: "even later" });
    assert.deepEqual(f.store.studio.aiRun(run.id, f.context), saved);
    assert.deepEqual(timeline(f, a), { revision: 0, cursor: -1, edits: [] });
    assert.deepEqual(f.store.studio.renders(f.context), []); assert.deepEqual(f.store.listMemory(f.context), []);
    assert.deepEqual(await readdir(join(f.directory, "media")), [`${a.id}.mp4`]);
    await f.restart();
    assert.equal(f.store.studio.aiRun(run.id, f.context).state, "cancelled");
  });
}

test("another runtime durably requests cancellation and the 1s owner heartbeat aborts a quiet bridge", { timeout: 10_000 }, async t => {
  const bridge = new ControlledBridge(), entered = gate(), aborted = gate(), release = gate();
  bridge.handler = async call => {
    entered.resolve(call);
    await new Promise(resolve => {
      if (call.signal.aborted) resolve();
      else call.signal.addEventListener("abort", resolve, { once: true });
    });
    aborted.resolve(); await release.promise;
    call.event({ type: "activity", message: "late cross-runtime callback" });
    return { summary: "Late cross-runtime result", edit: EDIT, sessionId: "late-cross-runtime" };
  };
  const f = await fixture(t), a = await imported(f), secondStore = new WorkspaceStore(f.path);
  const studio = new StudioService(f.store, {}, {}, f.directory);
  const owner = new AiService(f.store, studio, { bridge }), secondBridge = new ControlledBridge();
  const second = new AiService(secondStore, studio, { bridge: secondBridge });
  f.cleanup.push(() => secondStore.close(), () => studio.close(), () => second.close(), () => owner.close(), () => release.resolve());
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const run = await owner.start(request(f, a)), call = await entered.promise, task = owner.tasks.get(run.id);
  assert.ok(task);
  const initial = f.store.db.prepare("SELECT owner,lease_until,cancel_requested FROM ai_runs WHERE id=?").get(run.id);
  assert.equal(initial.cancel_requested, 0); assert.ok(initial.lease_until > Date.now());
  const pending = await second.cancel(run.id, f.context);
  assert.equal(pending.state, "running"); assert.equal(pending.cancelRequested, true);
  assert.equal(secondStore.studio.aiRun(run.id, f.context).cancelRequested, true);
  assert.equal(f.store.studio.aiRun(run.id, f.context).cancelRequested, true);
  const requested = f.store.db.prepare("SELECT owner,lease_until,cancel_requested FROM ai_runs WHERE id=?").get(run.id);
  assert.equal(requested.owner, initial.owner); assert.equal(requested.lease_until, initial.lease_until);
  assert.equal(requested.cancel_requested, 1);
  assert.throws(() => f.store.studio.assertAiActive(run.id, initial.owner), { code: "ai_cancelled" });
  assert.throws(() => f.store.studio.saveAiRun(structuredClone(run), initial.owner), { code: "ai_cancelled" });
  assert.throws(() => secondStore.studio.saveAiRun({ ...run, state: "ready", edit: EDIT }, "wrong-owner"), { code: "ai_run_conflict" });
  t.mock.timers.tick(999);
  assert.equal(call.signal.aborted, false, "a remote cancel has no in-process task to abort directly");
  t.mock.timers.tick(1); await aborted.promise;
  assert.equal(call.signal.aborted, true);
  assert.equal(owner.tasks.get(run.id), task, "the owner must still track the bridge until it settles");
  const events = f.store.studio.aiRun(run.id, f.context).events;
  release.resolve(); await task.promise;
  const saved = secondStore.studio.aiRun(run.id, f.context);
  assert.equal(saved.state, "cancelled"); assert.equal(saved.cancelRequested, true);
  assert.equal(saved.summary, null); assert.equal(saved.edit, null); assert.equal(saved.error, null);
  assert.deepEqual(saved.events, events); assert.equal(owner.tasks.has(run.id), false);
  const durable = f.store.db.prepare("SELECT data,owner,lease_until,cancel_requested FROM ai_runs WHERE id=?").get(run.id);
  assert.equal(JSON.parse(durable.data).state, "cancelled"); assert.equal(durable.lease_until, 0);
  assert.equal(durable.owner, initial.owner); assert.equal(durable.cancel_requested, 1);
  assert.throws(() => f.store.studio.saveAiRun({ ...run, state: "ready", edit: EDIT }, initial.owner), { code: "ai_run_conflict" });
  call.event({ type: "activity", message: "after task exit" }); t.mock.timers.tick(1000);
  assert.deepEqual(f.store.studio.aiRun(run.id, f.context), saved);
  assert.equal(secondBridge.discoveries, 0); assert.deepEqual(secondBridge.calls, []);
  assert.deepEqual(timeline(f, a), { revision: 0, cursor: -1, edits: [] });
  assert.deepEqual(f.store.studio.renders(f.context), []); assert.deepEqual(f.store.listMemory(f.context), []);
});

test("durable cancellation fences even the live owner's attempted ready write", async t => {
  const f = await fixture(t), a = await imported(f), secondStore = new WorkspaceStore(f.path), owner = "controlled-cancel-owner";
  f.cleanup.push(() => secondStore.close());
  const run = { id: randomUUID(), ...scope(f, a), sourceSha256: SHA, baseRevision: 0, model: MODEL, prompt: "Controlled",
    includeMemory: false, state: "running", summary: null, edit: null, error: null, events: [],
    createdAt: new Date().toISOString(), sessionId: null, previewRenderId: null };
  f.store.studio.createAiRun(run, owner);
  secondStore.studio.requestAiCancel(run.id, f.context);
  f.store.studio.saveAiRun({ ...run, state: "ready", summary: "Must not be ready", edit: EDIT }, owner);
  const saved = secondStore.studio.aiRun(run.id, f.context);
  assert.equal(saved.state, "cancelled"); assert.equal(saved.cancelRequested, true);
  assert.equal(saved.edit, null); assert.equal(saved.summary, null); assert.equal(saved.error, null);
  assert.equal(f.store.db.prepare("SELECT lease_until FROM ai_runs WHERE id=?").get(run.id).lease_until, 0);
  assert.throws(() => f.store.studio.saveAiRun({ ...run, state: "ready", edit: EDIT }, owner), { code: "ai_run_conflict" });
  assert.throws(() => f.store.studio.reviewAiRun(run.id, f.context, "accept"), { code: "ai_run_conflict" });
  assert.deepEqual(timeline(f, a), { revision: 0, cursor: -1, edits: [] });
});

for (const kind of ["export", "proxy", "preview"]) {
  test(`${kind} cancelled during final async source verification never registers its output`, { timeout: 10_000 }, async t => {
    const f = await fixture(t), a = await imported(f), verifying = gate(), release = gate();
    const service = new StudioService(f.store, {}, {}, f.directory);
    f.cleanup.push(() => service.close(), () => release.resolve());
    const history = f.store.studio.edit(a.id, f.context, 0, EDIT), before = timeline(f, a);
    const audit = f.store.listAudit(f.context);
    let verifies = 0, outputId, renderSignal;
    const verify = t.mock.method(service.engine, "verify", async (id, hash) => {
      assert.equal(id, a.id); assert.equal(hash, SHA);
      if (++verifies === 2) { verifying.resolve(); await release.promise; }
      return true;
    });
    // Trusted fake engine output, not an FFmpeg/container verification claim.
    const encode = async (sourceId, id, progress, signal) => {
      assert.equal(sourceId, a.id); signal.throwIfAborted();
      outputId = id; renderSignal = signal;
      await writeFile(service.engine.path(id), WEBM, { flag: "wx" }); progress(1);
      return { id, filename: "controlled.mp4", sha256: SHA, bytes: WEBM.length, mimeType: "video/mp4", probe: PROBE };
    };
    const render = t.mock.method(service.engine, "render", (sourceId, id, edit, progress, signal) => {
      assert.deepEqual(edit, EDIT); return encode(sourceId, id, progress, signal);
    });
    const proxy = t.mock.method(service.engine, "proxy", encode);
    const remove = t.mock.method(service.engine, "remove");
    const addArtifact = t.mock.method(f.store.studio, "addArtifact");
    const job = kind === "export" ? service.render(a.id, f.context, history.revision)
      : kind === "proxy" ? service.proxy(a.id, f.context)
      : service.renderCandidate(a.id, f.context, EDIT, history.revision, SHA);
    await verifying.promise;
    const key = `render:${job.id}`, task = service.tasks.get(key);
    assert.ok(task); assert.equal(job.kind, kind); assert.equal(renderSignal.aborted, false);
    assert.equal(f.store.studio.render(job.id, f.context).state, "running");
    assert.deepEqual(await readFile(service.engine.path(outputId)), WEBM, "encoding must finish before cancellation");
    service.cancelRender(job.id, f.context);
    assert.equal(renderSignal.aborted, true); assert.equal(addArtifact.mock.callCount(), 0);
    release.resolve(); await task.promise;
    const saved = f.store.studio.render(job.id, f.context);
    assert.equal(saved.state, "cancelled"); assert.equal(saved.error, null); assert.equal(saved.artifactId, null);
    assert.equal(verify.mock.callCount(), 2); assert.equal(addArtifact.mock.callCount(), 0);
    assert.equal(render.mock.callCount(), kind === "proxy" ? 0 : 1);
    assert.equal(proxy.mock.callCount(), kind === "proxy" ? 1 : 0);
    assert.deepEqual(remove.mock.calls.map(call => call.arguments), [[outputId]]);
    assert.equal(service.tasks.has(key), false);
    assert.deepEqual(f.store.studio.artifacts(f.context).map(value => value.id), [a.id]);
    assert.equal(f.store.studio.artifact(a.id, f.context).proxyId, a.proxyId);
    assert.deepEqual(timeline(f, a), before); assert.deepEqual(f.store.listMemory(f.context), []);
    assert.deepEqual(f.store.listAudit(f.context), audit);
    assert.deepEqual(await readdir(join(f.directory, "media")), [`${a.id}.mp4`]);
    assert.ok(!(await readdir(f.directory)).some(name => /^\.(?:proxy|render|import)-/u.test(name)));
  });
}

test("StudioStore AI leases fence wrong/expired owners and interrupted runs survive reopen without acceptance", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T00:00:00Z") });
  const f = await fixture(t), a = await imported(f), id = randomUUID(), owner = "controlled-owner";
  const run = { id, ...scope(f, a), sourceSha256: SHA, baseRevision: 0, model: MODEL, prompt: "Controlled",
    includeMemory: false, state: "running", summary: null, edit: null, error: null, events: [],
    createdAt: new Date().toISOString(), sessionId: null, previewRenderId: null };
  f.store.studio.createAiRun(run, owner);
  assert.throws(() => f.store.studio.saveAiRun({ ...run, state: "ready", edit: EDIT }, "wrong-owner"), /ai_run_conflict/u);
  assert.throws(() => f.store.studio.createAiRun({ ...run, id: randomUUID() }, "second"), /ai_busy/u);
  t.mock.timers.tick(300_000);
  assert.equal(f.store.studio.aiRun(id, f.context).error, "ai_interrupted");
  assert.throws(() => f.store.studio.saveAiRun({ ...run, state: "ready", edit: EDIT }, owner), /ai_run_conflict/u);
  await f.restart();
  await response(await review(f, run, "accept"), 409, "ai_run_conflict");
  assert.equal(f.store.studio.aiRun(id, f.context).state, "failed");
  assert.deepEqual(timeline(f, a), { revision: 0, cursor: -1, edits: [] });
});

test("actual HTTP MCP grant is dedicated, artifact-scoped and never reveals the desktop bearer or vault paths", async t => {
  const f = await fixture(t), a = await imported(f), other = await imported(f, f.other), grant = await mint(f, a);
  assert.match(grant.token, /^[a-f0-9]{64}$/u); assert.notEqual(grant.token, f.api.token);
  assert.deepEqual(grant.tools, TOOLS); assert.equal(grant.origin, f.api.origin);
  const capabilities = await response(await f.call("/api/mcp/capabilities", {}, grant.token), 200);
  assert.deepEqual(capabilities.scope, { ...f.context, artifactId: a.id, destinationId: f.destinationId });
  assert.equal(capabilities.includeMemory, false); assert.deepEqual(capabilities.tools, TOOLS);
  assert.ok(Date.parse(capabilities.expiresAt) > Date.now());
  const inspected = await response(await mcp(f, grant, "media_inspect"), 200);
  assert.deepEqual(inspected, { id: a.id, filename: a.filename, sha256: SHA, bytes: WEBM.length, probe: PROBE });
  for (const secret of [f.api.token, f.connection.credentialRef, f.directory, other.id, f.other.accountId])
    assert.ok(!JSON.stringify({ grant, capabilities, inspected }).includes(secret), secret);
  await response(await f.call("/api/mcp/capabilities"), 401, "mcp_grant_invalid");
  await response(await f.json("/api/mcp/call", { tool: "media_inspect", arguments: {} }), 401, "mcp_grant_invalid");
  await response(await f.call("/api/workspace", {}, grant.token), 401, "unauthorized");
  await response(await f.json("/api/ai/grants", { ...scope(f, a), includeMemory: false }, "POST", grant.token), 401, "unauthorized");
  for (const tool of ["publish", "approve", "publication_approve", "vault", "memory_read", "timeline_accept"]) {
    await response(await mcp(f, grant, tool), 403, "mcp_tool_forbidden");
  }
  await response(await f.json("/api/ai/grants", { ...scope(f, other), includeMemory: false }), 404, "artifact_not_found");
});

test("official SDK stdio to the actual API scopes proposals and requires the human session to accept", { timeout: 20_000 }, async t => {
  const f = await fixture(t), a = await imported(f), sameProject = await imported(f);
  const sibling = await imported(f, f.sibling), other = await imported(f, f.other);
  const grant = await mint(f, a), client = await sdkClient(f, grant);
  assert.notEqual(grant.token, f.api.token);
  assert.deepEqual(client.getServerVersion(), { name: "atris-share", version: "0.1.0-preview.1" });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), TOOLS);
  // Changing the desktop's current selection cannot redirect this fixed grant.
  f.store.setContext(f.other);
  const inspected = await sdkTool(client, "media_inspect");
  assert.deepEqual(inspected, { id: a.id, filename: a.filename, sha256: SHA, bytes: WEBM.length, probe: PROBE });
  const before = await sdkTool(client, "timeline_read");
  assert.deepEqual(before, { revision: 0, cursor: -1, edits: [] });
  const proposal = { summary: "Keep only the scoped opening and closing", edit: EDIT, baseRevision: before.revision };
  const audit = f.store.listAudit(f.context);
  for (const target of [sameProject, sibling, other]) {
    for (const [name, args] of [["media_inspect", {}], ["timeline_read", {}], ["timeline_propose", proposal]]) {
      await sdkError(client, name, { ...args, artifactId: target.id }, "mcp_invalid_arguments");
    }
  }
  for (const [key, value] of Object.entries({ context: f.other, accountId: f.other.accountId,
    projectId: f.sibling.projectId, destinationId: "other-destination" })) {
    await sdkError(client, "timeline_propose", { ...proposal, [key]: value }, "mcp_invalid_arguments");
  }
  for (const name of ["approve", "publish", "publication_approve", "timeline_accept"]) {
    await sdkError(client, name, {}, "mcp_tool_unavailable");
  }
  assert.deepEqual(f.store.listAudit(f.context), audit);
  assert.deepEqual(f.store.studio.aiRuns(a.id, f.context), []);
  const run = await sdkTool(client, "timeline_propose", proposal);
  assert.equal(run.state, "ready"); assert.equal(run.model, "external-mcp");
  assert.equal(run.artifactId, a.id); assert.deepEqual(run.context, f.context);
  assert.equal(run.destinationId, f.destinationId); assert.equal(run.sourceSha256, SHA);
  assert.equal(run.baseRevision, before.revision); assert.deepEqual(run.edit, EDIT);
  assert.deepEqual(await sdkTool(client, "timeline_read"), before);
  const runs = await response(await f.call(`/api/ai/runs?${new URLSearchParams({ ...f.context, artifactId: a.id })}`), 200);
  assert.deepEqual(runs, [run], "the UI session must see the proposal produced through stdio");
  for (const action of ["accept", "reject"]) {
    await response(await f.json(`/api/ai/runs/${run.id}/${action}`, { context: f.context }, "POST", grant.token), 401, "unauthorized");
  }
  await response(await f.json(`/api/media/${a.id}/timeline`, { context: f.context, expectedRevision: 0, edit: EDIT }, "PUT", grant.token), 401, "unauthorized");
  const publication = await sdkTool(client, "publication_request", PUBLICATION);
  assert.equal(publication.state, "review"); assert.equal(publication.payload.artifactId, a.id);
  assert.equal(publication.approvalExpiresAt, null); assert.equal(publication.videoId, null);
  await response(await f.json(`/api/publications/${publication.id}/approve`,
    { context: f.context, digest: publication.digest }, "POST", grant.token), 401, "unauthorized");
  assert.equal(f.store.studio.aiRun(run.id, f.context).state, "ready");
  assert.deepEqual(await sdkTool(client, "timeline_read"), before);
  assert.equal((await response(await review(f, run, "accept"), 200)).state, "accepted");
  const accepted = { revision: 1, cursor: 0, edits: [EDIT] };
  assert.deepEqual(await response(await f.call(`/api/media/${a.id}/timeline?${query(f.context)}`), 200), accepted);
  assert.deepEqual(await sdkTool(client, "timeline_read"), accepted);
  for (const [artifact, context] of [[sameProject, f.context], [sibling, f.sibling], [other, f.other]]) {
    assert.deepEqual(f.store.studio.timeline(artifact.id, context), before);
    assert.deepEqual(f.store.studio.aiRuns(artifact.id, context), []);
  }
  assert.equal(f.store.studio.publication(publication.id, f.context).state, "review");
  assert.equal(f.store.listAudit(f.context).filter(value => value.action === "ai.accepted").length, 1);
  assert.equal(f.store.listAudit(f.context).filter(value => value.action === "publication.approved").length, 0);
  assert.equal(f.bridge.discoveries, 0); assert.deepEqual(f.bridge.calls, []);
  assert.deepEqual(f.store.listMemory(f.context), []); assert.deepEqual(f.store.studio.renders(f.context), []);
  assert.deepEqual(await readFile(join(f.directory, "media", `${a.id}.mp4`)), WEBM);
  const exposed = JSON.stringify({ inspected, run, publication });
  for (const secret of [grant.token, f.api.token, f.connection.credentialRef, f.directory, sameProject.id, sibling.id, other.id]) {
    assert.ok(!exposed.includes(secret), "MCP results must not expose credentials, paths or unrelated artifacts");
  }
  await response(await f.json("/api/ai/grants/revoke", { context: f.context, token: grant.token }), 200);
  await sdkError(client, "media_inspect", {}, "mcp_grant_rejected");
});

test("real A/V through SDK proposal and human acceptance renders a 2s split while the proxy stays full length", { timeout: 60_000 }, async t => {
  // Use only configured/PATH FFmpeg and FFprobe, as in the media-engine suite.
  // Decoded marker synchronization is covered there; this case joins the actual services.
  const f = await fixture(t, { engine: {} });
  const status = await response(await f.call(`/api/studio?${query(f.context)}`), 200);
  if (!status.tools.available) { t.skip(`External tools unavailable: ${JSON.stringify(status.tools)}`); return; }
  const child = spawn(process.env.ATRIS_SHARE_FFMPEG ?? "ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "2", "-c:a", "aac",
    "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"],
  { cwd: f.directory, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  f.children.push({ child });
  const chunks = [], errors = [];
  child.stdout.on("data", chunk => chunks.push(chunk));
  child.stderr.on("data", chunk => errors.push(chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); })
    .finally(() => clearTimeout(timer));
  assert.equal(code, 0, Buffer.concat(errors).toString());
  const bytes = Buffer.concat(chunks), hash = createHash("sha256").update(bytes).digest("hex");
  const a = await response(await f.call(`/api/media/import?${new URLSearchParams({ ...f.context, filename: "generated-av.mp4" })}`,
    { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes }), 201);
  assert.equal(a.sha256, hash); assert.equal(a.probe.hasAudio, true);
  const proxyJob = await response(await f.json(`/api/media/${a.id}/proxy`, { context: f.context }), 202);
  const proxyRender = await renderDone(f, proxyJob.id);
  assert.equal(proxyRender.state, "succeeded", JSON.stringify(proxyRender));
  const proxy = f.store.studio.artifact(proxyRender.artifactId, f.context);
  assert.equal(proxy.kind, "proxy"); assert.equal(proxy.sourceId, a.id); assert.equal(proxy.sourceSha256, hash);
  assert.ok(Math.abs(proxy.probe.duration - a.probe.duration) < 0.15, "proxy must preserve the full source duration");
  assert.equal(proxy.probe.hasAudio, true);
  const client = await sdkClient(f, await mint(f, a));
  assert.equal((await sdkTool(client, "media_inspect")).sha256, hash);
  const run = await sdkTool(client, "timeline_propose", { summary: "Remove the middle two seconds", edit: EDIT, baseRevision: 0 });
  assert.equal(run.sourceSha256, hash);
  assert.deepEqual(await sdkTool(client, "timeline_read"), { revision: 0, cursor: -1, edits: [] });
  await response(await review(f, run, "accept"), 200);
  const job = await response(await f.json(`/api/media/${a.id}/render`, { context: f.context, expectedRevision: 1 }), 202);
  const render = await renderDone(f, job.id);
  assert.equal(render.state, "succeeded", JSON.stringify(render));
  const output = f.store.studio.artifact(render.artifactId, f.context);
  assert.equal(output.sourceId, a.id); assert.equal(output.probe.hasAudio, true);
  assert.ok(Math.abs(output.probe.duration - 2) < 0.15, JSON.stringify(output.probe));
  const content = await f.call(`/api/media/${output.id}/content?${query(f.context)}`);
  assert.equal(content.status, 200);
  assert.equal(createHash("sha256").update(Buffer.from(await content.arrayBuffer())).digest("hex"), output.sha256);
  const source = f.store.studio.artifact(a.id, f.context);
  assert.equal(source.sha256, hash); assert.equal(source.proxyId, proxy.id);
  assert.deepEqual(await readFile(join(f.directory, "media", `${a.id}.mp4`)), bytes);
  assert.deepEqual(f.store.studio.artifact(proxy.id, f.context), proxy, "split rendering must not trim or replace the full proxy");
  assert.equal(f.bridge.discoveries, 0); assert.deepEqual(f.bridge.calls, []);
  assert.deepEqual(f.store.studio.publications(f.context), []);
  t.diagnostic(`Real A/V: source=${a.probe.duration}s, full proxy=${proxy.probe.duration}s, split=${output.probe.duration}s`);
});

test("MCP memory requires opt-in and returns confirmed notes only from the granted scope", async t => {
  const f = await fixture(t), a = await imported(f); notes(f);
  const without = await mint(f, a), withMemory = await mint(f, a, true);
  await response(await mcp(f, without, "memory_read"), 403, "mcp_tool_forbidden");
  const capabilities = await response(await f.call("/api/mcp/capabilities", {}, withMemory.token), 200);
  assert.ok(capabilities.tools.includes("memory_read"));
  assert.deepEqual((await response(await mcp(f, withMemory, "memory_read"), 200)).map(value => value.text).sort(),
    ["ACCOUNT_CONFIRMED", "PROJECT_CONFIRMED"]);
});

test("MCP tool arguments reject scope smuggling on every tool before creating state", async t => {
  const f = await fixture(t), a = await imported(f), grant = await mint(f, a, true);
  const valid = { media_inspect: {}, timeline_read: {}, memory_read: {},
    timeline_propose: { summary: "Controlled", edit: EDIT, baseRevision: 0 },
    render_preview: { proposalId: randomUUID() }, render_status: { renderId: randomUUID() }, publication_request: PUBLICATION };
  const audit = f.store.listAudit(f.context);
  for (const [tool, args] of Object.entries(valid)) {
    for (const [key, value] of Object.entries({ accountId: f.other.accountId, projectId: f.other.projectId, artifactId: randomUUID(),
      destinationId: "other", context: f.other, path: "vault", token: f.api.token, approve: true })) {
      await response(await mcp(f, grant, tool, { ...args, [key]: value }), 400, "invalid_input");
    }
  }
  await response(await mcp(f, grant, "timeline_propose", { ...valid.timeline_propose, edit: { ...EDIT, artifactId: randomUUID() } }), 400, "invalid_input");
  assert.deepEqual(f.store.studio.aiRuns(a.id, f.context), []); assert.deepEqual(f.store.studio.renders(f.context), []);
  assert.deepEqual(f.store.studio.publications(f.context), []); assert.deepEqual(f.store.listAudit(f.context), audit);
});

test("MCP proposals create ready only; preview/render status are limited to this grant's proposal and render sets", async t => {
  const f = await fixture(t, { tools: true }), a = await imported(f), grant = await mint(f, a), second = await mint(f, a);
  const proposal = { summary: "External edit", edit: EDIT, baseRevision: 0 };
  await response(await mcp(f, grant, "timeline_propose", { ...proposal, baseRevision: 1 }), 409, "revision_conflict");
  const run = await response(await mcp(f, grant, "timeline_propose", proposal), 200);
  assert.equal(run.state, "ready"); assert.equal(run.model, "external-mcp"); assert.equal(run.sourceSha256, SHA);
  assert.deepEqual(timeline(f, a), { revision: 0, cursor: -1, edits: [] }); assert.equal(f.bridge.calls.length, 0);
  const runs = await response(await f.call(`/api/ai/runs?${new URLSearchParams({ ...f.context, artifactId: a.id })}`), 200);
  assert.ok(runs.some(value => value.id === run.id && value.state === "ready"));
  await response(await mcp(f, second, "render_preview", { proposalId: run.id }), 403, "mcp_scope_forbidden");
  const internal = await ready(f, a);
  await response(await mcp(f, grant, "render_preview", { proposalId: internal.id }), 403, "mcp_scope_forbidden");
  const preview = await response(await mcp(f, grant, "render_preview", { proposalId: run.id }), 200);
  assert.equal(preview.run.previewRenderId, preview.render.id); assert.equal(preview.render.kind, "preview");
  const render = await renderDone(f, preview.render.id);
  assert.equal(render.state, "succeeded", JSON.stringify(render));
  assert.equal((await response(await mcp(f, grant, "render_status", { renderId: render.id }), 200)).artifactId, render.artifactId);
  await response(await mcp(f, second, "render_status", { renderId: render.id }), 403, "mcp_scope_forbidden");
  await response(await mcp(f, grant, "render_status", { renderId: randomUUID() }), 403, "mcp_scope_forbidden");
  const artifact = f.store.studio.artifact(render.artifactId, f.context);
  assert.equal(artifact.kind, "preview"); assert.equal(artifact.sourceId, a.id); assert.equal(artifact.sourceSha256, SHA);
  assert.deepEqual((await response(await f.call(`/api/studio?${query(f.context)}`), 200)).artifacts.map(value => value.id), [a.id]);
  assert.deepEqual(timeline(f, a), { revision: 0, cursor: -1, edits: [] });
  assert.deepEqual(f.store.listMemory(f.context), []);
});

test("preview artifacts are protected from publication as well as hidden from the source library", async t => {
  const f = await fixture(t, { tools: true }), a = await imported(f), run = await ready(f, a);
  const preview = await response(await review(f, run, "preview"), 202), render = await renderDone(f, preview.render.id);
  assert.equal(render.state, "succeeded", JSON.stringify(render));
  const value = await f.json("/api/publications", { context: f.context, artifactId: render.artifactId, ...PUBLICATION });
  assert.equal(value.status, 409, `Preview-only artifacts must not become publishable: ${await value.text()}`);
  assert.deepEqual(f.store.studio.publications(f.context), []);
});

test("MCP publication_request requires a connected account and creates review only with no approval authority", async t => {
  const f = await fixture(t), a = await imported(f), grant = await mint(f, a);
  f.store.db.prepare("UPDATE accounts SET status='disconnected' WHERE id=?").run(f.context.accountId);
  await response(await mcp(f, grant, "publication_request", PUBLICATION), 409, "youtube_reauth_required");
  assert.deepEqual(f.store.studio.publications(f.context), []);
  f.store.db.prepare("UPDATE accounts SET status='connected' WHERE id=?").run(f.context.accountId);
  const publication = await response(await mcp(f, grant, "publication_request", PUBLICATION), 200);
  assert.equal(publication.state, "review"); assert.equal(publication.approvalExpiresAt, null); assert.equal(publication.videoId, null);
  assert.equal(publication.payload.artifactId, a.id); assert.equal(publication.payload.sha256, SHA);
  assert.equal(publication.payload.destinationId, f.destinationId); assert.deepEqual(publication.context, f.context);
  await response(await f.json(`/api/publications/${publication.id}/approve`, { context: f.context, digest: publication.digest }, "POST", grant.token), 401, "unauthorized");
  await response(await mcp(f, grant, "publication_approve", { id: publication.id, digest: publication.digest }), 403, "mcp_tool_forbidden");
  const row = f.store.db.prepare("SELECT owner,session_ref,lease_until FROM publications WHERE id=?").get(publication.id);
  assert.equal(row.owner, null); assert.equal(row.session_ref, null); assert.equal(row.lease_until, 0);
  assert.equal(f.store.studio.publication(publication.id, f.context).state, "review");
  assert.equal(f.store.listAudit(f.context).filter(value => value.action === "publication.approved").length, 0);
  assert.deepEqual(f.store.listMemory(f.context), []);
});

test("MCP capability expiry is exact, revoke is scoped, and restart invalidates old grants", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T00:00:00Z") });
  const f = await fixture(t), a = await imported(f), expires = await mint(f, a);
  const ttl = Date.parse(expires.expiresAt) - Date.now(); assert.equal(ttl, 30 * 60_000);
  t.mock.timers.tick(ttl - 1);
  await response(await f.call("/api/mcp/capabilities", {}, expires.token), 200);
  t.mock.timers.tick(1);
  await response(await f.call("/api/mcp/capabilities", {}, expires.token), 401, "mcp_grant_invalid");
  await response(await mcp(f, expires, "media_inspect"), 401, "mcp_grant_invalid");
  const revoked = await mint(f, a);
  await response(await f.json("/api/ai/grants/revoke", { context: f.other, token: revoked.token }), 404, "mcp_grant_not_found");
  await response(await f.call("/api/mcp/capabilities", {}, revoked.token), 200);
  assert.deepEqual(await response(await f.json("/api/ai/grants/revoke", { context: f.context, token: revoked.token }), 200), { revoked: true });
  await response(await f.call("/api/mcp/capabilities", {}, revoked.token), 401, "mcp_grant_invalid");
  await response(await mcp(f, revoked, "timeline_read"), 401, "mcp_grant_invalid");
  const restarted = await mint(f, a); await f.restart();
  await response(await f.call("/api/mcp/capabilities", {}, restarted.token), 401, "mcp_grant_invalid");
  await response(await mcp(f, restarted, "media_inspect"), 401, "mcp_grant_invalid");
  const fresh = await mint(f, a); await response(await mcp(f, fresh, "media_inspect"), 200);
});

test("MCP capabilities revalidate the destination binding and cannot follow account destination drift", async t => {
  const f = await fixture(t), a = await imported(f), grant = await mint(f, a), before = timeline(f, a);
  f.store.db.prepare("UPDATE accounts SET destination_id=? WHERE id=?").run(`UC${"C".repeat(22)}`, f.context.accountId);
  await response(await f.call("/api/mcp/capabilities", {}, grant.token), 409, "ai_scope_mismatch");
  await response(await mcp(f, grant, "timeline_propose", { summary: "No redirect", edit: EDIT, baseRevision: 0 }), 409, "ai_scope_mismatch");
  await response(await mcp(f, grant, "publication_request", PUBLICATION), 409, "ai_scope_mismatch");
  assert.deepEqual(timeline(f, a), before); assert.deepEqual(f.store.studio.aiRuns(a.id, f.context), []);
  assert.deepEqual(f.store.studio.publications(f.context), []);
});
