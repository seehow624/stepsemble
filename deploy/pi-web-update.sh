#!/bin/zsh
# Pi Harbor updater for macOS launchd.
#
# The updater lives outside the application directory so it can replace the
# application atomically. It downloads only the public GitHub repository and
# never touches ~/.pi, the Web token, or the user's project files.
set -u

umask 077

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  for candidate in "$HOME/.local/bin/node" "$HOME/.volta/bin/node" \
    "/opt/homebrew/bin/node" "/usr/local/bin/node" "/usr/bin/node"; do
    if [[ -x "$candidate" ]]; then NODE_BIN="$candidate"; break; fi
  done
fi
CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
GIT_BIN="${GIT_BIN:-/usr/bin/git}"
TAR_BIN="${TAR_BIN:-/usr/bin/tar}"
MKDIR_BIN="${MKDIR_BIN:-/bin/mkdir}"
MK_TEMP_BIN="${MK_TEMP_BIN:-/usr/bin/mktemp}"
MV_BIN="${MV_BIN:-/bin/mv}"
CP_BIN="${CP_BIN:-/bin/cp}"
RM_BIN="${RM_BIN:-/bin/rm}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-/bin/launchctl}"

PI_WEB_HOME="${PI_WEB_INSTALL_DIR:-$HOME/.local/share/pi-web}"
CONFIG_DIR="${PI_WEB_UPDATE_CONFIG_DIR:-$HOME/.config/pi-web}"
CONFIG_FILE="${PI_WEB_UPDATE_CONFIG:-$CONFIG_DIR/updater.json}"
STATE_FILE="${PI_WEB_UPDATE_STATE:-$CONFIG_DIR/update-state.json}"
LOCK_DIR="${PI_WEB_UPDATE_LOCK:-$HOME/.cache/pi-web-update.lock}"
DEFAULT_REPOSITORY="${PI_WEB_UPDATE_REPO:-seehow624/pi-harbor}"
DEFAULT_REF="${PI_WEB_UPDATE_REF:-master}"
SERVICE_LABEL="${PI_WEB_SERVICE_LABEL:-com.piweb.server}"
FORCE_UPDATE="${PI_WEB_UPDATE_FORCE:-0}"

log() { print -u2 -- "[pi-web-update] $*"; }

ensure_service_running() {
  [[ -x "$LAUNCHCTL_BIN" && -n "$SERVICE_LABEL" ]] || return 0
  local target="gui/$(id -u)/$SERVICE_LABEL"
  if ! "$LAUNCHCTL_BIN" print "$target" 2>/dev/null | /usr/bin/grep -q 'state = running'; then
    "$LAUNCHCTL_BIN" kickstart "$target" >/dev/null 2>&1 || log "application is current; launchd start was not available"
  fi
}

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  log "Node.js is required to read updater settings. Set NODE_BIN or install Node 20+."
  exit 1
fi
if [[ ! -x "$CURL_BIN" || ! -x "$GIT_BIN" || ! -x "$TAR_BIN" ]]; then
  log "curl, git, and tar are required."
  exit 1
fi

json_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  "$NODE_BIN" - "$file" "$key" <<'NODE'
const fs = require("node:fs");
try {
  const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const result = value?.[process.argv[3]];
  if (typeof result === "boolean") process.stdout.write(result ? "true" : "false");
  else if (result !== undefined && result !== null) process.stdout.write(String(result));
} catch {}
NODE
}

write_state() {
  local state_json="$1"
  "$MKDIR_BIN" -p "$CONFIG_DIR"
  STATE_JSON="$state_json" STATE_FILE="$STATE_FILE" "$NODE_BIN" - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
try {
  const file = process.env.STATE_FILE;
  const value = JSON.parse(process.env.STATE_JSON || "{}");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
} catch (error) {
  process.stderr.write(`could not write updater state: ${error.message}\n`);
  process.exitCode = 1;
}
NODE
}

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
enabled="$(json_value "$CONFIG_FILE" enabled)"
repository="$(json_value "$CONFIG_FILE" repository)"
ref="$(json_value "$CONFIG_FILE" ref)"
[[ "$enabled" == "true" ]] || enabled="false"
[[ -n "$repository" ]] || repository="$DEFAULT_REPOSITORY"
[[ -n "$ref" ]] || ref="$DEFAULT_REF"

