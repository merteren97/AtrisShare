import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import type { WorkspaceContext } from "../../../packages/domain/src/workspace.js";
import type { StudioArtifact } from "./Studio";
import { request } from "./api";
import { assistantText, transcriptionError } from "./assistant-i18n";
import "./transcription.css";

export interface Transcript {
  id: string; accountId: string; projectId: string; artifactId: string; sourceSha256: string;
  state: "running" | "succeeded" | "failed" | "cancelled"; progress: number;
  language: string | null; segments: { start: number; end: number; text: string }[];
  duration: number | null; error: string | null; createdAt: string; updatedAt: string; cancelRequested?: boolean;
}
interface Setup { available: boolean; ffmpeg: boolean; whisper: boolean; model: boolean }
interface TranscriptionPanelProps {
  artifact: StudioArtifact; context: WorkspaceContext; language: "tr" | "en";
  onChanged: (transcript: Transcript | null) => void;
}

function bound(transcript: Transcript, artifact: StudioArtifact, context: WorkspaceContext): boolean {
  return transcript.artifactId === artifact.id && transcript.sourceSha256 === artifact.sha256
    && transcript.accountId === context.accountId && transcript.projectId === context.projectId
    && artifact.accountId === context.accountId && artifact.projectId === context.projectId;
}

export function isTranscriptReady(transcript: Transcript | null, artifact: StudioArtifact, context: WorkspaceContext): transcript is Transcript & { state: "succeeded"; duration: number } {
  if (!transcript || !bound(transcript, artifact, context) || transcript.state !== "succeeded" || transcript.error
    || artifact.kind === "proxy" || artifact.kind === "preview" || transcript.progress !== 1
    || !artifact.probe?.hasAudio || !(artifact.probe.duration > 0) || !Number.isFinite(transcript.duration) || !(transcript.duration! > 0)
    || !transcript.segments.length) return false;
  let end = 0, hasText = false;
  for (const segment of transcript.segments) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < end
      || segment.end <= segment.start || segment.end > transcript.duration! || typeof segment.text !== "string") return false;
    end = segment.end; hasText ||= !!segment.text.trim();
  }
  return hasText;
}

