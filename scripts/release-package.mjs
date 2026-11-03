import { appendFile, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, repository, verifyRuntime } from "./package-inventory.mjs";

const formats = { "windows-x64": { nsis: ".exe" }, "linux-x64": { deb: ".deb", appimage: ".AppImage" } };
const json = async path => JSON.parse(await readFile(path, "utf8"));
const versionedInstaller = (name, version, extension) => {
  const stem = name.slice(0, -extension.length);
  return stem.endsWith(`_${version}`) || stem.includes(`_${version}_`);
};
function validateVersion(version) {
  if (typeof version !== "string" || version.length > 100 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version) ||
      version.split("-").slice(1).join("-").split(".").some(part => /^0\d+$/.test(part))) throw new Error("Invalid release version; use SemVer such as 0.2.0 or 0.2.0-beta.1");
  return version;
}
export async function releaseMetadata(root = repository) {
  const app = await json(join(root, "package.json"));
  const version = app.version;
  if (app.name !== "atris-share") throw new Error("Invalid release application");
  validateVersion(version);
  const desktop = await json(join(root, "apps/desktop/package.json"));
  const tauri = await json(join(root, "apps/desktop/src-tauri/tauri.conf.json"));
  const lock = await json(join(root, "package-lock.json"));
  const cargo = await readFile(join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "")?.[1];
  const cargoLock = await readFile(join(root, "apps/desktop/src-tauri/Cargo.lock"), "utf8");
  const entry = cargoLock.split("[[package]]").find(block => /^name\s*=\s*"atris-share"\s*$/m.test(block));
  const cargoLockVersion = /^version\s*=\s*"([^"]+)"/m.exec(entry ?? "")?.[1];
  const domain = await readFile(join(root, "packages/domain/src/workspace.ts"), "utf8");
  const domainVersion = /export const APP_VERSION = "([^"]+)"/.exec(domain)?.[1];
  for (const [name, actual] of Object.entries({ desktop: desktop.version, tauri: tauri.version, cargo: cargoVersion,
    "Cargo.lock": cargoLockVersion, "package-lock version": lock.version, "package-lock root": lock.packages?.[""]?.version,
    "package-lock desktop": lock.packages?.["apps/desktop"]?.version, APP_VERSION: domainVersion })) {
    if (actual !== version) throw new Error(`Release version mismatch: ${name} must equal ${version}`);
  }
  return { version, tag: `v${version}`, prerelease: version.includes("-") };
}
/** A deterministic build-workspace overlay; never creates commits or changes a remote branch. */
export async function applyReleaseVersion(root, requested = "") {
  const current = await releaseMetadata(root);
  if (typeof requested !== "string") throw new Error("Invalid release version input");
  const version = requested.trim() ? validateVersion(requested.trim().replace(/^v/, "")) : current.version;
  if (version !== current.version) {
    const changes = [];
    for (const path of ["package.json", "apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json", "package-lock.json"]) {
      const value = await json(join(root, path)); value.version = version;
      if (path === "package-lock.json") { value.packages[""].version = version; value.packages["apps/desktop"].version = version; }
      changes.push([path, `${JSON.stringify(value, null, 2)}\n`]);
    }
    const cargoPath = "apps/desktop/src-tauri/Cargo.toml";
    const cargo = await readFile(join(root, cargoPath), "utf8");
    changes.push([cargoPath, cargo.replace(/(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m, (_, prefix, old, suffix) => `${prefix}${version}${suffix}`)]);
    const lockPath = "apps/desktop/src-tauri/Cargo.lock";
    const lock = await readFile(join(root, lockPath), "utf8");
    changes.push([lockPath, lock.split("[[package]]").map(block => /^name\s*=\s*"atris-share"\s*$/m.test(block)
      ? block.replace(/(^version\s*=\s*")([^"]+)(")/m, (_, prefix, old, suffix) => `${prefix}${version}${suffix}`) : block).join("[[package]]")]);
    const domainPath = "packages/domain/src/workspace.ts";
    const domain = await readFile(join(root, domainPath), "utf8");
    changes.push([domainPath, domain.replace(/(export const APP_VERSION = ")([^"]+)(")/, (_, prefix, old, suffix) => `${prefix}${version}${suffix}`)]);
    // All source versions and input are validated before the first write.
    for (const [path, text] of changes) await writeFile(join(root, path), text);
  }
  return { ...await releaseMetadata(root), source_version: current.version };
}
export async function collectReleaseAssets(root, platform) {
  if (!Object.hasOwn(formats, platform)) throw new Error("Unsupported release platform");
  const { version } = await releaseMetadata(root);
  const files = [];
  const signed = (await json(join(root, "apps/desktop/src-tauri/tauri.conf.json"))).bundle?.createUpdaterArtifacts === true;
  for (const [bundle, extension] of Object.entries(formats[platform])) {
    const directory = join(root, "apps/desktop/src-tauri/target/release/bundle", bundle);
    const matches = (await readdir(directory)).filter(name => name.endsWith(extension));
    if (matches.length !== 1) throw new Error(`Expected exactly one ${platform} ${extension} installer`);
    const name = matches[0];
    if (!versionedInstaller(name, version, extension) || /[\r\n\\]/.test(name)) throw new Error(`Unexpected release filename: ${name}`);
    const digest = await fingerprint(join(directory, name));
    if (!digest.bytes) throw new Error(`Empty installer: ${name}`);
    files.push({ name, path: join(directory, name), ...digest });
    if (signed && bundle !== "deb") {
      const signature = `${name}.sig`;
      await readSignature(join(directory, signature));
      files.push({ name: signature, path: join(directory, signature), ...await fingerprint(join(directory, signature)) });
    }
  }
  const output = join(root, "release-artifacts", platform);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const file of files) await copyFile(file.path, join(output, file.name));
  await writeFile(join(output, `SHA256SUMS-${platform}.txt`), files.map(file => `${file.sha256}  ${file.name}\n`).join(""));
  return { output, files: files.map(({ path, ...file }) => file) };
}
export async function verifyReleaseAssets(directory, version) {
  const expected = [];
  const signed = (await readFile(join(directory, "SHA256SUMS-windows-x64.txt"), "utf8")).includes(".exe.sig");
  for (const [platform, bundles] of Object.entries(formats)) {
    const name = `SHA256SUMS-${platform}.txt`; expected.push(name);
    const lines = (await readFile(join(directory, name), "utf8")).trim().split(/\r?\n/);
    const extensions = Object.entries(bundles).flatMap(([bundle, extension]) => signed && bundle !== "deb" ? [extension, `${extension}.sig`] : [extension]);
    if (lines.length !== extensions.length) throw new Error(`Incomplete release assets: ${platform}`);
    const seen = new Set();
    for (const line of lines) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      const filename = match?.[2];
      if (!filename || basename(filename) !== filename || /[\\\u0000-\u001f]/.test(filename)) throw new Error("Invalid release checksum filename");
      const extension = extensions.find(extension => filename.endsWith(extension));
      if (extension && !versionedInstaller(filename, version, extension)) throw new Error("Invalid release checksum filename");
      if (!extension || seen.has(extension)) throw new Error(`Duplicate or invalid installer: ${filename}`);
      seen.add(extension); expected.push(filename);
      const actual = await fingerprint(join(directory, filename));
      if (!actual.bytes || actual.sha256 !== match[1]) throw new Error(`Release checksum mismatch: ${filename}`);
    }
  }
  if (signed) {
    const manifest = await json(join(directory, "latest.json"));
    const expectedManifest = await updaterManifest(directory, version);
    if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) throw new Error("Invalid updater manifest");
    expected.push("latest.json");
  }
  const actualNames = (await readdir(directory)).sort();
  if (actualNames.includes("release-manifest.json")) {
    const manifest = await json(join(directory, "release-manifest.json"));
    validateVersion(manifest.sourceVersion);
    if (manifest.schemaVersion !== 1 || manifest.version !== version || manifest.tag !== `v${version}` ||
        manifest.prerelease !== version.includes("-") || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? "") ||
        manifest.versionOverrideApplied !== (manifest.sourceVersion !== version) || !Array.isArray(manifest.files) ||
        JSON.stringify(manifest.files.map(file => file.name).sort()) !== JSON.stringify([...expected].sort())) throw new Error("Invalid release provenance manifest");
    for (const file of manifest.files) {
      const actual = await fingerprint(join(directory, file.name));
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error(`Release provenance hash mismatch: ${file.name}`);
    }
    expected.push("release-manifest.json");
  }
  if (JSON.stringify(actualNames) !== JSON.stringify(expected.sort())) throw new Error("Unexpected or missing release assets");
  return expected;
}
export async function finalizeReleaseAssets(root, directory, sourceCommit, sourceVersion) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? "")) throw new Error("Invalid source commit");
  validateVersion(sourceVersion);
  const metadata = await releaseMetadata(root);
  const config = await json(join(root, "apps/desktop/src-tauri/tauri.conf.json"));
  if (config.bundle?.createUpdaterArtifacts === true) {
    await writeFile(join(directory, "latest.json"), `${JSON.stringify(await updaterManifest(directory, metadata.version), null, 2)}\n`, { flag: "wx" });
  }
  const files = await verifyReleaseAssets(directory, metadata.version);
  const manifest = { schemaVersion: 1, ...metadata, sourceCommit, sourceVersion,
    versionOverrideApplied: sourceVersion !== metadata.version,
    files: await Promise.all(files.map(async name => ({ name, ...await fingerprint(join(directory, name)) }))) };
  await writeFile(join(directory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

async function readSignature(path) {
  const signature = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || Buffer.from(signature, "base64").length < 32) throw new Error("Missing or invalid updater signature");
  return signature;
}
export async function updaterManifest(directory, version) {
  validateVersion(version);
  const names = await readdir(directory);
  const platforms = {};
  for (const [platform, extension] of [["windows-x86_64", ".exe"], ["linux-x86_64", ".AppImage"]]) {
    const candidates = names.filter(name => name.endsWith(extension));
    if (candidates.length !== 1 || !versionedInstaller(candidates[0], version, extension)) throw new Error("Missing or stale updater installer");
    const name = candidates[0];
    platforms[platform] = {
      signature: await readSignature(join(directory, `${name}.sig`)),
      url: `https://github.com/merteren97/AtrisShare/releases/download/v${version}/${encodeURIComponent(name)}`
    };
  }
  return { version, notes: `AtrisShare ${version}`, platforms };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const metadata = command === "prepare" ? await applyReleaseVersion(repository, process.env.RELEASE_VERSION_INPUT ?? "") : await releaseMetadata();
  if (command === "metadata" || command === "prepare") {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(metadata).map(([key, value]) => `${key}=${value}\n`).join(""));
    console.log(JSON.stringify(metadata));
  } else if (command === "collect") {
    const platform = process.argv[3];
    if (platform !== `${process.platform === "win32" ? "windows" : process.platform}-x64` || process.arch !== "x64") throw new Error("Release runner/platform mismatch");
    await verifyRuntime(join(repository, "apps/desktop/src-tauri/runtime"), { root: repository });
    console.log(JSON.stringify(await collectReleaseAssets(repository, platform)));
  } else if (command === "verify" && process.argv[3]) {
    console.log(JSON.stringify(await verifyReleaseAssets(resolve(process.argv[3]), metadata.version)));
  } else if (command === "finalize" && process.argv[3]) {
    console.log(JSON.stringify(await finalizeReleaseAssets(repository, resolve(process.argv[3]), process.env.GITHUB_SHA, process.env.SOURCE_VERSION)));
  } else throw new Error("Usage: node scripts/release-package.mjs metadata | prepare | collect <platform> | verify <asset-directory> | finalize <asset-directory>");
}
