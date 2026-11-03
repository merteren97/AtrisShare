import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Clapperboard, LoaderCircle, RefreshCw, Scissors } from "lucide-react";
import type { ClipAnalysis, ClipCandidate } from "../../../packages/domain/src/clips.js";
import { editSchema, type MediaEdit } from "../../../packages/domain/src/media.js";
import type { StudioProps, StudioArtifact } from "./Studio";
import { isTranscriptReady, TranscriptionPanel, type Transcript } from "./TranscriptionPanel";
import { mediaBlob, request } from "./api";
import { clipError, clipText, type ClipText } from "./clips-i18n";
import { assistantError, assistantText } from "./assistant-i18n";
import "./clips.css";

type Props = Pick<StudioProps, "context" | "account" | "language"> & { artifact: StudioArtifact; onSeek: (seconds: number) => void; onChanged: () => void };
type Setup = { available: boolean; models: string[]; version?: string | null; error?: string | null;
  catalog?: { state: "current" | "stale"; refreshedAt: string | null } };
const time = (value: number) => `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toFixed(2).padStart(5, "0")}`;
export function ClipPanel(props: Props) {
  return <ClipSession key={`${props.context.accountId}:${props.context.projectId}:${props.artifact.id}:${props.artifact.sha256}`} {...props} />;
}
function ClipSession({ artifact, context, account, language, onSeek, onChanged }: Props) {
  const t = clipText(language), query = new URLSearchParams({ accountId: context.accountId, projectId: context.projectId ?? "", artifactId: artifact.id }).toString();
  const [runs, setRuns] = useState<ClipAnalysis[]>([]), [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [mode, setMode] = useState("local"), [model, setModel] = useState(""), [setup, setSetup] = useState<Setup | null>(null);
  const [consent, setConsent] = useState(false), [history, setHistory] = useState(false);
  const [minimum, setMinimum] = useState("15"), [target, setTarget] = useState("30"), [maximum, setMaximum] = useState("45"), [count, setCount] = useState("4");
  const [selected, setSelected] = useState<string[]>([]), [dirty, setDirty] = useState<Set<string>>(new Set());
  const [epoch, setEpoch] = useState(0);
  const lifetime = useRef(new AbortController()), operation = useRef(false), poll = useRef<AbortController | null>(null);
  const changed = useRef(onChanged); changed.current = onChanged;
  const run = runs.find(r => r.id === activeId) ?? runs[0] ?? null;
  const running = runs.some(r => r.state === "running");
  const ready = isTranscriptReady(transcript, artifact, context);
  const valid = [minimum, target, maximum, count].every(v => v.trim() !== "" && Number.isFinite(Number(v)))
    && +minimum >= 2 && +maximum <= 180 && +minimum <= +target && +target <= +maximum && +count >= 1 && +count <= 8 && Number.isInteger(+count);
  const dirtyChanged = useCallback((id: string, value: boolean) => setDirty(previous => {
    if (previous.has(id) === value) return previous;
    const next = new Set(previous); if (value) next.add(id); else next.delete(id); return next;
  }), []);
  const load = useCallback(async (signal: AbortSignal) => {
    const values = await request<ClipAnalysis[]>(`/api/clips?${query}`, "GET", undefined, signal);
    if (!signal.aborted) { setRuns(values); setError(null); }
  }, [query]);
  useEffect(() => {
    const abort = new AbortController(); lifetime.current = abort;
    void load(abort.signal).catch(failure => { if (!abort.signal.aborted) setError(failure); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); poll.current?.abort(); };
  }, [load]);
  useEffect(() => {
    if (!running || busy) return;
    const abort = new AbortController(); poll.current = abort;
    const timer = setTimeout(() => { void load(abort.signal).then(() => { if (!abort.signal.aborted) changed.current(); })
      .catch(failure => { if (!abort.signal.aborted) setError(failure); }).finally(() => { if (!abort.signal.aborted) setEpoch(v => v + 1); }); }, 1500);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [running, busy, epoch, load]);
  async function act(work: (signal: AbortSignal) => Promise<void>) {
    if (operation.current || lifetime.current.signal.aborted) return;
    operation.current = true; poll.current?.abort(); setBusy(true); setError(null);
    const signal = lifetime.current.signal;
    try { await work(signal); }
    catch (failure) { if (!signal.aborted) setError(failure); }
    finally { if (!signal.aborted) { operation.current = false; setBusy(false); } }
  }
  function update(value: ClipAnalysis) { setRuns(previous => [value, ...previous.filter(old => old.id !== value.id)]); setActiveId(value.id); }
  function refreshModels() {
    void act(async signal => {
      try {
        const value = await request<Setup>("/api/ai/setup?refresh=1", "GET", undefined, signal);
        if (signal.aborted) return;
        setSetup(value);
        if (!value.models.includes(model)) setModel("");
        if (!value.available || !value.models.includes(model)) setConsent(false);
      } catch {
        if (signal.aborted) return;
        setSetup(previous => ({ ...previous, available: false, models: previous?.models ?? [], error: "ai_catalog_refresh_failed",
          catalog: { state: "stale", refreshedAt: previous?.catalog?.refreshedAt ?? null } }));
        setConsent(false);
      }
    });
  }
  const disabled = busy || loading;
  return <div className="studio-inspector-form clips-panel">
    <header className="clips-heading"><Scissors size={18} /><div><h2>{t("title")}</h2><p>{t("help")}</p></div></header>
    <form onSubmit={event => { event.preventDefault(); if (!ready || !valid || running || dirty.size || mode === "ai" && (!consent || !setup?.available || !setup.models.includes(model))) return; void act(async signal => {
      const value = await request<ClipAnalysis>("/api/clips", "POST", { context, artifactId: artifact.id, destinationId: account.destinationId,
        options: { minSeconds: +minimum, targetSeconds: +target, maxSeconds: +maximum, count: +count, model: mode === "ai" ? model : null, includeTranscript: mode === "ai" && consent, includeHistory: history } }, signal);
      if (!signal.aborted) { setSelected([]); update(value); }
    }); }}>
      <fieldset className="studio-editor-fields" disabled={disabled || running}>
        <label className="form-field">{t("mode")}<select value={mode} onChange={event => { setMode(event.target.value); setConsent(false); }}><option value="local">{t("local")}</option><option value="ai">{t("ai")}</option></select></label>
        <p className="studio-help">{t(mode === "ai" ? "aiHelp" : "localHelp")}</p>
        {mode === "ai" && <>
          <button className="button secondary" type="button" onClick={refreshModels}><RefreshCw size={13} />{t("discover")}</button>
          {setup?.version && <p className="studio-help">OpenCode CLI · {setup.version}</p>}
          {setup?.catalog && <p className="studio-help" role="status">{assistantText(language)(setup.catalog.state === "stale" ? "catalogStale" : "catalogCurrent")}
            {setup.catalog.refreshedAt && <> · {assistantText(language)("catalogUpdated")} <time dateTime={setup.catalog.refreshedAt}>{new Date(setup.catalog.refreshedAt).toLocaleString(language)}</time></>}</p>}
          {setup && !setup.available && <p className="studio-inline-error">{setup.error ? assistantError(setup.error, assistantText(language)) : t("noModels")}</p>}
          <label className="form-field">{t("model")}<select value={model} disabled={!setup?.available} onChange={event => { setModel(event.target.value); setConsent(false); }} required><option value="">{t("chooseModel")}</option>{setup?.models.map(id => <option key={id}>{id}</option>)}</select></label>
          <label className="studio-checkbox"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{t("consent")}</label>
        </>}
        <div className="clips-duration">{([["min", minimum, setMinimum], ["target", target, setTarget], ["max", maximum, setMaximum]] as const).map(([key, value, setter]) => <label key={key} className="form-field">{t(key)}<input type="number" min={2} max={180} step="any" required value={value} onChange={event => setter(event.target.value)} /></label>)}</div>
        <label className="form-field">{t("count")}<input type="number" min={1} max={8} step={1} required value={count} onChange={event => setCount(event.target.value)} /></label>
        <label className="studio-checkbox"><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)} />{t("history")}</label>
        {!valid && <p className="studio-inline-error">{t("invalid")}</p>}
        <button className="button primary studio-full-width" type="submit" disabled={!ready || !valid || !!dirty.size || mode === "ai" && (!consent || !model || !setup?.available)}><Scissors size={14} />{t("start")}</button>
        {!ready && <p className="studio-help">{t("transcriptRequired")}</p>}
      </fieldset>
    </form>
    <TranscriptionPanel artifact={artifact} context={context} language={language} onChanged={setTranscript} />
    <div className="clips-list-heading"><h3>{t("candidates")}</h3><button className="icon-button" type="button" aria-label={t("retry")} disabled={disabled} onClick={() => { void act(signal => load(signal)); }}><RefreshCw size={14} /></button></div>
    {loading && <p className="studio-help" role="status">{t("load")}</p>}
    {!!error && <p className="studio-inline-error" role="alert">{clipError(error, t)}</p>}
    {runs.length > 1 && <label className="form-field">{t("historyChoose")}<select value={run?.id ?? ""} disabled={disabled || !!dirty.size} onChange={event => { setActiveId(event.target.value); setSelected([]); }}>{runs.map((r, i) => <option key={r.id} value={r.id}>{i === 0 ? `${t("latest")} · ` : ""}{new Date(r.createdAt).toLocaleTimeString(language)} · {r.options.model ?? t("local")}</option>)}</select></label>}
    {!run && !loading && <div className="clips-empty"><Scissors size={24} /><h3>{t("empty")}</h3><p>{t("emptyHelp")}</p></div>}
    {run && <>
      <p className="clips-status" role="status">{run.state === "running" && <LoaderCircle size={13} className="spinning" />}{t(run.state === "running" ? run.stage === "analysis" ? "running" : "rendering" : run.state)}</p>
      {run.error && <p className="studio-inline-error" role="alert">{clipError(run.error, t)} <code>{run.error}</code></p>}
      {run.state === "running" && <button className="button secondary studio-full-width" disabled={disabled || run.cancelRequested} onClick={() => { void act(async signal => { const value = await request<ClipAnalysis>(`/api/clips/${run.id}/cancel`, "POST", { context }, signal); if (!signal.aborted) { update(value); changed.current(); } }); }}>{t("cancel")}</button>}
      {run.truncated && <p className="studio-callout">{t("sampled")}</p>}
      <ol className="clips-candidates">{run.candidates.map((candidate, index) => <li key={`${run.id}:${candidate.id}`}><CandidateEditor
        key={`${candidate.id}:${JSON.stringify(candidate.edit)}`} candidate={candidate} run={run} rank={index + 1} t={t} disabled={disabled || run.state !== "ready"}
        selected={selected.includes(candidate.id)} onSelect={value => setSelected(previous => value ? [...previous, candidate.id] : previous.filter(id => id !== candidate.id))}
        onSeek={onSeek} onDirty={dirtyChanged} connected={account.platform === "youtube" && account.status === "connected"}
        save={edit => act(async signal => { const value = await request<ClipAnalysis>(`/api/clips/${run.id}`, "PUT", { context, expectedRevision: run.revision, candidateId: candidate.id, edit }, signal); if (!signal.aborted) update(value); })}
        captions={(start, end) => request<NonNullable<MediaEdit["timedCaptions"]>>(`/api/clips/${run.id}/captions`, "POST", { context, candidateId: candidate.id, start, end }, lifetime.current.signal)}
        draft={title => act(async signal => { await request(`/api/clips/${run.id}/draft`, "POST", { context, expectedRevision: run.revision, candidateId: candidate.id, title }, signal); if (!signal.aborted) { await load(signal); changed.current(); } })} />
      </li>)}</ol>
      {!!dirty.size && <p className="studio-help" role="status">{t("unsaved")}</p>}
      {!!run.candidates.length && <><button className="button primary studio-full-width" disabled={disabled || running || run.state !== "ready" || !selected.length || !!dirty.size} onClick={() => { void act(async signal => { const value = await request<ClipAnalysis>(`/api/clips/${run.id}/render`, "POST", { context, expectedRevision: run.revision, candidateIds: selected }, signal); if (!signal.aborted) { update(value); changed.current(); } }); }}><Clapperboard size={14} />{t("render")} · {selected.length}</button><p className="studio-help">{t("exports")}</p></>}
      <details className="clips-provenance"><summary>{t("provenance")}</summary><p>{run.algorithm} · {run.options.model ?? t("local")}<br />{t("language")}: {run.language}<br />{t("historyLabel")}: {run.history.revision}</p><code>{run.id}<br />{run.sourceSha256}<br />{run.transcriptSha256}</code></details>
    </>}
  </div>;
}

