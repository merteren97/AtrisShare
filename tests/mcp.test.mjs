import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { APP_VERSION } from "../dist/packages/domain/src/workspace.js";

const ENTRY = fileURLToPath(new URL("../dist/services/mcp-server/src/index.js", import.meta.url));
const LIMIT = 1024 * 1024;
const TOOLS = ["media_inspect", "timeline_read", "memory_read", "timeline_propose", "render_preview", "render_status", "publication_request"];
const SCOPE = {
  accountId: "10000000-0000-4000-8000-000000000001", projectId: "10000000-0000-4000-8000-000000000002",
  artifactId: "10000000-0000-4000-8000-000000000003", destinationId: "10000000-0000-4000-8000-000000000004"
};
const EDIT = { inSeconds: 0, outSeconds: 3, crop: "vertical", gainDb: -3, caption: "Synthetic 🎬" };
const PROPOSE = { summary: "Trim the scoped source", baseRevision: 0, edit: EDIT };
const PUBLICATION = { title: "Review only", description: "Synthetic description", visibility: "private", madeForKids: false, notifySubscribers: false };
const PRIVATE_ERROR = "private-response-never-log";
const json = (response, value, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};
const toolError = (result, code) => {
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ error: code }) }]);
};

async function fixture(t, options = {}) {
  const grant = randomBytes(32).toString("hex");
  const requests = [];
  const capabilities = { tools: TOOLS, expiresAt: new Date(Date.now() + 60_000).toISOString(), scope: SCOPE,
    includeMemory: true, ...options.capabilities };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const entry = { method: request.method, url: request.url, authorization: request.headers.authorization,
      body: body ? JSON.parse(body) : null };
    requests.push(entry);
    if (entry.authorization !== `Bearer ${grant}`) return json(response, { error: PRIVATE_ERROR }, 401);
    if (entry.url === "/api/mcp/capabilities" && entry.method === "GET") {
      if (options.discovery) return options.discovery(request, response, capabilities);
      return json(response, capabilities);
    }
    if (entry.url === "/api/mcp/call" && entry.method === "POST") {
      if (options.call) return options.call(request, response, entry.body);
      return json(response, { fixture: true, tool: entry.body.tool });
    }
    json(response, { error: PRIVATE_ERROR }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { grant, requests, capabilities, origin: `http://127.0.0.1:${server.address().port}` };
}

async function connect(t, fixture) {
  const messages = [], errors = [];
  let stderr = "";
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], stderr: "pipe",
    env: { ATRIS_SHARE_MCP_ORIGIN: fixture.origin, ATRIS_SHARE_MCP_GRANT: fixture.grant,
      // A different API bearer must never be selected or sent.
      ATRIS_SHARE_API_TOKEN: "regular-api-bearer-sentinel" } });
  transport.stderr.on("data", chunk => { stderr += chunk; });
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    const onmessage = transport.onmessage;
    transport.onmessage = message => { messages.push(message); onmessage?.(message); };
  };
  const client = new Client({ name: "atris-share-mcp-test", version: "1.0.0" });
  client.onerror = error => errors.push(error.message);
  t.after(async () => {
    const pid = transport.pid;
    await client.close();
    if (pid !== null) {
      let alive = true;
      for (let attempt = 0; attempt < 200; attempt++) {
        try { process.kill(pid, 0); } catch { alive = false; break; }
        await delay(10);
      }
      assert.equal(alive, false, "owned stdio child must exit when the client closes");
    }
    assert.equal(stderr, "", "successful startup and tool failures must not log private data");
    assert.deepEqual(errors, [], "stdout must contain only valid MCP messages");
    assert.ok(!JSON.stringify(messages).includes(fixture.grant));
    assert.ok(!JSON.stringify(messages).includes("regular-api-bearer-sentinel"));
  });
  await client.connect(transport);
  return client;
}

