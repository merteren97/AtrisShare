import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verifyRuntime } from "../scripts/package-inventory.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function standalone() {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-staged-"));
  try {
    const original = join(root, "apps", "desktop", "src-tauri", "runtime");
    const manifest = await verifyRuntime(original, { root });
    const runtime = join(directory, "runtime");
    await cp(original, runtime, { recursive: true, errorOnExist: true, force: false });
    await verifyRuntime(runtime);
    const node = join(runtime, process.platform === "win32" ? "node.exe" : "node");
    const { stdout } = await promisify(execFile)(node, ["--version"], { cwd: directory, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } });
    assert.equal(stdout.trim(), `v${manifest.node}`);
    return { directory, runtime, node };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

test("staged runtime starts independently and exits when its owner closes stdin", async t => {
  const { directory, runtime, node } = await standalone();
  const token = randomBytes(32).toString("hex");
  const child = spawn(node, [join(runtime, "api.mjs")], {
    cwd: directory, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", ATRIS_SHARE_RUNTIME_TOKEN: token, ATRIS_SHARE_DATA_DIR: directory,
      ATRIS_SHARE_PARENT_PID: String(process.pid), ATRIS_SHARE_DEV_ORIGIN: "" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exit; }
    await rm(directory, { recursive: true, force: true });
  });
  let diagnostics = "";
  child.stderr.on("data", bytes => { diagnostics = `${diagnostics}${bytes}`.slice(-8000).replaceAll(token, "[REDACTED]"); });
  const exit = new Promise(resolve => child.once("exit", code => resolve(code)));
  const ready = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Runtime timeout: ${diagnostics}`)), 15000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Runtime exited ${code}: ${diagnostics}`)); });
    child.stdout.on("data", bytes => {
      output += bytes;
      const line = output.split("\n").find(value => value.startsWith("ATRIS_SHARE_READY "));
      if (line) { clearTimeout(timeout); resolve(JSON.parse(line.slice("ATRIS_SHARE_READY ".length))); }
    });
  });
  assert.equal(ready.pid, child.pid);
  const response = await fetch(`${ready.origin}/api/workspace`, { headers: { Authorization: `Bearer ${token}`, Origin: "http://tauri.localhost" } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).accounts, []);
  child.stdin.end();
  assert.equal(await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve("timeout"), 6000).unref())]), 0);
});

test("relocated packaged MCP completes SDK handshake and tool call without checkout dependencies", { timeout: 30000 }, async t => {
  const { directory, runtime, node } = await standalone();
  let client;
  const grant = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${grant}`) { response.writeHead(401); response.end(); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/api/mcp/capabilities" ? {
      tools: ["media_inspect"], expiresAt: new Date(Date.now() + 60_000).toISOString(), includeMemory: false,
      includeTranscript: false, scope: { accountId: "fixture-account", projectId: "fixture-project", artifactId: "fixture-source", destinationId: "fixture-destination" }
    } : { fixture: "standalone-packaged-mcp" }));
  });
  t.after(async () => {
    try { await client?.close(); }
    finally {
      if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await rm(directory, { recursive: true, force: true });
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const transport = new StdioClientTransport({ command: node, args: [join(runtime, "mcp.mjs")], cwd: directory,
    env: { NODE_OPTIONS: "", NODE_PATH: "", ATRIS_SHARE_MCP_ORIGIN: `http://127.0.0.1:${server.address().port}`, ATRIS_SHARE_MCP_GRANT: grant }, stderr: "pipe" });
  client = new Client({ name: "packaged-runtime-fixture", version: "1" });
  await client.connect(transport, { timeout: 15000 });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["media_inspect"]);
  const result = await client.callTool({ name: "media_inspect", arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text), { fixture: "standalone-packaged-mcp" });
  await client.close();
});
