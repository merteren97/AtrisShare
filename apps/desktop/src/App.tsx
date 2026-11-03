import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, BrainCircuit, Check, ChevronRight, CircleAlert, Database, Clapperboard, FolderKanban, HardDrive,
  CalendarClock, Send, LoaderCircle, NotebookPen, Plus, RefreshCw, Scissors, Search, Settings2, ShieldCheck, UsersRound, X } from "lucide-react";
import type { WorkspaceAccount, WorkspaceContext, WorkspaceMemory, WorkspaceProject } from "../../../packages/domain/src/workspace.js";
import { ApiError, request } from "./api";
import { dictionaries, kindKeys, type Language, type TextKey } from "./i18n";
import { useWorkspace } from "./use-workspace";
import { Accounts, accountStatusKey, PlatformIcon } from "./Accounts";
import { Titlebar } from "./Titlebar";
import { Studio } from "./Studio";
import { SocialPanel } from "./SocialPanel";
import { QueuePanel } from "./QueuePanel";
import { NativeSettings } from "./NativeSettings";
import { MemoryExport } from "./MemoryExport";
import { MediaToolSettings } from "./MediaToolSettings";
import { AppUpdater } from "./AppUpdater";
import { notifyDue, onNativeOpenQueue } from "./native-desktop";
import type { Occurrence } from "../../../packages/domain/src/scheduling.js";

type Page = "studio" | "social" | "queue" | "workspace" | "memory" | "accounts" | "settings";
type Modal = { type: "project" } | { type: "memory" | "delete"; entry: WorkspaceMemory | null };
const platformNames = { youtube: "YouTube", x: "X", tiktok: "TikTok", linkedin: "LinkedIn", local: "Local" };
const nav = [{ id: "studio", icon: Clapperboard }, { id: "social", icon: Send }, { id: "queue", icon: CalendarClock }, { id: "workspace", icon: FolderKanban }, { id: "memory", icon: BrainCircuit },
  { id: "accounts", icon: UsersRound }, { id: "settings", icon: Settings2 }] as const;

