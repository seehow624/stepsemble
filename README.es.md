# Pi Harbor (Español)

[English](README.md) · [Chino simplificado](README.zh-Hans.md) · [Chino tradicional](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · Español · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor es un cliente web de código abierto y orientado a móviles para Pi coding agent. Permite consultar y continuar sesiones, iniciar proyectos, previsualizar imágenes y cambiar entre varios ordenadores Pi Harbor.

## Privacidad

El repositorio solo contiene código de la aplicación y plantillas de despliegue genéricas. No contiene tokens, registros de sesiones, archivos de proyectos, URL privadas, credenciales, historial de uso de modelos, estadísticas de uso ni configuración de un ordenador concreto. Guarda el token en un archivo local con permisos `600` y usa una puerta de enlace HTTPS.

## Inicio rápido

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

En el ordenador que ejecuta Pi Harbor, abre Terminal y ejecuta:

```bash
cat ~/.config/pi-harbor/token
```

Pega el token en la pantalla de inicio de sesión. Desde otro dispositivo, recupéralo de forma segura en ese equipo anfitrión. Si se ha configurado explícitamente `PI_HARBOR_TOKEN_FILE`, lee el archivo configurado en lugar de la ruta predeterminada. Nunca pongas el token en Git, chats, capturas ni registros.

Instala y ejecuta Pi Harbor en cada ordenador y añade una dirección de Tailscale o HTTPS desde **Settings → Devices → Add device**. También puedes usar un código de emparejamiento válido durante cinco minutos. Usa el mismo token web y no expongas el puerto 3140. En **Settings → Connection → Models & providers**, elige un servicio del catálogo, cuenta/OAuth, clave API, servicio local o proveedor personalizado y selecciona los modelos visibles. Las plantillas launchd de `deploy/` permiten actualizaciones automáticas.

```bash
npm run check
npm test
```

Consulta la [documentación en inglés](README.md) para más detalles.
