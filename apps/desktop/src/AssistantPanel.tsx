import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, CircleAlert, Copy, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { editSchema, type MediaEdit } from "../../../packages/domain/src/media.js";
import type { AiConnectionStatus, AiConnectionTest } from "../../../packages/domain/src/ai.js";
import type { WorkspaceAccount, WorkspaceContext } from "../../../packages/domain/src/workspace.js";
import type { StudioArtifact, StudioRender } from "./Studio";
import { mediaBlob, request } from "./api";
import { assistantError, assistantText, type AssistantTranslate } from "./assistant-i18n";
import { isTranscriptReady, TranscriptionPanel, type Transcript } from "./TranscriptionPanel";
import "./assistant.css";

export interface AssistantPanelProps {
  artifact: StudioArtifact; context: WorkspaceContext; account: WorkspaceAccount;
  language: "tr" | "en"; onApplied: () => void;
}
interface AiSetup { available: boolean; version: string | null; models: string[]; auth: "cli-managed"; error: string | null;
  catalog?: { state: "current" | "stale"; refreshedAt: string | null } }
interface AiRun {
  id: string; context: WorkspaceContext; artifactId: string; destinationId: string; sourceSha256: string;
  baseRevision: number; model: string; prompt: string; includeMemory: boolean; includeTranscript?: boolean;
  state: "running" | "ready" | "accepted" | "rejected" | "failed" | "cancelled";
  summary: string | null; edit: MediaEdit | null; error: string | null;
  events: { message: string; at: string }[]; createdAt: string; sessionId: string | null; previewRenderId: string | null;
  cancelRequested?: boolean;
}
interface Timeline { revision: number; cursor: number; edits: MediaEdit[] }
interface Snapshot { tools: { available: boolean }; renders: StudioRender[]; artifacts: StudioArtifact[] }
interface Grant { origin: string; token: string; expiresAt: string; tools: string[]; command: { command: string; args: string[] } }
type Operation = "generate" | "cancel" | "accept" | "reject" | "preview" | "grant" | "revoke" | "test" | "cancelTest";
const BLOB_LIMIT = 256 * 1024 * 1024;
const upsert = <T extends { id: string },>(items: T[], value: T) => [value, ...items.filter(item => item.id !== value.id)];
function sourceTime(value: number): string {
  const n = Math.round(value * 100);
  return `${Math.floor(n / 6000).toString().padStart(2, "0")}:${(Math.floor(n / 100) % 60).toString().padStart(2, "0")}.${(n % 100).toString().padStart(2, "0")}`;
}
const ranges = (edit: MediaEdit) => edit.segments ?? [{ inSeconds: edit.inSeconds, outSeconds: edit.outSeconds }];
const kept = (edit: MediaEdit) => ranges(edit).reduce((sum, range) => sum + range.outSeconds - range.inSeconds, 0);
function validEdit(edit: MediaEdit | null, duration: number): edit is MediaEdit {
  const result = editSchema.safeParse(edit);
  return result.success && duration > 0 && result.data.outSeconds <= duration;
}
function eventKey(message: string): "started" | "activity" | null {
  // Only bounded status messages from the bridge, never free-form model/tool logs.
  if (message === "started" || message === "Starting proposal") return "started";
  if (message === "activity" || message === "Preparing proposal") return "activity";
  return null;
}

export function AssistantPanel(props: AssistantPanelProps) {
  const { context, artifact, account } = props;
  return <AssistantWorkspace key={`${context.accountId}:${context.projectId ?? ""}:${account.id}:${account.destinationId}:${artifact.id}:${artifact.sha256}`} {...props} />;
}

