import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { licenseTexts, npmLicenseTexts, pinnedCargoLicenses, repository, requiredFiles, sealRuntime, sourceFingerprints, verifyRuntime } from "../scripts/package-inventory.mjs";
import { replaceRuntime } from "../scripts/stage-runtime.mjs";

const metadata = { version: "fixture", node: process.versions.node, platform: process.platform, arch: process.arch, sources: { fixture: "synthetic" } };
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "atris-packaging-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, output: join(parent, "runtime") };
}
async function populate(directory) {
  for (const name of [...requiredFiles, process.platform === "win32" ? "node.exe" : "node"]) {
    await writeFile(join(directory, name), name === "dependency-inventory.json" ?
      JSON.stringify({ schemaVersion: 1, complete: true, components: ["API", "MCP", "FRONTEND", "RUST"].map(group => ({
        group, ecosystem: group === "RUST" ? "cargo" : "npm", name: "synthetic", version: "1", license: "MIT",
        licenseFiles: [{ file: "LICENSE", sha256: "a".repeat(64) }]
      })) }) : `synthetic ${name}\n`);
  }
}

test("fresh replacement removes stale/private files and records exact bytes and hashes", async t => {
  const { output } = await fixture(t);
  await mkdir(output);
  await writeFile(join(output, "private-fixture.txt"), "SYNTHETIC NOT REAL USER DATA");
  await mkdir(join(output, "old-cache"));
  await writeFile(join(output, "old-cache", "stale.txt"), "stale");
  await replaceRuntime(output, metadata, populate);
  const manifest = await verifyRuntime(output);
  assert.equal(manifest.files["api.mjs"].bytes, Buffer.byteLength("synthetic api.mjs\n"));
  assert.match(manifest.files["api.mjs"].sha256, /^[a-f0-9]{64}$/);
  assert.ok(!(await readdir(output)).includes("private-fixture.txt"));
  assert.ok(!(await readdir(output)).includes("old-cache"));
});

test("producer failure invalidates the previous runtime and removes partial staging and lock", async t => {
  const { parent, output } = await fixture(t);
  await replaceRuntime(output, metadata, populate);
  await assert.rejects(replaceRuntime(output, metadata, async directory => {
    await writeFile(join(directory, "api.mjs"), "partial"); throw new Error("injected collection failure");
  }), /injected collection failure/);
  assert.deepEqual(await readdir(parent), []);
});

test("packaging input mutation during staging fails final verification and removes the renamed runtime", async t => {
  const { parent, output } = await fixture(t);
  const root = join(parent, "checkout");
  for (const name of Object.keys(await sourceFingerprints(repository))) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), name === "package.json" ? JSON.stringify({ version: "fixture", devDependencies: { node: process.versions.node } }) : "synthetic packaging input");
  }
  const current = { ...metadata, sources: await sourceFingerprints(root) };
  await assert.rejects(replaceRuntime(output, current, async directory => {
    await populate(directory); await writeFile(join(root, "NOTICE"), "changed while staging");
  }, { root }), /sources changed/);
  assert.deepEqual(await readdir(parent), ["checkout"]);
});

test("unknown output, missing resources and incomplete notices cannot replace a valid runtime", async t => {
  const { parent, output } = await fixture(t);
  for (const change of [
    directory => writeFile(join(directory, "unexpected.env"), "synthetic"),
    directory => rm(join(directory, "mcp.mjs")),
    directory => writeFile(join(directory, "dependency-inventory.json"), JSON.stringify({ schemaVersion: 1, complete: false, components: [] }))
  ]) {
    await replaceRuntime(output, metadata, populate);
    await assert.rejects(replaceRuntime(output, metadata, async directory => { await populate(directory); await change(directory); }));
    assert.deepEqual(await readdir(parent), []);
  }
});

test("verification rejects same-size tampering, inventory omission, extra files and mismatched platform", async t => {
  const { output } = await fixture(t);
  await replaceRuntime(output, metadata, populate);
  await writeFile(join(output, "api.mjs"), "SYNTHETIC api.mjs\n");
  await assert.rejects(verifyRuntime(output), /hash mismatch/);
  await replaceRuntime(output, metadata, populate);
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  delete manifest.files["mcp.mjs"];
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyRuntime(output), /strict allowlist/);
  await replaceRuntime(output, metadata, populate);
  await writeFile(join(output, "extra.txt"), "synthetic");
  await assert.rejects(verifyRuntime(output), /differs from inventory/);
  await rm(join(output, "extra.txt"));
  await assert.rejects(verifyRuntime(output, { platform: process.platform === "win32" ? "linux" : "win32" }), /incompatible/);
});

