# Pi Harbor (Português do Brasil)

[English](README.md) · [Chinês simplificado](README.zh-Hans.md) · [Chinês tradicional](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · Português · [Italiano](README.it.md)

Pi Harbor é um cliente web de código aberto, pensado primeiro para celulares, para o Pi coding agent. Ele permite consultar e continuar sessões, iniciar projetos, visualizar imagens e alternar entre vários computadores Pi Harbor.

## Privacidade

O repositório contém apenas o código do aplicativo e modelos genéricos de implantação. Não contém tokens, logs de sessões, arquivos de projetos, URLs privadas, credenciais, histórico de uso de modelos, métricas de uso ou configurações de um computador específico. Guarde o token em um arquivo local com permissão `600` e use um gateway HTTPS.

## Início rápido

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

No computador que executa o Pi Harbor, abra o Terminal e execute:

```bash
cat ~/.config/pi-harbor/token
```

Cole o token na tela de login. Em outro dispositivo, obtenha-o com segurança nesse host. Se `PI_HARBOR_TOKEN_FILE` tiver sido configurado explicitamente, leia o arquivo configurado em vez do caminho padrão. Nunca coloque o token no Git, em chats, capturas de tela ou logs.

Ao abrir o Pi Harbor pela primeira vez em um navegador no próprio computador anfitrião, é oferecida uma revelação única da chave privada, no estilo de uma carteira de hardware, antes do login. Ela é exibida apenas em conexões loopback — nunca via Tailscale Serve, proxy ou outro dispositivo — e some para sempre após as duas confirmações serem salvas. Outros dispositivos sempre usam a chave registrada ou o arquivo de token.

Instale e execute o Pi Harbor em cada computador e adicione um endereço Tailscale ou HTTPS em **Settings → Devices → Add device**. Você também pode usar um código de pareamento válido por cinco minutos. Use o mesmo token Web e não exponha a porta 3140. Em **Settings → Connection → Models & providers**, escolha um serviço do catálogo, conta/OAuth, chave de API, serviço local ou provedor personalizado e selecione os modelos visíveis. Os modelos launchd em `deploy/` permitem atualizações automáticas.

```bash
npm run check
npm test
```

Veja a [documentação em inglês](README.md) para mais detalhes.
