#!/bin/zsh
# Stepsemble one-click installer for macOS.
#
# Stable installs come from a GitHub Release asset and are verified with
# SHA-256 before activation. Set STEPSEMBLE_SOURCE_DIR only for local development.
set -eu
setopt NO_NOMATCH
umask 077

REPOSITORY="${STEPSEMBLE_REPOSITORY:-${PI_HARBOR_REPOSITORY:-${PI_WEB_REPOSITORY:-seehow624/stepsemble}}}"
[[ "$REPOSITORY" != "seehow624/pi-harbor" ]] || REPOSITORY="seehow624/stepsemble"
readonly REPOSITORY
readonly INSTALL_DIR="${STEPSEMBLE_INSTALL_DIR:-$HOME/.local/share/stepsemble}"
readonly BIN_DIR="${STEPSEMBLE_BIN_DIR:-$HOME/.local/share/stepsemble-bin}"
readonly CONFIG_DIR="${STEPSEMBLE_CONFIG_DIR:-$HOME/.config/stepsemble}"
TOKEN_FILE="${STEPSEMBLE_TOKEN_FILE:-$CONFIG_DIR/token}"
readonly STATE_DIR="${STEPSEMBLE_STATE_DIR:-$HOME/.local/state/stepsemble}"
readonly RUNTIME_DIR="${STEPSEMBLE_RUNTIME_DIR:-$HOME/.local/share/stepsemble-runtime}"
readonly LAUNCH_DIR="$HOME/Library/LaunchAgents"
readonly SERVER_PLIST="$LAUNCH_DIR/com.stepsemble.server.plist"
readonly UPDATER_PLIST="$LAUNCH_DIR/com.stepsemble.updater.plist"
readonly SERVER_LABEL="com.stepsemble.server"
readonly UPDATER_LABEL="com.stepsemble.updater"

YES=0
INSTALL_UPDATES=1
INSTALL_PI=1
REQUESTED_VERSION="${STEPSEMBLE_VERSION:-${PI_HARBOR_VERSION:-${PI_WEB_VERSION:-}}}"

say() { print -r -- "$*"; }
note() { print -r -- "  $*"; }
die() { print -u2 -r -- "Stepsemble installer: $*"; exit 1; }