function preference(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function remember(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Preferences remain available in memory. */ }
}
function Empty({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h2>{title}</h2><p>{description}</p>{action}</div>;
}
function MemoryCard({ entry, t, date, onEdit, onDelete }: {
  entry: WorkspaceMemory; t: (key: TextKey) => string; date: (value: string) => string;
  onEdit: (entry: WorkspaceMemory) => void; onDelete: (entry: WorkspaceMemory) => void;
}) {
  return <article className="memory-card">
    <div className="memory-card-top"><span className="category-label">{t(kindKeys[entry.kind])}</span>
      <span className={`badge ${entry.reviewState === "confirmed" ? "positive" : "suggested"}`}>{entry.reviewState === "confirmed" && <Check size={11} />}{t(entry.reviewState)}</span></div>
    <p className="note-content">{entry.text}</p>
    <div className="memory-meta"><span>{t("manual")} · {date(entry.updatedAt)}</span><span>{t("revision")} {entry.revision}</span></div>
    <details className="provenance"><summary>{t("source")}</summary><span>{entry.provenance.sourceId}</span><time dateTime={entry.provenance.recordedAt}>{date(entry.provenance.recordedAt)}</time></details>
    <div className="card-actions"><button className="text-button" onClick={() => onEdit(entry)}>{t("edit")}</button>
      <button className="text-button danger-text" onClick={() => onDelete(entry)}>{t("delete")}</button></div>
  </article>;
}

export function App() {
  const [language, setLanguage] = useState<Language>(() => preference("atris-share-language", "tr") === "en" ? "en" : "tr");
  const [theme, setTheme] = useState(() => preference("atris-share-theme", "dark") === "light" ? "light" : "dark");
  const [page, setPage] = useState<Page>("studio");
  const [studioTab, setStudioTab] = useState<"media" | "publishing">("media");
  const [modal, setModal] = useState<Modal | null>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);
  const [notice, setNotice] = useState<TextKey | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [review, setReview] = useState("");
  const [dueReviews, setDueReviews] = useState<Occurrence[]>([]);
  const dueRef = useRef<Occurrence[]>([]);
  const returnFocus = useRef<HTMLElement | null>(null);
  const focusTools = useRef(false);
  const ws = useWorkspace();
  const t = (key: TextKey) => dictionaries[language][key];
  const state = ws.snapshot;
  const context = state?.context ?? null;
  const account = state?.accounts.find(item => item.id === context?.accountId);
  const project = state?.projects.find(item => item.id === context?.projectId);
  const openQueue = useRef(() => {});
  openQueue.current = () => {
    const due = dueRef.current[0];
    if (due) void ws.chooseContext(due.context).then(() => setPage("queue"));
    else setPage("queue");
  };
  const date = (value: string) => new Intl.DateTimeFormat(language === "tr" ? "tr-TR" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const errorText = (error: unknown) => {
    if (error instanceof ApiError) {
      if (error.code === "revision_conflict") return t("revisionConflict");
      if (error.code === "invalid_input") return t("invalidInput");
      if (["context_not_found", "memory_not_found", "context_required"].includes(error.code)) return t("missingContext");
      if (["unauthorized", "connection_failed", "invalid_runtime"].includes(error.code)) return t("connectionError");
      const youtubeErrors: Record<string, TextKey> = {
        youtube_no_channel: "youtubeNoChannel", youtube_token_failed: "youtubeTokenFailed",
        youtube_not_configured: "youtubeSetupHelp", vault_unavailable: "youtubeVaultRequired", youtube_missing_scope: "youtubeMissingScope",
        youtube_channel_mismatch: "youtubeChannelMismatch", youtube_identity_mismatch: "youtubeIdentityMismatch", youtube_reauth_required: "youtubeReauthHelp",
        youtube_consent_denied: "youtubeConsentDenied", youtube_session_expired: "youtubeExpired", youtube_refresh_missing: "youtubeRefreshMissing",
        youtube_access_denied: "youtubeAccessDenied", youtube_revoke_failed: "youtubeRevokeFailed", youtube_already_connected: "youtubeAlreadyConnected",
        youtube_session_active: "youtubeSessionActive", connection_conflict: "youtubeConnectionConflict", youtube_session_not_found: "youtubeExpired"
      };
      if (youtubeErrors[error.code]) return t(youtubeErrors[error.code]!);
      if (error.code.startsWith("youtube_")) return t("youtubeOperationFailed");
      return t("operationFailed");
    }
    return t("connectionError");
  };
  useEffect(() => { document.documentElement.dataset.theme = theme; remember("atris-share-theme", theme); }, [theme]);
  useEffect(() => { document.documentElement.lang = language; remember("atris-share-language", language); }, [language]);
  useEffect(() => {
    document.getElementById("main-content")?.scrollTo({ top: 0 });
    if (page === "settings" && focusTools.current) { focusTools.current = false; requestAnimationFrame(() => document.getElementById("video-tools")?.scrollIntoView({ block: "start" })); }
  }, [page]);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const occurrences: Occurrence[] = []; let next: { dueAt: string; id: string } | null = null;
        do {
          const q: string = next ? `?${new URLSearchParams({ afterId: next.id, afterDueAt: next.dueAt })}` : "";
          const page: { occurrences: Occurrence[]; next: { dueAt: string; id: string } | null } = await request(`/api/queue/notifications${q}`, "GET", undefined, abort.signal);
          occurrences.push(...page.occurrences); next = page.next;
        } while (next && !abort.signal.aborted);
        const result = { occurrences };
        if (abort.signal.aborted) return;
        dueRef.current = result.occurrences; setDueReviews(result.occurrences);
        for (const o of result.occurrences) {
          if (abort.signal.aborted) break;
          await notifyDue({ id: `${o.context.accountId}:${o.id}`, title: "AtrisShare", body: language === "tr" ? "Zamanlanmış bir içerik inceleme kutusunda onayını bekliyor." : "A scheduled item is waiting for your approval in the review inbox." });
        }
      } catch { /* Inbox/queue remains authoritative when optional reminders fail. */ }
      finally { if (!abort.signal.aborted) timer = setTimeout(() => { void poll(); }, 5000); }
    };
    void poll();
    return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [language]);
  useEffect(() => {
    let dispose: (() => void) | undefined, cancelled = false;
    void onNativeOpenQueue(() => openQueue.current()).then(fn => { if (cancelled) fn(); else dispose = fn; });
    return () => { cancelled = true; dispose?.(); };
  }, []);
  useEffect(() => {
    setModal(null); setSearch(""); setCategory(""); setReview("");
  }, [context?.accountId, context?.projectId]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(timeout);
  }, [notice]);
  function open(value: Modal) { returnFocus.current = document.activeElement as HTMLElement | null; setFormError(null); setModal(value); }
  async function mutate(action: () => Promise<void>, message: TextKey) {
    if (pending) return;
    setPending(true); setFormError(null);
    try { await action(); setModal(null); setNotice(message); await ws.refresh(); }
    catch (error) { setFormError(error); }
    finally { setPending(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (key: string) => String(data.get(key) ?? "");
    if (modal?.type === "project") {
      const target = text("accountId");
      void mutate(async () => {
        const owner = target === "local" ? state?.accounts.find(a => a.platform === "local") ?? await request<WorkspaceAccount>("/api/accounts", "POST", { displayName: t("personalWorkspace"), platform: "local" }) : state?.accounts.find(a => a.id === target);
        if (!owner) throw new ApiError("context_not_found");
        const created = await request<WorkspaceProject>("/api/projects", "POST", { accountId: owner.id, name: text("name"), description: text("description") });
        await request("/api/context", "PUT", { accountId: owner.id, projectId: created.id });
        setStudioTab("media"); setPage("studio");
      }, "projectCreated");
    } else if (modal?.type === "memory" && context) {
      const entry = modal.entry;
      const scope = context;
      void mutate(async () => {
        const input = { context: scope, text: text("text"), kind: text("kind"), reviewState: text("reviewState") };
        await request(entry ? `/api/memory/${entry.id}` : "/api/memory", entry ? "PATCH" : "POST",
          entry ? { ...input, expectedRevision: entry.revision } : input);
      }, "noteSaved");
    } else if (modal?.type === "delete" && context && modal.entry) {
      const entry = modal.entry;
      const scope = context;
      void mutate(async () => {
        await request(`/api/memory/${entry.id}`, "DELETE", { context: scope, expectedRevision: entry.revision });
      }, "noteDeleted");
    }
  }
  const addMemory = <button className="button primary" disabled={!context || ws.loading} onClick={() => open({ type: "memory", entry: null })}><Plus size={16} />{t("newMemory")}</button>;
  const addProject = <button className="button primary" disabled={ws.loading || !state} onClick={() => open({ type: "project" })}><Plus size={16} />{t("newProject")}</button>;
  const addAccount = <button className="button primary" disabled={ws.loading || !state} onClick={() => setPage("accounts")}><Plus size={16} />{t("connectAccount")}</button>;
  const visibleMemory = ws.memory.filter(entry => (!category || entry.kind === category) && (!review || entry.reviewState === review) &&
    entry.text.toLocaleLowerCase(language).includes(search.toLocaleLowerCase(language)));
  function scopeLabel(scope: WorkspaceContext) { return state?.projects.find(p => p.id === scope.projectId)?.name ?? t("accountScope"); }
  const memoryCard = (entry: WorkspaceMemory) => <MemoryCard key={entry.id} entry={entry} t={t} date={date}
    onEdit={value => open({ type: "memory", entry: value })} onDelete={value => open({ type: "delete", entry: value })} />;
  const modalTitle = modal?.type === "project" ? t("newProject") : modal?.type === "delete" ? t("deleteTitle") : modal?.type === "memory" && modal.entry ? t("edit") : t("newMemory");

  return <div className="desktop-shell"><Titlebar language={language} /><AppUpdater language={language} /><div className="app-shell">
    <aside className="sidebar" aria-label="AtrisShare">
      <button className="button sidebar-create" disabled={ws.loading || !state} title={t("newProject")} onClick={() => open({ type: "project" })}><Plus size={16} /><span>{t("newProject")}</span></button>
      <div className="sidebar-label">{t("studioLabel")}</div>
      <nav aria-label={t("workspace")}>{nav.map(item => <button key={item.id} className={`nav-item ${page === item.id ? "active" : ""}`} aria-current={page === item.id ? "page" : undefined}
        title={t(item.id)} onClick={() => { if (item.id === "studio") setStudioTab("media"); setPage(item.id); }}><item.icon size={18} /><span>{t(item.id)}</span>{item.id === "memory" && <small>{ws.memory.length}</small>}</button>)}</nav>
      <a className="hub-link" href="https://atrishub.com" target="_blank" rel="noreferrer">AtrisHub <ArrowUpRight size={14} /></a>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">AtrisShare <ChevronRight size={14} /><strong>{t(page)}</strong></div>
        <div className="topbar-right"><span className={`connection ${ws.error ? "offline" : ""}`}><span />{ws.error ? t("retry") : t("saved")}</span>
          <button className="icon-button" aria-label={t("retry")} title={t("retry")} disabled={ws.loading} onClick={() => { void ws.refresh(true); }}><RefreshCw size={16} className={ws.loading ? "spinning" : ""} /></button></div></header>

      {page !== "accounts" && page !== "settings" && <div className="context-bar" aria-label={t("scopeDescription")}>
        <label><span>{t("account")}</span><div className="context-select">{account && <PlatformIcon platform={account.platform} />}<select aria-label={t("account")} value={context?.accountId ?? ""} disabled={!state?.accounts.length || ws.loading}
          onChange={event => { void ws.chooseContext({ accountId: event.target.value, projectId: null }); }}>
          {!state?.accounts.length && <option value="">{t("noAccount")}</option>}{state?.accounts.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>{account && <span className={`badge ${account.status === "connected" ? "positive" : "demo-badge"}`}>{t(accountStatusKey(account))}</span>}</div></label>
        <span className="context-divider" />
        <label className="project-select"><span>{t("project")}</span><select aria-label={t("project")} value={context?.projectId ?? ""} disabled={!context || ws.loading}
          onChange={event => { if (context) void ws.chooseContext({ accountId: context.accountId, projectId: event.target.value || null }); }}>
          <option value="">{t("accountScope")}</option>{state?.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {context && <button className="text-button context-new" disabled={ws.loading || !state} onClick={() => open({ type: "project" })}><Plus size={14} />{t("newProject")}</button>}
        <div className="context-saved"><Database size={13} /><span>{t("local")}</span></div>
      </div>}

      <main id="main-content" data-page={page} aria-busy={ws.loading}>
        {!!dueReviews.length && <div className="queue-reminder" role="status"><CalendarClock size={17} /><span>{language === "tr" ? `${dueReviews.length} zamanlanmış içerik onay bekliyor.` : `${dueReviews.length} scheduled items await approval.`}</span><button className="text-button" onClick={() => openQueue.current()}>{t("queue")}<ChevronRight size={14} /></button></div>}
        {!!ws.error && <div className="error-banner" role="alert"><CircleAlert size={17} /><span>{errorText(ws.error)}</span><button className="text-button" onClick={() => { void ws.refresh(true); }}>{t("retry")}</button></div>}
        {ws.loading && !state ? <div className="loading-state" role="status"><LoaderCircle className="spinning" />{t("loading")}</div> : state && <>
          {page === "studio" && (context && account && context.projectId ? <Studio key={`${context.accountId}:${context.projectId}`} context={context} account={account} language={language} errorText={errorText} initialTab={studioTab} projectName={project?.name ?? ""} onToolSettings={() => { focusTools.current = true; setPage("settings"); }} /> : <>
            <div className="page-heading"><div><p className="eyebrow">{t("studioLabel")}</p><h1>{t("editorStartTitle")}</h1><p>{t("editorStartHelp")}</p></div></div>
            <section className="editor-launch panel"><span className="editor-launch-icon"><Scissors size={28} strokeWidth={1.5} /></span><div><h2>{t("startEditing")}</h2><p>{t("localProjectHelp")}</p></div><button className="button primary" onClick={() => open({ type: "project" })}><Plus size={16} />{t("newProject")}</button></section>
            {!!state.projects.length && <section className="section"><div className="section-heading"><h2>{t("recentProjects")}</h2><span className="count">{state.projects.length}</span></div><div className="project-grid">{state.projects.map(item => <button className="project-card" key={item.id} onClick={() => { void ws.chooseContext({ accountId: item.accountId, projectId: item.id }); setStudioTab("media"); }}><span className="project-symbol"><Clapperboard size={20} /></span><span className="project-card-copy"><strong>{item.name}</strong><span>{item.description || account?.displayName}</span></span><span className="project-card-bottom">{t("open")}<ArrowUpRight size={14} /></span></button>)}</div></section>}
            <div className="workflow-links">{([{ icon: Scissors, title: "workflowEdit", help: "workflowEditHelp", action: () => open({ type: "project" }) }, { icon: UsersRound, title: "workflowConnect", help: "workflowConnectHelp", action: () => setPage("accounts") }, { icon: CalendarClock, title: "workflowPublish", help: "workflowPublishHelp", action: () => setPage("queue") }] as const).map((item, index) => <button key={item.title} onClick={item.action}><span className="workflow-number">0{index + 1}</span><item.icon size={19} /><strong>{t(item.title)}</strong><span>{t(item.help)}</span><ChevronRight size={15} /></button>)}</div>
          </>)}
          {page === "social" && <SocialPanel mode="compose" language={language} context={context} onOpenAccounts={() => setPage("accounts")} onAccountsChanged={() => { void ws.refresh(); }} />}
          {page === "queue" && (context?.projectId ? <QueuePanel context={context} language={language} onReview={(kind, target) => { void ws.chooseContext(target).then(() => { setStudioTab("publishing"); setPage(kind === "youtube" ? "studio" : "social"); }); }} /> : <div className="panel"><Empty icon={<CalendarClock size={26} />} title={t("chooseStudioProject")} description={t("queueStartHelp")} action={account ? addProject : <button className="button primary" onClick={() => setPage("accounts")}>{t("accounts")}</button>} /></div>)}
          {page === "workspace" && <>
            <div className="page-heading"><div><p className="eyebrow">{t("workspace")}</p><h1>{t("homeTitle")}</h1><p>{t("homeDescription")}</p></div>{addProject}</div>
            {!account ? <div className="panel welcome"><Empty icon={<FolderKanban size={30} />} title={t("welcomeTitle")} description={t("welcomeDescription")} action={addProject} /></div> : <>
              <div className="target-strip"><PlatformIcon platform={account.platform} /><div><strong>{account.displayName}</strong><p>{t(account.platform === "local" ? "localAccountNotice" : account.status === "demo" ? "demoNotice" : account.platform !== "youtube" ? account.status === "connected" ? "connectedAccountNotice" : "disconnectedAccountNotice" : account.status === "connected" ? "youtubeAccountNotice" : "youtubeDisconnectedNotice")}</p></div><span className={`badge ${account.status === "connected" ? "positive" : "suggested"}`}>{platformNames[account.platform]} · {t(accountStatusKey(account))}</span></div>
              <section className="section"><div className="section-heading"><div><h2>{t("projects")} <span className="count">{state.projects.length}</span></h2><p>{t("projectsDescription")}</p></div></div>
                {state.projects.length ? <div className="project-grid">{state.projects.map(item => <button className={`project-card ${project?.id === item.id ? "selected-project" : ""}`} key={item.id} disabled={ws.loading}
                  onClick={() => { void ws.chooseContext({ accountId: item.accountId, projectId: item.id }); setPage("studio"); }}><span className="project-symbol"><FolderKanban size={20} /></span>
                  <span className="project-card-copy"><strong>{item.name}</strong><span>{item.description || platformNames[account.platform]}</span></span><span className="project-card-bottom">{project?.id === item.id ? t("selected") : t("open")}<ChevronRight size={14} /></span></button>)}</div>
                  : <div className="panel"><Empty icon={<FolderKanban size={24} />} title={t("noProjects")} description={t("noProjectsDescription")} action={addProject} /></div>}
              </section>
              <section className="section"><div className="section-heading"><div><h2>{t("recentMemory")}</h2><p>{scopeLabel(context!)}</p></div><button className="text-button" onClick={() => setPage("memory")}>{t("viewAll")}<ArrowUpRight size={14} /></button></div>
                {ws.memory.length ? <div className="memory-grid">{ws.memory.slice(0, 3).map(memoryCard)}</div> : <div className="inline-empty"><BrainCircuit size={20} /><span>{t("memoryEmpty")}</span><button className="text-button" onClick={() => open({ type: "memory", entry: null })}>{t("newMemory")}<Plus size={14} /></button></div>}
              </section>
            </>}
          </>}

          {page === "memory" && <>
            <div className="page-heading"><div><p className="eyebrow">{t("memory")}</p><h1>{t("memoryTitle")}</h1><p>{t("memoryDescription")}</p></div><div className="studio-heading-actions">{context && <MemoryExport context={context} language={language} />}{addMemory}</div></div>
            <div className="memory-toolbar"><label className="search-field"><Search size={16} /><input aria-label={t("searchLabel")} placeholder={t("search")} value={search} onChange={event => setSearch(event.target.value)} /></label>
              <select aria-label={t("category")} value={category} onChange={event => setCategory(event.target.value)}><option value="">{t("allKinds")}</option>{Object.entries(kindKeys).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select>
              <select aria-label={t("state")} value={review} onChange={event => setReview(event.target.value)}><option value="">{t("allStates")}</option><option value="confirmed">{t("confirmed")}</option><option value="suggested">{t("suggested")}</option></select></div>
            <div className="list-caption"><span>{context ? `${account?.displayName} / ${scopeLabel(context)}` : t("noAccount")}</span><span>{visibleMemory.length} {t("records")}</span></div>
            {ws.loading ? <div className="loading-state" role="status"><LoaderCircle className="spinning" />{t("loading")}</div> : visibleMemory.length ? <div className="memory-grid">{visibleMemory.map(memoryCard)}</div>
              : <div className="panel"><Empty icon={<BrainCircuit size={27} />} title={ws.memory.length ? t("noResults") : t("memoryEmpty")} description={t("memoryEmptyDescription")} action={context ? addMemory : addAccount} /></div>}
          </>}

          {page === "accounts" && <Accounts language={language} accounts={state.accounts} selectedId={account?.id} vaultAvailable={state.vault.available} loading={ws.loading}
            t={t} errorText={errorText} refresh={ws.refresh} choose={accountId => { void ws.chooseContext({ accountId, projectId: null }); }} />}

          {page === "settings" && <>
            <div className="page-heading"><div><p className="eyebrow">{t("settings")}</p><h1>{t("settingsTitle")}</h1><p>{t("settingsDescription")}</p></div><span className="version">v{state.version}</span></div>
            <section className="settings-panel panel"><div className="settings-section-title"><Settings2 size={18} /><h2>{t("appearance")}</h2></div>
              <div className="setting-row"><label htmlFor="theme">{t("theme")}</label><select id="theme" value={theme} onChange={event => setTheme(event.target.value)}><option value="dark">{t("dark")}</option><option value="light">{t("light")}</option></select></div>
              <div className="setting-row"><label htmlFor="language">{t("language")}</label><select id="language" value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="tr">Türkçe</option><option value="en">English</option></select></div></section>
            <NativeSettings language={language} />
            <MediaToolSettings language={language} />
            <section className="settings-panel panel"><div className="settings-section-title"><HardDrive size={18} /><h2>{t("storage")}</h2></div>
              <div className="setting-row data-row"><span>{t("dataDirectory")}</span><code>{state.dataDirectory}</code></div>
              <div className="setting-row"><span>{t("database")}</span><span>SQLite · WAL</span></div>
              <div className="setting-row"><div><span>{t("vault")}</span><p>{t("vaultDescription")}</p></div><span className="vault-status"><ShieldCheck size={15} />{state.vault.available ? t("vaultReady") : t("vaultUnavailable")}</span></div>
              <div className="setting-row"><div><span>{t("session")}</span><p>{t("sessionDescription")}</p></div><span className="badge positive">{t("local")}</span></div></section>
            <section className="settings-panel panel"><div className="settings-section-title"><NotebookPen size={18} /><h2>{t("audit")}</h2></div><p className="section-note">{t("auditDescription")}</p>
              {ws.audit.length ? <ul className="audit-list">{ws.audit.map(event => <li key={event.id}><span className="audit-dot" /><span>{event.action in dictionaries[language] ? t(event.action as TextKey) : event.action}</span><time dateTime={event.recordedAt}>{date(event.recordedAt)}</time></li>)}</ul> : <p className="section-note">{t("noAudit")}</p>}</section>
          </>}
        </>}
      </main>
      <footer className="statusbar"><span><span className={`status-dot ${ws.error ? "offline-dot" : ""}`} />{ws.error ? t("connectionError") : ws.loading ? t("loading") : t("connected")}</span><span>{account?.displayName ?? "AtrisShare"}{context && <> / {scopeLabel(context)}</>}</span></footer>
    </div>
    <div className="notice-region" role="status" aria-live="polite">{notice && <div className="toast"><Check size={17} />{t(notice)}</div>}</div>
    <Dialog.Root open={modal !== null} onOpenChange={value => { if (!value && !pending) setModal(null); }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content" aria-describedby="dialog-description" onEscapeKeyDown={event => { if (pending) event.preventDefault(); }} onPointerDownOutside={event => { if (pending) event.preventDefault(); }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const target = returnFocus.current?.isConnected ? returnFocus.current : document.querySelector<HTMLElement>('.nav-item[aria-current="page"]');
          target?.focus();
        }}>
        <Dialog.Title>{modalTitle}</Dialog.Title><Dialog.Description id="dialog-description">{modal?.type === "project" ? t("localProjectHelp") : modal?.type === "delete" ? t("deleteDescription") : t("memoryFormDescription")}</Dialog.Description>
        <Dialog.Close className="icon-button dialog-close" aria-label={t("close")} disabled={pending}><X size={18} /></Dialog.Close>
        {context && modal?.type !== "project" && <div className="form-scope"><span className="status-dot" />{account?.displayName} / {scopeLabel(context)}</div>}
        <form onSubmit={submit} key={`${modal?.type}-${modal && "entry" in modal ? modal.entry?.id ?? "new" : "new"}`}>
          {modal?.type === "project" && <><label className="form-field">{t("name")}<input name="name" placeholder={t("projectPlaceholder")} required maxLength={100} autoComplete="off" /></label><label className="form-field">{t("projectTarget")}<select name="accountId" defaultValue={account?.status === "connected" ? account.id : "local"}><option value="local">{t("projectLocal")}</option>{state?.accounts.filter(a => a.status === "connected").map(a => <option key={a.id} value={a.id}>{platformNames[a.platform]} · {a.displayName}</option>)}</select></label><label className="form-field">{t("description")}<textarea name="description" rows={2} maxLength={500} /></label></>}
          {modal?.type === "memory" && <><div className="form-columns"><label className="form-field">{t("category")}<select name="kind" defaultValue={modal.entry?.kind ?? "brand-voice"}>{Object.entries(kindKeys).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></label><label className="form-field">{t("state")}<select name="reviewState" defaultValue={modal.entry?.reviewState ?? "confirmed"}><option value="confirmed">{t("confirmed")}</option><option value="suggested">{t("suggested")}</option></select></label></div><label className="form-field">{t("noteText")}<textarea name="text" required maxLength={4000} rows={6} defaultValue={modal.entry?.text ?? ""} placeholder={t("notePlaceholder")} /></label><p className="field-help">{t("noteHelp")}</p></>}
          {modal?.type === "delete" && <blockquote className="delete-preview">{modal.entry?.text}</blockquote>}
          {!!formError && <p role="alert" className="form-error">{errorText(formError)}</p>}
          <div className="dialog-actions"><button className="button secondary" type="button" disabled={pending} onClick={() => setModal(null)}>{t("cancel")}</button><button className={`button ${modal?.type === "delete" ? "danger" : "primary"}`} disabled={pending} type="submit">{pending && <LoaderCircle size={15} className="spinning" />}{pending ? t("saving") : modal?.type === "delete" ? t("delete") : modal?.type === "project" ? t("newProject") : t("save")}</button></div>
        </form>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </div></div>;
}
