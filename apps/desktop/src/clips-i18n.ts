const en = {
  title: "Find your next clip", help: "Discover short, self-contained moments. Review the source context before exporting.",
  mode: "Analysis", local: "Local signals", ai: "Selected AI model", discover: "Load AI models", model: "Model", chooseModel: "Choose a model",
  localHelp: "Transcript, scene changes and silence are analyzed on this device. Scores are editorial hints, not engagement predictions. No face tracking or visual-model analysis.",
  aiHelp: "AI receives up to 16,000 characters of timestamped excerpts and signal summaries, source hash and channel link. No video, frames or audio. Your CLI provider may charge for inference.",
  consent: "Send these transcript excerpts to the selected model", history: "Use this source’s saved edit history as a ranking signal",
  min: "Minimum · seconds", target: "Target · seconds", max: "Maximum · seconds", count: "Candidate limit", start: "Find clips", retry: "Refresh", cancel: "Cancel job",
  running: "Analyzing transcript and local media…", rendering: "Exporting selected clips, one at a time…", ready: "Candidates ready for review", failed: "Job failed. Refresh or start a new analysis.", cancelled: "Job cancelled. Start a new analysis to continue.",
  empty: "Your candidates will appear here", emptyHelp: "Prepare the local transcript below, then choose a duration and find clips.",
  transcriptRequired: "A completed transcript for this exact source is required.", invalid: "Use 2–180 seconds, with minimum ≤ target ≤ maximum.",
  candidates: "Ranked candidates", evidence: "Analysis evidence", score: "Local signal score", speech: "Speech coverage", scenes: "Scene changes", previous: "Previous edit overlap", sentence: "Ends at a sentence boundary", context: "Check the opening and ending for missing context.",
  source: "Inspect source", selected: "Select clip", render: "Export selected", exports: "Exported clips remain in the media library. Drafts still require a separate human review and approval.",
  adjust: "Adjust clip", in: "Start · source seconds", out: "End · source seconds", crop: "Aspect ratio", vertical: "Vertical · 9:16", square: "Square · 1:1", original: "Original", framing: "Horizontal framing · left → right", center: "Center", caption: "Static caption", timed: "Generate timed captions", captionHelp: "Captions use segment-level speech timestamps. Review timing and text; word alignment is not inferred. Regenerate after changing boundaries.",
  cueStart: "Caption start", cueEnd: "Caption end", cueText: "Caption text", remove: "Remove caption", save: "Save adjustments", unsaved: "Save or discard adjustments before exporting.", discard: "Discard", saved: "Adjustments saved", preview: "Play exported clip", close: "Close preview", titleField: "YouTube draft title", draft: "Prepare private YouTube draft", draftReady: "Draft prepared · open Publishing to review", connect: "Connect YouTube to prepare a draft.",
  provenance: "Analysis provenance", sampled: "Evidence sampling/truncation was applied. Review the full source.", historyLabel: "Saved edit revision", noModels: "No compatible models available. Refresh model discovery or use local analysis.",
  genericError: "The operation could not finish. Refresh and try again.", conflict: "The source timeline or candidate revision changed. Start a new analysis or refresh current candidates.", sourceChanged: "The source or transcript no longer matches this analysis. Re-import or transcribe again.", busy: "A media or clip job is already running. Wait for it to finish.", bounds: "Check clip boundaries and caption order. Duration must stay within the analysis limits.", captionError: "A caption segment is too long to generate automatically. Shorten it manually or use a static caption.", renderError: "Export failed. Check FFmpeg availability, caption fit and source media, then start a new analysis.",
  captionFit: "This caption does not fit the output frame. Shorten the caption text, save and export again.",
  partialSpeech: "A speech segment crosses the clip boundary. The excerpt includes that segment’s context; it is not word-aligned. Adjust boundaries and inspect the source.",
  language: "Transcript language", load: "Loading clip analyses…", historyChoose: "Analysis history", latest: "Latest analysis", originalEvidence: "Evidence refers to the original proposed range; boundary adjustments do not re-score it."
};
const tr: typeof en = {
  title: "Bir sonraki klibini bul", help: "Kısa, kendi içinde anlamlı bölümleri keşfet. Dışa aktarmadan önce kaynak bağlamını incele.",
  mode: "Analiz", local: "Yerel sinyaller", ai: "Seçilen AI modeli", discover: "AI modellerini yükle", model: "Model", chooseModel: "Model seç",
  localHelp: "Transkript, sahne değişimleri ve sessizlik bu cihazda analiz edilir. Puanlar düzenleme ipucudur; etkileşim tahmini değildir. Yüz takibi veya görsel model analizi yoktur.",
  aiHelp: "AI'ya en fazla 16.000 karakter zaman damgalı alıntı, sinyal özeti, kaynak hash'i ve kanal bağı gönderilir. Video, kare ve ses gönderilmez. CLI sağlayıcınız çıkarım ücreti alabilir.",
  consent: "Bu transkript alıntılarını seçili modele gönder", history: "Bu kaynağın kayıtlı düzenleme geçmişini sıralama sinyali olarak kullan",
  min: "En az · saniye", target: "Hedef · saniye", max: "En çok · saniye", count: "Aday sınırı", start: "Klipleri bul", retry: "Yenile", cancel: "İşi iptal et",
  running: "Transkript ve yerel medya analiz ediliyor…", rendering: "Seçili klipler sırayla dışa aktarılıyor…", ready: "Adaylar incelemeye hazır", failed: "İş başarısız. Yenile veya yeni analiz başlat.", cancelled: "İş iptal edildi. Devam etmek için yeni analiz başlat.",
  empty: "Klip adayların burada görünecek", emptyHelp: "Aşağıdan yerel transkripti hazırla; süreyi seçip klipleri bul.",
  transcriptRequired: "Bu kaynağa ait tamamlanmış transkript gerekli.", invalid: "2–180 saniye kullan: en az ≤ hedef ≤ en çok.",
  candidates: "Sıralanmış adaylar", evidence: "Analiz kanıtı", score: "Yerel sinyal puanı", speech: "Konuşma kapsamı", scenes: "Sahne değişimleri", previous: "Önceki düzenleme örtüşmesi", sentence: "Cümle sınırında bitiyor", context: "Eksik bağlam için başlangıç ve bitişi kontrol et.",
  source: "Kaynağı incele", selected: "Klibi seç", render: "Seçilileri dışa aktar", exports: "Dışa aktarılan klipler medya kitaplığında kalır. Taslaklar ayrıca insan incelemesi ve onayı gerektirir.",
  adjust: "Klibi düzelt", in: "Başlangıç · kaynak saniyesi", out: "Bitiş · kaynak saniyesi", crop: "En-boy oranı", vertical: "Dikey · 9:16", square: "Kare · 1:1", original: "Orijinal", framing: "Yatay kadraj · sol → sağ", center: "Ortala", caption: "Sabit yazı", timed: "Zamanlı altyazı oluştur", captionHelp: "Altyazılar konuşma segmentlerinin gerçek zamanlarını kullanır. Zamanlama ve metni incele; sözcük zamanlaması tahmin edilmez. Sınır değiştirince yeniden oluştur.",
  cueStart: "Altyazı başlangıcı", cueEnd: "Altyazı bitişi", cueText: "Altyazı metni", remove: "Altyazıyı kaldır", save: "Düzeltmeleri kaydet", unsaved: "Dışa aktarmadan önce düzeltmeleri kaydet veya geri al.", discard: "Geri al", saved: "Düzeltmeler kaydedildi", preview: "Aktarılan klibi oynat", close: "Önizlemeyi kapat", titleField: "YouTube taslak başlığı", draft: "Özel YouTube taslağı hazırla", draftReady: "Taslak hazır · incelemek için Yayınlar'ı aç", connect: "Taslak hazırlamak için YouTube'u bağla.",
  provenance: "Analiz kaydı", sampled: "Kanıtlar örneklendi/kısaltıldı. Kaynağın tamamını incele.", historyLabel: "Kayıtlı düzenleme revizyonu", noModels: "Uyumlu model bulunamadı. Model keşfini yenile veya yerel analiz kullan.",
  genericError: "İşlem tamamlanamadı. Yenileyip tekrar dene.", conflict: "Kaynak timeline veya aday revizyonu değişti. Yeni analiz başlat ya da adayları yenile.", sourceChanged: "Kaynak veya transkript bu analizle eşleşmiyor. Yeniden içe aktar veya transkript oluştur.", busy: "Bir medya veya klip işi sürüyor. Tamamlanmasını bekle.", bounds: "Klip sınırlarını ve altyazı sırasını kontrol et. Süre analiz sınırlarında kalmalı.", captionError: "Bir altyazı segmenti otomatik oluşturmak için çok uzun. Elle kısalt veya sabit yazı kullan.", renderError: "Aktarım başarısız. FFmpeg, yazının kadraja sığması ve kaynağı kontrol edip yeni analiz başlat.",
  captionFit: "Altyazı çıktı karesine sığmıyor. Altyazı metnini kısalt, kaydet ve yeniden aktar.",
  partialSpeech: "Bir konuşma segmenti klip sınırını aşıyor. Alıntı o segmentin bağlamını da içerir; sözcük zamanlaması yoktur. Sınırları düzeltip kaynağı incele.",
  language: "Transkript dili", load: "Klip analizleri yükleniyor…", historyChoose: "Analiz geçmişi", latest: "Son analiz", originalEvidence: "Kanıtlar ilk önerilen aralığa aittir; sınır düzeltmeleri yeniden puanlanmaz."
};
export type ClipText = (key: keyof typeof en) => string;
export const clipText = (language: "tr" | "en"): ClipText => key => (language === "tr" ? tr : en)[key];
export function clipError(error: unknown, t: ClipText) {
  const code = typeof error === "string" ? error : error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (/conflict|revision/u.test(code)) return t("conflict");
  if (/source_changed|transcript_not_ready/u.test(code)) return t("sourceChanged");
  if (/busy/u.test(code)) return t("busy");
  if (/bounds|invalid_input/u.test(code)) return t("bounds");
  if (/caption_segment|caption_limit/u.test(code)) return t("captionError");
  if (/caption_does_not_fit/u.test(code)) return t("captionFit");
  if (/render_failed/u.test(code)) return t("renderError");
  return t("genericError");
}
