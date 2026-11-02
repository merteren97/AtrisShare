import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, CalendarClock, CalendarDays, Check, CircleAlert, Clock3, List, LoaderCircle, Pause, Play, Plus, RefreshCw, SkipForward, X } from "lucide-react";
import type { WorkspaceContext } from "../../../packages/domain/src/workspace.js";
import { ApiError, request } from "./api";
import { queueCopy, queueError, type QueueText } from "./queue-i18n";
import "./queue.css";

// Local wire types keep the screen usable while the scheduler domain is integrated.
// There is deliberately no runtime import from an unfinished scheduler module.
type Kind = "youtube" | "social";
type Rule = { frequency: "once" | "daily" | "weekly"; localStart: string; timeZone: string; weekdays: number[]; missedPolicy: "ask" | "skip" };
type Schedule = { id: string; name: string; context: WorkspaceContext; destinationId: string; kind: Kind; rule: Rule; revision: number;
  state: "active" | "paused" | "cancelled" | "completed"; nextDueAt: string | null; createdAt: string; missedThrough?: string };
type Occurrence = { id: string; scheduleId: string; context: WorkspaceContext; destinationId: string; kind: Kind; dueAt: string; localTime: string; timeZone: string;
  reviewUntil: string; state: "scheduled" | "awaiting-approval" | "dispatched" | "completed" | "skipped" | "expired" | "cancelled" | "blocked";
  publicationId: string | null; error: string | null; missed: boolean; publicationState?: string | null };
type Draft = { kind: Kind; id: string; label: string; destinationId: string };
type Snapshot = { schedules: Schedule[]; occurrences: Occurrence[]; drafts: Draft[]; runningOnly: true };
type Modal = { type: "create" } | { type: "edit" | "pause" | "cancel"; schedule: Schedule } | { type: "skip"; occurrence: Occurrence };
type Form = { name: string; draftKey: string; rule: Rule };
export interface QueuePanelProps {
  context: WorkspaceContext;
  language: "tr" | "en";
  onReview?: (kind: Kind, context: WorkspaceContext) => void;
}