test("official SDK stdio handshake exposes only granted static tools and forwards scoped inspect/propose", async t => {
  const f = await fixture(t, { capabilities: { tools: ["media_inspect", "timeline_propose", "memory_read", "media_download", "publish"], includeMemory: false } });
  const client = await connect(t, f);
  assert.deepEqual(client.getServerVersion(), { name: "atris-share", version: APP_VERSION });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ["media_inspect", "timeline_propose"]);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(await client.callTool({ name: "media_inspect", arguments: {} }),
    { content: [{ type: "text", text: JSON.stringify({ fixture: true, tool: "media_inspect" }) }] });
  await client.callTool({ name: "timeline_propose", arguments: PROPOSE });
  assert.deepEqual(f.requests, [
    { method: "GET", url: "/api/mcp/capabilities", authorization: `Bearer ${f.grant}`, body: null },
    { method: "POST", url: "/api/mcp/call", authorization: `Bearer ${f.grant}`, body: { tool: "media_inspect", arguments: {} } },
    { method: "POST", url: "/api/mcp/call", authorization: `Bearer ${f.grant}`, body: { tool: "timeline_propose", arguments: PROPOSE } }
  ]);
  for (const name of ["publish", "approve", "revoke", "vault", "fs", "media_transcribe", "memory_read", "render_status", "__proto__", "constructor", f.grant]) {
    toolError(await client.callTool({ name, arguments: {} }), "mcp_tool_unavailable");
  }
  assert.equal(f.requests.length, 3, "unsupported operations must never reach HTTP");
});

test("all seven strict schemas permit only their documented arguments, never scope overrides", async t => {
  const f = await fixture(t);
  const client = await connect(t, f);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), TOOLS);
  const valid = { media_inspect: {}, timeline_read: {}, memory_read: {}, timeline_propose: PROPOSE,
    render_preview: { proposalId: SCOPE.artifactId }, render_status: { renderId: SCOPE.artifactId }, publication_request: PUBLICATION };
  for (const [name, args] of Object.entries(valid)) {
    assert.notEqual((await client.callTool({ name, arguments: args })).isError, true);
    for (const field of ["accountId", "projectId", "artifactId", "destinationId", "path", "grant"]) {
      toolError(await client.callTool({ name, arguments: { ...args, [field]: f.grant } }), "mcp_invalid_arguments");
    }
  }
  const invalid = [
    ["timeline_propose", { ...PROPOSE, summary: "" }],
    ["timeline_propose", { ...PROPOSE, summary: "x".repeat(2001) }],
    ["timeline_propose", { ...PROPOSE, baseRevision: -1 }],
    ["timeline_propose", { ...PROPOSE, baseRevision: 1.5 }],
    ["timeline_propose", { ...PROPOSE, edit: { ...EDIT, outSeconds: 0 } }],
    ["timeline_propose", { ...PROPOSE, edit: { ...EDIT, inSeconds: 4 } }],
    ["timeline_propose", { ...PROPOSE, edit: { ...EDIT, path: f.grant } }],
    ["timeline_propose", { ...PROPOSE, edit: { ...EDIT, segments: [{ inSeconds: 0, outSeconds: 4 }] } }],
    ["render_preview", { proposalId: "not-a-uuid" }], ["render_status", { renderId: "not-a-uuid" }],
    ["publication_request", { ...PUBLICATION, title: "" }],
    ["publication_request", { ...PUBLICATION, title: "x".repeat(101) }],
    ["publication_request", { ...PUBLICATION, description: "x".repeat(5001) }],
    ["publication_request", { ...PUBLICATION, visibility: "friends" }],
    ["publication_request", { ...PUBLICATION, madeForKids: "false" }],
    ["publication_request", { ...PUBLICATION, notifySubscribers: undefined }]
  ];
  for (const [name, args] of invalid) toolError(await client.callTool({ name, arguments: args }), "mcp_invalid_arguments");
  assert.equal(f.requests.length, 1 + TOOLS.length);
  const { tools } = await client.listTools();
  assert.equal(tools.find(tool => tool.name === "timeline_propose").inputSchema.properties.edit.additionalProperties, false);
});

test("empty or entirely unsupported capability lists remain valid empty MCP servers", async t => {
  for (const tools of [[], ["publish", "media_download", "memory_read"]]) await t.test(JSON.stringify(tools), async t => {
    const f = await fixture(t, { capabilities: { tools, includeMemory: false } });
    const client = await connect(t, f);
    assert.deepEqual((await client.listTools()).tools, []);
    toolError(await client.callTool({ name: "media_inspect", arguments: {} }), "mcp_tool_unavailable");
    assert.equal(f.requests.length, 1);
  });
});

