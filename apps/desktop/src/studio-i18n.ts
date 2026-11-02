export type StudioLanguage = "tr" | "en";

const en = {
  toolSettings: "Open video tool settings",
  editingMode: "Non-destructive editing", clipsMode: "Find and refine short clips", assistantMode: "Review AI edit proposals", publishMode: "Prepare a YouTube publication",
  clips: "Clips", framing: "Horizontal framing · left → right",
  studio: "Video editor", studioTitle: "Video editor", subtitle: "Import footage, shape your timeline and export your video.", media: "Video editor", publishing: "Publishing", channel: "Channel",
  mediaCount: "media files", mediaCountOne: "media file", import: "Import video", importing: "Importing video…", refresh: "Refresh", retry: "Try again", loading: "Loading…",
  chooseProject: "Choose a project to open Studio", chooseProjectHelp: "Select a project in the workspace bar. Media and publications belong to that account and project.",
  scopeMismatch: "Select the matching workspace account to open Studio.", library: "Library", source: "Source", exported: "Export", linked: "Linked to channel",
  emptyLibrary: "Your media starts here", emptyLibraryHelp: "Import an MP4, MOV, WebM or MKV file to preview, edit and prepare a publication.",
  selectMedia: "Select a video", selectMediaHelp: "Choose a file from the library to preview it and open its inspector.", preview: "Source preview",
  previewLoading: "Loading video…", previewFailed: "This video could not be played in the desktop player. You can still download it or export a compatible version.",
  previewLimit: "This player can load files up to 256 MB. Create a compatible preview for a larger source. If that preview also exceeds the limit, editing and exporting remain available.",
  download: "Download file", noProbe: "Media details unavailable", duration: "Duration", dimensions: "Dimensions", size: "File size", hash: "SHA-256", filename: "File",
  publish: "Publish", edit: "Edit video", destination: "Destination", channelId: "Channel ID", title: "Title", description: "Description", visibility: "Visibility",
  private: "Private", unlisted: "Unlisted", public: "Public", madeForKids: "Made for kids", notifySubscribers: "Notify subscribers", yes: "Yes", no: "No",
  createDraft: "Create review draft", draftHelp: "Creates an immutable draft. Upload starts only after you review and approve its exact contents.",
  connectRequired: "Connect this YouTube account to publish or refresh its channel catalog.", unsupported: "Publishing and channel access are currently available for connected YouTube accounts.",
  noPublications: "No publications yet", noPublicationsHelp: "Select a video in Media and create a review draft. Every upload requires your approval.",
  review: "Awaiting review", uploading: "Uploading", uncertain: "Needs reconciliation", processing: "YouTube processing", succeeded: "Completed", failed: "Failed", cancelled: "Cancelled", running: "Rendering",
  reviewApprove: "Review & approve", cancel: "Cancel", reconcile: "Check existing upload", reconcileHelp: "Checks the existing upload. Remaining bytes resume only while approval is valid and dispatch has not been cancelled; a new upload is never created.",
  openYouTube: "Open on YouTube", approvalTitle: "Approve this publication?", approvalHelp: "Approval is bound to this draft and file hash. It authorizes this upload for 10 minutes. Expiry or cancellation stops further byte dispatch; an existing provider result can still be checked.",
  approveUpload: "Approve & upload", back: "Back", close: "Close", digest: "Draft digest", approvalExpires: "Approval expires", reviewExpired: "This approval window has expired. Cancel this draft and create a new review draft.",
  immutableHelp: "To change these details, cancel this draft and create another.", draftCreated: "Draft created. Review it before uploading.", imported: "Video imported.", downloadReady: "Download started.",
  sourceSafe: "Your source file is never overwritten.", editorTitle: "Clip settings", trimIn: "In (seconds)", trimOut: "Out (seconds)", trimHelp: "The highlighted range is exported. The player above shows the original source.",
  aspect: "Aspect ratio", original: "Original", vertical: "Vertical · 9:16", square: "Square · 1:1", gain: "Audio gain (dB)", caption: "Caption", captionHelp: "Burned into the exported video. Leave empty for no caption.",
  save: "Save edit", undo: "Undo", redo: "Redo", export: "Export video", unsaved: "Unsaved changes", saved: "Edit saved", saveBeforeExport: "Save your changes before exporting.",
  noEdits: "Save a clip setting to enable export.", timeline: "Source timeline", selectedRange: "Selected range", invalidTrim: "Enter a valid range within the source duration and a gain between −60 and 24 dB.",
  toolsMissing: "Set up video processing", toolsHelp: "Install FFmpeg and FFprobe, then save their file paths in Settings → Video tools. Fully quit and reopen the app to activate them.",
  durationRequired: "A probed source duration is required to edit this file. After configuring FFprobe, import the source again to inspect it.", renderJobs: "Media jobs", renderReady: "Export added to your library.", openExport: "Open export", renderStarted: "Export started.",
  channelTitle: "Channel catalog", channelHelp: "Refresh explicitly to retrieve videos from this connected YouTube channel.", catalogEmpty: "No channel videos returned.", catalogNotLoaded: "The channel catalog has not been loaded.", loadMore: "Load more", linkVideo: "Link selected file", linkHelp: "Links the selected local file to a video owned by this channel. Ownership is validated by YouTube on the service.",
  linkedDone: "Channel video linked to the selected file.", selectedFile: "Selected local file", selectToLink: "Select a local file in Media before linking a channel video.",
  progress: "Progress", operationFailed: "The operation could not be completed. Try again.", networkError: "Could not reach the local service. Check the connection and try again.",
  invalidMedia: "This video file is invalid or unsupported. Choose a self-contained MP4, MOV, WebM or MKV video.", mediaTooLarge: "This file exceeds the import size limit configured by the service.",
  mediaMissing: "This media file is no longer available. Refresh the library.", revisionConflict: "The timeline changed elsewhere. Reload it before applying another edit.",
  approvalInvalid: "Approval is expired or no longer matches this draft. Refresh and review the publication again.", publicationState: "This action is not available in the publication’s current state. Refresh to see its latest status.",
  accountUnavailable: "Reconnect the YouTube account and verify the selected channel before continuing.", quotaError: "YouTube could not accept this request because of a quota or rate limit. Try again later.",
  renderFailed: "The export could not be completed. Check the source and local FFmpeg setup.", linkFailed: "This video could not be verified as owned by the selected channel.",
  cancelledNotice: "Cancellation requested.", dispatchStopped: "Further uploading is stopped. Check the existing session to recover any result already accepted by YouTube.", captionTooLong: "This caption does not fit the output frame. Shorten it and export again.", refreshTimeline: "Reload timeline", noAudio: "No audio stream", ffmpeg: "FFmpeg", ffprobe: "FFprobe", available: "Available", unavailable: "Unavailable",
  assistant: "AI assistant", keptRanges: "Kept ranges", range: "Range", outputDuration: "Kept duration", sourceDuration: "Source duration", sourceTime: "Source time", outputTime: "Output",
  splitAt: "Split at source second", split: "Split", removeRange: "Remove", usePlayhead: "Use player time", globalSettings: "Settings for all ranges",
  rangesHelp: "Split inside the selected range, then trim or remove ranges. Gaps are skipped; exports join kept ranges in source order. At least one range must remain.",
  rangeLimit: "32 ranges maximum. Trim or remove an existing range to continue.", invalidRanges: "Keep 1–32 ordered, non-overlapping ranges within the source. Each end must follow its start. Gain must be −60 to 24 dB; captions cannot contain control characters.",
  previewMode: "Playback version", compatiblePreview: "Compatible preview", proxyAvailable: "Preview ready", proxyUnavailable: "Preview not created", proxyPending: "Preparing preview…",
  createProxy: "Create compatible preview", rebuildProxy: "Rebuild preview", previewUnedited: "Full source playback · edits appear in exports only.", proxyToolsRequired: "Compatible previews require local FFmpeg and FFprobe.",
  proxyFailed: "The compatible preview could not be created. Check the local FFmpeg setup and try again.",
} as const;

