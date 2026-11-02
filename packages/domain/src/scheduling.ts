import { z } from "zod";
import { idSchema, type WorkspaceContext } from "./workspace.js";
import { studioContextSchema } from "./studio.js";

export const scheduleBindingSchema = z.object({ occurrenceId: idSchema, dueAt: z.string().datetime(), reviewUntil: z.string().datetime() }).strict();
export type ScheduleBinding = z.infer<typeof scheduleBindingSchema>;
export const scheduleRuleSchema = z.object({
  frequency: z.enum(["once", "daily", "weekly"]),
  localStart: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/),
  timeZone: z.string().min(1).max(100).refine(value => { try { return !/^[+-]/.test(new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone); } catch { return false; } }),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7), missedPolicy: z.enum(["ask", "skip"])
}).strict().superRefine((v, c) => {
  const d = new Date(`${v.localStart}:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 16) !== v.localStart || d.getUTCFullYear() < 2020 || d.getUTCFullYear() > 2100)
    c.addIssue({ code: "custom", message: "Invalid calendar date" });
  if (new Set(v.weekdays).size !== v.weekdays.length || (v.frequency === "weekly" && !v.weekdays.length)) c.addIssue({ code: "custom", message: "Weekly days required" });
});
export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;
export const createScheduleSchema = z.object({ context: studioContextSchema, name: z.string().trim().min(1).max(100),
  kind: z.enum(["youtube", "social"]), draftId: idSchema, rule: scheduleRuleSchema }).strict();
export const updateScheduleSchema = z.object({ context: studioContextSchema, expectedRevision: z.number().int().positive(), rule: scheduleRuleSchema }).strict();
export const scheduleActionSchema = updateScheduleSchema.omit({ rule: true });
export type ScheduleKind = "youtube" | "social";
export interface Schedule { id: string; name: string; context: WorkspaceContext; destinationId: string; kind: ScheduleKind; rule: ScheduleRule;
  revision: number; state: "active" | "paused" | "cancelled" | "completed"; nextDueAt: string | null; createdAt: string; missedThrough?: string }
export interface Occurrence { id: string; scheduleId: string; context: WorkspaceContext; destinationId: string; kind: ScheduleKind;
  dueAt: string; localTime: string; timeZone: string; reviewUntil: string; state: "scheduled" | "awaiting-approval" | "dispatched" | "completed" | "skipped" | "expired" | "cancelled" | "blocked";
  publicationId: string | null; error: string | null; missed: boolean; publicationState?: string }

const formatters = new Map<string, Intl.DateTimeFormat>();
export function localMinute(instant: number, zone: string): string {
  let f = formatters.get(zone);
  if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); if (formatters.size < 128) formatters.set(zone, f); }
  const p = Object.fromEntries(f.formatToParts(instant).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** Resolve a wall minute without normalizing DST gaps. An overlap selects its first instant. */
export function wallInstant(local: string, zone: string): number | null {
  const wall = Date.parse(`${local}:00Z`), candidates = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = wall + hours * 3600_000;
    const offset = Date.parse(`${localMinute(probe, zone)}:00Z`) - Math.floor(probe / 60000) * 60000;
    const candidate = wall - offset;
    if (localMinute(candidate, zone) === local) candidates.add(candidate);
  }
  return candidates.size ? Math.min(...candidates) : null;
}
export function futureStart(rule: ScheduleRule, now: number): boolean {
  const instant = wallInstant(rule.localStart, rule.timeZone);
  return instant === null ? rule.localStart > localMinute(now, rule.timeZone) : instant > now;
}
/** Bounded search; nonexistent recurring wall times are skipped, never shifted. */
export function nextSlot(rule: ScheduleRule, after: number): { dueAt: string; localTime: string } | null {
  scheduleRuleSchema.parse(rule);
  const startDay = rule.localStart.slice(0, 10), today = localMinute(after, rule.timeZone).slice(0, 10);
  let day = rule.frequency === "once" ? startDay : startDay > today ? startDay : today;
  for (let i = 0; i < 370; i++) {
    const localTime = `${day}T${rule.localStart.slice(11)}`;
    if (rule.frequency !== "weekly" || rule.weekdays.includes(new Date(`${day}T12:00Z`).getUTCDay())) {
      const instant = wallInstant(localTime, rule.timeZone);
      if (instant !== null && instant > after) return { dueAt: new Date(instant).toISOString(), localTime };
    }
    if (rule.frequency === "once") return null;
    day = new Date(Date.parse(`${day}T12:00Z`) + 86400_000).toISOString().slice(0, 10);
  }
  return null;
}
