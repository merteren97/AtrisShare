import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CircleAlert, Copy, HardDrive, Minus, Share2, Square, X } from "lucide-react";
import "./titlebar.css";

const copy = {
  en: {
    titlebar: "Window title bar", studio: "Content studio", workspace: "Local workspace",
    minimize: "Minimize", maximize: "Maximize", restore: "Restore", close: "Close",
    unavailable: "Window controls unavailable", stateFailed: "Window state unavailable",
    minimizeFailed: "Could not minimize window", maximizeFailed: "Could not resize window",
    closeFailed: "Could not close window"
  },
  tr: {
    titlebar: "Pencere başlık çubuğu", studio: "İçerik stüdyosu", workspace: "Yerel çalışma alanı",
    minimize: "Simge durumuna küçült", maximize: "Ekranı kapla", restore: "Önceki boyuta getir", close: "Kapat",
    unavailable: "Pencere kontrolleri kullanılamıyor", stateFailed: "Pencere durumu alınamadı",
    minimizeFailed: "Pencere küçültülemedi", maximizeFailed: "Pencere boyutu değiştirilemedi",
    closeFailed: "Pencere kapatılamadı"
  }
} as const;

type WindowAction = "minimize" | "maximize" | "close";
type TitlebarError = "unavailable" | "stateFailed" | `${WindowAction}Failed`;
type WindowMode = "browser" | "checking" | "decorated" | "custom" | "unavailable";

export function Titlebar({ language }: { language: "tr" | "en" }) {
  const [mode, setMode] = useState<WindowMode>(() => isTauri() ? "checking" : "browser");
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<TitlebarError | null>(null);
  const mounted = useRef(false);
  const actionPending = useRef(false);
  const t = copy[language];

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let maximizedRevision = 0;
    let focusRevision = 0;
    const unlisteners: UnlistenFn[] = [];
    const reportStateError = () => { if (!disposed) setError("stateFailed"); };
    const subscribe = async (subscription: Promise<UnlistenFn>) => {
      try {
        const unlisten = await subscription;
        // Registration can resolve after an unmount (including StrictMode's cleanup).
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      } catch { reportStateError(); }
    };

    async function initialize() {
      if (!isTauri()) return;
      const window = getCurrentWindow();
      try {
        const decorated = await window.isDecorated();
        if (disposed) return;
        setMode(decorated ? "decorated" : "custom");
        if (decorated) return;
      } catch {
        if (!disposed) { setMode("unavailable"); setError("unavailable"); }
        return;
      }

      async function refreshMaximized() {
        const revision = ++maximizedRevision;
        try {
          const value = await window.isMaximized();
          if (!disposed && revision === maximizedRevision) setMaximized(value);
        } catch { reportStateError(); }
      }

      await Promise.all([
        subscribe(window.onResized(() => { void refreshMaximized(); })),
        subscribe(window.onFocusChanged(({ payload }) => {
          focusRevision++;
          if (!disposed) setFocused(payload);
        }))
      ]);
      if (disposed) return;
      void refreshMaximized();
      const revision = focusRevision;
      try {
        const value = await window.isFocused();
        if (!disposed && revision === focusRevision) setFocused(value);
      } catch { reportStateError(); }
    }

    void initialize();
    return () => {
      mounted.current = false;
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  async function runAction(action: WindowAction) {
    if (mode !== "custom" || !isTauri() || actionPending.current) return;
    actionPending.current = true;
    setPending(true);
    setError(null);
    try {
      const window = getCurrentWindow();
      if (action === "minimize") await window.minimize();
      else if (action === "close") await window.close();
      else {
        await window.toggleMaximize();
        const value = await window.isMaximized();
        if (mounted.current) setMaximized(value);
      }
    } catch {
      if (mounted.current) setError(`${action}Failed`);
    } finally {
      actionPending.current = false;
      if (mounted.current) setPending(false);
    }
  }

  if (mode === "checking" || mode === "decorated") return null;
  const native = mode === "custom";
  const maximizeLabel = maximized ? t.restore : t.maximize;

  return <header className="atris-share-titlebar" aria-label={t.titlebar} lang={language}
    data-native={native} data-focused={focused}>
    {/* Tauri owns dragging and double-click maximize. Keep interactive controls outside this region. */}
    <div className="atris-share-titlebar__drag" data-tauri-drag-region={native ? "" : undefined} aria-hidden="true" />
    <div className="atris-share-titlebar__brand">
      <span className="atris-share-titlebar__mark"><Share2 size={14} strokeWidth={2.2} aria-hidden="true" /></span>
      <span>Atris<span className="atris-share-titlebar__brand-light">Share</span></span>
    </div>
    <span className="atris-share-titlebar__studio">{t.studio}</span>
    <div className="atris-share-titlebar__right">
      <span className="atris-share-titlebar__status" role="status" aria-live="polite" aria-atomic="true" title={error ? t[error] : undefined}>
        {error && <><CircleAlert size={12} aria-hidden="true" /><span>{t[error]}</span></>}
      </span>
      {!error && <span className="atris-share-titlebar__workspace"><HardDrive size={12} aria-hidden="true" />{t.workspace}</span>}
      {native && <div className="atris-share-titlebar__controls" role="group" aria-label={t.titlebar}>
        <button type="button" className="atris-share-titlebar__control" aria-label={t.minimize} title={t.minimize}
          disabled={pending} onClick={() => { void runAction("minimize"); }}><Minus size={14} aria-hidden="true" /></button>
        <button type="button" className="atris-share-titlebar__control" aria-label={maximizeLabel} title={maximizeLabel}
          disabled={pending} onClick={() => { void runAction("maximize"); }}>
          {maximized ? <Copy size={12} aria-hidden="true" /> : <Square size={12} aria-hidden="true" />}
        </button>
        <button type="button" className="atris-share-titlebar__control atris-share-titlebar__control--close" aria-label={t.close} title={t.close}
          disabled={pending} onClick={() => { void runAction("close"); }}><X size={15} aria-hidden="true" /></button>
      </div>}
    </div>
  </header>;
}