function AssistantWorkspace({ artifact, context, account, language, onApplied }: AssistantPanelProps) {
  const t = assistantText(language);
  const id = useId();
  const [setup, setSetup] = useState<AiSetup | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [runs, setRuns] = useState<AiRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [model, setModel] = useState("");
  const [connection, setConnection] = useState<AiConnectionStatus | null>(null);
  const [connectionPollError, setConnectionPollError] = useState<unknown>(null);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [includeMemory, setIncludeMemory] = useState(false);
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(true);
  const [comparing, setComparing] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [pollError, setPollError] = useState<unknown>(null);
  const [timelineError, setTimelineError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<{ operation: Operation; error: unknown } | null>(null);
  const [conflictId, setConflictId] = useState<string | null>(null);
  const [pollEpoch, setPollEpoch] = useState(0);
  const [compareEpoch, setCompareEpoch] = useState(0);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [grantMemory, setGrantMemory] = useState(false);
  const [grantTranscript, setGrantTranscript] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [grantExpired, setGrantExpired] = useState(false);
  const [copyNotice, setCopyNotice] = useState<"copied" | "clipboardFailed" | "revoked" | null>(null);
  const lifetime = useRef(new AbortController());
  const operationRef = useRef<Operation | null>(null);
  const loadingRef = useRef(false);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const scopeQuery = new URLSearchParams({ accountId: context.accountId, projectId: context.projectId ?? "" }).toString();
  const runsPath = `/api/ai/runs?${scopeQuery}&artifactId=${encodeURIComponent(artifact.id)}`;
  const timelinePath = `/api/media/${encodeURIComponent(artifact.id)}/timeline?${scopeQuery}`;
  const studioPath = `/api/studio?${scopeQuery}`;
  const connectionPath = `/api/ai/connection?${scopeQuery}`;
  const connectionRunning = connection?.lastTest?.state === "running";
  const selectedAuthentication = connection?.lastTest?.model === model && setup?.available && setup.models.includes(model) ? connection.authentication : "unverified";
  const inScope = useCallback((run: AiRun) => run.artifactId === artifact.id && run.context.accountId === context.accountId && run.context.projectId === context.projectId && run.destinationId === account.destinationId,
    [artifact.id, context.accountId, context.projectId, account.destinationId]);
  const selected = runs.find(run => run.id === selectedId) ?? null;
  const duration = artifact.probe?.duration ?? 0;
  const matchingScope = !!context.projectId && context.accountId === account.id && artifact.accountId === context.accountId && artifact.projectId === context.projectId;
  const available = matchingScope && !!setup?.available && !!snapshot?.tools.available && duration > 0;
  const isRunning = runs.some(run => run.state === "running");
  const previewPending = runs.some(run => run.previewRenderId && (!snapshot?.renders.some(render => render.id === run.previewRenderId) || snapshot.renders.some(render => render.id === run.previewRenderId && render.state === "running")));
  const proposalValid = !!selected && validEdit(selected.edit, duration);
  const stale = !!selected && (selected.sourceSha256 !== artifact.sha256 || selected.id === conflictId || !!timeline && timeline.revision !== selected.baseRevision);
  const currentEdit: MediaEdit = timeline?.edits[timeline.cursor] ?? { inSeconds: 0, outSeconds: duration, crop: "original", gainDb: 0, caption: "" };
  const transcriptReady = isTranscriptReady(transcript, artifact, context);

  useEffect(() => { if (!transcriptReady) setIncludeTranscript(false); }, [transcriptReady]);

  const load = useCallback(async (refresh = false) => {
    if (loadingRef.current || operationRef.current) return;
    loadingRef.current = true; setLoading(true); setLoadError(null);
    const signal = lifetime.current.signal;
    const results = await Promise.allSettled([
      request<AiSetup>(`/api/ai/setup${refresh ? "?refresh=1" : ""}`, "GET", undefined, signal),
      request<AiRun[]>(runsPath, "GET", undefined, signal),
      request<Snapshot>(studioPath, "GET", undefined, signal),
      request<AiConnectionStatus>(connectionPath, "GET", undefined, signal),
    ]);
    if (signal.aborted) return;
    const [discovery, history, studio, health] = results;
    if (discovery.status === "fulfilled") {
      setSetup(discovery.value);
      // Keep a disappeared selection visible and invalid; never select a fallback.
      setModel(current => current || (health.status === "fulfilled" ? health.value.preference?.model ?? "" : ""));
    } else setSetup(previous => previous ? { ...previous, available: false, error: "ai_catalog_refresh_failed",
      catalog: { state: "stale", refreshedAt: previous.catalog?.refreshedAt ?? null } } : null);
    if (history.status === "fulfilled") {
      const visible = history.value.filter(inScope).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setRuns(visible); setSelectedId(current => current && visible.some(run => run.id === current) ? current : visible[0]?.id ?? null);
      setPollError(null);
    }
    if (studio.status === "fulfilled") setSnapshot(studio.value); else setSnapshot(null);
    if (health.status === "fulfilled") { setConnection(health.value); setConnectionPollError(null); }
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") setLoadError(failure.reason);
    loadingRef.current = false; setLoading(false); setCompareEpoch(value => value + 1);
  }, [runsPath, studioPath, connectionPath, inScope]);

  useEffect(() => {
    if (!connectionRunning || operation) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void request<AiConnectionStatus>(connectionPath, "GET", undefined, abort.signal).then(value => {
        if (!abort.signal.aborted) { setConnection(value); setConnectionPollError(null); }
      }).catch(error => { if (!abort.signal.aborted) setConnectionPollError(error); })
        .finally(() => { if (!abort.signal.aborted) setConnectionEpoch(value => value + 1); });
    }, 1000);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [connectionRunning, connectionPath, operation, connectionEpoch]);

  useEffect(() => {
    lifetime.current = new AbortController(); loadingRef.current = false;
    void load();
    return () => lifetime.current.abort();
  }, [load]);

  // Reading the current timeline is independent of the proposal snapshot.
  useEffect(() => {
    const abort = new AbortController(); setComparing(true); setTimeline(null); setTimelineError(null);
    void request<Timeline>(timelinePath, "GET", undefined, abort.signal).then(value => {
      if (!abort.signal.aborted) setTimeline(value);
    }).catch(error => { if (!abort.signal.aborted) setTimelineError(error); })
      .finally(() => { if (!abort.signal.aborted) setComparing(false); });
    return () => abort.abort();
  }, [timelinePath, selected?.id, selected?.state, compareEpoch]);

  useEffect(() => {
    if ((!isRunning && !previewPending) || operation || loading) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void Promise.all([
        request<AiRun[]>(runsPath, "GET", undefined, abort.signal),
        request<Snapshot>(studioPath, "GET", undefined, abort.signal),
      ]).then(([history, studio]) => {
        if (abort.signal.aborted || operationRef.current) return;
        setRuns(history.filter(inScope).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); setSnapshot(studio); setPollError(null);
      }).catch(error => { if (!abort.signal.aborted) setPollError(error); })
        .finally(() => { if (!abort.signal.aborted) setPollEpoch(value => value + 1); });
    }, 2000);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [isRunning, previewPending, operation, loading, runsPath, studioPath, inScope, pollEpoch]);

  useEffect(() => {
    setGrantExpired(false);
    if (!grant) return;
    const expires = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) { setGrantExpired(true); setReveal(false); return; }
    const timer = setTimeout(() => { setGrantExpired(true); setReveal(false); }, Math.min(2147483647, expires - Date.now()));
    return () => clearTimeout(timer);
  }, [grant]);

  async function act(name: Operation, work: (signal: AbortSignal) => Promise<void>) {
    if (operationRef.current || loadingRef.current || lifetime.current.signal.aborted) return;
    operationRef.current = name; setOperation(name); setActionError(null);
    const signal = lifetime.current.signal;
    try { await work(signal); }
    catch (error) {
      if (!signal.aborted) {
        setActionError({ operation: name, error });
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (/revision|conflict|stale|source_changed|hash_mismatch/u.test(code) && selected) { setConflictId(selected.id); setCompareEpoch(value => value + 1); }
      }
    } finally { if (!signal.aborted) { operationRef.current = null; setOperation(null); } }
  }
  function updateRun(run: AiRun) {
    if (!inScope(run)) throw { code: "ai_scope_mismatch" };
    setRuns(current => upsert(current, run).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); setSelectedId(run.id);
  }
  function generate(event: FormEvent) {
    event.preventDefault();
    if (!available || loading || isRunning || connectionRunning || !timeline || comparing || !setup?.models.includes(model) || !prompt.trim() || prompt.length > 4000 || includeTranscript && !transcriptReady) return;
    void act("generate", async signal => {
      const run = await request<AiRun>("/api/ai/runs", "POST", { context, destinationId: account.destinationId, artifactId: artifact.id, model, prompt: prompt.trim(), includeMemory, includeTranscript, allowRemote: true }, signal);
      if (!signal.aborted) updateRun(run);
    });
  }
  function testConnection() {
    if (!setup?.available || !setup.models.includes(model) || connectionRunning) return;
    void act("test", async signal => {
      const test = await request<AiConnectionTest>("/api/ai/connection/tests", "POST", { context, model, allowRemote: true }, signal);
      if (!signal.aborted) {
        setConnection(current => current ? { ...current, lastTest: test } : current);
        const status = await request<AiConnectionStatus>(connectionPath, "GET", undefined, signal);
        if (!signal.aborted) setConnection(status);
      }
    });
  }
  function cancelTest() {
    if (!connection?.lastTest || !connectionRunning) return;
    void act("cancelTest", async signal => {
      const value = await request<AiConnectionStatus>(`/api/ai/connection/tests/${encodeURIComponent(connection.lastTest!.id)}/cancel`, "POST", { context }, signal);
      if (!signal.aborted) setConnection(value);
    });
  }
  function runAction(name: "cancel" | "accept" | "reject" | "preview") {
    if (!selected || (name === "accept" && (!proposalValid || stale || !timeline || comparing))) return;
    void act(name, async signal => {
      const result = await request<AiRun | { run: AiRun; render: StudioRender }>(`/api/ai/runs/${encodeURIComponent(selected.id)}/${name}`, "POST", { context }, signal);
      if (signal.aborted) return;
      if ("run" in result) { updateRun(result.run); setSnapshot(current => current ? { ...current, renders: upsert(current.renders, result.render) } : current); }
      else { updateRun(result); if (name === "accept" && result.state === "accepted") onApplied(); }
    });
  }
  function editRequest(run: AiRun) {
    setPrompt(run.prompt); setModel(run.model); setIncludeMemory(run.includeMemory);
    setIncludeTranscript(false);
    setActionError(null); promptInput.current?.focus();
  }
  function createGrant() {
    if (!available || includeTranscript && !transcriptReady) return;
    void act("grant", async signal => {
      const result = await request<Grant>("/api/ai/grants", "POST", { context, destinationId: account.destinationId, artifactId: artifact.id, includeMemory, includeTranscript }, signal);
      if (!signal.aborted) { setGrant(result); setGrantMemory(includeMemory); setGrantTranscript(includeTranscript); setReveal(false); setCopyNotice(null); }
    });
  }
  function revokeGrant() {
    if (!grant) return;
    void act("revoke", async signal => {
      await request("/api/ai/grants/revoke", "POST", { context, token: grant.token }, signal);
      if (!signal.aborted) { setGrant(null); setReveal(false); setCopyNotice("revoked"); }
    });
  }
  function grantConfig(mask: boolean) {
    if (!grant) return "";
    return JSON.stringify({ mcpServers: { atrisShare: { command: grant.command.command, args: grant.command.args,
      env: { ATRIS_SHARE_MCP_ORIGIN: grant.origin, ATRIS_SHARE_MCP_GRANT: mask ? "••••••••" : grant.token } } } }, null, 2);
  }
  async function copyConfig() {
    if (!grant || grantExpired) return;
    const signal = lifetime.current.signal;
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(grantConfig(false));
      if (!signal.aborted) setCopyNotice("copied");
    } catch { if (!signal.aborted) setCopyNotice("clipboardFailed"); }
  }
  const disabled = !!operation || loading;
  const render = snapshot?.renders.find(item => item.id === selected?.previewRenderId);
  const previewArtifact = snapshot?.artifacts.find(item => item.id === render?.artifactId);
  const latestEvents = selected?.events.map(event => ({ ...event, key: eventKey(event.message) })).filter(event => event.key !== null).slice(-4) ?? [];

  return <section className="studio-inspector-form assistant-panel" aria-label={t("title")}>
    <header className="assistant-heading"><h2><Sparkles size={15} />{t("title")}</h2><p>{t("intro")}</p></header>
    <div className="assistant-setup"><div><strong>{t("setup")}</strong><span>{!setup ? t(loading ? "checking" : "unavailable") : t(setup.available ? "available" : "unavailable")}{setup?.version && ` · ${setup.version}`}</span></div>
      <button className="icon-button" type="button" disabled={disabled} aria-label={t("refresh")} title={t("refresh")} onClick={() => { void load(true); }}><RefreshCw size={14} className={loading ? "spinning" : ""} /></button></div>
    {setup?.catalog && <p className="studio-help" role="status">{t(setup.catalog.state === "stale" ? "catalogStale" : "catalogCurrent")}
      {setup.catalog.refreshedAt && <> · {t("catalogUpdated")} <time dateTime={setup.catalog.refreshedAt}>{new Date(setup.catalog.refreshedAt).toLocaleString(language)}</time></>}</p>}
    {!loading && !setup?.available && <p className="studio-help">{t("cliHelp")}</p>}
    {setup?.error && <p className="studio-inline-error">{assistantError(setup.error, t)}</p>}
    {setup?.available && !setup.models.length && <p className="studio-help">{t("noModels")}</p>}
    {!loading && snapshot && !snapshot.tools.available && <p className="studio-callout">{t("toolsRequired")}</p>}
    {!duration && <p className="studio-callout">{t("probeRequired")}</p>}
    {!matchingScope && <p className="studio-inline-error" role="alert">{t("errorScope")}</p>}
    {!!loadError && <ErrorMessage error={loadError} t={t} retry={() => { void load(); }} disabled={disabled} />}
    <TranscriptionPanel artifact={artifact} context={context} language={language} onChanged={setTranscript} />
    <form onSubmit={generate} className="assistant-composer">
      <label className="form-field" htmlFor={`${id}-model`}>{t("model")}<select id={`${id}-model`} value={model} disabled={disabled || connectionRunning || !setup?.available} onChange={event => setModel(event.target.value)} required>
        <option value="" disabled>{t("chooseModel")}</option>{model && !setup?.models.includes(model) && <option value={model} disabled>{model} — {t("modelMissing")}</option>}{setup?.models.map(value => <option value={value} key={value}>{value}</option>)}</select></label>
      {model && !setup?.models.includes(model) && <p className="studio-inline-error" role="alert">{t("selectionMissing")}</p>}
      <section className="assistant-connection" aria-label={t("connectionTitle")}>
        <h3>{t("connectionTitle")}</h3>
        <p className="studio-help">{t("catalogNotAuth")}</p>
        <p className="assistant-connection-status" role="status">{t(selectedAuthentication === "required" ? "authRequired" : selectedAuthentication === "verified-by-inference" ? "authVerified" : "authUnverified")}</p>
        <p className="assistant-disclosure" id={`${id}-test-disclosure`}>{t("testDisclosure")}</p>
        <div className="assistant-connection-actions">
          <button className="button secondary" type="button" aria-describedby={`${id}-test-disclosure`} disabled={disabled || connectionRunning || !connection?.profileId || !setup?.available || !setup.models.includes(model)} onClick={testConnection}>
            {connectionRunning && <LoaderCircle size={13} className="spinning" />}{t(connectionRunning ? "testRunning" : connection?.lastTest ? "testAgain" : "testConnection")}</button>
          {connectionRunning && <button className="text-button" type="button" disabled={disabled} onClick={cancelTest}>{t(operation === "cancelTest" ? "cancelling" : "cancelTest")}</button>}
        </div>
        {connection?.lastTest && <div className="assistant-test-result" role="status">
          <strong>{t(connection.lastTest.state === "succeeded" ? "testSucceeded" : connection.lastTest.state === "failed" ? "testFailed" : connection.lastTest.state === "cancelled" ? "testCancelled" : "testRunning")}</strong>
          <code>{connection.lastTest.model}</code>
          {connection.lastTest.error && <p className="studio-inline-error">{assistantError(connection.lastTest.error, t)}</p>}
          {connection.lastTest.diagnostic && <details className="assistant-details"><summary>{t("safeDiagnostic")}</summary><dl className="assistant-binding">
            <div><dt>{t("stage")}</dt><dd>{connection.lastTest.diagnostic.stage}</dd></div><div><dt>{t("category")}</dt><dd>{connection.lastTest.diagnostic.category}</dd></div>
            <div><dt>{t("elapsed")}</dt><dd>{connection.lastTest.diagnostic.durationMs} ms</dd></div><div><dt>{t("exitCode")}</dt><dd>{connection.lastTest.diagnostic.exitCode ?? "—"}</dd></div>
            <div><dt>{t("setup")}</dt><dd>{connection.lastTest.diagnostic.version ?? "—"}</dd></div><div><dt>{t("requestId")}</dt><dd><code>{connection.lastTest.diagnostic.requestId}</code></dd></div>
          </dl></details>}
        </div>}
        {connection?.preference && <p className="studio-help">{t("lastSuccess")} <time dateTime={connection.preference.succeededAt}>{new Date(connection.preference.succeededAt).toLocaleString(language)}</time><br /><code>{connection.preference.model}</code></p>}
        {(connection?.preferenceError || connection?.persistence === "session") && <p className="studio-callout">{t(connection.preferenceError ? "preferenceFailed" : "preferenceSession")}</p>}
        {!!connectionPollError && <ErrorMessage error={connectionPollError} t={t} disabled={disabled} retry={() => { setConnectionEpoch(value => value + 1); void load(); }} />}
        <details className="assistant-details"><summary>{t("connectionSupport")}</summary><p className="studio-help">{t("connectionSupportHelp")}</p></details>
      </section>
      <label className="form-field" htmlFor={`${id}-prompt`}>{t("request")}<textarea ref={promptInput} id={`${id}-prompt`} rows={4} maxLength={4000} required value={prompt} disabled={!!operation} aria-describedby={`${id}-disclosure`} onChange={event => setPrompt(event.target.value)} /></label>
      <span className="assistant-counter">{prompt.length.toLocaleString(language)} / {(4000).toLocaleString(language)}</span>
      <label className="studio-checkbox"><input type="checkbox" checked={includeMemory} disabled={!!operation} aria-describedby={`${id}-memory-help`} onChange={event => setIncludeMemory(event.target.checked)} />{t("memory")}</label>
      <p className="studio-help" id={`${id}-memory-help`}>{t("memoryHelp")}</p>
      <label className="studio-checkbox"><input type="checkbox" checked={includeTranscript && transcriptReady} disabled={!!operation || !transcriptReady} aria-describedby={`${id}-transcript-help`} onChange={event => setIncludeTranscript(event.target.checked)} />{t("includeTranscript")}</label>
      <p className="studio-help" id={`${id}-transcript-help`}>{t("includeTranscriptHelp")}</p>
      <p className="assistant-disclosure" id={`${id}-disclosure`}>{t("disclosure")}</p>
      {includeTranscript && transcriptReady && <p className="assistant-disclosure">{t("transcriptDisclosure")}</p>}
      <button className="button primary studio-full-width" type="submit" disabled={disabled || connectionRunning || !available || isRunning || !timeline || comparing || !setup?.models.includes(model) || !prompt.trim() || includeTranscript && !transcriptReady}>
        {operation === "generate" ? <LoaderCircle size={14} className="spinning" /> : <Sparkles size={14} />}{t(operation === "generate" ? "generating" : actionError?.operation === "generate" ? "retryGenerate" : "generate")}</button>
    </form>
    {!!actionError && actionError.operation !== "grant" && actionError.operation !== "revoke" && <div className="studio-inline-error" role="alert">{assistantError(actionError.error, t)}</div>}
    {!!timelineError && <ErrorMessage error={timelineError} t={t} disabled={disabled} retry={() => setCompareEpoch(value => value + 1)} />}
    {!!pollError && <ErrorMessage error={pollError} t={t} disabled={disabled} retry={() => { void load(); }} />}
    {selected && <article className="assistant-run" aria-label={t("submittedRequest")}>
      <div className="assistant-run-heading"><span className={`studio-state state-${selected.state}`}>{selected.state === "running" && <LoaderCircle size={12} className="spinning" />}{t(selected.state === "running" && selected.cancelRequested ? "cancelling" : selected.state)}</span>
        {selected.state === "running" && <button type="button" className="text-button" disabled={disabled || selected.cancelRequested} onClick={() => runAction("cancel")}>{t("cancel")}</button>}</div>
      <p className="assistant-model"><span>{t("modelUsed")}</span> <code>{selected.model}</code></p>
      <details className="assistant-details"><summary>{t("submittedRequest")}</summary><p className="assistant-plaintext">{selected.prompt}</p><p className="studio-help">{t(selected.includeMemory ? "memoryIncluded" : "memoryExcluded")}<br />{t(selected.includeTranscript ? "transcriptIncluded" : "transcriptExcluded")}</p></details>
      {!!latestEvents.length && <ol className="assistant-events" aria-live="polite">{latestEvents.map((event, index) => <li key={`${event.at}-${index}`}><span>{t(event.key!)}</span><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })}</time></li>)}</ol>}
      {selected.error && <p className="studio-inline-error" role="alert">{assistantError(selected.error, t)}</p>}
      {(selected.edit || selected.state === "ready") && <>
        <h3>{t(proposalValid ? "proposal" : "summary")}</h3><p className="assistant-plaintext assistant-summary">{selected.summary || t("noSummary")}</p>
        <dl className="assistant-binding"><div><dt>{t("sourceHash")}</dt><dd><code title={selected.sourceSha256}>{selected.sourceSha256.slice(0, 12)}</code></dd></div><div><dt>{t("baseRevision")}</dt><dd>{selected.baseRevision}</dd></div><div><dt>{t("currentRevision")}</dt><dd>{comparing ? "…" : timeline?.revision ?? "—"}</dd></div></dl>
        {!proposalValid || !selected.edit ? <p className="studio-inline-error" role="alert">{t("invalidProposal")}</p> : <>
          <div className="assistant-comparison-heading"><h3>{t("comparison")}</h3><button type="button" className="icon-button" disabled={disabled || comparing} aria-label={t("reloadTimeline")} title={t("reloadTimeline")} onClick={() => setCompareEpoch(value => value + 1)}><RefreshCw size={13} className={comparing ? "spinning" : ""} /></button></div>
          {comparing ? <p className="studio-help" role="status">{t("loading")}</p> : timeline ? <EditComparison current={currentEdit} proposed={selected.edit} t={t} language={language} /> : null}
          {stale && selected.state === "ready" && <p className="studio-callout" role="alert">{t("stale")}</p>}
          <p className="studio-help">{t("immutable")}</p>
          {selected.state === "ready" && <button className="button secondary studio-full-width" type="button" disabled={disabled || !matchingScope || !snapshot?.tools.available || !proposalValid || stale || !!render && render.state === "running"} onClick={() => runAction("preview")}>{operation === "preview" && <LoaderCircle size={13} className="spinning" />}{t("preview")}</button>}
        </>}
        {selected.previewRenderId && <section className="assistant-preview" aria-label={t("previewTitle")}><h3>{t("previewTitle")}</h3>
          {!render ? <p className="studio-help" role="status">{t("previewLookup")}</p> : <>
            <p className="assistant-preview-status" role="status">{t(render.state === "running" ? "previewRunning" : render.state === "succeeded" ? "previewReady" : render.state === "failed" ? "previewFailed" : "previewCancelled")}</p>
            {render.state === "running" && <div className="studio-progress"><progress max={1} {...(Number.isFinite(render.progress) ? { value: Math.min(1, Math.max(0, render.progress)) } : {})} aria-label={t("previewRunning")} />{Number.isFinite(render.progress) && <span>{Math.round(Math.min(1, Math.max(0, render.progress)) * 100)}%</span>}</div>}
            {render.error && <p className="studio-inline-error">{assistantError(render.error, t)}</p>}
            {render.state === "succeeded" && render.artifactId && <ProposalPlayer key={`${selected.id}:${render.artifactId}`} artifactId={render.artifactId} scopeQuery={scopeQuery} limited={!!previewArtifact && previewArtifact.bytes > BLOB_LIMIT} t={t} />}
          </>}<p className="studio-help">{t("previewHelp")}</p></section>}
        {selected.state === "ready" && <><p className="studio-help">{t("applyHelp")}</p><div className="assistant-review-actions"><button type="button" className="button primary" disabled={disabled || !matchingScope || !proposalValid || stale || comparing || !timeline} onClick={() => runAction("accept")}>{operation === "accept" ? <LoaderCircle size={13} className="spinning" /> : <Check size={13} />}{t(operation === "accept" ? "accepting" : "accept")}</button><button className="text-button" type="button" disabled={disabled} onClick={() => runAction("reject")}>{t("reject")}</button></div></>}
      </>}
      {selected.state !== "running" && <button className="text-button assistant-edit-retry" type="button" disabled={disabled} onClick={() => editRequest(selected)}>{t("editRetry")}</button>}
    </article>}
    <details className="assistant-details assistant-history"><summary>{t("history")} · {Math.min(5, runs.length)}</summary>
      {!runs.length ? <p className="studio-help">{t(loading ? "loading" : "noHistory")}</p> : <ul>{runs.slice(0, 5).map(run => <li key={run.id}><button type="button" aria-pressed={selectedId === run.id} onClick={() => { setSelectedId(run.id); setActionError(null); }} disabled={!!operation}><span>{run.prompt}</span><small>{t(run.state)} · {new Date(run.createdAt).toLocaleString(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}<br />{t(run.includeTranscript ? "transcriptIncluded" : "transcriptExcluded")}</small></button></li>)}</ul>}
    </details>
    <details className="assistant-details assistant-mcp"><summary>{t("mcp")}</summary><p className="studio-help">{t("mcpHelp")}</p>
      {!!actionError && (actionError.operation === "grant" || actionError.operation === "revoke") && <p className="studio-inline-error" role="alert">{assistantError(actionError.error, t)}</p>}
      {!grant ? <button className="button secondary studio-full-width" type="button" disabled={disabled || !available || includeTranscript && !transcriptReady} onClick={createGrant}>{t(operation === "grant" ? "creatingGrant" : "createGrant")}</button> : <>
        <p className="studio-help">{t("grantExpires")}: <time dateTime={grant.expiresAt}>{new Date(grant.expiresAt).toLocaleString(language)}</time><br />{t(grantMemory ? "memoryIncluded" : "memoryExcluded")}<br />{t(grantTranscript ? "transcriptReadGranted" : "transcriptReadExcluded")}</p>
        <details className="assistant-details"><summary>{t("tools")}</summary><ul className="assistant-tools">{grant.tools.map(tool => <li key={tool}><code>{tool}</code></li>)}</ul></details>
        {grantExpired && <p className="studio-callout" role="status">{t("expired")}</p>}
        <p className="studio-help">{t("secretHelp")}</p><pre className="assistant-config" aria-label={t("mcp")} tabIndex={0}>{grantConfig(!reveal || grantExpired)}</pre>
        <div className="assistant-grant-actions"><button className="text-button" type="button" disabled={grantExpired || disabled} onClick={() => setReveal(value => !value)}>{t(reveal ? "hideConfig" : "showConfig")}</button><button className="button secondary" type="button" disabled={grantExpired || disabled} onClick={() => { void copyConfig(); }}><Copy size={13} />{t("copyConfig")}</button><button className="text-button" type="button" disabled={disabled} onClick={revokeGrant}>{t("revoke")}</button></div>
      </>}{copyNotice && <p className="studio-help" role="status">{t(copyNotice)}</p>}
    </details>
  </section>;
}

