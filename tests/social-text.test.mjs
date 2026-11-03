import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { OpenCodeBridge } from "../dist/packages/ai-bridge/src/opencode.js";
import { OpenCodeTextBridge } from "../dist/packages/ai-bridge/src/social-text.js";
import { SocialTextService } from "../dist/services/local-api/src/social-text.js";
import { socialRoute } from "../dist/services/local-api/src/social-routes.js";
import { WorkspaceError } from "../dist/packages/storage/src/config.js";
import { socialTextRequestSchema } from "../dist/packages/domain/src/social.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111", PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ACCOUNT = "22222222-2222-4222-8222-222222222222", OTHER_PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MODEL = "fixture/selected-text-model", OTHER_MODEL = "fixture/second-discovered-model";
const context = { accountId: ACCOUNT, projectId: PROJECT }, target = { ...context, destinationId: "123456" };
const output = (text = "A reviewed text proposal.") => ({ summary: "Shortened this variant.", edit: { inSeconds: 0, outSeconds: 1, crop: "original", gainDb: 0, caption: text }, sessionId: "ses_social_text_fixture" });
const input = (extra = {}) => ({ requestId: randomUUID(), context: { ...context }, target: { ...target }, modelId: MODEL,
  instruction: "Make this concise without adding facts.", text: "This is the current variant.", includeMemory: false, allowRemote: true, ...extra });
const hash = value => createHash("sha256").update(value).digest("hex");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
async function until(check) { const end = Date.now() + 8000; while (!check()) { if (Date.now() >= end) throw new Error("Expected operation barrier not reached"); await delay(5); } }

function fixture(t, options = {}) {
  const calls = [], reads = [], memoryReads = [], controls = { status: "connected", destination: target.destinationId, models: [MODEL, OTHER_MODEL],
    discoveryGate: null, proposeGate: null, reply: output(), error: null, ...options.controls };
  const notes = [
    { id: randomUUID(), accountId: ACCOUNT, projectId: PROJECT, kind: "brand-voice", reviewState: "confirmed", text: "CONFIRMED_TARGET_PROJECT_NOTE" },
    { id: randomUUID(), accountId: ACCOUNT, projectId: PROJECT, kind: "audience", reviewState: "suggested", text: "UNCONFIRMED_NOTE_MUST_NOT_SEND" },
    { id: randomUUID(), accountId: ACCOUNT, projectId: null, kind: "brand-voice", reviewState: "confirmed", text: "ACCOUNT_WIDE_NOTE_MUST_NOT_SEND" },
    { id: randomUUID(), accountId: ACCOUNT, projectId: OTHER_PROJECT, kind: "brand-voice", reviewState: "confirmed", text: "OTHER_PROJECT_MUST_NOT_SEND" },
    { id: randomUUID(), accountId: OTHER_ACCOUNT, projectId: PROJECT, kind: "brand-voice", reviewState: "confirmed", text: "OTHER_ACCOUNT_MUST_NOT_SEND" }
  ];
  const store = {
    resolveContext(scope) { reads.push({ ...scope }); if (scope.accountId !== ACCOUNT || scope.projectId !== PROJECT) throw new WorkspaceError(404, "context_not_found"); return { ...scope }; },
    listAccounts() { return [{ id: ACCOUNT, platform: "x", destinationId: controls.destination, status: controls.status, displayName: "UNREQUESTED_ACCOUNT_NAME", createdAt: "2026-11-02T00:00:00Z", connection: { providerSubjectId: "DO_NOT_SEND_CONNECTION", grantedScopes: ["DO_NOT_SEND_SCOPES"], verifiedAt: "2026-11-02T00:00:00Z" } }]; },
    listMemory(scope) { memoryReads.push({ ...scope }); return notes; }
  };
  const bridge = options.bridge ?? {
    async discover(signal, options) {
      calls.push({ kind: "discover", signal, options }); if (controls.discoveryGate) await controls.discoveryGate.promise;
      return { available: true, version: "1.19.5", auth: "cli-managed", models: controls.models, error: null };
    },
    async propose(value, _onEvent, signal) {
      calls.push({ kind: "propose", ...value, signal });
      if (controls.proposeGate) await controls.proposeGate.promise;
      if (controls.error) throw controls.error;
      return controls.reply;
    }
  };
  const service = new SocialTextService(store, { bridge }); t.after(() => service.close());
  return { service, store, calls, reads, memoryReads, notes, controls };
}

