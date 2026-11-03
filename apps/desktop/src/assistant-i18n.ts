const en = {
  title: "Editing assistant", intro: "Describe the edit. Review the proposal before changing your timeline.",
  setup: "OpenCode CLI", checking: "Checking local setup…", available: "Available", unavailable: "Unavailable",
  refresh: "Refresh models & history", cliHelp: "Install and sign in through the OpenCode CLI, then refresh. Authentication is managed by the CLI.",
  catalogCurrent: "Model catalog up to date", catalogStale: "Model catalog could not be updated", catalogUpdated: "Last updated",
  noModels: "No models discovered. Configure a provider in OpenCode, then refresh.", model: "Model", chooseModel: "Choose an exact model", request: "Your editing request",
  memory: "Include confirmed account/project memory", memoryHelp: "Optional. Only confirmed account-wide and project memory for this target is included.",
  disclosure: "Generate sends your request, source metadata and current timeline to the selected provider, which may be remote. If you select Include local transcript, its timestamped segments and text are also sent. No media bytes, frames or audio are sent. The CLI uses an isolated temporary session; AtrisShare saves proposal history locally.",
  includeTranscript: "Include local transcript", includeTranscriptHelp: "Off by default. Available only for completed text bound to this source’s SHA-256. This choice also controls transcript-read permission for a new MCP connection.",
  transcriptDisclosure: "Generate will send the selected local transcript’s timestamped segments and text to the selected provider, along with metadata. Audio and media bytes stay local.",
  transcriptIncluded: "Transcript text included", transcriptExcluded: "Transcript text not included", transcriptReadGranted: "Transcript read permitted", transcriptReadExcluded: "Transcript read not permitted",
  transcriptTitle: "Local transcript", transcriptLocalHelp: "Transcription runs locally. Audio stays on this device and your original source is never overwritten. Speech recognition requires a local engine and model.",
  transcriptSetup: "Local transcription tools", transcriptRefresh: "Refresh transcription setup & status", transcriptFfmpeg: "FFmpeg", transcriptWhisper: "whisper.cpp CLI", transcriptModel: "Local model",
  transcriptSetupHelp: "Install a compatible whisper.cpp CLI and speech model locally. Set ATRIS_SHARE_WHISPER_CLI to the executable’s absolute path and ATRIS_SHARE_WHISPER_MODEL to the model’s absolute path. Restart the app after changing its environment, then refresh. Speech models are not downloaded automatically.",
  transcriptStart: "Transcribe locally", transcriptAgain: "Transcribe again locally", transcriptStarting: "Starting local transcription…", transcriptCancel: "Cancel transcription", transcriptCancelling: "Cancellation requested; waiting for the local worker…",
  transcriptRunning: "Transcribing locally", transcriptReady: "Transcript ready", transcriptEmpty: "No completed transcript for this source yet.", transcriptFailed: "Local transcription failed", transcriptCancelled: "Transcription cancelled",
  transcriptStale: "This transcript does not match the current source SHA-256 or account/project. Its text cannot be displayed or included. Refresh or transcribe the current source again.",
  transcriptNoAudio: "This source has no audio track. Local transcription is unavailable.", transcriptLanguage: "Detected language", transcriptDuration: "Source duration", transcriptSegments: "Timestamped text", transcriptMore: "Show next 100 segments",
  transcriptErrorTools: "Speech recognition is not ready. Check the local speech engine and model, then refresh.",
  transcriptErrorProcess: "The local tools could not transcribe this audio. Check your whisper.cpp CLI/model compatibility and try again. No tool diagnostics or private file paths are shown here.",
  transcriptErrorOutput: "The local tool returned invalid or oversized transcript data. Check the whisper.cpp version and local model, then try again.",
  transcriptErrorInterrupted: "The local worker stopped before finishing. Start a new local transcription.", transcriptErrorTimeout: "Local transcription timed out. Check the local tools and try a shorter source.",
  transcriptErrorDuration: "Local transcription supports sources up to two hours. Choose a shorter source.", transcriptErrorSource: "A successfully probed source with valid audio is required. Refresh the source metadata before retrying.",
  transcriptErrorChanged: "The latest transcription job changed. Refresh its status before continuing.",
  generate: "Generate proposal", generating: "Submitting request…", retryGenerate: "Retry generation", toolsRequired: "The assistant will be available once video processing is ready.",
  probeRequired: "Source metadata is required. Choose a successfully probed source.", loading: "Loading workspace…", retry: "Retry", cancel: "Cancel request",
  running: "Generating", cancelling: "Cancelling…", ready: "Ready to review", accepted: "Applied", rejected: "Rejected", failed: "Failed", cancelled: "Cancelled",
  started: "Request started", activity: "Preparing proposal", history: "Recent requests", noHistory: "No requests for this source yet.",
  proposal: "Validated proposal", summary: "Assistant summary", noSummary: "No summary returned.", immutable: "This proposal is immutable. To change it, edit the request and generate another proposal.",
  sourceHash: "Source SHA-256", baseRevision: "Proposal revision", currentRevision: "Current revision", comparison: "Timeline comparison", current: "Current", proposed: "Proposed",
  inSeconds: "Source in", outSeconds: "Source out", crop: "Crop", gain: "Audio gain", caption: "Caption", segments: "Kept source ranges", kept: "Total kept seconds", framing: "Horizontal framing", timedCaptions: "Timed captions",
  original: "Original", vertical: "Vertical", square: "Square", emptyCaption: "No caption", unchanged: "Unchanged", changed: "Changed",
  reloadTimeline: "Reload comparison", stale: "The source or timeline has changed. This proposal cannot be applied. Reload the comparison, then generate a new request against the current timeline.",
  invalidProposal: "The returned edit is not valid for this source. It cannot be previewed or applied. Reject it or edit the request and try again.",
  accept: "Apply to timeline", accepting: "Applying…", reject: "Reject proposal", applyHelp: "Apply adds this edit to the timeline at the revision shown. The source stays intact. Nothing is published.",
  editRetry: "Edit request & retry", preview: "Render proposal preview", previewTitle: "Proposal preview", previewHelp: "This separate preview does not replace the source player or apply the proposal.",
  previewRunning: "Rendering preview", previewReady: "Preview ready", previewFailed: "Preview failed", previewCancelled: "Preview cancelled", previewLookup: "Checking preview render…",
  previewLoading: "Loading preview media…", previewPlayback: "This preview could not be played. Try loading it again.", previewLimit: "This preview exceeds the 256 MB in-app playback limit.",
  mcp: "MCP integration", mcpHelp: "Create a 30-minute connection scoped to this account, project, destination and source. It can inspect metadata, propose edits and start local transcription with media_transcribe, which returns job metadata, not transcript text. transcript_read is granted only when Include local transcript above is selected; confirmed memory is also optional. These choices are fixed when the connection is created. No tool exposes raw media bytes; the connection cannot publish or approve.",
  createGrant: "Create scoped connection", creatingGrant: "Creating connection…", grantExpires: "Expires", tools: "Granted tools", showConfig: "Reveal configuration", hideConfig: "Hide secret", copyConfig: "Copy configuration", copied: "Configuration copied.",
  clipboardFailed: "Clipboard is unavailable. Reveal the configuration and copy it manually.", revoke: "Revoke connection", revoked: "Connection revoked.", expired: "Connection expired. Revoke it to create a new connection.",
  secretHelp: "The grant is a secret capability. Keep it in your local MCP client. It is held only in this panel’s memory and cleared when the source changes; the server expiry still applies.",
  memoryIncluded: "Confirmed memory included", memoryExcluded: "Memory not included", modelUsed: "Requested model", submittedRequest: "Submitted request",
  errorGeneric: "The operation could not be completed. Retry the action or refresh the workspace.",
  errorConnection: "The local runtime is unreachable. Restore the connection, then retry.",
  errorSetup: "OpenCode is unavailable or its configuration could not be verified. Check the local CLI setup and refresh.",
  errorVersion: "This OpenCode version is not supported yet. This adapter has been verified with 1.19.5.",
  errorCatalog: "The model catalog could not be downloaded or verified. Check your connection and refresh models again. Your last saved list is retained.",
  errorModel: "This model is no longer available. Refresh discovery and choose a model again.",
  errorTimeout: "The request timed out. You can edit the request and retry explicitly.",
  errorOutput: "The model did not return a valid edit proposal. Edit the request or choose another model and retry.",
  errorScope: "This operation no longer matches the current account, project or source. Reload the workspace.",
  errorGrant: "The connection grant is expired, revoked or invalid. Create a new scoped connection.",
  errorBusy: "Another operation is in progress for this source. Refresh its status before trying again.",
  errorInput: "Check the selected model and enter a request between 1 and 4,000 characters.",
  errorProcess: "OpenCode could not complete the request. Check your CLI provider sign-in, then edit and retry.",
} as const;