if [[ "$TOKEN_FILE" == "~/"* ]]; then TOKEN_FILE="$HOME/${TOKEN_FILE#\~/}"; fi
[[ "$TOKEN_FILE" == /* && "$TOKEN_FILE" != *"|"* && "$TOKEN_FILE" != *"&"* && "$TOKEN_FILE" != *"\""* && "$TOKEN_FILE" != *"\\"* && "$TOKEN_FILE" != *"<"* && "$TOKEN_FILE" != *">"* && "$TOKEN_FILE" != *$'\n'* ]] || die "STEPSEMBLE_TOKEN_FILE must be an absolute path without shell or XML separators"
[[ ! -L "$CONFIG_DIR" && ! -L "$TOKEN_FILE" ]] || die "refusing a symlinked Stepsemble config or token path"

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

  --yes             Accept recommended choices when possible
  --version TAG     Install a specific release tag, for example v3.0.0
  --no-pi           Do not offer to install Pi when it is missing
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
[[ "$REPOSITORY" =~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' ]] || die "invalid GitHub repository"
for command in curl tar shasum mktemp sed; do command -v "$command" >/dev/null 2>&1 || die "$command is required"; done

safe_replace_path() {
  case "$1" in
    "$HOME/.local/share/stepsemble"|"$HOME/.local/share/stepsemble.previous") return 0 ;;
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
    "$RUNTIME_DIR/current/bin/node" "$HOME/.local/share/pi-harbor-runtime/current/bin/node" \
    "/opt/homebrew/bin/node" "/usr/local/bin/node"; do
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
  say "Installing a private Node.js runtime for Stepsemble…"
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
  : > "$RUNTIME_DIR/installed-by-stepsemble"
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
  (( INSTALL_PI )) || { note "Pi Agent is not installed; its connector will remain unavailable"; return 0; }
  confirm "Pi Agent is missing. Install it with the official Pi installer?" yes || {
    note "Skipped Pi Agent; other installed agent connectors remain available"
    return 0
  }
  say "Opening the official Pi installer…"
  curl -fsSL --max-time 180 https://pi.dev/install.sh -o "$WORK_DIR/pi-install.sh"
  PI_EXPERIMENTAL=1 /bin/sh "$WORK_DIR/pi-install.sh"
  hash -r
  PI_BIN="$(find_pi || true)"
  [[ -n "$PI_BIN" ]] || die "Pi finished installing but the pi command could not be found; restart the shell and run this installer again"
}

legacy_plists=()
legacy_active_plists=()
USE_SSH_LAUNCHER=0
CURRENT_SERVER_WAS_LOADED=0
CURRENT_UPDATER_WAS_LOADED=0
discover_legacy_services() {
  local plist label
  if [[ -f "$SERVER_PLIST" ]] && /usr/bin/grep -Iq -e '/usr/bin/ssh' -e '/stepsemble-bin/start.sh' "$SERVER_PLIST"; then
    USE_SSH_LAUNCHER=1
  fi
  for plist in "$LAUNCH_DIR"/*.plist; do
    [[ -f "$plist" ]] || continue
    label="$(plist_label "$plist")"
    case "$label" in
      com.piharbor.server|com.piharbor.updater|com.jerome.pi-web|com.jerome.pi-web-updater|com.piweb.server|com.piweb.updater) ;;
      *) continue ;;
    esac
    legacy_plists+=("$plist")
    if /bin/launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
      legacy_active_plists+=("$plist")
    fi
    if /usr/bin/grep -Iq -e '/usr/bin/ssh' -e '/pi-harbor-bin/start.sh' -e '/pi-web-bin/start.sh' "$plist"; then
      USE_SSH_LAUNCHER=1
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

backup_current_services() {
  local backup_dir="$WORK_DIR/current-services" file
  /bin/launchctl print "gui/$UID/$SERVER_LABEL" >/dev/null 2>&1 && CURRENT_SERVER_WAS_LOADED=1 || true
  /bin/launchctl print "gui/$UID/$UPDATER_LABEL" >/dev/null 2>&1 && CURRENT_UPDATER_WAS_LOADED=1 || true
  mkdir -p "$backup_dir/plists" "$backup_dir/bin"
  for file in "$SERVER_PLIST" "$UPDATER_PLIST"; do
    [[ -f "$file" && ! -L "$file" ]] || continue
    cp -p "$file" "$backup_dir/plists/${file:t}"
  done
  for file in start.sh stepsemble-update.sh uninstall.sh id_ed25519 known_hosts; do
    [[ -f "$BIN_DIR/$file" && ! -L "$BIN_DIR/$file" ]] || continue
    cp -p "$BIN_DIR/$file" "$backup_dir/bin/$file"
  done
}

restore_current_services_after_failure() {
  local backup_dir="$WORK_DIR/current-services" file
  for file in "$SERVER_PLIST" "$UPDATER_PLIST"; do
    if [[ -f "$backup_dir/plists/${file:t}" ]]; then
      cp -p "$backup_dir/plists/${file:t}" "$file"
    else
      rm -f -- "$file"
    fi
  done
  for file in "$backup_dir/bin"/*; do
    [[ -f "$file" ]] || continue
    mkdir -p "$BIN_DIR"
    cp -p "$file" "$BIN_DIR/${file:t}"
  done
  if (( CURRENT_SERVER_WAS_LOADED )) && [[ -f "$SERVER_PLIST" ]]; then
    /bin/launchctl bootstrap "gui/$UID" "$SERVER_PLIST" >/dev/null 2>&1 || true
  fi
  if (( CURRENT_UPDATER_WAS_LOADED )) && [[ -f "$UPDATER_PLIST" ]]; then
    /bin/launchctl bootstrap "gui/$UID" "$UPDATER_PLIST" >/dev/null 2>&1 || true
  fi
}

migrate_legacy_config() {
  local old_config file_name task_file
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  for old_config in "$HOME/.config/pi-harbor" "$HOME/.config/pi-web"; do
    [[ -d "$old_config" && ! -L "$old_config" ]] || continue
    if [[ ! -f "$TOKEN_FILE" && -f "$old_config/token" && ! -L "$old_config/token" ]]; then
      mkdir -p "${TOKEN_FILE:h}"
      cp -p "$old_config/token" "$TOKEN_FILE"
      chmod 600 "$TOKEN_FILE"
      note "Preserved the existing Web token"
    fi
    for file_name in tokens.json onboarding.json device-trust.json updater.json update-state.json push.json push-subscriptions.json provider-cookies.json agent-tasks.json; do
      [[ -f "$old_config/$file_name" && ! -L "$old_config/$file_name" && ! -e "$CONFIG_DIR/$file_name" ]] || continue
      cp -p "$old_config/$file_name" "$CONFIG_DIR/$file_name"
      chmod 600 "$CONFIG_DIR/$file_name"
    done
    if [[ -d "$old_config/agent-tasks" && ! -L "$old_config/agent-tasks" ]]; then
      [[ ! -L "$CONFIG_DIR/agent-tasks" ]] || die "refusing a symlinked Stepsemble task-state directory"
      mkdir -p "$CONFIG_DIR/agent-tasks"
      chmod 700 "$CONFIG_DIR/agent-tasks"
      for task_file in "$old_config/agent-tasks"/*.json; do
        [[ -f "$task_file" && ! -L "$task_file" && ! -e "$CONFIG_DIR/agent-tasks/${task_file:t}" ]] || continue
        cp -p "$task_file" "$CONFIG_DIR/agent-tasks/${task_file:t}"
        chmod 600 "$CONFIG_DIR/agent-tasks/${task_file:t}"
      done
    fi
  done
}

archive_legacy_installation() {
  local destination="$STATE_DIR/legacy-products/$(date +%Y%m%d-%H%M%S)" legacy_path
  for legacy_path in "$HOME/.local/share/pi-harbor" "$HOME/.local/share/pi-web"; do
    [[ -e "$legacy_path" || -L "$legacy_path" ]] || continue
    case "$legacy_path" in
      "$HOME/.local/share/pi-harbor"|"$HOME/.local/share/pi-web") ;;
      *) die "refusing unexpected legacy path" ;;
    esac
    mkdir -p "$destination"
    mv "$legacy_path" "$destination/${legacy_path:t}"
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
const exact = `stepsemble-${release.tag_name}${suffix}`;
const asset = release.assets?.find((entry) => entry.name === exact);
if (asset?.browser_download_url) process.stdout.write(asset.browser_download_url);
NODE
}

# GitHub's unauthenticated REST API is limited per public IP.  If that quota
# is exhausted, the public release page still redirects to the selected tag;
# use that tag to build the predictable archive and checksum URLs.
write_page_release_metadata() {
  local metadata="$1" tag="$2"
  "$NODE_BIN" - "$metadata" "$tag" "$REPOSITORY" <<'NODE'
const fs = require("node:fs");
const [file, tag, repository] = process.argv.slice(2);
const archive = `stepsemble-${tag}.tar.gz`;
const base = `https://github.com/${repository}/releases/download/${tag}`;
fs.writeFileSync(file, JSON.stringify({
  tag_name: tag,
  assets: [
    { name: archive, browser_download_url: `${base}/${archive}` },
    { name: `${archive}.sha256`, browser_download_url: `${base}/${archive}.sha256` },
  ],
}));
NODE
}

fetch_release_metadata() {
  local metadata="$1" page_url final_url tag api_url
  if [[ -n "$REQUESTED_VERSION" ]]; then
    api_url="https://api.github.com/repos/$REPOSITORY/releases/tags/$REQUESTED_VERSION"
  else
    api_url="https://api.github.com/repos/$REPOSITORY/releases/latest"
  fi
  if curl -fsSL --max-time 180 "$api_url" -o "$metadata"; then
    return 0
  fi
  page_url="https://github.com/$REPOSITORY/releases/latest"
  [[ -n "$REQUESTED_VERSION" ]] && page_url="https://github.com/$REPOSITORY/releases/tag/$REQUESTED_VERSION"
  final_url="$(curl -fsSL --max-time 60 -o /dev/null -w '%{url_effective}' "$page_url" 2>/dev/null)" || return 1
  final_url="${final_url%%\?*}"
  tag="${final_url##*/}"
  [[ "$tag" =~ '^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$' ]] || return 1
  write_page_release_metadata "$metadata" "$tag"
}

