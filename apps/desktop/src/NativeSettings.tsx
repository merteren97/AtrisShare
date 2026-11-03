import { useEffect, useId, useRef, useState } from "react";
import { Bell, LoaderCircle, Monitor } from "lucide-react";
import {
  getNativeDesktopSettings, getNotificationPermission, requestNotificationPermission, setCloseToTray,
  type NativeDesktopSettings, type NativeNotificationPermission
} from "./native-desktop";
import "./native-desktop.css";
import { UpdateSettings } from "./AppUpdater";

const copy = {
  en: {
    title: "Desktop behavior", description: "Choose what happens when you close AtrisShare. Changes save on this device immediately.",
    background: "Keep running in the system tray when I close the window",
    backgroundHelp: "Keep local work running with the window hidden. Use Show in the tray menu to return, or Quit to stop the app. Does not enable launch at login.",
    foreground: "Closing currently quits AtrisShare and stops local work.", backgroundOn: "Closing currently hides the window; local work continues until Quit.",
    trayMissing: "The system tray is unavailable. Closing will quit, even if a saved preference was enabled.",
    web: "Browser preview: system tray, desktop background mode and native notifications are unavailable. Closing this tab is not a desktop Quit command.",
    loading: "Checking desktop settings…", saving: "Saving…", saved: "Saved on this device.",
    loadFailed: "Desktop settings could not be loaded. Retry before changing this preference.", saveFailed: "Could not save this preference. The previous behavior remains active.",
    invalidSaved: "The saved preference could not be read. Close-to-tray is off until a new choice is saved.", repair: "Keep close-to-quit",
    notifications: "Review reminders", permission: "Notification permission", granted: "Allowed", denied: "Denied", prompt: "Not granted yet", unavailable: "Unavailable",
    notificationHelp: "Get a reminder when scheduled content needs your review. System notification settings and Do Not Disturb may affect delivery.",
    boundary: "Your review inbox always holds pending items. Publishing starts only after your approval.",
    allow: "Request notification permission", check: "Refresh status", permissionFailed: "Notification permission could not be checked. Use the inbox while notifications are unavailable.", retry: "Retry"
  },
  tr: {
    title: "Masaüstü davranışı", description: "AtrisShare kapatıldığında ne olacağını seçin. Değişiklikler bu cihaza hemen kaydedilir.",
    background: "Pencereyi kapattığımda sistem tepsisinde çalışmaya devam et",
    backgroundHelp: "Pencere gizlenirken yerel işler sürer. Geri dönmek için tepsi menüsünden Göster, uygulamayı durdurmak için Çıkış seç. Bilgisayar açılışında otomatik başlatmayı etkinleştirmez.",
    foreground: "Pencereyi kapatmak şu anda AtrisShare’den çıkar ve yerel işleri durdurur.", backgroundOn: "Pencere kapanınca gizlenir; yerel işler Çıkış seçilene kadar sürer.",
    trayMissing: "Sistem tepsisi kullanılamıyor. Kayıtlı tercih açık olsa bile pencereyi kapatmak uygulamadan çıkar.",
    web: "Tarayıcı ön izlemesi: sistem tepsisi, masaüstü arka plan modu ve yerel bildirimler kullanılamaz. Bu sekmeyi kapatmak masaüstü Çıkış komutu değildir.",
    loading: "Masaüstü ayarları kontrol ediliyor…", saving: "Kaydediliyor…", saved: "Bu cihaza kaydedildi.",
    loadFailed: "Masaüstü ayarları yüklenemedi. Tercihi değiştirmeden önce yeniden deneyin.", saveFailed: "Tercih kaydedilemedi. Önceki davranış geçerli olmaya devam ediyor.",
    invalidSaved: "Kayıtlı tercih okunamadı. Yeni bir seçim kaydedilene kadar tepsiye kapatma devre dışıdır.", repair: "Kapatınca çıkışı koru",
    notifications: "İnceleme hatırlatmaları", permission: "Bildirim izni", granted: "İzinli", denied: "Reddedildi", prompt: "Henüz izin verilmedi", unavailable: "Kullanılamıyor",
    notificationHelp: "Zamanlanmış içerik inceleme beklediğinde hatırlatma al. Sistem bildirim ayarları ve Rahatsız Etmeyin modu iletimi etkileyebilir.",
    boundary: "Bekleyen içerikler her zaman inceleme kutusunda bulunur. Yayın yalnızca senin onayınla başlar.",
    allow: "Bildirim izni iste", check: "Durumu yenile", permissionFailed: "Bildirim izni kontrol edilemedi. Bildirimler kullanılamıyorken gelen kutusunu kullanın.", retry: "Yeniden dene"
  }
} as const;

