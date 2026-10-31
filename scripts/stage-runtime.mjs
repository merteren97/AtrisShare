import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
