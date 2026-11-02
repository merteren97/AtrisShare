import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { SocialTextService } from "../dist/services/local-api/src/social-text.js";
import { socialRoute } from "../dist/services/local-api/src/social-routes.js";
import { WorkspaceError } from "../dist/packages/storage/src/config.js";

/** Synthetic local HTTP harness only. Never imported into the runtime bundle. */
export async function startSocialTextHttpFixture(port = 0) {
  const accountId = "11111111-1111-4111-8111-111111111111", projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const secondProject = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", token = "synthetic-local-ui-runtime-0000000000000000";
  const account = { id: accountId, platform: "x", displayName: "Local fixture account", destinationId: "123456", status: "connected", createdAt: new Date().toISOString() };
  const context = { accountId, projectId }, target = { ...context, destinationId: account.destinationId };
  const models = ["fixture/first-discovered-model", "fixture/second-discovered-model"];
  const stats = { discoveries: 0, started: 0, completed: 0, cancelled: 0, prompts: [], modelIds: [], delays: 350 };
  const store = {
    resolveContext(v) { if (v.accountId !== accountId || ![projectId, secondProject].includes(v.projectId)) throw new WorkspaceError(404, "context_not_found"); return v; },
    listAccounts() { return [account]; },
    listMemory(v) { return [{ id: randomUUID(), ...v, kind: "brand-voice", reviewState: "confirmed", text: "Keep this exact project’s voice concise and factual." }]; }
  };
  const text = new SocialTextService(store, { bridge: {
    async discover(signal) { signal.throwIfAborted(); stats.discoveries++; return { available: true, version: "1.19.5", models, auth: "cli-managed", error: null }; },
    async propose(input, _onEvent, signal) {
      stats.started++; stats.prompts.push(JSON.parse(input.prompt).scopedRequest); stats.modelIds.push(input.model);
      try { await delay(stats.delays, undefined, { signal }); stats.completed++;
        return { summary: "A controlled local text proposal; no model inference was run.", edit: { inSeconds: 0, outSeconds: 1, crop: "original", gainDb: 0, caption: "A concise launch message, ready for human review." }, sessionId: "ses_http_ui_fixture" };
      } catch { stats.cancelled++; await delay(15); throw new DOMException("ai_cancelled", "AbortError"); }
    }
  } });
  const social = { async setup() { return ["x", "linkedin", "tiktok"].map(provider => ({ provider, configured: provider === "x", available: provider === "x", reason: provider === "x" ? null : "social_not_configured", scopes: [], audited: false, publicApp: false })); },
    accounts() { return [{ accountId, provider: "x", destinationId: account.destinationId, displayName: account.displayName, status: "connected", destinationKind: "user", subjectId: "123456", scopes: [], verifiedAt: new Date().toISOString(), revision: 1 }]; },
    async verify() { return { provider: "x", destinationId: account.destinationId, verifiedAt: new Date().toISOString(), text: true, video: true, readback: true, reasons: [], creator: null, maxBytes: 8 * 1024 ** 3, maxDuration: 1200 }; },
    posts() { return []; }
  };
  let origin = "", closing;
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:1458");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    const send = (status, value) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); } };
    const work = async () => {
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      if (req.headers.authorization !== `Bearer ${token}`) throw new WorkspaceError(401, "unauthorized");
      const url = new URL(req.url, origin), abort = new AbortController();
      const cancelled = () => { if (!res.writableEnded) abort.abort(); };
      req.once("aborted", cancelled); res.once("close", cancelled);
      const body = async () => { let data = ""; for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 128 * 1024) throw new WorkspaceError(413, "body_too_large"); } return JSON.parse(data); };
      try {
        if (url.pathname === "/api/test/shutdown") { send(200, { closing: true }); setImmediate(() => { void close(); }); return; }
        if (url.pathname === "/api/test/stats") { send(200, stats); return; }
        if (url.pathname === "/api/projects") { send(200, [{ id: projectId, accountId, name: "Launch project", description: "", createdAt: account.createdAt }, { id: secondProject, accountId, name: "Another target project", description: "", createdAt: account.createdAt }]); return; }
        if (url.pathname === "/api/studio") { send(200, { artifacts: [] }); return; }
        const result = await socialRoute(social, req.method, url, body, { text, signal: abort.signal });
        if (result) send(result.status, result.body); else send(404, { error: "not_found" });
      } finally { req.off("aborted", cancelled); res.off("close", cancelled); }
    };
    void work().catch(e => send(e instanceof WorkspaceError ? e.status : 400, { error: e instanceof WorkspaceError ? e.code : "invalid_input" }));
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  function close() { return closing ??= text.close().then(() => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); })); }
  return { origin, token, context, target, models, stats, close };
}

if (process.argv.includes("--serve")) {
  const port = Number(process.argv.find(v => v.startsWith("--port="))?.slice(7) ?? 1459);
  const fixture = await startSocialTextHttpFixture(port); console.log(`Controlled social text UI fixture: ${fixture.origin}`);
} else {
  test("authenticated HTTP text routes discover/select an actual controlled model and return only a suggestion", async t => {
    const f = await startSocialTextHttpFixture(); t.after(() => f.close());
    const headers = { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" };
    assert.equal((await fetch(`${f.origin}/api/social/ai/setup`)).status, 401);
    const setup = await (await fetch(`${f.origin}/api/social/ai/setup`, { headers })).json(); assert.deepEqual(setup.models, f.models);
    const response = await fetch(`${f.origin}/api/social/ai/suggest`, { method: "POST", headers, body: JSON.stringify({ requestId: randomUUID(), context: f.context, target: f.target,
      modelId: f.models[1], text: "Current variant", instruction: "Shorten it", includeMemory: false, allowRemote: true }) });
    assert.equal(response.status, 200); const proposal = await response.json(); assert.equal(proposal.modelId, f.models[1]); assert.equal(proposal.memoryCount, 0);
    assert.equal(Object.hasOwn(proposal, "edit"), false); assert.equal(Object.hasOwn(proposal, "approval"), false);
  });
  test("HTTP response disconnect aborts text generation and awaits controlled cleanup", async t => {
    const f = await startSocialTextHttpFixture(); t.after(() => f.close()); f.stats.delays = 10000;
    const controller = new AbortController();
    const pending = fetch(`${f.origin}/api/social/ai/suggest`, { method: "POST", headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ requestId: randomUUID(), context: f.context, target: f.target, modelId: f.models[0], instruction: "Refine", text: "Original", includeMemory: false, allowRemote: true }) });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    for (let i = 0; !f.stats.started && i < 200; i++) await delay(5);
    assert.equal(f.stats.started, 1); controller.abort(); await rejected;
    for (let i = 0; !f.stats.cancelled && i < 200; i++) await delay(5);
    assert.equal(f.stats.cancelled, 1); assert.equal(f.stats.completed, 0);
  });
}
