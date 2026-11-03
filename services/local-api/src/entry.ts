import { APP_VERSION } from "../../../packages/domain/src/workspace.js";
import { NATIVE_ORIGINS, startApi } from "./server.js";

const token = process.env.ATRIS_SHARE_RUNTIME_TOKEN;
if (!token || token.length < 32) throw new Error("A protected runtime session is required");
const devOrigin = process.env.ATRIS_SHARE_DEV_ORIGIN;
if (devOrigin && devOrigin !== "http://127.0.0.1:1438") throw new Error("Invalid native development origin");
const api = await startApi({ token, managedMediaTools: true, refreshAiModels: true, ...(devOrigin ? { allowedOrigins: [...NATIVE_ORIGINS, devOrigin] } : {}) });
process.stdout.write(`ATRIS_SHARE_READY ${JSON.stringify({ origin: api.origin, pid: process.pid, version: APP_VERSION })}\n`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 5000).unref();
  await api.close();
  clearTimeout(timeout);
  process.exit(0);
}
process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
process.stdin.resume();
process.stdin.on("end", () => { void stop(); });
api.server.on("close", () => { void stop(); });
const parent = Number(process.env.ATRIS_SHARE_PARENT_PID);
if (Number.isSafeInteger(parent) && parent > 0) {
  setInterval(() => {
    try { process.kill(parent, 0); } catch { void stop(); }
  }, 2000).unref();
}