type AssistantKey = keyof typeof en;
const tr: Record<AssistantKey, string> = {
  title: "Kurgu asistanı", intro: "İstediğiniz kurguyu anlatın. Zaman çizelgesini değiştirmeden önce öneriyi inceleyin.",
  setup: "OpenCode CLI", checking: "Yerel kurulum denetleniyor…", available: "Kullanılabilir", unavailable: "Kullanılamıyor",
  refresh: "Modelleri ve geçmişi yenile", cliHelp: "OpenCode CLI’ı kurup CLI üzerinden oturum açın, ardından yenileyin. Kimlik doğrulamayı CLI yönetir.",
  catalogCurrent: "Model kataloğu güncel", catalogStale: "Model kataloğu güncellenemedi", catalogUpdated: "Son güncelleme",
  noModels: "Model bulunamadı. OpenCode’da bir sağlayıcı yapılandırıp yenileyin.", model: "Model", chooseModel: "Tam model adını seçin", request: "Kurgu isteğiniz",
  memory: "Onaylı hesap/proje belleğini ekle", memoryHelp: "İsteğe bağlıdır. Yalnızca bu hedefin hesap geneli ve proje kapsamındaki onaylı belleği eklenir.",
  disclosure: "Öneri oluştur, isteğinizi, kaynak üst verilerini ve güncel zaman çizelgesini uzakta çalışabilen seçili sağlayıcıya gönderir. Yerel dökümü ekle seçilirse zaman damgalı bölümler ve metin de gönderilir. Medya baytları, kare veya ses gönderilmez. CLI izole geçici oturum kullanır; AtrisShare öneri geçmişini yerelde kaydeder.",
  includeTranscript: "Yerel dökümü ekle", includeTranscriptHelp: "Varsayılan olarak kapalıdır. Yalnızca bu kaynağın SHA-256 değeriyle eşleşen tamamlanmış metinde kullanılabilir. Bu seçim, yeni MCP bağlantısının döküm okuma iznini de belirler.",
  transcriptDisclosure: "Öneri oluştur, seçili yerel dökümün zaman damgalı bölümlerini ve metnini üst verilerle birlikte seçili sağlayıcıya gönderecek. Ses ve medya baytları yerelde kalır.",
  transcriptIncluded: "Döküm metni eklendi", transcriptExcluded: "Döküm metni eklenmedi", transcriptReadGranted: "Döküm okuma izni verildi", transcriptReadExcluded: "Döküm okuma izni verilmedi",
  transcriptTitle: "Yerel döküm", transcriptLocalHelp: "Döküm yerel olarak oluşturulur. Ses bu cihazda kalır ve orijinal kaynağın üzerine yazılmaz. Konuşma tanıma için yerel bir motor ve model gerekir.",
  transcriptSetup: "Yerel döküm araçları", transcriptRefresh: "Döküm kurulumunu ve durumunu yenile", transcriptFfmpeg: "FFmpeg", transcriptWhisper: "whisper.cpp CLI", transcriptModel: "Yerel model",
  transcriptSetupHelp: "Uyumlu bir whisper.cpp CLI ve konuşma modelini yerel olarak kurun. ATRIS_SHARE_WHISPER_CLI değerini çalıştırılabilir dosyanın, ATRIS_SHARE_WHISPER_MODEL değerini modelin mutlak yolu olarak ayarlayın. Ortam değiştikten sonra uygulamayı yeniden başlatıp yenileyin. Konuşma modelleri otomatik indirilmez.",
  transcriptStart: "Yerelde döküm oluştur", transcriptAgain: "Yerelde yeniden döküm oluştur", transcriptStarting: "Yerel döküm başlatılıyor…", transcriptCancel: "Dökümü iptal et", transcriptCancelling: "İptal istendi; yerel çalışanın durması bekleniyor…",
  transcriptRunning: "Yerel döküm oluşturuluyor", transcriptReady: "Döküm hazır", transcriptEmpty: "Bu kaynak için henüz tamamlanmış döküm yok.", transcriptFailed: "Yerel döküm başarısız", transcriptCancelled: "Döküm iptal edildi",
  transcriptStale: "Bu döküm, güncel kaynak SHA-256 değeriyle veya hesap/projeyle eşleşmiyor. Metin gösterilemez veya eklenemez. Durumu yenileyin ya da güncel kaynak için yeni döküm oluşturun.",
  transcriptNoAudio: "Bu kaynakta ses izi yok. Yerel döküm oluşturulamaz.", transcriptLanguage: "Algılanan dil", transcriptDuration: "Kaynak süresi", transcriptSegments: "Zaman damgalı metin", transcriptMore: "Sonraki 100 bölümü göster",
  transcriptErrorTools: "Konuşma tanıma hazır değil. Yerel konuşma motorunu ve modelini kontrol edip durumu yenileyin.",
  transcriptErrorProcess: "Yerel araçlar bu sesi döküme çeviremedi. whisper.cpp CLI/model uyumluluğunu denetleyip yeniden deneyin. Araç tanılamaları ve özel dosya yolları burada gösterilmez.",
  transcriptErrorOutput: "Yerel araç geçersiz veya fazla büyük döküm verisi döndürdü. whisper.cpp sürümünü ve yerel modeli denetleyip yeniden deneyin.",
  transcriptErrorInterrupted: "Yerel çalışan tamamlanmadan durdu. Yeni bir yerel döküm başlatın.", transcriptErrorTimeout: "Yerel döküm zaman aşımına uğradı. Yerel araçları denetleyin veya daha kısa bir kaynak deneyin.",
  transcriptErrorDuration: "Yerel döküm en fazla iki saatlik kaynakları destekler. Daha kısa bir kaynak seçin.", transcriptErrorSource: "Geçerli ses içeren, başarıyla analiz edilmiş bir kaynak gerekli. Yeniden denemeden önce kaynak üst verilerini yenileyin.",
  transcriptErrorChanged: "Güncel döküm işi değişti. Devam etmeden önce durumunu yenileyin.",
  generate: "Öneri oluştur", generating: "İstek gönderiliyor…", retryGenerate: "Oluşturmayı yeniden dene", toolsRequired: "Video işleme hazır olduğunda asistanı kullanabilirsiniz.",
  probeRequired: "Kaynak üst verileri gerekli. Başarıyla analiz edilmiş bir kaynak seçin.", loading: "Çalışma alanı yükleniyor…", retry: "Yeniden dene", cancel: "İsteği iptal et",
  running: "Oluşturuluyor", cancelling: "İptal ediliyor…", ready: "İncelemeye hazır", accepted: "Uygulandı", rejected: "Reddedildi", failed: "Başarısız", cancelled: "İptal edildi",
  started: "İstek başlatıldı", activity: "Öneri hazırlanıyor", history: "Son istekler", noHistory: "Bu kaynak için henüz istek yok.",
  proposal: "Doğrulanmış öneri", summary: "Asistan özeti", noSummary: "Özet döndürülmedi.", immutable: "Bu öneri değiştirilemez. Değişiklik için isteği düzenleyip yeni bir öneri oluşturun.",
  sourceHash: "Kaynak SHA-256", baseRevision: "Öneri revizyonu", currentRevision: "Güncel revizyon", comparison: "Zaman çizelgesi karşılaştırması", current: "Güncel", proposed: "Önerilen",
  inSeconds: "Kaynak girişi", outSeconds: "Kaynak çıkışı", crop: "Kırpma", gain: "Ses kazancı", caption: "Altyazı", segments: "Tutulan kaynak aralıkları", kept: "Toplam tutulan saniye", framing: "Yatay kadraj", timedCaptions: "Zamanlı altyazılar",
  original: "Orijinal", vertical: "Dikey", square: "Kare", emptyCaption: "Altyazı yok", unchanged: "Aynı", changed: "Değişti",
  reloadTimeline: "Karşılaştırmayı yenile", stale: "Kaynak veya zaman çizelgesi değişti. Bu öneri uygulanamaz. Karşılaştırmayı yenileyin, ardından güncel zaman çizelgesine göre yeni bir istek oluşturun.",
  invalidProposal: "Döndürülen kurgu bu kaynak için geçerli değil. Önizlenemez veya uygulanamaz. Reddedin ya da isteği düzenleyip yeniden deneyin.",
  accept: "Zaman çizelgesine uygula", accepting: "Uygulanıyor…", reject: "Öneriyi reddet", applyHelp: "Uygula, bu kurguyu gösterilen revizyonda zaman çizelgesine ekler. Kaynak korunur. Hiçbir şey yayınlanmaz.",
  editRetry: "İsteği düzenle ve yeniden dene", preview: "Öneri önizlemesini işle", previewTitle: "Öneri önizlemesi", previewHelp: "Bu ayrı önizleme kaynak oynatıcısını değiştirmez ve öneriyi uygulamaz.",
  previewRunning: "Önizleme işleniyor", previewReady: "Önizleme hazır", previewFailed: "Önizleme başarısız", previewCancelled: "Önizleme iptal edildi", previewLookup: "Önizleme işlemi denetleniyor…",
  previewLoading: "Önizleme medyası yükleniyor…", previewPlayback: "Bu önizleme oynatılamadı. Yeniden yüklemeyi deneyin.", previewLimit: "Bu önizleme, uygulama içi 256 MB oynatma sınırını aşıyor.",
  mcp: "MCP entegrasyonu", mcpHelp: "Bu hesap, proje, hedef ve kaynağa özel, 30 dakikalık bir bağlantı oluşturun. Üst verileri inceleyebilir, kurgu önerebilir ve media_transcribe ile yerel döküm başlatabilir; bu araç döküm metni değil iş üst verilerini döndürür. transcript_read yalnızca yukarıdaki Yerel dökümü ekle seçildiğinde verilir; onaylı bellek de isteğe bağlıdır. Seçimler bağlantı oluşturulurken sabitlenir. Hiçbir araç ham medya baytlarını açmaz; bağlantı yayınlayamaz veya onaylayamaz.",
  createGrant: "Kapsamlı bağlantı oluştur", creatingGrant: "Bağlantı oluşturuluyor…", grantExpires: "Son kullanım", tools: "İzin verilen araçlar", showConfig: "Yapılandırmayı göster", hideConfig: "Gizli anahtarı gizle", copyConfig: "Yapılandırmayı kopyala", copied: "Yapılandırma kopyalandı.",
  clipboardFailed: "Pano kullanılamıyor. Yapılandırmayı gösterip elle kopyalayın.", revoke: "Bağlantıyı iptal et", revoked: "Bağlantı iptal edildi.", expired: "Bağlantının süresi doldu. Yeni bağlantı oluşturmak için mevcut bağlantıyı iptal edin.",
  secretHelp: "Bağlantı anahtarı gizli bir yetkidir. Yerel MCP istemcinizde tutun. Yalnızca bu panelin belleğinde saklanır, kaynak değiştiğinde temizlenir; sunucudaki süre sınırı geçerliliğini korur.",
  memoryIncluded: "Onaylanmış bellek eklendi", memoryExcluded: "Bellek eklenmedi", modelUsed: "İstenen model", submittedRequest: "Gönderilen istek",
  errorGeneric: "İşlem tamamlanamadı. İşlemi yeniden deneyin veya çalışma alanını yenileyin.",
  errorConnection: "Yerel çalışma zamanına ulaşılamıyor. Bağlantıyı düzeltip yeniden deneyin.",
  errorSetup: "OpenCode kullanılamıyor veya yapılandırması doğrulanamadı. Yerel CLI kurulumunu denetleyip yenileyin.",
  errorVersion: "Bu OpenCode sürümü henüz desteklenmiyor. Bu adaptör 1.19.5 ile doğrulandı.",
  errorCatalog: "Model kataloğu indirilemedi veya doğrulanamadı. Bağlantınızı denetleyip modelleri yeniden yenileyin. Son kaydedilen liste korunur.",
  errorModel: "Bu model artık kullanılamıyor. Model listesini yenileyip tekrar seçim yapın.",
  errorTimeout: "İstek zaman aşımına uğradı. İsteği düzenleyip yeniden başlatabilirsiniz.",
  errorOutput: "Model geçerli bir kurgu önerisi döndürmedi. İsteği düzenleyin veya başka bir model seçip yeniden deneyin.",
  errorScope: "Bu işlem artık güncel hesap, proje veya kaynakla eşleşmiyor. Çalışma alanını yeniden yükleyin.",
  errorGrant: "Bağlantı anahtarının süresi dolmuş, iptal edilmiş veya geçersiz. Yeni bir kapsamlı bağlantı oluşturun.",
  errorBusy: "Bu kaynakta başka bir işlem sürüyor. Yeniden denemeden önce durumu yenileyin.",
  errorInput: "Seçili modeli denetleyin ve 1–4.000 karakter uzunluğunda bir istek girin.",
  errorProcess: "OpenCode isteği tamamlayamadı. CLI sağlayıcı oturumunu denetleyip isteği düzenleyerek yeniden deneyin.",
};

