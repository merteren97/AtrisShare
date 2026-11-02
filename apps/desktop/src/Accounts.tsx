import { useEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, CircleAlert, ExternalLink, FolderKanban, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { WorkspaceAccount } from "../../../packages/domain/src/workspace.js";
import type { YouTubeSession, YouTubeSetup } from "../../../packages/domain/src/youtube.js";
import { ApiError, request } from "./api";
import type { TextKey } from "./i18n";
import { YouTubeSetup as YouTubeAppSetup } from "./YouTubeSetup";
import { SocialPanel } from "./SocialPanel";

const platformNames = { youtube: "YouTube", x: "X", tiktok: "TikTok", linkedin: "LinkedIn" };
export function accountStatusKey(account: WorkspaceAccount): TextKey {
  return account.status === "local" ? "localOnly" : account.status === "demo" ? "legacyLocal" : account.status === "connected" ? "socialConnected" : account.status === "disconnected" ? "socialDisconnected" : "socialReauth";
}
export function PlatformIcon({ platform }: { platform: WorkspaceAccount["platform"] }) {
  return <span className={`platform-icon ${platform}`} aria-hidden="true">{platform === "local" ? <FolderKanban size={15} /> : platform === "youtube" ? "▶" : platform === "linkedin" ? "in" : platform === "tiktok" ? "♪" : "𝕏"}</span>;
}
const active = (session: YouTubeSession | null) => session && ["awaiting-browser", "verifying", "select-channel"].includes(session.state);
function restoreSession(): string | null { try { return sessionStorage.getItem("atris-share-youtube-session"); } catch { return null; } }

export function Accounts({ accounts, selectedId, vaultAvailable, loading, t, errorText, refresh, choose, language }: {
  accounts: WorkspaceAccount[]; selectedId: string | undefined; vaultAvailable: boolean; loading: boolean;
  t: (key: TextKey) => string; errorText: (error: unknown) => string; refresh: () => Promise<void>;
  choose: (accountId: string) => void;
  language: "tr" | "en";
}) {
  const [setup, setSetup] = useState<YouTubeSetup | null>(null);
  const [provider, setProvider] = useState<keyof typeof platformNames>("youtube");
  const [selectedChannel, setSelectedChannel] = useState("");
  const [session, setSession] = useState<YouTubeSession | null>(null);
  const [channel, setChannel] = useState("");
  const [reconnect, setReconnect] = useState<WorkspaceAccount | null>(null);
  const [disconnect, setDisconnect] = useState<WorkspaceAccount | null>(null);
  const [revoke, setRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<TextKey | null>(null);
  const generation = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const channelInput = useRef<HTMLInputElement | null>(null);
  const setupAbort = useRef<AbortController | null>(null);
  function saveSession(value: YouTubeSession | null) {
    setSession(value);
    try {
      if (value && active(value)) sessionStorage.setItem("atris-share-youtube-session", value.id);
      else sessionStorage.removeItem("atris-share-youtube-session");
    } catch { /* The current view retains the session. */ }
  }
  async function loadSetup() {
    setupAbort.current?.abort();
    const abort = new AbortController(); setupAbort.current = abort;
    try {
      const result = await request<YouTubeSetup>("/api/youtube", "GET", undefined, abort.signal);
      const id = restoreSession();
      if (id && !session) {
        try {
          const value = await request<YouTubeSession>(`/api/youtube/sessions/${id}`, "GET", undefined, abort.signal);
          if (!abort.signal.aborted) {
            saveSession(value); setChannel(value.expectedChannelId);
            if (value.accountId && active(value)) setReconnect(accounts.find(account => account.id === value.accountId) ?? null);
          }
        } catch (failure) {
          if (failure instanceof ApiError && failure.code === "youtube_session_not_found") {
            if (!abort.signal.aborted) saveSession(null);
          } else throw failure;
        }
      }
      if (!abort.signal.aborted) { setSetup(result); setError(null); }
    } catch (failure) { if (!abort.signal.aborted) setError(failure); }
  }
  useEffect(() => {
    void loadSetup();
    return () => { ++generation.current; setupAbort.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!session || !active(session) || session.state === "select-channel" || busy) return;
    const id = session.id;
    const version = generation.current;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await request<YouTubeSession>(`/api/youtube/sessions/${id}`, "GET", undefined, abort.signal);
        if (abort.signal.aborted || version !== generation.current) return;
        saveSession(result); setError(null);
        if (result.state === "connected") { setReconnect(null); setChannel(""); await refresh(); }
        else if (active(result)) timer = setTimeout(() => { void poll(); }, 1800);
      } catch (failure) {
        if (!abort.signal.aborted && version === generation.current) {
          if (failure instanceof ApiError && failure.code === "youtube_session_not_found") saveSession(null);
          setError(failure);
          timer = setTimeout(() => { void poll(); }, 3500);
        }
      }
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [session?.id, session?.state, busy, refresh]);

  async function act(action: () => Promise<void>) {
    if (busy) return;
    ++generation.current; setBusy(true); setError(null); setNotice(null);
    try { await action(); }
    catch (failure) { setError(failure); await refresh(); }
    finally { setBusy(false); }
  }
  function connect(event: FormEvent) {
    event.preventDefault();
    void act(async () => {
      const result = await request<YouTubeSession>("/api/youtube/sessions", "POST", {
        ...(reconnect ? { expectedChannelId: reconnect.destinationId, accountId: reconnect.id } : channel.trim() ? { expectedChannelId: channel.trim() } : {})
      });
      setSelectedChannel(""); saveSession(result);
    });
  }
  function prepareReconnect(account: WorkspaceAccount) {
    setReconnect(account); setChannel(account.destinationId); setError(null); setNotice(null);
    channelInput.current?.focus(); channelInput.current?.scrollIntoView({ block: "center", behavior: "instant" });
  }
  const unavailable = setup && (!setup.configured || !vaultAvailable);
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t("accounts")}</p><h1>{t("accountTitle")}</h1><p>{t("accountDescription")}</p></div><span className="badge positive"><ShieldCheck size={13} />{accounts.filter(a => a.status === "connected").length} {t("connectedAccounts")}</span></div>
    <div className="account-provider-picker" aria-label={t("platform")}>{(Object.keys(platformNames) as (keyof typeof platformNames)[]).map(p => <button key={p} className={provider === p ? "is-selected" : ""} aria-pressed={provider === p} disabled={!!active(session) && p !== "youtube"} onClick={() => setProvider(p)}><PlatformIcon platform={p} /><strong>{platformNames[p]}</strong><span>{accounts.filter(a => a.platform === p && a.status === "connected").length || t("connectAccount")}</span></button>)}</div>
    {provider === "youtube" && session?.state === "connected" && <div className="account-success" role="status"><Check size={20} /><div><strong>{t("youtubeConnected")}</strong><p>{accounts.find(a => a.id === session.accountId)?.displayName ?? session.expectedChannelId}</p></div><ShieldCheck size={20} /></div>}
    {provider !== "youtube" ? <SocialPanel key={provider} mode="connections" providerFilter={provider} context={null} language={language} onAccountsChanged={() => { void refresh(); }} /> : <>
    <section className="panel youtube-connect" aria-labelledby="youtube-connect-title">
      <div className="youtube-connect-heading"><PlatformIcon platform="youtube" /><div><h2 id="youtube-connect-title">{t("connectYouTube")}</h2><p>{t("youtubeDescription")}</p></div><span className="badge positive">OAuth · PKCE</span></div>
      <div className="connection-steps"><span className={setup?.configured ? "is-complete" : "is-current"}>1 <strong>{t("appSetup")}</strong></span><span className={active(session) ? "is-current" : ""}>2 <strong>{t("googleSignIn")}</strong></span><span className={session?.state === "select-channel" || session?.state === "connected" ? "is-current" : ""}>3 <strong>{t("confirmChannel")}</strong></span></div>
      <YouTubeAppSetup language={language} onConfigured={() => { void loadSetup(); }} errorText={errorText} />
      {!setup ? <div className="section-note">{t("youtubeSetupLoading")} <button className="text-button" disabled={busy} onClick={() => { void loadSetup(); }}>{t("retry")}</button></div>
        : unavailable ? <div className="youtube-setup-note"><ShieldCheck size={18} /><div><strong>{!vaultAvailable ? t("vaultUnavailable") : t("youtubeNotConfigured")}</strong><p>{!vaultAvailable ? t("youtubeVaultRequired") : t("youtubeSetupHelp")}</p></div></div>
        : <form onSubmit={connect} className="youtube-connect-form">
          <details className="youtube-channel-advanced" open={!!reconnect || undefined}><summary>{t("expectedChannelOptional")}</summary><label className="form-field">{t("expectedChannel")}<input ref={channelInput} value={reconnect?.destinationId ?? channel} onChange={event => setChannel(event.target.value)} readOnly={!!reconnect}
            pattern={"UC[A-Za-z0-9_\\-]{22}"} maxLength={24} placeholder="UC…" autoComplete="off" spellCheck={false} disabled={busy || !!active(session)} aria-describedby="youtube-channel-help" /></label><p id="youtube-channel-help" className="field-help">{reconnect ? `${reconnect.displayName} · ` : ""}{t("expectedChannelHelp")}</p></details>
          <button className="button primary" type="submit" disabled={busy || !!active(session) || loading}><ExternalLink size={15} />{busy ? t("saving") : reconnect ? t("reconnectYouTube") : t("continueGoogle")}</button>
          {reconnect && !active(session) && <button className="text-button" type="button" disabled={busy} onClick={() => { setReconnect(null); setChannel(""); }}>{t("cancel")}</button>}
        </form>}
      <p className="section-note">{t("youtubeScopeHelp")}</p>
      {session && session.state !== "connected" && <div className="youtube-session" role="status" aria-live="polite">
        {active(session) ? <LoaderCircle size={17} className="spinning" /> : <CircleAlert size={17} />}
        <div><strong>{t(session.state === "select-channel" ? "confirmChannel" : session.state === "verifying" ? "youtubeVerifying" : session.state === "awaiting-browser" ? "youtubeAwaiting" : session.state === "cancelled" ? "youtubeCancelled" : "youtubeFailed")}</strong>
          {session.expectedChannelId && <p className="session-destination">{session.expectedChannelId}</p>}
          {session.state === "select-channel" && <div className="youtube-channel-selection"><label className="form-field">{t("confirmChannel")}<select value={selectedChannel} onChange={e => setSelectedChannel(e.target.value)} disabled={busy}><option value="">{t("chooseChannel")}</option>{session.channels?.map(c => <option key={c.id} value={c.id}>{c.title} · {c.id}</option>)}</select></label><button className="button primary" disabled={busy || !selectedChannel} onClick={() => { void act(async () => { const result = await request<YouTubeSession>(`/api/youtube/sessions/${session.id}/select`, "POST", { channelId: selectedChannel }); saveSession(result); if (result.state === "connected") { setChannel(""); await refresh(); if (result.accountId) choose(result.accountId); } }); }}><Check size={15} />{t("confirmConnection")}</button></div>}
          {session.error && <p>{errorText(new ApiError(session.error))}</p>}
          {session.state === "awaiting-browser" && <p>{t(session.browserOpened ? "youtubeBrowserHelp" : "youtubeBrowserFailed")}</p>}
        </div>
        {active(session) && <div className="youtube-session-actions">
          {session.state === "awaiting-browser" && <button className="text-button" disabled={busy} onClick={() => { void act(async () => saveSession(await request<YouTubeSession>(`/api/youtube/sessions/${session.id}/open`, "POST"))); }}>{t("openBrowser")}</button>}
          <button className="text-button" disabled={busy} onClick={() => { void act(async () => saveSession(await request<YouTubeSession>(`/api/youtube/sessions/${session.id}/cancel`, "POST"))); }}>{t("cancel")}</button>
        </div>}
      </div>}
      {!!error && <p className="form-error" role="alert">{errorText(error)}</p>}
      {notice && <p className="section-note" role="status">{t(notice)}</p>}
    </section>
    <div className="section-heading"><h2>{t("connectedChannels")}</h2></div>
    {!accounts.some(a => a.platform === "youtube" && a.status !== "demo") && <div className="inline-empty"><ShieldCheck size={18} />{t("noConnectedChannels")}</div>}
    <div className="account-grid">{accounts.filter(item => item.platform === "youtube" && item.status !== "demo").map(item => <article className={`account-card ${item.id === selectedId ? "selected-account" : ""}`} key={item.id}>
      <div className="account-card-top"><PlatformIcon platform={item.platform} /><span className={`badge ${item.status === "connected" ? "positive" : "suggested"}`}>{t(accountStatusKey(item))}</span></div><h2>{item.displayName}</h2><p>YouTube</p>
      <div className="destination"><span>{t("target")}</span><code>{item.destinationId}</code></div>
      <p className="account-disclaimer">{t(item.status === "demo" ? "demoNotice" : item.platform !== "youtube" ? item.status === "connected" ? "connectedAccountNotice" : "disconnectedAccountNotice" : item.status === "connected" ? "youtubeAccountNotice" : "youtubeDisconnectedNotice")}</p>
      {item.connection && <details className="connection-details"><summary>{t("verifiedIdentity")}</summary><code>{item.connection.providerSubjectId}</code><ul>{item.connection.grantedScopes.map(scope => <li key={scope}>{scope}</li>)}</ul><time dateTime={item.connection.verifiedAt}>{new Date(item.connection.verifiedAt).toLocaleString()}</time></details>}
      <button className={`button ${item.id === selectedId ? "subtle" : "secondary"}`} disabled={item.id === selectedId || loading} onClick={() => choose(item.id)}>{item.id === selectedId && <Check size={15} />}{item.id === selectedId ? t("selected") : t("selectAccount")}</button>
      {item.connection && <div className="account-connection-actions">
        {item.status === "connected" && <button className="text-button" disabled={busy || !!active(session)} onClick={() => { void act(async () => {
          await request("/api/youtube/verify", "POST", { accountId: item.id, destinationId: item.destinationId }); setNotice("youtubeVerified"); await refresh();
        }); }}><RefreshCw size={13} />{t("verifyConnection")}</button>}
        <button className="text-button" disabled={busy || !!active(session) || !!unavailable || !setup} onClick={() => prepareReconnect(item)}>{t("reconnectYouTube")}</button>
        {item.status !== "disconnected" && <button className="text-button danger-text" disabled={busy || !!active(session)} onClick={() => {
          returnFocus.current = document.activeElement as HTMLElement; setDisconnect(item); setRevoke(false); setError(null);
        }}>{t("disconnectYouTube")}</button>}
      </div>}
    </article>)}</div></>}
    <Dialog.Root open={disconnect !== null} onOpenChange={value => { if (!value && !busy) setDisconnect(null); }}><Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}
        onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus(); }}>
        <Dialog.Title>{t("disconnectYouTube")}</Dialog.Title><Dialog.Description>{t("disconnectDescription")}</Dialog.Description>
        <Dialog.Close className="icon-button dialog-close" disabled={busy} aria-label={t("close")}><X size={18} /></Dialog.Close>
        <div className="form-scope">{disconnect?.displayName} · {disconnect?.destinationId}</div>
        <label className="revoke-option"><input type="checkbox" checked={revoke} disabled={busy} onChange={event => setRevoke(event.target.checked)} /><span>{t("revokeGoogle")}<small>{t("revokeGoogleHelp")}</small></span></label>
        {!!error && <p className="form-error" role="alert">{errorText(error)}</p>}
        <div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={() => setDisconnect(null)}>{t("cancel")}</button>
          <button className="button danger" disabled={busy} onClick={() => { if (disconnect) void act(async () => {
            await request("/api/youtube/disconnect", "POST", { accountId: disconnect.id, destinationId: disconnect.destinationId, revoke });
            setDisconnect(null); setNotice("youtubeDisconnectDone"); await refresh();
          }); }}>{busy && <LoaderCircle className="spinning" size={15} />}{t("disconnectYouTube")}</button></div>
      </Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
