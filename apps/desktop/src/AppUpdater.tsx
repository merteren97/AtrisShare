import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import "./updater.css";
import { APP_VERSION } from "../../../packages/domain/src/workspace.js";

const copy = {
  tr: { checking: "Güncellemeler kontrol ediliyor…", downloading: "Güncelleme indiriliyor…", ready: "Yeni sürüm kurulmaya hazır", auto: "Uygulama kullanılmıyorsa 60 saniye sonra otomatik kurulur.", active: "Çalışmanız bölünmedi. Hazır olduğunuzda kurup yeniden başlatın.", install: "Kur ve yeniden başlat", installing: "Güncelleme kuruluyor…", failed: "Güncelleme tamamlanamadı. Mevcut sürümü kullanmaya devam edebilirsiniz.", retry: "Tekrar dene", later: "Daha sonra" },
  en: { checking: "Checking for updates…", downloading: "Downloading update…", ready: "A new version is ready to install", auto: "Installs automatically after 60 seconds if the app stays unused.", active: "Your work was not interrupted. Install and restart when ready.", install: "Install and restart", installing: "Installing update…", failed: "The update could not finish. You can keep using this version.", retry: "Retry", later: "Later" }
};

export function AppUpdater({ language }: { language: "tr" | "en" }) {
  const t = copy[language];
  const [phase, setPhase] = useState<"checking" | "downloading" | "ready" | "installing" | "failed" | "current" | "packageManager" | "hidden">("hidden");
  const [version, setVersion] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [active, setActive] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const startedWork = useRef(false), operation = useRef(false), mounted = useRef(false);

  async function check(manual = false) {
    if (!isTauri() || operation.current) return;
    operation.current = true;
    setPhase("checking"); setDismissed(false); setProgress(null);
    try {
      const next = await invoke<string | null>("native_prepare_update");
      if (!mounted.current) return;
      setVersion(next ?? ""); setPhase(next ? "ready" : manual ? "current" : "hidden");
    } catch (failure) {
      if (mounted.current) setPhase(failure === "update_development" ? "hidden" : failure === "update_package_manager" ? "packageManager" : "failed");
    } finally { operation.current = false; }
  }
  async function install() {
    if (operation.current) return;
    operation.current = true; setPhase("installing");
    try { await invoke("native_install_update"); }
    catch { if (mounted.current) setPhase("failed"); }
    finally { operation.current = false; }
  }
  useEffect(() => {
    mounted.current = true;
    if (!isTauri()) return () => { mounted.current = false; };
    let dispose: (() => void) | undefined, cancelled = false;
    void listen<{ downloaded: number; total: number | null }>("atris-share://update-progress", ({ payload }) => {
      if (cancelled) return;
      setPhase("downloading");
      setProgress(payload.total ? Math.min(100, Math.round(payload.downloaded / payload.total * 100)) : null);
    }).then(fn => { if (cancelled) fn(); else dispose = fn; }).catch(() => { /* Checks remain available without progress events. */ });
    // A session with user interaction never restarts automatically. Downloads continue;
    // edits, dialogs and background tasks are left under the user's control.
    const activity = (event: Event) => {
      if ((event.target as Element | null)?.closest?.(".app-updater")) return;
      startedWork.current = true; setActive(true);
    };
    window.addEventListener("pointerdown", activity, true); window.addEventListener("keydown", activity, true);
    window.addEventListener("atris-share:work-started", activity);
    const requested = () => { void check(true); };
    window.addEventListener("atris-share:check-update", requested);
    const initial = setTimeout(() => { void check(); }, 5000);
    const periodic = setInterval(() => { void check(); }, 4 * 60 * 60 * 1000);
    return () => { mounted.current = false; cancelled = true; dispose?.(); clearTimeout(initial); clearInterval(periodic); window.removeEventListener("pointerdown", activity, true); window.removeEventListener("keydown", activity, true); window.removeEventListener("atris-share:work-started", activity); window.removeEventListener("atris-share:check-update", requested); };
  }, []);
  useEffect(() => {
    if (phase !== "ready" || active || dismissed) return;
    const timer = setTimeout(() => {
      if (startedWork.current) return;
      if (document.querySelector('[data-update-blocked="true"], [aria-busy="true"], [role="dialog"]')) {
        startedWork.current = true; setActive(true); return;
      }
      void install();
    }, 60_000);
    return () => clearTimeout(timer);
  }, [phase, active, dismissed]);
  if (phase === "hidden" || dismissed || !isTauri()) return null;
  return <aside className="app-updater" aria-label={language === "tr" ? "Uygulama güncellemesi" : "Application update"}>
    <div role="status">{phase === "ready" || phase === "current" || phase === "packageManager" || phase === "failed" ? <Download size={16} /> : <LoaderCircle size={16} className="spinning" />}<strong>{phase === "ready" ? `${t.ready} · ${version}` : phase === "current" ? language === "tr" ? "En güncel sürümü kullanıyorsunuz." : "You are using the latest version." : phase === "packageManager" ? language === "tr" ? "Bu kurulum için paket yöneticinizi kullanın veya AppImage sürümüne geçin." : "Use your package manager to update this installation, or switch to AppImage." : t[phase]}{phase === "downloading" && progress !== null ? ` ${progress}%` : ""}</strong></div>
    {phase === "ready" && <p>{active ? t.active : t.auto}</p>}
    <div className="app-updater-actions">{phase === "ready" && <button className="button primary" onClick={() => { void install(); }}><RefreshCw size={14} />{t.install}</button>}{phase === "failed" && <button className="button secondary" onClick={() => { void check(); }}>{t.retry}</button>}{phase !== "installing" && <button className="text-button" onClick={() => setDismissed(true)}>{t.later}</button>}</div>
  </aside>;
}

export function UpdateSettings({ language }: { language: "tr" | "en" }) {
  return <section className="panel native-settings"><header className="native-settings__heading"><Download size={18} /><div><h2>{language === "tr" ? "Uygulama güncellemeleri" : "Application updates"}</h2><p>AtrisShare {APP_VERSION}</p></div></header>
    <div className="settings-action-row"><p className="native-settings__help">{language === "tr" ? "GitHub’daki yeni kararlı sürümler otomatik indirilir. Uygulama kullanılmıyorken kurulur; çalışırken yeniden başlatma size bırakılır." : "New stable GitHub releases download automatically. Installation runs when the app is unused; an active session lets you choose when to restart."}</p>
    <button type="button" className="button secondary" disabled={!isTauri()} onClick={() => window.dispatchEvent(new Event("atris-share:check-update"))}><RefreshCw size={14} />{language === "tr" ? "Güncellemeleri kontrol et" : "Check for updates"}</button>
    </div>
  </section>;
}