test("upstream revocation returns a fixed grant error with no private response data", async t => {
  for (const status of [401, 403]) await t.test(String(status), async t => {
    const f = await fixture(t, { call: (_request, response) => json(response, { error: PRIVATE_ERROR }, status) });
    const client = await connect(t, f);
    toolError(await client.callTool({ name: "media_inspect", arguments: {} }), "mcp_grant_rejected");
  });
});

test("a grant that expires after handshake cannot dispatch another HTTP call", async t => {
  const f = await fixture(t, { capabilities: { expiresAt: new Date(Date.now() + 2000).toISOString() } });
  const client = await connect(t, f);
  await delay(Math.max(0, Date.parse(f.capabilities.expiresAt) - Date.now() + 20));
  toolError(await client.callTool({ name: "media_inspect", arguments: {} }), "mcp_grant_expired");
  assert.equal(f.requests.length, 1);
});

test("arbitrary validated JSON results survive exactly; malformed, oversized and redirect responses fail closed", async t => {
  let mode;
  const f = await fixture(t, { call: (_request, response) => {
    if (mode === "redirect") { response.writeHead(302, { Location: `${f.origin}/leak` }); response.end(PRIVATE_ERROR); }
    else if (mode === "declared-limit") { response.writeHead(200, { "Content-Length": LIMIT + 1 }); response.end(); }
    else if (mode === "stream-limit") { response.writeHead(200); response.write('"'); response.end("x".repeat(LIMIT)); }
    else if (mode === "bad-json") response.end(PRIVATE_ERROR);
    else if (mode === "bad-utf8") response.end(Buffer.from([0x22, 0xff, 0x22]));
    else if (mode === "nonfinite") response.end("1e999");
    else if (mode === "error") json(response, { error: PRIVATE_ERROR }, 500);
    else json(response, mode);
  } });
  const client = await connect(t, f);
  for (const value of [null, true, 42, "Synthetic 🎬", [1, { nested: [false, null] }], { arbitrary: { proposal: "fixture" } }, "x".repeat(LIMIT - 2)]) {
    mode = value;
    assert.deepEqual(await client.callTool({ name: "media_inspect", arguments: {} }),
      { content: [{ type: "text", text: JSON.stringify(value) }] });
  }
  for (const [value, code] of [["redirect", "mcp_http_error"], ["declared-limit", "mcp_response_limit"], ["stream-limit", "mcp_response_limit"],
    ["bad-json", "mcp_response_invalid"], ["bad-utf8", "mcp_response_invalid"], ["nonfinite", "mcp_response_invalid"], ["error", "mcp_http_error"]]) {
    mode = value;
    toolError(await client.callTool({ name: "media_inspect", arguments: {} }), code);
  }
  assert.ok(f.requests.every(request => request.url === "/api/mcp/capabilities" || request.url === "/api/mcp/call"));
});

