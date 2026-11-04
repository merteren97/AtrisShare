import { z } from "zod";
import { createProjectSchema, idSchema, projectActionSchema, updateProjectSchema } from "../../../packages/domain/src/workspace.js";
import type { WorkspaceStore } from "../../../packages/storage/src/store.js";

/** Mount after runtime authentication, before the legacy /api/projects branches. */
export async function projectRoute(store: WorkspaceStore, method: string, url: URL, body: () => Promise<unknown>) {
  if (url.pathname === "/api/projects") {
    if (method === "GET") {
      const state = z.enum(["active", "trashed"]).parse(url.searchParams.get("state") ?? "active");
      return { status: 200, body: store.listProjects(idSchema.parse(url.searchParams.get("accountId")), state) };
    }
    if (method === "POST") return { status: 201, body: store.createProject(createProjectSchema.parse(await body())) };
  }
  const match = /^\/api\/projects\/([^/]+)(\/restore)?$/.exec(url.pathname);
  if (!match) return null;
  const id = idSchema.parse(match[1]);
  if (!match[2] && method === "PATCH") return { status: 200, body: store.updateProject(id, updateProjectSchema.parse(await body())) };
  if (!match[2] && method === "DELETE") return { status: 200, body: store.trashProject(id, projectActionSchema.parse(await body())) };
  if (match[2] && method === "POST") return { status: 200, body: store.restoreProject(id, projectActionSchema.parse(await body())) };
  return null;
}