# The installer is intentionally standalone, so keep this bounded archive
# validator here as well as in the independently installed updater. No release
# entry may touch the filesystem before its name and type pass this preflight.
preflight_release_archive() {
  local archive="$1" listing verbose temp_dir
  [[ -n "$archive" && -f "$archive" ]] || return 1
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/stepsemble-install-archive-check.XXXXXX")" || return 1
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
const fail = (message) => { console.error(`Stepsemble installer: archive rejected: ${message}`); process.exit(1); };
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
  local source_dir="${STEPSEMBLE_SOURCE_DIR:-${PI_HARBOR_SOURCE_DIR:-${PI_WEB_SOURCE_DIR:-}}}" metadata asset_url checksum_url archive checksum extract_root
  STAGED_DIR="$WORK_DIR/staged"
  mkdir -p "$STAGED_DIR"
  if [[ -n "$source_dir" ]]; then
    source_dir="${source_dir:A}"
    [[ -f "$source_dir/server.js" && -f "$source_dir/public/index.html" ]] || die "STEPSEMBLE_SOURCE_DIR is not a Stepsemble checkout"
    (cd "$source_dir" && tar --exclude='./.git' --exclude='./node_modules' --exclude='./.DS_Store' --exclude='./_MEMORY-CARD.md' -cf - .) | tar -xf - -C "$STAGED_DIR"
    return
  fi

  metadata="$WORK_DIR/release.json"
  fetch_release_metadata "$metadata" || die "could not read release metadata"
  asset_url="$(release_asset_url "$metadata" archive)"
  checksum_url="$(release_asset_url "$metadata" checksum)"
  [[ -n "$asset_url" && -n "$checksum_url" ]] || die "the selected release does not contain a verified installer archive"
  archive="$WORK_DIR/stepsemble.tar.gz"
  checksum="$WORK_DIR/stepsemble.sha256"
  curl -fsSL --max-time 300 "$asset_url" -o "$archive"
  curl -fsSL --max-time 180 "$checksum_url" -o "$checksum"
  (cd "$WORK_DIR" && expected="$(awk 'NR==1 {print $1}' stepsemble.sha256)" && actual="$(shasum -a 256 stepsemble.tar.gz | awk '{print $1}')" && [[ "$expected" == "$actual" ]]) || die "Stepsemble release checksum verification failed"
  extract_root="$WORK_DIR/extracted"
  preflight_release_archive "$archive" || die "Stepsemble release archive failed safety preflight"
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
    die "could not activate Stepsemble"
  fi
  INSTALL_ACTIVATED=1
}