interface CandidateProps {
  candidate: ClipCandidate; run: ClipAnalysis; rank: number; t: ClipText; disabled: boolean; selected: boolean; connected: boolean;
  onSelect: (value: boolean) => void; onSeek: (time: number) => void; onDirty: (id: string, value: boolean) => void;
  save: (edit: MediaEdit) => Promise<void>; captions: (start: number, end: number) => Promise<NonNullable<MediaEdit["timedCaptions"]>>; draft: (title: string) => Promise<void>;
}
function CandidateEditor({ candidate: c, run, rank, t, disabled, selected, connected, onSelect, onSeek, onDirty, save, captions, draft }: CandidateProps) {
  const [start, setStart] = useState(String(c.edit.inSeconds)), [end, setEnd] = useState(String(c.edit.outSeconds));
  const [crop, setCrop] = useState(c.edit.crop), [cropX, setCropX] = useState(c.edit.cropX ?? .5), [caption, setCaption] = useState(c.edit.caption);
  const [cues, setCues] = useState(c.edit.timedCaptions ?? []), [captionBusy, setCaptionBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const [title, setTitle] = useState(c.evidence.excerpt.slice(0, 90).replace(/[<>\u0000-\u001f]/gu, " "));
  const [preview, setPreview] = useState<string | null>(null), [previewBusy, setPreviewBusy] = useState(false);
  const lifetime = useRef(new AbortController()), urlRef = useRef<string | null>(null);
  const edit = { ...c.edit, inSeconds: +start, outSeconds: +end, crop, cropX, caption, ...(cues.length ? { timedCaptions: cues } : { timedCaptions: undefined }) };
  const dirty = JSON.stringify({ ...c.edit, cropX: c.edit.cropX ?? .5, timedCaptions: c.edit.timedCaptions?.length ? c.edit.timedCaptions : undefined }) !== JSON.stringify(edit);
  const valid = !!start.trim() && !!end.trim() && editSchema.safeParse(edit).success && +end - +start >= run.options.minSeconds && +end - +start <= run.options.maxSeconds;
  useEffect(() => { onDirty(c.id, dirty); return () => onDirty(c.id, false); }, [c.id, dirty, onDirty]);
  useEffect(() => { const abort = new AbortController(); lifetime.current = abort; return () => { abort.abort(); if (urlRef.current) URL.revokeObjectURL(urlRef.current); }; }, []);
  function discard() { setStart(String(c.edit.inSeconds)); setEnd(String(c.edit.outSeconds)); setCrop(c.edit.crop); setCropX(c.edit.cropX ?? .5); setCaption(c.edit.caption); setCues(c.edit.timedCaptions ?? []); setError(null); }
  return <article className="clip-card">
    <header><label className="studio-checkbox"><input type="checkbox" checked={selected} disabled={disabled} aria-label={`${t("selected")} ${rank}`} onChange={event => onSelect(event.target.checked)} /><strong>#{rank} · {time(c.edit.inSeconds)} → {time(c.edit.outSeconds)}</strong></label><span title={t("score")}>{c.score}/100</span></header>
    {c.reason && <p className="clip-rationale">{c.reason}</p>}
    {c.renderError && <p className="studio-inline-error" role="alert">{clipError(c.renderError, t)}</p>}
    <blockquote>{c.evidence.excerpt}</blockquote>
    <details><summary>{t("evidence")}</summary>{Number.isFinite(c.evidence.start) && <p className="studio-help">{time(c.evidence.start)} → {time(c.evidence.end)}<br />{c.evidence.segmentTimes?.map(s => `${time(s.start)}–${time(s.end)}`).join(" · ")}</p>}<dl><div><dt>{t("speech")}</dt><dd>{Math.round(c.evidence.speechRatio * 100)}%</dd></div><div><dt>{t("scenes")}</dt><dd>{c.evidence.scenes.length}</dd></div><div><dt>{t("previous")}</dt><dd>{Math.round(c.evidence.historyOverlap * 100)}%</dd></div></dl>{c.evidence.sentenceBoundary && <p className="studio-help"><Check size={11} /> {t("sentence")}</p>}{c.evidence.partialSpeech && <p className="studio-callout">{t("partialSpeech")}</p>}<p className="studio-help">{t("context")} {t("originalEvidence")}</p></details>
    <button className="text-button" type="button" onClick={() => onSeek(valid ? +start : c.edit.inSeconds)}>{t("source")}</button>
    <details className="clip-adjust"><summary>{t("adjust")}</summary><fieldset className="studio-editor-fields" disabled={disabled || captionBusy}>
      <div className="studio-form-pair"><label className="form-field">{t("in")}<input type="number" min={0} step="any" value={start} onChange={event => setStart(event.target.value)} /></label><label className="form-field">{t("out")}<input type="number" min={0} step="any" value={end} onChange={event => setEnd(event.target.value)} /></label></div>
      <label className="form-field">{t("crop")}<select value={crop} onChange={event => setCrop(event.target.value as MediaEdit["crop"])}>{(["vertical", "square", "original"] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
      <label className="form-field">{t("framing")}<input type="range" min={0} max={1} step={.01} value={cropX} onChange={event => setCropX(+event.target.value)} /><output>{Math.round(cropX * 100)}%</output></label>
      <label className="form-field">{t("caption")}<textarea rows={2} maxLength={2000} value={caption} onChange={event => setCaption(event.target.value)} /></label>
      <button type="button" className="button secondary" disabled={!valid} onClick={() => { if (captionBusy) return; setCaptionBusy(true); setError(null); void captions(+start, +end).then(value => { if (!lifetime.current.signal.aborted) { setCues(value); setCaption(""); } }).catch(failure => { if (!lifetime.current.signal.aborted) setError(failure); }).finally(() => { if (!lifetime.current.signal.aborted) setCaptionBusy(false); }); }}>{t("timed")}</button>
      <p className="studio-help">{t("captionHelp")}</p>
      {!!cues.length && <ol className="clip-cues">{cues.map((cue, index) => <li key={index}><div className="studio-form-pair"><input type="number" step="any" aria-label={`${t("cueStart")} ${index + 1}`} value={cue.start} onChange={event => setCues(previous => previous.map((v, n) => n === index ? { ...v, start: +event.target.value } : v))} /><input type="number" step="any" aria-label={`${t("cueEnd")} ${index + 1}`} value={cue.end} onChange={event => setCues(previous => previous.map((v, n) => n === index ? { ...v, end: +event.target.value } : v))} /></div><textarea rows={2} aria-label={`${t("cueText")} ${index + 1}`} maxLength={300} value={cue.text} onChange={event => setCues(previous => previous.map((v, n) => n === index ? { ...v, text: event.target.value } : v))} /><button type="button" className="text-button" onClick={() => setCues(previous => previous.filter((_, n) => n !== index))}>{t("remove")}</button></li>)}</ol>}
      {dirty && !valid && <p className="studio-inline-error">{t("bounds")}</p>}
      <div className="clips-actions"><button type="button" className="button secondary" disabled={!dirty || !valid} onClick={() => { void save(edit); }}>{t("save")}</button><button type="button" className="text-button" disabled={!dirty} onClick={discard}>{t("discard")}</button></div>
    </fieldset></details>
    {!!error && <p className="studio-inline-error" role="alert">{clipError(error, t)}</p>}
    {c.artifactId && <>
      <button type="button" className="text-button" disabled={previewBusy} onClick={() => {
        if (preview) { URL.revokeObjectURL(preview); urlRef.current = null; setPreview(null); return; }
        setPreviewBusy(true); setError(null); void mediaBlob(`/api/media/${c.artifactId}/content?${new URLSearchParams({ accountId: run.context.accountId, projectId: run.context.projectId })}`, lifetime.current.signal)
          .then(blob => { if (!lifetime.current.signal.aborted) { const url = URL.createObjectURL(blob); urlRef.current = url; setPreview(url); } })
          .catch(failure => { if (!lifetime.current.signal.aborted) setError(failure); }).finally(() => { if (!lifetime.current.signal.aborted) setPreviewBusy(false); });
      }}>{t(preview ? "close" : "preview")}</button>
      {preview && <video className="clip-preview" src={preview} controls playsInline preload="metadata" />}
      {c.publicationId ? <p className="studio-saved" role="status"><Check size={12} />{t("draftReady")}</p> : <div className="clip-draft"><label className="form-field">{t("titleField")}<input maxLength={100} value={title} disabled={disabled} onChange={event => setTitle(event.target.value)} /></label><button className="button secondary studio-full-width" type="button" disabled={disabled || dirty || !connected || !title.trim() || /[<>\u0000-\u001f]/u.test(title)} onClick={() => { void draft(title.trim()); }}>{t("draft")}</button>{!connected && <p className="studio-help">{t("connect")}</p>}</div>}
    </>}
  </article>;
}
