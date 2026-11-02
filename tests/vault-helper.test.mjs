import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { win32 } from "node:path";
import { test } from "node:test";
import { dpapi } from "../dist/packages/storage/src/vault.js";

function helper() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  let kills = 0, received = "", calls = 0, script = "";
  child.kill = () => { kills++; return true; };
  child.stdin.on("data", bytes => { received += bytes; });
  const spawn = (exe, args, options) => {
    calls++;
    assert.ok(win32.isAbsolute(exe)); assert.match(exe, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    assert.equal(options.windowsHide, true); assert.deepEqual(options.stdio, ["pipe", "pipe", "ignore"]);
    script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    assert.ok(!script.includes("synthetic-vault-secret"));
    return child;
  };
  return { child, spawn, get kills() { return kills; }, get received() { return received; }, get calls() { return calls; }, get script() { return script; } };
}
test("cold Windows DPAPI probe survives the old 8s deadline and round-trips in one hidden helper", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = helper(), bytes = Buffer.from("synthetic-vault-secret");
  const result = dpapi(bytes, "RoundTrip", { spawn: f.spawn });
  t.mock.timers.tick(8001); assert.equal(f.kills, 0);
  assert.equal(f.calls, 1); assert.match(f.script, /::Protect\(/); assert.match(f.script, /::Unprotect\(/);
  assert.equal(f.received, bytes.toString("base64"));
  f.child.stdout.write(bytes.toString("base64")); f.child.emit("close", 0);
  assert.deepEqual(await result, bytes);
  t.mock.timers.tick(15000); assert.equal(f.kills, 0, "successful close clears the deadline");
});
test("a timed-out DPAPI helper is killed and awaited, even if it later reports a successful exit", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = helper(); let settled = false;
  const result = dpapi(Buffer.from("synthetic-vault-secret"), "Protect", { spawn: f.spawn });
  const rejection = assert.rejects(result, /credential operation timed out/).finally(() => { settled = true; });
  t.mock.timers.tick(15000); await Promise.resolve(); assert.equal(f.kills, 1); assert.equal(settled, false);
  f.child.stdout.write(Buffer.from("late-output").toString("base64")); f.child.emit("close", 0);
  await rejection;
});
test("malformed, empty and oversized helper output cannot be accepted as a credential", async t => {
  for (const output of ["", "untrusted diagnostic / not base64", "a".repeat(256 * 1024 + 1)]) await t.test(String(output.length), async () => {
    const f = helper(), result = dpapi(Buffer.from("synthetic-vault-secret"), "Unprotect", { spawn: f.spawn });
    const rejection = assert.rejects(result, /OS credential operation failed/);
    f.child.stdout.write(output); f.child.emit("close", 0); await rejection;
  });
});
