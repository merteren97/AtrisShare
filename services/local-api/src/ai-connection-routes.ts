import { aiConnectionScopeSchema, aiConnectionTestSchema } from "../../../packages/domain/src/ai.js";
import type { AiService } from "./ai.js";

/** Call only AFTER the desktop bearer/host/origin checks; never from MCP routes. */
export async function aiConnectionRoute(ai: AiService, method: string, url: URL, body: () => Promise<unknown>) {
  if (method === "GET" && url.pathname === "/api/ai/connection") {
    const scope = aiConnectionScopeSchema.parse({ context: { accountId: url.searchParams.get("accountId"), projectId: url.searchParams.get("projectId") } });
    return { status: 200, body: await ai.connectionStatus(scope) };
  }
  if (method === "POST" && url.pathname === "/api/ai/connection/tests") {
    return { status: 202, body: await ai.startConnectionTest(aiConnectionTestSchema.parse(await body())) };
  }
  const cancel = /^\/api\/ai\/connection\/tests\/([^/]+)\/cancel$/u.exec(url.pathname);
  if (method === "POST" && cancel) {
    return { status: 200, body: await ai.cancelConnectionTest(cancel[1]!, aiConnectionScopeSchema.parse(await body())) };
  }
  return null;
}
