#!/usr/bin/env bash
# Stepsemble one-click installer for Linux.
#
# The Linux service is a user-level systemd unit. Node.js 22.19+ is required;
# keeping the runtime managed by the distribution (or fnm/volta) avoids a
# privileged installer and lets the user choose how Node is patched.
set -euo pipefail
umask 077

REPOSITORY="${STEPSEMBLE_REPOSITORY:-${PI_HARBOR_REPOSITORY:-${PI_WEB_REPOSITORY:-seehow624/stepsemble}}}"
[[ "$REPOSITORY" != "seehow624/pi-harbor" ]] || REPOSITORY="seehow624/stepsemble"
readonly REPOSITORY
readonly INSTALL_DIR="${STEPSEMBLE_INSTALL_DIR:-$HOME/.local/share/stepsemble}"
readonly BIN_DIR="${STEPSEMBLE_BIN_DIR:-$HOME/.local/share/stepsemble-bin}"
readonly CONFIG_DIR="${STEPSEMBLE_CONFIG_DIR:-$HOME/.config/stepsemble}"
readonly TOKEN_FILE="${STEPSEMBLE_TOKEN_FILE:-$CONFIG_DIR/token}"
readonly STATE_DIR="${STEPSEMBLE_STATE_DIR:-$HOME/.local/state/stepsemble}"
readonly SERVICE_DIR="$HOME/.config/systemd/user"
readonly SERVICE_NAME="stepsemble.service"
readonly UPDATER_SERVICE_NAME="stepsemble-updater.service"
readonly UPDATER_TIMER_NAME="stepsemble-updater.timer"

REQUESTED_VERSION="${STEPSEMBLE_VERSION:-${PI_HARBOR_VERSION:-${PI_WEB_VERSION:-}}}"
YES=0
INSTALL_UPDATES=1
SOURCE_DIR="${STEPSEMBLE_SOURCE_DIR:-${PI_HARBOR_SOURCE_DIR:-${PI_WEB_SOURCE_DIR:-}}}"

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf 'Stepsemble installer: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./install-linux.sh [options]

  --yes             Accept recommended choices
  --version TAG     Install an exact release tag, for example v2.13.0
  --no-updates      Do not install the hourly systemd update timer
  --source DIR      Install from a local checkout (development)
  --help            Show this help
EOF
}

