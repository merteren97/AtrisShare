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
hafıza yönetimi uygulanmıştır. Açıkça demo etiketli hedefler ve projeler oluşturabilir,
kaynak bilgisi ile öneri/onaylı durumları tutulan notlar ekleyebilir, düzenleyebilir
ve silebilirsin. Koyu/açık tema ve Türkçe/İngilizce arayüz vardır. Windows DPAPI
tabanlı dahili kimlik kasası hazırdır; demo hedefler sosyal token tutmaz.

**Aşama 2 kodu uygulandı; canlı kabul bekliyor:** YouTube Desktop OAuth/PKCE,
kimlik/kanal doğrulaması, kasa, yenileme/bağlantı iptali, sahip olunan videoların
sayfalı kataloğu ve yerel dosya eşleme, değişmez yayın incelemesi, sürdürülebilir
yükleme, işleme kontrolü ve sonuç/uzlaştırma akışları vardır. Testler gerçek servisleri
kontrollü sağlayıcılarla çalıştırır; **canlı Google testi değildir**. Canlı bağlantı
veya yayın için sana ait OAuth uygulaması, yetkili kanal ve açık insan onayı gerekir;
canlı Google kabulü yapıldığı iddia edilmez. [YouTube rehberi](docs/YOUTUBE.md).

**Aşama 3 kısmi:** Stüdyo, değişmez yönetilen medya ve manuel tek klip editörü sunar:
kırpma, özgün/dikey/kare kadraj, altyazı, ses kazancı, revizyonlu kaydetme,
geri al/yinele, yeniden açma ve ilerleme/iptal destekli dışa aktarma. Tekrar denemek
yeni bir dışa aktarma başlatır. Çok kanallı kurgu, bölme ve proxy uygulanmadı.
Windows'ta özel başlık çubuğu ve kapanışta runtime/medya süreç ağacını sonlandırma
vardır. AI/MCP, bildirimler, zamanlayıcı ve diğer sosyal bağlantılar planlanır.
İmzalı kurulum paketi yayınlanmadı.

## Planlanan kullanım akışı

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
başarılı dışa aktarma/yayın işlemleri kapsamlı geçmiş notları ekler. AI bağlam getirme planlanır.
Her hafıza işleminde açık kapsam kontrol edilir; mevcut YouTube onayları hesap,
proje, hedef, metadata ve dosya SHA-256 değerine bağlıdır. Açık onay tek kullanımlıktır
ve gönderim için 10 dakika geçerlidir. İptal, gönderim yetkisinin geri alınmasını
kalıcı tutar; uzakta gerçekleşmiş etkileri geri alma garantisi vermez.

## AI seçimi ve video araçları

AI köprüsünde AtrisAgent’ın CLI/runtime yaklaşımının uyarlanması planlanır.
Tek bir AI sağlayıcısına bağlı kalmak yerine, kullanılabilir modeller ve
yetenekler keşfedilir. İlk adaylar Codex CLI, Claude Code, OpenCode ve
Antigravity CLI’dır. Henüz entegre değildirler; resmi kurulumları ve oturum açma
işlemleri ilgili araçların kendi akışlarıyla yapılacaktır.

Uyumlu harici AI istemcileri için yerel bir **MCP** arayüzü planlanır. Bu arayüz
sınırlı video inceleme, klip önerisi, düzenleme teklifi ve ön izleme render
araçlarını sunar. Videoyu fiilen FFmpeg tabanlı işçiler işler. AI paylaşım onayı
isteyebilir; insan kararını kabul edip yayınlama yapabilen taraf güvenilir uygulamadır.

## Platform durumu

YouTube bağlantı ve insan onaylı yayın kodu kontrollü sağlayıcı testleriyle uygulanmıştır;
canlı bağlantı/yayın kabulü bekler. Diğer bağlayıcılar planlanır.
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

`check`; tür kontrollerini, veri/API/OAuth/yayın/medya/Stüdyo testlerini ve üretim
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

Medya inceleme/dışa aktarma için **harici FFmpeg ve FFprobe** kullanılır:
`ATRIS_SHARE_FFMPEG` / `ATRIS_SHARE_FFPROBE` veya `PATH`. İkili medya aracı paketlenmez.
Dışa aktarma H.264 (`libx264`), ses için AAC, altyazı için `drawtext` gerektirir.
İçe aktarma sınırı **2 GiB**; desteklenen içerik kendi kendine yeterli MP4 ailesi
(`.mp4`/`.mov`) veya WebM'dir. `.mkv` yalnızca WebM içeriyorsa kabul edilir; genel
Matroska desteği yoktur. Oturum doğrulamalı Blob ön izleme/indirme **256 MiB** ile
sınırlıdır; oynatma WebView codec desteğine bağlıdır. FFprobe yoksa geçerli dosyalar
inceleme bilgisi olmadan saklanabilir; düzenleme süre bilgisi ve kullanılabilir araçlar gerektirir.

Önce **demo hesap** ekle, bir proje oluştur ve **Hafıza** bölümünü aç. Hesap notları
için **Hesap geneli**, proje notları için ilgili projeyi seç; bu kapsamlar bilinçli
olarak ayrı tutulur. Seçim ve notlar yeniden başlatmada korunur.
Windows'ta gerçek YouTube kanalı bağlamak için Desktop OAuth istemcini yapılandır
ve **Hesaplar** bölümünü kullan; [bağlantı rehberini](docs/YOUTUBE.md) izle.
Medya içe aktarmak, düzenlemeleri kaydetmek ve dışa aktarmak için proje seçip **Stüdyo**'yu aç.

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
  ai-bridge/         Planlanan CLI/runtime entegrasyonu
  connectors/        Planlanan resmi sosyal medya API’leri
  media-engine/      Yönetilen medya, FFprobe incelemesi ve tek klip FFmpeg çıktısı
  storage/           SQLite migration/repository ve DPAPI kasa arayüzü
services/
  local-api/         Oturum doğrulamalı loopback uygulama API’si
  mcp-server/        Planlanan hesap/proje kapsamına bağlı AI araçları
  worker/            Ayrı kuyruk/zamanlayıcı servisi için ayrılmış sınır
docs/                Herkese açık mimari, yol haritası ve platform notları
```

Masaüstü, domain, veri katmanı, yerel API, medya motoru ve preview CLI uygulanmıştır.
YouTube kimlik/yayın ve kalıcı lease kullanan Stüdyo işleri şu an yerel API içinde
çalışır. AI köprüsü, diğer bağlayıcılar, MCP ve ayrı işçi kuyruğu planlanır.

## Yol haritası ve katkı

Sonraki kabul hedefi, uygulanmış insan onaylı YouTube akışının kullanıcıya ait OAuth
uygulaması ve yetkili canlı kanalla doğrulanmasıdır. Tek klip editörü ilk dilimdir;
daha kapsamlı kurgu, AI/MCP, otomatik klip çıkarma, zamanlayıcı ve diğer platformlar
aşamalı olarak eklenir.

- [Yol haritası](docs/ROADMAP.md)
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
Üçüncü taraf AI araçları, platform API’leri, medya varlıkları ve ileride
dağıtılabilecek ikili dosyalar kendi lisans ve koşullarına tabidir.
Yerel doğrulamada kullanılan geçici GPL etkin FFmpeg derlemeleri dağıtım parçası
değildir; gelecekte paketlemek için derleme/codec lisansları ayrıca incelenmelidir.
