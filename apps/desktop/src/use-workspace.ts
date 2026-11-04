import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditEvent, WorkspaceContext, WorkspaceMemory, WorkspaceProject, WorkspaceSnapshot } from "../../../packages/domain/src/workspace.js";
import { reconnect, request } from "./api";

export function scopeQuery(scope: WorkspaceContext): string {
  return new URLSearchParams({ accountId: scope.accountId, projectId: scope.projectId ?? "" }).toString();
}
export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [memory, setMemory] = useState<WorkspaceMemory[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async (generation: number) => {
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    try {
      const state = await request<WorkspaceSnapshot>("/api/workspace", "GET", undefined, abort.signal);
      if (generation !== epoch.current) return;
      setSnapshot(state);
      const [entries, events] = state.context ? await Promise.all([
        request<WorkspaceMemory[]>(`/api/memory?${scopeQuery(state.context)}`, "GET", undefined, abort.signal),
        request<AuditEvent[]>(`/api/audit?${scopeQuery(state.context)}`, "GET", undefined, abort.signal)
      ]) : [[], []];
      if (generation !== epoch.current) return;
      setMemory(entries); setAudit(events);
    } catch (failure) {
      if (generation === epoch.current && !abort.signal.aborted) setError(failure);
    } finally { if (generation === epoch.current) setLoading(false); }
  }, []);
  const refresh = useCallback(async (reset = false) => {
    if (reset) reconnect();
    setLoading(true); setError(null); setMemory([]); setAudit([]);
    await load(++epoch.current);
  }, [load]);
  const chooseContext = useCallback(async (scope: WorkspaceContext) => {
    const generation = ++epoch.current;
    controller.current?.abort();
    setLoading(true); setError(null); setMemory([]); setAudit([]);
    setSnapshot(previous => previous ? { ...previous, context: scope,
      projects: previous.projects.filter(project => project.accountId === scope.accountId) } : null);
    try {
      await request("/api/context", "PUT", scope);
      if (generation === epoch.current) await load(generation);
    } catch (failure) {
      if (generation === epoch.current) { setSnapshot(null); setError(failure); setLoading(false); }
    }
  }, [load]);
  useEffect(() => {
    void refresh();
    return () => { ++epoch.current; controller.current?.abort(); };
  }, [refresh]);
  const changeProject = useCallback(async (project: WorkspaceProject, action: "rename" | "info" | "trash" | "restore", fields?: { name: string; description: string }) => {
    const path = `/api/projects/${project.id}${action === "restore" ? "/restore" : ""}`;
    await request(path, action === "trash" ? "DELETE" : action === "restore" ? "POST" : "PATCH", {
      context: { accountId: project.accountId, projectId: project.id }, expectedRevision: project.revision, ...fields
    });
    await refresh();
  }, [refresh]);
  return { snapshot, memory, audit, loading, error, refresh, chooseContext, changeProject };
}
