<div align="center">
  <h1>AtrisShare</h1>
  <p><strong>Üret, düzenle ve paylaş — AI desteğiyle, kontrol sende.</strong></p>
  <p>
    <a href="README.md">English</a> ·
    <a href="README.tr.md"><strong>Türkçe</strong></a> ·
    <a href="https://atrishub.com">AtrisHub</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/status-Local%20Workspace%20Preview-orange" alt="Yerel Çalışma Alanı Ön İzlemesi" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache Lisansı 2.0" /></a>
  </p>
</div>

## AtrisShare nedir?

AtrisShare; **YouTube, X, TikTok ve LinkedIn** için AI destekli video üretimini
ve sosyal medya paylaşımını bir araya getirmek üzere geliştirilen, açık kaynaklı,
yerel öncelikli bir çalışma alanıdır. Hedef; manuel veya AI yardımıyla video
düzenlemek, kısa klipler çıkarmak, yazı hazırlamak, birden fazla hesabı yönetmek
ve paylaşımları tek uygulama üzerinden planlamaktır.

**Yerel Çalışma Alanı Ön İzlemesi `0.1.0-preview.1`:** React/Tauri masaüstü,
oturum doğrulamalı yerel API, SQLite projeler, kalıcı hesap/proje seçimi ve kapsamlı
hafıza yönetimi uygulanmıştır. Sosyal hesap gerektirmeyen gerçek yerel video projeleri oluşturabilir,
kaynak bilgisi ile öneri/onaylı durumları tutulan notlar ekleyebilir, düzenleyebilir
ve silebilirsin. Koyu/açık tema ve Türkçe/İngilizce arayüz vardır. Windows DPAPI
tabanlı dahili kimlik kasası hazırdır. Uygulama sahte sosyal hesap oluşturmaz;
önceki sürümün yerel kayıtları yayın yetkisi verilmeden korunur.

**Aşama 2 özellikleri uygulandı; canlı kabul Aşama 9'a ertelendi:** YouTube Desktop OAuth/PKCE,
kimlik/kanal doğrulaması, kasa, yenileme/bağlantı iptali, sahip olunan videoların
sayfalı kataloğu ve yerel dosya eşleme, değişmez yayın incelemesi, sürdürülebilir
yükleme, işleme kontrolü ve sonuç/uzlaştırma akışları vardır. Testler gerçek servisleri
kontrollü sağlayıcılarla çalıştırır; **canlı Google testi değildir**. Canlı bağlantı
veya yayın için sana ait OAuth uygulaması, yetkili kanal ve açık insan onayı gerekir;
canlı Google kabulü yapıldığı iddia edilmez. [YouTube rehberi](docs/YOUTUBE.md).

**Aşama 3, sınırlı manuel editör kapsamında tamamlandı:** değişmez kaynak medya,
tam kaynak uyumlu proxy (H.264/AAC, en fazla 1280×720, dönüş ve görüntü oranı korunur),
kaynak zamanıyla oynatma, kırpma/bölme/silme ve dış sınırlar içindeki 1–32 sıralı,
çakışmayan aralığın boşlukları gerçekten çıkarılarak birleştirilmesi. Çıktıda ortak
A/V zaman başlangıcı korunur; ses ofseti dahil eksik ses aralıkları sessizlikle doldurulur. Özgün/dikey/kare merkez
kadraj, statik altyazı, ses kazancı, revizyon kontrollü kaydetme, dallanan geri al/yinele,
yeniden açma ve ilerleme/iptal destekli dışa aktarma vardır. Tekrar deneme yeni çıktı
başlatır. Çok kanallı kurgu uygulanmadı; Aşama 5 zamanlı klip altyazılarını ekler.

**Aşama 4 çekirdek özellik uygulaması tamamlandı:** izole OpenCode köprüsü, model seçimi,
kalıcı ve incelenebilir düzenleme teklifleri, yerel zaman damgalı transkripsiyon ve
açık transkript okuma izniyle resmi SDK stdio MCP. Yerel native kontroller gerçek
OpenCode 1.19.5 keşfini ve harici SDK istemcisinden deterministik teklif → ön izleme →
insan uygulaması → geri al akışını kapsadı; **canlı LLM çıkarımı yapılmadı**.
OpenCode gerekli ilk gerçek adaptördür; diğer CLI adaptörleri gelecek genişletmelerdir.
Windows'ta özel başlık
çubuğu ve kapanışta runtime sahipliği vardır; UI'da aşama rozetleri yoktur.
Yerel zamanlayıcı, tray/bildirim ve diğer resmi API adaptörleri aşağıdaki kapsamda uygulanmıştır.
İmzalı kurulum paketi yayınlanmadı.