if [[ ! "$repository" =~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' ]]; then
  state_json="$(STATE_ENABLED=false STATE_REPOSITORY="$repository" STATE_REF="$ref" STATE_CHECKED="$now" STATE_ERROR="Invalid GitHub repository name" "$NODE_BIN" - <<'NODE'
process.stdout.write(JSON.stringify({ enabled: false, repository: process.env.STATE_REPOSITORY, ref: process.env.STATE_REF, lastCheckedAt: process.env.STATE_CHECKED, error: process.env.STATE_ERROR }));
NODE
  )"
  write_state "$state_json"
  log "invalid GitHub repository: $repository"
  exit 1
fi
if [[ ! "$ref" =~ '^[A-Za-z0-9._/-]{1,100}$' || "$ref" == /* || "$ref" == */ || "$ref" == *..* ]]; then
  state_json="$(STATE_ENABLED=false STATE_REPOSITORY="$repository" STATE_REF="$ref" STATE_CHECKED="$now" STATE_ERROR="Invalid GitHub branch or tag" "$NODE_BIN" - <<'NODE'
process.stdout.write(JSON.stringify({ enabled: false, repository: process.env.STATE_REPOSITORY, ref: process.env.STATE_REF, lastCheckedAt: process.env.STATE_CHECKED, error: process.env.STATE_ERROR }));
NODE
  )"
  write_state "$state_json"
  log "invalid GitHub ref: $ref"
  exit 1
fi

if [[ "$enabled" != "true" && "$FORCE_UPDATE" != "1" ]]; then
  write_state "$(STATE_ENABLED="$enabled" STATE_REPOSITORY="$repository" STATE_REF="$ref" STATE_CHECKED="$now" "$NODE_BIN" - <<'NODE'
const value = { enabled: process.env.STATE_ENABLED === "true", repository: process.env.STATE_REPOSITORY, ref: process.env.STATE_REF, lastCheckedAt: process.env.STATE_CHECKED };
process.stdout.write(JSON.stringify(value));
NODE
  )"
  exit 0
fi

if ! "$MKDIR_BIN" -p "${LOCK_DIR:h}" 2>/dev/null || ! "$MKDIR_BIN" "$LOCK_DIR" 2>/dev/null; then
  log "another update check is already running"
  exit 0
fi
cleanup_lock() { "$RM_BIN" -rf -- "$LOCK_DIR"; }
trap cleanup_lock EXIT

latest_sha="$("$GIT_BIN" ls-remote "https://github.com/$repository.git" "refs/heads/$ref" 2>/dev/null | /usr/bin/awk 'NR == 1 { print $1 }')"
if [[ -z "$latest_sha" ]]; then
  latest_sha="$("$GIT_BIN" ls-remote "https://github.com/$repository.git" "refs/tags/$ref" 2>/dev/null | /usr/bin/awk 'NR == 1 { print $1 }')"
fi
if [[ ! "$latest_sha" =~ '^[0-9a-f]{40}$' ]]; then
  state_json="$(STATE_ENABLED="$enabled" STATE_REPOSITORY="$repository" STATE_REF="$ref" STATE_CHECKED="$now" STATE_ERROR="Could not read the latest GitHub revision" "$NODE_BIN" - <<'NODE'
process.stdout.write(JSON.stringify({ enabled: process.env.STATE_ENABLED === "true", repository: process.env.STATE_REPOSITORY, ref: process.env.STATE_REF, lastCheckedAt: process.env.STATE_CHECKED, error: process.env.STATE_ERROR }));
NODE
  )"
  write_state "$state_json"
  log "could not read latest revision from GitHub"
  exit 1
fi

current_sha="$(json_value "$STATE_FILE" currentSha)"
if [[ "$current_sha" == "$latest_sha" ]]; then
  current_version="$(json_value "$STATE_FILE" latestVersion)"
  last_updated="$(json_value "$STATE_FILE" lastUpdatedAt)"
  state_json="$(STATE_ENABLED="$enabled" STATE_REPOSITORY="$repository" STATE_REF="$ref" STATE_CHECKED="$now" STATE_UPDATED="$last_updated" STATE_VERSION="$current_version" STATE_SHA="$latest_sha" "$NODE_BIN" - <<'NODE'
