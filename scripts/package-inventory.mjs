import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = ["package.json", "package-lock.json", "apps/desktop/package.json",
  "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/Cargo.lock", "apps/desktop/src-tauri/tauri.conf.json",
  "scripts/stage-runtime.mjs", "scripts/package-inventory.mjs", "scripts/release-package.mjs", "LICENSE", "NOTICE"];
export const requiredFiles = ["api.mjs", "mcp.mjs", "NODE-LICENSE.txt", "ZOD-LICENSE.txt", "LICENSE.txt", "NOTICE.txt",
  "API-THIRD-PARTY-NOTICES.txt", "MCP-THIRD-PARTY-NOTICES.txt", "FRONTEND-THIRD-PARTY-NOTICES.txt",
  "RUST-THIRD-PARTY-NOTICES.txt", "dependency-inventory.json"];
const optionalFiles = ["api.mjs.LEGAL.txt", "mcp.mjs.LEGAL.txt"];
const json = async path => JSON.parse(await readFile(path, "utf8"));
const slash = path => path.split(sep).join("/");
const licenseName = name => /^(licen[cs]es?|copying|copyright|notices?|unlicense)([._-]|$)/i.test(name);
// Reviewed archive omission, bounded to this exact lock integrity. The published
// gitHead no longer exists upstream; this is explicitly a later upstream notice,
// not misrepresented as the original release snapshot. Upgrades require review.
const npmLicenseExceptions = {
  "react-remove-scroll-bar@2.3.8": {
    integrity: "sha512-9r+yi9+mgU33AKcj6IbT9oRCO78WriSj6t/cF8DWBZJ9aOGPOTEDvdUDz1FwKim7QXWwmHqtdHnRJfhAxEG46Q==",
    repository: "theKashey/react-remove-scroll-bar", license: "MIT",
    commit: "7301c160fda44cb8cf2b9fdfde61efad35736196",
    sha256: "a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84",
    resolution: "Reviewed later upstream LICENSE (2025-05-21); npm 2.3.8 (2024-12-15) omitted it and its published gitHead is unavailable. Distribution review required."
  }
};
// This published crate omits both repository metadata and license files. Its
// archive's .cargo_vcs_info.json identifies the original upstream snapshot.
// Never infer a repository from an arbitrary crate name or a newer release.
const cargoRepositoryFallbacks = {
  "libappindicator-sys@0.9.0": {
    repository: "tauri-apps/libappindicator-rs", commit: "eafd1e3682a1247f595410266091e9684021cb6f",
    path: "sys", license: "Apache-2.0 OR MIT"
  }
};
function within(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export async function fingerprint(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular file: ${path}`);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return { bytes: stat.size, sha256: hash.digest("hex") };
}
export async function sourceFingerprints(root) {
  return Object.fromEntries(await Promise.all(sources.map(async name => [name, await fingerprint(join(root, name))])));
}
function runtimeNames(platform) {
  if (!["win32", "linux", "darwin"].includes(platform)) throw new Error(`Unsupported runtime platform: ${platform}`);
  return [...requiredFiles, platform === "win32" ? "node.exe" : "node"];
}
export async function sealRuntime(directory, metadata) {
  const required = runtimeNames(metadata.platform);
  const entries = await readdir(directory);
  for (const name of entries) if (![...required, ...optionalFiles].includes(name)) throw new Error(`Unexpected runtime file: ${name}`);
  const files = {};
  for (const name of [...required, ...optionalFiles.filter(name => entries.includes(name))].sort()) {
    files[name] = await fingerprint(join(directory, name));
    if (!files[name].bytes) throw new Error(`Empty runtime file: ${name}`);
  }
  const manifest = { schemaVersion: 1, ...metadata, files };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await verifyRuntime(directory);
  return manifest;
}
export async function verifyRuntime(directory, { root, platform = process.platform, arch = process.arch } = {}) {
  await fingerprint(join(directory, "manifest.json"));
  const manifest = await json(join(directory, "manifest.json"));
  if (manifest.schemaVersion !== 1 || manifest.platform !== platform || manifest.arch !== arch ||
      typeof manifest.version !== "string" || typeof manifest.node !== "string" || !manifest.files || !manifest.sources) {
    throw new Error("Invalid or incompatible runtime manifest");
  }
  const required = runtimeNames(platform);
  const expected = Object.keys(manifest.files).sort();
  if (required.some(name => !expected.includes(name)) || expected.some(name => ![...required, ...optionalFiles].includes(name))) {
    throw new Error("Runtime inventory is not the strict allowlist");
  }
  const actual = (await readdir(directory)).filter(name => name !== "manifest.json").sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Runtime directory differs from inventory");
  for (const name of expected) {
    const recorded = manifest.files[name], current = await fingerprint(join(directory, name));
    if (!recorded || recorded.bytes !== current.bytes || recorded.sha256 !== current.sha256) throw new Error(`Runtime hash mismatch: ${name}`);
  }
  const inventory = await json(join(directory, "dependency-inventory.json"));
  const groups = ["API", "MCP", "FRONTEND", "RUST"];
  if (inventory.schemaVersion !== 1 || inventory.complete !== true || !Array.isArray(inventory.components) ||
      groups.some(group => !inventory.components.some(component => component.group === group)) || inventory.components.some(component =>
        !groups.includes(component.group) || !["npm", "cargo"].includes(component.ecosystem) || !component.name || !component.version ||
        !component.license || !Array.isArray(component.licenseFiles) || !component.licenseFiles.length ||
        component.licenseFiles.some(file => !file.file || !/^[a-f0-9]{64}$/.test(file.sha256)))) {
    throw new Error("Missing or incomplete dependency license inventory");
  }
  if (root) {
    if (JSON.stringify(manifest.sources) !== JSON.stringify(await sourceFingerprints(root))) throw new Error("Runtime sources changed; stage again");
    const app = await json(join(root, "package.json"));
    if (manifest.version !== app.version || manifest.node !== app.devDependencies.node) throw new Error("Runtime version differs from pinned application/runtime");
  }
  return manifest;
}

// Read only resolved package roots and their license directories, never scan the
// dependency tree for source/media/config files. Preserve full texts, not SPDX labels.
export async function licenseTexts(directory, explicit) {
  directory = await realpath(directory);
  const files = new Set();
  async function visit(path, depth = 0) {
    if (depth > 5 || files.size > 256) throw new Error(`Unbounded license directory: ${directory}`);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !within(directory, path)) throw new Error(`Unsafe license path: ${path}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), depth + 1);
    } else if (stat.isFile()) {
      if (!stat.size || stat.size > 2 * 1024 * 1024) throw new Error(`Invalid license text size: ${path}`);
      files.add(path);
    } else throw new Error(`Invalid license entry: ${path}`);
  }
  for (const name of (await readdir(directory)).sort()) {
    if (licenseName(name)) await visit(join(directory, name));
  }
  if (explicit) {
    const path = resolve(directory, explicit);
    if (!within(directory, path)) throw new Error(`License file escapes package: ${explicit}`);
    await visit(path);
  }
  const texts = [];
  for (const path of [...files].sort()) {
    const text = await readFile(path, "utf8");
    if (text.includes("\u0000") || text.includes("\ufffd")) throw new Error(`License is not UTF-8 text: ${path}`);
    texts.push({ file: slash(relative(directory, path)), text, sha256: createHash("sha256").update(text).digest("hex") });
  }
  return texts;
}
async function upstreamText(url, fetcher) {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "AtrisShare-license-inventory", Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`Pinned license source failed (${response.status}): ${url}`);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw new Error(`Oversized license source: ${url}`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
// A few crates omit repository-root licenses from the published archive. Only
// immutable commits recorded by Cargo are eligible; never use HEAD or a generic
// SPDX template (which would lose the actual copyright/attribution).
export async function pinnedCargoLicenses(pkg, fetcher = fetch, cache = new Map()) {
  let repository = githubRepository(pkg.repository);
  const fallback = !pkg.repository && cargoRepositoryFallbacks[`${pkg.name}@${pkg.version}`];
  if ((!repository && !fallback) || !pkg.source?.startsWith("registry+")) return [];
  let vcs;
  try { vcs = await json(join(dirname(pkg.manifest_path), ".cargo_vcs_info.json")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const commit = vcs.git?.sha1;
  if (!/^[a-f0-9]{40}$/.test(commit) || typeof vcs.path_in_vcs !== "string" ||
       vcs.path_in_vcs.split("/").some(part => part === ".." || part === ".")) throw new Error(`Invalid Cargo provenance: ${pkg.name}`);
  if (fallback) {
    if (pkg.source !== "registry+https://github.com/rust-lang/crates.io-index" || pkg.license !== fallback.license ||
        commit !== fallback.commit || vcs.path_in_vcs !== fallback.path) throw new Error(`Reviewed Cargo repository metadata no longer matches: ${pkg.name}`);
    repository = fallback.repository;
  }
  const texts = await githubLicenseTexts(repository, commit, vcs.path_in_vcs, fetcher, cache);
  return fallback ? texts.map(text => ({ ...text, resolution: "Published crate omitted repository and license files; resolved from its original .cargo_vcs_info.json commit in the reviewed upstream repository." })) : texts;
}
function githubRepository(value) {
  return /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec((typeof value === "string" ? value : value?.url ?? "").replace(/^git\+/, ""))?.[1];
}
async function githubLicenseTexts(repository, commit, packagePath, fetcher, cache) {
  const key = `${repository}/${commit}`;
  if (!cache.has(key)) cache.set(key, upstreamText(`https://api.github.com/repos/${repository}/git/trees/${commit}?recursive=1`, fetcher).then(JSON.parse));
  const tree = await cache.get(key);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error(`Incomplete upstream license tree: ${key}`);
  const ancestors = new Set([""]);
  const parts = packagePath.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) ancestors.add(parts.slice(0, i).join("/"));
  const candidates = tree.tree.filter(entry => {
    const segments = entry.path.split("/");
    // Include license directories under the package or its repository ancestors.
    return segments.some((part, index) => licenseName(part) && ancestors.has(segments.slice(0, index).join("/")));
  }).filter(entry => entry.type === "blob");
  if (candidates.length > 256) throw new Error(`Unbounded upstream licenses: ${key}`);
  const texts = [];
  for (const entry of candidates.sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    if (entry.mode === "120000" || entry.path.split("/").some(part => !part || part === "..")) throw new Error(`Unsafe upstream license path: ${entry.path}`);
    const sourceUrl = `https://raw.githubusercontent.com/${key}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
    if (!cache.has(sourceUrl)) cache.set(sourceUrl, upstreamText(sourceUrl, fetcher));
    const text = await cache.get(sourceUrl);
    if (text.trim().length < 100 || text.includes("\u0000") || text.includes("\ufffd")) throw new Error(`Invalid upstream license text: ${sourceUrl}`);
    texts.push({ file: entry.path, sourceUrl, commit, text, sha256: createHash("sha256").update(text).digest("hex") });
  }
  return texts;
}
async function npmPackage(root, directory, lock) {
  const manifest = await json(join(directory, "package.json"));
  const key = slash(relative(root, directory));
  const locked = lock.packages[key];
  if (!within(root, directory) || !locked || locked.version !== manifest.version) throw new Error(`Installed package differs from lockfile: ${manifest.name}`);
  const texts = await npmLicenseTexts(manifest, locked, directory);
  // twitter-text 3.1.0 omits the manifest SPDX field but ships the full Apache
  // license and Twitter copyright notice. Record that actual archive evidence.
  const packagedLicense = manifest.name === "twitter-text" && manifest.version === "3.1.0" && texts.some(t => t.file === "LICENSE" && /Copyright 2011 Twitter, Inc\./.test(t.text) && /Apache License[\s\S]*Version 2\.0, January 2004/.test(t.text)) ? "Apache-2.0" : null;
  return { ecosystem: "npm", name: manifest.name, version: manifest.version, license: manifest.license ?? locked.license ?? packagedLicense,
    lockKey: key, integrity: locked.integrity ?? null, texts };
}
export async function npmLicenseTexts(manifest, locked, directory, fetcher = fetch) {
  let texts = await licenseTexts(directory);
  if (!texts.length) {
    const exception = npmLicenseExceptions[`${manifest.name}@${manifest.version}`];
    if (exception) {
      if (locked.integrity !== exception.integrity || manifest.license !== exception.license || githubRepository(manifest.repository) !== exception.repository) {
        throw new Error(`Reviewed license exception no longer matches: ${manifest.name}`);
      }
      const sourceUrl = `https://raw.githubusercontent.com/${exception.repository}/${exception.commit}/LICENSE`;
      const text = await upstreamText(sourceUrl, fetcher);
      if (createHash("sha256").update(text).digest("hex") !== exception.sha256) throw new Error(`Reviewed upstream license hash mismatch: ${manifest.name}`);
      return [{ file: "LICENSE", text, sourceUrl, commit: exception.commit, sha256: exception.sha256, resolution: exception.resolution }];
    }
    const published = JSON.parse(await upstreamText(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`, fetcher));
    const repository = githubRepository(manifest.repository);
    if (!repository || repository !== githubRepository(published.repository) || published.name !== manifest.name || published.version !== manifest.version ||
        published.license !== manifest.license || !locked.integrity || published.dist?.integrity !== locked.integrity || !/^[a-f0-9]{40}$/.test(published.gitHead)) {
      throw new Error(`Unverifiable npm license provenance: ${manifest.name}`);
    }
    texts = await githubLicenseTexts(repository, published.gitHead, "", fetcher, new Map());
  }
  return texts;
}
async function packageDirectory(start, name, root) {
  if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error(`Invalid dependency name: ${name}`);
  let parent = start;
  while (within(root, parent)) {
    const candidate = join(parent, "node_modules", name);
    try {
      const manifest = await json(join(candidate, "package.json"));
      if (manifest.name !== name) throw new Error(`Dependency name mismatch: ${name}`);
      return await realpath(candidate);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (parent === root) break;
    parent = dirname(parent);
  }
  return null;
}
async function frontendGraph(root, lock) {
  const visited = new Set(), result = [];
  async function visit(directory, application = false) {
    if (visited.has(directory)) return;
    visited.add(directory);
    const manifest = await json(join(directory, "package.json"));
    if (!application) result.push(await npmPackage(root, directory, lock));
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      const resolved = await packageDirectory(directory, name, root);
      if (!resolved) {
        if (name in (manifest.optionalDependencies ?? {}) || manifest.peerDependenciesMeta?.[name]?.optional) continue;
        throw new Error(`Missing frontend dependency: ${manifest.name} -> ${name}`);
      }
      await visit(resolved);
    }
  }
  await visit(join(root, "apps", "desktop"), true);
  return result;
}
async function bundledGraph(root, metafile, lock) {
  const directories = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    if (!slash(input).includes("node_modules/")) continue;
    let directory = dirname(resolve(root, input));
    while (within(root, directory)) {
      try {
        const manifest = await json(join(directory, "package.json"));
        if (manifest.name) { directories.add(await realpath(directory)); break; }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      directory = dirname(directory);
    }
  }
  return Promise.all([...directories].sort().map(directory => npmPackage(root, directory, lock)));
}
export async function rustGraph(root) {
  const { stdout: version } = await exec("rustc", ["-vV"], { cwd: root });
  const target = /^host: (.+)$/m.exec(version)?.[1];
  if (!target) throw new Error("Could not determine the native Rust target");
  const { stdout } = await exec("cargo", ["metadata", "--locked", "--format-version", "1", "--filter-platform", target,
    "--features", "custom-protocol", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const metadata = JSON.parse(stdout), nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const reachable = new Set();
  function visit(id) { if (reachable.has(id)) return; reachable.add(id); for (const dep of nodes.get(id)?.deps ?? []) visit(dep.pkg); }
  visit(metadata.resolve.root);
  const components = [], cache = new Map();
  for (const pkg of metadata.packages.filter(pkg => reachable.has(pkg.id) && pkg.id !== metadata.resolve.root)) {
    let texts = await licenseTexts(dirname(pkg.manifest_path), pkg.license_file);
    if (!texts.length) texts = await pinnedCargoLicenses(pkg, fetch, cache);
    // MPL is a steward-authored standard license, not a copyright template. Some
    // crates ship only its Exhibit A header. Retain that actual header alongside
    // the steward's full v2 text; do not synthesize missing MIT/BSD attributions.
    if (!texts.length && pkg.license === "MPL-2.0") {
      const library = pkg.targets.find(target => target.kind.includes("lib"));
      const source = library && await readFile(library.src_path, "utf8");
      const header = source && /^\/\*[\s\S]*?\*\//.exec(source)?.[0];
      if (header?.includes("https://mozilla.org/MPL/2.0/")) {
        const sourceUrl = "https://www.mozilla.org/media/MPL/2.0/index.txt";
        const text = await upstreamText(sourceUrl, fetch);
        if (!text.startsWith("Mozilla Public License Version 2.0") || text.length < 15000) throw new Error("Invalid Mozilla full license text");
        texts = [{ file: "MPL-2.0.txt", sourceUrl, text, sha256: createHash("sha256").update(text).digest("hex") },
          { file: slash(relative(dirname(pkg.manifest_path), library.src_path)), text: header, sha256: createHash("sha256").update(header).digest("hex") }];
      }
    }
    components.push({ ecosystem: "cargo", name: pkg.name, version: pkg.version, license: pkg.license,
      source: pkg.source, sourceCodeUrl: pkg.source === "registry+https://github.com/rust-lang/crates.io-index" ?
        `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/download` : pkg.repository, texts });
  }
  return { target, components };
}
function notices(components) {
  return components.map(component => [`${component.ecosystem}: ${component.name}@${component.version} (${component.license ?? "UNDECLARED"})`,
    ...(component.sourceCodeUrl ? [`Unmodified upstream source: ${component.sourceCodeUrl}`] : []),
    ...component.texts.map(text => `--- ${text.file}${text.sourceUrl ? ` (${text.sourceUrl})` : ""} ---\n${text.resolution ? `${text.resolution}\n\n` : ""}${text.text}`)].join("\n\n")).join("\n\n========================================\n\n") + "\n";
}
export async function collectLicenses(root, output, { api, mcp }) {
  const lock = await json(join(root, "package-lock.json"));
  const rust = await rustGraph(root);
  const groups = {
    API: await bundledGraph(root, api, lock), MCP: await bundledGraph(root, mcp, lock),
    FRONTEND: await frontendGraph(root, lock), RUST: rust.components
  };
  const missing = Object.values(groups).flat().filter(component => !component.license ||
    !component.texts.some(text => /(^|\/)(licen[cs]es?|copying|unlicense|MPL-2\.0)([._/-]|$)/i.test(text.file)));
  if (missing.length) throw new Error(`Incomplete license inventory; supply upstream full texts before packaging: ${[...new Set(missing.map(c => `${c.ecosystem}:${c.name}@${c.version}`))].join(", ")}`);
  for (const [group, components] of Object.entries(groups)) {
    components.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));
    await writeFile(join(output, `${group}-THIRD-PARTY-NOTICES.txt`), notices(components));
  }
  const components = Object.entries(groups).flatMap(([group, entries]) => entries.map(({ texts, ...component }) => ({
    ...component, group, licenseFiles: texts.map(({ text, ...provenance }) => provenance)
  })));
  const inventory = { schemaVersion: 1, complete: true, distributionReviewRequired: true, rustTarget: rust.target,
    coverage: { API: "esbuild bundled input graph", MCP: "esbuild bundled input graph",
      FRONTEND: "conservative installed production/optional/peer dependency closure, not exact Vite tree-shaking output",
      RUST: "locked target-filtered Cargo graph including build dependencies and custom-protocol; not linker reachability" },
    limitations: ["License text presence and provenance are checked, not legal compatibility or patent clearance.",
      "External tools/models, system libraries, WebView2 and installer tooling are not represented as bundled application dependencies.",
      "Rust standard library/toolchain notices require separate distribution review; this inventory covers Cargo packages."], components };
  await writeFile(join(output, "dependency-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  return rust.target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--verify" || !process.argv[3]) throw new Error("Usage: node scripts/package-inventory.mjs --verify <runtime-directory>");
  const manifest = await verifyRuntime(resolve(process.argv[3]), { root: repository });
  console.log(`Verified ${Object.keys(manifest.files).length} standalone runtime resources for ${manifest.platform}/${manifest.arch}.`);
}