**Aşama 5 klip keşfi uygulandı:** Stüdyo → Klipler, yerel zaman damgalı konuşma/sahne/
sessizlik sıralaması veya açık metin paylaşımı izniyle seçili OpenCode modelinden
gerekçeli sıralama sunar. 2–180 saniye sınırlarını seç, kanıtı incele, başlangıç/bitişi,
sabit kadrajı ve zamanlı altyazıları düzelt; birden fazla klibi dışa aktar ve gizli
YouTube inceleme taslakları hazırla. Kalıcı analizler kaynak/transkript hash'ine,
hesap/proje/hedefe ve timeline revizyonuna bağlıdır. Yüz takibi/görsel model analizi
yoktur; puanlar kurgu ipucudur. Gerçek yerel medya/UI ve kontrollü AI çıktısı
mühendislik kanıtıdır; canlı model/Google kabulü Aşama 9'da kalır.
[Klip akışı ve sınırlar](docs/CLIPS.md).

**Aşama 6–8:** kalıcı tek-seferlik/günlük/haftalık IANA kuyruk her tekrar için yeni
insan incelemesi üretir; DST, kaçırılmış zaman ve süre sonu korunur. X/LinkedIn metin/
video, TikTok video, bağımsız çoklu hedefler ve opt-in AI metin önerileri resmi
uygulama/izin/rol koşullarıyla uygulanmıştır. Windows tray/bildirim, kapsamlı hafıza
JSON dışa aktarma ve hash doğrulamalı paket/lisans hazırlığı vardır. Canlı sağlayıcı/
temiz kurulum kabulü Aşama 9'da; paketleme yayın izni değildir. [Zamanlayıcı](docs/SCHEDULING.md),
[sosyal kurulum](docs/SOCIAL.md), [veri](docs/DATA.md), [paketleme](docs/PACKAGING.md).

## Kullanım akışı

1. Bir veya birden fazla hesabı bağla, işlem yapılacak kanal/profili açıkça seç.
2. Kaynak videonu içe aktar veya yetkili olduğun kanalın video listesini ve eski düzenlemeleri incele.
3. Orijinali değiştirmeyen zaman çizelgesinde manuel çalış ya da yandaki AI asistanından yardım al.
4. AI’dan örneğin 30 saniyelik dikey klip önerileri al; zaman damgalı gerekçelerini
   incele, seç ve gerektiğinde yeniden düzenle.
5. Video/Shorts veya yazı paylaşımını platforma özel ön izleme ve bilgilerle hazırla.
6. Hemen paylaşmayı seç veya saat dilimine göre tek seferlik, günlük ya da haftalık sıraya al.
7. Her paylaşım öncesinde bildirim al; son içeriği ve hedef hesabı onayla.
   Onaylanmayan zamanlanmış işler bekler; kendiliğinden yayınlanmaz.

Hesap/proje kapsamlı notlarla marka dili, hedef kitle ve kararlar tutulabilir;
başarılı dışa aktarma/yayın işlemleri kapsamlı geçmiş notları ekler. AI, isteğe bağlı
olarak onaylı hesap/proje notlarını kullanabilir.
Her hafıza işleminde açık kapsam kontrol edilir; mevcut YouTube onayları hesap,
proje, hedef, metadata ve dosya SHA-256 değerine bağlıdır. Açık onay tek kullanımlıktır
ve gönderim için 10 dakika geçerlidir. İptal, gönderim yetkisinin geri alınmasını
kalıcı tutar; uzakta gerçekleşmiş etkileri geri alma garantisi vermez.

## AI seçimi ve video araçları

