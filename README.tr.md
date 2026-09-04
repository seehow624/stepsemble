# Stepsemble (Türkçe)

[English](README.md) · [Basitleştirilmiş Çince](README.zh-Hans.md) · [Geleneksel Çince](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · Türkçe · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Stepsemble, yerel coding agent'lar için açık kaynaklı, kendi sunucunuzda çalışan ve mobil öncelikli bir çalışma alanıdır. Pi Agent'ın yerel oturumlarının yanında, ana bilgisayarda kurulu Claude Code, Codex CLI, Grok Build ve OpenCode'u aynı arayüzden çalıştırabilir.

## Gizlilik

Depo yalnızca uygulama kodu ve genel dağıtım şablonları içerir. Token, oturum günlüğü, proje dosyası, özel URL, hesap bilgisi, model kullanım geçmişi, kullanım miktarı veya bilgisayara özel yapılandırma içermez. Token'ı izinleri `600` olan yerel dosyada saklayın ve HTTPS ağ geçidi kullanın.

## Hızlı başlangıç

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/stepsemble/master/install.sh)"
```

Stepsemble'ı çalıştıran bilgisayarda Terminal'i açın ve token'ı görmek için şunu çalıştırın:

```bash
cat ~/.config/stepsemble/token
```

Token'ı giriş ekranına yapıştırın. Başka bir cihazdan kullanırken token'ı bu ana bilgisayardan güvenli şekilde alın. `STEPSEMBLE_TOKEN_FILE` açıkça yapılandırıldıysa varsayılan yol yerine yapılandırılan dosyayı okuyun. Token'ı Git'e, sohbete, ekran görüntüsüne veya günlüğe asla koymayın.

Ana bilgisayardaki bir tarayıcıyla Stepsemble ilk kez açıldığında, oturum açmadan önce donanım cüzdanı tarzında tek seferlik bir anahtar gösterimi sunulur. Anahtar yalnızca loopback bağlantılarında gösterilir — asla Tailscale Serve, proxy veya uzak bir cihaz üzerinden değil — ve her iki onay kaydedildikten sonra bir daha görünmez. Diğer cihazlar her zaman kaydedilen anahtarı veya token dosyasını kullanır.

### Ek erişim belirteçleri

Bir ana bilgisayar birden fazla kişi veya cihaz tarafından kullanılıyorsa, kurulum/ana belirteçle **Settings → Access tokens** bölümünü açıp etiketli belirteçler oluşturun. Her belirteç yalnızca bir kez gösterilir, ayrı ayrı iptal edilebilir ve sunucuda yalnızca SHA-256 özeti `~/.config/stepsemble/tokens.json` (izin `600`) içinde saklanır. Ayrı Pi hesapları veya proje izinleri oluşturmaz.

Her bilgisayara Stepsemble'ı kurup çalıştırın ve **Settings → Devices → Add device** bölümünden Tailscale veya HTTPS adresi ekleyin. URL'yi elle girmek eski paylaşılan Web token yoludur ve iki ana bilgisayarda aynı token'ı gerektirir. Beş dakika geçerli ve tek kullanımlık `STEPSEMBLE3` eşleştirme kodu, aday bilgilerini onayladıktan sonra bağımsız ve iptal edilebilir bir eş kimlik bilgisi oluşturur; paylaşılan token aday URL'ye gönderilmez. Yetkili cihazları cihaz ayarlarında görebilir ve hemen iptal edebilirsiniz. Stepsemble 3, eski ana bilgisayarlardan gelen `PIHARBOR2` / `PIHARBOR3` kodlarını kabul eder; eski istemciler `STEPSEMBLE3` kullanmadan önce güncellenmelidir. 3140 numaralı bağlantı noktasını açmayın. **Settings → Connection → Models & providers** bölümünde katalog hizmeti, hesap/OAuth, API anahtarı, yerel hizmet veya özel sağlayıcı seçip görünür modelleri belirleyin. `deploy/` içindeki launchd şablonları otomatik güncellemeyi destekler.

```bash
npm run check
npm test
```

Ayrıntılar için [İngilizce belgelere](README.md) bakın.