function ErrorMessage({ error, t, retry, disabled }: { error: unknown; t: AssistantTranslate; retry: () => void; disabled: boolean }) {
  return <div className="assistant-error" role="alert"><CircleAlert size={14} /><div><p>{assistantError(error, t)}</p><button className="text-button" type="button" disabled={disabled} onClick={retry}>{t("retry")}</button></div></div>;
}

function EditComparison({ current, proposed, t, language }: { current: MediaEdit; proposed: MediaEdit; t: AssistantTranslate; language: "tr" | "en" }) {
  const number = (value: number) => new Intl.NumberFormat(language, { maximumFractionDigits: 3 }).format(value);
  const rows = [
    { key: "inSeconds", before: sourceTime(current.inSeconds), after: sourceTime(proposed.inSeconds), changed: current.inSeconds !== proposed.inSeconds },
    { key: "outSeconds", before: sourceTime(current.outSeconds), after: sourceTime(proposed.outSeconds), changed: current.outSeconds !== proposed.outSeconds },
    { key: "crop", before: t(current.crop), after: t(proposed.crop), changed: current.crop !== proposed.crop },
    { key: "gain", before: `${number(current.gainDb)} dB`, after: `${number(proposed.gainDb)} dB`, changed: current.gainDb !== proposed.gainDb },
    { key: "caption", before: current.caption || t("emptyCaption"), after: proposed.caption || t("emptyCaption"), changed: current.caption !== proposed.caption },
    { key: "kept", before: number(kept(current)), after: number(kept(proposed)), changed: kept(current) !== kept(proposed) },
    { key: "framing", before: `${number((current.cropX ?? .5) * 100)}%`, after: `${number((proposed.cropX ?? .5) * 100)}%`, changed: (current.cropX ?? .5) !== (proposed.cropX ?? .5) },
  ] as const;
  return <div className="assistant-diff"><div className="assistant-diff-labels"><span>{t("current")}</span><span>{t("proposed")}</span></div>
    {rows.map(row => <div className={`assistant-diff-row ${row.changed ? "is-changed" : ""}`} key={row.key}><strong>{t(row.key)} <span>{t(row.changed ? "changed" : "unchanged")}</span></strong><div><p>{row.before}</p><p>{row.after}</p></div></div>)}
    <div className={`assistant-diff-row ${JSON.stringify(ranges(current)) !== JSON.stringify(ranges(proposed)) ? "is-changed" : ""}`}><strong>{t("segments")}</strong><div>{[current, proposed].map((edit, index) => <ol key={index} aria-label={`${t(index === 0 ? "current" : "proposed")} · ${t("segments")}`}>{ranges(edit).map((range, i) => <li key={i}><span>{sourceTime(range.inSeconds)} → {sourceTime(range.outSeconds)}</span></li>)}</ol>)}</div></div>
    {!!(current.timedCaptions?.length || proposed.timedCaptions?.length) && <div className={`assistant-diff-row ${JSON.stringify(current.timedCaptions ?? []) !== JSON.stringify(proposed.timedCaptions ?? []) ? "is-changed" : ""}`}><strong>{t("timedCaptions")}</strong><div>{[current, proposed].map((edit, index) => <ol key={index} aria-label={`${t(index === 0 ? "current" : "proposed")} · ${t("timedCaptions")}`}>{edit.timedCaptions?.map((cue, i) => <li key={i}><span>{sourceTime(cue.start)} → {sourceTime(cue.end)}</span><p>{cue.text}</p></li>)}</ol>)}</div></div>}
  </div>;
}