`OpenCodeBridge` native kurulumu güvenli keşfeder; şu an yalnızca doğrulanmış
**OpenCode 1.19.5** kabul edilir, diğer sürümler engellenir. Kurulum/giriş resmi CLI
üzerinden yapılır. AtrisShare kimlik deposunun yolunu korur; kimlik bilgilerini
okumaz veya kopyalamaz. Geçici çalışma/config/cache/veritabanı izole edilir ve
temizlenir; etkin config ve ajan izinleri doğrulanır. Alt süreç dosya, araç, skill
ve MCP erişimi alamaz. Model kimlikleri gerçek CLI çıktısıdır; hesap erişim hakkı
kanıtı değildir. Codex CLI, Claude Code ve Antigravity CLI uygulanmadı.

Oluşturma; isteğini ve kapsamlı metadata/mevcut timeline'ı seçtiğin modele gönderir.
Onaylı hesap/proje hafızası ayrı bir tercihtir. Konuşma, **transkripti dahil et**
(`includeTranscript`) kutusunu açıkça seçmedikçe yerelde kalır. Seçildiğinde en fazla
**16.000 metin karakteri / 150 segment**, zaman damgaları, dil, süre, kaynak hash'i
ve `truncated` bilgisi eklenir. Medya baytları, kare veya ses gönderilmez.
Geçici CLI transkripti silinir; yerel AtrisShare teklif/çalıştırma geçmişi
kalır. Değişmez teklifler kapsam, kaynak hash'i ve temel revizyona bağlıdır;
insan ön izler, kabul/reddeder. İptal runtime'lar arasında kalıcıdır; CLI tek seferlik
çalışır, resume yoktur. [AI köprüsü](packages/ai-bridge/README.md).

Harici **MCP stdio**, resmi SDK **1.32.2** ve UI'dan üretilen ayrı, 30 dakikalık
hesap/proje/hedef/dosya yetkisi kullanır; yetki UI'dan iptal edilebilir ve runtime
yeniden başladığında geçersizleşir. UI gerçek komutu ve
`ATRIS_SHARE_MCP_ORIGIN` / `ATRIS_SHARE_MCP_GRANT` ortam yapılandırmasını verir;
masaüstü bearer'ını harici istemciye verme. Araçlar metadata/timeline/isteğe bağlı
onaylı hafıza okur, yerel transkripsiyon başlatır/durumunu okur/iptal eder, düzenleme
teklif eder, ön izleme üretir/durumunu okur ve yayın inceleme talebi oluşturur.
`transcript_read` yalnızca açık transkript izniyle listelenir/kullanılır; `offset`/`limit`
ile sayfa başına en fazla 100 segment döner ve gerçek kaynak baytlarının hash'i
doğrulanır. Başlat/durum/iptal boş segmentlerle metadata döndürür; izinsiz yetki
konuşma metni alamaz. Onay veya yayın aracı yoktur.
[MCP kurulumu](services/mcp-server/README.md).

## Platform durumu

YouTube bağlantı ve insan onaylı yayın kodu kontrollü sağlayıcı testleriyle uygulanmıştır;
canlı bağlantı/yayın kabulü Aşama 9'a ertelenmiştir. X, LinkedIn ve TikTok adaptörleri
de kontrollü sağlayıcı kapsamındadır; uygulamaya özel erişim koşulları gerektirir.
Gerçek özellikler resmi
API’ye, hesap izinlerine, uygulama incelemesine, kotalara ve erişim paketlerine
bağlıdır. YouTube video listesine erişmek kaynak videoyu indirme yetkisi veya
API’si sağlamaz. Shorts/kısa video davranışı yalnızca dosya adı veya süreye göre
varsayılmayacak, platform özelinde doğrulanacaktır. [Platform notları](docs/PLATFORMS.md).

## Yerel çalışma alanını çalıştırma

Gereksinimler: **Node.js 22 LTS** (`.nvmrc`) ve **npm 10+**.
Bu projenin klasöründe çalıştır:

```bash
npm ci
npm run check
```

`check`; tür kontrollerini, veri/API/OAuth/yayın/medya/Stüdyo/AI/MCP testlerini ve üretim
arayüz/core derlemesini çalıştırır. Sağlayıcı testleri kontrollü transport kullanır;
canlı Google'a bağlanmaz veya paylaşım yapmaz. Gerçek medya fixture'ları harici araç gerektirir.

```bash
npm run dev        # Tarayıcı geliştirmesi: http://127.0.0.1:1438
npm run tauri:dev  # Native masaüstü geliştirmesi
npm run preview    # Özellik/durum manifestosu (arayüz sunucusu değildir)
```

