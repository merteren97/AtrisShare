<div align="center">
  <h1>AtrisShare</h1>
  <p><strong>Üret, düzenle ve paylaş — AI desteğiyle, kontrol sende.</strong></p>
  <p>
    <a href="README.md">English</a> ·
    <a href="README.tr.md"><strong>Türkçe</strong></a> ·
    <a href="https://atrishub.com">AtrisHub</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/status-Foundation%20Preview-orange" alt="Temel Ön İzleme" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache Lisansı 2.0" /></a>
  </p>
</div>

## AtrisShare nedir?

AtrisShare; **YouTube, X, TikTok ve LinkedIn** için AI destekli video üretimini
ve sosyal medya paylaşımını bir araya getirmek üzere geliştirilen, açık kaynaklı,
yerel öncelikli bir çalışma alanıdır. Hedef; manuel veya AI yardımıyla video
düzenlemek, kısa klipler çıkarmak, yazı hazırlamak, birden fazla hesabı yönetmek
ve paylaşımları tek uygulama üzerinden planlamaktır.

**Foundation Preview `0.1.0-preview.0`:** bu sürüm derlenebilir bir TypeScript
proje iskeleti, temel veri sözleşmeleri ve geliştirme belgeleri içerir.
Masaüstü uygulaması, sosyal hesap bağlantıları, video işleme, AI/MCP entegrasyonu,
bildirimler ve yayınlama **planlanmıştır; henüz uygulanmamıştır**. Bu ön izlemede
masaüstü kurulum paketi veya gerçek hesaplara paylaşım özelliği yoktur.

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

Hesaba özel hafızada marka dili, hedef kitle bağlamı, önceki düzenlemeler ve
paylaşım geçmişi tutulması planlanır. Her işlemden önce hesap bağlamı kontrol
edilir; hesap değişince diğer hesabın tercihleri veya onayları taşınmaz.

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

## Temel ön izlemeyi çalıştırma

Gereksinimler: **Node.js 22 LTS** (`.nvmrc`) ve **npm 10+**.
Bu projenin klasöründe çalıştır:

```bash
npm ci
npm run check
```

`check`, tür kontrolü ve derleme yaptıktan sonra JSON biçiminde bir ön izleme
manifestosu yazdırır. Masaüstü uygulaması başlatmaz, sağlayıcılara bağlanmaz,
paylaşım yapmaz.

```bash
npm run typecheck  # Statik veri sözleşmesi kontrolü
npm run build      # dist/ klasörüne derleme
npm run preview    # Derle ve ön izleme manifestosunu yazdır
```

`.env.example`, ileride kullanılacak yerel ayarları belgeler; mevcut CLI bu
ayarları okumaz. Bu aşamada Rust, Tauri gereksinimleri veya FFmpeg gerekmez.

## Proje yapısı

```text
apps/
  preview-cli/       Çalışan temel ön izleme manifestosu
  desktop/           Planlanan React + Tauri uygulaması
packages/
  domain/            İlk TypeScript veri sözleşmeleri
  ai-bridge/         Planlanan CLI/runtime entegrasyonu
  connectors/        Planlanan resmi sosyal medya API’leri
  media-engine/      Planlanan zaman çizelgesi ve video işleme
  storage/           Planlanan SQLite ve hesap hafızası
services/
  local-api/         Planlanan güvenilir uygulama API’si
  mcp-server/        Planlanan hesap/proje kapsamına bağlı AI araçları
  worker/            Planlanan video ve paylaşım işçileri
docs/                Herkese açık mimari, yol haritası ve platform notları
```

Şu anda yalnızca `domain` ve `preview-cli` derlenebilir/çalıştırılabilir kaynak
içerir. Diğer klasörler uygulama sınırlarını açıklayan notlardır; çalışan servis değildir.

## Yol haritası ve katkı

Sonraki hedef, yerel masaüstü temeli ve kalıcı hesap/proje verileridir. Ardından
YouTube için uçtan uca, onaylı ilk paylaşım akışı gelir. Manuel editör, AI/MCP,
otomatik klip çıkarma, zamanlayıcı ve diğer platformlar aşamalı olarak eklenir.

- [Yol haritası](docs/ROADMAP.md)
- [Mimari ve güven sınırları](docs/ARCHITECTURE.md)
- [Katkı rehberi](CONTRIBUTING.md)
- [Güvenlik bildirimi](SECURITY.md)
- [Değişiklik günlüğü](CHANGELOG.md)

## Atris ekosistemi

Diğer Atris uygulamalarını **[atrishub.com](https://atrishub.com)** adresinde
keşfedebilirsin. AtrisShare bağımsız bir depodur; bu temel ön izlemeyi çalıştırmak
için AtrisHub hesabı veya AtrisAgent kaynak kodu gerekmez.

## Lisans

[Apache Lisansı 2.0](LICENSE) ile lisanslanmıştır. [NOTICE](NOTICE) dosyasına bak.
Üçüncü taraf AI araçları, platform API’leri, medya varlıkları ve ileride
dağıtılabilecek ikili dosyalar kendi lisans ve koşullarına tabidir.