function ProposalPlayer({ artifactId, scopeQuery, limited, t }: { artifactId: string; scopeQuery: string; limited: boolean; t: AssistantTranslate }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [playError, setPlayError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); let objectUrl: string | null = null;
    setUrl(null); setError(null); setPlayError(false);
    if (!limited) void mediaBlob(`/api/media/${encodeURIComponent(artifactId)}/content?${scopeQuery}`, abort.signal).then(blob => {
      if (abort.signal.aborted) return;
      if (blob.size > BLOB_LIMIT) throw { code: "assistant_blob_limit" };
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(failure => { if (!abort.signal.aborted) setError(failure); });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifactId, scopeQuery, limited, retry]);
  if (limited || error && typeof error === "object" && "code" in error && error.code === "assistant_blob_limit") return <p className="studio-help">{t("previewLimit")}</p>;
  return <div className="assistant-player">{url && <video src={url} controls preload="metadata" aria-label={t("previewTitle")} onError={() => setPlayError(true)} />}
    {error ? <ErrorMessage error={error} t={t} disabled={false} retry={() => setRetry(value => value + 1)} /> : playError ? <div className="studio-inline-error" role="alert"><p>{t("previewPlayback")}</p><button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}>{t("retry")}</button></div> : !url && <p className="studio-help" role="status">{t("previewLoading")}</p>}
  </div>;
}