export type AssistantTranslate = (key: AssistantKey) => string;
export function assistantText(language: "tr" | "en"): AssistantTranslate { return key => (language === "tr" ? tr : en)[key]; }
export function assistantError(error: unknown, t: AssistantTranslate): string {
  const code = typeof error === "string" ? error : error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (/transcript|transcription/u.test(code)) return transcriptionError(error, t);
  if (/revision|conflict|stale|source_changed|hash_mismatch/u.test(code)) return t("stale");
  if (/connection_failed|invalid_runtime|network/u.test(code) || error instanceof TypeError) return t("errorConnection");
  if (/ai_version_unsupported/u.test(code)) return t("errorVersion");
  if (/ai_catalog_refresh_failed/u.test(code)) return t("errorCatalog");
  if (/ai_(unavailable|configuration_unsafe|invalid_executable|cleanup_failed)|tools_unavailable|media_tools/u.test(code)) return t("errorSetup");
  if (/model_unavailable|model_not_found/u.test(code)) return t("errorModel");
  if (/timeout/u.test(code)) return t("errorTimeout");
  if (/protocol|output_limit|invalid_proposal|invalid_edit/u.test(code)) return t("errorOutput");
  if (/grant|capability/u.test(code)) return t("errorGrant");
  if (/scope|context|account|destination|project|not_found/u.test(code)) return t("errorScope");
  if (/busy|running|invalid_state/u.test(code)) return t("errorBusy");
  if (/invalid_input|invalid_request|validation/u.test(code)) return t("errorInput");
  if (/process_failed|provider|auth/u.test(code)) return t("errorProcess");
  return t("errorGeneric");
}

