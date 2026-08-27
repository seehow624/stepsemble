#!/bin/zsh
# Pi Harbor launcher for a macOS host where launchd must start the server through
# an SSH child process. Copy this file to ~/.local/share/pi-harbor-bin/start.sh.
set -eu

PI_HARBOR_HOME="${PI_HARBOR_HOME:-$HOME/.local/share/pi-harbor}"
PI_HARBOR_TOKEN_FILE="${PI_HARBOR_TOKEN_FILE:-$HOME/.config/pi-harbor/token}"
device_config="${PI_HARBOR_DEVICE_CONFIG:-$HOME/.pi/agent/device.json}"
configured_port=""
if [[ -f "$device_config" ]]; then
  configured_port=$(/usr/bin/jq -r '.port // empty' "$device_config" 2>/dev/null || true)
fi
if [[ "$configured_port" != <-> ]] || (( configured_port < 1024 || configured_port > 65535 )); then
  configured_port="3140"
fi
export PI_HARBOR_PORT="$configured_port"
export PI_HARBOR_HOST="127.0.0.1"
export PI_HARBOR_SECURE_COOKIE="1"
export PI_HARBOR_TOKEN_FILE
export PI_HARBOR_BROWSE_ROOTS="${PI_HARBOR_BROWSE_ROOTS:-$HOME,/Volumes}"
PI_BIN="${PI_BIN:-__PIBIN__}"
NODE_BIN="${NODE_BIN:-__NODE__}"
[[ -x "$PI_BIN" ]] || PI_BIN="$(command -v pi || true)"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
export PI_BIN

if [[ -z "$NODE_BIN" || -z "$PI_BIN" ]]; then
  print -u2 "Pi Harbor needs both node and pi on PATH, or set NODE_BIN and PI_BIN."
  exit 1
fi

# Do not pkill an existing server here. launchd/ssh can briefly start a new
# launcher while the previous process is draining. Only stop an old server
# after confirming that it has no active RPC run; connected idle browsers can
# reconnect safely and must not block an update forever.
if /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:${PI_HARBOR_PORT}/api/health" >/dev/null 2>&1; then
  cookie_file=$(/usr/bin/mktemp /tmp/pi-harbor-start.XXXXXX)
  trap '/bin/rm -f "$cookie_file"' EXIT
  token=$(/usr/bin/tr -d '\n' < "$PI_HARBOR_TOKEN_FILE")
  if /usr/bin/printf '%s' '{"token":"'"$token"'"}' | /usr/bin/curl -fsS --max-time 3 -c "$cookie_file" \
    -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:${PI_HARBOR_PORT}/api/login" >/dev/null 2>&1; then
    rpcs=$(/usr/bin/curl -fsS --max-time 3 -b "$cookie_file" "http://127.0.0.1:${PI_HARBOR_PORT}/api/rpcs" || true)
    if printf '%s' "$rpcs" | /usr/bin/jq -e 'any(.rpcs[]?; .isStreaming == true)' >/dev/null 2>&1; then
      while /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${PI_HARBOR_PORT}/api/health" >/dev/null 2>&1; do
        /bin/sleep 2
      done
    else
      old_pid=$(/usr/sbin/lsof -nP -iTCP:"${PI_HARBOR_PORT}" -sTCP:LISTEN -t 2>/dev/null | /usr/bin/head -n 1 || true)
      old_cmd=$([ -n "$old_pid" ] && /bin/ps -p "$old_pid" -o command= || true)
      case "$old_cmd" in
        *"$PI_HARBOR_HOME/server.js"*|*"$HOME/.local/share/pi-web/server.js"*) /bin/kill -TERM "$old_pid" 2>/dev/null || true ;;
      esac
      while /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${PI_HARBOR_PORT}/api/health" >/dev/null 2>&1; do
        /bin/sleep 1
      done
    fi
  else
    while /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${PI_HARBOR_PORT}/api/health" >/dev/null 2>&1; do
      /bin/sleep 2
    done
  fi
fi
exec "$NODE_BIN" "$PI_HARBOR_HOME/server.js"