install_services() {
  local server_template="$INSTALL_DIR/deploy/com.stepsemble.server.plist" legacy_file legacy_bin
  mkdir -p "$BIN_DIR" "$STATE_DIR" "$LAUNCH_DIR"
  cp "$INSTALL_DIR/deploy/stepsemble-update.sh" "$BIN_DIR/stepsemble-update.sh"
  cp "$INSTALL_DIR/uninstall.sh" "$BIN_DIR/uninstall.sh"
  chmod 700 "$BIN_DIR/stepsemble-update.sh" "$BIN_DIR/uninstall.sh"
  if (( USE_SSH_LAUNCHER )); then
    server_template="$INSTALL_DIR/deploy/com.stepsemble.server.mini.plist"
    render_shell "$INSTALL_DIR/deploy/stepsemble-mini-start.sh" "$BIN_DIR/start.sh"
    for legacy_file in id_ed25519 known_hosts; do
      for legacy_bin in "$HOME/.local/share/pi-harbor-bin" "$HOME/.local/share/pi-web-bin"; do
        if [[ -f "$legacy_bin/$legacy_file" && ! -L "$legacy_bin/$legacy_file" && ! -f "$BIN_DIR/$legacy_file" ]]; then
          cp -p "$legacy_bin/$legacy_file" "$BIN_DIR/$legacy_file"
        fi
      done
    done
    [[ -f "$BIN_DIR/id_ed25519" ]] || die "the existing SSH launch mode is missing its local key"
    chmod 600 "$BIN_DIR/id_ed25519"
    note "Preserved this Mac's reliable local SSH launch mode"
  fi
  render_plist "$server_template" "$SERVER_PLIST"
  if (( INSTALL_UPDATES )); then
    render_plist "$INSTALL_DIR/deploy/com.stepsemble.updater.plist" "$UPDATER_PLIST"
    if [[ ! -f "$CONFIG_DIR/updater.json" ]]; then
      print -r -- '{"enabled":true,"repository":"seehow624/stepsemble","ref":"stable","intervalMinutes":60}' > "$CONFIG_DIR/updater.json"
    fi
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
  local port="$1" expected="$2" attempt listener_pid listener_command response
  for attempt in {1..30}; do
    response="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" 2>/dev/null || true)"
    if HEALTH_RESPONSE="$response" EXPECTED_VERSION="$expected" "$NODE_BIN" - <<'NODE'