while (($#)); do
  case "$1" in
    --yes|-y) YES=1 ;;
    --version) (($# >= 2)) || die "--version needs a tag"; REQUESTED_VERSION="$2"; shift ;;
    --no-updates) INSTALL_UPDATES=0 ;;
    --source) (($# >= 2)) || die "--source needs a directory"; SOURCE_DIR="$2"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Linux" ]] || die "run this installer on Linux"
[[ "$EUID" -ne 0 ]] || die "run this installer as your normal user, not with sudo"
[[ "$HOME" == /* && "$HOME" != "/" ]] || die "HOME is not a safe user directory"
[[ "$INSTALL_DIR" == "$HOME/.local/share/stepsemble" ]] || die "refusing unexpected application path"
[[ "$BIN_DIR" == "$HOME/.local/share/stepsemble-bin" ]] || die "refusing unexpected binary path"
[[ "$CONFIG_DIR" == "$HOME/.config/stepsemble" ]] || die "refusing unexpected config path"
[[ "$TOKEN_FILE" == "$CONFIG_DIR/token" ]] || die "use STEPSEMBLE_CONFIG_DIR instead of a custom token path"
[[ ! -L "$CONFIG_DIR" && ! -L "$TOKEN_FILE" ]] || die "refusing a symlinked Stepsemble config or token path"
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid GitHub repository"
for command in node curl tar sha256sum sed find cp mv mkdir; do command -v "$command" >/dev/null 2>&1 || die "$command is required"; done

node_supported() {
  node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&(b>19||(b===19&&c>=0)))?0:1)' >/dev/null 2>&1
}
node_supported || die "Node.js 22.19 or newer is required"

safe_tag() { [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$ ]]; }
release_is_newer() {
  node - "$1" "$2" <<'NODE'
function parts(value) { const m=String(value||"").match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-.]([A-Za-z0-9.-]+))?$/); return m ? { n:m.slice(1,4).map(Number), p:m[4]||"" } : null; }
const a=parts(process.argv[2]), b=parts(process.argv[3]); if (!b) process.exit(1); if (!a) process.exit(0);
for (let i=0;i<3;i++) { if (b.n[i]!==a.n[i]) process.exit(b.n[i]>a.n[i]?0:1); } process.exit(!b.p && a.p ? 0 : 1);
NODE
}

preflight_archive() {
  local archive="$1" listing verbose
  listing="$work_dir/listing"; verbose="$work_dir/verbose"
  tar -tzf "$archive" > "$listing" || return 1
  tar -tvzf "$archive" > "$verbose" || return 1
  node - "$listing" "$verbose" <<'NODE'
const fs = require("node:fs");
const names = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(Boolean);
const verbose = fs.readFileSync(process.argv[3], "utf8").split(/\r?\n/).filter(Boolean);
const fail = (message) => { console.error(`Stepsemble installer: archive rejected: ${message}`); process.exit(1); };
if (!names.length || names.length !== verbose.length || names.length > 4096) fail("unexpected entry count");
let top = null; let topDirectory = false; const seen = new Set();
for (let index = 0; index < names.length; index += 1) {
  const raw = names[index]; const type = verbose[index].trim()[0] || "";
  if (type !== "d" && type !== "-") fail("links and special entries are not allowed");
  if (!raw || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) fail("absolute or platform-ambiguous entry name");
  const parts = raw.split("/");
  if (parts.some((part) => part === "..")) fail("path traversal entry");
  const normalizedParts = parts.filter((part) => part && part !== ".");
  if (!normalizedParts.length) fail("empty entry name");
  const normalized = normalizedParts.join("/"); const entryTop = normalizedParts[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entryTop)) fail("invalid release directory name");
  if (!top) top = entryTop;
  if (entryTop !== top || (normalized !== top && !normalized.startsWith(`${top}/`))) fail("archive must contain one top-level release directory");
  if (seen.has(normalized)) fail("duplicate archive entry");
  seen.add(normalized);
  if (normalized === top) { if (type !== "d") fail("top-level release entry must be a directory"); topDirectory = true; }
}
if (!top || !topDirectory) fail("top-level release directory is missing");
NODE
}

migrate_legacy_config() {
  local old_config file_name task_file
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  for old_config in "$HOME/.config/pi-harbor" "$HOME/.config/pi-web"; do
    [[ -d "$old_config" && ! -L "$old_config" ]] || continue
    for file_name in token tokens.json onboarding.json device-trust.json updater.json update-state.json push.json push-subscriptions.json provider-cookies.json agent-tasks.json; do
      [[ -f "$old_config/$file_name" && ! -L "$old_config/$file_name" && ! -e "$CONFIG_DIR/$file_name" ]] || continue
      cp -p "$old_config/$file_name" "$CONFIG_DIR/$file_name"
      chmod 600 "$CONFIG_DIR/$file_name"
    done
    if [[ -d "$old_config/agent-tasks" && ! -L "$old_config/agent-tasks" ]]; then
      [[ ! -L "$CONFIG_DIR/agent-tasks" ]] || die "refusing a symlinked Stepsemble task-state directory"
      mkdir -p "$CONFIG_DIR/agent-tasks"
      chmod 700 "$CONFIG_DIR/agent-tasks"
      for task_file in "$old_config/agent-tasks"/*.json; do
        [[ -f "$task_file" && ! -L "$task_file" && ! -e "$CONFIG_DIR/agent-tasks/$(basename "$task_file")" ]] || continue
        cp -p "$task_file" "$CONFIG_DIR/agent-tasks/$(basename "$task_file")"
        chmod 600 "$CONFIG_DIR/agent-tasks/$(basename "$task_file")"
      done
    fi
  done
}

create_token() {
  if [[ ! -s "$TOKEN_FILE" ]]; then
    node - <<'NODE' > "$TOKEN_FILE"
const crypto=require("node:crypto"); process.stdout.write(crypto.randomBytes(32).toString("hex")+"\n");
NODE
    note "Created a new Web token"
  fi
  chmod 600 "$TOKEN_FILE"
}

configured_port() {
  node - "$HOME/.pi/agent/device.json" <<'NODE'
const fs = require("node:fs");
try {
  const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).port;
  process.stdout.write(Number.isInteger(value) && value >= 1024 && value <= 65535 ? String(value) : "3140");
} catch { process.stdout.write("3140"); }
NODE
}

active_work_state() {
  local port="$1" cookie login_payload rpcs_file tasks_file task_status result
  [[ -s "$TOKEN_FILE" ]] || return 2
  cookie="$(mktemp /tmp/stepsemble-linux-cookie.XXXXXX)"
  login_payload="$(mktemp /tmp/stepsemble-linux-login.XXXXXX)"
  rpcs_file="$(mktemp /tmp/stepsemble-linux-rpcs.XXXXXX)"
  tasks_file="$(mktemp /tmp/stepsemble-linux-tasks.XXXXXX)"
  if ! node - "$TOKEN_FILE" "$login_payload" <<'NODE'
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
    404) printf '{}\n' > "$tasks_file" ;;
    *) rm -f -- "$cookie" "$login_payload" "$rpcs_file" "$tasks_file"; return 2 ;;
  esac
  if node - "$rpcs_file" "$tasks_file" <<'NODE'
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

release_health_ok() {
  local port="$1" expected="$2" response
  response="$(curl -fsS --max-time 3 "http://127.0.0.1:$port/api/health" 2>/dev/null || true)"
  HEALTH_RESPONSE="$response" EXPECTED_VERSION="${expected#v}" node - <<'NODE'
try {
  const value = JSON.parse(process.env.HEALTH_RESPONSE || "{}");
  process.exit(value.ok === true && String(value.appVersion || "").replace(/^v/, "") === process.env.EXPECTED_VERSION ? 0 : 1);
} catch { process.exit(1); }
NODE
}

wait_for_release_health() {
  local port="$1" expected="$2" attempt
  for attempt in {1..30}; do
    release_health_ok "$port" "$expected" && return 0
    sleep 1
  done
  return 1
}

readonly LEGACY_UNITS=(
  pi-harbor.service pi-harbor-updater.service pi-harbor-updater.timer
  pi-web.service pi-web-updater.service pi-web-updater.timer
)
legacy_active_units=()
current_active_units=()
current_enabled_units=()

capture_and_stop_services() {
  local unit
  for unit in "$SERVICE_NAME" "$UPDATER_SERVICE_NAME" "$UPDATER_TIMER_NAME"; do
    if systemctl --user is-active --quiet "$unit"; then current_active_units+=("$unit"); fi
    if systemctl --user is-enabled --quiet "$unit"; then current_enabled_units+=("$unit"); fi
  done
  systemctl --user stop "$SERVICE_NAME" "$UPDATER_TIMER_NAME" "$UPDATER_SERVICE_NAME" >/dev/null 2>&1 || true
  for unit in "${LEGACY_UNITS[@]}"; do
    if systemctl --user is-active --quiet "$unit"; then legacy_active_units+=("$unit"); fi
    systemctl --user stop "$unit" >/dev/null 2>&1 || true
  done
}

restore_services_after_failure() {
  local unit
  systemctl --user stop "$SERVICE_NAME" "$UPDATER_TIMER_NAME" "$UPDATER_SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl --user disable "$SERVICE_NAME" "$UPDATER_TIMER_NAME" >/dev/null 2>&1 || true
  restore_service_files
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  for unit in "${current_enabled_units[@]}"; do systemctl --user enable "$unit" >/dev/null 2>&1 || true; done
  for unit in "${current_active_units[@]}"; do systemctl --user start "$unit" >/dev/null 2>&1 || true; done
  for unit in "${legacy_active_units[@]}"; do systemctl --user start "$unit" >/dev/null 2>&1 || true; done
}

backup_service_files() {
  local unit
  mkdir -p "$work_dir/service-backup"
  for unit in "$SERVICE_NAME" "$UPDATER_SERVICE_NAME" "$UPDATER_TIMER_NAME"; do
    [[ -e "$SERVICE_DIR/$unit" || -L "$SERVICE_DIR/$unit" ]] || continue
    cp -a "$SERVICE_DIR/$unit" "$work_dir/service-backup/$unit"
  done
  if [[ -f "$BIN_DIR/install-linux.sh" && ! -L "$BIN_DIR/install-linux.sh" ]]; then
    cp -p "$BIN_DIR/install-linux.sh" "$work_dir/install-linux.sh.previous"
  fi
}

restore_service_files() {
  local unit
  for unit in "$SERVICE_NAME" "$UPDATER_SERVICE_NAME" "$UPDATER_TIMER_NAME"; do
    rm -f -- "$SERVICE_DIR/$unit"
    [[ -e "$work_dir/service-backup/$unit" || -L "$work_dir/service-backup/$unit" ]] \
      && cp -a "$work_dir/service-backup/$unit" "$SERVICE_DIR/$unit"
  done
  if [[ -f "$work_dir/install-linux.sh.previous" ]]; then
    cp -p "$work_dir/install-linux.sh.previous" "$BIN_DIR/install-linux.sh"
  else
    rm -f -- "$BIN_DIR/install-linux.sh"
  fi
}

archive_legacy_installation() {
  local destination="$STATE_DIR/legacy-products/$(date +%Y%m%d-%H%M%S)" legacy_path unit unit_destination
  for legacy_path in "$HOME/.local/share/pi-harbor" "$HOME/.local/share/pi-web"; do
    [[ -e "$legacy_path" || -L "$legacy_path" ]] || continue
    case "$legacy_path" in
      "$HOME/.local/share/pi-harbor"|"$HOME/.local/share/pi-web") ;;
      *) die "refusing unexpected legacy path" ;;
    esac
    mkdir -p "$destination"
    mv "$legacy_path" "$destination/$(basename "$legacy_path")"
  done
  unit_destination="$STATE_DIR/legacy-systemd/$(date +%Y%m%d-%H%M%S)"
  for unit in "${LEGACY_UNITS[@]}"; do
    [[ -e "$SERVICE_DIR/$unit" || -L "$SERVICE_DIR/$unit" ]] || continue
    mkdir -p "$unit_destination"
    mv "$SERVICE_DIR/$unit" "$unit_destination/$unit"
  done
}

work_dir="$(mktemp -d /tmp/stepsemble-linux.XXXXXX)"
rollback_armed=0
release_activated=0
systemd_ready=0
stage=""
backup=""
rollback_linux_install() {
  if (( release_activated )); then
    rm -rf -- "$INSTALL_DIR"
    [[ -z "$backup" || ! -e "$backup" ]] || mv "$backup" "$INSTALL_DIR"
  fi
  if (( systemd_ready )); then restore_services_after_failure; else restore_service_files; fi
}
cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e
  (( rollback_armed == 0 )) || rollback_linux_install
  [[ -z "$work_dir" || "$work_dir" != /tmp/stepsemble-linux.* ]] || rm -rf -- "$work_dir"
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

source_root="$SOURCE_DIR"
if [[ -n "$source_root" ]]; then
  source_root="$(cd "$source_root" && pwd -P)"
  [[ -f "$source_root/server.js" && -f "$source_root/public/index.html" ]] || die "local source is not a Stepsemble checkout"
  latest_version="v$(node -p 'require(process.argv[1]).version' "$source_root/package.json")"
else
  metadata="$work_dir/release.json"
  tag="${REQUESTED_VERSION:-}"
  api_url="https://api.github.com/repos/$REPOSITORY/releases/latest"
  [[ -z "$tag" ]] || api_url="https://api.github.com/repos/$REPOSITORY/releases/tags/$tag"
  if ! curl -fsSL --max-time 180 -H 'Accept: application/vnd.github+json' "$api_url" -o "$metadata"; then
    page_url="https://github.com/$REPOSITORY/releases/latest"
    [[ -z "$tag" ]] || page_url="https://github.com/$REPOSITORY/releases/tag/$tag"
    tag="$(curl -fsSL --max-time 60 -o /dev/null -w '%{url_effective}' "$page_url" | sed 's/[?].*$//' | sed 's#.*/##')" || die "could not read GitHub release metadata"
    safe_tag "$tag" || die "GitHub did not return a release tag"
    archive_url="https://github.com/$REPOSITORY/releases/download/$tag/stepsemble-$tag.tar.gz"
    checksum_url="$archive_url.sha256"
  else
    read -r latest_version archive_url checksum_url < <(node - "$metadata" <<'NODE'
const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[2],"utf8")); const tag=r.tag_name||""; const a=r.assets||[];
const archive=a.find(x=>x.name===`stepsemble-${tag}.tar.gz`)||a.find(x=>x.name?.endsWith(".tar.gz")); const sum=a.find(x=>x.name===`${archive?.name}.sha256`)||a.find(x=>x.name?.endsWith(".tar.gz.sha256"));
process.stdout.write(`${tag} ${archive?.browser_download_url||""} ${sum?.browser_download_url||""}`);
NODE
)
  fi
  safe_tag "$latest_version" || die "release tag is invalid"
  [[ -n "${archive_url:-}" && -n "${checksum_url:-}" ]] || die "release assets are incomplete"
  installed_version=""
  if [[ -f "$INSTALL_DIR/package.json" ]]; then installed_version="v$(node -p 'require(process.argv[1]).version' "$INSTALL_DIR/package.json" 2>/dev/null || true)"; fi
  if [[ -n "$installed_version" ]] && ! release_is_newer "$installed_version" "$latest_version"; then say "Stepsemble $installed_version is already up to date"; exit 0; fi
  archive="$work_dir/stepsemble.tar.gz"; checksum="$work_dir/stepsemble.tar.gz.sha256"
  curl -fsSL --max-time 300 "$archive_url" -o "$archive" || die "release download failed"
  curl -fsSL --max-time 180 "$checksum_url" -o "$checksum" || die "checksum download failed"
  expected="$(awk 'NR==1 {print $1}' "$checksum")"; actual="$(sha256sum "$archive" | awk '{print $1}')"
  [[ "$expected" =~ ^[0-9a-fA-F]{64}$ && "${actual,,}" == "${expected,,}" ]] || die "release checksum verification failed"
  preflight_archive "$archive" || die "release archive failed safety preflight"
  extract="$work_dir/extract"; mkdir -p "$extract"; tar -xzf "$archive" -C "$extract" || die "release extraction failed"
  source_root="$(find "$extract" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [[ -n "$source_root" && -f "$source_root/server.js" ]] || die "release archive is incomplete"
fi

mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$BIN_DIR"
migrate_legacy_config
create_token
port="$(configured_port)"
if curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
  if active_work_state "$port"; then
    die "an agent is working or waiting for input; finish it before updating"
  else
    work_state=$?
    (( work_state == 1 )) || die "could not safely inspect the running service; verify its token and try again"
  fi
fi

stage="$HOME/.local/share/stepsemble.update.$$"; backup="$HOME/.local/share/stepsemble.previous"
[[ "$stage" == "$HOME/.local/share/stepsemble.update."* && "$backup" == "$HOME/.local/share/stepsemble.previous" ]] || die "unsafe update path"
mkdir -p "$stage"; cp -a "$source_root"/. "$stage"/
cp "$stage/install-linux.sh" "$work_dir/install-linux.sh.next"
chmod 700 "$work_dir/install-linux.sh.next"

node_bin="$(command -v node)"
rendered_service="$work_dir/$SERVICE_NAME"
sed "s|__NODE__|$node_bin|g" "$stage/deploy/stepsemble.service" > "$rendered_service"
if (( INSTALL_UPDATES )); then
  cp "$stage/deploy/stepsemble-updater.service" "$work_dir/$UPDATER_SERVICE_NAME"
  cp "$stage/deploy/stepsemble-updater.timer" "$work_dir/$UPDATER_TIMER_NAME"
fi
backup_service_files

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemd_ready=1
elif curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
  die "a service is running but no systemd user session is available to restart it safely"
fi

rollback_armed=1
if (( systemd_ready )); then
  capture_and_stop_services
fi
mkdir -p "$SERVICE_DIR"
[[ ! -d "$SERVICE_DIR/$SERVICE_NAME" || -L "$SERVICE_DIR/$SERVICE_NAME" ]] || die "refusing a directory at the Stepsemble service path"
rm -f -- "$SERVICE_DIR/$SERVICE_NAME"
mv "$rendered_service" "$SERVICE_DIR/$SERVICE_NAME"
if (( INSTALL_UPDATES )); then
  [[ ! -d "$SERVICE_DIR/$UPDATER_SERVICE_NAME" || -L "$SERVICE_DIR/$UPDATER_SERVICE_NAME" ]] || die "refusing a directory at the updater service path"
  [[ ! -d "$SERVICE_DIR/$UPDATER_TIMER_NAME" || -L "$SERVICE_DIR/$UPDATER_TIMER_NAME" ]] || die "refusing a directory at the updater timer path"
  rm -f -- "$SERVICE_DIR/$UPDATER_SERVICE_NAME" "$SERVICE_DIR/$UPDATER_TIMER_NAME"
  mv "$work_dir/$UPDATER_SERVICE_NAME" "$SERVICE_DIR/$UPDATER_SERVICE_NAME"
  mv "$work_dir/$UPDATER_TIMER_NAME" "$SERVICE_DIR/$UPDATER_TIMER_NAME"
fi
if (( systemd_ready )); then systemctl --user daemon-reload >/dev/null 2>&1 || die "could not reload systemd user services"; fi

if [[ -e "$backup" ]]; then rm -rf -- "$backup"; fi
if [[ -e "$INSTALL_DIR" ]]; then mv "$INSTALL_DIR" "$backup"; fi
release_activated=1
mv "$stage" "$INSTALL_DIR" || die "could not activate the release"

# Keep a stable copy for the hourly timer; release archives and local checkouts
# can both be replaced while this executable is running.
rm -f -- "$BIN_DIR/install-linux.sh"
mv "$work_dir/install-linux.sh.next" "$BIN_DIR/install-linux.sh"

if (( systemd_ready )); then
  if ! systemctl --user enable --now "$SERVICE_NAME" >/dev/null 2>&1 || ! wait_for_release_health "$port" "$latest_version"; then
    die "the service did not become healthy; the previous installation was restored"
  fi
  for unit in "${LEGACY_UNITS[@]}"; do systemctl --user disable "$unit" >/dev/null 2>&1 || true; done
  if (( INSTALL_UPDATES )); then systemctl --user enable --now "$UPDATER_TIMER_NAME" >/dev/null 2>&1 || note "could not enable the hourly update timer"; fi
  if (( ! INSTALL_UPDATES )); then systemctl --user disable --now "$UPDATER_TIMER_NAME" >/dev/null 2>&1 || true; fi
  rollback_armed=0
  archive_legacy_installation
  systemctl --user daemon-reload >/dev/null 2>&1 || true
else
  rollback_armed=0
  note "A systemd user session was not available; start Stepsemble with: $node_bin $INSTALL_DIR/server.js"
  note "Former Pi Harbor files were retained until the new service can be verified."
fi
say "Stepsemble $latest_version is installed."
note "Token: $TOKEN_FILE"
note "Service: systemctl --user status $SERVICE_NAME"