type StudioTextKey = keyof typeof en;
const tr: Record<StudioTextKey, string> = {
  toolSettings: "Video araç ayarlarını aç",
  editingMode: "Kaynağı koruyan düzenleme", clipsMode: "Kısa klipleri bul ve düzenle", assistantMode: "AI kurgu önerilerini incele", publishMode: "YouTube yayını hazırla",
  clips: "Klipler", framing: "Yatay kadraj · sol → sağ",
  studio: "Video editörü", studioTitle: "Video editörü", subtitle: "Videonu içe aktar, zaman çizelgesini düzenle ve dışa aktar.", media: "Video editörü", publishing: "Yayınlar", channel: "Kanal",
  mediaCount: "medya dosyası", mediaCountOne: "medya dosyası", import: "Video içe aktar", importing: "Video içe aktarılıyor…", refresh: "Yenile", retry: "Tekrar dene", loading: "Yükleniyor…",
  chooseProject: "Stüdyoyu açmak için bir proje seçin", chooseProjectHelp: "Çalışma alanı çubuğundan bir proje seçin. Medya ve yayınlar bu hesaba ve projeye aittir.",
  scopeMismatch: "Stüdyoyu açmak için eşleşen çalışma alanı hesabını seçin.", library: "Kitaplık", source: "Kaynak", exported: "Dışa aktarım", linked: "Kanal ile bağlantılı",
  emptyLibrary: "Medyanız burada başlar", emptyLibraryHelp: "Önizlemek, düzenlemek ve yayın hazırlamak için bir MP4, MOV, WebM veya MKV dosyası içe aktarın.",
  selectMedia: "Bir video seçin", selectMediaHelp: "Önizleme ve ayrıntılar için kitaplıktan bir dosya seçin.", preview: "Kaynak önizlemesi",
  previewLoading: "Video yükleniyor…", previewFailed: "Bu video masaüstü oynatıcısında oynatılamadı. Dosyayı indirebilir veya uyumlu bir sürümünü dışa aktarabilirsiniz.",
  previewLimit: "Bu oynatıcı en fazla 256 MB yükleyebilir. Büyük kaynaklar için uyumlu önizleme oluşturun. Önizleme de sınırı aşarsa düzenleme ve dışa aktarma kullanılabilir.",
  download: "Dosyayı indir", noProbe: "Medya bilgileri alınamadı", duration: "Süre", dimensions: "Boyutlar", size: "Dosya boyutu", hash: "SHA-256", filename: "Dosya",
  publish: "Yayınla", edit: "Video düzenle", destination: "Hedef", channelId: "Kanal kimliği", title: "Başlık", description: "Açıklama", visibility: "Görünürlük",
  private: "Gizli", unlisted: "Liste dışı", public: "Herkese açık", madeForKids: "Çocuklara özel", notifySubscribers: "Abonelere bildirim gönder", yes: "Evet", no: "Hayır",
  createDraft: "İnceleme taslağı oluştur", draftHelp: "Değiştirilemez bir taslak oluşturur. Yükleme, içeriği gözden geçirip onayladıktan sonra başlar.",
  connectRequired: "Yayınlamak veya kanal listesini yenilemek için bu YouTube hesabını bağlayın.", unsupported: "Yayınlama ve kanal erişimi şu anda bağlı YouTube hesaplarında kullanılabilir.",
  noPublications: "Henüz yayın yok", noPublicationsHelp: "Medya bölümünden bir video seçip inceleme taslağı oluşturun. Her yükleme onayınızı gerektirir.",
  review: "İnceleme bekliyor", uploading: "Yükleniyor", uncertain: "Durum kontrolü gerekli", processing: "YouTube işliyor", succeeded: "Tamamlandı", failed: "Başarısız", cancelled: "İptal edildi", running: "Dışa aktarılıyor",
  reviewApprove: "İncele ve onayla", cancel: "İptal et", reconcile: "Mevcut yüklemeyi kontrol et", reconcileHelp: "Mevcut yüklemeyi kontrol eder. Kalan veriler yalnızca onay geçerliyken ve yükleme iptal edilmemişken sürdürülür; yeni bir yükleme oluşturulmaz.",
  openYouTube: "YouTube’da aç", approvalTitle: "Bu yayın onaylansın mı?", approvalHelp: "Onay bu taslağa ve dosya özetine bağlıdır; yükleme için 10 dakika geçerlidir. Süre dolması veya iptal, yeni veri gönderimini durdurur; sağlayıcının kabul ettiği sonuç yine kontrol edilebilir.",
  approveUpload: "Onayla ve yükle", back: "Geri", close: "Kapat", digest: "Taslak özeti", approvalExpires: "Onay bitişi", reviewExpired: "Bu onay süresi doldu. Bu taslağı iptal edip yeni bir inceleme taslağı oluşturun.",
  immutableHelp: "Bu bilgileri değiştirmek için taslağı iptal edip yeni bir taslak oluşturun.", draftCreated: "Taslak oluşturuldu. Yüklemeden önce gözden geçirin.", imported: "Video içe aktarıldı.", downloadReady: "İndirme başlatıldı.",
  sourceSafe: "Kaynak dosyanızın üzerine asla yazılmaz.", editorTitle: "Klip ayarları", trimIn: "Başlangıç (saniye)", trimOut: "Bitiş (saniye)", trimHelp: "Vurgulanan aralık dışa aktarılır. Yukarıdaki oynatıcı özgün kaynağı gösterir.",
  aspect: "En boy oranı", original: "Özgün", vertical: "Dikey · 9:16", square: "Kare · 1:1", gain: "Ses kazancı (dB)", caption: "Altyazı", captionHelp: "Dışa aktarılan videoya işlenir. Altyazı istemiyorsanız boş bırakın.",
  save: "Düzenlemeyi kaydet", undo: "Geri al", redo: "Yinele", export: "Videoyu dışa aktar", unsaved: "Kaydedilmemiş değişiklikler", saved: "Düzenleme kaydedildi", saveBeforeExport: "Dışa aktarmadan önce değişikliklerinizi kaydedin.",
  noEdits: "Dışa aktarımı açmak için bir klip ayarı kaydedin.", timeline: "Kaynak zaman çizelgesi", selectedRange: "Seçili aralık", invalidTrim: "Kaynak süresi içinde geçerli bir aralık ve −60 ile 24 dB arasında ses kazancı girin.",
  toolsMissing: "Video işleme araçlarını ayarla", toolsHelp: "FFmpeg ve FFprobe’u kurduktan sonra Ayarlar → Video araçları bölümünden dosya yollarını kaydet. Etkinleştirmek için uygulamadan tamamen çıkıp yeniden aç.",
  durationRequired: "Düzenleme için kaynak süresinin analiz edilmesi gerekir. FFprobe’u yapılandırdıktan sonra analiz için kaynağı yeniden içe aktarın.", renderJobs: "Medya işlemleri", renderReady: "Dışa aktarılan dosya kitaplığınıza eklendi.", openExport: "Çıktıyı aç", renderStarted: "Dışa aktarım başladı.",
  channelTitle: "Kanal videoları", channelHelp: "Bu bağlı YouTube kanalının videolarını almak için yenileyin.", catalogEmpty: "Kanal videosu bulunamadı.", catalogNotLoaded: "Kanal videoları henüz yüklenmedi.", loadMore: "Daha fazla yükle", linkVideo: "Seçili dosyayı bağla", linkHelp: "Seçili yerel dosyayı bu kanala ait bir videoyla eşleştirir. Sahiplik, serviste YouTube üzerinden doğrulanır.",
  linkedDone: "Kanal videosu seçili dosyayla eşleştirildi.", selectedFile: "Seçili yerel dosya", selectToLink: "Bir kanal videosunu bağlamadan önce Medya bölümünden yerel bir dosya seçin.",
  progress: "İlerleme", operationFailed: "İşlem tamamlanamadı. Tekrar deneyin.", networkError: "Yerel servise ulaşılamadı. Bağlantıyı kontrol edip tekrar deneyin.",
  invalidMedia: "Bu video geçersiz veya desteklenmiyor. Harici kaynağa bağlı olmayan bir MP4, MOV, WebM veya MKV video seçin.", mediaTooLarge: "Dosya, servisin içe aktarma boyut sınırını aşıyor.",
  mediaMissing: "Bu medya dosyası artık kullanılamıyor. Kitaplığı yenileyin.", revisionConflict: "Zaman çizelgesi başka bir yerde değişti. Yeni düzenleme yapmadan önce yeniden yükleyin.",
  approvalInvalid: "Onayın süresi doldu veya bu taslakla eşleşmiyor. Yenileyip yayını tekrar gözden geçirin.", publicationState: "Yayının mevcut durumunda bu işlem kullanılamıyor. Son durum için yenileyin.",
  accountUnavailable: "Devam etmeden önce YouTube hesabını yeniden bağlayıp seçili kanalı doğrulayın.", quotaError: "YouTube, kota veya hız sınırı nedeniyle isteği kabul edemedi. Daha sonra tekrar deneyin.",
  renderFailed: "Dışa aktarım tamamlanamadı. Kaynağı ve yerel FFmpeg kurulumunu kontrol edin.", linkFailed: "Bu videonun seçili kanala ait olduğu doğrulanamadı.",
  cancelledNotice: "İptal isteği gönderildi.", dispatchStopped: "Yeni veri gönderimi durduruldu. YouTube’un daha önce kabul ettiği bir sonuç varsa mevcut oturumu kontrol ederek görebilirsiniz.", captionTooLong: "Altyazı çıktı karesine sığmıyor. Kısaltıp yeniden dışa aktarın.", refreshTimeline: "Zaman çizelgesini yeniden yükle", noAudio: "Ses akışı yok", ffmpeg: "FFmpeg", ffprobe: "FFprobe", available: "Kullanılabilir", unavailable: "Kullanılamıyor",
  assistant: "AI asistanı", keptRanges: "Korunan aralıklar", range: "Aralık", outputDuration: "Korunan süre", sourceDuration: "Kaynak süresi", sourceTime: "Kaynak zamanı", outputTime: "Çıktı",
  splitAt: "Bölme zamanı (kaynak sn)", split: "Böl", removeRange: "Kaldır", usePlayhead: "Oynatıcı zamanını kullan", globalSettings: "Tüm aralıkların ayarları",
  rangesHelp: "Seçili aralığı içinden bölün; aralıkları kırpın veya kaldırın. Boşluklar atlanır; korunan aralıklar kaynak sırasıyla birleştirilir. En az bir aralık kalmalıdır.",
  rangeLimit: "En fazla 32 aralık. Devam etmek için mevcut bir aralığı kırpın veya kaldırın.", invalidRanges: "Kaynak içinde sıralı, örtüşmeyen 1–32 aralık tutun. Bitiş başlangıçtan sonra olmalıdır. Ses kazancı −60 ile 24 dB arasında olmalı; altyazı kontrol karakteri içermemelidir.",
  previewMode: "Oynatma sürümü", compatiblePreview: "Uyumlu önizleme", proxyAvailable: "Önizleme hazır", proxyUnavailable: "Önizleme oluşturulmadı", proxyPending: "Önizleme hazırlanıyor…",
  createProxy: "Uyumlu önizleme oluştur", rebuildProxy: "Önizlemeyi yeniden oluştur", previewUnedited: "Tam kaynak oynatımı · düzenlemeler yalnızca çıktıda görünür.", proxyToolsRequired: "Uyumlu önizleme için yerel FFmpeg ve FFprobe gerekir.",
  proxyFailed: "Uyumlu önizleme oluşturulamadı. Yerel FFmpeg kurulumunu kontrol edip tekrar deneyin.",
};

