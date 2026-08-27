# Pi Harbor (Español)

[English](README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · Español · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor es un cliente web de código abierto y orientado a móviles para Pi coding agent. Permite consultar y continuar sesiones, iniciar proyectos, previsualizar imágenes y cambiar entre varios ordenadores Pi Harbor.

## Privacidad

El repositorio solo contiene código de la aplicación y plantillas de despliegue genéricas. No contiene tokens, registros de sesiones, archivos de proyectos, URL privadas, credenciales, historial de uso de modelos, estadísticas de uso ni configuración de un ordenador concreto. Guarda el token en un archivo local con permisos `600` y usa una puerta de enlace HTTPS.

## Inicio rápido

```bash
git clone https://github.com/seehow624/pi-harbor.git
cd pi-harbor
mkdir -p ~/.config/pi-web
openssl rand -hex 32 > ~/.config/pi-web/token
chmod 600 ~/.config/pi-web/token
PI_WEB_TOKEN_FILE="$HOME/.config/pi-web/token" node server.js
```

Ejecuta Pi Harbor en cada ordenador e inicia sesión con su URL HTTPS y token local. No pongas el token en Git, chats, capturas ni registros.

Añade ordenadores desde **Settings → Devices**. Las plantillas launchd de `deploy/` permiten actualizaciones automáticas.

```bash
npm run check
npm test
```

Consulta la [documentación en inglés](README.md) para más detalles.
