import type { WorkspaceContext } from "../../../packages/domain/src/workspace.js";
import type { WorkspaceStore } from "../../../packages/storage/src/store.js";
import { WorkspaceError } from "../../../packages/storage/src/config.js";

/** Capture when granting access/launching async work; call after awaits and before
 * effects. A restore deliberately never makes an old capability valid again.
 */
export function projectLifecycleGuard(store: WorkspaceStore, value: WorkspaceContext, code = "context_not_found", status = 404): () => void {
  const context = { ...value }, epoch = store.projectAccessEpoch(context);
  return () => {
    try { if (store.projectAccessEpoch(context) === epoch) return; } catch { /* Closed/deleted context is invalid. */ }
    throw new WorkspaceError(status, code);
  };
}

/** Optional task adapter for quiet child processes: poll the same durable fence,
 * abort promptly, and still assert before committing any result after an await.
 * The owning service must dispose in its task's finally block.
 */
export function watchProjectLifecycle(store: WorkspaceStore, context: WorkspaceContext, abort: AbortController) {
  const assertActive = projectLifecycleGuard(store, context);
  const timer = setInterval(() => { try { assertActive(); } catch { abort.abort(); } }, 1000);
  timer.unref();
  return { assertActive, dispose: () => clearInterval(timer) };
}
