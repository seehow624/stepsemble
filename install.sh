#!/bin/zsh
# Pi Harbor one-click installer for macOS.
#
# Stable installs come from a GitHub Release asset and are verified with
# SHA-256 before activation. Set PI_HARBOR_SOURCE_DIR only for local development.
set -eu
setopt NO_NOMATCH
umask 077

readonly REPOSITORY="${PI_HARBOR_REPOSITORY:-seehow624/pi-harbor}"
readonly INSTALL_DIR="${PI_HARBOR_INSTALL_DIR:-$HOME/.local/share/pi-harbor}"
readonly BIN_DIR="${PI_HARBOR_BIN_DIR:-$HOME/.local/share/pi-harbor-bin}"
readonly CONFIG_DIR="${PI_HARBOR_CONFIG_DIR:-$HOME/.config/pi-harbor}"
TOKEN_FILE="${PI_HARBOR_TOKEN_FILE:-$CONFIG_DIR/token}"
readonly STATE_DIR="${PI_HARBOR_STATE_DIR:-$HOME/.local/state/pi-harbor}"
readonly RUNTIME_DIR="${PI_HARBOR_RUNTIME_DIR:-$HOME/.local/share/pi-harbor-runtime}"
readonly LAUNCH_DIR="$HOME/Library/LaunchAgents"
readonly SERVER_PLIST="$LAUNCH_DIR/com.piharbor.server.plist"
readonly UPDATER_PLIST="$LAUNCH_DIR/com.piharbor.updater.plist"
readonly SERVER_LABEL="com.piharbor.server"
readonly UPDATER_LABEL="com.piharbor.updater"

YES=0
INSTALL_UPDATES=1
INSTALL_PI=1
REQUESTED_VERSION="${PI_HARBOR_VERSION:-}"

say() { print -r -- "$*"; }
note() { print -r -- "  $*"; }
die() { print -u2 -r -- "Pi Harbor installer: $*"; exit 1; }

