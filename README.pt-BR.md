# Stepsemble (Português do Brasil)

[English](README.md) · [Chinês simplificado](README.zh-Hans.md) · [Chinês tradicional](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · Português · [Italiano](README.it.md)

Stepsemble é um espaço de trabalho de código aberto, auto-hospedado e pensado primeiro para celulares, voltado a coding agents locais. Além das sessões nativas do Pi Agent, ele pode iniciar Claude Code, Codex CLI, Grok Build e OpenCode instalados no host.

## Privacidade

O repositório contém apenas o código do aplicativo e modelos genéricos de implantação. Não contém tokens, logs de sessões, arquivos de projetos, URLs privadas, credenciais, histórico de uso de modelos, métricas de uso ou configurações de um computador específico. Guarde o token em um arquivo local com permissão `600` e use um gateway HTTPS.

## Início rápido

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/stepsemble/master/install.sh)"
```

No computador que executa o Stepsemble, abra o Terminal e execute:

```bash
cat ~/.config/stepsemble/token
```

Cole o token na tela de login. Em outro dispositivo, obtenha-o com segurança nesse host. Se `STEPSEMBLE_TOKEN_FILE` tiver sido configurado explicitamente, leia o arquivo configurado em vez do caminho padrão. Nunca coloque o token no Git, em chats, capturas de tela ou logs.

Ao abrir o Stepsemble pela primeira vez em um navegador no próprio computador anfitrião, é oferecida uma revelação única da chave privada, no estilo de uma carteira de hardware, antes do login. Ela é exibida apenas em conexões loopback — nunca via Tailscale Serve, proxy ou outro dispositivo — e some para sempre após as duas confirmações serem salvas. Outros dispositivos sempre usam a chave registrada ou o arquivo de token.

### Tokens de acesso adicionais

Se um host for compartilhado por várias pessoas ou dispositivos, abra **Settings → Access tokens** usando o token mestre da instalação para emitir tokens com rótulo. Cada token é mostrado apenas uma vez, pode ser revogado separadamente e somente seu hash SHA-256 é salvo em `~/.config/stepsemble/tokens.json` (modo `600`). Isso não cria contas Pi nem permissões de projeto separadas.

Instale e execute o Stepsemble em cada computador e adicione um endereço Tailscale ou HTTPS em **Settings → Devices → Add device**. A entrada manual de URL continua no caminho legado com token Web compartilhado e exige o mesmo token nos dois hosts. Um código `STEPSEMBLE3` de uso único, válido por cinco minutos, cria após a revisão do candidato uma credencial de par independente e revogável; o token compartilhado não é enviado à URL candidata. Veja e revogue dispositivos autorizados nas configurações, com efeito imediato. O Stepsemble 3 aceita códigos `PIHARBOR2` / `PIHARBOR3` de hosts anteriores; clientes antigos precisam atualizar antes de usar `STEPSEMBLE3`. Não exponha a porta 3140. Em **Settings → Connection → Models & providers**, escolha um serviço do catálogo, conta/OAuth, chave API, serviço local ou provedor personalizado e selecione os modelos visíveis. Os modelos launchd em `deploy/` permitem atualizações automáticas.

```bash
npm run check
npm test
```

Veja a [documentação em inglês](README.md) para mais detalhes.
