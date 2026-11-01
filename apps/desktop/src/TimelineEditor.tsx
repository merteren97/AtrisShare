import { useEffect, useRef, useState } from "react";
import { Check, Clapperboard, LoaderCircle, RotateCcw, RotateCw, Scissors, Trash2 } from "lucide-react";
import type { WorkspaceContext } from "../../../packages/domain/src/workspace.js";
import type { MediaEdit } from "../../../packages/domain/src/media.js";
import type { StudioArtifact } from "./Studio";
import { request } from "./api";
import type { StudioTranslate } from "./studio-i18n";

interface Timeline { revision: number; cursor: number; edits: MediaEdit[] }
interface RangeFields { inSeconds: string; outSeconds: string }
interface EditFields { segments: RangeFields[]; crop: MediaEdit["crop"]; gainDb: string; caption: string }
interface EditPanelProps {
  artifact: StudioArtifact; context: WorkspaceContext; tools: { available: boolean }; t: StudioTranslate;
  errorText: (e: unknown) => string; parentBusy: boolean; reloadKey: number;
  sourceTime: number; onSeek: (seconds: number) => void; onExport: (expectedRevision: number) => void;
}
function time(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—";
  const hundredths = Math.round(value * 100);
  return `${Math.floor(hundredths / 6000).toString().padStart(2, "0")}:${(Math.floor(hundredths / 100) % 60).toString().padStart(2, "0")}.${(hundredths % 100).toString().padStart(2, "0")}`;
}
function toFields(edit: MediaEdit): EditFields {
  return { segments: (edit.segments ?? [{ inSeconds: edit.inSeconds, outSeconds: edit.outSeconds }]).map(range => ({ inSeconds: String(range.inSeconds), outSeconds: String(range.outSeconds) })), crop: edit.crop, gainDb: String(edit.gainDb), caption: edit.caption };
}

