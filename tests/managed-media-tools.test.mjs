import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { ManagedMediaTools } from "../dist/services/local-api/src/managed-media-tools.js";

const content = { ffmpeg: "verified ffmpeg fixture", ffprobe: "verified ffprobe fixture", LICENSE: "full license fixture", README: "source notices fixture" };
const assets = Object.entries(content).map(([file, value]) => ({ file, name: file, gzip: file.startsWith("ff"),
  sha256: createHash("sha256").update(value).digest("hex"), size: Buffer.byteLength(value) }));
const absent = { available: false, ffmpeg: false, ffprobe: false };
const probe = async paths => {
  const check = async (path, expected) => !!path && await readFile(path, "utf8").catch(() => "") === expected;
  const ffmpeg = await check(paths.ffmpegPath, content.ffmpeg), ffprobe = await check(paths.ffprobePath, content.ffprobe);
  return { available: ffmpeg && ffprobe, ffmpeg, ffprobe };
};
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atris-managed-tools-"));
  const calls = [], managers = [];
  const download = async url => {
    const name = new URL(url).pathname.split("/").at(-1); calls.push(name);
    return new Response(name.startsWith("ff") ? gzipSync(content[name]) : content[name]);
  };
  const create = extra => {
    const manager = new ManagedMediaTools(directory, { assets, probe, fetch: download, ...options, ...extra }); managers.push(manager); return manager;
  };
  t.after(async () => { await Promise.all(managers.map(m => m.close())); await rm(directory, { recursive: true, force: true }); });
  return { create, calls };
}

test("background provisioning is single-flight, verifies files and reuses its cache offline after restart", async t => {
  const { create, calls } = await fixture(t);
  const manager = create(); const paths = await manager.initialize({});
  assert.equal(manager.view().state, "preparing");
  await Promise.all([manager.retry(), manager.retry()]);
  assert.equal(manager.view().state, "ready");
  assert.deepEqual(calls, ["LICENSE", "README", "ffmpeg", "ffprobe"]);
  assert.equal((await probe(paths)).available, true);
  await manager.close();
  const restarted = create({ fetch: async () => { throw new Error("offline cache must not download"); } });
  assert.deepEqual(await restarted.initialize({}), paths);
  await restarted.retry(); assert.equal(restarted.view().state, "ready");
});

test("working existing tools are preserved without making a network request", async t => {
  const { create, calls } = await fixture(t, { probe: async () => ({ available: true, ffmpeg: true, ffprobe: true }) });
  const manager = create(); const existing = { ffmpegPath: "/existing/ffmpeg", ffprobePath: "/existing/ffprobe" };
  assert.deepEqual(await manager.initialize(existing), existing);
  await manager.retry(); assert.equal(manager.view().state, "ready"); assert.deepEqual(calls, []);
});

test("wrong hashes and oversized responses never activate binaries, partial files are removed and retry recovers", async t => {
  const { create } = await fixture(t);
  for (const payload of ["x".repeat(content.ffmpeg.length), "x".repeat(content.ffmpeg.length + 1)]) {
    let bad = true;
    const manager = create({ fetch: async url => {
      const name = new URL(url).pathname.split("/").at(-1);
      return new Response(name.startsWith("ff") ? gzipSync(bad && name === "ffmpeg" ? payload : content[name]) : content[name]);
    } });
    const paths = await manager.initialize({}); await manager.retry();
    assert.equal(manager.view().state, "retrying");
    assert.equal(await readFile(paths.ffmpegPath).catch(() => null), null);
    assert.ok(!(await readdir(dirname(paths.ffmpegPath))).some(name => name.endsWith(".partial")));
    bad = false; await manager.retry(); assert.equal(manager.view().state, "ready");
    await manager.close();
    await rm(dirname(paths.ffmpegPath), { recursive: true, force: true });
  }
});

test("damaged cached executables are removed before the engine receives their paths and are repaired", async t => {
  const { create } = await fixture(t);
  const first = create(); const paths = await first.initialize({}); await first.retry(); await first.close();
  await writeFile(paths.ffmpegPath, "x".repeat(content.ffmpeg.length));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const repaired = create({ fetch: async () => { await gate; return new Response(gzipSync(content.ffmpeg)); } });
  await repaired.initialize({});
  assert.equal(await readFile(paths.ffmpegPath).catch(() => null), null);
  release(); await repaired.retry(); assert.equal(repaired.view().state, "ready");
});

test("offline initialization can retry, while closing aborts an in-flight download", async t => {
  const { create } = await fixture(t);
  const offline = create({ fetch: async () => { throw new Error("offline"); } });
  await offline.initialize({}); await offline.retry(); assert.equal(offline.view().state, "retrying");
  await offline.close();
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const active = create({ probe: async () => absent, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }); started();
  }) });
  await active.initialize({}); await began;
  await active.close();
});