function timestamp(seconds: number): string {
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

export function TranscriptionPanel(props: TranscriptionPanelProps) {
  const { artifact, context } = props;
  return <TranscriptionSession key={JSON.stringify([context.accountId, context.projectId, artifact.id, artifact.sha256, artifact.probe?.hasAudio, artifact.probe?.duration])} {...props} />;
}

function TranscriptionSession({ artifact, context, language, onChanged }: TranscriptionPanelProps) {
  const t = assistantText(language);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<"start" | "cancel" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pollEpoch, setPollEpoch] = useState(0);
  const [visible, setVisible] = useState(100);
  const [expanded, setExpanded] = useState(false);
  const callback = useRef(onChanged);
  const lifetime = useRef(new AbortController());
  const busy = useRef(false);
  const callbackValue = boundValue(transcript);
  const projectId = context.projectId;
  const accountId = context.accountId;
  const path = `/api/media/${encodeURIComponent(artifact.id)}`;
  const query = new URLSearchParams({ accountId, projectId: projectId ?? "" }).toString();
  const latestPath = `${path}/transcript?${query}`;
  const matchingScope = !!projectId && artifact.accountId === accountId && artifact.projectId === projectId
    && artifact.kind !== "proxy" && artifact.kind !== "preview";
  const hasProbe = !!artifact.probe && Number.isFinite(artifact.probe.duration) && artifact.probe.duration > 0;
  const eligible = matchingScope && hasProbe && artifact.probe?.hasAudio === true;
  const stale = !!transcript && !bound(transcript, artifact, context);
  const running = !stale && transcript?.state === "running";
  const ready = isTranscriptReady(transcript, artifact, context);

  function boundValue(value: Transcript | null) { return value && bound(value, artifact, context) ? value : null; }
  useEffect(() => { callback.current = onChanged; }, [onChanged]);
  useEffect(() => { callback.current(callbackValue); }, [callbackValue]);
  useEffect(() => { setVisible(100); setExpanded(false); }, [transcript?.id]);

  // A running cancel acknowledgement remains pending until a terminal state is read.
  const update = useCallback((value: Transcript | null) => {
    setTranscript(previous => value && previous?.id === value.id && value.state === "running"
      ? { ...value, cancelRequested: !!(previous.cancelRequested || value.cancelRequested) } : value);
  }, []);

  const load = useCallback(async () => {
    if (busy.current || lifetime.current.signal.aborted) return;
    busy.current = true; setLoading(true); setError(null);
    const signal = lifetime.current.signal;
    const results = await Promise.allSettled([
      request<Setup>("/api/transcription/setup", "GET", undefined, signal),
      request<Transcript | null>(latestPath, "GET", undefined, signal),
    ]);
    if (signal.aborted) return;
    const [discovery, latest] = results;
    setSetup(discovery.status === "fulfilled" ? discovery.value : null);
    update(latest.status === "fulfilled" ? latest.value : null);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") setError(failure.reason);
    busy.current = false; setLoading(false);
  }, [latestPath, update]);

  useEffect(() => {
    const abort = new AbortController(); lifetime.current = abort; busy.current = false;
    callback.current(null); void load();
    return () => { abort.abort(); };
  }, [load]);

  useEffect(() => {
    if (!running || loading || operation) return;
    const abort = new AbortController(), jobId = transcript!.id;
    const timer = setTimeout(() => {
      void request<Transcript | null>(latestPath, "GET", undefined, abort.signal).then(value => {
        if (abort.signal.aborted || busy.current) return;
        // An old poll must never replace a different job or cross a source boundary.
        if (value?.id !== jobId) { setError({ code: "transcription_job_changed" }); return; }
        update(value); setError(null);
      }).catch(failure => { if (!abort.signal.aborted) setError(failure); })
        .finally(() => { if (!abort.signal.aborted) setPollEpoch(value => value + 1); });
    }, 1800);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [running, loading, operation, transcript?.id, latestPath, update, pollEpoch]);

  async function act(name: "start" | "cancel") {
    if (busy.current || lifetime.current.signal.aborted || !eligible
      || name === "start" && (running || !setup?.available)
      || name === "cancel" && (!running || transcript?.cancelRequested)) return;
    busy.current = true; setOperation(name); setError(null);
    const signal = lifetime.current.signal, jobId = transcript?.id;
    try {
      const value = await request<Transcript>(name === "start" ? `${path}/transcribe` : `/api/transcripts/${encodeURIComponent(jobId!)}/cancel`, "POST", { context: { accountId, projectId } }, signal);
      if (signal.aborted) return;
      if (name === "cancel" && value.id !== jobId) throw { code: "transcription_job_changed" };
      update(name === "cancel" && value.state === "running" ? { ...value, cancelRequested: true } : value);
    } catch (failure) { if (!signal.aborted) setError(failure); }
    finally { if (!signal.aborted) { busy.current = false; setOperation(null); } }
  }

  const disabled = loading || !!operation;
  const progress = transcript?.progress;
  const status = running ? transcript?.cancelRequested || operation === "cancel" ? "transcriptCancelling" : "transcriptRunning"
    : ready ? "transcriptReady" : transcript?.state === "failed" ? "transcriptFailed"
      : transcript?.state === "cancelled" ? "transcriptCancelled" : "transcriptEmpty";

  return <details className="assistant-details transcription-panel">
    <summary>{t("transcriptTitle")}</summary>
    <p className="studio-help">{t("transcriptLocalHelp")}</p>
    <div className="transcription-setup"><div><strong>{t("transcriptSetup")}</strong><span>{t(loading ? "checking" : setup?.available ? "available" : "unavailable")}</span></div>
      <button type="button" className="icon-button" disabled={disabled} onClick={() => { void load(); }} title={t("transcriptRefresh")} aria-label={t("transcriptRefresh")}><RefreshCw size={14} className={loading ? "spinning" : ""} /></button></div>
    {setup && <ul className="transcription-tools">{(["ffmpeg", "whisper", "model"] as const).map(tool => <li key={tool}>{t(tool === "ffmpeg" ? "transcriptFfmpeg" : tool === "whisper" ? "transcriptWhisper" : "transcriptModel")}: {t(setup[tool] ? "available" : "unavailable")}</li>)}</ul>}
    {!loading && !setup?.available && <p className="studio-help">{t("transcriptSetupHelp")}</p>}
    {!matchingScope && <p className="studio-inline-error" role="alert">{t("errorScope")}</p>}
    {!hasProbe ? <p className="studio-callout">{t("probeRequired")}</p> : !artifact.probe?.hasAudio && <p className="studio-callout">{t("transcriptNoAudio")}</p>}
    {stale && <p className="studio-inline-error" role="alert">{t("transcriptStale")}</p>}
    {!!error && <div className="assistant-error" role="alert"><CircleAlert size={14} /><div><p>{transcriptionError(error, t)}</p><button className="text-button" type="button" disabled={disabled} onClick={() => { void load(); }}>{t("retry")}</button></div></div>}
    {!stale && !loading && <p className="transcription-status" role="status">{running && <LoaderCircle size={12} className="spinning" />}{t(status)}</p>}
    {running && <div className="studio-progress"><progress max={1} {...(Number.isFinite(progress) ? { value: Math.min(1, Math.max(0, progress!)) } : {})} aria-label={t("transcriptRunning")} />{Number.isFinite(progress) && <span>{Math.round(Math.min(1, Math.max(0, progress!)) * 100)}%</span>}</div>}
    {!stale && transcript?.error && <p className="studio-inline-error" role="alert">{transcriptionError(transcript.error, t)}</p>}
    {running ? <button type="button" className="button secondary studio-full-width" disabled={disabled || transcript?.cancelRequested || !eligible} onClick={() => { void act("cancel"); }}>{t(transcript?.cancelRequested || operation === "cancel" ? "transcriptCancelling" : "transcriptCancel")}</button>
      : <button type="button" className="button secondary studio-full-width" disabled={disabled || !eligible || !setup?.available} onClick={() => { void act("start"); }}>{operation === "start" && <LoaderCircle size={13} className="spinning" />}{t(operation === "start" ? "transcriptStarting" : ready ? "transcriptAgain" : "transcriptStart")}</button>}
    {ready && <>
      <p className="studio-help">{t("transcriptLanguage")}: {transcript.language ?? "—"} · {t("transcriptDuration")}: {timestamp(transcript.duration!)}<br />{t("sourceHash")}: <code title={transcript.sourceSha256}>{transcript.sourceSha256.slice(0, 12)}</code></p>
      <details className="assistant-details transcription-segments" onToggle={event => setExpanded(event.currentTarget.open)}><summary>{t("transcriptSegments")} · {transcript.segments.length.toLocaleString(language)}</summary>
        {expanded && <><ol>{transcript.segments.slice(0, visible).map((segment, index) => <li key={index}><span className="transcription-time">{timestamp(segment.start)} → {timestamp(segment.end)}</span><p>{segment.text}</p></li>)}</ol>
          <p className="studio-help">{Math.min(visible, transcript.segments.length).toLocaleString(language)} / {transcript.segments.length.toLocaleString(language)}</p>
          {visible < transcript.segments.length && <button className="text-button" type="button" onClick={() => setVisible(value => value + 100)}>{t("transcriptMore")}</button>}</>}
      </details>
    </>}
  </details>;
}