try {
  const value = JSON.parse(process.env.HEALTH_RESPONSE || "{}");
  process.exit(value.ok === true && String(value.appVersion || "").replace(/^v/, "") === process.env.EXPECTED_VERSION.replace(/^v/, "") ? 0 : 1);
} catch { process.exit(1); }
NODE
    then
      listener_pid="$(/usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | /usr/bin/head -n 1 || true)"
      listener_command="$([[ -n "$listener_pid" ]] && /bin/ps -p "$listener_pid" -o command= 2>/dev/null || true)"
      [[ "$listener_command" == *"$INSTALL_DIR/server.js"* ]] && return 0
    fi
    sleep 1
  done
  return 1
}

active_work_state() {
  local port="$1" cookie login_payload rpcs_file tasks_file task_status result
  [[ -s "$TOKEN_FILE" ]] || return 2
  cookie="$(mktemp "${TMPDIR:-/tmp}/stepsemble-install-cookie.XXXXXX")"
  login_payload="$(mktemp "${TMPDIR:-/tmp}/stepsemble-install-login.XXXXXX")"
  rpcs_file="$(mktemp "${TMPDIR:-/tmp}/stepsemble-install-rpcs.XXXXXX")"
  tasks_file="$(mktemp "${TMPDIR:-/tmp}/stepsemble-install-tasks.XXXXXX")"
  if ! "$NODE_BIN" - "$TOKEN_FILE" "$login_payload" <<'NODE'
const fs = require("node:fs");
const token = fs.readFileSync(process.argv[2], "utf8").trim();
if (!token) process.exit(1);
fs.writeFileSync(process.argv[3], JSON.stringify({ token }), { mode: 0o600 });
NODE
  then
    rm -f -- "$cookie" "$login_payload" "$rpcs_file" "$tasks_file"
    return 2
  fi
  if ! curl -fsS --max-time 3 -c "$cookie" -H 'Content-Type: application/json' \
    --data-binary "@$login_payload" "http://127.0.0.1:$port/api/login" >/dev/null 2>&1; then
    rm -f -- "$cookie" "$login_payload" "$rpcs_file" "$tasks_file"
    return 2
  fi
  if ! curl -fsS --max-time 3 -b "$cookie" "http://127.0.0.1:$port/api/rpcs" -o "$rpcs_file" 2>/dev/null; then
    rm -f -- "$cookie" "$login_payload" "$rpcs_file" "$tasks_file"
    return 2
  fi
  task_status="$(curl -sS --max-time 3 -b "$cookie" "http://127.0.0.1:$port/api/agent-tasks" -o "$tasks_file" -w '%{http_code}' 2>/dev/null || true)"
  case "$task_status" in
    200) ;;
    404) print -r -- '{}' > "$tasks_file" ;;
    *) rm -f -- "$cookie" "$login_payload" "$rpcs_file" "$tasks_file"; return 2 ;;
  esac
  if "$NODE_BIN" - "$rpcs_file" "$tasks_file" <<'NODE'
const fs = require("node:fs");
try {
  const rpcs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const tasks = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  if (!Array.isArray(rpcs.rpcs)) process.exit(2);
  const rpcActive = rpcs.rpcs.some((rpc) => rpc?.isStreaming === true);
  const taskActive = Array.isArray(tasks.tasks) && tasks.tasks.some((task) =>
    ["starting", "running", "waiting", "reconnecting"].includes(String(task?.status || "")));
  process.exit(rpcActive || taskActive ? 0 : 1);
} catch { process.exit(2); }
NODE
  then
    result=0
  else
    result=$?
  fi
  rm -f -- "$cookie" "$login_payload" "$rpcs_file" "$tasks_file"
  return "$result"
}