export function NativeSettings({ language }: { language: "tr" | "en" }) {
  const t = copy[language], id = useId();
  const [settings, setSettings] = useState<NativeDesktopSettings | null>(null);
  const [permission, setPermission] = useState<NativeNotificationPermission>("unavailable");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"loadFailed" | "saveFailed" | null>(null);
  const [permissionError, setPermissionError] = useState(false);
  const [saved, setSaved] = useState(false);
  const epoch = useRef(0), operation = useRef(false);

  async function load() {
    if (operation.current) return;
    const generation = ++epoch.current;
    setLoading(true); setError(null); setPermissionError(false); setSaved(false);
    const [desktop, notification] = await Promise.allSettled([getNativeDesktopSettings(), getNotificationPermission()]);
    if (generation !== epoch.current) return;
    if (desktop.status === "fulfilled") setSettings(desktop.value);
    else { setSettings(null); setError("loadFailed"); }
    if (notification.status === "fulfilled") setPermission(notification.value);
    else { setPermission("unavailable"); setPermissionError(true); }
    setLoading(false);
  }
  useEffect(() => { void load(); return () => { epoch.current++; }; }, []);

  async function save(enabled: boolean) {
    if (operation.current) return;
    operation.current = true;
    const generation = epoch.current;
    setBusy(true); setError(null); setSaved(false);
    try {
      const next = await setCloseToTray(enabled);
      if (generation === epoch.current) { setSettings(next); setSaved(true); }
    } catch { if (generation === epoch.current) setError("saveFailed"); }
    finally { operation.current = false; if (generation === epoch.current) setBusy(false); }
  }
  async function requestPermission() {
    if (operation.current) return;
    operation.current = true;
    const generation = epoch.current;
    setBusy(true); setPermissionError(false);
    try {
      const next = await requestNotificationPermission();
      if (generation === epoch.current) setPermission(next);
    } catch { if (generation === epoch.current) setPermissionError(true); }
    finally { operation.current = false; if (generation === epoch.current) setBusy(false); }
  }

  const native = settings?.native ?? false;
  const permissionLabel = permission === "granted" ? t.granted : permission === "denied" ? t.denied : permission === "unavailable" ? t.unavailable : t.prompt;
  return <><UpdateSettings language={language} /><section className="panel native-settings" aria-labelledby={`${id}-title`} aria-busy={loading || busy} lang={language}>
    <header className="native-settings__heading"><Monitor size={18} aria-hidden="true" /><div><h2 id={`${id}-title`}>{t.title}</h2><p>{t.description}</p></div></header>
    {loading ? <p className="native-settings__status" role="status"><LoaderCircle size={15} className="spinning" aria-hidden="true" />{t.loading}</p> : <>
      {settings && !native && <p className="native-settings__help">{t.web}</p>}
      <label className="native-settings__toggle"><input type="checkbox" checked={settings?.closeToTray ?? false}
        disabled={!native || busy || (!settings?.trayAvailable && !settings?.closeToTray)} aria-describedby={`${id}-background-help`}
        onChange={event => { void save(event.target.checked); }} /><span>{t.background}</span></label>
      <p id={`${id}-background-help`} className="native-settings__help">{t.backgroundHelp}</p>
      {native && <p className="native-settings__status" role="status">{!settings?.trayAvailable ? t.trayMissing : settings.closeToTray ? t.backgroundOn : t.foreground}</p>}
      {settings?.settingsError && <div className="native-settings__recovery"><p>{t.invalidSaved}</p><button type="button" className="button secondary" disabled={busy} onClick={() => { void save(false); }}>{t.repair}</button></div>}
      {error && <div className="native-settings__error" role="alert"><p>{t[error]}</p>{error === "loadFailed" && <button type="button" className="button secondary" disabled={busy} onClick={() => { void load(); }}>{t.retry}</button>}</div>}
      <div className="native-settings__save" role="status" aria-live="polite">{busy ? <><LoaderCircle size={14} className="spinning" aria-hidden="true" />{t.saving}</> : saved ? t.saved : null}</div>
      <div className="native-settings__notifications"><h3><Bell size={16} aria-hidden="true" />{t.notifications}</h3>
        <p className="native-settings__permission">{t.permission}: <strong>{permissionLabel}</strong></p>
        <p className="native-settings__help">{t.notificationHelp}</p><p className="native-settings__help">{t.boundary}</p>
        {permissionError && <p className="native-settings__error" role="alert">{t.permissionFailed}</p>}
        {native && <div className="native-settings__actions">{permission !== "granted" && <button type="button" className="button secondary" disabled={busy} onClick={() => { void requestPermission(); }}>{t.allow}</button>}
          <button type="button" className="button secondary" disabled={busy} onClick={() => { void load(); }}>{t.check}</button></div>}
      </div>
    </>}
  </section></>;
}
