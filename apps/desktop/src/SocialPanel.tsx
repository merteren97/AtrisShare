import { useEffect, useId, useRef, useState } from "react";
import { Check, ExternalLink, KeyRound, LoaderCircle, Plus, RefreshCw, Send, ShieldCheck, StopCircle } from "lucide-react";
import type { SocialAccount, SocialCapabilities, SocialContext, SocialDraft, SocialMetadata, SocialPost, SocialProviderId, SocialSession, SocialSetup, SocialTarget,
  SocialTextRequest, SocialTextSetup, SocialTextSuggestion } from "../../../packages/domain/src/social.js";
import type { StudioArtifact } from "../../../packages/domain/src/studio.js";
import type { WorkspaceContext, WorkspaceProject } from "../../../packages/domain/src/workspace.js";
import { ApiError, mediaBlob, request } from "./api";
import { socialCopy, socialReasons } from "./social-panel-i18n";
import "./social-panel.css";

export interface SocialPanelProps {
  language: "en" | "tr"; context: WorkspaceContext | null; onAccountsChanged?: () => void;
  mode?: "all" | "connections" | "compose";
  providerFilter?: SocialProviderId;
  onOpenAccounts?: () => void;
  loadPreview?: (input: { context: SocialContext; artifactId: string }, signal: AbortSignal) => Promise<Blob>;
  client?: typeof request;
}
type Variant = {
  selected: boolean; projectId: string; text: string; title: string; visibility: "PUBLIC" | "CONNECTIONS";
  privacy: "" | "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";
  allowComment: boolean; allowDuet: boolean; allowStitch: boolean; disclosure: boolean; ownBrand: boolean; branded: boolean;
  madeWithAi: boolean; paid: boolean; reshare: boolean; consent: boolean; revision: number;
  capability: SocialCapabilities | null; draftId: string | null; error: string | null; busy: boolean; proposal: SocialTextSuggestion | null;
  aiModelId: string; aiInstruction: string; aiIncludeMemory: boolean; aiConsent: boolean; aiBusy: boolean; aiError: string | null;
  aiState: "idle" | "running" | "ready" | "cancelled" | "failed" | "applied" | "rejected";
};
const blank = (): Variant => ({ selected: false, projectId: "", text: "", title: "", visibility: "PUBLIC", privacy: "", allowComment: false, allowDuet: false, allowStitch: false,
  disclosure: false, ownBrand: false, branded: false, madeWithAi: false, paid: false, reshare: false, consent: false, revision: 0, capability: null, draftId: null, error: null, busy: false, proposal: null,
  aiModelId: "", aiInstruction: "", aiIncludeMemory: false, aiConsent: false, aiBusy: false, aiError: null, aiState: "idle" });