const value = { enabled: process.env.STATE_ENABLED === "true", repository: process.env.STATE_REPOSITORY, ref: process.env.STATE_REF, currentSha: process.env.STATE_SHA, latestSha: process.env.STATE_SHA, lastCheckedAt: process.env.STATE_CHECKED };
if (process.env.STATE_VERSION) value.latestVersion = process.env.STATE_VERSION;
if (process.env.STATE_UPDATED) value.lastUpdatedAt = process.env.STATE_UPDATED;
process.stdout.write(JSON.stringify(value));
NODE
  )"
  write_state "$state_json"
  ensure_service_running
  exit 0
fi

tmp_root="$("$MK_TEMP_BIN" -d "${TMPDIR:-/tmp}/pi-web-update.XXXXXX")"
stage_dir="${PI_WEB_HOME}.update.$$"
backup_dir="${PI_WEB_HOME}.previous"
cleanup_temp() {
  "$RM_BIN" -rf -- "$tmp_root" "$stage_dir"
}
trap 'cleanup_temp; cleanup_lock' EXIT

archive="$tmp_root/pi-web.tar.gz"
extract_dir="$tmp_root/source"
"$MKDIR_BIN" -p "$extract_dir"
if ! "$CURL_BIN" -fsSL --max-time 180 "https://codeload.github.com/$repository/tar.gz/$latest_sha" -o "$archive"; then
  log "download failed"
  exit 1
fi
if ! "$TAR_BIN" -xzf "$archive" -C "$extract_dir"; then
  log "archive extraction failed"
  exit 1
fi
source_dir="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d -print -quit)"
if [[ -z "$source_dir" || ! -f "$source_dir/server.js" || ! -f "$source_dir/public/index.html" || ! -f "$source_dir/package.json" ]]; then
  log "downloaded repository does not look like a Pi Harbor release"
  exit 1
fi

version="$("$NODE_BIN" - "$source_dir/package.json" <<'NODE'
try { process.stdout.write(String(require(process.argv[2]).version || "")); } catch {}
NODE
)"
[[ -n "$version" ]] || version="unknown"
"$MKDIR_BIN" -p "$stage_dir"
"$CP_BIN" -a "$source_dir"/. "$stage_dir"/

if [[ -e "$PI_WEB_HOME" && ! -d "$PI_WEB_HOME" ]]; then
  log "install path is not a directory: $PI_WEB_HOME"
  exit 1
fi
if [[ -e "$backup_dir" ]]; then "$RM_BIN" -rf -- "$backup_dir"; fi
if [[ -e "$PI_WEB_HOME" ]]; then "$MV_BIN" "$PI_WEB_HOME" "$backup_dir"; fi
if ! "$MV_BIN" "$stage_dir" "$PI_WEB_HOME"; then
  [[ -e "$backup_dir" ]] && "$MV_BIN" "$backup_dir" "$PI_WEB_HOME"
  log "could not activate downloaded release"
  exit 1
fi

updated_at="$now"
state_json="$(STATE_ENABLED="$enabled" STATE_REPOSITORY="$repository" STATE_REF="$ref" STATE_CHECKED="$now" STATE_UPDATED="$updated_at" STATE_VERSION="$version" STATE_SHA="$latest_sha" "$NODE_BIN" - <<'NODE'
process.stdout.write(JSON.stringify({ enabled: process.env.STATE_ENABLED === "true", repository: process.env.STATE_REPOSITORY, ref: process.env.STATE_REF, currentSha: process.env.STATE_SHA, latestSha: process.env.STATE_SHA, latestVersion: process.env.STATE_VERSION, lastCheckedAt: process.env.STATE_CHECKED, lastUpdatedAt: process.env.STATE_UPDATED }));
NODE
  )"
write_state "$state_json"

if [[ -x "$LAUNCHCTL_BIN" && -n "$SERVICE_LABEL" ]]; then
  "$LAUNCHCTL_BIN" kickstart -k "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 || log "release installed; launchd restart was not available"
fi
log "updated Pi Harbor to $version ($latest_sha)"