export function EditPanel({ artifact, context, tools, t, errorText, parentBusy, reloadKey, sourceTime, onSeek, onExport }: EditPanelProps) {
  const duration = artifact.probe?.duration ?? 0;
  const defaults: MediaEdit = { inSeconds: 0, outSeconds: duration, crop: "original", gainDb: 0, caption: "" };
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [fields, setFields] = useState<EditFields>(() => toFields(defaults));
  const [baseline, setBaseline] = useState(() => JSON.stringify(toFields(defaults)));
  const [selected, setSelected] = useState(0);
  const [splitTime, setSplitTime] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);
  const abortRef = useRef(new AbortController());
  const path = `/api/media/${encodeURIComponent(artifact.id)}/timeline?${new URLSearchParams({ accountId: context.accountId, projectId: context.projectId ?? "" })}`;
  const dirty = baseline !== JSON.stringify(fields);
  const disabled = loading || saving || parentBusy || !tools.available || !duration || conflict || !timeline;
  const ranges = fields.segments.map(range => ({ inSeconds: Number(range.inSeconds), outSeconds: Number(range.outSeconds) }));
  const rangesValid = ranges.length >= 1 && ranges.length <= 32 && ranges.every((range, index) => fields.segments[index]!.inSeconds.trim() !== "" && fields.segments[index]!.outSeconds.trim() !== "" && Number.isFinite(range.inSeconds) && Number.isFinite(range.outSeconds) && range.inSeconds >= 0 && range.outSeconds > range.inSeconds && range.outSeconds <= duration && (index === 0 || range.inSeconds >= ranges[index - 1]!.outSeconds));
  const valid = rangesValid && fields.gainDb.trim() !== "" && Number.isFinite(Number(fields.gainDb)) && Number(fields.gainDb) >= -60 && Number(fields.gainDb) <= 24 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(fields.caption);
  const current = ranges[selected];
  const split = Number(splitTime);
  const canSplit = rangesValid && ranges.length < 32 && splitTime.trim() !== "" && Number.isFinite(split) && !!current && split > current.inSeconds && split < current.outSeconds;
  const keptDuration = rangesValid ? ranges.reduce((sum, range) => sum + range.outSeconds - range.inSeconds, 0) : 0;
  const outputStarts = ranges.map((_, index) => ranges.slice(0, index).reduce((sum, range) => sum + range.outSeconds - range.inSeconds, 0));

  function accept(value: Timeline) {
    const next = toFields(value.edits[value.cursor] ?? defaults);
    setTimeline(value); setFields(next); setBaseline(JSON.stringify(next)); setConflict(false); setSelected(0); setSplitTime("");
  }
  useEffect(() => {
    const abort = new AbortController(); abortRef.current = abort;
    busyRef.current = false; setSaving(false); setLoading(true); setTimeline(null); setError(null); setSavedNotice(false);
    void request<Timeline>(path, "GET", undefined, abort.signal).then(value => {
      if (!abort.signal.aborted) accept(value);
    }).catch(failure => { if (!abort.signal.aborted) setError(failure); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [path, reload, reloadKey]);
  function change(next: EditFields) { setSavedNotice(false); setFields(next); }
  function trim(key: keyof RangeFields, value: string) {
    change({ ...fields, segments: fields.segments.map((range, index) => index === selected ? { ...range, [key]: value } : range) });
  }
  function selectRange(index: number) {
    setSelected(index); setSplitTime("");
    if (rangesValid) onSeek(ranges[index]!.inSeconds);
  }
  function splitRange() {
    if (disabled || !canSplit || !current) return;
    // Keep the exact user boundary on both sides, including adjacent segments.
    const next = [...fields.segments];
    next.splice(selected, 1, { inSeconds: String(current.inSeconds), outSeconds: splitTime }, { inSeconds: splitTime, outSeconds: String(current.outSeconds) });
    change({ ...fields, segments: next }); setSelected(selected + 1); setSplitTime(""); onSeek(split);
  }
  async function mutate(action: "save" | "undo" | "redo") {
    if (!timeline || busyRef.current || disabled || (action === "save" ? !valid : dirty)) return;
    busyRef.current = true; setSaving(true); setError(null); setSavedNotice(false);
    const signal = abortRef.current.signal;
    try {
      const edit: MediaEdit = { inSeconds: ranges[0]!.inSeconds, outSeconds: ranges[ranges.length - 1]!.outSeconds, segments: ranges, crop: fields.crop, gainDb: Number(fields.gainDb), caption: fields.caption };
      const url = action === "save" ? path : `/api/media/${encodeURIComponent(artifact.id)}/timeline/${action}`;
      const value = await request<Timeline>(url, action === "save" ? "PUT" : "POST", { context, expectedRevision: timeline.revision, ...(action === "save" ? { edit } : {}) }, signal);
      if (!signal.aborted) { accept(value); setSavedNotice(true); }
    } catch (failure) {
      if (!signal.aborted) {
        setError(failure);
        if (failure && typeof failure === "object" && "code" in failure && /revision|conflict/.test(String(failure.code))) setConflict(true);
      }
    } finally { if (!signal.aborted) { busyRef.current = false; setSaving(false); } }
  }

  return <div className="studio-inspector-form studio-range-editor">
    {!tools.available && <div className="studio-callout"><strong>{t("toolsMissing")}</strong><p>{t("toolsHelp")}</p></div>}
    {!duration && <p className="studio-help">{t("durationRequired")}</p>}
    {loading ? <p className="studio-help" role="status">{t("loading")}</p> : <>
      <form onSubmit={event => { event.preventDefault(); void mutate("save"); }}>
        <fieldset className="studio-editor-fields" disabled={disabled}>
          <legend>{t("keptRanges")}</legend>
          <div className="studio-duration-summary"><strong>{rangesValid ? time(keptDuration) : "—"}<small>{t("outputDuration")}</small></strong><span>/ {time(duration)}<small>{t("sourceDuration")}</small></span><span className="count">{ranges.length} / 32</span></div>
          <div className="studio-timeline" aria-label={t("timeline")}>
            <div className="studio-timeline-track studio-kept-track">
              {rangesValid && ranges.map((range, index) => <button key={index} type="button" className={index === selected ? "is-selected" : ""} style={{ left: `${range.inSeconds / duration * 100}%`, width: `${(range.outSeconds - range.inSeconds) / duration * 100}%` }} aria-label={`${t("range")} ${index + 1}: ${time(range.inSeconds)}–${time(range.outSeconds)}`} aria-pressed={selected === index} title={`${index + 1} · ${time(range.inSeconds)}–${time(range.outSeconds)}`} onClick={() => selectRange(index)}>{index + 1}</button>)}
              {duration > 0 && <i className="studio-source-playhead" style={{ left: `${Math.min(100, Math.max(0, sourceTime / duration * 100))}%` }} />}
            </div><div className="studio-timeline-times"><span>00:00</span><span>{t("sourceTime")}</span><span>{time(duration)}</span></div>
          </div>
          <ol className="studio-range-list" aria-label={t("keptRanges")}>{ranges.map((range, index) => <li key={index}><button className={index === selected ? "is-selected" : ""} type="button" aria-pressed={selected === index} onClick={() => selectRange(index)}>
            <span className="studio-range-number">{index + 1}</span><span><strong>{time(range.inSeconds)} → {time(range.outSeconds)}</strong><small>{t("outputTime")} {rangesValid ? `${time(outputStarts[index]!)}–${time(outputStarts[index]! + range.outSeconds - range.inSeconds)}` : "—"}</small></span><span>{rangesValid ? time(range.outSeconds - range.inSeconds) : "—"}</span>
          </button></li>)}</ol>
          <div className="studio-selected-range"><strong>{t("range")} {selected + 1}</strong><button className="text-button" type="button" disabled={ranges.length <= 1} onClick={() => { change({ ...fields, segments: fields.segments.filter((_, index) => index !== selected) }); setSelected(Math.max(0, selected - 1)); setSplitTime(""); }}><Trash2 size={12} />{t("removeRange")}</button></div>
          <div className="studio-form-pair"><label className="form-field">{t("trimIn")}<input type="number" min={selected > 0 ? ranges[selected - 1]!.outSeconds : 0} max={current?.outSeconds ?? duration} step="any" required value={fields.segments[selected]?.inSeconds ?? ""} onChange={event => trim("inSeconds", event.target.value)} /></label>
            <label className="form-field">{t("trimOut")}<input type="number" min={current?.inSeconds ?? 0} max={selected < ranges.length - 1 ? ranges[selected + 1]!.inSeconds : duration} step="any" required value={fields.segments[selected]?.outSeconds ?? ""} onChange={event => trim("outSeconds", event.target.value)} /></label></div>
          <div className="studio-split-controls"><label className="form-field">{t("splitAt")}<input type="number" min={current?.inSeconds ?? 0} max={current?.outSeconds ?? duration} step="any" value={splitTime} placeholder={time(sourceTime)} onChange={event => setSplitTime(event.target.value)} /></label><button className="button secondary" type="button" disabled={!canSplit} onClick={splitRange}><Scissors size={13} />{t("split")}</button></div>
          <button type="button" className="text-button" disabled={!rangesValid || !current || sourceTime <= current.inSeconds || sourceTime >= current.outSeconds} onClick={() => setSplitTime(String(sourceTime))}>{t("usePlayhead")} · {time(sourceTime)}</button>
          <p className="studio-help">{t(ranges.length >= 32 ? "rangeLimit" : "rangesHelp")}</p>
          <details className="studio-global-settings" open><summary>{t("globalSettings")}</summary>
            <label className="form-field">{t("aspect")}<select value={fields.crop} onChange={event => change({ ...fields, crop: event.target.value as MediaEdit["crop"] })}>{(["original", "vertical", "square"] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
            <label className="form-field">{t("gain")}<input type="number" min={-60} max={24} step="any" required value={fields.gainDb} onChange={event => change({ ...fields, gainDb: event.target.value })} /></label>
            <label className="form-field">{t("caption")}<textarea rows={2} maxLength={2000} value={fields.caption} onChange={event => change({ ...fields, caption: event.target.value })} /></label><p className="studio-help">{t("captionHelp")}</p>
          </details>
          {dirty && !valid && <p className="studio-inline-error" role="alert">{t("invalidRanges")}</p>}
          <div className="studio-edit-actions"><button className="button secondary" type="submit" disabled={!valid || !dirty && !!timeline && timeline.cursor >= 0}>{saving && <LoaderCircle size={13} className="spinning" />}{t("save")}</button>
            <button className="icon-button" type="button" title={t("undo")} aria-label={t("undo")} disabled={!timeline || timeline.cursor < 0 || dirty} onClick={() => { void mutate("undo"); }}><RotateCcw size={16} /></button>
            <button className="icon-button" type="button" title={t("redo")} aria-label={t("redo")} disabled={!timeline || timeline.cursor >= timeline.edits.length - 1 || dirty} onClick={() => { void mutate("redo"); }}><RotateCw size={16} /></button>
          </div>
        </fieldset>
      </form>
      {dirty ? <p className="studio-help" role="status">{t("unsaved")} · {t("saveBeforeExport")}</p> : savedNotice && <p className="studio-saved" role="status"><Check size={12} />{t("saved")}</p>}
      <button className="button primary studio-full-width" disabled={disabled || !timeline || timeline.cursor < 0 || dirty || !valid} onClick={() => { if (timeline && !disabled && !dirty && valid) onExport(timeline.revision); }}><Clapperboard size={15} />{t("export")}</button>
      {timeline && timeline.cursor < 0 && !dirty && <p className="studio-help">{t("noEdits")}</p>}
    </>}
    {!!error && <div className="studio-inline-error" role="alert"><p>{errorText(error)}</p><button className="text-button" disabled={saving || parentBusy} onClick={() => setReload(value => value + 1)}>{t(conflict ? "refreshTimeline" : "retry")}</button></div>}
    <p className="studio-help">{t("sourceSafe")}</p>
  </div>;
}
