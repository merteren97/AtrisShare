import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectReleaseAssets, releaseMetadata, verifyReleaseAssets } from "../scripts/release-package.mjs";

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
async function installer(root, bundle, extension, prefix = "AtrisShare") {
  const directory = join(root, "apps/desktop/src-tauri/target/release/bundle", bundle);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${prefix}_${version}${extension}`);
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