if [[ "$TOKEN_FILE" == "~/"* ]]; then TOKEN_FILE="$HOME/${TOKEN_FILE#\~/}"; fi
[[ "$TOKEN_FILE" == /* && "$TOKEN_FILE" != *"|"* && "$TOKEN_FILE" != *"&"* && "$TOKEN_FILE" != *"\""* && "$TOKEN_FILE" != *"\\"* && "$TOKEN_FILE" != *"<"* && "$TOKEN_FILE" != *">"* && "$TOKEN_FILE" != *$'\n'* ]] || die "PI_HARBOR_TOKEN_FILE must be an absolute path without shell or XML separators"

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

  --yes             Accept recommended choices when possible
  --version TAG     Install a specific release tag, for example v2.0.0
  --no-pi           Do not install Pi when the pi command is missing
  --no-updates      Do not install the automatic updater
  --help            Show this help
EOF
}

while (( $# )); do
  case "$1" in
    --yes|-y) YES=1 ;;
    --version) (( $# >= 2 )) || die "--version needs a tag"; REQUESTED_VERSION="$2"; shift ;;
    --no-pi) INSTALL_PI=0 ;;
    --no-updates) INSTALL_UPDATES=0 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Darwin" ]] || die "the one-click installer currently supports macOS only"
(( EUID != 0 )) || die "run this installer as your normal macOS user, not with sudo"
[[ "$HOME" == /* && "$HOME" != "/" ]] || die "HOME is not a safe user directory"
for command in curl tar shasum mktemp sed; do command -v "$command" >/dev/null 2>&1 || die "$command is required"; done

safe_replace_path() {
  case "$1" in
    "$HOME/.local/share/pi-harbor"|"$HOME/.local/share/pi-harbor.previous") return 0 ;;
    *) die "refusing unexpected application path: $1" ;;
  esac
}

confirm() {
  local prompt="$1" default="${2:-yes}" answer=""
  if (( YES )); then [[ "$default" == "yes" ]]; return; fi
  if [[ ! -t 0 ]]; then [[ "$default" == "yes" ]]; return; fi
  if [[ "$default" == "yes" ]]; then
    read "answer?$prompt [Y/n] " || answer=""
    [[ -z "$answer" || "$answer" == [yY]* ]]
  else
    read "answer?$prompt [y/N] " || answer=""
    [[ "$answer" == [yY]* ]]
  fi
}

node_is_supported() {
  local node_bin="$1"
  [[ -x "$node_bin" ]] || return 1
  "$node_bin" -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&(b>19||(b===19&&c>=0)))?0:1)' >/dev/null 2>&1
}

find_node() {
  local candidate
  for candidate in "${NODE_BIN:-}" "$(command -v node 2>/dev/null || true)" \
    "$RUNTIME_DIR/current/bin/node" "/opt/homebrew/bin/node" "/usr/local/bin/node"; do
    [[ -n "$candidate" ]] || continue
    if node_is_supported "$candidate"; then print -r -- "$candidate"; return 0; fi
  done
  return 1
}

install_private_node() {
  local arch node_arch sums archive filename version extracted
  arch="$(uname -m)"
  case "$arch" in
    arm64) node_arch="arm64" ;;
    x86_64) node_arch="x64" ;;
    *) die "unsupported Mac architecture: $arch" ;;
  esac
  say "Installing a private Node.js runtime for Pi Harbor…"
  sums="$WORK_DIR/SHASUMS256.txt"
  curl -fsSL --max-time 180 "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" -o "$sums"
  filename="$(awk -v suffix="darwin-${node_arch}.tar.gz" '$2 ~ suffix"$" { print $2; exit }' "$sums")"
  [[ -n "$filename" ]] || die "could not find the current Node.js 22 build"
  archive="$WORK_DIR/$filename"
  curl -fsSL --max-time 300 "https://nodejs.org/dist/latest-v22.x/$filename" -o "$archive"
  (cd "$WORK_DIR" && grep "  $filename$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || die "Node.js checksum verification failed"
  tar -xzf "$archive" -C "$WORK_DIR"
  extracted="$WORK_DIR/${filename%.tar.gz}"
  [[ -x "$extracted/bin/node" ]] || die "downloaded Node.js runtime is incomplete"
  version="$($extracted/bin/node --version | tr -d 'v')"
  mkdir -p "$RUNTIME_DIR"
  [[ -e "$RUNTIME_DIR/node-$version" ]] || mv "$extracted" "$RUNTIME_DIR/node-$version"
  ln -sfn "$RUNTIME_DIR/node-$version" "$RUNTIME_DIR/current"
  : > "$RUNTIME_DIR/installed-by-pi-harbor"
  NODE_BIN="$RUNTIME_DIR/current/bin/node"
}

find_pi() {
  local candidate
  for candidate in "${PI_BIN:-}" "$(command -v pi 2>/dev/null || true)" \
    "$HOME/.pi/agent/bin/pi" "$HOME/.local/bin/pi" "/opt/homebrew/bin/pi" "/usr/local/bin/pi"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    print -r -- "$candidate"; return 0
  done
  return 1
}

install_pi_agent() {
  (( INSTALL_PI )) || die "Pi is not installed; run again without --no-pi after installing Pi"
  confirm "Pi Agent is missing. Install it with the official Pi installer?" yes || die "Pi Harbor needs Pi Agent"
  say "Opening the official Pi installer…"
  curl -fsSL --max-time 180 https://pi.dev/install.sh -o "$WORK_DIR/pi-install.sh"
  PI_EXPERIMENTAL=1 /bin/sh "$WORK_DIR/pi-install.sh"
  hash -r
  PI_BIN="$(find_pi || true)"
  [[ -n "$PI_BIN" ]] || die "Pi finished installing but the pi command could not be found; restart the shell and run this installer again"
}

legacy_plists=()
USE_SSH_LAUNCHER=0
discover_legacy_services() {
  local plist
  if [[ -f "$SERVER_PLIST" ]] && /usr/bin/grep -Iq -e '/usr/bin/ssh' -e '/pi-harbor-bin/start.sh' "$SERVER_PLIST"; then
    USE_SSH_LAUNCHER=1
  fi
  for plist in "$LAUNCH_DIR"/*.plist; do
    [[ -f "$plist" ]] || continue
    if /usr/bin/grep -Iq -e '/pi-web/' -e '/pi-web-bin/' -e 'PI_WEB_' -e 'com.piweb' "$plist"; then
      legacy_plists+=("$plist")
      if /usr/bin/grep -Iq -e '/usr/bin/ssh' -e '/pi-web-bin/start.sh' "$plist"; then
        USE_SSH_LAUNCHER=1
      fi
    fi
  done
}

plist_label() {
  /usr/libexec/PlistBuddy -c 'Print :Label' "$1" 2>/dev/null || true
}

stop_plist() {
  local plist="$1" label
  label="$(plist_label "$plist")"
  /bin/launchctl bootout "gui/$UID" "$plist" >/dev/null 2>&1 || true
  [[ -z "$label" ]] || /bin/launchctl bootout "gui/$UID/$label" >/dev/null 2>&1 || true
}

migrate_legacy_config() {
  local old_config="$HOME/.config/pi-web"
  mkdir -p "$CONFIG_DIR"
  if [[ ! -f "$TOKEN_FILE" && -f "$old_config/token" ]]; then
    mkdir -p "${TOKEN_FILE:h}"
    cp -p "$old_config/token" "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    note "Preserved the existing Web token"
  fi
  if [[ ! -f "$CONFIG_DIR/updater.json" && -f "$old_config/updater.json" ]]; then
    cp -p "$old_config/updater.json" "$CONFIG_DIR/updater.json"
  fi
}

archive_legacy_installation() {
  local destination="$STATE_DIR/legacy-v1" legacy_path
  mkdir -p "$destination"
  for legacy_path in "$HOME/.local/share/pi-web" "$HOME/.local/share/pi-web-bin" "$HOME/.config/pi-web"; do
    [[ -e "$legacy_path" || -L "$legacy_path" ]] || continue
    case "$legacy_path" in
      "$HOME/.local/share/pi-web"|"$HOME/.local/share/pi-web-bin"|"$HOME/.config/pi-web") ;;
      *) die "refusing unexpected legacy path" ;;
    esac
    [[ -e "$destination/${legacy_path:t}" ]] || mv "$legacy_path" "$destination/${legacy_path:t}"
  done
}

create_token() {
  mkdir -p "${TOKEN_FILE:h}"
  if [[ ! -s "$TOKEN_FILE" ]]; then
    /usr/bin/openssl rand -hex 32 > "$TOKEN_FILE"
    note "Created a new Web token"
  fi
  chmod 600 "$TOKEN_FILE"
}

release_asset_url() {
  local metadata="$1" kind="$2"
  "$NODE_BIN" - "$metadata" "$kind" <<'NODE'
const fs = require("node:fs");
const release = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const suffix = process.argv[3] === "archive" ? ".tar.gz" : ".tar.gz.sha256";
const exact = `pi-harbor-${release.tag_name}${suffix}`;
const asset = release.assets?.find((entry) => entry.name === exact);
if (asset?.browser_download_url) process.stdout.write(asset.browser_download_url);
NODE
}

# The installer is intentionally standalone, so keep this bounded archive
# validator here as well as in the independently installed updater. No release
# entry may touch the filesystem before its name and type pass this preflight.
preflight_release_archive() {
  local archive="$1" listing verbose temp_dir
  [[ -n "$archive" && -f "$archive" ]] || return 1
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-harbor-install-archive-check.XXXXXX")" || return 1
  listing="$temp_dir/listing"
  verbose="$temp_dir/verbose"
  if ! tar -tzf "$archive" > "$listing" 2>/dev/null \
    || ! tar -tvzf "$archive" > "$verbose" 2>/dev/null; then
    /bin/rm -rf -- "$temp_dir"
    return 1
  fi
  if ! "$NODE_BIN" - "$listing" "$verbose" <<'NODE'
const fs = require("node:fs");
const names = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(Boolean);
const verbose = fs.readFileSync(process.argv[3], "utf8").split(/\r?\n/).filter(Boolean);
const fail = (message) => { console.error(`Pi Harbor installer: archive rejected: ${message}`); process.exit(1); };
if (!names.length || names.length !== verbose.length || names.length > 4096) fail("unexpected entry count");
let top = null;
let topDirectory = false;
const seen = new Set();
for (let index = 0; index < names.length; index += 1) {
  const raw = names[index];
  const type = verbose[index].trim()[0] || "";
  if (type !== "d" && type !== "-") fail("links and special entries are not allowed");
  if (!raw || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    fail("absolute or platform-ambiguous entry name");
  }
  const parts = raw.split("/");
  if (parts.some((part) => part === "..")) fail("path traversal entry");
  const normalizedParts = parts.filter((part) => part && part !== ".");
  if (!normalizedParts.length) fail("empty entry name");
  const normalized = normalizedParts.join("/");
  const entryTop = normalizedParts[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entryTop)) fail("invalid release directory name");
  if (!top) top = entryTop;
  if (entryTop !== top || (normalized !== top && !normalized.startsWith(`${top}/`))) fail("archive must contain one top-level release directory");
  if (seen.has(normalized)) fail("duplicate archive entry");
  seen.add(normalized);
  if (normalized === top) {
    if (type !== "d") fail("top-level release entry must be a directory");
    topDirectory = true;
  }
}
if (!top || !topDirectory) fail("top-level release directory is missing");
NODE
  then
    /bin/rm -rf -- "$temp_dir"
    return 1
  fi
  /bin/rm -rf -- "$temp_dir"
  return 0
}

stage_release() {
  local source_dir="${PI_HARBOR_SOURCE_DIR:-}" metadata asset_url checksum_url archive checksum extract_root
  STAGED_DIR="$WORK_DIR/staged"
  mkdir -p "$STAGED_DIR"
  if [[ -n "$source_dir" ]]; then
    source_dir="${source_dir:A}"
    [[ -f "$source_dir/server.js" && -f "$source_dir/public/index.html" ]] || die "PI_HARBOR_SOURCE_DIR is not a Pi Harbor checkout"
    (cd "$source_dir" && tar --exclude='./.git' --exclude='./node_modules' --exclude='./.DS_Store' -cf - .) | tar -xf - -C "$STAGED_DIR"
    return
  fi

  metadata="$WORK_DIR/release.json"
  if [[ -n "$REQUESTED_VERSION" ]]; then
    curl -fsSL --max-time 180 "https://api.github.com/repos/$REPOSITORY/releases/tags/$REQUESTED_VERSION" -o "$metadata"
  else
    curl -fsSL --max-time 180 "https://api.github.com/repos/$REPOSITORY/releases/latest" -o "$metadata"
  fi
  asset_url="$(release_asset_url "$metadata" archive)"
  checksum_url="$(release_asset_url "$metadata" checksum)"
  [[ -n "$asset_url" && -n "$checksum_url" ]] || die "the selected release does not contain a verified installer archive"
  archive="$WORK_DIR/pi-harbor.tar.gz"
  checksum="$WORK_DIR/pi-harbor.sha256"
  curl -fsSL --max-time 300 "$asset_url" -o "$archive"
  curl -fsSL --max-time 180 "$checksum_url" -o "$checksum"
  (cd "$WORK_DIR" && expected="$(awk 'NR==1 {print $1}' pi-harbor.sha256)" && actual="$(shasum -a 256 pi-harbor.tar.gz | awk '{print $1}')" && [[ "$expected" == "$actual" ]]) || die "Pi Harbor release checksum verification failed"
  extract_root="$WORK_DIR/extracted"
  preflight_release_archive "$archive" || die "Pi Harbor release archive failed safety preflight"
  mkdir -p "$extract_root"
  tar -xzf "$archive" -C "$extract_root"
  source_dir="$(find "$extract_root" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [[ -n "$source_dir" && -f "$source_dir/server.js" && -f "$source_dir/public/index.html" ]] || die "release archive is incomplete"
  cp -a "$source_dir"/. "$STAGED_DIR"/
}

render_plist() {
  local source="$1" destination="$2"
  /usr/bin/sed \
    -e "s|__USER__|$USER|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__PIBIN__|$PI_BIN|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__TOKEN_FILE__|$TOKEN_FILE|g" \
    "$source" > "$destination"
  /usr/bin/plutil -lint "$destination" >/dev/null || die "generated LaunchAgent is invalid: $destination"
  chmod 600 "$destination"
}

render_shell() {
  local source="$1" destination="$2"
  /usr/bin/sed \
    -e "s|__USER__|$USER|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__PIBIN__|$PI_BIN|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__TOKEN_FILE__|$TOKEN_FILE|g" \
    "$source" > "$destination"
  /bin/zsh -n "$destination" || die "generated launcher is invalid: $destination"
  chmod 700 "$destination"
}

activate_release() {
  local previous="$INSTALL_DIR.previous"
  safe_replace_path "$INSTALL_DIR"
  safe_replace_path "$previous"
  rm -rf -- "$previous"
  [[ ! -e "$INSTALL_DIR" ]] || mv "$INSTALL_DIR" "$previous"
  mkdir -p "${INSTALL_DIR:h}"
  if ! mv "$STAGED_DIR" "$INSTALL_DIR"; then
    [[ ! -e "$previous" ]] || mv "$previous" "$INSTALL_DIR"
    die "could not activate Pi Harbor"
  fi
}

install_services() {
  local server_template="$INSTALL_DIR/deploy/com.piharbor.server.plist"
  mkdir -p "$BIN_DIR" "$STATE_DIR" "$LAUNCH_DIR"
  cp "$INSTALL_DIR/deploy/pi-harbor-update.sh" "$BIN_DIR/pi-harbor-update.sh"
  cp "$INSTALL_DIR/uninstall.sh" "$BIN_DIR/uninstall.sh"
  chmod 700 "$BIN_DIR/pi-harbor-update.sh" "$BIN_DIR/uninstall.sh"
  if (( USE_SSH_LAUNCHER )); then
    server_template="$INSTALL_DIR/deploy/com.piharbor.server.mini.plist"
    render_shell "$INSTALL_DIR/deploy/pi-harbor-mini-start.sh" "$BIN_DIR/start.sh"
    for legacy_file in id_ed25519 known_hosts; do
      if [[ -f "$HOME/.local/share/pi-web-bin/$legacy_file" && ! -f "$BIN_DIR/$legacy_file" ]]; then
        cp -p "$HOME/.local/share/pi-web-bin/$legacy_file" "$BIN_DIR/$legacy_file"
      fi
    done
    [[ -f "$BIN_DIR/id_ed25519" ]] || die "the existing SSH launch mode is missing its local key"
    chmod 600 "$BIN_DIR/id_ed25519"
    note "Preserved this Mac's reliable local SSH launch mode"
  fi
  render_plist "$server_template" "$SERVER_PLIST"
  if (( INSTALL_UPDATES )); then
    render_plist "$INSTALL_DIR/deploy/com.piharbor.updater.plist" "$UPDATER_PLIST"
    print -r -- '{"enabled":true,"repository":"seehow624/pi-harbor","ref":"stable","intervalMinutes":60}' > "$CONFIG_DIR/updater.json"
    chmod 600 "$CONFIG_DIR/updater.json"
  fi
}

configured_port() {
  "$NODE_BIN" - "$HOME/.pi/agent/device.json" <<'NODE'
const fs = require("node:fs");
try {
  const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).port;
  process.stdout.write(Number.isInteger(value) && value >= 1024 && value <= 65535 ? String(value) : "3140");
} catch { process.stdout.write("3140"); }
NODE
}

wait_for_health() {
  local port="$1" attempt listener_pid listener_command
  for attempt in {1..30}; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
      listener_pid="$(/usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | /usr/bin/head -n 1 || true)"
      listener_command="$([[ -n "$listener_pid" ]] && /bin/ps -p "$listener_pid" -o command= 2>/dev/null || true)"
      [[ "$listener_command" == *"$INSTALL_DIR/server.js"* ]] && return 0
    fi
    sleep 1
  done
  return 1
}

active_rpc_running() {
  local port="$1" cookie response token
  [[ -s "$TOKEN_FILE" ]] || return 1
  cookie="$(mktemp "${TMPDIR:-/tmp}/pi-harbor-install-cookie.XXXXXX")"
  token="$(tr -d '\n' < "$TOKEN_FILE")"
  if ! curl -fsS --max-time 3 -c "$cookie" -H 'Content-Type: application/json' \
    --data-binary "{\"token\":\"$token\"}" "http://127.0.0.1:$port/api/login" >/dev/null 2>&1; then
    rm -f -- "$cookie"
    return 1
  fi
  response="$(curl -fsS --max-time 3 -b "$cookie" "http://127.0.0.1:$port/api/rpcs" 2>/dev/null || true)"
  rm -f -- "$cookie"
  RPC_RESPONSE="$response" "$NODE_BIN" - <<'NODE'
try { const value = JSON.parse(process.env.RPC_RESPONSE || "{}"); process.exit(value.rpcs?.some((rpc) => rpc.isStreaming === true) ? 0 : 1); } catch { process.exit(1); }
NODE
}

# No-network/no-extraction maintainer hook used by regression tests and release
# review. It exits before staging, prompts, token creation, or launchd changes.
if [[ -n "${PI_HARBOR_INSTALL_PREFLIGHT_ARCHIVE:-}" ]]; then
  NODE_BIN="$(find_node || true)"
  [[ -n "$NODE_BIN" ]] || die "Node.js 22.19 or newer is required for archive preflight"
  preflight_release_archive "$PI_HARBOR_INSTALL_PREFLIGHT_ARCHIVE" || exit 1
  exit 0
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-harbor-install.XXXXXX")"
cleanup() { rm -rf -- "$WORK_DIR"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

say ""
say "Pi Harbor 2.2.3 installer"
say "────────────────────────"

NODE_BIN="$(find_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  confirm "Pi Harbor needs Node.js 22.19 or newer. Install a private runtime?" yes || die "Node.js 22.19 or newer is required"
  install_private_node
fi
export PATH="${NODE_BIN:h}:$PATH"

PI_BIN="$(find_pi || true)"
[[ -n "$PI_BIN" ]] || install_pi_agent

stage_release
discover_legacy_services
migrate_legacy_config
create_token
PORT="$(configured_port)"

if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && active_rpc_running "$PORT"; then
  die "Pi is working in an active session; wait for it to finish, then run the installer again"
fi

for plist in "${legacy_plists[@]}"; do stop_plist "$plist"; done
stop_plist "$SERVER_PLIST"
stop_plist "$UPDATER_PLIST"

activate_release
install_services
/bin/launchctl bootstrap "gui/$UID" "$SERVER_PLIST"
/bin/launchctl kickstart -k "gui/$UID/$SERVER_LABEL" >/dev/null 2>&1 || true
if (( INSTALL_UPDATES )); then
  /bin/launchctl bootstrap "gui/$UID" "$UPDATER_PLIST"
fi

if ! wait_for_health "$PORT"; then
  stop_plist "$SERVER_PLIST"
  [[ ! -d "$INSTALL_DIR.previous" ]] || { rm -rf -- "$INSTALL_DIR"; mv "$INSTALL_DIR.previous" "$INSTALL_DIR"; }
  for plist in "${legacy_plists[@]}"; do /bin/launchctl bootstrap "gui/$UID" "$plist" >/dev/null 2>&1 || true; done
  die "the service did not become healthy; the previous installation was restored"
fi

for plist in "${legacy_plists[@]}"; do
  mkdir -p "$STATE_DIR/legacy-launchagents"
  mv "$plist" "$STATE_DIR/legacy-launchagents/${plist:t}" 2>/dev/null || true
done
archive_legacy_installation

say ""
say "Pi Harbor is ready."
note "Local service: http://127.0.0.1:$PORT"
note "Web token file: $TOKEN_FILE"
if [[ "$TOKEN_FILE" == "$HOME/.config/pi-harbor/token" ]]; then
  note "To sign in, open Terminal on this computer and run: cat ~/.config/pi-harbor/token"
else
  note "To sign in, open Terminal on this computer and read: $TOKEN_FILE"
fi
note "For another device, retrieve the token securely from this computer; never share it in chat, screenshots, repositories, or logs."
note "Remove later: $BIN_DIR/uninstall.sh"
if command -v tailscale >/dev/null 2>&1 || [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
  note "Open Pi Harbor through your Tailscale HTTPS address for secure remote access."
else
  note "Install Tailscale when you want secure access from another device."
fi
say ""