Native geliştirme için ayrıca Rust stable, Tauri 2 platform gereksinimleri,
Windows'ta WebView2 ve Microsoft C++ Build Tools gerekir. `npm ci`, npm komutları
ve paketleme için sabitlenen Node 22 çalışma zamanını kurar.
Node 22'nin dahili SQLite API'si upstream'de deneysel işaretlidir;
ayrıca native SQLite eklentisi derlemeye gerek yoktur.

Medya inceleme/dışa aktarma için **harici FFmpeg ve FFprobe** kullanılır.
Kurulu araçların dosya yollarını **Ayarlar → Video araçları** bölümünden kaydet;
uygulamadan tamamen çıkıp yeniden aç. Kayıtlı yollar `ATRIS_SHARE_FFMPEG` /
`ATRIS_SHARE_FFPROBE` ve `PATH` ayarından önceliklidir; boş alanlar bu yedekleri kullanır.
İkili medya aracı paketlenmez.
Dışa aktarma H.264 (`libx264`), ses için AAC, altyazı için `drawtext` gerektirir.
İçe aktarma sınırı **2 GiB**; desteklenen içerik kendi kendine yeterli MP4 ailesi
(`.mp4`/`.mov`) veya WebM'dir. `.mkv` yalnızca WebM içeriyorsa kabul edilir; genel
Matroska desteği yoktur. Oturum doğrulamalı Blob ön izleme/indirme **256 MiB** ile
sınırlıdır; oynatma WebView codec desteğine bağlıdır. FFprobe yoksa geçerli dosyalar
inceleme bilgisi olmadan saklanabilir; düzenleme süre bilgisi ve kullanılabilir araçlar gerektirir.

Yerel transkripsiyon için harici **whisper.cpp `whisper-cli`** ve uyumlu GGML model
kullanılır: `ATRIS_SHARE_WHISPER_CLI` yürütülebiliri seçer (yoksa `PATH` üzerindeki
`whisper-cli`); `ATRIS_SHARE_WHISPER_MODEL` mutlak yerel model yolu olmalıdır.
FFmpeg 16 kHz mono 16-bit PCM çıkarır; **iki saati** aşan kaynaklar reddedilir.
Dil/zaman damgaları ve işlem öncesi/sonrası kaynak hash'i doğrulanır. İlerleme,
kalıcı iptal ve lease korumalı yeniden başlatma kesintisi uygulanmıştır; başarısız/
kesilen işler açıkça yeni çalıştırma ister, otomatik tekrar veya resume yoktur.
Konuşma aracı/modeli paketlenmez veya indirilmez. [Medya motoru](packages/media-engine/README.md).

**Video editörü → Proje oluştur** ile başla. Yerel çalışma alanı seçeneği sosyal
giriş gerektirmez. Videonu içe aktar, kırp/böl, düzenlemeyi kaydet ve dışa aktar.
YouTube, X, TikTok ve LinkedIn bağlantılarının tamamı **Hesaplar** sayfasındadır.
Hesap notları için **Tüm projeler**, proje notları için ilgili projeyi seç; bu kapsamlar bilinçli
olarak ayrı tutulur. Seçim ve notlar yeniden başlatmada korunur.
Windows'ta **Hesaplar → YouTube uygulama ayarı**, Desktop OAuth istemci kimliğini ve
isteğe bağlı sırrını şifreli OS kasasına kaydeder; hemen etkinleşir ve yeniden başlatmada
korunur. Google Cloud’dan indirilen Masaüstü istemci JSON dosyasını da içe aktarabilirsin.
Google girişinden sonra bulunan kanalı seçip doğrula. Yeni bağlantıda kanal kimliği
isteğe bağlıdır; yeniden bağlantıda mevcut hedef kimliği zorunludur.
Kayıtlı değerler UI'a geri okunmaz, tarayıcı depolamasına yazılmaz. Ortam
yapılandırması yedektir. Aşama 9 kabulü için [bağlantı rehberini](docs/YOUTUBE.md) izle.
**Video editörü** menüsü doğrudan düzenleme çalışma alanını açar.

