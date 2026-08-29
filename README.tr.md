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

Her bilgisayara Pi Harbor'ı kurup çalıştırın ve **Settings → Devices → Add device** bölümünden Tailscale veya HTTPS adresi ekleyin. Beş dakika geçerli bir eşleştirme kodu da kullanılabilir. Aynı Web token'ını kullanın ve 3140 numaralı bağlantı noktasını açmayın. **Settings → Connection → Models & providers** bölümünde katalog hizmeti, hesap/OAuth, API anahtarı, yerel hizmet veya özel sağlayıcı seçip görünür modelleri belirleyin. `deploy/` içindeki launchd şablonları otomatik güncellemeyi destekler.

```bash
npm run check
npm test
```

Ayrıntılar için [İngilizce belgelere](README.md) bakın.
