import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowDownToLine, Check, CircleAlert, Clapperboard, ExternalLink, FileVideo, Film, FolderOpen, Link2, LoaderCircle, Plus, RefreshCw, RotateCcw, RotateCw, ShieldCheck, Upload, X } from "lucide-react";
import type { WorkspaceAccount, WorkspaceContext } from "../../../packages/domain/src/workspace.js";
import { binaryRequest, mediaBlob, request } from "./api";
import { studioError, studioText, type StudioLanguage, type StudioTranslate } from "./studio-i18n";
import "./studio.css";

export interface StudioArtifact {
  id: string; accountId: string; projectId: string; filename: string; sha256: string; bytes: number; mimeType: string;
  probe: { duration: number; width: number; height: number; hasAudio: boolean } | null;
  sourceId: string | null; channelVideoId: string | null; createdAt: string;
}
export interface StudioPublication {
  id: string; context: WorkspaceContext; revision: 1;
  payload: { version: 1; accountId: string; projectId: string; destinationId: string; artifactId: string; sha256: string; bytes: number; mimeType: string;
    title: string; description: string; visibility: "private" | "unlisted" | "public"; madeForKids: boolean; notifySubscribers: boolean };
  digest: string; state: "review" | "uploading" | "uncertain" | "processing" | "succeeded" | "failed" | "cancelled";
  approvalExpiresAt: string | null; progress: number; videoId: string | null; error: string | null; createdAt: string;
}
export interface StudioRender { id: string; sourceId: string; state: "running" | "succeeded" | "failed" | "cancelled"; progress: number; error: string | null; artifactId: string | null }
interface StudioSnapshot { artifacts: StudioArtifact[]; publications: StudioPublication[]; tools: { available: boolean; ffmpeg: boolean; ffprobe: boolean }; renders: StudioRender[] }
interface Edit { inSeconds: number; outSeconds: number; crop: "original" | "vertical" | "square"; gainDb: number; caption: string }
interface Timeline { revision: number; cursor: number; edits: Edit[] }
interface Catalog { items: { id: string; title: string; publishedAt: string; thumbnail: string | null }[]; nextPageToken: string | null }
export interface StudioProps { context: WorkspaceContext; account: WorkspaceAccount; language: StudioLanguage; errorText: (e: unknown) => string }

const BLOB_LIMIT = 256 * 1024 * 1024;
const pendingPublication = (item: StudioPublication) => item.state === "uploading" || item.state === "processing";
const percent = (value: number) => Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 100);
function seconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const whole = Math.floor(value);
  return `${Math.floor(whole / 60).toString().padStart(2, "0")}:${(whole % 60).toString().padStart(2, "0")}${value % 1 ? `.${Math.floor((value % 1) * 100).toString().padStart(2, "0")}` : ""}`;
}
function bytes(value: number, language: StudioLanguage) { return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value / 1024 / 1024)} MB`; }
function query(context: WorkspaceContext) { return new URLSearchParams({ accountId: context.accountId, projectId: context.projectId ?? "" }).toString(); }
function mediaPath(id: string, suffix: string, context: WorkspaceContext) { return `/api/media/${encodeURIComponent(id)}/${suffix}?${query(context)}`; }
function upsert<T extends { id: string }>(list: T[], value: T): T[] { return list.some(item => item.id === value.id) ? list.map(item => item.id === value.id ? value : item) : [value, ...list]; }
function videoUrl(id: string) { return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`; }

export function Studio(props: StudioProps) {
  const t = studioText(props.language);
  if (!props.context.projectId || props.context.accountId !== props.account.id) return <section className="studio studio-project-empty panel empty-state">
    <div className="empty-icon"><FolderOpen size={25} /></div><h1>{t("chooseProject")}</h1>
    <p>{t(props.context.accountId !== props.account.id ? "scopeMismatch" : "chooseProjectHelp")}</p>
  </section>;
  return <StudioWorkspace key={`${props.context.accountId}:${props.context.projectId}:${props.account.destinationId}`} {...props} />;
}

