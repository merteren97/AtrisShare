import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, ExternalLink, FileJson, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import type { YouTubeSetup as Setup } from "../../../packages/domain/src/youtube.js";
import { ApiError, request } from "./api";
import "./youtube-setup.css";

type LocalSetup = Setup & {
  configuredSource?: "env" | "local" | "none";
  configurationError?: string;
};
export interface YouTubeSetupProps {
  language: "tr" | "en";
  onConfigured: () => void;
  errorText: (error: unknown) => string;
}
const copy = {
  en: {
    importJson: "Import Google client JSON", importHelp: "Choose the JSON downloaded for a Desktop app in Google Cloud. Review the imported fields, then save.", invalidJson: "Choose a valid Google Desktop app JSON file under 32 KB. Web application clients are not supported.", cloudChecklist: "Before signing in: enable YouTube Data API v3, create a Desktop app OAuth client, and add your Google account as a test user if the consent screen is in testing mode.",
    title: "YouTube app setup", description: "Use your Google Desktop OAuth app to connect a channel from this device.",
    loading: "Checking app setup…", ready: "Ready to connect", missing: "App configuration needed", unavailable: "Secure storage not ready", checkFailed: "Setup could not be checked",
    local: "Saved securely on this device. Continue with Google below to connect your channel.",
    env: "Using the runtime’s app configuration. You can save a local configuration here.",
    storage: "App configuration is present, but connection is unavailable. Check the OS credential vault and retry.",
    help: "In Google Cloud, use an OAuth client with application type Desktop app. Copy its client ID and, if provided, client secret.",
    cloud: "Google Cloud credentials", edit: "Change app configuration", cancel: "Cancel", clientId: "Desktop client ID",
    idHelp: "Ends in .apps.googleusercontent.com", secret: "Client secret", optional: "Optional",
    secretHelp: "Enter the secret for this client if Google provided one. Saved values are never displayed here.",
    save: "Save app configuration", saving: "Saving securely…", saved: "App configuration saved. You can now continue with Google.",
    privacy: "Encrypted in the OS credential vault. No browser storage. No restart needed.", retry: "Retry",
    invalid: "Enter a valid Desktop client ID and a client secret without spaces or line breaks.",
    active: "Finish or cancel the current Google connection before changing the app configuration.",
    configuring: "App configuration is being updated. Please try again shortly.",
    vault: "The OS credential vault is unavailable. Restore secure storage, then try again.",
    saveFailed: "Could not save the app configuration securely. Please try again.",
    invalidSaved: "Saved app configuration could not be read. Enter the Desktop app details again.",
    closing: "The local runtime is closing. Reopen the app to continue."
  },
  tr: {
    importJson: "Google istemci JSON dosyasını içe aktar", importHelp: "Google Cloud’dan Masaüstü uygulaması için indirdiğin JSON dosyasını seç. Alanları inceleyip kaydet.", invalidJson: "32 KB altında geçerli bir Google Masaüstü uygulaması JSON dosyası seç. Web uygulaması istemcileri desteklenmez.", cloudChecklist: "Girişten önce: YouTube Data API v3’ü etkinleştir, Masaüstü uygulaması türünde OAuth istemcisi oluştur. İzin ekranı test modundaysa Google hesabını test kullanıcısı olarak ekle.",
    title: "YouTube uygulama ayarı", description: "Bu cihazdan kanal bağlamak için Google Masaüstü OAuth uygulamanızı kullanın.",
    loading: "Uygulama ayarı kontrol ediliyor…", ready: "Bağlantıya hazır", missing: "Uygulama ayarı gerekli", unavailable: "Güvenli depolama hazır değil", checkFailed: "Uygulama ayarı kontrol edilemedi",
    local: "Bu cihazda güvenle kaydedildi. Kanalınızı bağlamak için aşağıdan Google ile devam edin.",
    env: "Çalışma ortamının uygulama ayarı kullanılıyor. Buradan yerel bir ayar kaydedebilirsiniz.",
    storage: "Uygulama ayarı mevcut ancak bağlantı kullanılamıyor. İşletim sistemi kimlik kasasını kontrol edip yeniden deneyin.",
    help: "Google Cloud’da uygulama türü Masaüstü uygulaması olan bir OAuth istemcisi kullanın. İstemci kimliğini ve varsa istemci sırrını kopyalayın.",
    cloud: "Google Cloud kimlik bilgileri", edit: "Uygulama ayarını değiştir", cancel: "Vazgeç", clientId: "Masaüstü istemci kimliği",
    idHelp: ".apps.googleusercontent.com ile biter", secret: "İstemci sırrı", optional: "İsteğe bağlı",
    secretHelp: "Google bu istemci için bir sır sağladıysa girin. Kaydedilmiş değerler burada gösterilmez.",
    save: "Uygulama ayarını kaydet", saving: "Güvenle kaydediliyor…", saved: "Uygulama ayarı kaydedildi. Artık Google ile devam edebilirsiniz.",
    privacy: "İşletim sistemi kimlik kasasında şifrelenir. Tarayıcıda saklanmaz. Yeniden başlatma gerekmez.", retry: "Yeniden dene",
    invalid: "Geçerli bir Masaüstü istemci kimliği ve boşluk veya satır sonu içermeyen bir istemci sırrı girin.",
    active: "Uygulama ayarını değiştirmeden önce mevcut Google bağlantısını tamamlayın veya iptal edin.",
    configuring: "Uygulama ayarı güncelleniyor. Lütfen kısa süre sonra yeniden deneyin.",
    vault: "İşletim sistemi kimlik kasası kullanılamıyor. Güvenli depolamayı geri yükleyip yeniden deneyin.",
    saveFailed: "Uygulama ayarı güvenle kaydedilemedi. Lütfen yeniden deneyin.",
    invalidSaved: "Kaydedilmiş uygulama ayarı okunamadı. Masaüstü uygulaması bilgilerini yeniden girin.",
    closing: "Yerel çalışma ortamı kapanıyor. Devam etmek için uygulamayı yeniden açın."
  }
} as const;