test("social text setup returns only discovered actual model IDs and no default/fallback", async t => {
  const f = fixture(t); const setup = await f.service.setup();
  assert.deepEqual(setup.models, [MODEL, OTHER_MODEL]); assert.equal(setup.auth, "cli-managed"); assert.equal(setup.memoryScope, "target-project-confirmed-only");
  assert.equal(setup.maxOutputChars, 2000);
  await assert.rejects(f.service.suggest(input({ modelId: "invented/model" })), /social_ai_model_unavailable/);
  assert.equal(f.calls.filter(c => c.kind === "propose").length, 0);
  f.controls.models = [OTHER_MODEL]; await f.service.setup(undefined, true);
  assert.deepEqual(f.calls.filter(c => c.kind === "discover").map(c => c.options), [{ refresh: false }, { refresh: true }]);
  await assert.rejects(f.service.suggest(input()), /social_ai_model_unavailable/);
});

test("social setup keeps stale catalog IDs and distinguishes version/refresh failures", async t => {
  const refreshedAt = "2026-11-03T00:00:00.000Z";
  const f = fixture(t, { bridge: { async discover(_signal, options) {
    assert.equal(options.refresh, true);
    return { available: false, version: "1.19.5", models: [MODEL], auth: "cli-managed", error: "ai_catalog_refresh_failed", catalog: { state: "stale", refreshedAt } };
  }, async propose() { assert.fail("failed discovery cannot infer"); } } });
  const setup = await f.service.setup(undefined, true);
  assert.equal(setup.available, false); assert.equal(setup.error, "social_ai_catalog_refresh_failed");
  assert.deepEqual(setup.models, [MODEL]); assert.deepEqual(setup.catalog, { state: "stale", refreshedAt });
});

test("social setup preserves full semver diagnostics without accepting arbitrary version text", async t => {
  for (const version of ["1.20.0", "1.20.0-rc.1+build.7", "1.20.0+build.7"]) {
    const f = fixture(t, { bridge: { async discover() {
      return { available: false, version, models: [], auth: "cli-managed", error: "ai_version_unsupported" };
    }, async propose() { assert.fail("unsupported version must not run"); } } });
    const setup = await f.service.setup();
    assert.equal(setup.version, version); assert.equal(setup.error, "social_ai_version_unsupported");
  }
});

test("social text sends exactly the explicit variant/instruction/target, no implicit memory or publication rights", async t => {
  const f = fixture(t); const request = input({ modelId: OTHER_MODEL, text: "Current variant, Bearer synthetic-sensitive-token", instruction: "Keep the facts, client_secret=synthetic-sensitive-secret" });
  const result = await f.service.suggest(request), call = f.calls.find(c => c.kind === "propose");
  assert.equal(call.model, OTHER_MODEL); const prompt = JSON.parse(call.prompt), scoped = prompt.scopedRequest;
  assert.deepEqual(scoped.context, context); assert.deepEqual(scoped.target, target); assert.deepEqual(scoped.confirmedMemory, []);
  assert.equal(f.memoryReads.length, 0); assert.equal(prompt.outputContract.edit.inSeconds, 0);
  for (const hidden of ["synthetic-sensitive-token", "synthetic-sensitive-secret", "UNREQUESTED_ACCOUNT_NAME", "DO_NOT_SEND_CONNECTION", "DO_NOT_SEND_SCOPES", "ACCOUNT_WIDE_NOTE_MUST_NOT_SEND"]) assert.ok(!call.prompt.includes(hidden));
  assert.equal(result.text, "A reviewed text proposal."); assert.equal(result.modelId, OTHER_MODEL); assert.equal(result.id, request.requestId);
  assert.equal(result.sourceTextDigest, hash(request.text)); assert.equal(result.instructionDigest, hash(request.instruction));
  const { digest, ...payload } = result; assert.equal(digest, hash(JSON.stringify(payload)));
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.target), true); assert.equal(Object.isFrozen(result.context), true);
  assert.throws(() => { result.text = "mutated"; }, TypeError);
  for (const forbidden of ["edit", "credential", "approval", "publication", "grant", "token"]) assert.equal(Object.hasOwn(result, forbidden), false);
});

