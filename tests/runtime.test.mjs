import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("staged runtime starts independently and exits when its owner closes stdin", async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const directory = await mkdtemp(join(tmpdir(), "atris-share-staged-"));
  const runtime = join(root, "apps", "desktop", "src-tauri", "runtime");
  const token = randomBytes(32).toString("hex");
  const child = spawn(join(runtime, process.platform === "win32" ? "node.exe" : "node"), [join(runtime, "api.mjs")], {
    cwd: directory, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", ATRIS_SHARE_RUNTIME_TOKEN: token, ATRIS_SHARE_DATA_DIR: directory,
      ATRIS_SHARE_PARENT_PID: String(process.pid), ATRIS_SHARE_DEV_ORIGIN: "" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(async () => { if (child.exitCode === null) child.kill(); await rm(directory, { recursive: true, force: true }); });
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
