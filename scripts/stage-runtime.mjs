import { build } from "esbuild";
import { copyFile, lstat, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { collectLicenses, repository, sealRuntime, sourceFingerprints, verifyRuntime } from "./package-inventory.mjs";

// A failed attempt invalidates the old staging directory. Tauri's pre-build hook
// must fail rather than silently packaging a previous successful runtime.
export async function replaceRuntime(output, metadata, produce, verification = {}) {
  const parent = dirname(output);
  if (!(await lstat(parent)).isDirectory()) throw new Error("Runtime staging parent is not a directory");
  const lock = await open(`${output}.lock`, "wx");
  let temporary;
  try {
    await rm(output, { recursive: true, force: true });
    temporary = await mkdtemp(join(parent, ".runtime-stage-"));
    await produce(temporary);
    await sealRuntime(temporary, metadata);
    await rename(temporary, output);
    temporary = undefined;
    await verifyRuntime(output, verification);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    finally { await lock.close(); await rm(`${output}.lock`, { force: true }); }
  }
}

export async function stageRuntime(root = repository) {
  const output = join(root, "apps", "desktop", "src-tauri", "runtime");
  const metadata = {};
  // Reuse only a fully hash-validated prior license for this exact Node version.
  let nodeLicense, previousNode;
  try {
    const previous = await verifyRuntime(output);
    previousNode = previous.node;
    nodeLicense = await readFile(join(output, "NODE-LICENSE.txt"), "utf8");
  } catch { /* No trusted reusable staging inventory. */ }
  await replaceRuntime(output, metadata, async temporary => {
    const app = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    Object.assign(metadata, { version: app.version, node: app.devDependencies.node, platform: process.platform, arch: process.arch,
      sources: await sourceFingerprints(root) });
    if (process.versions.node !== metadata.node) throw new Error(`Stage with pinned Node ${metadata.node}: npm run stage:runtime`);
    if (previousNode !== metadata.node) nodeLicense = undefined;
    const options = { absWorkingDir: root, bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "linked", metafile: true };
    const api = await build({ ...options, entryPoints: ["services/local-api/src/entry.ts"], outfile: join(temporary, "api.mjs"),
      banner: { js: 'import { createRequire as __atrisCreateRequire } from "node:module"; const require = __atrisCreateRequire(import.meta.url);' } });
    const mcp = await build({ ...options, entryPoints: ["services/mcp-server/src/index.ts"], outfile: join(temporary, "mcp.mjs"),
      banner: { js: 'import { createRequire as __atrisCreateRequire } from "node:module"; const require = __atrisCreateRequire(import.meta.url);' } });
    await collectLicenses(root, temporary, { api: api.metafile, mcp: mcp.metafile });
    await copyFile(process.execPath, join(temporary, process.platform === "win32" ? "node.exe" : "node"));
    if (!nodeLicense) {
      const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${metadata.node}/LICENSE`, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error("Could not fetch the pinned Node.js license");
      nodeLicense = await response.text();
    }
    if (!nodeLicense.startsWith("Node.js is licensed") || nodeLicense.length < 10000) throw new Error("Invalid Node.js full license inventory");
    await writeFile(join(temporary, "NODE-LICENSE.txt"), nodeLicense);
    const require = createRequire(join(root, "package.json"));
    await copyFile(join(dirname(require.resolve("zod/package.json")), "LICENSE"), join(temporary, "ZOD-LICENSE.txt"));
    await copyFile(join(root, "LICENSE"), join(temporary, "LICENSE.txt"));
    await copyFile(join(root, "NOTICE"), join(temporary, "NOTICE.txt"));
    if (JSON.stringify(metadata.sources) !== JSON.stringify(await sourceFingerprints(root))) throw new Error("Packaging inputs changed during staging; retry after edits finish");
  }, { root });
  console.log(`Staged and verified Node ${metadata.node}, API, MCP and license resources for ${metadata.platform}/${metadata.arch}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await stageRuntime();