Veriler Windows'ta `%LOCALAPPDATA%\AtrisShare`, macOS'ta `~/Library/Application
Support/AtrisShare`, Linux'ta `$XDG_DATA_HOME/AtrisShare` veya
`~/.local/share/AtrisShare` altında tutulur. `ATRIS_SHARE_DATA_DIR`, **mutlak bir yol**
ile değiştirilebilir. `.env.example` referanstır; otomatik yüklenmez.
API oturum anahtarı yalnızca bellekte kalır ve her başlatmada yenilenir.

Komutlar, servis yaşam döngüsü, veri katmanı ve API için [yerel geliştirme
belgesine](docs/LOCAL-WORKSPACE.md) bak. Windows/Linux CI kontrolleri tanımlıdır;
native Windows yerelde denenmiştir. macOS/Linux masaüstü paketleri doğrulanmadı.

## Proje yapısı

```text
apps/
  preview-cli/       Özellik/durum manifestosu
  desktop/           React + Vite + Tauri uygulaması
packages/
  domain/            Veri sözleşmeleri ve runtime doğrulama şemaları
  ai-bridge/         İzole, tek seferlik OpenCode adaptörü
   connectors/        Sınır; resmi adaptörler şu an local-api içinde
  media-engine/      Yönetilen medya, proxy, aralık birleştiren çıktı ve yerel transkripsiyon
  storage/           SQLite migration/repository ve DPAPI kasa arayüzü
services/
  local-api/         Oturum doğrulamalı loopback uygulama API’si
  mcp-server/        Resmi SDK stdio araçları ve kapsamlı başlatma yetkisi
  worker/            Ayrı kuyruk/zamanlayıcı servisi için ayrılmış sınır
docs/                Herkese açık mimari, yol haritası ve platform notları
```

Masaüstü, domain, veri katmanı, yerel API, medya motoru ve preview CLI uygulanmıştır.
YouTube kimlik/yayın ve kalıcı lease kullanan Stüdyo işleri şu an yerel API içinde
çalışır; AI teklif ve transkripsiyon orkestrasyonu da yerel API'dedir. OpenCode
köprüsü, kapsamlı MCP, sosyal adaptörler ve kalıcı yerel zamanlayıcı uygulanmıştır.
Ayrı sürekli çalışan/cloud worker sunulmaz.

## Yol haritası ve katkı

Aşama 0–8 özellikleri tanımlı preview kapsamında uygulanmıştır: sınırlı editör,
AI/transkript/klip, yerel kuyruk, sosyal adaptör ve paket sağlamlaştırma hazırdır.
**Aşama 9, Aşama 0–8'in canlı sağlayıcı ve tüm özellikleri kapsayan son
uçtan uca kabul kapısıdır.** Yerel regresyon, derleme ve render/native UI kontrolleri
mühendislik kanıtı olarak sürer. Ertelenen kabul, eksik özellik anlamına gelmez.
Gizli bilgi sağlanmadı; canlı OAuth veya AI çıkarım testi yapılmadı. Yayınlama yetkisi
ancak Aşama 9 tamamlandıktan ve ayrıca açıkça istendikten sonra verilebilir; otomatik değildir.

- [Yol haritası](docs/ROADMAP.md)
- [Son kabul kontrol listesi](docs/ACCEPTANCE.md)
- [Mimari ve güven sınırları](docs/ARCHITECTURE.md)
- [Katkı rehberi](CONTRIBUTING.md)
- [Güvenlik bildirimi](SECURITY.md)
- [Değişiklik günlüğü](CHANGELOG.md)

## Atris ekosistemi

Diğer Atris uygulamalarını **[atrishub.com](https://atrishub.com)** adresinde
keşfedebilirsin. AtrisShare bağımsız bir depodur; bu yerel çalışma alanını çalıştırmak
için AtrisHub hesabı veya AtrisAgent kaynak kodu gerekmez.

## Lisans

[Apache Lisansı 2.0](LICENSE) ile lisanslanmıştır. [NOTICE](NOTICE) dosyasına bak.
Üçüncü taraf AI araçları, platform API’leri, medya varlıkları ve paketlenen runtime
bağımlılıkları kendi lisans ve koşullarına tabidir. Runtime hazırlama tam üçüncü
taraf lisans metinlerini içerir; [MCP paketleme](services/mcp-server/README.md).
Yerel doğrulamada kullanılan geçici GPL etkin FFmpeg derlemeleri dağıtım parçası
değildir; gelecekte paketlemek için derleme/codec lisansları ayrıca incelenmelidir.
