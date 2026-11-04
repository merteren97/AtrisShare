import { invoke, isTauri } from "@tauri-apps/api/core";
import type { RuntimeConfig } from "../../../packages/domain/src/workspace.js";
import type { WorkspaceContext } from "../../../packages/domain/src/workspace.js";

export class ApiError extends Error {
  constructor(public readonly code: string) { super(code); }
}
let runtime: Promise<RuntimeConfig> | undefined;
export function reconnect(): void { runtime = undefined; }
async function bootstrap(): Promise<RuntimeConfig> {
  const config: RuntimeConfig = isTauri()
    ? await invoke<RuntimeConfig>("runtime_config")
    : await fetch("/__atris/bootstrap", { headers: { "X-Atris-Bootstrap": "1" }, cache: "no-store" }).then(async r => {
        if (!r.ok) throw new ApiError("connection_failed");
        return r.json() as Promise<RuntimeConfig>;
      });
  const origin = new URL(config.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || !config.token || config.token.length < 32) {
    throw new ApiError("invalid_runtime");
  }
  return config;
}
export async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  runtime ??= bootstrap();
  const config = await runtime;
  const response = await fetch(`${config.origin}${path}`, {
    method, headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    cache: "no-store", ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {})
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({ error: "operation_failed" })) as { error?: string };
    throw new ApiError(result.error ?? "operation_failed");
  }
  return response.json() as Promise<T>;
}
export async function binaryRequest<T>(path: string, file: File, signal?: AbortSignal): Promise<T> {
  runtime ??= bootstrap(); const config = await runtime;
  const response = await fetch(`${config.origin}${path}`, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/octet-stream" },
    body: file, ...(signal ? { signal } : {}) });
  if (!response.ok) { const value = await response.json().catch(() => ({})) as {error?:string}; throw new ApiError(value.error ?? "operation_failed"); }
  return response.json() as Promise<T>;
}
export async function mediaBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  runtime ??= bootstrap(); const config = await runtime;
  const response = await fetch(`${config.origin}${path}`, { headers: { Authorization: `Bearer ${config.token}` }, cache: "no-store", ...(signal ? { signal } : {}) });
  if (!response.ok) { const value = await response.json().catch(() => ({})) as {error?:string}; throw new ApiError(value.error ?? "operation_failed"); }
  return response.blob();
}
/** Native save streams directly to disk; browser streaming uses File System Access when present. */
export async function saveMedia(artifactId: string, context: WorkspaceContext, filename: string, signal?: AbortSignal): Promise<void> {
  if (isTauri()) { await invoke("native_save_media",{artifactId,accountId:context.accountId,projectId:context.projectId,filename}); return; }
  type Writable = {write:(chunk:Uint8Array)=>Promise<void>;close:()=>Promise<void>;abort:()=>Promise<void>};
  type PickerWindow = Window & {showSaveFilePicker?: (options:{suggestedName:string;types:{description:string;accept:Record<string,string[]>}[]})=>Promise<{createWritable:()=>Promise<Writable>}>};
  const picker=(window as PickerWindow).showSaveFilePicker;
  // Open the picker before the first await that follows the user gesture.
  const handle=picker?await picker({suggestedName:filename,types:[{description:"MP4 video",accept:{"video/mp4":[".mp4"]}}]}):null;
  runtime ??= bootstrap(); const config = await runtime;
  const q=new URLSearchParams({accountId:context.accountId,projectId:context.projectId??""});
  const response=await fetch(`${config.origin}/api/media/${encodeURIComponent(artifactId)}/download?${q}`,{headers:{Authorization:`Bearer ${config.token}`},...(signal?{signal}:{})});
  if(!response.ok) {const value=await response.json().catch(()=>({})) as {error?:string};throw new ApiError(value.error??"operation_failed");}
  if(handle&&response.body){const writable=await handle.createWritable(),reader=response.body.getReader();try{while(true){const {done,value}=await reader.read();if(done)break;await writable.write(value);}await writable.close();}catch(e){await writable.abort().catch(()=>{});throw e;}finally{await reader.cancel().catch(()=>{});}return;}
  if(Number(response.headers.get("content-length"))>256*1024**2){void response.body?.cancel();throw new ApiError("studio_blob_limit");}
  const url=URL.createObjectURL(await response.blob()),anchor=document.createElement("a");anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
