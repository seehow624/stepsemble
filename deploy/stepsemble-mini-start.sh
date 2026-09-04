#!/bin/zsh
# Stepsemble launcher for a macOS host where launchd must start the server through
# an SSH child process. Copy this file to ~/.local/share/stepsemble-bin/start.sh
# after replacing the __NODE__, optional __PIBIN__, and __TOKEN_FILE__ placeholders.
set -eu

STEPSEMBLE_HOME="${STEPSEMBLE_HOME:-$HOME/.local/share/stepsemble}"
STEPSEMBLE_TOKEN_FILE_DEFAULT="__TOKEN_FILE__"
if [[ "$STEPSEMBLE_TOKEN_FILE_DEFAULT" == "__TOKEN_"FILE__ ]]; then STEPSEMBLE_TOKEN_FILE_DEFAULT="$HOME/.config/stepsemble/token"; fi
STEPSEMBLE_TOKEN_FILE="${STEPSEMBLE_TOKEN_FILE:-$STEPSEMBLE_TOKEN_FILE_DEFAULT}"
device_config="${STEPSEMBLE_DEVICE_CONFIG:-$HOME/.pi/agent/device.json}"
configured_port=""
if [[ -f "$device_config" ]]; then
  configured_port=$(/usr/bin/jq -r '.port // empty' "$device_config" 2>/dev/null || true)
fi
if [[ "$configured_port" != <-> ]] || (( configured_port < 1024 || configured_port > 65535 )); then
  configured_port="3140"
fi
export STEPSEMBLE_PORT="$configured_port"
export STEPSEMBLE_HOST="127.0.0.1"
export STEPSEMBLE_SECURE_COOKIE="1"
export STEPSEMBLE_TOKEN_FILE
export STEPSEMBLE_BROWSE_ROOTS="${STEPSEMBLE_BROWSE_ROOTS:-$HOME,/Volumes}"
PI_BIN="${PI_BIN:-__PIBIN__}"
NODE_BIN="${NODE_BIN:-__NODE__}"
[[ -x "$PI_BIN" ]] || PI_BIN="$(command -v pi || true)"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
export PI_BIN

if [[ -z "$NODE_BIN" ]]; then
  print -u2 "Stepsemble needs node on PATH, or set NODE_BIN."
  exit 1
fi

# Do not pkill an existing server here. launchd/ssh can briefly start a new
# launcher while the previous process is draining. Only stop an old server
# after confirming that it has no active RPC run; connected idle browsers can
# reconnect safely and must not block an update forever.
if /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:${STEPSEMBLE_PORT}/api/health" >/dev/null 2>&1; then
  cookie_file=$(/usr/bin/mktemp /tmp/stepsemble-start.XXXXXX)
  rpcs_file=$(/usr/bin/mktemp /tmp/stepsemble-start-rpcs.XXXXXX)
  tasks_file=$(/usr/bin/mktemp /tmp/stepsemble-start-tasks.XXXXXX)
  trap '/bin/rm -f "$cookie_file" "$rpcs_file" "$tasks_file"' EXIT
  token=$(/usr/bin/tr -d '\n' < "$STEPSEMBLE_TOKEN_FILE")
  if /usr/bin/jq -nc --arg token "$token" '{token:$token}' | /usr/bin/curl -fsS --max-time 3 -c "$cookie_file" \
    -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:${STEPSEMBLE_PORT}/api/login" >/dev/null 2>&1; then
    rpcs_status=$(/usr/bin/curl -sS --max-time 3 -b "$cookie_file" -o "$rpcs_file" -w '%{http_code}' \
      "http://127.0.0.1:${STEPSEMBLE_PORT}/api/rpcs" 2>/dev/null || true)
    tasks_status=$(/usr/bin/curl -sS --max-time 3 -b "$cookie_file" -o "$tasks_file" -w '%{http_code}' \
      "http://127.0.0.1:${STEPSEMBLE_PORT}/api/agent-tasks" 2>/dev/null || true)
    inspection_ok=0
    agent_active=0
    if [[ "$rpcs_status" == "200" && ( "$tasks_status" == "200" || "$tasks_status" == "404" ) ]]; then
      inspection_ok=1
      if /usr/bin/jq -e 'any(.rpcs[]?; .isStreaming == true)' "$rpcs_file" >/dev/null 2>&1; then
        agent_active=1
      elif [[ "$tasks_status" == "200" ]] && /usr/bin/jq -e \
        'any(.tasks[]?; .status == "starting" or .status == "running" or .status == "waiting" or .status == "reconnecting")' \
        "$tasks_file" >/dev/null 2>&1; then
        agent_active=1
      fi
    fi
    if (( ! inspection_ok || agent_active )); then
      while /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${STEPSEMBLE_PORT}/api/health" >/dev/null 2>&1; do
        /bin/sleep 2
      done
    else
      old_pid=$(/usr/sbin/lsof -nP -iTCP:"${STEPSEMBLE_PORT}" -sTCP:LISTEN -t 2>/dev/null | /usr/bin/head -n 1 || true)
      old_cmd=$([ -n "$old_pid" ] && /bin/ps -p "$old_pid" -o command= || true)
      case "$old_cmd" in
        *"$STEPSEMBLE_HOME/server.js"*|*"$HOME/.local/share/pi-harbor/server.js"*|*"$HOME/.local/share/pi-web/server.js"*) /bin/kill -TERM "$old_pid" 2>/dev/null || true ;;
      esac
      while /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${STEPSEMBLE_PORT}/api/health" >/dev/null 2>&1; do
        /bin/sleep 1
      done
    fi
  else
    while /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${STEPSEMBLE_PORT}/api/health" >/dev/null 2>&1; do
      /bin/sleep 2
    done
  fi
fi
exec "$NODE_BIN" "$STEPSEMBLE_HOME/server.js"
