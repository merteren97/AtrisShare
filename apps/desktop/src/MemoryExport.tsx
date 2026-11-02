import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import type { WorkspaceContext, WorkspaceMemory } from "../../../packages/domain/src/workspace.js";
import { request } from "./api";

export function MemoryExport({ context, language }: { context: WorkspaceContext; language: "tr" | "en" }) {
  return <ScopedExport key={`${context.accountId}/${context.projectId ?? ""}`} context={context} language={language} />;
}
function ScopedExport({ context, language }: { context: WorkspaceContext; language: "tr" | "en" }) {
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const abort = useRef<AbortController | null>(null), url = useRef<string | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { abort.current?.abort(); if (url.current) URL.revokeObjectURL(url.current); if (timer.current) clearTimeout(timer.current); }, []);
  async function download() {
    if (busy) return;
    const controller = new AbortController(); abort.current = controller; setBusy(true); setFailed(false);
    try {
      const q = new URLSearchParams({ accountId: context.accountId, projectId: context.projectId ?? "" });
      const notes = await request<WorkspaceMemory[]>(`/api/memory?${q}`, "GET", undefined, controller.signal);
      if (controller.signal.aborted) return;
      const documentValue = { format: "atris-share-memory", version: 1, exportedAt: new Date().toISOString(), context,
        notes: notes.map(({ id, kind, text, reviewState, revision, provenance, updatedAt }) => ({ id, kind, text, reviewState, revision, provenance, updatedAt })) };
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(new Blob([JSON.stringify(documentValue, null, 2)], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url.current; link.download = `atrisshare-memory-${context.accountId}-${context.projectId ?? "account"}.json`; link.click();
      timer.current = setTimeout(() => { if (url.current) URL.revokeObjectURL(url.current); url.current = null; }, 1000);
    } catch { if (!controller.signal.aborted) setFailed(true); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <div><button className="button secondary" disabled={busy} onClick={() => { void download(); }}><ArrowDownToLine size={16} />{language === "tr" ? busy ? "Dışa aktarılıyor…" : "Kapsamı dışa aktar" : busy ? "Exporting…" : "Export this scope"}</button>
    {failed && <p role="alert" className="form-error">{language === "tr" ? "Dışa aktarılamadı. Tekrar dene." : "Export failed. Try again."}</p>}</div>;
}
