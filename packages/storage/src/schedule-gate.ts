import type { DatabaseSync } from "node:sqlite";
import type { ScheduleBinding } from "../../domain/src/scheduling.js";
import { WorkspaceError } from "./config.js";

/** Called inside the publisher's claim transaction, never a separately reusable authorization. */
export function consumeScheduledApproval(db: DatabaseSync, publicationId: string, binding: ScheduleBinding | undefined, now: number, reapproval = false): void {
  const row = db.prepare("SELECT o.id,o.data,o.generation,s.data schedule FROM schedule_occurrences o JOIN schedules s ON s.id=o.schedule_id WHERE o.publication_id=?").get(publicationId) as { id: string; data: string; generation: number; schedule: string } | undefined;
  if (!row) { if (binding) throw new WorkspaceError(409, "schedule_approval_stale"); return; }
  const occurrence = JSON.parse(row.data) as { state: string; dueAt: string; reviewUntil: string };
  const schedule = JSON.parse(row.schedule) as { revision: number; state: string };
  if (!binding || binding.occurrenceId !== row.id || binding.dueAt !== occurrence.dueAt || binding.reviewUntil !== occurrence.reviewUntil ||
      occurrence.state !== (reapproval ? "dispatched" : "awaiting-approval") || schedule.revision !== row.generation || !["active", "completed"].includes(schedule.state) ||
      now < Date.parse(binding.dueAt) || now >= Date.parse(binding.reviewUntil)) throw new WorkspaceError(409, "schedule_approval_stale");
  if (!reapproval) db.prepare("UPDATE schedule_occurrences SET data=json_set(data,'$.state','dispatched') WHERE id=?").run(row.id);
}