const dayOrder = [1, 2, 3, 4, 5, 6, 0];
const openStates = new Set<Occurrence["state"]>(["scheduled", "awaiting-approval", "blocked", "dispatched"]);
const stateText: Record<Occurrence["state"], QueueText> = { scheduled: "scheduled", "awaiting-approval": "awaiting", dispatched: "dispatched", completed: "completed", skipped: "skipped", expired: "expired", cancelled: "cancelled", blocked: "blocked" };
const two = (value: number) => String(value).padStart(2, "0");
function systemZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } }
function tomorrow() {
  const date = new Date(); date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T09:00`;
}
function freshForm(): Form { return { name: "", draftKey: "", rule: { frequency: "once", localStart: tomorrow(), timeZone: systemZone(), weekdays: [], missedPolicy: "ask" } }; }
function localParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const epoch = Date.UTC(year, month - 1, day, hour, minute), date = new Date(epoch);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? { epoch, year, month, day, hour, minute } : null;
}
function zoneFormatter(zone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, calendar: "iso8601", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
function zoneClock(formatter: Intl.DateTimeFormat, time: number) {
  const parts = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function inspectStart(rule: Rule): { error: QueueText | null; gap: boolean } {
  const local = localParts(rule.localStart);
  if (!local) return { error: "invalidDate", gap: false };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = zoneFormatter(rule.timeZone);
    if (/^[+-]/.test(formatter.resolvedOptions().timeZone)) return { error: "invalidZone", gap: false };
  } catch { return { error: "invalidZone", gap: false }; }
  // Sample nearby offsets, then round-trip candidates through Intl. This resolves
  // repeated clock times to their FIRST instant without assuming the device zone.
  // The backend remains authoritative for recurrence generation and skipped gaps.
  const matches = new Set<number>();
  for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
    const sample = local.epoch + hours * 3600_000;
    const projected = localParts(zoneClock(formatter, sample));
    if (!projected) continue;
    const candidate = local.epoch - (projected.epoch - sample);
    if (zoneClock(formatter, candidate) === rule.localStart) matches.add(candidate);
  }
  const gap = matches.size === 0;
  const past = gap ? rule.localStart <= zoneClock(formatter, Date.now()) : Math.min(...matches) <= Date.now();
  return { error: past ? "past" : null, gap };
}
function draftKey(draft: Draft) { return `${draft.kind}:${draft.id}`; }
function sameScope(item: WorkspaceContext, selected: WorkspaceContext) {
  return item.accountId === selected.accountId && (selected.projectId === null || item.projectId === selected.projectId);
}
function errorKey(error: unknown): QueueText { return error instanceof ApiError ? queueError(error.code) : "error"; }

export function QueuePanel(props: QueuePanelProps) {
  // A scope change tears down requests, the dialog and its captured revision in
  // one render; a previous project's data/form can never flash in the new scope.
  return <QueueWorkspace key={`${props.context.accountId}/${props.context.projectId ?? ""}`} {...props} />;
}
function QueueWorkspace({ context, language, onReview }: QueuePanelProps) {
  const t = queueCopy[language], id = useId(), locale = language === "tr" ? "tr-TR" : "en-GB";
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false);
  const [readError, setReadError] = useState(false), [actionError, setActionError] = useState<QueueText | null>(null);
  const [view, setView] = useState<"agenda" | "list">("agenda"), [filter, setFilter] = useState<"open" | "all">("open");
  const [modal, setModal] = useState<Modal | null>(null), [form, setForm] = useState<Form>(freshForm);
  const [formError, setFormError] = useState<QueueText | null>(null), [pending, setPending] = useState(false), [notice, setNotice] = useState<QueueText | null>(null);
  const mounted = useRef(false), epoch = useRef(0), lock = useRef(false);
  const fetching = useRef<symbol | null>(null), getAbort = useRef<AbortController | null>(null), mutationAbort = useRef<AbortController | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null), createButton = useRef<HTMLButtonElement | null>(null), title = useRef<HTMLHeadingElement | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null), startInput = useRef<HTMLInputElement | null>(null), cancelButton = useRef<HTMLButtonElement | null>(null);
  const { accountId, projectId } = context;
  const load = useCallback(async (manual = false) => {
    if (fetching.current || lock.current || !mounted.current) return;
    const token = Symbol(), generation = epoch.current, abort = new AbortController();
    fetching.current = token; getAbort.current = abort;
    if (manual) setRefreshing(true);
    try {
      const query = new URLSearchParams({ accountId, projectId: projectId ?? "" });
      const next = await request<Snapshot>(`/api/queue?${query}`, "GET", undefined, abort.signal);
      if (!Array.isArray(next.schedules) || !Array.isArray(next.occurrences) || !Array.isArray(next.drafts) || next.runningOnly !== true ||
          next.schedules.some(item => !sameScope(item.context, { accountId, projectId })) || next.occurrences.some(item => !sameScope(item.context, { accountId, projectId }))) throw new ApiError("queue_scope_mismatch");
      if (mounted.current && generation === epoch.current) { setSnapshot(next); setReadError(false); }
    } catch { if (mounted.current && generation === epoch.current && !abort.signal.aborted) setReadError(true); }
    finally {
      if (fetching.current === token) fetching.current = null;
      if (mounted.current && generation === epoch.current && !abort.signal.aborted) { setLoading(false); if (manual) setRefreshing(false); }
    }
  }, [accountId, projectId]);
  useEffect(() => {
    mounted.current = true; epoch.current++; fetching.current = null;
    void load();
    const refreshVisible = () => { if (document.visibilityState === "visible") void load(); };
    const interval = setInterval(refreshVisible, 5000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { mounted.current = false; epoch.current++; clearInterval(interval); document.removeEventListener("visibilitychange", refreshVisible); getAbort.current?.abort(); mutationAbort.current?.abort(); };
  }, [load]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  const zones = useMemo(() => {
    try { return [...new Set(["UTC", systemZone(), ...Intl.supportedValuesOf("timeZone")])]; }
    catch { return [systemZone(), "UTC", "Europe/Istanbul", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"]; }
  }, []);
  const startInfo = useMemo(() => inspectStart(form.rule), [form.rule.localStart, form.rule.timeZone]);
  const dateTime = (value: string, zone: string) => {
    try { return new Intl.DateTimeFormat(locale, { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
    catch { return "—"; }
  };
  const dateLabel = (value: string) => {
    try { return new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: "full" }).format(new Date(`${value}T12:00:00Z`)); }
    catch { return value; }
  };
  const visible = [...(snapshot?.occurrences ?? [])].filter(item => filter === "all" || openStates.has(item.state)).sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
  const groups = new Map<string, Occurrence[]>();
  for (const item of visible) { const day = item.localTime.slice(0, 10); const group = groups.get(day) ?? []; group.push(item); groups.set(day, group); }
  const schedules = new Map(snapshot?.schedules.map(item => [item.id, item]));
  const disabled = pending || loading || readError;
  const modalForm = modal?.type === "create" || modal?.type === "edit";
  const selectedDraft = snapshot?.drafts.find(draft => draftKey(draft) === form.draftKey);
  const modalTitle = !modal ? "" : t[modal.type === "create" ? "createTitle" : modal.type === "edit" ? "editTitle" : modal.type === "pause" ? "pauseTitle" : modal.type === "cancel" ? "cancelTitle" : "skipTitle"];
  const modalDescription = !modal ? "" : t[modal.type === "create" ? "createHelp" : modal.type === "edit" ? "editHelp" : modal.type === "pause" ? "pauseHelp" : modal.type === "cancel" ? "cancelHelp" : "skipHelp"];

  function open(value: Modal) {
    if (lock.current) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFormError(null); setActionError(null);
    setForm(value.type === "edit" ? { name: value.schedule.name, draftKey: "", rule: { ...value.schedule.rule, weekdays: [...value.schedule.rule.weekdays] } } : freshForm());
    setModal(value);
  }
  function patchRule(patch: Partial<Rule>) { setForm(previous => ({ ...previous, rule: { ...previous.rule, ...patch } })); setFormError(null); }
  async function mutate(path: string, method: string, body: unknown, message: QueueText, inDialog = true) {
    if (lock.current) return;
    lock.current = true; setPending(true); setFormError(null); setActionError(null); setNotice(null);
    getAbort.current?.abort(); fetching.current = null; setRefreshing(false);
    const generation = epoch.current, abort = new AbortController(); mutationAbort.current = abort;
    try {
      await request(path, method, body, abort.signal);
      if (mounted.current && generation === epoch.current) { returnFocus.current = title.current; setModal(null); setNotice(message); }
    } catch (error) {
      if (mounted.current && generation === epoch.current && !abort.signal.aborted) {
        if (inDialog) setFormError(errorKey(error)); else setActionError(errorKey(error));
      }
    } finally {
      lock.current = false;
      if (mounted.current && generation === epoch.current) { setPending(false); void load(); }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!modal || lock.current) return;
    if (modalForm) {
      const inspection = inspectStart(form.rule);
      if (inspection.error) { setFormError(inspection.error); return; }
      if (form.rule.frequency === "weekly" && (!form.rule.weekdays.length || form.rule.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6))) { setFormError("noDays"); return; }
      const rule: Rule = { ...form.rule, timeZone: form.rule.timeZone.trim(), weekdays: form.rule.frequency === "weekly" ? [...form.rule.weekdays].sort((a, b) => a - b) : [] };
      if (modal.type === "create") {
        if (!selectedDraft || !context.projectId) { setFormError("missingDraft"); return; }
        if (!form.name.trim()) { setFormError("invalid"); return; }
        void mutate("/api/schedules", "POST", { context: { ...context }, name: form.name.trim(), kind: selectedDraft.kind, draftId: selectedDraft.id, rule }, "created");
      } else if (modal.type === "edit") {
        void mutate(`/api/schedules/${encodeURIComponent(modal.schedule.id)}`, "PUT", { context: { ...modal.schedule.context }, expectedRevision: modal.schedule.revision, rule }, "updated");
      }
    } else if (modal.type === "skip") {
      void mutate(`/api/queue/${encodeURIComponent(modal.occurrence.id)}/skip`, "POST", { context: { ...modal.occurrence.context } }, "changed");
    } else if (modal.type === "pause" || modal.type === "cancel") {
      void mutate(`/api/schedules/${encodeURIComponent(modal.schedule.id)}/${modal.type}`, "POST", { context: { ...modal.schedule.context }, expectedRevision: modal.schedule.revision }, "changed");
    }
  }
  function ruleSummary(rule: Rule) {
    const days = dayOrder.filter(day => rule.weekdays.includes(day)).map(day => t.weekdaysShort[day]).join(", ");
    return `${t[rule.frequency]}${rule.frequency === "weekly" ? ` · ${days}` : ""} · ${rule.missedPolicy === "ask" ? t.ask : t.skipMissed}`;
  }
  function occurrenceRow(item: Occurrence) {
    const schedule = schedules.get(item.scheduleId);
    const publicationState = item.publicationState && Object.prototype.hasOwnProperty.call(t.publicationStates, item.publicationState) ? t.publicationStates[item.publicationState as keyof typeof t.publicationStates] : t.reviewStatus;
    return <li key={item.id} className="queue-occurrence">
      <div className="queue-occurrence__time"><time dateTime={item.dueAt}>{view === "list" ? item.localTime.replace("T", " · ") : item.localTime.slice(11, 16)}</time><span>{item.timeZone}</span></div>
      <div className="queue-occurrence__body"><div className="queue-row-heading"><strong>{schedule?.name ?? t.unknownSchedule}</strong><span className={`queue-state queue-state--${item.state}`}>{t[stateText[item.state]]}</span></div>
        <div className="queue-row-meta"><span>{t[item.kind]}</span><span>{t.destination}: <code>{item.destinationId}</code></span>{item.missed && <span className="queue-missed">{t.missed}</span>}</div>
        {item.publicationId ? <p className="queue-help">{t.publicationState}: {publicationState}</p> : item.state === "scheduled" ? <p className="queue-help">{t.dueReview}</p> : null}
        {item.error && <p className="queue-inline-error"><CircleAlert size={13} aria-hidden="true" />{t.issue}</p>}
        <details className="queue-details"><summary>{t.details}</summary><dl><div><dt>{t.dueUtc}</dt><dd><time dateTime={item.dueAt}>{dateTime(item.dueAt, "UTC")} UTC</time></dd></div><div><dt>{t.reviewUntil}</dt><dd><time dateTime={item.reviewUntil}>{dateTime(item.reviewUntil, item.timeZone)} · {item.timeZone}</time></dd></div><div><dt>{t.project}</dt><dd><code>{item.context.projectId ?? t.accountWide}</code></dd></div></dl></details>
      </div>
      <div className="queue-row-actions">{item.publicationId && <button type="button" className="button secondary" disabled={!onReview || pending} title={!onReview ? t.reviewUnavailable : undefined} onClick={() => onReview?.(item.kind, { ...item.context })}>{item.state === "awaiting-approval" ? t.review : t.publication}<ArrowUpRight size={13} aria-hidden="true" /></button>}
        {["scheduled", "awaiting-approval", "blocked"].includes(item.state) && <button type="button" className="text-button" disabled={disabled} onClick={() => open({ type: "skip", occurrence: item })}><SkipForward size={13} aria-hidden="true" />{t.skip}</button>}</div>
    </li>;
  }

  return <section className="queue-panel" aria-labelledby={`${id}-title`} lang={language}>
    <header className="page-heading queue-heading"><div><p className="eyebrow">{t.eyebrow}</p><h1 id={`${id}-title`} ref={title} tabIndex={-1}>{t.title}</h1><p>{t.description}</p></div><button ref={createButton} type="button" className="button primary" disabled={disabled || !context.projectId || !snapshot?.drafts.length} onClick={() => open({ type: "create" })}><Plus size={15} aria-hidden="true" />{t.create}</button></header>
    <div className="queue-runtime"><Clock3 size={17} aria-hidden="true" /><div><strong>{t.runningOnly}</strong><p>{t.runningHelp}</p></div></div>
    <div className="queue-scope"><span>{t.scope}</span><code>{context.accountId} / {context.projectId ?? t.accountWide}</code></div>
    {!context.projectId && <p className="queue-help queue-scope-help">{t.projectRequired}</p>}
    {snapshot && context.projectId && !snapshot.drafts.length && <p className="queue-help queue-scope-help">{t.noDrafts}</p>}
    {readError && <div className="error-banner queue-error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{t.readFailed}</span><button type="button" className="text-button" disabled={pending || refreshing} onClick={() => { void load(true); }}>{t.retry}</button></div>}
    {actionError && <p className="form-error" role="alert">{t[actionError]}</p>}
    <div className="queue-notice" role="status" aria-live="polite">{pending && !modal ? <><LoaderCircle size={15} className="spinning" aria-hidden="true" />{t.saving}</> : notice ? <><Check size={15} aria-hidden="true" />{t[notice]}</> : null}</div>
    {loading ? <div className="loading-state" role="status"><LoaderCircle className="spinning" aria-hidden="true" />{t.loading}</div> : snapshot && <>
      <section className="queue-section" aria-labelledby={`${id}-occurrences`}><div className="queue-section-heading"><h2 id={`${id}-occurrences`}>{t.occurrences}<span className="queue-count">{visible.length}</span></h2><button type="button" className="text-button" disabled={pending || refreshing} onClick={() => { void load(true); }}><RefreshCw size={14} className={refreshing ? "spinning" : ""} aria-hidden="true" />{refreshing ? t.refreshing : t.refresh}</button></div>
        <div className="queue-toolbar"><label><span className="queue-sr-only">{t.filter}</span><select value={filter} onChange={event => setFilter(event.target.value as "open" | "all")}><option value="open">{t.open}</option><option value="all">{t.all}</option></select></label><div className="queue-view" role="group" aria-label={t.display}><button type="button" aria-pressed={view === "agenda"} onClick={() => setView("agenda")}><CalendarDays size={14} aria-hidden="true" />{t.agenda}</button><button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={14} aria-hidden="true" />{t.list}</button></div></div>
        <p className="queue-help queue-dates-help">{t.datesHelp}</p>
        {visible.length ? view === "agenda" ? <div className="queue-agenda">{[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([day, items]) => <section className="queue-day" key={day}><h3>{dateLabel(day)}</h3><ol className="queue-occurrences">{items.map(occurrenceRow)}</ol></section>)}</div> : <ol className="queue-occurrences panel">{visible.map(occurrenceRow)}</ol>
          : <div className="panel queue-empty"><CalendarClock size={25} aria-hidden="true" /><h3>{snapshot.occurrences.length ? t.noMatches : t.emptyTitle}</h3><p>{snapshot.occurrences.length ? t.noMatchesHelp : t.emptyHelp}</p>{!snapshot.occurrences.length && !!snapshot.schedules.length && <p>{t.noOccurrences}</p>}</div>}
      </section>
      <section className="queue-section" aria-labelledby={`${id}-schedules`}><div className="queue-section-heading"><h2 id={`${id}-schedules`}>{t.schedules}<span className="queue-count">{snapshot.schedules.length}</span></h2></div><p className="queue-help queue-dates-help">{t.resumeHelp}</p>
        {snapshot.schedules.length ? <ul className="queue-schedules panel">{snapshot.schedules.map(schedule => <li key={schedule.id} className="queue-schedule"><div className="queue-schedule__body"><div className="queue-row-heading"><h3>{schedule.name}</h3><span className={`queue-state queue-state--${schedule.state}`}>{t[schedule.state]}</span></div><p className="queue-rule">{ruleSummary(schedule.rule)}</p><p className="queue-help">{t.start}: {schedule.rule.localStart.replace("T", " · ")} · <strong>{schedule.rule.timeZone}</strong></p><p className="queue-help">{t.nextDue}: {schedule.nextDueAt ? <time dateTime={schedule.nextDueAt}>{dateTime(schedule.nextDueAt, schedule.rule.timeZone)} · {schedule.rule.timeZone}</time> : t.noNextDue}</p><div className="queue-row-meta"><span>{t[schedule.kind]}</span><span>{t.destination}: <code>{schedule.destinationId}</code></span><span>{t.revision} {schedule.revision}</span></div></div>
          {schedule.missedThrough && <p className="queue-help">{language === "tr" ? "Çevrimdışı geçmiş tekrarlar bu ana kadar birleştirildi; yayın yapılmadı: " : "Offline backlog collapsed without publication through: "}{new Date(schedule.missedThrough).toLocaleString(locale)}</p>}
          <div className="queue-schedule__actions">{["active", "paused"].includes(schedule.state) && <><button type="button" className="button secondary" disabled={disabled} onClick={() => open({ type: "edit", schedule })}>{t.reschedule}</button>{schedule.state === "active" ? <button type="button" className="text-button" disabled={disabled} onClick={() => open({ type: "pause", schedule })}><Pause size={13} aria-hidden="true" />{t.pause}</button> : <button type="button" className="text-button" disabled={disabled} onClick={() => { void mutate(`/api/schedules/${encodeURIComponent(schedule.id)}/resume`, "POST", { context: { ...schedule.context }, expectedRevision: schedule.revision }, "changed", false); }}><Play size={13} aria-hidden="true" />{t.resume}</button>}<button type="button" className="text-button danger-text" disabled={disabled} onClick={() => open({ type: "cancel", schedule })}>{t.cancelSchedule}</button></>}</div>
        </li>)}</ul> : <div className="queue-empty panel"><p>{t.noSchedules}</p></div>}
      </section>
    </>}
    <Dialog.Root open={modal !== null} onOpenChange={value => { if (!value && !lock.current) setModal(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content queue-dialog" aria-describedby={`${id}-dialog-description`} onEscapeKeyDown={event => { if (lock.current) event.preventDefault(); }} onPointerDownOutside={event => { if (lock.current) event.preventDefault(); }} onOpenAutoFocus={event => { event.preventDefault(); (modal?.type === "create" ? nameInput.current : modal?.type === "edit" ? startInput.current : cancelButton.current)?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); const target = returnFocus.current?.isConnected ? returnFocus.current : createButton.current?.isConnected && !createButton.current.disabled ? createButton.current : title.current; target?.focus(); }}>
      <Dialog.Title>{modalTitle}</Dialog.Title><Dialog.Description id={`${id}-dialog-description`}>{modalDescription}</Dialog.Description><Dialog.Close className="icon-button dialog-close" aria-label={t.close} disabled={pending}><X size={18} /></Dialog.Close>
      {modal && <form onSubmit={submit}><fieldset disabled={pending} className="queue-form-fields">
        {modalForm ? <>
          {modal.type === "create" ? <><label className="form-field">{t.name}<input ref={nameInput} required maxLength={100} autoComplete="off" placeholder={t.namePlaceholder} value={form.name} onChange={event => setForm(previous => ({ ...previous, name: event.target.value }))} /></label><label className="form-field">{t.draft}<select required value={form.draftKey} onChange={event => setForm(previous => ({ ...previous, draftKey: event.target.value }))}><option value="">—</option>{snapshot?.drafts.map(draft => <option key={draftKey(draft)} value={draftKey(draft)}>{t[draft.kind]} · {draft.label} · {draft.destinationId}</option>)}</select></label>{selectedDraft && <p className="queue-form-scope">{t.destination}: <code>{selectedDraft.destinationId}</code></p>}<p className="queue-form-note">{t.consumeHelp}</p></> : modal.type === "edit" ? <div className="queue-form-scope"><strong>{modal.schedule.name}</strong><span>{t.destination}: <code>{modal.schedule.destinationId}</code></span><span>{t.project}: <code>{modal.schedule.context.projectId ?? t.accountWide}</code></span></div> : null}
          <label className="form-field">{t.frequency}<select value={form.rule.frequency} onChange={event => { const frequency = event.target.value as Rule["frequency"], local = localParts(form.rule.localStart); patchRule({ frequency, weekdays: frequency === "weekly" && !form.rule.weekdays.length ? [local ? new Date(local.epoch).getUTCDay() : 1] : form.rule.weekdays }); }}><option value="once">{t.once}</option><option value="daily">{t.daily}</option><option value="weekly">{t.weekly}</option></select></label>
          <div className="form-columns"><label className="form-field">{t.localStart}<input ref={startInput} type="datetime-local" required step={60} value={form.rule.localStart} onChange={event => patchRule({ localStart: event.target.value })} /></label><label className="form-field">{t.zone}<input type="text" list={`${id}-zones`} autoComplete="off" required maxLength={100} value={form.rule.timeZone} onChange={event => patchRule({ timeZone: event.target.value })} /></label></div><datalist id={`${id}-zones`}>{zones.map(zone => <option key={zone} value={zone} />)}</datalist>
          {form.rule.frequency === "weekly" && <fieldset className="queue-weekdays"><legend>{t.weekdays}</legend>{dayOrder.map(day => <label key={day}><input type="checkbox" checked={form.rule.weekdays.includes(day)} aria-label={t.weekdaysLong[day]} onChange={event => patchRule({ weekdays: event.target.checked ? [...form.rule.weekdays, day] : form.rule.weekdays.filter(value => value !== day) })} /><span>{t.weekdaysShort[day]}</span></label>)}</fieldset>}
          <label className="form-field">{t.missedPolicy}<select value={form.rule.missedPolicy} onChange={event => patchRule({ missedPolicy: event.target.value as Rule["missedPolicy"] })}><option value="ask">{t.ask}</option><option value="skip">{t.skipMissed}</option></select></label><p className="queue-form-note">{t.askHelp}</p><p className="queue-form-note">{t.expiryHelp}</p><p className="queue-form-note">{t.dstHelp}</p>{startInfo.gap && !startInfo.error && <p className="queue-form-warning" role="status">{t.gapHelp}</p>}
        </> : <div className="queue-form-scope"><strong>{modal.type === "skip" ? schedules.get(modal.occurrence.scheduleId)?.name ?? t.unknownSchedule : modal.schedule.name}</strong><span>{t.destination}: <code>{modal.type === "skip" ? modal.occurrence.destinationId : modal.schedule.destinationId}</code></span>{modal.type === "skip" && <span>{modal.occurrence.localTime.replace("T", " · ")} · {modal.occurrence.timeZone}</span>}</div>}
      </fieldset>{formError && <p role="alert" className="form-error">{t[formError]}</p>}<div className="dialog-actions"><button ref={cancelButton} type="button" className="button secondary" disabled={pending} onClick={() => setModal(null)}>{t.cancel}</button><button type="submit" className={`button ${modal.type === "cancel" ? "danger" : "primary"}`} disabled={pending || (modal.type === "create" && !snapshot?.drafts.length)}>{pending && <LoaderCircle size={14} className="spinning" aria-hidden="true" />}{pending ? t.saving : modal.type === "create" ? t.confirmCreate : modal.type === "edit" ? t.save : modal.type === "skip" ? t.confirmSkip : modal.type === "pause" ? t.pause : t.cancelSchedule}</button></div></form>}
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
