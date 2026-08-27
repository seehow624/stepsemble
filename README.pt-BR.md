# Pi Harbor (Português do Brasil)

[English](README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · Português · [Italiano](README.it.md)

Pi Harbor é um cliente web de código aberto, pensado primeiro para celulares, para o Pi coding agent. Ele permite consultar e continuar sessões, iniciar projetos, visualizar imagens e alternar entre vários computadores Pi Harbor.

## Privacidade

O repositório contém apenas o código do aplicativo e modelos genéricos de implantação. Não contém tokens, logs de sessões, arquivos de projetos, URLs privadas, credenciais, histórico de uso de modelos, métricas de uso ou configurações de um computador específico. Guarde o token em um arquivo local com permissão `600` e use um gateway HTTPS.

## Início rápido

```bash
git clone https://github.com/seehow624/pi-harbor.git
cd pi-harbor
mkdir -p ~/.config/pi-web
openssl rand -hex 32 > ~/.config/pi-web/token
chmod 600 ~/.config/pi-web/token
PI_WEB_TOKEN_FILE="$HOME/.config/pi-web/token" node server.js
```

Execute o Pi Harbor em cada computador e entre com a URL HTTPS e o token local. Nunca coloque o token no Git, em chats, capturas de tela ou logs.

Adicione computadores em **Settings → Devices**. Os modelos launchd em `deploy/` permitem atualizações automáticas.

```bash
npm run check
npm test
```

Veja a [documentação em inglês](README.md) para mais detalhes.