export function YouTubeSetup({ language, onConfigured, errorText }: YouTubeSetupProps) {
  const text = copy[language];
  const id = useId();
  const [setup, setSetup] = useState<LocalSetup | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  const saveLock = useRef(false);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const clientRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [fileError, setFileError] = useState(false);
  async function importClient(file: File) {
    setFileError(false); setSaved(false);
    try {
      if (file.size > 32768) throw new Error();
      const value = JSON.parse(await file.text()) as { installed?: { client_id?: unknown; client_secret?: unknown } };
      const client = value.installed;
      if (!client || typeof client.client_id !== "string" || client.client_id.length > 256 || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(client.client_id) ||
        client.client_secret !== undefined && (typeof client.client_secret !== "string" || client.client_secret.length > 500 || !/^[A-Za-z0-9_-]+$/.test(client.client_secret))) throw new Error();
      setClientId(client.client_id); setClientSecret(typeof client.client_secret === "string" ? client.client_secret : ""); setError(null); clientRef.current?.focus();
    } catch { setFileError(true); }
  }

  async function load() {
    if (saveLock.current) return;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setLoading(true); setError(null);
    try {
      const result = await request<LocalSetup>("/api/youtube", "GET", undefined, abort.signal);
      if (!abort.signal.aborted) setSetup(result);
    } catch (failure) { if (!abort.signal.aborted) setError(failure); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    void load();
    return () => { controller.current?.abort(); };
  }, []);
  useEffect(() => { if (saved) editRef.current?.focus(); }, [saved]);
  useEffect(() => { if (editing) clientRef.current?.focus(); else editRef.current?.focus(); }, [editing]);

  function message(failure: unknown): string {
    if (failure instanceof ApiError) {
      switch (failure.code) {
        case "youtube_invalid_client_config": return text.invalid;
        case "youtube_session_active": return text.active;
        case "youtube_configuring": return text.configuring;
        case "vault_unavailable": return text.vault;
        case "youtube_config_save_failed": return text.saveFailed;
        case "youtube_config_invalid": case "youtube_config_load_failed": return text.invalidSaved;
        case "runtime_closing": return text.closing;
      }
    }
    return errorText(failure);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saveLock.current) return;
    const value = clientId.trim();
    if (value.length > 256 || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value) ||
        (clientSecret && (clientSecret.length > 500 || !/^[A-Za-z0-9_-]+$/.test(clientSecret) || /\s/.test(clientSecret)))) {
      setError(new ApiError("youtube_invalid_client_config")); return;
    }
    saveLock.current = true;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setSaving(true); setSaved(false); setError(null);
    try {
      const result = await request<LocalSetup>("/api/youtube/config", "POST", {
        clientId: value, ...(clientSecret ? { clientSecret } : {})
      }, abort.signal);
      if (!abort.signal.aborted) {
        setSetup(result); setClientId(""); setClientSecret(""); setEditing(false); setSaved(true);
        onConfigured();
      }
    } catch (failure) { if (!abort.signal.aborted) setError(failure); }
    finally {
      saveLock.current = false;
      if (!abort.signal.aborted) setSaving(false);
    }
  }
  const showForm = !loading && (!setup?.configured || editing);
  return <section className="panel youtube-app-setup" aria-labelledby={`${id}-title`} aria-busy={loading || saving}>
    <div className="youtube-app-setup-heading">
      <span className="youtube-app-setup-icon"><KeyRound size={19} aria-hidden="true" /></span>
      <div><h2 id={`${id}-title`}>{text.title}</h2><p>{text.description}</p></div>
      <span className={`badge ${setup?.available ? "positive" : ""}`} role="status">
        {loading ? <LoaderCircle size={13} className="spinning" aria-hidden="true" /> : setup?.available ? <Check size={13} aria-hidden="true" /> : null}
        {loading ? text.loading : !setup ? text.checkFailed : setup.available ? text.ready : setup.configured ? text.unavailable : text.missing}
      </span>
    </div>
    {setup?.configured && !showForm && <div className="youtube-app-setup-ready">
      <p>{!setup.available ? text.storage : setup.configuredSource === "env" ? text.env : text.local}</p>
      <button ref={editRef} type="button" className="text-button" disabled={loading || saving} onClick={() => { setEditing(true); setSaved(false); }}>
        {text.edit}<ChevronDown size={14} aria-hidden="true" />
      </button>
    </div>}
    {showForm && <form onSubmit={event => { void save(event); }} className="youtube-app-setup-form" autoComplete="off">
      <div className="youtube-app-setup-guide"><p>{text.help}</p>
        <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-button">{text.cloud}<ExternalLink size={13} aria-hidden="true" /></a>
      </div>
      <p className="section-note">{text.cloudChecklist}</p>
      <div className="youtube-json-import"><button className="button secondary" type="button" disabled={saving} onClick={() => fileRef.current?.click()}><FileJson size={15} />{text.importJson}</button><p className="field-help">{text.importHelp}</p>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden aria-label={text.importJson} onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (file) void importClient(file); }} />{fileError && <p className="form-error" role="alert">{text.invalidJson}</p>}</div>
      <div className="youtube-app-setup-fields">
        <label className="form-field" htmlFor={`${id}-client`}>{text.clientId}
          <input ref={clientRef} id={`${id}-client`} name="youtube-client-id" value={clientId} onChange={event => setClientId(event.target.value)}
            required maxLength={256} pattern={"[A-Za-z0-9_\\-]+\\.apps\\.googleusercontent\\.com"} placeholder="1234567890-….apps.googleusercontent.com"
            disabled={saving} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby={`${id}-client-help`} />
          <span className="field-help" id={`${id}-client-help`}>{text.idHelp}</span>
        </label>
        <label className="form-field" htmlFor={`${id}-secret`}><span>{text.secret} <span className="youtube-app-setup-optional">{text.optional}</span></span>
          <input id={`${id}-secret`} name="youtube-client-secret" type="password" value={clientSecret} onChange={event => setClientSecret(event.target.value)}
            maxLength={500} disabled={saving} autoComplete="new-password" spellCheck={false} autoCapitalize="none" aria-describedby={`${id}-secret-help`} />
          <span className="field-help" id={`${id}-secret-help`}>{text.secretHelp}</span>
        </label>
      </div>
      <div className="youtube-app-setup-actions">
        <button className="button primary" type="submit" disabled={saving || !clientId.trim()}>{saving ? <LoaderCircle className="spinning" size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}{saving ? text.saving : text.save}</button>
        {setup?.configured && <button className="text-button" type="button" disabled={saving} onClick={() => {
          setEditing(false); setClientId(""); setClientSecret(""); setError(null);
        }}>{text.cancel}</button>}
      </div>
      <p className="youtube-app-setup-privacy"><ShieldCheck size={14} aria-hidden="true" />{text.privacy}</p>
    </form>}
    {setup?.configurationError && !error && <p className="form-error" role="alert">{message(new ApiError(setup.configurationError))}</p>}
    {!!error && <div className="youtube-app-setup-error"><p className="form-error" role="alert">{message(error)}</p>
      {!setup && <button type="button" className="text-button" disabled={loading || saving} onClick={() => { void load(); }}>{text.retry}</button>}
    </div>}
    {saved && <p className="youtube-app-setup-success" role="status"><Check size={15} aria-hidden="true" />{text.saved}</p>}
  </section>;
}