# No-network/no-extraction maintainer hook used by regression tests and release
# review. It exits before staging, prompts, token creation, or launchd changes.
if [[ -n "${STEPSEMBLE_INSTALL_PREFLIGHT_ARCHIVE:-}" ]]; then
  NODE_BIN="$(find_node || true)"
  [[ -n "$NODE_BIN" ]] || die "Node.js 22.19 or newer is required for archive preflight"
  preflight_release_archive "$STEPSEMBLE_INSTALL_PREFLIGHT_ARCHIVE" || exit 1
  exit 0
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stepsemble-install.XXXXXX")"
ROLLBACK_ARMED=0
INSTALL_ACTIVATED=0
rollback_installation() {
  local plist
  stop_plist "$SERVER_PLIST"
  stop_plist "$UPDATER_PLIST"
  if (( INSTALL_ACTIVATED )); then
    rm -rf -- "$INSTALL_DIR"
    [[ ! -d "$INSTALL_DIR.previous" ]] || mv "$INSTALL_DIR.previous" "$INSTALL_DIR"
  fi
  restore_current_services_after_failure
  for plist in "${legacy_active_plists[@]}"; do
    /bin/launchctl bootstrap "gui/$UID" "$plist" >/dev/null 2>&1 || true
  done
}
cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e
  (( ROLLBACK_ARMED == 0 )) || rollback_installation
  rm -rf -- "$WORK_DIR"
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

say ""
say "Stepsemble 3.0.0 installer"
say "────────────────────────"

NODE_BIN="$(find_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  confirm "Stepsemble needs Node.js 22.19 or newer. Install a private runtime?" yes || die "Node.js 22.19 or newer is required"
  install_private_node
fi
export PATH="${NODE_BIN:h}:$PATH"

PI_BIN="$(find_pi || true)"
[[ -n "$PI_BIN" ]] || install_pi_agent

stage_release
EXPECTED_VERSION="$("$NODE_BIN" -p 'require(process.argv[1]).version' "$STAGED_DIR/package.json" 2>/dev/null || true)"
[[ "$EXPECTED_VERSION" =~ '^[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$' ]] || die "the staged release has an invalid version"
discover_legacy_services
migrate_legacy_config
create_token
PORT="$(configured_port)"

if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  if active_work_state "$PORT"; then
    die "an agent is working or waiting for input; finish it before updating"
  else
    work_state=$?
    (( work_state == 1 )) || die "could not safely inspect the running service; verify its token and try again"
  fi
fi

backup_current_services
ROLLBACK_ARMED=1
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

if ! wait_for_health "$PORT" "$EXPECTED_VERSION"; then
  die "the service did not become healthy; the previous installation was restored"
fi
ROLLBACK_ARMED=0

legacy_plist_dir=""
for plist in "${legacy_plists[@]}"; do
  [[ -n "$legacy_plist_dir" ]] || legacy_plist_dir="$STATE_DIR/legacy-launchagents/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$legacy_plist_dir"
  mv "$plist" "$legacy_plist_dir/${plist:t}"
done
archive_legacy_installation

say ""
say "Stepsemble is ready."
note "Local service: http://127.0.0.1:$PORT"
note "Web token file: $TOKEN_FILE"
if [[ "$TOKEN_FILE" == "$HOME/.config/stepsemble/token" ]]; then
  note "To sign in, open Terminal on this computer and run: cat ~/.config/stepsemble/token"
else
  note "To sign in, open Terminal on this computer and read: $TOKEN_FILE"
fi
note "For another device, retrieve the token securely from this computer; never share it in chat, screenshots, repositories, or logs."
note "Remove later: $BIN_DIR/uninstall.sh"
if command -v tailscale >/dev/null 2>&1 || [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
  note "Open Stepsemble through your Tailscale HTTPS address for secure remote access."
else
  note "Install Tailscale when you want secure access from another device."
fi
say ""
