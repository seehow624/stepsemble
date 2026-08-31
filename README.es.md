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

Cuando se abre Pi Harbor por primera vez en un navegador del propio ordenador anfitrión, se ofrece una revelación única de la clave privada al estilo de una cartera hardware antes de iniciar sesión. Solo se muestra en conexiones loopback — nunca a través de Tailscale Serve, un proxy ni otro dispositivo — y desaparece para siempre tras guardar ambas confirmaciones. Los demás dispositivos usan siempre la clave guardada o el archivo de token.

### Tokens de acceso adicionales

Si varias personas o dispositivos comparten un equipo, abre **Settings → Access tokens** con el token de instalación/maestro para emitir tokens con etiqueta. Cada token se muestra una sola vez, puede revocarse por separado y el servidor solo guarda su hash SHA-256 en `~/.config/pi-harbor/tokens.json` (permisos `600`). No crea cuentas de Pi ni permisos de proyecto independientes.

Instala y ejecuta Pi Harbor en cada ordenador y añade una dirección de Tailscale o HTTPS desde **Settings → Devices → Add device**. La entrada manual de URL mantiene el antiguo recorrido con token web compartido y exige el mismo token en ambos hosts. Un código `PIHARBOR3` de un solo uso, válido durante cinco minutos, crea tras revisar el candidato una credencial de par independiente y revocable; el token compartido no se envía a la URL candidata. Puedes ver y revocar los dispositivos autorizados desde Ajustes, con efecto inmediato. Pi Harbor 2.2 acepta códigos `PIHARBOR2` de hosts 2.1.2; los clientes antiguos deben actualizarse antes de usar `PIHARBOR3`. No expongas el puerto 3140. En **Settings → Connection → Models & providers**, elige un servicio del catálogo, cuenta/OAuth, clave API, servicio local o proveedor personalizado y selecciona los modelos visibles. Las plantillas launchd de `deploy/` permiten actualizaciones automáticas.

```bash
npm run check
npm test
```

Consulta la [documentación en inglés](README.md) para más detalles.
