# Pi Harbor (Türkçe)

[English](README.md) · [Basitleştirilmiş Çince](README.zh-Hans.md) · [Geleneksel Çince](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · Türkçe · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor, Pi coding agent için açık kaynaklı ve mobil öncelikli bir web istemcisidir. Oturumları görüntüleme ve sürdürme, proje başlatma, görsel önizleme ve birden fazla Pi Harbor bilgisayarı arasında geçiş sağlar.

## Gizlilik

Depo yalnızca uygulama kodu ve genel dağıtım şablonları içerir. Token, oturum günlüğü, proje dosyası, özel URL, hesap bilgisi, model kullanım geçmişi, kullanım miktarı veya bilgisayara özel yapılandırma içermez. Token'ı izinleri `600` olan yerel dosyada saklayın ve HTTPS ağ geçidi kullanın.

## Hızlı başlangıç

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

Her bilgisayarda Pi Harbor'i çalıştırın ve HTTPS adresi ile yerel token'ı kullanarak giriş yapın. Token'ı Git'e, sohbete, ekran görüntüsüne veya günlüğe koymayın.

**Settings → Devices** bölümünden görünen ad ve HTTPS URL ekleyebilirsiniz. `deploy/` içindeki launchd şablonları otomatik güncellemeyi destekler.

```bash
npm run check
npm test
```

Ayrıntılar için [İngilizce belgelere](README.md) bakın.
