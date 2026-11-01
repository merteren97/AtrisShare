import { build } from "esbuild";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
if (process.versions.node !== "22.23.2") throw new Error("Stage the pinned Node 22 runtime by running npm run stage:runtime");
const output = join(root, "apps", "desktop", "src-tauri", "runtime");
await mkdir(output, { recursive: true });
await build({
  entryPoints: [join(root, "services", "local-api", "src", "entry.ts")], outfile: join(output, "api.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "linked"
});
const mcpBuild = await build({
  entryPoints: [join(root, "services", "mcp-server", "src", "index.ts")], outfile: join(output, "mcp.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "linked", metafile: true,
  banner: { js: 'import { createRequire as __atrisCreateRequire } from "node:module"; const require = __atrisCreateRequire(import.meta.url);' }
});
// Preserve full license texts for the actual bundled MCP dependency graph.
const packages = new Map();
for (const input of Object.keys(mcpBuild.metafile.inputs)) {
  if (!input.includes("node_modules/")) continue;
  let directory = dirname(resolve(input));
  while (directory.startsWith(root)) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (manifest.name && !packages.has(directory)) packages.set(directory, manifest);
      break;
    } catch { const parent = dirname(directory); if (parent === directory) break; directory = parent; }
  }
}
const notices = [];
for (const [directory, manifest] of packages) {
  notices.push(`${manifest.name}@${manifest.version} (${manifest.license ?? "see license"})`);
  for (const name of await readdir(directory)) if (/^(licen[cs]e|copying|notice)(\.|$)/i.test(name)) {
    try { notices.push(await readFile(join(directory, name), "utf8")); } catch { /* Some packages use a license directory. */ }
  }
}
await writeFile(join(output, "MCP-THIRD-PARTY-NOTICES.txt"), notices.join("\n\n---\n\n"));
await copyFile(process.execPath, join(output, process.platform === "win32" ? "node.exe" : "node"));
let nodeLicense;
try {
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  if (manifest.node === process.versions.node) nodeLicense = await readFile(join(output, "NODE-LICENSE.txt"), "utf8");
} catch { /* First staging downloads the pinned runtime's full license inventory. */ }
if (!nodeLicense) {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("Could not fetch the pinned Node.js license");
  nodeLicense = await response.text();
  if (!nodeLicense.startsWith("Node.js is licensed")) throw new Error("Invalid Node.js license response");
}
await writeFile(join(output, "NODE-LICENSE.txt"), nodeLicense);
await copyFile(join(dirname(require.resolve("zod/package.json")), "LICENSE"), join(output, "ZOD-LICENSE.txt"));
await writeFile(join(output, "manifest.json"), JSON.stringify({ version: "0.1.0-preview.1", node: process.versions.node, platform: process.platform, arch: process.arch }, null, 2));
console.log(`Staged Node ${process.versions.node} and local API for ${process.platform}/${process.arch}.`);
