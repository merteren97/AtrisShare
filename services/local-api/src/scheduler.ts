import type { WorkspaceStore } from "../../../packages/storage/src/store.js";
import type { ScheduleKind } from "../../../packages/domain/src/scheduling.js";
import type { WorkspaceContext } from "../../../packages/domain/src/workspace.js";

/** Materializes local review work only. Publication transport/leases remain publisher-owned. */
export class Scheduler {
  private readonly timer: ReturnType<typeof setInterval>;
  private failures = 0;
  private readonly checked = new Map<string, { next: number; attempts: number }>();
  constructor(private readonly store: WorkspaceStore, private readonly reconcile?: (kind: ScheduleKind, id: string, context: WorkspaceContext, destinationId: string) => void) {
    this.tick(); this.timer = setInterval(() => this.tick(), 5000); this.timer.unref();
  }
  private tick() {
    try {
      this.store.schedules.tick(); this.failures = 0;
      const receipts = this.store.schedules.processingReceipts(), current = new Set(receipts.map(p => p.id)), accounts = new Set<string>();
      for (const id of this.checked.keys()) if (!current.has(id)) this.checked.delete(id);
      for (const p of receipts) {
        const prior = this.checked.get(p.id);
        if (accounts.has(p.context.accountId) || (prior?.next ?? 0) > Date.now()) continue;
        const attempts = (prior?.attempts ?? 0) + 1;
        this.checked.set(p.id, { next: Date.now() + Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5)), attempts });
        accounts.add(p.context.accountId);
        try { this.reconcile?.(p.kind, p.id, p.context, p.destinationId); } catch { /* Existing publisher leases own contention; no dispatch retry here. */ }
      }
    } catch { this.failures++; }
  }
  status() { return { runningOnly: true, recovering: this.failures > 0 }; }
  close() { clearInterval(this.timer); }
}
