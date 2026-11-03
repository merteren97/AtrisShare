import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyReleaseVersion, collectReleaseAssets, finalizeReleaseAssets, releaseMetadata, verifyReleaseAssets } from "../scripts/release-package.mjs";

const version = "0.1.0-preview.1";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atrisshare-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "apps/desktop/src-tauri"), { recursive: true });
  await mkdir(join(root, "packages/domain/src"), { recursive: true });
  for (const [path, value] of Object.entries({
    "package.json": { name: "atris-share", version }, "apps/desktop/package.json": { version },
    "apps/desktop/src-tauri/tauri.conf.json": { version },
    "package-lock.json": { version, packages: { "": { version }, "apps/desktop": { version } } }
  })) await writeFile(join(root, path), JSON.stringify(value));
  await writeFile(join(root, "apps/desktop/src-tauri/Cargo.toml"), `[package]\nname = "atris-share"\nversion = "${version}"\n\n[lib]\nname = "atris_share_lib"\n`);
  await writeFile(join(root, "apps/desktop/src-tauri/Cargo.lock"), `version = 4\n\n[[package]]\nname = "atris-share"\nversion = "${version}"\n\n[[package]]\nname = "other"\nversion = "1.2.3"\n`);
  await writeFile(join(root, "packages/domain/src/workspace.ts"), `export const APP_VERSION = "${version}";\n`);
  return root;
}
async function installer(root, bundle, extension, prefix = "AtrisShare", releaseVersion = version) {
  const directory = join(root, "apps/desktop/src-tauri/target/release/bundle", bundle);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${prefix}_${releaseVersion}${extension}`);
  await writeFile(path, `synthetic ${bundle} installer bytes`);
  return path;
}
test("release version comes from every source, rejecting mismatched runtime or native versions", async t => {
  const root = await fixture(t);
  assert.deepEqual(await releaseMetadata(root), { version, tag: `v${version}`, prerelease: true });
  await writeFile(join(root, "packages/domain/src/workspace.ts"), 'export const APP_VERSION = "0.0.1";');
  await assert.rejects(releaseMetadata(root), /version mismatch: APP_VERSION/);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "atris-share", version: "1.0.0\nforged=true" }));
  await assert.rejects(releaseMetadata(root), /Invalid release version/);
});
test("release assets require all Windows/Linux installers and verify bytes after artifact download", async t => {
  const root = await fixture(t);
  await installer(root, "nsis", ".exe"); await installer(root, "deb", ".deb"); await installer(root, "appimage", ".AppImage");
  const windows = await collectReleaseAssets(root, "windows-x64"), linux = await collectReleaseAssets(root, "linux-x64");
  assert.equal(windows.files.length, 1); assert.equal(linux.files.length, 2);
  const combined = join(root, "combined"); await mkdir(combined);
  for (const source of [windows.output, linux.output]) for (const name of await readdir(source)) await copyFile(join(source, name), join(combined, name));
  assert.equal((await verifyReleaseAssets(combined, version)).length, 5);
  const file = windows.files[0].name;
  await writeFile(join(combined, file), "changed installer bytes");
  await assert.rejects(verifyReleaseAssets(combined, version), /checksum mismatch/);
  await copyFile(join(windows.output, file), join(combined, file));
  await writeFile(join(combined, "extra.exe"), "unlisted");
  await assert.rejects(verifyReleaseAssets(combined, version), /Unexpected or missing/);
  await rm(join(combined, "extra.exe"));
  await assert.rejects(verifyReleaseAssets(combined, "9.9.9"), /checksum filename/);
  const checksum = await readFile(join(combined, "SHA256SUMS-windows-x64.txt"), "utf8");
  await writeFile(join(combined, "SHA256SUMS-windows-x64.txt"), checksum.replace(file, `../${file}`));
  await assert.rejects(verifyReleaseAssets(combined, version), /checksum filename/);
});
test("missing, duplicate, empty and stale installers cannot be collected as a successful platform", async t => {
  const root = await fixture(t);
  const exe = await installer(root, "nsis", ".exe");
  await assert.rejects(collectReleaseAssets(root, "linux-x64"));
  const duplicate = await installer(root, "nsis", ".exe", "Stale");
  await assert.rejects(collectReleaseAssets(root, "windows-x64"), /exactly one/);
  await rm(duplicate); await writeFile(exe, "");
  await assert.rejects(collectReleaseAssets(root, "windows-x64"), /Empty installer/);
  await rm(exe);
  await writeFile(join(root, "apps/desktop/src-tauri/target/release/bundle/nsis", `AtrisShare_${version}0_x64-setup.exe`), "stale prerelease");
  await assert.rejects(collectReleaseAssets(root, "windows-x64"), /Unexpected release filename/);
  await assert.rejects(collectReleaseAssets(root, "unsupported"), /Unsupported/);
});

test("manual release version updates native/runtime/npm sources together without modifying dependency versions", async t => {
  const root = await fixture(t);
  const before = await readFile(join(root, "package.json"), "utf8");
  assert.deepEqual(await applyReleaseVersion(root, ""), { version, tag: `v${version}`, prerelease: true, source_version: version });
  assert.equal(await readFile(join(root, "package.json"), "utf8"), before);
  for (const input of ["0.01.0", "1.0.0\nforged=true", "0.2.0-beta.01", "../../outside"]) {
    await assert.rejects(applyReleaseVersion(root, input), /Invalid release version/);
    assert.equal(await readFile(join(root, "package.json"), "utf8"), before, "invalid input must not partially change metadata");
  }
  assert.deepEqual(await applyReleaseVersion(root, " v0.2.0 "), { version: "0.2.0", tag: "v0.2.0", prerelease: false, source_version: version });
  assert.deepEqual(await releaseMetadata(root), { version: "0.2.0", tag: "v0.2.0", prerelease: false });
  const lock = await readFile(join(root, "apps/desktop/src-tauri/Cargo.lock"), "utf8");
  assert.match(lock, /name = "other"\nversion = "1\.2\.3"/);
  assert.deepEqual(await applyReleaseVersion(root, "0.3.0-beta.2"), { version: "0.3.0-beta.2", tag: "v0.3.0-beta.2", prerelease: true, source_version: "0.2.0" });
});

test("version overrides remain reproducible through the source commit/version and final asset manifest", async t => {
  const root = await fixture(t), selected = "0.2.0";
  await applyReleaseVersion(root, selected);
  await installer(root, "nsis", ".exe", "AtrisShare", selected); await installer(root, "deb", ".deb", "AtrisShare", selected); await installer(root, "appimage", ".AppImage", "AtrisShare", selected);
  const windows = await collectReleaseAssets(root, "windows-x64"), linux = await collectReleaseAssets(root, "linux-x64");
  const combined = join(root, "combined"); await mkdir(combined);
  for (const source of [windows.output, linux.output]) for (const name of await readdir(source)) await copyFile(join(source, name), join(combined, name));
  await assert.rejects(finalizeReleaseAssets(root, combined, "not-a-commit", version), /source commit/);
  const manifest = await finalizeReleaseAssets(root, combined, "a".repeat(40), version);
  assert.equal(manifest.version, selected); assert.equal(manifest.sourceVersion, version); assert.equal(manifest.sourceCommit, "a".repeat(40));
  assert.equal(manifest.versionOverrideApplied, true); assert.equal(manifest.files.length, 5);
  assert.equal((await verifyReleaseAssets(combined, selected)).length, 6);
  manifest.files[0].sha256 = "0".repeat(64);
  await writeFile(join(combined, "release-manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyReleaseAssets(combined, selected), /provenance hash mismatch/);
});

test("signed releases bind both update platforms, signatures, checksums and provenance", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), JSON.stringify({ version, bundle: { createUpdaterArtifacts: true } }));
  const exe = await installer(root, "nsis", ".exe"), image = await installer(root, "appimage", ".AppImage");
  await installer(root, "deb", ".deb");
  await assert.rejects(collectReleaseAssets(root, "windows-x64"), /ENOENT/);
  for (const path of [exe, image]) await writeFile(`${path}.sig`, Buffer.from("synthetic signature, verified by client before install").toString("base64"));
  const windows = await collectReleaseAssets(root, "windows-x64"), linux = await collectReleaseAssets(root, "linux-x64");
  const combined = join(root, "combined"); await mkdir(combined);
  for (const source of [windows.output, linux.output]) for (const name of await readdir(source)) await copyFile(join(source, name), join(combined, name));
  await finalizeReleaseAssets(root, combined, "a".repeat(40), version);
  assert.equal((await verifyReleaseAssets(combined, version)).length, 9);
  const update = JSON.parse(await readFile(join(combined, "latest.json"), "utf8"));
  assert.deepEqual(Object.keys(update.platforms), ["windows-x86_64", "linux-x86_64"]);
  assert.ok(update.platforms["windows-x86_64"].url.startsWith(`https://github.com/merteren97/AtrisShare/releases/download/v${version}/`));
  update.platforms["windows-x86_64"].url = "https://example.com/untrusted.exe";
  await writeFile(join(combined, "latest.json"), JSON.stringify(update));
  await assert.rejects(verifyReleaseAssets(combined, version), /Invalid updater manifest/);
});