function StudioWorkspace({ context, account, language, errorText }: StudioProps) {
  const t = studioText(language);
  const translateError = (error: unknown) => studioError(error, t, errorText);
  const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"media" | "publishing" | "channel">("media");
  const [inspector, setInspector] = useState<"publish" | "edit">("publish");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [importing, setImporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<"imported" | "draftCreated" | "downloadReady" | "renderStarted" | "linkedDone" | "cancelledNotice" | null>(null);
  const [approval, setApproval] = useState<StudioPublication | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<unknown>(null);
  const catalogBusyRef = useRef(false);
  const lifetime = useRef(new AbortController());
  const refreshAbort = useRef<AbortController | null>(null);
  const refreshSequence = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const focusReturn = useRef<HTMLElement | null>(null);
  const downloadUrls = useRef(new Set<string>());
  const downloadTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const baseQuery = query(context);
  const scope = { accountId: context.accountId, projectId: context.projectId };
  const connected = account.platform === "youtube" && account.status === "connected";
  const selected = snapshot?.artifacts.find(item => item.id === selectedId) ?? null;
  const uniqueId = useId();

  const refresh = useCallback(async () => {
    refreshAbort.current?.abort();
    const abort = new AbortController(); refreshAbort.current = abort;
    const sequence = ++refreshSequence.current;
    setRefreshing(true);
    try {
      const result = await request<StudioSnapshot>(`/api/studio?${baseQuery}`, "GET", undefined, abort.signal);
      if (abort.signal.aborted || lifetime.current.signal.aborted || sequence !== refreshSequence.current) return;
      setSnapshot(result); setLoadError(null);
      setSelectedId(current => current && result.artifacts.some(item => item.id === current) ? current : result.artifacts[0]?.id ?? null);
      setApproval(current => current ? result.publications.find(item => item.id === current.id && item.state === "review") ?? null : null);
    } catch (failure) { if (!abort.signal.aborted && !lifetime.current.signal.aborted) setLoadError(failure); }
    finally { if (sequence === refreshSequence.current && !lifetime.current.signal.aborted) setRefreshing(false); }
  }, [baseQuery]);

  useEffect(() => {
    lifetime.current = new AbortController();
    void refresh();
    return () => {
      lifetime.current.abort(); refreshAbort.current?.abort();
      for (const url of downloadUrls.current) URL.revokeObjectURL(url);
      for (const timer of downloadTimers.current) clearTimeout(timer);
    };
  }, [refresh]);
  const pending = !!snapshot && (snapshot.publications.some(pendingPublication) || snapshot.renders.some(item => item.state === "running"));
  useEffect(() => {
    if (!pending || busy) return;
    const timer = setTimeout(() => { void refresh(); }, loadError ? 6000 : 2000);
    return () => clearTimeout(timer);
  }, [pending, busy, snapshot, loadError, refresh]);

  async function act(action: (signal: AbortSignal) => Promise<void>) {
    if (busyRef.current || lifetime.current.signal.aborted) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    refreshAbort.current?.abort(); ++refreshSequence.current; setRefreshing(false);
    const signal = lifetime.current.signal;
    try { await action(signal); }
    catch (failure) { if (!signal.aborted) { setError(failure); await refresh(); } }
    finally { if (!signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  function updatePublication(value: StudioPublication) {
    setSnapshot(current => current ? { ...current, publications: upsert(current.publications, value) } : current);
  }
  function updateRender(value: StudioRender) {
    setSnapshot(current => current ? { ...current, renders: upsert(current.renders, value) } : current);
  }
  function selectArtifact(id: string) { setSelectedId(id); setTab("media"); }
  function importFile(file: File) {
    void act(async signal => {
      setImporting(true);
      try {
        const artifact = await binaryRequest<StudioArtifact>(`/api/media/import?${baseQuery}&filename=${encodeURIComponent(file.name)}`, file, signal);
        if (signal.aborted) return;
        setSnapshot(current => current ? { ...current, artifacts: upsert(current.artifacts, artifact) } : current);
        setSelectedId(artifact.id); setTab("media"); setNotice("imported");
        await refresh();
      } finally { if (!signal.aborted) setImporting(false); }
    });
  }
  function download(artifact: StudioArtifact) {
    if (artifact.bytes > BLOB_LIMIT) return;
    void act(async signal => {
      const blob = await mediaBlob(mediaPath(artifact.id, "content", scope), signal);
      if (signal.aborted) return;
      if (blob.size > BLOB_LIMIT) throw { code: "studio_blob_limit" };
      const url = URL.createObjectURL(blob); downloadUrls.current.add(url);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.filename; document.body.append(anchor); anchor.click(); anchor.remove();
      const timer = setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.current.delete(url); downloadTimers.current.delete(timer); }, 1000);
      downloadTimers.current.add(timer); setNotice("downloadReady");
    });
  }
  async function loadCatalog(more = false) {
    if (!connected || catalogBusyRef.current) return;
    catalogBusyRef.current = true; setCatalogBusy(true); setCatalogError(null);
    const signal = lifetime.current.signal;
    try {
      const params = new URLSearchParams({ accountId: account.id, destinationId: account.destinationId });
      if (more && catalog?.nextPageToken) params.set("pageToken", catalog.nextPageToken);
      const result = await request<Catalog>(`/api/youtube/catalog?${params}`, "GET", undefined, signal);
      if (!signal.aborted) setCatalog(current => more && current ? { ...result, items: [...current.items, ...result.items.filter(item => !current.items.some(old => old.id === item.id))] } : result);
    } catch (failure) { if (!signal.aborted) setCatalogError(failure); }
    finally { if (!signal.aborted) { catalogBusyRef.current = false; setCatalogBusy(false); } }
  }
  function publicationAction(item: StudioPublication, action: "cancel" | "reconcile") {
    void act(async signal => {
      const result = await request<StudioPublication>(`/api/publications/${encodeURIComponent(item.id)}/${action}`, "POST", { context: scope }, signal);
      if (signal.aborted) return;
      updatePublication(result); if (action === "cancel") setNotice("cancelledNotice");
    });
  }
  const tools = snapshot?.tools;

  return <div className="studio">
    <header className="studio-heading">
      <div><p className="eyebrow">{t("studio")}</p><h1>{t("studioTitle")}</h1><p>{t("subtitle")}</p></div>
      <div className="studio-heading-actions"><span className="studio-count">{snapshot ? snapshot.artifacts.length : "—"} {t(snapshot?.artifacts.length === 1 ? "mediaCountOne" : "mediaCount")}</span>
        <button className="button primary" disabled={busy || !snapshot} onClick={() => input.current?.click()}>{importing ? <LoaderCircle size={16} className="spinning" /> : <Plus size={16} />}{t(importing ? "importing" : "import")}</button>
        <input ref={input} className="studio-file-input" type="file" accept=".mp4,.mov,.webm,.mkv" aria-label={t("import")} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) importFile(file); }} />
      </div>
    </header>
    <div className="studio-nav"><div className="studio-tabs" role="tablist" aria-label={t("studio")}>
      {(["media", "publishing", "channel"] as const).map(name => <button key={name} role="tab" type="button" id={`${uniqueId}-${name}`} aria-selected={tab === name} aria-controls={`${uniqueId}-panel-${name}`} tabIndex={tab === name ? 0 : -1}
        onKeyDown={event => { const tabs = ["media", "publishing", "channel"] as const; const index = tabs.indexOf(name); const next = event.key === "ArrowRight" ? tabs[(index + 1) % 3] : event.key === "ArrowLeft" ? tabs[(index + 2) % 3] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[2] : null; if (next) { event.preventDefault(); setTab(next); document.getElementById(`${uniqueId}-${next}`)?.focus(); } }}
        onClick={() => setTab(name)}>{t(name)}{name === "publishing" && !!snapshot?.publications.filter(item => item.state === "review" || item.state === "uncertain").length && <span className="count">{snapshot.publications.filter(item => item.state === "review" || item.state === "uncertain").length}</span>}</button>)}
    </div><button className="icon-button" aria-label={t("refresh")} title={t("refresh")} disabled={busy || refreshing} onClick={() => { void refresh(); }}><RefreshCw size={15} className={refreshing ? "spinning" : ""} /></button></div>
    {!!loadError && <div className="studio-alert" role="alert"><CircleAlert size={16} /><span>{translateError(loadError)}</span><button className="text-button" disabled={refreshing || busy} onClick={() => { void refresh(); }}>{t("retry")}</button></div>}
    {!!error && !approval && <div className="studio-alert" role="alert"><CircleAlert size={16} /><span>{translateError(error)}</span><button className="icon-button" onClick={() => setError(null)} aria-label={t("close")}><X size={14} /></button></div>}
    {notice && <p className="studio-notice" role="status"><Check size={14} />{t(notice)}</p>}
    {!snapshot ? !loadError && <div className="loading-state" role="status"><LoaderCircle className="spinning" />{t("loading")}</div> : <>
      <section role="tabpanel" id={`${uniqueId}-panel-media`} aria-labelledby={`${uniqueId}-media`} hidden={tab !== "media"}>
        <div className="studio-workbench">
          <aside className="studio-library"><div className="studio-pane-heading"><h2>{t("library")}</h2><span className="count">{snapshot.artifacts.length}</span></div>
            {snapshot.artifacts.length ? <ul className="studio-files">{snapshot.artifacts.map(item => <li key={item.id}><button className={`studio-file ${item.id === selectedId ? "is-selected" : ""}`} aria-pressed={item.id === selectedId} onClick={() => setSelectedId(item.id)}>
              <span className="studio-file-icon"><FileVideo size={19} /></span><span className="studio-file-copy"><strong title={item.filename}>{item.filename}</strong><small>{item.probe ? seconds(item.probe.duration) : bytes(item.bytes, language)} · {t(item.sourceId ? "exported" : "source")}</small></span>{item.channelVideoId && <Link2 size={12} aria-label={t("linked")} />}
            </button></li>)}</ul> : <div className="studio-library-empty"><Film size={22} /><p>{t("emptyLibraryHelp")}</p></div>}
          </aside>
          <div className="studio-canvas">
            {selected ? <><Preview key={selected.id} artifact={selected} context={scope} t={t} errorText={translateError} active={tab === "media"} />
              <div className="studio-preview-caption"><div><h2>{selected.filename}</h2><p>{selected.probe ? `${seconds(selected.probe.duration)} · ${selected.probe.width} × ${selected.probe.height}${selected.probe.hasAudio ? "" : ` · ${t("noAudio")}`}` : t("noProbe")} · {bytes(selected.bytes, language)}</p></div>
                <button className="icon-button" aria-label={t("download")} title={t("download")} disabled={busy || selected.bytes > BLOB_LIMIT} onClick={() => download(selected)}><ArrowDownToLine size={17} /></button></div>
              <details className="studio-file-details"><summary>{t("hash")}</summary><code>{selected.sha256}</code></details>
              <RenderList renders={snapshot.renders.filter(item => item.sourceId === selected.id)} artifacts={snapshot.artifacts} t={t} busy={busy} errorText={translateError} open={selectArtifact} cancel={item => { void act(async signal => { const value = await request<StudioRender>(`/api/renders/${encodeURIComponent(item.id)}/cancel`, "POST", { context: scope }, signal); if (!signal.aborted) updateRender(value); }); }} />
            </> : <div className="studio-preview-empty"><div className="studio-empty-frame"><Clapperboard size={38} strokeWidth={1.2} /></div><h2>{t(snapshot.artifacts.length ? "selectMedia" : "emptyLibrary")}</h2><p>{t(snapshot.artifacts.length ? "selectMediaHelp" : "emptyLibraryHelp")}</p>{!snapshot.artifacts.length && <button className="button secondary" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} />{t("import")}</button>}</div>}
          </div>
          <aside className="studio-inspector"><div className="studio-segmented" role="tablist" aria-label={selected?.filename ?? t("selectMedia")}>
            {(["publish", "edit"] as const).map(name => <button key={name} role="tab" aria-selected={inspector === name} id={`${uniqueId}-${name}`} aria-controls={`${uniqueId}-inspector-${name}`} tabIndex={inspector === name ? 0 : -1}
              onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "publish" : event.key === "End" ? "edit" : name === "publish" ? "edit" : "publish"; setInspector(next); document.getElementById(`${uniqueId}-${next}`)?.focus(); } }} onClick={() => setInspector(name)}>{t(name)}</button>)}
          </div>{selected ? <>
            <div role="tabpanel" id={`${uniqueId}-inspector-publish`} aria-labelledby={`${uniqueId}-publish`} hidden={inspector !== "publish"}><PublishForm key={selected.id} artifact={selected} account={account} t={t} busy={busy} connected={connected} submit={fields => {
              void act(async signal => { const result = await request<StudioPublication>("/api/publications", "POST", { context: scope, artifactId: selected.id, ...fields }, signal); if (signal.aborted) return; updatePublication(result); setTab("publishing"); setNotice("draftCreated"); });
            }} /></div>
            <div role="tabpanel" id={`${uniqueId}-inspector-edit`} aria-labelledby={`${uniqueId}-edit`} hidden={inspector !== "edit"}><EditPanel key={selected.id} artifact={selected} context={scope} tools={snapshot.tools} t={t} errorText={translateError} parentBusy={busy} onExport={expectedRevision => {
              void act(async signal => { const value = await request<StudioRender>(`/api/media/${encodeURIComponent(selected.id)}/render`, "POST", { context: scope, expectedRevision }, signal); if (!signal.aborted) { updateRender(value); setNotice("renderStarted"); } });
            }} /></div>
          </> : <p className="studio-inspector-empty">{t("selectMediaHelp")}</p>}</aside>
        </div>
        {tools && <div className="studio-footnote"><span><ShieldCheck size={13} />{t("sourceSafe")}</span><span>{t("ffmpeg")}: {t(tools.ffmpeg ? "available" : "unavailable")} · {t("ffprobe")}: {t(tools.ffprobe ? "available" : "unavailable")}</span></div>}
      </section>
      <section role="tabpanel" id={`${uniqueId}-panel-publishing`} aria-labelledby={`${uniqueId}-publishing`} hidden={tab !== "publishing"}>
        {!snapshot.publications.length ? <div className="studio-panel empty-state"><div className="empty-icon"><Upload size={24} /></div><h2>{t("noPublications")}</h2><p>{t("noPublicationsHelp")}</p><button className="button secondary" onClick={() => setTab("media")}>{t("media")}</button></div>
          : <div className="studio-publications">{snapshot.publications.map(item => <article key={item.id} className="studio-publication">
            <div className="studio-publication-main"><span className={`studio-state state-${item.state}`}>{t(item.state)}</span><h2>{item.payload.title}</h2><p className="studio-target">{t("channelId")} <code>{item.payload.destinationId}</code> · {t(item.payload.visibility)}</p><p className="studio-publication-file">{snapshot.artifacts.find(file => file.id === item.payload.artifactId)?.filename ?? item.payload.artifactId} · {bytes(item.payload.bytes, language)}</p>
              {pendingPublication(item) && <Progress value={item.progress} label={t(item.state)} />}
              {item.state === "uncertain" && <p className="studio-help">{t("reconcileHelp")}</p>}
              {item.error && <p className="studio-inline-error">{translateError(item.error)}</p>}
              {item.videoId && <a className="text-button studio-provider-link" href={videoUrl(item.videoId)} target="_blank" rel="noreferrer"><ExternalLink size={13} />{t("openYouTube")}</a>}
            </div><div className="studio-publication-actions">
              {item.state === "review" && <button className="button primary" disabled={busy || !connected} onClick={() => { focusReturn.current = document.activeElement as HTMLElement; setError(null); setApproval(item); }}><ShieldCheck size={15} />{t("reviewApprove")}</button>}
              {item.state === "uncertain" && <button className="button secondary" disabled={busy || !connected} onClick={() => publicationAction(item, "reconcile")}><RefreshCw size={14} />{t("reconcile")}</button>}
              {["review", "uploading", "uncertain"].includes(item.state) && <button className="text-button" disabled={busy} onClick={() => publicationAction(item, "cancel")}>{t("cancel")}</button>}
            </div>
          </article>)}</div>}
      </section>
      <section role="tabpanel" id={`${uniqueId}-panel-channel`} aria-labelledby={`${uniqueId}-channel`} hidden={tab !== "channel"}>
        <div className="studio-channel-heading"><div><h2>{t("channelTitle")}</h2><p>{t("channelHelp")}</p><code>{account.destinationId}</code></div><button className="button secondary" disabled={!connected || catalogBusy} onClick={() => { void loadCatalog(); }}><RefreshCw size={14} className={catalogBusy ? "spinning" : ""} />{t("refresh")}</button></div>
        {!connected ? <div className="studio-callout"><CircleAlert size={17} /><p>{t(account.platform === "youtube" ? "connectRequired" : "unsupported")}</p></div> : <>
          <div className="studio-link-scope"><span>{t("selectedFile")}</span><strong>{selected?.filename ?? t("selectToLink")}</strong><p>{t("linkHelp")}</p></div>
          {!!catalogError && <div className="studio-alert" role="alert"><CircleAlert size={15} /><span>{translateError(catalogError)}</span><button className="text-button" disabled={catalogBusy} onClick={() => { void loadCatalog(); }}>{t("retry")}</button></div>}
          {!catalog ? <p className="studio-catalog-empty" role="status">{t(catalogBusy ? "loading" : "catalogNotLoaded")}</p> : !catalog.items.length ? <p className="studio-catalog-empty">{t("catalogEmpty")}</p> : <ul className="studio-catalog">{catalog.items.map(item => <li key={item.id}>
            {safeThumbnail(item.thumbnail) ? <img src={item.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="studio-catalog-icon"><FileVideo size={23} /></span>}
            <div><a href={videoUrl(item.id)} target="_blank" rel="noreferrer"><strong>{item.title}</strong><ExternalLink size={12} /></a><time dateTime={item.publishedAt}>{new Date(item.publishedAt).toLocaleDateString(language)}</time></div>
            <button className="button secondary" disabled={busy || !selected || selected.channelVideoId === item.id} onClick={() => { if (!selected) return; void act(async signal => {
              await request(mediaPath(selected.id, "link", scope).split("?")[0]!, "POST", { context: scope, videoId: item.id }, signal); if (signal.aborted) return; setNotice("linkedDone"); await refresh();
            }); }}><Link2 size={14} />{t(selected?.channelVideoId === item.id ? "linked" : "linkVideo")}</button>
          </li>)}</ul>}
          {catalog?.nextPageToken && <button className="button secondary studio-load-more" disabled={catalogBusy} onClick={() => { void loadCatalog(true); }}>{catalogBusy && <LoaderCircle size={14} className="spinning" />}{t("loadMore")}</button>}
        </>}
      </section>
    </>}
    <Dialog.Root open={!!approval} onOpenChange={open => { if (!open && !busy) setApproval(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content studio-approval" onCloseAutoFocus={event => { event.preventDefault(); if (focusReturn.current?.isConnected) focusReturn.current.focus(); else document.getElementById(`${uniqueId}-publishing`)?.focus(); }}
        onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
        <Dialog.Title>{t("approvalTitle")}</Dialog.Title><Dialog.Description>{t("approvalHelp")}</Dialog.Description><Dialog.Close className="icon-button dialog-close" disabled={busy} aria-label={t("close")}><X size={18} /></Dialog.Close>
        {approval && <><ApprovalDetails publication={approval} artifact={snapshot?.artifacts.find(item => item.id === approval.payload.artifactId) ?? null} t={t} language={language} />
          <p className="studio-help">{t("immutableHelp")}</p>{!!error && <p className="form-error" role="alert">{translateError(error)}</p>}
          <ApprovalActions publication={approval} t={t} busy={busy} connected={connected} back={() => setApproval(null)} approve={() => { void act(async signal => {
            const result = await request<StudioPublication>(`/api/publications/${encodeURIComponent(approval.id)}/approve`, "POST", { context: scope, digest: approval.digest }, signal);
            if (signal.aborted) return; updatePublication(result); setApproval(null);
          }); }} />
        </>}
      </Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}

function safeThumbnail(value: string | null): value is string { try { if (!value) return false; const url = new URL(value); return url.protocol === "https:" && ["i.ytimg.com", "img.youtube.com"].includes(url.hostname); } catch { return false; } }

function Preview({ artifact, context, t, errorText, active }: { artifact: StudioArtifact; context: WorkspaceContext; t: StudioTranslate; errorText: (e: unknown) => string; active: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [playError, setPlayError] = useState(false);
  const [retry, setRetry] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const path = mediaPath(artifact.id, "content", context);
  useEffect(() => {
    if (artifact.bytes > BLOB_LIMIT) return;
    const abort = new AbortController(); let objectUrl: string | null = null;
    setUrl(null); setError(null); setPlayError(false);
    void mediaBlob(path, abort.signal).then((blob: Blob) => {
      if (abort.signal.aborted) return;
      if (blob.size > BLOB_LIMIT) throw { code: "studio_blob_limit" };
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch((failure: unknown) => { if (!abort.signal.aborted) setError(failure); });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path, artifact.bytes, retry]);
  useEffect(() => { if (!active) video.current?.pause(); }, [active]);
  return <div className="studio-preview" aria-label={t("preview")}>
    {artifact.bytes > BLOB_LIMIT ? <div className="studio-preview-message"><FileVideo size={28} /><p>{t("previewLimit")}</p></div>
      : error ? <div className="studio-preview-message" role="alert"><CircleAlert size={24} /><p>{errorText(error)}</p><button className="button secondary" onClick={() => setRetry(value => value + 1)}>{t("retry")}</button></div>
      : url ? <><video ref={video} src={url} controls preload="metadata" aria-label={artifact.filename} onError={() => setPlayError(true)} />{playError && <p className="studio-player-error" role="alert">{t("previewFailed")}</p>}</>
      : <div className="studio-preview-message" role="status"><LoaderCircle size={24} className="spinning" /><p>{t("previewLoading")}</p></div>}
  </div>;
}

interface PublishFields { title: string; description: string; visibility: "private" | "unlisted" | "public"; madeForKids: boolean; notifySubscribers: boolean }
function PublishForm({ artifact, account, t, busy, connected, submit }: { artifact: StudioArtifact; account: WorkspaceAccount; t: StudioTranslate; busy: boolean; connected: boolean; submit: (fields: PublishFields) => void }) {
  const [fields, setFields] = useState<PublishFields>({ title: artifact.filename.replace(/\.[^.]+$/, "").slice(0, 100), description: "", visibility: "private", madeForKids: false, notifySubscribers: false });
  function send(event: FormEvent) { event.preventDefault(); if (connected && !busy && fields.title.trim()) submit({ ...fields, title: fields.title.trim() }); }
  return <form className="studio-inspector-form" onSubmit={send}>
    <div className="studio-destination"><span>{t("destination")}</span><strong>{account.displayName}</strong><code>{account.destinationId}</code></div>
    {!connected && <p className="studio-callout">{t(account.platform === "youtube" ? "connectRequired" : "unsupported")}</p>}
    <label className="form-field">{t("title")}<input value={fields.title} required maxLength={100} disabled={busy} onChange={event => setFields(current => ({ ...current, title: event.target.value }))} /></label>
    <label className="form-field">{t("description")}<textarea rows={4} maxLength={5000} value={fields.description} disabled={busy} onChange={event => setFields(current => ({ ...current, description: event.target.value }))} /></label>
    <label className="form-field">{t("visibility")}<select value={fields.visibility} disabled={busy} onChange={event => setFields(current => ({ ...current, visibility: event.target.value as PublishFields["visibility"] }))}>{(["private", "unlisted", "public"] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
    <label className="studio-checkbox"><input type="checkbox" checked={fields.madeForKids} disabled={busy} onChange={event => setFields(current => ({ ...current, madeForKids: event.target.checked }))} />{t("madeForKids")}</label>
    <label className="studio-checkbox"><input type="checkbox" checked={fields.notifySubscribers} disabled={busy} onChange={event => setFields(current => ({ ...current, notifySubscribers: event.target.checked }))} />{t("notifySubscribers")}</label>
    <button className="button primary studio-full-width" disabled={busy || !connected || !fields.title.trim()} type="submit"><ShieldCheck size={15} />{t("createDraft")}</button><p className="studio-help">{t("draftHelp")}</p>
  </form>;
}

type EditFields = { inSeconds: string; outSeconds: string; crop: Edit["crop"]; gainDb: string; caption: string };
const toFields = (edit: Edit): EditFields => ({ ...edit, inSeconds: String(edit.inSeconds), outSeconds: String(edit.outSeconds), gainDb: String(edit.gainDb) });
function EditPanel({ artifact, context, tools, t, errorText, parentBusy, onExport }: { artifact: StudioArtifact; context: WorkspaceContext; tools: StudioSnapshot["tools"]; t: StudioTranslate; errorText: (e: unknown) => string; parentBusy: boolean; onExport: (expectedRevision: number) => void }) {
  const duration = artifact.probe?.duration ?? 0;
  const defaults: Edit = { inSeconds: 0, outSeconds: duration, crop: "original", gainDb: 0, caption: "" };
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [fields, setFields] = useState<EditFields>(() => toFields(defaults));
  const [baseline, setBaseline] = useState(() => JSON.stringify(toFields(defaults)));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);
  const abortRef = useRef(new AbortController());
  const path = mediaPath(artifact.id, "timeline", context);
  const dirty = baseline !== JSON.stringify(fields);
  const disabled = loading || saving || parentBusy || !tools.available || !duration || conflict;
  function accept(value: Timeline) {
    const next = toFields(value.edits[value.cursor] ?? defaults);
    setTimeline(value); setFields(next); setBaseline(JSON.stringify(next)); setConflict(false);
  }
  useEffect(() => {
    const abort = new AbortController(); abortRef.current = abort;
    setLoading(true); setError(null);
    void request<Timeline>(path, "GET", undefined, abort.signal).then(value => {
      if (!abort.signal.aborted) accept(value);
    }).catch(failure => { if (!abort.signal.aborted) setError(failure); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [path, reload]);
  const edit: Edit = { inSeconds: Number(fields.inSeconds), outSeconds: Number(fields.outSeconds), crop: fields.crop, gainDb: Number(fields.gainDb), caption: fields.caption };
  const valid = fields.inSeconds.trim() !== "" && fields.outSeconds.trim() !== "" && fields.gainDb.trim() !== "" && Number.isFinite(edit.inSeconds) && Number.isFinite(edit.outSeconds) && Number.isFinite(edit.gainDb) && edit.inSeconds >= 0 && edit.outSeconds > edit.inSeconds && edit.outSeconds <= duration && edit.gainDb >= -60 && edit.gainDb <= 24;
  function change(key: keyof EditFields, value: string) { setSavedNotice(false); setFields(current => ({ ...current, [key]: value })); }
  async function mutate(action: "save" | "undo" | "redo") {
    if (!timeline || busyRef.current || disabled) return;
    if (action === "save" && !valid) return;
    busyRef.current = true; setSaving(true); setError(null); setSavedNotice(false);
    const signal = abortRef.current.signal;
    try {
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
  const start = valid && duration ? edit.inSeconds / duration * 100 : 0;
  const end = valid && duration ? edit.outSeconds / duration * 100 : 0;
  return <div className="studio-inspector-form">
    {!tools.available && <div className="studio-callout"><strong>{t("toolsMissing")}</strong><p>{t("toolsHelp")}</p></div>}
    {!duration && <p className="studio-help">{t("durationRequired")}</p>}
    {loading ? <p className="studio-help" role="status">{t("loading")}</p> : <>
      <form onSubmit={event => { event.preventDefault(); void mutate("save"); }}>
        <fieldset className="studio-editor-fields" disabled={disabled || !timeline}><legend>{t("editorTitle")}</legend>
          <div className="studio-form-pair"><label className="form-field">{t("trimIn")}<input type="number" min={0} max={duration} step="any" required value={fields.inSeconds} onChange={event => change("inSeconds", event.target.value)} /></label>
            <label className="form-field">{t("trimOut")}<input type="number" min={0} max={duration} step="any" required value={fields.outSeconds} onChange={event => change("outSeconds", event.target.value)} /></label></div>
          <div className="studio-timeline" aria-label={`${t("timeline")}: ${seconds(duration)}; ${t("selectedRange")}: ${valid ? `${seconds(edit.inSeconds)}–${seconds(edit.outSeconds)}` : "—"}`} role="img">
            <div className="studio-timeline-track"><span style={{ left: `${start}%`, width: `${end - start}%` }} /></div><div className="studio-timeline-times"><span>00:00</span><span>{seconds(duration)}</span></div>
          </div><p className="studio-help">{t("trimHelp")}</p>
          <label className="form-field">{t("aspect")}<select value={fields.crop} onChange={event => change("crop", event.target.value)}>{(["original", "vertical", "square"] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
          <label className="form-field">{t("gain")}<input type="number" min={-60} max={24} step="any" required value={fields.gainDb} onChange={event => change("gainDb", event.target.value)} /></label>
          <label className="form-field">{t("caption")}<textarea rows={3} maxLength={2000} value={fields.caption} onChange={event => change("caption", event.target.value)} /></label><p className="studio-help">{t("captionHelp")}</p>
          {dirty && !valid && <p className="studio-inline-error">{t("invalidTrim")}</p>}
          <div className="studio-edit-actions"><button className="button secondary" type="submit" disabled={!valid || !dirty && !!timeline?.edits.length}>{saving && <LoaderCircle size={13} className="spinning" />}{t("save")}</button>
            <button className="icon-button" type="button" title={t("undo")} aria-label={t("undo")} disabled={!timeline || timeline.cursor < 0 || dirty} onClick={() => { void mutate("undo"); }}><RotateCcw size={16} /></button>
            <button className="icon-button" type="button" title={t("redo")} aria-label={t("redo")} disabled={!timeline || timeline.cursor >= timeline.edits.length - 1 || dirty} onClick={() => { void mutate("redo"); }}><RotateCw size={16} /></button>
          </div>
        </fieldset>
      </form>
      {dirty ? <p className="studio-help">{t("unsaved")} · {t("saveBeforeExport")}</p> : savedNotice && <p className="studio-saved" role="status"><Check size={12} />{t("saved")}</p>}
      <button className="button primary studio-full-width" disabled={disabled || !timeline || timeline.cursor < 0 || dirty} onClick={() => { if (timeline) onExport(timeline.revision); }}><Clapperboard size={15} />{t("export")}</button>
      {timeline && timeline.cursor < 0 && !dirty && <p className="studio-help">{t("noEdits")}</p>}
    </>}
    {!!error && <div className="studio-inline-error" role="alert"><p>{errorText(error)}</p><button className="text-button" disabled={saving || parentBusy} onClick={() => setReload(value => value + 1)}>{t(conflict ? "refreshTimeline" : "retry")}</button></div>}
    <p className="studio-help">{t("sourceSafe")}</p>
  </div>;
}

function Progress({ value, label }: { value: number; label: string }) { return <div className="studio-progress"><progress max={100} value={percent(value)} aria-label={label} /><span>{percent(value)}%</span></div>; }
function RenderList({ renders, artifacts, t, busy, errorText, open, cancel }: { renders: StudioRender[]; artifacts: StudioArtifact[]; t: StudioTranslate; busy: boolean; errorText: (e: unknown) => string; open: (id: string) => void; cancel: (render: StudioRender) => void }) {
  if (!renders.length) return null;
  return <section className="studio-renders"><h3>{t("renderJobs")}</h3>{renders.map(item => <div className="studio-render" key={item.id}>
    <div className="studio-render-heading"><span className={`studio-state state-${item.state}`}>{item.state === "running" && <LoaderCircle size={12} className="spinning" />}{t(item.state)}</span>{item.state === "running" && <button className="text-button" disabled={busy} onClick={() => cancel(item)}>{t("cancel")}</button>}</div>
    {item.state === "running" && <Progress value={item.progress} label={t("running")} />}
    {item.error && <p className="studio-inline-error">{errorText(item.error)}</p>}
    {item.state === "succeeded" && item.artifactId && artifacts.some(artifact => artifact.id === item.artifactId) && <button className="text-button" onClick={() => { if (item.artifactId) open(item.artifactId); }}>{t("openExport")}</button>}
  </div>)}</section>;
}

function ApprovalDetails({ publication, artifact, t, language }: { publication: StudioPublication; artifact: StudioArtifact | null; t: StudioTranslate; language: StudioLanguage }) {
  const payload = publication.payload;
  return <dl className="studio-approval-details">
    <div><dt>{t("channelId")}</dt><dd><code>{payload.destinationId}</code></dd></div>
    <div><dt>{t("filename")}</dt><dd>{artifact?.filename ?? payload.artifactId}</dd></div>
    <div><dt>{t("size")}</dt><dd>{bytes(payload.bytes, language)} · {payload.mimeType}</dd></div>
    <div><dt>{t("hash")}</dt><dd><code>{payload.sha256}</code></dd></div>
    <div><dt>{t("title")}</dt><dd>{payload.title}</dd></div>
    <div><dt>{t("description")}</dt><dd className="studio-approval-description">{payload.description || "—"}</dd></div>
    <div><dt>{t("visibility")}</dt><dd>{t(payload.visibility)}</dd></div>
    <div><dt>{t("madeForKids")}</dt><dd>{t(payload.madeForKids ? "yes" : "no")}</dd></div>
    <div><dt>{t("notifySubscribers")}</dt><dd>{t(payload.notifySubscribers ? "yes" : "no")}</dd></div>
    <div><dt>{t("digest")}</dt><dd><code>{publication.digest}</code></dd></div>
    {publication.approvalExpiresAt && <div><dt>{t("approvalExpires")}</dt><dd><time dateTime={publication.approvalExpiresAt}>{new Date(publication.approvalExpiresAt).toLocaleString(language)}</time></dd></div>}
  </dl>;
}
function ApprovalActions({ publication, t, busy, connected, back, approve }: { publication: StudioPublication; t: StudioTranslate; busy: boolean; connected: boolean; back: () => void; approve: () => void }) {
  const [now, setNow] = useState(Date.now());
  const expiry = publication.approvalExpiresAt ? Date.parse(publication.approvalExpiresAt) : null;
  useEffect(() => {
    if (expiry === null || !Number.isFinite(expiry)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.max(0, expiry - Date.now()) + 50));
    return () => clearTimeout(timer);
  }, [expiry]);
  const expired = expiry !== null && expiry <= now;
  return <>{expired && <p className="studio-inline-error" role="alert">{t("reviewExpired")}</p>}<div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={back}>{t("back")}</button><button className="button primary" disabled={busy || !connected || expired} onClick={approve}>{busy ? <LoaderCircle size={15} className="spinning" /> : <ShieldCheck size={15} />}{t("approveUpload")}</button></div></>;
}
