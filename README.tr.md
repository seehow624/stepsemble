# Pi Harbor (Türkçe)

[English](README.md) · [Basitleştirilmiş Çince](README.zh-Hans.md) · [Geleneksel Çince](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · Türkçe · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor, Pi coding agent için açık kaynaklı ve mobil öncelikli bir web istemcisidir. Oturumları görüntüleme ve sürdürme, proje başlatma, görsel önizleme ve birden fazla Pi Harbor bilgisayarı arasında geçiş sağlar.

## Gizlilik

Depo yalnızca uygulama kodu ve genel dağıtım şablonları içerir. Token, oturum günlüğü, proje dosyası, özel URL, hesap bilgisi, model kullanım geçmişi, kullanım miktarı veya bilgisayara özel yapılandırma içermez. Token'ı izinleri `600` olan yerel dosyada saklayın ve HTTPS ağ geçidi kullanın.

## Hızlı başlangıç

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

Pi Harbor'ı çalıştıran bilgisayarda Terminal'i açın ve token'ı görmek için şunu çalıştırın:

```bash
cat ~/.config/pi-harbor/token
```

Token'ı giriş ekranına yapıştırın. Başka bir cihazdan kullanırken token'ı bu ana bilgisayardan güvenli şekilde alın. `PI_HARBOR_TOKEN_FILE` açıkça yapılandırıldıysa varsayılan yol yerine yapılandırılan dosyayı okuyun. Token'ı Git'e, sohbete, ekran görüntüsüne veya günlüğe asla koymayın.

Ana bilgisayardaki bir tarayıcıyla Pi Harbor ilk kez açıldığında, oturum açmadan önce donanım cüzdanı tarzında tek seferlik bir anahtar gösterimi sunulur. Anahtar yalnızca loopback bağlantılarında gösterilir — asla Tailscale Serve, proxy veya uzak bir cihaz üzerinden değil — ve her iki onay kaydedildikten sonra bir daha görünmez. Diğer cihazlar her zaman kaydedilen anahtarı veya token dosyasını kullanır.

### Ek erişim belirteçleri

Bir ana bilgisayar birden fazla kişi veya cihaz tarafından kullanılıyorsa, kurulum/ana belirteçle **Settings → Access tokens** bölümünü açıp etiketli belirteçler oluşturun. Her belirteç yalnızca bir kez gösterilir, ayrı ayrı iptal edilebilir ve sunucuda yalnızca SHA-256 özeti `~/.config/pi-harbor/tokens.json` (izin `600`) içinde saklanır. Ayrı Pi hesapları veya proje izinleri oluşturmaz.

Her bilgisayara Pi Harbor'ı kurup çalıştırın ve **Settings → Devices → Add device** bölümünden Tailscale veya HTTPS adresi ekleyin. URL'yi elle girmek eski paylaşılan Web token yoludur ve iki ana bilgisayarda aynı token'ı gerektirir. Beş dakika geçerli ve tek kullanımlık `PIHARBOR3` eşleştirme kodu, aday bilgilerini onayladıktan sonra bağımsız ve iptal edilebilir bir eş kimlik bilgisi oluşturur; paylaşılan token aday URL'ye gönderilmez. Yetkili cihazları cihaz ayarlarında görebilir ve hemen iptal edebilirsiniz. Pi Harbor 2.2, 2.1.2 ana bilgisayarlarından gelen `PIHARBOR2` kodlarını kabul eder; eski istemciler `PIHARBOR3` kullanmadan önce güncellenmelidir. 3140 numaralı bağlantı noktasını açmayın. **Settings → Connection → Models & providers** bölümünde katalog hizmeti, hesap/OAuth, API anahtarı, yerel hizmet veya özel sağlayıcı seçip görünür modelleri belirleyin. `deploy/` içindeki launchd şablonları otomatik güncellemeyi destekler.

```bash
npm run check
npm test
```

Ayrıntılar için [İngilizce belgelere](README.md) bakın.