export function studioText(language: StudioLanguage) {
  return (key: StudioTextKey): string => (language === "tr" ? tr : en)[key];
}
export type StudioTranslate = ReturnType<typeof studioText>;

const errors: Record<string, StudioTextKey> = {};
function codes(key: StudioTextKey, values: string) { for (const code of values.split(" ")) errors[code] = key; }
codes("networkError", "connection_failed invalid_runtime network_error fetch_failed");
codes("invalidMedia", "unsupported_media_extension invalid_media_container external_media_reference invalid_media_file invalid_media_probe media_video_required invalid_media_extension invalid_media_type invalid_media_filename");
codes("mediaTooLarge", "media_too_large media_size_limit payload_too_large import_too_large body_too_large");
codes("mediaMissing", "artifact_not_found media_not_found media_file_not_found");
codes("revisionConflict", "revision_conflict timeline_revision_conflict stale_revision");
codes("approvalInvalid", "approval_expired approval_stale approval_digest_mismatch publication_digest_mismatch invalid_approval approval_required");
codes("publicationState", "publication_busy media_busy invalid_publication_state publication_state_conflict publication_not_found invalid_render_state render_not_found");
codes("accountUnavailable", "youtube_reauth_required youtube_not_connected account_not_connected youtube_destination_mismatch youtube_channel_mismatch destination_mismatch youtube_scope_missing youtube_missing_scope youtube_account_required connected_youtube_required youtube_access_denied");
codes("quotaError", "youtube_quota_exceeded youtube_rate_limited quota_exceeded rate_limited");
codes("toolsMissing", "media_tool_unavailable ffmpeg_unavailable ffprobe_unavailable media_tools_unavailable media_tools_missing");
codes("invalidRanges", "timeline_bounds media_trim_out_of_bounds invalid_edit invalid_timeline_edit invalid_segments media_segments_out_of_bounds");
codes("renderFailed", "media_render_failed media_ffmpeg_failed media_ffprobe_failed media_tool_timeout media_render_incomplete ffmpeg_failed render_failed");
codes("captionTooLong", "media_caption_does_not_fit");
codes("dispatchStopped", "publication_dispatch_stopped publication_cancel_pending");
codes("linkFailed", "youtube_video_not_owned youtube_video_not_found video_not_owned");
codes("previewLimit", "studio_blob_limit");
codes("proxyFailed", "media_proxy_failed proxy_failed media_proxy_incomplete");
codes("reconcileHelp", "youtube_upload_uncertain publication_uncertain");

/** Never display arbitrary provider responses, paths or stack traces as UI text. */
export function studioError(error: unknown, t: StudioTranslate, fallback: (e: unknown) => string): string {
  const code = typeof error === "string" ? error : error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const key = errors[code];
  if (key) return t(key);
  if (error instanceof TypeError) return t("networkError");
  if (["unauthorized", "forbidden", "context_mismatch", "project_not_found", "account_not_found"].includes(code)) {
    const message = fallback(error);
    if (message && message !== code && message.length <= 240 && !/[_{}<>]|https?:\/\//.test(message)) return message;
  }
  return t("operationFailed");
}