async function rawChild(env, input) {
  const child = spawn(process.execPath, [ENTRY], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
  // Keep stdin open unless this fixture explicitly requests EOF.
  if (input !== undefined) child.stdin.end(input);
  return { child, done };
}

test("configuration rejects alternate origins/credentials/paths and missing or malformed grants without token output", async () => {
  const grant = randomBytes(32).toString("hex");
  const origins = [undefined, "http://localhost:1234", "https://127.0.0.1:1234", "http://127.0.0.2:1234", "http://[::1]:1234",
    "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:01234", "http://127.0.0.1:1234/",
    "http://127.0.0.1:1234/api", "http://127.0.0.1:1234?token=" + grant, "http://127.0.0.1:1234#" + grant,
    `http://${grant}@127.0.0.1:1234`, "http://2130706433:1234", "http://127.1:1234", " http://127.0.0.1:1234"];
  const cases = [...origins.map(origin => ({ ...(origin === undefined ? {} : { ATRIS_SHARE_MCP_ORIGIN: origin }), ATRIS_SHARE_MCP_GRANT: grant })),
    ...[undefined, "", "a".repeat(63), "g".repeat(64), "a".repeat(65), grant + "\n"].map(value => ({ ATRIS_SHARE_MCP_ORIGIN: "http://127.0.0.1:1234",
      ...(value === undefined ? {} : { ATRIS_SHARE_MCP_GRANT: value }), ATRIS_SHARE_API_TOKEN: grant }))];
  for (const env of cases) {
    const { done } = await rawChild(env);
    assert.deepEqual(await done, { code: 1, signal: null, stdout: "", stderr: "mcp_invalid_configuration\n" });
  }
});

test("expired/malformed/denied startup capabilities print only one fixed error code to stderr", async t => {
  for (const [override, code] of [[{ expiresAt: new Date(0).toISOString() }, "mcp_grant_expired"],
    [{ includeMemory: "true" }, "mcp_capabilities_invalid"], [{ scope: { ...SCOPE, path: PRIVATE_ERROR } }, "mcp_capabilities_invalid"]]) await t.test(code, async t => {
    const f = await fixture(t, { capabilities: override });
    const { done } = await rawChild({ ATRIS_SHARE_MCP_ORIGIN: f.origin, ATRIS_SHARE_MCP_GRANT: f.grant });
    assert.deepEqual(await done, { code: 1, signal: null, stdout: "", stderr: `${code}\n` });
  });
  await t.test("denied", async t => {
    const f = await fixture(t, { discovery: (_request, response) => json(response, { error: PRIVATE_ERROR }, 401) });
    const { done } = await rawChild({ ATRIS_SHARE_MCP_ORIGIN: f.origin, ATRIS_SHARE_MCP_GRANT: f.grant });
    assert.deepEqual(await done, { code: 1, signal: null, stdout: "", stderr: "mcp_grant_rejected\n" });
  });
});

test("importing the entrypoint has no stdio/server side effects", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../dist/services/mcp-server/src/index.js", import.meta.url).href)});`],
    { env: {}, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  assert.deepEqual(await once(child, "close"), [0, null]);
  assert.equal(output, "");
});

test("stdio EOF aborts an owned in-flight HTTP call and exits cleanly without forced termination", { timeout: 10_000 }, async t => {
  let called;
  const pendingCall = new Promise(resolve => { called = resolve; });
  const f = await fixture(t, { call: () => called() });
  const { child, done } = await rawChild({ ATRIS_SHARE_MCP_ORIGIN: f.origin, ATRIS_SHARE_MCP_GRANT: f.grant });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "lifecycle-fixture", version: "1.0.0" }
  } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "media_inspect", arguments: {} } }) + "\n");
  await pendingCall;
  child.stdin.end();
  const result = await done;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(f.grant));
  for (const line of result.stdout.trim().split("\n")) assert.equal(JSON.parse(line).jsonrpc, "2.0");
});

test("stdio EOF also aborts pending capability discovery without losing or logging protocol input", { timeout: 10_000 }, async t => {
  let discovered;
  const discovery = new Promise(resolve => { discovered = resolve; });
  const f = await fixture(t, { discovery: () => discovered() });
  const { child, done } = await rawChild({ ATRIS_SHARE_MCP_ORIGIN: f.origin, ATRIS_SHARE_MCP_GRANT: f.grant });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await discovery;
  child.stdin.end();
  assert.deepEqual(await done, { code: 0, signal: null, stdout: "", stderr: "" });
});

test("HTTP timeout covers a stalled response body at the fixed 30-second boundary", { timeout: 40_000 }, async t => {
  let closed;
  const bodyClosed = new Promise(resolve => { closed = resolve; });
  let stall = true;
  const f = await fixture(t, { call: (_request, response) => {
    if (!stall) return json(response, { recovered: true });
    response.once("close", closed);
    response.writeHead(200);
    response.write('{"partial":');
  } });
  const client = await connect(t, f);
  const started = Date.now();
  toolError(await client.callTool({ name: "media_inspect", arguments: {} }, undefined, { timeout: 35_000 }), "mcp_http_timeout");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 29_000 && elapsed < 35_000, `HTTP deadline must fire around 30 seconds, took ${elapsed}ms`);
  await bodyClosed;
  stall = false;
  assert.deepEqual(await client.callTool({ name: "media_inspect", arguments: {} }),
    { content: [{ type: "text", text: JSON.stringify({ recovered: true }) }] });
});
