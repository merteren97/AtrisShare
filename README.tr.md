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
tabanlı dahili kimlik kasası arayüzü hazırdır; demo hedefler sosyal token tutmaz.

Gerçek sosyal OAuth bağlantıları, video işleme, AI/MCP, bildirimler, zamanlayıcı
ve gerçek paylaşım **henüz uygulanmamıştır**. İmzalı kurulum paketi yayınlanmadı.

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

Hesap/proje kapsamlı notlarla marka dili, hedef kitle ve kararlar şimdiden tutulabilir.
Otomatik düzenleme/paylaşım geçmişi ve AI bağlam getirme sonraki aşamalarda gelir.
Her hafıza işleminde açık kapsam kontrol edilir; ileride paylaşım onayları da
oluşturuldukları hesap ve hedefe bağlı kalacaktır.

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

Dört platformun bağlayıcısı da planlama aşamasındadır. Gerçek özellikler resmi
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

`check`; tür kontrollerini, API/veri testlerini ve üretim arayüz/core derlemesini
çalıştırır. Sosyal sağlayıcılara bağlanmaz veya paylaşım yapmaz.

```bash
npm run dev        # Tarayıcı geliştirmesi: http://127.0.0.1:1438
npm run tauri:dev  # Native masaüstü geliştirmesi
npm run preview    # Özellik/durum manifestosu (arayüz sunucusu değildir)
```

Native geliştirme için ayrıca Rust stable, Tauri 2 platform gereksinimleri,
Windows'ta WebView2 ve Microsoft C++ Build Tools gerekir. `npm ci`, npm komutları
ve paketleme için sabitlenen Node 22 çalışma zamanını kurar. Bu aşamada FFmpeg
gerekmez. Node 22'nin dahili SQLite API'si upstream'de deneysel işaretlidir;
ayrıca native SQLite eklentisi derlemeye gerek yoktur.

Önce **demo hesap** ekle, bir proje oluştur ve **Hafıza** bölümünü aç. Hesap notları
için **Hesap geneli**, proje notları için ilgili projeyi seç; bu kapsamlar bilinçli
olarak ayrı tutulur. Seçim ve notlar yeniden başlatmada korunur.

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
  media-engine/      Planlanan zaman çizelgesi ve video işleme
  storage/           SQLite migration/repository ve DPAPI kasa arayüzü
services/
  local-api/         Oturum doğrulamalı loopback uygulama API’si
  mcp-server/        Planlanan hesap/proje kapsamına bağlı AI araçları
  worker/            Planlanan video ve paylaşım işçileri
docs/                Herkese açık mimari, yol haritası ve platform notları
```

Masaüstü, domain, veri katmanı, yerel API ve preview CLI uygulanmıştır. AI köprüsü,
sosyal bağlayıcılar, medya motoru, MCP ve kalıcı işçiler planlama aşamasındadır.

## Yol haritası ve katkı

Sonraki hedef, gerçek OAuth/kanal doğrulamasıyla YouTube için uçtan uca, onaylı
ilk paylaşım akışıdır. Manuel editör, AI/MCP, otomatik klip çıkarma, zamanlayıcı
ve diğer platformlar aşamalı olarak eklenir.

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