test("confirmed memory is opt-in and limited to the exact target project even with a wider store response", async t => {
  const f = fixture(t); const result = await f.service.suggest(input({ includeMemory: true }));
  assert.deepEqual(f.memoryReads, [context]); const call = f.calls.find(c => c.kind === "propose");
  assert.ok(call.prompt.includes("CONFIRMED_TARGET_PROJECT_NOTE"));
  for (const excluded of ["UNCONFIRMED_NOTE_MUST_NOT_SEND", "ACCOUNT_WIDE_NOTE_MUST_NOT_SEND", "OTHER_PROJECT_MUST_NOT_SEND", "OTHER_ACCOUNT_MUST_NOT_SEND"]) assert.ok(!call.prompt.includes(excluded));
  assert.equal(result.memoryCount, 1); assert.equal(result.includeMemory, true); assert.ok(!JSON.stringify(result).includes("CONFIRMED_TARGET_PROJECT_NOTE"));
});

test("memory, prompt and output budgets preserve Unicode and redact supplied sensitive text", async t => {
  const f = fixture(t); f.notes.length = 0;
  for (let i = 0; i < 20; i++) f.notes.push({ accountId: ACCOUNT, projectId: PROJECT, reviewState: "confirmed", kind: "brand-voice", text: `Bearer secret${i} ` + "🎬".repeat(600) });
  f.controls.reply = output("Safe response, access_token=synthetic-secret");
  const result = await f.service.suggest(input({ text: "漢".repeat(10000), instruction: "語".repeat(2000), includeMemory: true }));
  const call = f.calls.find(c => c.kind === "propose"), scoped = JSON.parse(call.prompt).scopedRequest;
  assert.ok(Buffer.byteLength(call.prompt, "utf8") <= 64 * 1024); assert.ok(scoped.confirmedMemory.reduce((n, m) => n + m.text.length, 0) <= 4000);
  assert.ok(scoped.confirmedMemory.length <= 12); assert.equal(result.memoryTruncated, true);
  assert.ok(!call.prompt.includes("secret0")); assert.ok(!result.text.includes("synthetic-secret"));
  await assert.rejects(async () => f.service.suggest(input({ text: "x".repeat(10001) })));
});

test("request shape rejects implicit/mismatched context, instruction omission and authority injection before any CLI call", async t => {
  const f = fixture(t);
  for (const request of [input({ context: { accountId: ACCOUNT, projectId: OTHER_PROJECT } }), input({ target: { ...target, accountId: OTHER_ACCOUNT } }), input({ instruction: "" }),
    input({ allowRemote: false }), input({ includeMemory: undefined }), input({ publish: true }), input({ artifactId: randomUUID() }), input({ text: "unpaired \ud800" })]) {
    assert.equal(socialTextRequestSchema.safeParse(request).success, false); await assert.rejects(async () => f.service.suggest(request));
  }
  await assert.rejects(async () => f.service.suggest(input({ target: { ...target, destinationId: "different" } })), /social_ai_scope_changed/);
  assert.equal(f.calls.length, 0);
});

test("scope is rechecked after discovery and after completion", async t => {
  const f = fixture(t), gate = deferred(); f.controls.discoveryGate = gate;
  const pending = f.service.suggest(input()); const rejected = assert.rejects(pending, /social_ai_scope_changed/);
  await until(() => f.calls.length > 0); f.controls.destination = "changed"; gate.resolve(); await rejected;
  assert.equal(f.calls.some(c => c.kind === "propose"), false);
  const g = fixture(t), done = deferred(); g.controls.proposeGate = done;
  const inFlight = g.service.suggest(input()); const changed = assert.rejects(inFlight, /social_ai_scope_changed/);
  await until(() => g.calls.some(c => c.kind === "propose")); g.controls.status = "disconnected"; done.resolve(); await changed;
});

test("cancellation is explicitly request/context/target scoped and awaits operation cleanup", async t => {
  let cleaned = false;
  const f = fixture(t, { bridge: {
    async discover() { return { available: true, version: "1.19.5", models: [MODEL], auth: "cli-managed", error: null }; },
    async propose(_value, _events, signal) { await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); await delay(25); cleaned = true; throw new DOMException("hidden-sensitive-reason", "AbortError"); }
  } });
  const request = input(), pending = f.service.suggest(request), rejected = assert.rejects(pending, /social_ai_cancelled/);
  await delay(10);
  await assert.rejects(f.service.cancel({ requestId: request.requestId, context, target: { ...target, destinationId: "wrong" } }), /social_ai_request_not_found/);
  assert.equal(cleaned, false);
  await f.service.cancel({ requestId: request.requestId, context, target }); await rejected; assert.equal(cleaned, true);
});

