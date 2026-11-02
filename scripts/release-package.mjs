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
export async function releaseMetadata(root = repository) {
  const app = await json(join(root, "package.json"));
  const version = app.version;
  if (app.name !== "atris-share" || typeof version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version) ||
      version.split("-").slice(1).join("-").split(".").some(part => /^0\d+$/.test(part))) throw new Error("Invalid release version in package.json");
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
export async function collectReleaseAssets(root, platform) {
  if (!Object.hasOwn(formats, platform)) throw new Error("Unsupported release platform");
  const { version } = await releaseMetadata(root);
  const files = [];
  for (const [bundle, extension] of Object.entries(formats[platform])) {
    const directory = join(root, "apps/desktop/src-tauri/target/release/bundle", bundle);
    const matches = (await readdir(directory)).filter(name => name.endsWith(extension));
    if (matches.length !== 1) throw new Error(`Expected exactly one ${platform} ${extension} installer`);
    const name = matches[0];
    if (!versionedInstaller(name, version, extension) || /[\r\n\\]/.test(name)) throw new Error(`Unexpected release filename: ${name}`);
    const digest = await fingerprint(join(directory, name));
    if (!digest.bytes) throw new Error(`Empty installer: ${name}`);
    files.push({ name, path: join(directory, name), ...digest });
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
  for (const [platform, bundles] of Object.entries(formats)) {
    const name = `SHA256SUMS-${platform}.txt`; expected.push(name);
    const lines = (await readFile(join(directory, name), "utf8")).trim().split(/\r?\n/);
    const extensions = Object.values(bundles);
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
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected.sort())) throw new Error("Unexpected or missing release assets");
  return expected;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metadata = await releaseMetadata();
  if (process.argv[2] === "metadata") {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(metadata).map(([key, value]) => `${key}=${value}\n`).join(""));
    console.log(JSON.stringify(metadata));
  } else if (process.argv[2] === "collect") {
    const platform = process.argv[3];
    if (platform !== `${process.platform === "win32" ? "windows" : process.platform}-x64` || process.arch !== "x64") throw new Error("Release runner/platform mismatch");
    await verifyRuntime(join(repository, "apps/desktop/src-tauri/runtime"), { root: repository });
    console.log(JSON.stringify(await collectReleaseAssets(repository, platform)));
  } else if (process.argv[2] === "verify" && process.argv[3]) {
    console.log(JSON.stringify(await verifyReleaseAssets(resolve(process.argv[3]), metadata.version)));
  } else throw new Error("Usage: node scripts/release-package.mjs metadata | collect <platform> | verify <asset-directory>");
}
