import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { startApi } from "../../services/local-api/src/server.js";

const DEV_ORIGIN = "http://127.0.0.1:1438";
function localRuntime(): Plugin {
  return {
    name: "atris-share-local-runtime",
    async configureServer(server) {
      const runtime = await startApi({ allowedOrigins: [DEV_ORIGIN], managedMediaTools: true });
      server.httpServer?.once("close", () => { void runtime.close(); });
      server.middlewares.use("/__atris/bootstrap", (request, response) => {
        if (request.method !== "GET" || request.headers.host !== new URL(DEV_ORIGIN).host ||
            (request.headers.origin && request.headers.origin !== DEV_ORIGIN) || request.headers["x-atris-bootstrap"] !== "1") {
          response.writeHead(403); response.end(); return;
        }
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        response.end(JSON.stringify({ origin: runtime.origin, token: runtime.token }));
      });
    }
  };
}
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "native" ? [] : [localRuntime()])],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1438, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022" }
}));