test("a competing staging attempt cannot remove output or the active stage lock", async t => {
  const { parent, output } = await fixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = replaceRuntime(output, metadata, async directory => { entered(); await gate; await populate(directory); });
  await started;
  try { await assert.rejects(replaceRuntime(output, metadata, populate), error => error.code === "EEXIST"); }
  finally { release(); await first; }
  await verifyRuntime(output);
  assert.deepEqual(await readdir(parent), ["runtime"]);
});

test("license directories retain full text, explicit files are required, and escaping paths are rejected", async t => {
  const { parent } = await fixture(t);
  await mkdir(join(parent, "LICENSES"));
  // LICENSES is an SPDX convention; a plural directory is supported too.
  await writeFile(join(parent, "LICENSES", "MIT.txt"), "synthetic full MIT text");
  await writeFile(join(parent, "NOTICE"), "synthetic attribution");
  const texts = await licenseTexts(parent);
  assert.ok(texts.some(text => text.file === "LICENSES/MIT.txt" && text.text === "synthetic full MIT text"));
  await assert.rejects(licenseTexts(parent, "missing.txt"), error => error.code === "ENOENT");
  await assert.rejects(licenseTexts(parent, "../outside.txt"), /escapes/);
});

test("runtime inventory and license collection reject directory symlinks/junctions", async t => {
  const { parent, output } = await fixture(t);
  const outside = join(parent, "outside");
  await mkdir(outside);
  await mkdir(output);
  await populate(output);
  await rm(join(output, "NOTICE.txt"));
  await symlink(outside, join(output, "NOTICE.txt"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(sealRuntime(output, metadata), /regular file/);
  const licenses = join(parent, "licenses-fixture");
  await mkdir(licenses);
  await symlink(outside, join(licenses, "LICENSE"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(licenseTexts(licenses), /Unsafe license/);
});

test("missing Cargo texts resolve only from recorded immutable provenance, preserving URL/hash/attribution", async t => {
  const { parent } = await fixture(t);
  const commit = "a".repeat(40), text = `Copyright Synthetic Fixture\n${"full license text ".repeat(20)}`;
  await writeFile(join(parent, ".cargo_vcs_info.json"), JSON.stringify({ git: { sha1: commit }, path_in_vcs: "crates/fixture" }));
  const pkg = { name: "fixture", manifest_path: join(parent, "Cargo.toml"), repository: "https://github.com/example/fixture", source: "registry+fixture" };
  const requests = [];
  const fetcher = async url => {
    requests.push(url);
    return new Response(url.includes("api.github.com") ? JSON.stringify({ truncated: false,
      tree: [{ path: "LICENSE", type: "blob", mode: "100644" }, { path: "unrelated/LICENSE", type: "blob", mode: "100644" }] }) : text);
  };
  const texts = await pinnedCargoLicenses(pkg, fetcher);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, text);
  assert.equal(texts[0].commit, commit);
  assert.match(texts[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(requests.every(url => url.includes(commit) && !url.includes("HEAD")));
  await assert.rejects(pinnedCargoLicenses(pkg, async () => new Response("unavailable", { status: 503 })), /Pinned license source failed/);
  await writeFile(join(parent, ".cargo_vcs_info.json"), JSON.stringify({ git: { sha1: "HEAD" }, path_in_vcs: "" }));
  await assert.rejects(pinnedCargoLicenses(pkg, fetcher), /Invalid Cargo provenance/);
});

test("reviewed npm omissions cannot silently follow changed integrity or changed upstream license bytes", async t => {
  const { parent } = await fixture(t);
  const manifest = { name: "react-remove-scroll-bar", version: "2.3.8", license: "MIT", repository: "https://github.com/theKashey/react-remove-scroll-bar" };
  let fetched = false;
  const fetcher = async () => { fetched = true; return new Response("synthetic altered license"); };
  await assert.rejects(npmLicenseTexts(manifest, { integrity: "changed" }, parent, fetcher), /exception no longer matches/);
  assert.equal(fetched, false);
  await assert.rejects(npmLicenseTexts(manifest, { integrity: "sha512-9r+yi9+mgU33AKcj6IbT9oRCO78WriSj6t/cF8DWBZJ9aOGPOTEDvdUDz1FwKim7QXWwmHqtdHnRJfhAxEG46Q==" }, parent, fetcher), /license hash mismatch/);
});