test("service close cancels and awaits active calls; capacity is reserved before discovery awaits", async t => {
  const gate = deferred(); const f = fixture(t, { controls: { discoveryGate: gate } });
  const a = f.service.suggest(input()), b = f.service.suggest(input());
  const rejectedA = assert.rejects(a, /runtime_closing/), rejectedB = assert.rejects(b, /runtime_closing/);
  assert.throws(() => f.service.suggest(input()), /social_ai_busy/);
  await until(() => f.calls.filter(c => c.kind === "discover").length === 2);
  let closed = false; const closing = f.service.close().then(() => { closed = true; }); await delay(10); assert.equal(closed, false);
  gate.resolve(); await closing; await Promise.all([rejectedA, rejectedB]); assert.equal(closed, true);
  assert.throws(() => f.service.suggest(input()), /runtime_closing/); assert.equal(f.calls.some(c => c.kind === "propose"), false);
});

test("HTTP request cancellation reaches the owned one-shot call without returning late output", async t => {
  const f = fixture(t), gate = deferred(), controller = new AbortController(); f.controls.proposeGate = gate;
  const pending = f.service.suggest(input(), controller.signal), rejected = assert.rejects(pending, /social_ai_cancelled/);
  await until(() => f.calls.some(c => c.kind === "propose")); controller.abort("sensitive abort reason");
  assert.equal(f.calls.find(c => c.kind === "propose").signal.aborted, true); gate.resolve(); await rejected;
});

test("only the strict text carrier is accepted and arbitrary bridge diagnostics are sanitized", async t => {
  for (const reply of [output("x".repeat(2001)), { ...output(), edit: { ...output().edit, crop: "vertical" } }, { ...output(), edit: { ...output().edit, segments: [{ inSeconds: 0, outSeconds: 1 }] } },
    { ...output(), summary: "x".repeat(601) }, { ...output(), sessionId: "bad-session" }, { ...output(), publish: true }]) {
    const f = fixture(t, { controls: { reply } }); await assert.rejects(f.service.suggest(input()), /social_ai_protocol_error/);
  }
  const bad = fixture(t, { controls: { error: new Error("provider-secret sensitive stderr") } });
  await assert.rejects(bad.service.suggest(input()), e => e.code === "social_ai_process_failed" && !e.message.includes("secret"));
  const forged = fixture(t, { controls: { error: new WorkspaceError(502, "social_ai_secret_detail") } });
  await assert.rejects(forged.service.suggest(input()), e => e.code === "social_ai_process_failed");
});

test("timeouts and malformed discovery are bounded codes, not raw CLI output", async t => {
  const timeout = fixture(t, { bridge: { async discover() { throw new DOMException("sensitive provider detail", "TimeoutError"); }, async propose() { assert.fail("no inference after timeout"); } } });
  await assert.rejects(timeout.service.suggest(input()), e => e.code === "social_ai_timeout" && e.status === 504 && !e.message.includes("sensitive"));
  const malformed = fixture(t, { bridge: { async discover() { return { available: true, version: "secret version string", models: [MODEL], auth: "cli-managed", error: null }; }, async propose() { assert.fail("no inference after unsafe discovery"); } } });
  await assert.rejects(malformed.service.setup(), /social_ai_protocol_error/);
});