const names = { x: "X", linkedin: "LinkedIn", tiktok: "TikTok" };
const providers: SocialProviderId[] = ["x", "linkedin", "tiktok"];
const sessionKey = "atris-share-social-sessions";
function pendingSessionIds(): string[] {
  try { const value: unknown = JSON.parse(sessionStorage.getItem(sessionKey) ?? "[]"); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id)).slice(0, 3) : []; }
  catch { return []; }
}
const defaultPreview: NonNullable<SocialPanelProps["loadPreview"]> = (input, signal) => mediaBlob(`/api/media/${input.artifactId}/content?accountId=${input.context.accountId}&projectId=${input.context.projectId}`, signal);
export function SocialPanel({ language, context, onAccountsChanged, mode = "all", providerFilter, onOpenAccounts, loadPreview = defaultPreview, client = request }: SocialPanelProps) {
  const t = socialCopy[language], uid = useId();
  const [setup, setSetup] = useState<SocialSetup[]>([]), [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [variants, setVariants] = useState<Record<string, Variant>>({}); const variantsRef = useRef(variants); variantsRef.current = variants;
  const [projects, setProjects] = useState<Record<string, WorkspaceProject[]>>({}), [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<SocialSession[]>([]), [destinations, setDestinations] = useState<Record<string, string>>({});
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [posts, setPosts] = useState<SocialPost[]>([]), [approved, setApproved] = useState<Record<string, boolean>>({});
  const [mediaReady, setMediaReady] = useState<Record<string, boolean>>({});
  const [tikReviews, setTikReviews] = useState<Record<string, { cap: SocialCapabilities; expires: number; privacy: string; comment: boolean; duet: boolean; stitch: boolean; own: boolean; branded: boolean; consent: boolean }>>({});
  const [postsEpoch, setPostsEpoch] = useState(0);
  const [aiSetup, setAiSetup] = useState<SocialTextSetup | null>(null), [aiLoading, setAiLoading] = useState(true), [aiSetupError, setAiSetupError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<StudioArtifact[]>([]), [artifactId, setArtifactId] = useState(""), [base, setBase] = useState("");
  const [provider, setProvider] = useState<SocialProviderId>(providerFilter ?? "x"), [clientId, setClientId] = useState(""), [secret, setSecret] = useState(""), [port, setPort] = useState(!providerFilter || providerFilter === "x" ? "18477" : "0");
  const [pkce, setPkce] = useState(false), [redirect, setRedirect] = useState(false), [organization, setOrganization] = useState(false), [publicApp, setPublicApp] = useState(false), [audited, setAudited] = useState(false);
  const [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [video, setVideo] = useState<string | null>(null);
  const abort = useRef(new AbortController()), mounted = useRef(true), sourceVersion = useRef(0), operationLock = useRef(new Set<string>());
  const aiRequests = useRef(new Map<string, { input: SocialTextRequest; controller: AbortController }>());
  const scopeKey = `${context?.accountId ?? ""}/${context?.projectId ?? ""}`;
  const code = (e: unknown) => e instanceof ApiError && /^(social_[a-z_]+|vault_unavailable|runtime_closing)$/.test(e.code) ? e.code : "social_operation_failed";
  const message = (c: string) => socialReasons[c]?.[language] ?? t.error;
  const api = <T,>(path: string, method = "GET", body?: unknown) => client<T>(path, method, body, abort.current.signal);
  const remember = (p: SocialPost) => setPosts(prev => [p, ...prev.filter(old => old.id !== p.id)]);
  function patch(id: string, update: Partial<Variant>, edit = false) {
    if (edit && aiRequests.current.has(id)) void cancelAi(id);
    setVariants(prev => { const v = prev[id] ?? blank(); return { ...prev, [id]: { ...v, ...update,
      ...(update.projectId !== undefined && update.projectId !== v.projectId ? { aiIncludeMemory: false } : {}),
      ...(edit ? { revision: v.revision + 1, draftId: null, consent: false, aiConsent: false, proposal: null, aiBusy: false,
        ...(v.aiBusy ? { aiState: "cancelled" as const } : {}) } : {}) } }; });
  }
  function editAi(id: string, update: Partial<Variant>) {
    if (aiRequests.current.has(id)) void cancelAi(id);
    setVariants(prev => { const v = prev[id] ?? blank(); return { ...prev, [id]: { ...v, aiConsent: false, ...update,
      revision: v.revision + 1, proposal: null, aiError: null, aiBusy: false, aiState: "idle" } }; });
  }
  async function loadAiSetup(refresh = false) {
    setAiLoading(true); setAiSetupError(null);
    try { const setup = await api<SocialTextSetup>(`/api/social/ai/setup${refresh ? "?refresh=1" : ""}`);
      if (!mounted.current) return;
      setAiSetup(setup);
      for (const [id, task] of aiRequests.current) if (!setup.models.includes(task.input.modelId)) void cancelAi(id);
      setVariants(prev => Object.fromEntries(Object.entries(prev).map(([id, v]) => [id, setup.models.includes(v.aiModelId) ? v : { ...v, aiModelId: "", aiConsent: false, proposal: null, revision: v.revision + 1 }])));
    } catch (e) { if (mounted.current) { setAiSetup(null); setAiSetupError(code(e)); } }
    finally { if (mounted.current) setAiLoading(false); }
  }
  async function cancelAi(id: string, report = false) {
    const task = aiRequests.current.get(id); if (!task) return;
    aiRequests.current.delete(id); task.controller.abort();
    if (mounted.current) patch(id, { aiBusy: false, aiConsent: false, proposal: null, aiState: "cancelled" });
    try { await client("/api/social/ai/cancel", "POST", { requestId: task.input.requestId, context: task.input.context, target: task.input.target }, AbortSignal.timeout(10_000)); }
    catch (e) { if (report && mounted.current && !(e instanceof ApiError && e.code === "social_ai_request_not_found")) patch(id, { aiError: code(e) }); }
  }
  async function suggest(a: SocialAccount) {
    const v = variantsRef.current[a.accountId];
    if (!v || !v.projectId || !v.aiConsent || !v.aiInstruction.trim() || !aiSetup?.available || !aiSetup.models.includes(v.aiModelId) || aiRequests.current.has(a.accountId)) return;
    const t = target(a, v), input: SocialTextRequest = { requestId: crypto.randomUUID(), context: { accountId: t.accountId, projectId: t.projectId }, target: t,
      modelId: v.aiModelId, instruction: v.aiInstruction, text: v.text, includeMemory: v.aiIncludeMemory, allowRemote: true };
    const revision = v.revision, source = sourceVersion.current, task = { input, controller: new AbortController() };
    aiRequests.current.set(a.accountId, task); patch(a.accountId, { aiBusy: true, aiError: null, aiState: "running", proposal: null });
    try {
      const proposal = await client<SocialTextSuggestion>("/api/social/ai/suggest", "POST", input, AbortSignal.any([task.controller.signal, abort.current.signal]));
      if (!mounted.current || aiRequests.current.get(a.accountId) !== task || source !== sourceVersion.current || variantsRef.current[a.accountId]?.revision !== revision) return;
      if (proposal.id !== input.requestId || proposal.modelId !== input.modelId || JSON.stringify(proposal.target) !== JSON.stringify(input.target) ||
        typeof proposal.text !== "string" || !proposal.text.trim() || proposal.text.length > 2000 || !/^[a-f0-9]{64}$/.test(proposal.digest)) throw new ApiError("social_ai_protocol_error");
      patch(a.accountId, { proposal, aiState: "ready", aiConsent: false });
    } catch (e) {
      if (mounted.current && aiRequests.current.get(a.accountId) === task) patch(a.accountId, { aiError: task.controller.signal.aborted ? null : code(e), aiState: task.controller.signal.aborted ? "cancelled" : "failed", aiConsent: false });
    } finally { if (aiRequests.current.get(a.accountId) === task) { aiRequests.current.delete(a.accountId); if (mounted.current) patch(a.accountId, { aiBusy: false }); } }
  }
  async function load() {
    try { const s = await api<{ setup: SocialSetup[]; accounts: SocialAccount[] }>("/api/social");
      if (mounted.current) { setSetup(s.setup); setAccounts(s.accounts); setError(null); setPostsEpoch(value => value + 1); }
      for (const id of aiRequests.current.keys()) if (!s.accounts.some(a => a.accountId === id && a.status === "connected")) void cancelAi(id);
    } catch (e) { if (mounted.current) setError(code(e)); }
    finally { if (mounted.current) setLoading(false); }
  }
  async function restoreSessions() {
    try {
      const restored = await Promise.all(pendingSessionIds().map(id => api<SocialSession>(`/api/social/sessions/${id}`).catch(e => { if (e instanceof ApiError && ["social_session_not_found", "social_session_expired"].includes(e.code)) return null; throw e; })));
      if (mounted.current) { setSessions(prev => [...prev, ...restored.filter((s): s is SocialSession => !!s && !prev.some(p => p.id === s.id))]); setSessionsLoaded(true); }
    } catch (e) { if (mounted.current) setError(code(e)); }
  }
  useEffect(() => {
    mounted.current = true; abort.current = new AbortController(); void load(); void restoreSessions(); if (mode !== "connections") void loadAiSetup();
    return () => { mounted.current = false; for (const id of aiRequests.current.keys()) void cancelAi(id); abort.current.abort(); };
  }, []);
  useEffect(() => {
    if (!sessionsLoaded) return;
    try { sessionStorage.setItem(sessionKey, JSON.stringify(sessions.filter(s => ["awaiting-browser", "verifying", "select-destination"].includes(s.state)).map(s => s.id))); }
    catch { /* The current panel still retains pending sessions. */ }
  }, [sessions, sessionsLoaded]);
  useEffect(() => {
    sourceVersion.current++; const version = sourceVersion.current;
    for (const id of aiRequests.current.keys()) void cancelAi(id);
    setArtifactId(""); setArtifacts([]); setVideo(null);
    setPosts([]); setApproved({}); setMediaReady({}); setTikReviews({});
    setVariants(prev => Object.fromEntries(Object.entries(prev).map(([id, v]) => [id, { ...v, revision: v.revision + 1, draftId: null, consent: false,
      aiConsent: false, aiIncludeMemory: false, aiBusy: false, proposal: null, aiState: "idle" }])));
    if (context?.projectId) void api<{artifacts:StudioArtifact[]}>(`/api/studio?accountId=${context.accountId}&projectId=${context.projectId}`).then(r => {
      if (mounted.current && version === sourceVersion.current) setArtifacts(r.artifacts.filter(a => a.kind !== "preview" && a.kind !== "proxy"));
    }).catch(e => { if (mounted.current && version === sourceVersion.current) setError(code(e)); });
  }, [scopeKey]);
  const savedTargets = accounts.flatMap(a => {
    const v = variants[a.accountId];
    const projectId = v?.selected && v.projectId ? v.projectId : context?.accountId === a.accountId ? context.projectId : null;
    return projectId ? [{ accountId: a.accountId, projectId, destinationId: a.destinationId }] : [];
  });
  const savedTargetKey = JSON.stringify(savedTargets);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all((JSON.parse(savedTargetKey) as SocialTarget[]).map(target => client<SocialPost[]>(`/api/social/posts?${new URLSearchParams(target)}`, "GET", undefined, controller.signal)))
      .then(values => { if (!controller.signal.aborted) setPosts(prev => {
        const next = new Map(prev.map(p => [p.id, p])); for (const p of values.flat()) next.set(p.id, p);
        return [...next.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }); }).catch(e => { if (!controller.signal.aborted) setError(code(e)); });
    return () => controller.abort();
  }, [savedTargetKey, scopeKey, postsEpoch]);
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState !== "hidden") setPostsEpoch(value => value + 1); }, 5000); return () => clearInterval(timer); }, []);
  useEffect(() => () => { if (video) URL.revokeObjectURL(video); }, [video]);
  useEffect(() => {
    if (!sessions.some(s => ["awaiting-browser", "verifying", "select-destination"].includes(s.state))) return;
    let active = true, running = false;
    const timer = setInterval(() => { if (running) return; running = true;
      void Promise.all(sessions.map(async s => ["awaiting-browser", "verifying", "select-destination"].includes(s.state) ? api<SocialSession>(`/api/social/sessions/${s.id}`) : s))
        .then(values => { if (active) setSessions(values); }).catch(e => { if (active) setError(code(e)); }).finally(() => { running = false; });
    }, 1800);
    return () => { active = false; clearInterval(timer); };
  }, [sessions.map(s => `${s.id}:${s.state}`).join(",")]);
  useEffect(() => {
    if (!posts.some(p => ["uploading", "processing"].includes(p.state))) return;
    let active = true, running = false;
    const targets = [...new Map(posts.filter(p => ["uploading", "processing"].includes(p.state)).map(p => [JSON.stringify(p.payload.target), p.payload.target])).values()];
    const timer = setInterval(() => { if (running) return; running = true;
      void Promise.all(targets.map(target => api<SocialPost[]>(`/api/social/posts?${new URLSearchParams(target)}`))).then(values => {
        if (active) setPosts(prev => { const next = new Map(prev.map(p => [p.id, p])); for (const p of values.flat()) next.set(p.id, p); return [...next.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); });
      }).catch(e => { if (active) setError(code(e)); }).finally(() => { running = false; });
    }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [posts.map(p => `${p.id}:${p.state}`).join(",")]);
  async function action(key: string, work: () => Promise<void>) {
    if (operationLock.current.has(key)) return;
    operationLock.current.add(key);
    try { await work(); } catch (e) { if (mounted.current) setError(code(e)); } finally { operationLock.current.delete(key); }
  }
  async function connect(aProvider: SocialProviderId, account?: SocialAccount) {
    await action(`connect:${aProvider}`, async () => {
      setBusy(true); try { const s = await api<SocialSession>("/api/social/sessions", "POST", { provider: aProvider, ...(account ? { accountId: account.accountId, expectedDestinationId: account.destinationId } : {}) });
        setSessions(prev => [s, ...prev.filter(v => v.provider !== aProvider)]);
      } finally { if (mounted.current) setBusy(false); }
    });
  }
  async function verify(a: SocialAccount) {
    patch(a.accountId, { busy: true, error: null });
    try { const capability = await api<SocialCapabilities>("/api/social/verify", "POST", { accountId: a.accountId, destinationId: a.destinationId });
      if (mounted.current) {
        const v = variantsRef.current[a.accountId] ?? blank(), creator = capability.creator;
        patch(a.accountId, { capability, ...(a.provider === "tiktok" ? { consent: false,
          allowComment: v.allowComment && !creator?.comment_disabled, allowDuet: v.allowDuet && !creator?.duet_disabled,
          allowStitch: v.allowStitch && !creator?.stitch_disabled,
          privacy: v.privacy && creator?.privacy_level_options.includes(v.privacy) ? v.privacy : "" } : {}) });
      }
    } catch (e) { if (mounted.current) { patch(a.accountId, { error: code(e), capability: null }); void load(); } }
    finally { if (mounted.current) patch(a.accountId, { busy: false }); }
  }
  async function selectAccount(a: SocialAccount, selected: boolean) {
    if (!selected) { void cancelAi(a.accountId); patch(a.accountId, { proposal: null, aiConsent: false }); }
    patch(a.accountId, { selected }); if (!selected) return;
    void verify(a);
    try { const list = await api<WorkspaceProject[]>(`/api/projects?accountId=${a.accountId}`); if (mounted.current) setProjects(prev => ({ ...prev, [a.accountId]: list })); }
    catch (e) { if (mounted.current) patch(a.accountId, { error: code(e) }); }
  }
  function target(a: SocialAccount, v: Variant): SocialTarget { return { accountId: a.accountId, projectId: v.projectId, destinationId: a.destinationId }; }
  function metadata(a: SocialAccount, v: Variant): SocialMetadata {
    if (a.provider === "x") return { provider: "x", text: v.text, paidPartnership: v.paid, madeWithAi: v.madeWithAi };
    if (a.provider === "linkedin") return { provider: "linkedin", text: v.text, title: v.title, visibility: v.visibility, reshareDisabled: v.reshare };
    if (!v.privacy || !v.consent) throw new ApiError("social_privacy_changed");
    return { provider: "tiktok", text: v.text, privacy: v.privacy, allowComment: v.allowComment, allowDuet: v.allowDuet, allowStitch: v.allowStitch,
      disclosure: v.disclosure, ownBrand: v.ownBrand, brandedContent: v.branded, madeWithAi: v.madeWithAi, musicConsent: true, brandedConsent: v.branded && v.consent };
  }
  function invalid(a: SocialAccount, v: Variant): boolean {
    if (!v.projectId || !v.capability || v.busy || a.status !== "connected") return true;
    if (artifactId ? !v.capability.video : !v.capability.text) return true;
    if (!artifactId && !v.text.trim()) return true;
    return a.provider === "tiktok" && (!artifactId || !v.privacy || !v.consent || (v.disclosure && !v.ownBrand && !v.branded) || (v.branded && v.privacy === "SELF_ONLY"));
  }
  async function preview(a: SocialAccount) {
    const v = variantsRef.current[a.accountId]; if (!v || invalid(a, v)) return;
    const revision = v.revision, source = sourceVersion.current;
    await action(`preview:${a.accountId}`, async () => {
      patch(a.accountId, { busy: true, error: null });
      try {
        const input: SocialDraft = { target: target(a, v), metadata: metadata(a, v), media: artifactId && context?.projectId ? { context: { accountId: context.accountId, projectId: context.projectId }, artifactId } : null };
        const p = await api<SocialPost>("/api/social/posts", "POST", input);
        if (mounted.current) { remember(p); if (sourceVersion.current === source && variantsRef.current[a.accountId]?.revision === revision) patch(a.accountId, { draftId: p.id }); }
      } catch (e) { if (mounted.current) patch(a.accountId, { error: code(e) }); }
      finally { if (mounted.current) patch(a.accountId, { busy: false }); }
    });
  }
  const selected = accounts.filter(a => variants[a.accountId]?.selected);
  async function reviewSaved(p: SocialPost) {
    setApproved(prev => ({ ...prev, [p.id]: false }));
    if (p.payload.metadata.provider === "tiktok") {
      await action(`review:${p.id}`, async () => {
        const cap = await api<SocialCapabilities>("/api/social/verify", "POST", { accountId: p.payload.target.accountId, destinationId: p.payload.target.destinationId });
        if (!mounted.current) return;
        setTikReviews(prev => ({ ...prev, [p.id]: { cap, expires: Date.now() + 300000, privacy: "", comment: false, duet: false, stitch: false, own: false, branded: false, consent: false } }));
        patch(p.payload.target.accountId, { draftId: p.id });
      });
    } else patch(p.payload.target.accountId, { draftId: p.id });
  }
  const checkbox = (label: string, checked: boolean, change: (value: boolean) => void, disabled = false) => <label className="social-check"><input type="checkbox" checked={checked} onChange={e => change(e.target.checked)} disabled={disabled} /> <span>{label}</span></label>;
  const connectionActions = (a: SocialAccount) => <div className="social-actions"><button className="text-button" disabled={busy} onClick={() => { void verify(a); }}><RefreshCw size={13} />{t.verify}</button>
    <button className="text-button" disabled={busy} onClick={() => { void connect(a.provider, a); }}>{t.reconnect}</button>
    {a.status !== "disconnected" && <button className="text-button danger-text" disabled={busy} onClick={() => { void action(`disconnect:${a.accountId}`, async () => { await api("/api/social/disconnect", "POST", { accountId: a.accountId, destinationId: a.destinationId, revoke: false }); patch(a.accountId, { selected: false, capability: null, draftId: null }); await load(); onAccountsChanged?.(); }); }}>{t.disconnect}</button>}
  </div>;
  return <section className="social-panel" aria-labelledby={`${uid}-title`}>
    <header className={mode === "connections" ? "section-heading" : "page-heading"}><div><p className="eyebrow">X · LinkedIn · TikTok</p>{mode === "connections" ? <h2 id={`${uid}-title`}>{t.connections}</h2> : <><h1 id={`${uid}-title`}>{t.title}</h1><p>{t.subtitle}</p></>}</div>
      <button className="button secondary" disabled={loading || busy} onClick={() => { void load(); if (!sessionsLoaded) void restoreSessions(); }}><RefreshCw size={15} />{t.refresh}</button></header>
    {error && <p className="social-alert" role="alert">{message(error)} <button className="text-button" onClick={() => { setError(null); void load(); }}>{t.retry}</button></p>}
    {mode !== "compose" && <section className="panel social-connections" aria-labelledby={`${uid}-connections`} aria-busy={loading}>
      <div className="social-section-title"><KeyRound size={18} /><h2 id={`${uid}-connections`}>{language === "tr" ? "Platform bağlantıları" : "Platform connections"}</h2></div>
      {loading ? <p role="status">{t.loading}</p> : <div className="social-provider-grid">{providers.filter(p => !providerFilter || p === providerFilter).map(p => {
        const s = setup.find(s => s.provider === p);
        return <article className="social-provider-card" key={p}><div className="social-card-heading"><span className={`platform-icon ${p}`}>{p === "linkedin" ? "in" : p === "tiktok" ? "♪" : "𝕏"}</span><h3>{names[p]}</h3><span className={`badge ${s?.available ? "positive" : "demo-badge"}`}>{s?.available ? t.ready : t.disabled}</span></div>
          {s?.reason && <p className="social-help">{message(s.reason)}</p>}
          <button className="button secondary" disabled={busy || loading} onClick={() => { if (s?.available) void connect(p); else { setProvider(p); setPort(p === "x" ? "18477" : "0"); setClientId(""); setSecret(""); const details = document.getElementById(`${uid}-config`) as HTMLDetailsElement | null; if (details) { details.open = true; details.scrollIntoView({ block: "nearest" }); details.querySelector<HTMLSelectElement>("select")?.focus(); } } }}><ExternalLink size={14} />{s?.available ? t.connect : t.configure}</button>
        </article>;
      })}</div>}
      <details className="social-config" id={`${uid}-config`}><summary>{t.configure}</summary><form autoComplete="off" onSubmit={e => {
        e.preventDefault(); void action("config", async () => { setBusy(true);
          try { await api("/api/social/config", "POST", { provider, clientId: clientId.trim(), ...(provider === "tiktok" ? { clientSecret: secret } : {}), callbackPort: Number(port),
            nativePkceEnabled: pkce, loopbackApproved: redirect, organizationAccess: organization, publicApp, audited }); setClientId(""); setSecret(""); await load(); }
          finally { setSecret(""); if (mounted.current) setBusy(false); }
        });
      }}><div className="social-fields"><label>{t.provider}<select value={provider} disabled={busy} onChange={e => { setProvider(e.target.value as SocialProviderId); setClientId(""); setSecret(""); setPort(e.target.value === "x" ? "18477" : "0"); }}>{providers.filter(p => !providerFilter || p === providerFilter).map(p => <option key={p} value={p}>{names[p]}</option>)}</select></label>
        <label>{t.client}<input required value={clientId} maxLength={2048} disabled={busy} autoComplete="off" spellCheck={false} onChange={e => setClientId(e.target.value)} /></label>
        <label>{t.port}<input required type="number" min={provider === "x" ? 1024 : 0} max={65535} disabled={busy} value={port} onChange={e => setPort(e.target.value)} /></label>
        {provider === "tiktok" && <label>{t.secret}<input required type="password" autoComplete="new-password" maxLength={2048} disabled={busy} value={secret} onChange={e => setSecret(e.target.value)} /><small>{t.secretHelp}</small></label>}</div>
        {provider === "x" && checkbox(t.redirect, redirect, setRedirect, busy)}
        {provider === "linkedin" && <>{checkbox(t.pkce, pkce, setPkce, busy)}{checkbox(t.organizations, organization, setOrganization, busy)}</>}
        {provider === "tiktok" && <>{checkbox(t.publicApp, publicApp, setPublicApp, busy)}{checkbox(t.audited, audited, setAudited, busy)}</>}
        <p className="social-help">{t.configNote}</p><p className="social-mono">http://127.0.0.1:{port === "0" ? "*" : port}/oauth/social/{provider}/callback</p>
        <button className="button primary" disabled={busy || !clientId.trim()}><ShieldCheck size={15} />{busy ? t.busy : t.save}</button>
      </form></details>
      {sessions.filter(s => !providerFilter || s.provider === providerFilter).map(s => <div className="social-session" key={s.id} role="status"><strong>{names[s.provider]} · {t.sessionStates[s.state]}</strong>
        {s.error && <p>{message(s.error)}</p>}
        {s.state === "awaiting-browser" && <button className="button secondary" onClick={() => { void action(s.id, async () => { const next = await api<SocialSession>(`/api/social/sessions/${s.id}/open`, "POST", {}); setSessions(prev => prev.map(v => v.id === s.id ? next : v)); }); }}>{t.reopen}</button>}
        {s.state === "select-destination" && <><label>{t.selectDestination}<select value={destinations[s.id] ?? ""} onChange={e => setDestinations(prev => ({ ...prev, [s.id]: e.target.value }))}><option value="">—</option>{s.destinations.map(d => <option key={d.id} value={d.id}>{d.label} · {d.id}</option>)}</select></label>
          <button className="button primary" disabled={!destinations[s.id]} onClick={() => { void action(s.id, async () => { const next = await api<SocialSession>(`/api/social/sessions/${s.id}/select`, "POST", { destinationId: destinations[s.id] }); setSessions(prev => prev.map(v => v.id === s.id ? next : v)); await load(); onAccountsChanged?.(); }); }}>{t.confirmConnection}</button></>}
        {["awaiting-browser", "verifying", "select-destination"].includes(s.state) && <button className="text-button" onClick={() => { void action(s.id, async () => { const next = await api<SocialSession>(`/api/social/sessions/${s.id}/cancel`, "POST", {}); setSessions(prev => prev.map(v => v.id === s.id ? next : v)); }); }}>{t.cancel}</button>}
      </div>)}
      {mode === "connections" && accounts.filter(a => !providerFilter || a.provider === providerFilter).map(a => <article className="social-account-row" key={a.accountId}><div><strong>{names[a.provider]} · {a.displayName}</strong><p className="social-mono">{a.destinationId}</p></div><span className={`badge ${a.status === "connected" ? "positive" : "suggested"}`}>{language === "tr" ? a.status === "connected" ? "Bağlı" : a.status === "disconnected" ? "Bağlantı kesildi" : "Yeniden giriş gerekli" : a.status}</span>{connectionActions(a)}</article>)}
    </section>}
    {mode === "compose" && <div className="compose-connections"><span><ShieldCheck size={15} />{language === "tr" ? `${accounts.filter(a => a.status === "connected").length} bağlı sosyal hesap` : `${accounts.filter(a => a.status === "connected").length} connected social accounts`}</span><button className="text-button" onClick={onOpenAccounts}>{language === "tr" ? "Hesapları yönet" : "Manage accounts"}<ExternalLink size={13} /></button></div>}
    {mode !== "connections" && <><section className="social-composer" aria-labelledby={`${uid}-compose`}><div className="social-section-title"><Send size={18} /><h2 id={`${uid}-compose`}>{t.compose}</h2><span className="badge">{selected.length} {t.selected}</span></div>
      <div className="panel social-source"><label>{t.source}<select value={artifactId} onChange={e => { setArtifactId(e.target.value); setVideo(null); sourceVersion.current++; for (const id of aiRequests.current.keys()) void cancelAi(id);
        setVariants(prev => Object.fromEntries(Object.entries(prev).map(([id, v]) => [id, { ...v, revision: v.revision + 1, draftId: null, consent: false, aiConsent: false, proposal: null, aiBusy: false, aiState: "idle" }]))); }}><option value="">{t.noMedia}</option>{artifacts.map(a => <option value={a.id} key={a.id}>{a.filename} · {a.probe?.duration.toFixed(1)}s</option>)}</select></label>
        <p className="social-help">{context?.projectId ? `${context.accountId} / ${context.projectId}` : t.noSource}</p><p className="social-help">{t.sourceHelp}</p>
        {artifactId && context?.projectId && <button className="text-button" onClick={() => { const version = sourceVersion.current; void action("video", async () => { const blob = await mediaBlob(`/api/media/${artifactId}/content?accountId=${context.accountId}&projectId=${context.projectId}`, abort.current.signal); if (mounted.current && version === sourceVersion.current) setVideo(URL.createObjectURL(blob)); }); }}>{t.previewVideo}</button>}
        {video && <video className="social-video" controls src={video} preload="metadata" />}
        <label>{t.base}<textarea rows={3} value={base} maxLength={10000} onChange={e => setBase(e.target.value)} /></label><button className="button secondary" disabled={!selected.length} onClick={() => selected.forEach(a => patch(a.accountId, { text: base }, true))}>{t.applyBase}</button>
      </div>
      <h3 className="social-subtitle">{t.targets}</h3>{!accounts.length && <p className="inline-empty">{t.noAccounts}</p>}
      <div className="social-variants">{accounts.map(a => {
        const v = variants[a.accountId] ?? blank(), cap = v.capability, post = posts.find(p => p.id === v.draftId);
        const checks = (key: "allowComment" | "allowDuet" | "allowStitch", label: string, disabled: boolean) => checkbox(label, v[key], value => patch(a.accountId, { [key]: value }, true), disabled);
        return <article className={`panel social-variant ${v.selected ? "social-selected" : ""}`} key={a.accountId}>
          <div className="social-card-heading">{checkbox(`${names[a.provider]} · ${a.displayName}`, v.selected, selected => { void selectAccount(a, selected); }, a.status !== "connected")}<span className={`badge ${a.status === "connected" ? "positive" : "demo-badge"}`}>{a.status}</span></div>
          <p className="social-mono">{a.destinationId}</p>
          <div className="social-actions"><button className="text-button" disabled={v.busy} onClick={() => { void verify(a); }}><RefreshCw size={13} />{t.verify}</button>
            <button className="text-button" disabled={busy || v.busy} onClick={() => { void connect(a.provider, a); }}>{t.reconnect}</button>
            <button className="text-button danger-text" onClick={() => { void action(`disconnect:${a.accountId}`, async () => { await api("/api/social/disconnect", "POST", { accountId: a.accountId, destinationId: a.destinationId, revoke: false }); patch(a.accountId, { selected: false, capability: null, draftId: null }); await load(); onAccountsChanged?.(); }); }}>{t.disconnect}</button>
            {a.provider !== "linkedin" && <button className="text-button danger-text" onClick={() => { void action(`disconnect:${a.accountId}`, async () => { await api("/api/social/disconnect", "POST", { accountId: a.accountId, destinationId: a.destinationId, revoke: true }); patch(a.accountId, { selected: false, capability: null, draftId: null }); await load(); onAccountsChanged?.(); }); }}>{t.revoke}</button>}
          </div>
          {v.selected && <fieldset disabled={v.busy}><legend className="social-sr">{a.displayName}</legend>
            <label>{t.project}<select value={v.projectId} onChange={e => { patch(a.accountId, { projectId: e.target.value }, true); const dest = { accountId: a.accountId, projectId: e.target.value, destinationId: a.destinationId }; if (e.target.value) void api<SocialPost[]>(`/api/social/posts?${new URLSearchParams(dest)}`).then(list => { if (mounted.current) list.forEach(remember); }).catch(e => patch(a.accountId, { error: code(e) })); }}><option value="">{t.chooseProject}</option>{(projects[a.accountId] ?? []).map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
            {!projects[a.accountId]?.length && <div className="social-project-create"><label>{t.projectName}<input value={projectNames[a.accountId] ?? ""} maxLength={100} onChange={e => setProjectNames(prev => ({ ...prev, [a.accountId]: e.target.value }))} /></label><button className="button secondary" disabled={!projectNames[a.accountId]?.trim()} onClick={() => { void action(`project:${a.accountId}`, async () => { const project = await api<WorkspaceProject>("/api/projects", "POST", { accountId: a.accountId, name: projectNames[a.accountId], description: "" }); setProjects(prev => ({ ...prev, [a.accountId]: [...prev[a.accountId] ?? [], project] })); patch(a.accountId, { projectId: project.id }, true); }); }}><Plus size={14} />{t.addProject}</button></div>}
            {cap?.reasons.map(reason => <p className="social-help social-warning" key={reason}>{message(reason)}</p>)}
            {cap && <p className="social-help">{t.mediaLimit}: {(cap.maxBytes / 1024 ** 2).toFixed(0)} MB · {cap.maxDuration} {t.seconds}{!cap.readback ? ` · ${t.readback}` : ""}</p>}
            <label>{t.text}<textarea rows={4} value={v.text} maxLength={a.provider === "tiktok" ? 2200 : a.provider === "linkedin" ? 3000 : 10000} onChange={e => patch(a.accountId, { text: e.target.value }, true)} /></label>
            {a.provider === "x" ? <XTextCounter text={v.text} client={client} language={language} /> : <span className="social-help">{v.text.length} / {a.provider === "tiktok" ? 2200 : 3000}</span>}
            {a.provider === "linkedin" && <><label>{t.videoTitle}<input value={v.title} maxLength={200} onChange={e => patch(a.accountId, { title: e.target.value }, true)} /></label><label>{t.visibility}<select value={v.visibility} onChange={e => patch(a.accountId, { visibility: e.target.value as Variant["visibility"] }, true)}><option value="PUBLIC">{t.public}</option>{a.destinationKind !== "organization" && <option value="CONNECTIONS">{t.connectionsOnly}</option>}</select></label>{checkbox(t.reshare, v.reshare, reshare => patch(a.accountId, { reshare }, true))}</>}
            {a.provider === "x" && checkbox(t.paid, v.paid, paid => patch(a.accountId, { paid }, true))}
            {a.provider !== "linkedin" && checkbox(t.aiGenerated, v.madeWithAi, madeWithAi => patch(a.accountId, { madeWithAi }, true))}
            {a.provider === "tiktok" && <div className="social-tiktok"><p><strong>{t.creator}: {cap?.creator?.creator_nickname ?? "—"}</strong></p><p className="social-help">{t.noDefault}</p>
              <label>{t.privacy}<select value={v.privacy} onChange={e => patch(a.accountId, { privacy: e.target.value as Variant["privacy"] }, true)}><option value="">—</option>{cap?.creator?.privacy_level_options.map(option => <option value={option} key={option} disabled={(v.branded && option === "SELF_ONLY") || (!setup.find(s => s.provider === "tiktok")?.audited && option !== "SELF_ONLY")}>{option}</option>)}</select></label>
              {checks("allowComment", t.allowComment, !!cap?.creator?.comment_disabled)}{checks("allowDuet", t.allowDuet, !!cap?.creator?.duet_disabled)}{checks("allowStitch", t.allowStitch, !!cap?.creator?.stitch_disabled)}
              {checkbox(t.disclosure, v.disclosure, disclosure => patch(a.accountId, { disclosure, ownBrand: false, branded: false }, true))}
              {v.disclosure && <div className="social-disclosure">{checkbox(t.ownBrand, v.ownBrand, ownBrand => patch(a.accountId, { ownBrand }, true))}{checkbox(t.branded, v.branded, branded => patch(a.accountId, { branded }, true), v.privacy === "SELF_ONLY")}
                {v.privacy === "SELF_ONLY" && <p className="social-help">{t.brandedPrivate}</p>}<p className="social-help">{v.branded ? t.partnership : v.ownBrand ? t.promotional : t.disclosureRequired}</p></div>}
              <p className="social-help">{t.consentPrefix} {v.branded && <><a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">{t.brandedPolicy}</a> {t.and} </>}<a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">{t.music}</a>{t.consentSuffix}</p>
              {checkbox(t.consent, v.consent, consent => patch(a.accountId, { consent, draftId: null, revision: v.revision + 1 }))}<p className="social-help">{t.processingNote}</p>
            </div>}
            <button className="button secondary" disabled={invalid(a, v)} onClick={() => { void preview(a); }}>{v.busy ? <LoaderCircle size={15} className="spinning" /> : <ShieldCheck size={15} />}{t.preview}</button>
            {post?.state === "review" && <p className="social-help"><Check size={13} /> {t.immutable} · {post.digest.slice(0, 12)}</p>}
          </fieldset>}
          {v.selected && <section className="social-ai" aria-label={`${t.aiTitle} · ${a.displayName}`} aria-busy={v.aiBusy}>
            <div className="social-card-heading"><h3>{t.aiTitle}</h3><button className="text-button" disabled={aiLoading || v.aiBusy} onClick={() => { void loadAiSetup(true); }}><RefreshCw size={13} />{t.aiRefresh}</button></div>
            <p className="social-help">{t.aiNote}</p>
            <p className="social-mono">{v.projectId ? `${a.accountId} / ${v.projectId} / ${a.destinationId}` : t.chooseProject}</p>
            {aiLoading ? <p className="social-help" role="status">{t.aiDiscovering}</p> : (aiSetupError || aiSetup?.error || !aiSetup?.available) && <p className="social-help social-warning">{message(aiSetupError ?? aiSetup?.error ?? "social_ai_unavailable")}</p>}
            <label>{t.aiModel}<select value={v.aiModelId} disabled={aiLoading || !aiSetup?.available} onChange={e => editAi(a.accountId, { aiModelId: e.target.value })}><option value="">{t.aiChooseModel}</option>{aiSetup?.models.map(model => <option key={model} value={model}>{model}</option>)}</select></label>
            <label>{t.aiInstruction}<textarea rows={2} maxLength={2000} value={v.aiInstruction} onChange={e => editAi(a.accountId, { aiInstruction: e.target.value })} /></label>
            {checkbox(t.aiMemory, v.aiIncludeMemory, aiIncludeMemory => editAi(a.accountId, { aiIncludeMemory }), !v.projectId)}<p className="social-help">{t.aiMemoryHelp}</p>
            {checkbox(t.aiConsent, v.aiConsent, aiConsent => editAi(a.accountId, { aiConsent }), !v.projectId || !aiSetup?.available)}
            <div className="social-actions"><button className="button secondary" disabled={!v.projectId || !v.aiInstruction.trim() || !v.aiConsent || !aiSetup?.available || !aiSetup.models.includes(v.aiModelId) || v.aiBusy || v.busy || aiLoading} onClick={() => { void suggest(a); }}>{v.aiBusy ? <LoaderCircle size={15} className="spinning" /> : null}{t.suggest}</button>
              {v.aiBusy && <button className="button secondary" onClick={() => { void cancelAi(a.accountId, true); }}><StopCircle size={14} />{t.aiCancel}</button>}</div>
            <p className="social-help" role="status">{v.aiState === "running" ? t.aiRunning : v.aiState === "cancelled" ? t.aiCancelled : v.aiState === "applied" ? t.aiApplied : v.aiState === "rejected" ? t.aiRejected : ""}</p>
            {v.aiError && <p className="social-alert" role="alert">{message(v.aiError)}</p>}
            {v.proposal && <div className="social-ai-proposal"><h3>{t.proposal}</h3><pre>{v.proposal.text}</pre><p className="social-help">{v.proposal.summary}</p>
              <p className="social-mono">{v.proposal.modelId} · {v.proposal.memoryCount} {t.aiNotes}{v.proposal.memoryTruncated ? ` · ${t.aiTruncated}` : ""}</p>
              <details><summary>{t.aiProvenance}</summary><p className="social-mono">{v.proposal.digest}<br />{v.proposal.target.accountId} / {v.proposal.target.projectId}<br />{v.proposal.target.destinationId}</p></details>
              <div className="social-actions"><button className="button secondary" onClick={() => patch(a.accountId, { text: v.proposal!.text, proposal: null, aiState: "applied" }, true)}>{t.applyProposal}</button>
                <button className="text-button" onClick={() => patch(a.accountId, { proposal: null, aiState: "rejected" })}>{t.aiReject}</button></div></div>}
          </section>}
          {v.error && <p className="social-alert" role="alert">{message(v.error)}</p>}
        </article>;
      })}</div>
      <div className="social-compose-footer"><p className="social-help">{t.notAtomic}</p><button className="button primary" disabled={!selected.some(a => !invalid(a, variants[a.accountId]!))} onClick={() => { void Promise.allSettled(selected.map(preview)); }}>{t.previews}</button></div>
    </section>
    <section className="social-receipts" aria-labelledby={`${uid}-review`}><div className="social-section-title"><ShieldCheck size={18} /><h2 id={`${uid}-review`}>{t.review}</h2></div>
      {!posts.length && <p className="inline-empty">{t.emptyReceipts}</p>}
      {posts.map(p => {
        const activeDraft = variants[p.payload.target.accountId]?.draftId === p.id;
        const approvable = p.state === "review" || (p.state === "accepted" && p.receipt.providerState === "MEDIA_READY" && !p.dispatchRevoked);
        const tik = p.payload.metadata.provider === "tiktok" ? p.payload.metadata : null, review = tikReviews[p.id];
        const tikCurrent = !tik || !!review && review.expires > Date.now();
        const tikMatches = !tik || !!review && review.cap.video && review.cap.creator?.privacy_level_options.includes(tik.privacy) &&
          !(tik.allowComment && review.cap.creator.comment_disabled) && !(tik.allowDuet && review.cap.creator.duet_disabled) && !(tik.allowStitch && review.cap.creator.stitch_disabled) &&
          review.privacy === tik.privacy && review.comment === tik.allowComment && review.duet === tik.allowDuet && review.stitch === tik.allowStitch && review.own === tik.ownBrand && review.branded === tik.brandedContent;
        return <article className="panel social-receipt" key={p.id}><div className="social-card-heading"><h3>{names[p.payload.metadata.provider]}</h3><span className={`badge ${p.state === "succeeded" ? "positive" : "demo-badge"}`} role="status">{t.states[p.state]}</span></div>
          <p className="social-mono">{p.payload.target.accountId} / {p.payload.target.projectId}<br />{p.payload.target.destinationId}</p><pre>{p.payload.metadata.text}</pre>
          {p.payload.media && activeDraft && approvable && <SocialVideoPreview key={`${p.id}:${p.payload.media.sha256}`} language={language}
            input={{ context: p.payload.media.context, artifactId: artifacts.find(a => a.id === p.payload.media?.artifactId && a.sha256 === p.payload.media.sha256)?.proxyId ?? p.payload.media.artifactId }}
            loader={loadPreview} onReady={ready => setMediaReady(prev => prev[p.id] === ready ? prev : { ...prev, [p.id]: ready })} />}
          {p.payload.scheduleBinding && <p className="social-help">{language === "tr" ? "Planlanan zaman / gerçek gönderim: şimdi onay sonrası" : "Scheduled time / actual dispatch: after approval now"}<br />{new Date(p.payload.scheduleBinding.dueAt).toLocaleString(language)} · {language === "tr" ? "İnceleme sonu" : "Review expires"}: {new Date(p.payload.scheduleBinding.reviewUntil).toLocaleString(language)}</p>}
          <details><summary>{t.immutable}</summary><pre>{JSON.stringify(p.payload.metadata, null, 2)}</pre><p className="social-mono">{t.hash}: {p.payload.media?.sha256 ?? "—"}<br />{t.digest}: {p.digest}</p></details>
          {p.error && <p className="social-help social-warning">{message(p.error)}</p>}
          {approvable && (!activeDraft || !tikCurrent) && <button className="button secondary" onClick={() => { void reviewSaved(p); }}>{t.reviewSaved}</button>}
          {approvable && activeDraft && tik && review && tikCurrent && <div className="social-tiktok">
            <h3>{t.creator}: {review.cap.creator?.creator_nickname ?? "—"}</h3><p className="social-help">{t.noDefault}</p>
            <label>{t.privacy}<select value={review.privacy} onChange={e => setTikReviews(prev => ({ ...prev, [p.id]: { ...review, privacy: e.target.value, consent: false } }))}><option value="">—</option>{review.cap.creator?.privacy_level_options.map(option => <option value={option} key={option}>{option}</option>)}</select></label>
            {([['comment', t.allowComment, review.cap.creator?.comment_disabled], ['duet', t.allowDuet, review.cap.creator?.duet_disabled], ['stitch', t.allowStitch, review.cap.creator?.stitch_disabled], ['own', t.ownBrand, false], ['branded', t.branded, review.privacy === 'SELF_ONLY']] as const).map(([field, label, disabled]) => <span key={field}>{checkbox(label, review[field], value => setTikReviews(prev => ({ ...prev, [p.id]: { ...review, [field]: value, consent: false } })), !!disabled)}</span>)}
            <p className="social-help">{review.branded ? t.partnership : review.own ? t.promotional : ""}</p>
            <p className="social-help">{t.consentPrefix} {tik.brandedContent && <><a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">{t.brandedPolicy}</a> {t.and} </>}<a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">{t.music}</a>{t.consentSuffix}</p>
            {!tikMatches && <p className="social-help social-warning">{language === "tr" ? "Bu değişmez önizlemedeki gizlilik, etkileşim ve marka seçimlerini tekrar inceleyip seçin. Farklı seçimler için düzenleyicide yeni önizleme oluşturun." : "Review and reselect this immutable preview’s privacy, interaction and brand settings. For different settings, create a new preview in the composer."}</p>}
            {checkbox(t.consent, review.consent, consent => setTikReviews(prev => ({ ...prev, [p.id]: { ...review, consent } })), !tikMatches)}
          </div>}
          {approvable && activeDraft && <div className="social-approval">{checkbox(t.approval, !!approved[p.id], value => setApproved(prev => ({ ...prev, [p.id]: value })), (!!p.payload.media && !mediaReady[p.id]) || !tikCurrent || !tikMatches || !!tik && !review?.consent)}
            <button className="button primary" disabled={!approved[p.id] || (!!p.payload.media && !mediaReady[p.id]) || !tikCurrent || !tikMatches || !!tik && !review?.consent} onClick={() => { void action(`post:${p.id}`, async () => { setApproved(prev => ({ ...prev, [p.id]: false })); if (tik) setTikReviews(prev => ({ ...prev, [p.id]: { ...prev[p.id]!, consent: false } })); remember(await api<SocialPost>(`/api/social/posts/${p.id}/approve`, "POST", { target: p.payload.target, digest: p.digest, ...(tik ? { tiktokConsent: true } : {}) })); }); }}><Send size={15} />{t.approve}</button></div>}
          <div className="social-actions">{["review", "uploading", "processing", "uncertain", "accepted"].includes(p.state) && !p.dispatchRevoked && <button className="text-button" onClick={() => { void action(`post:${p.id}`, async () => remember(await api<SocialPost>(`/api/social/posts/${p.id}/stop`, "POST", { target: p.payload.target }))); }}><StopCircle size={14} />{t.stop}</button>}
            {["processing", "uncertain", "accepted"].includes(p.state) && <button className="text-button" onClick={() => { void action(`post:${p.id}`, async () => remember(await api<SocialPost>(`/api/social/posts/${p.id}/reconcile`, "POST", { target: p.payload.target }))); }}><RefreshCw size={14} />{t.reconcile}</button>}
            {p.receipt.publicUrl && /^https:\/\/(x\.com|www\.linkedin\.com)\//.test(p.receipt.publicUrl) && <a className="text-button" href={p.receipt.publicUrl} target="_blank" rel="noreferrer">{t.openPost}<ExternalLink size={13} /></a>}</div>
          {(p.receipt.jobId || p.receipt.postIds.length > 0) && <p className="social-mono">{p.receipt.providerState} · {p.receipt.jobId ?? p.receipt.postIds.join(", ")}</p>}
        </article>;
      })}
    </section></>}
  </section>;
}

function XTextCounter({ text, client, language }: { text: string; client: typeof request; language: "tr" | "en" }) {
  const [metrics, setMetrics] = useState<{ weightedLength: number; maxWeightedLength: number; valid: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setMetrics(null);
    const timer = setTimeout(() => { void client<{ weightedLength: number; maxWeightedLength: number; valid: boolean }>("/api/social/x/text-metrics", "POST", { text }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setMetrics(value); }).catch(() => {}); }, 200);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [text, client]);
  return <span className={`social-help ${metrics && !metrics.valid && text ? "social-warning" : ""}`} role="status">{metrics ? `${metrics.weightedLength} / ${metrics.maxWeightedLength}` : "… / 280"} · {language === "tr" ? "X ağırlıklı karakter" : "X weighted characters"}</span>;
}

function SocialVideoPreview({ language, input, loader, onReady }: { language: "en" | "tr"; input: { context: SocialContext; artifactId: string };
  loader: NonNullable<SocialPanelProps["loadPreview"]>; onReady: (ready: boolean) => void }) {
  const t = socialCopy[language], [url, setUrl] = useState<string | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const ready = useRef(onReady); ready.current = onReady;
  useEffect(() => {
    const abort = new AbortController(); let objectUrl: string | null = null;
    ready.current(false); setFailed(false); setUrl(null);
    void loader(input, abort.signal).then(blob => {
      if (abort.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [input.artifactId, input.context.accountId, input.context.projectId, loader, attempt]);
  return <div className="social-media-preview">{url && <video className="social-video" controls src={url} preload="metadata"
    onLoadedMetadata={() => ready.current(true)} onError={() => { ready.current(false); setFailed(true); }} />}
    {failed ? <p className="social-help social-warning">{t.previewUnavailable} <button className="text-button" onClick={() => setAttempt(v => v + 1)}>{t.retry}</button></p>
      : !url && <p className="social-help" role="status">{t.loading}</p>}
  </div>;
}