export function transcriptionError(error: unknown, t: AssistantTranslate): string {
  const code = typeof error === "string" ? error : error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (/source_changed|hash_mismatch/u.test(code)) return t("transcriptStale");
  if (/connection_failed|invalid_runtime|network/u.test(code) || error instanceof TypeError) return t("errorConnection");
  if (/unavailable|model_unavailable_absolute_path_required/u.test(code)) return t("transcriptErrorTools");
  if (/scope|context|account|project|not_found/u.test(code)) return t("errorScope");
  if (/job_changed/u.test(code)) return t("transcriptErrorChanged");
  if (/busy|running|invalid_state/u.test(code)) return t("errorBusy");
  if (/unsupported_duration/u.test(code)) return t("transcriptErrorDuration");
  if (/no_audio/u.test(code)) return t("transcriptNoAudio");
  if (/invalid_source|invalid_audio/u.test(code)) return t("transcriptErrorSource");
  if (/interrupted/u.test(code)) return t("transcriptErrorInterrupted");
  if (/timeout/u.test(code)) return t("transcriptErrorTimeout");
  if (/invalid_output|invalid_timestamps|invalid_progress|output_limit/u.test(code)) return t("transcriptErrorOutput");
  if (/ffmpeg_failed|whisper_failed|whisper_incompatible|transcription_failed/u.test(code)) return t("transcriptErrorProcess");
  return t("errorGeneric");
}