test("AI routes use only the text service, retain strict bodies and honor request abort signals", async t => {
  const f = fixture(t), forbiddenSocial = new Proxy({}, { get() { throw new Error("Publication service must not be touched by AI routes"); } });
  const base = "http://127.0.0.1:1";
  await assert.rejects(socialRoute(forbiddenSocial, "GET", new URL("/api/social/ai/setup", base), async () => ({})), /social_ai_unavailable/);
  const setup = await socialRoute(forbiddenSocial, "GET", new URL("/api/social/ai/setup", base), async () => ({}), { text: f.service });
  assert.deepEqual(setup.body.models, [MODEL, OTHER_MODEL]);
  const suggestion = await socialRoute(forbiddenSocial, "POST", new URL("/api/social/ai/suggest", base), async () => input(), { text: f.service });
  assert.equal(suggestion.body.text, "A reviewed text proposal.");
  await assert.rejects(socialRoute(forbiddenSocial, "POST", new URL("/api/social/ai/suggest", base), async () => input({ approval: true }), { text: f.service }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(socialRoute(forbiddenSocial, "POST", new URL("/api/social/ai/suggest", base), async () => input(), { text: f.service, signal: controller.signal }), /social_ai_cancelled/);
});

function processFixture(t, runScript) {
  const calls = [], AGENT = "atrisshare-proposal";
  const spawn = (executable, args, options) => {
    assert.equal(executable, process.execPath); assert.equal(options.shell, false);
    const cfg = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT), print = value => `process.stdout.write(${JSON.stringify(value)});`;
    let script;
    if (args[0] === "--version") script = print("1.19.5\n");
    else if (args[0] === "debug" && args[1] === "config") script = print(JSON.stringify(cfg));
    else if (args[0] === "debug") script = print(JSON.stringify({ name: AGENT, mode: "primary", options: {}, steps: 1, tools: { "*": false }, permission: [{ permission: "*", pattern: "*", action: "deny" }] }));
    else if (args[0] === "models") script = print(`${MODEL}\n`);
    else script = runScript;
    const child = nodeSpawn(process.execPath, ["-e", script], options); calls.push({ args, options, child }); return child;
  };
  const native = new OpenCodeBridge({ executable: process.execPath, spawn, timeoutMs: 15000 });
  const f = fixture(t, { bridge: native });
  return { ...f, processCalls: calls, native };
}
async function assertClean(calls) {
  for (const c of calls) { assert.notEqual(c.child.exitCode ?? c.child.signalCode, null); await assert.rejects(access(dirname(c.options.cwd)), { code: "ENOENT" }); }
}

test("real one-shot process adapter uses stdin, deny-all isolation and exact selected model without inference", async t => {
  const body = output(); delete body.sessionId;
  const sessionID = "ses_social_text_fixture", event = (type, part) => JSON.stringify({ type, sessionID, part: { ...part, sessionID } });
  const wire = [event("step_start", { id: "start", type: "step-start" }), event("text", { id: "text", type: "text", text: JSON.stringify(body) }), event("step_finish", { id: "finish", type: "step-finish", reason: "stop" })].join("\n") + "\n";
  const script = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const p=JSON.parse(input);if(p.scopedRequest.currentVariant!=='This is the current variant.'||p.scopedRequest.confirmedMemory.length!==0)process.exitCode=9;else process.stdout.write(${JSON.stringify(wire)});});`;
  const f = processFixture(t, script); const result = await f.service.suggest(input()); assert.equal(result.text, body.edit.caption);
  const call = f.processCalls.find(c => c.args[0] === "run"); assert.equal(call.args[call.args.indexOf("--model") + 1], MODEL);
  assert.ok(!call.args.some(arg => arg.includes("current variant"))); const config = JSON.parse(call.options.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.mcp, {}); assert.deepEqual(config.plugin, []); assert.equal(config.tools["*"], false); assert.equal(config.permission["*"], "deny");
  await assertClean(f.processCalls);
});

test("text-service close kills a real controlled inference child/grandchild and awaits workspace cleanup", async t => {
  const script = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync('grandchild.pid',String(child.pid));setInterval(()=>{},1000);`;
  const f = processFixture(t, script), pending = f.service.suggest(input()), rejected = assert.rejects(pending, /runtime_closing/);
  await until(() => f.processCalls.some(c => c.args[0] === "run"));
  const call = f.processCalls.find(c => c.args[0] === "run"); let pid;
  for (let i = 0; i < 300; i++) { if ((await readdir(call.options.cwd)).includes("grandchild.pid")) { pid = Number(await readFile(join(call.options.cwd, "grandchild.pid"), "utf8")); break; } await delay(10); }
  assert.ok(Number.isSafeInteger(pid)); await f.service.close(); await rejected;
  let alive = true; for (let i = 0; i < 200; i++) { try { process.kill(pid, 0); } catch { alive = false; break; } await delay(10); }
  assert.equal(alive, false); await assertClean(f.processCalls);
});

test("text adapter output budget never exposes the edit carrier or starts any application operation", async () => {
  const oneShot = { async discover() { throw new Error("not used"); }, async propose() { return output("Only generated text"); } };
  const bridge = new OpenCodeTextBridge(oneShot);
  assert.deepEqual(await bridge.complete({ modelId: MODEL, prompt: JSON.stringify({ task: "Text only" }) }, new AbortController().signal), { text: "Only generated text", summary: "Shortened this variant.", sessionId: "ses_social_text_fixture" });
});
