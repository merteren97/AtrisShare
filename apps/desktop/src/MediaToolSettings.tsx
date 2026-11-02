import { useEffect, useState } from "react";
import { Check, Clapperboard, LoaderCircle } from "lucide-react";
import { request } from "./api";

interface Setup { ffmpegPath: string; ffprobePath: string; restartRequired: boolean; configurationError: boolean; tools: { available: boolean; ffmpeg: boolean; ffprobe: boolean } }
const copy = {
  tr: { title: "Video araçları", loading: "Araçlar kontrol ediliyor…", help: "Video analizi ve dışa aktarım için FFmpeg ve FFprobe gerekir. Kurulu araçların tam dosya yollarını kaydet; boş alanlar sistem PATH ayarını kullanır.",
    path: "dosya yolu", save: "Araçları doğrula ve kaydet", ready: "Düzenlemeye hazır", missing: "Araç kurulumu gerekli", restart: "Ayarlar kaydedildi. Yeni araçları kullanmak için uygulamadan tamamen çıkıp yeniden aç.",
    saved: "Araç ayarları kaydedildi.", error: "Araçlar doğrulanamadı. Dosyaların mevcut olduğunu ve doğru FFmpeg / FFprobe çalıştırılabilir dosyalarını seçtiğini kontrol et.", invalid: "Kaydedilmiş araç ayarı okunamadı. Yolları yeniden kaydet.", retry: "Yenile", note: "Medyan yerel olarak işlenir. Bu ayar araç veya model indirmez." },
  en: { title: "Video tools", loading: "Checking tools…", help: "FFmpeg and FFprobe are required for media analysis and export. Save the full paths to installed tools; leave fields empty to use the system PATH.",
    path: "file path", save: "Verify & save tools", ready: "Ready to edit", missing: "Tool setup needed", restart: "Settings saved. Fully quit and reopen the app to use the new tools.",
    saved: "Tool settings saved.", error: "Tools could not be verified. Check that the files exist and are the correct FFmpeg / FFprobe executables.", invalid: "Saved tool settings could not be read. Save the paths again.", retry: "Refresh", note: "Your media is processed locally. This setting does not download tools or models." }
};
export function MediaToolSettings({ language }: { language: "tr" | "en" }) {
  const t = copy[language];
  const [setup, setSetup] = useState<Setup | null>(null), [ffmpegPath, setFfmpeg] = useState(""), [ffprobePath, setFfprobe] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setError(false);
    void request<Setup>("/api/settings/media-tools", "GET", undefined, abort.signal).then(value => {
      if (!abort.signal.aborted) { setSetup(value); setFfmpeg(value.ffmpegPath); setFfprobe(value.ffprobePath); }
    }).catch(() => { if (!abort.signal.aborted) setError(true); });
    return () => abort.abort();
  }, [reload]);
  return <section className="settings-panel panel" id="video-tools" aria-busy={busy || !setup && !error}><div className="settings-section-title"><Clapperboard size={18} /><h2>{t.title}</h2><span className={`badge ${setup?.tools.available ? "positive" : "suggested"}`}>{!setup && !error ? t.loading : setup?.tools.available ? t.ready : t.missing}</span></div>
    <p className="section-note">{t.help}</p><form className="media-tools-form" onSubmit={e => { e.preventDefault(); if (busy) return; setBusy(true); setError(false); setSaved(false);
      void request<Setup>("/api/settings/media-tools", "POST", { ffmpegPath, ffprobePath }).then(value => { setSetup(value); setSaved(true); }).catch(() => setError(true)).finally(() => setBusy(false));
    }}><div className="form-columns"><label className="form-field">FFmpeg · {t.path}<input value={ffmpegPath} onChange={e => setFfmpeg(e.target.value)} disabled={busy} maxLength={2048} autoComplete="off" spellCheck={false} placeholder={navigator.platform.startsWith("Win") ? "C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe" : "/usr/local/bin/ffmpeg"} /></label>
      <label className="form-field">FFprobe · {t.path}<input value={ffprobePath} onChange={e => setFfprobe(e.target.value)} disabled={busy} maxLength={2048} autoComplete="off" spellCheck={false} placeholder={navigator.platform.startsWith("Win") ? "C:\\Tools\\ffmpeg\\bin\\ffprobe.exe" : "/usr/local/bin/ffprobe"} /></label></div>
      <button className="button secondary" disabled={busy || !setup}>{busy ? <LoaderCircle className="spinning" size={15} /> : <Check size={15} />}{t.save}</button></form>
    {error && <div className="form-error" role="alert"><p>{t.error}</p>{!setup && <button className="text-button" onClick={() => setReload(v => v + 1)}>{t.retry}</button>}</div>}{setup?.configurationError && <p className="form-error" role="alert">{t.invalid}</p>}
    {(setup?.restartRequired || saved) && <p className="section-note" role="status">{setup?.restartRequired ? t.restart : t.saved}</p>}<p className="section-note">{t.note}</p>
  </section>;
}
