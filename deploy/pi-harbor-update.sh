#!/bin/zsh
# Pi Harbor stable-release updater for macOS launchd.
#
# Release archives are downloaded from GitHub Releases and verified against a
# separately published SHA-256 file. Updates wait while a Pi RPC is streaming.
set -u
setopt NO_NOMATCH
umask 077

NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
for candidate in "$HOME/.local/share/pi-harbor-runtime/current/bin/node" \
  "$HOME/.local/bin/node" "$HOME/.volta/bin/node" \
  "/opt/homebrew/bin/node" "/usr/local/bin/node"; do
  [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] && break
  [[ -x "$candidate" ]] && NODE_BIN="$candidate"
done

readonly CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
readonly TAR_BIN="${TAR_BIN:-/usr/bin/tar}"
readonly SHASUM_BIN="${SHASUM_BIN:-/usr/bin/shasum}"
readonly LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-/bin/launchctl}"
readonly INSTALL_DIR="${PI_HARBOR_INSTALL_DIR:-$HOME/.local/share/pi-harbor}"
readonly CONFIG_DIR="${PI_HARBOR_UPDATE_CONFIG_DIR:-$HOME/.config/pi-harbor}"
readonly CONFIG_FILE="${PI_HARBOR_UPDATE_CONFIG:-$CONFIG_DIR/updater.json}"
readonly STATE_FILE="${PI_HARBOR_UPDATE_STATE:-$CONFIG_DIR/update-state.json}"
# The server passes a custom token-file path without passing the token itself.
readonly TOKEN_FILE="${PI_HARBOR_UPDATE_TOKEN_FILE:-${PI_HARBOR_TOKEN_FILE:-$CONFIG_DIR/token}}"
readonly LOCK_DIR="${PI_HARBOR_UPDATE_LOCK:-$HOME/.cache/pi-harbor-update.lock}"
readonly DEFAULT_REPOSITORY="${PI_HARBOR_UPDATE_REPO:-seehow624/pi-harbor}"
readonly DEFAULT_REF="${PI_HARBOR_UPDATE_REF:-stable}"
readonly SERVICE_LABEL="${PI_HARBOR_SERVICE_LABEL:-com.piharbor.server}"
readonly FORCE_UPDATE="${PI_HARBOR_UPDATE_FORCE:-0}"

log() { print -u2 -r -- "[pi-harbor-update] $*"; }
die() {
  log "$*"
  # State writes are best-effort: early dependency/configuration failures can
  # happen before the updater variables exist.
  if [[ -n "${enabled:-}" && -n "${installed_version:-}" ]] && (( $+functions[write_state] )); then
    write_state "$*" "${now:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" "" "$installed_version" "" "error" ""
  fi
  exit 1
}

[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "Node.js 22.19 or newer is required."
[[ -x "$CURL_BIN" && -x "$TAR_BIN" && -x "$SHASUM_BIN" ]] || die "curl, tar, and shasum are required."
[[ "$INSTALL_DIR" == "$HOME/.local/share/pi-harbor" ]] || die "refusing unexpected application path"

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
  local error_message="${1:-}" checked_at="${2:-}" latest_version="${3:-}" current_version="${4:-}" updated_at="${5:-}" phase="${6:-}" deferred_reason="${7:-}"
  mkdir -p "$CONFIG_DIR"
  PH_STATE_FILE="$STATE_FILE" PH_STATE_ENABLED="$enabled" PH_STATE_REPOSITORY="$repository" \
    PH_STATE_REF="$ref" PH_STATE_ERROR="$error_message" PH_STATE_CHECKED="$checked_at" \
    PH_STATE_LATEST="$latest_version" PH_STATE_CURRENT="$current_version" PH_STATE_UPDATED="$updated_at" \
    PH_STATE_PHASE="$phase" PH_STATE_DEFERRED_REASON="$deferred_reason" \
    "$NODE_BIN" - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const file = process.env.PH_STATE_FILE;
const previous = (() => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } })();
const value = {
  enabled: process.env.PH_STATE_ENABLED === "true",
  repository: process.env.PH_STATE_REPOSITORY,
  ref: process.env.PH_STATE_REF,
  currentSha: process.env.PH_STATE_CURRENT || previous.currentSha || "",
  latestSha: process.env.PH_STATE_LATEST || previous.latestSha || "",
  latestVersion: (process.env.PH_STATE_LATEST || previous.latestVersion || "").replace(/^v/, ""),
  lastCheckedAt: process.env.PH_STATE_CHECKED || previous.lastCheckedAt || "",
};
if (process.env.PH_STATE_UPDATED || previous.lastUpdatedAt) value.lastUpdatedAt = process.env.PH_STATE_UPDATED || previous.lastUpdatedAt;
if (process.env.PH_STATE_ERROR) value.error = process.env.PH_STATE_ERROR;
if (process.env.PH_STATE_PHASE) value.phase = process.env.PH_STATE_PHASE;
if (process.env.PH_STATE_DEFERRED_REASON) value.deferredReason = process.env.PH_STATE_DEFERRED_REASON;
else delete value.deferredReason;
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const temp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, file);
NODE
}

current_version() {
  "$NODE_BIN" - "$INSTALL_DIR/package.json" <<'NODE'
const fs = require("node:fs");
try { process.stdout.write(`v${JSON.parse(fs.readFileSync(process.argv[2], "utf8")).version}`); } catch {}
NODE
}

release_is_newer() {
  "$NODE_BIN" - "$1" "$2" <<'NODE'
function parts(value) {
  const match = String(value || "").match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-.]([A-Za-z0-9.-]+))?$/);
  return match ? { numbers: match.slice(1, 4).map(Number), pre: match[4] || "" } : null;
}
const current = parts(process.argv[2]);
const latest = parts(process.argv[3]);
if (!latest) process.exit(1);
if (!current) process.exit(0);
for (let i = 0; i < 3; i += 1) {
  if (latest.numbers[i] > current.numbers[i]) process.exit(0);
  if (latest.numbers[i] < current.numbers[i]) process.exit(1);
}
if (!latest.pre && current.pre) process.exit(0);
process.exit(1);
NODE
}

release_field() {
  local metadata="$1" field="$2"
  "$NODE_BIN" - "$metadata" "$field" <<'NODE'
const fs = require("node:fs");
const release = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const field = process.argv[3];
if (field === "tag") process.stdout.write(String(release.tag_name || ""));
else {
  const exact = `pi-harbor-${release.tag_name}.tar.gz${field === "checksum" ? ".sha256" : ""}`;
  const suffix = field === "archive" ? ".tar.gz" : ".sha256";
  const asset = release.assets?.find((item) => item.name === exact)
    || release.assets?.find((item) => item.name.endsWith(suffix));
  if (asset?.browser_download_url) process.stdout.write(asset.browser_download_url);
}
NODE
}

# GitHub's unauthenticated REST API is limited per public IP.  A shared home
# network can exhaust that quota even when the release itself is available.
# Fall back to the public release page, which redirects to the selected tag,
# then construct the two predictable, checksum-verified asset URLs.
write_page_release_metadata() {
  local metadata="$1" tag="$2"
  "$NODE_BIN" - "$metadata" "$tag" "$repository" <<'NODE'
const fs = require("node:fs");
const [file, tag, repository] = process.argv.slice(2);
const archive = `pi-harbor-${tag}.tar.gz`;
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
  local metadata="$1" api_url page_url final_url tag
  api_url="https://api.github.com/repos/$repository/releases/latest"
  [[ "$ref" == "stable" ]] || api_url="https://api.github.com/repos/$repository/releases/tags/$ref"
  if "$CURL_BIN" -fsSL --max-time 180 -H 'Accept: application/vnd.github+json' "$api_url" -o "$metadata"; then
    return 0
  fi
  page_url="https://github.com/$repository/releases/latest"
  [[ "$ref" == "stable" ]] || page_url="https://github.com/$repository/releases/tag/$ref"
  final_url="$($CURL_BIN -fsSL --max-time 60 -o /dev/null -w '%{url_effective}' "$page_url" 2>/dev/null)" || return 1
  final_url="${final_url%%\?*}"
  tag="${final_url##*/}"
  [[ "$tag" =~ '^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$' ]] || return 1
  write_page_release_metadata "$metadata" "$tag"
}

# Validate the complete archive before tar is allowed to create a filesystem
# tree.  macOS /usr/bin/tar and GNU tar both provide the portable -t/-v
# listings used here; Node only performs bounded, type-aware validation.
preflight_archive() {
  local archive="$1" listing verbose temp_dir
  [[ -n "$archive" && -f "$archive" ]] || return 1
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-harbor-archive-check.XXXXXX")" || return 1
  listing="$temp_dir/listing"
  verbose="$temp_dir/verbose"
  if ! "$TAR_BIN" -tzf "$archive" > "$listing" 2> /dev/null \
    || ! "$TAR_BIN" -tvzf "$archive" > "$verbose" 2> /dev/null; then
    /bin/rm -rf -- "$temp_dir"
    return 1
  fi
  if ! "$NODE_BIN" - "$listing" "$verbose" <<'NODE'
const fs = require("node:fs");
const names = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(Boolean);
const verbose = fs.readFileSync(process.argv[3], "utf8").split(/\r?\n/).filter(Boolean);
const fail = (message) => { console.error(`[pi-harbor-update] archive rejected: ${message}`); process.exit(1); };
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

# A no-network, no-extraction hook keeps archive validation independently
# testable and is useful to maintainers reviewing a release artifact.
if [[ -n "${PI_HARBOR_UPDATE_PREFLIGHT_ARCHIVE:-}" ]]; then
  preflight_archive "$PI_HARBOR_UPDATE_PREFLIGHT_ARCHIVE" || exit 1
  exit 0
fi

active_rpc_running() {
  [[ -s "$TOKEN_FILE" ]] || return 1
  local cookie response token port
  port="$("$NODE_BIN" - "$HOME/.pi/agent/device.json" <<'NODE'
const fs = require("node:fs");
try { const port = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).port; process.stdout.write(Number.isInteger(port) ? String(port) : "3140"); } catch { process.stdout.write("3140"); }
NODE
)"
  cookie="$(mktemp "${TMPDIR:-/tmp}/pi-harbor-updater-cookie.XXXXXX")"
  token="$(tr -d '\n' < "$TOKEN_FILE")"
  local token_json
  token_json="$("$NODE_BIN" - "$token" <<'NODE'
process.stdout.write(JSON.stringify(process.argv[2]));
NODE
)"
  if ! "$CURL_BIN" -fsS --max-time 3 -c "$cookie" -H 'Content-Type: application/json' \
    --data-binary "{\"token\":$token_json}" "http://127.0.0.1:$port/api/login" >/dev/null 2>&1; then
    /bin/rm -f -- "$cookie"
    return 1
  fi
  response="$("$CURL_BIN" -fsS --max-time 3 -b "$cookie" "http://127.0.0.1:$port/api/rpcs" 2>/dev/null || true)"
  /bin/rm -f -- "$cookie"
  RPC_RESPONSE="$response" "$NODE_BIN" - <<'NODE'
try { const value = JSON.parse(process.env.RPC_RESPONSE || "{}"); process.exit(value.rpcs?.some((rpc) => rpc.isStreaming === true && rpc.stuck !== true) ? 0 : 1); } catch { process.exit(1); }
NODE
}

# Probe the public health endpoint after launchd has activated a release. This
# is intentionally independent of the authenticated API so a broken app can be
# detected even when the token path changed during an update.
release_health_ok() {
  local expected="$1" response
  response="$($CURL_BIN -fsS --max-time 3 "http://127.0.0.1:$UPDATE_PORT/api/health" 2>/dev/null || true)"
  EXPECTED_VERSION="${expected#v}" HEALTH_RESPONSE="$response" "$NODE_BIN" - <<'NODE'
try {
  const value = JSON.parse(process.env.HEALTH_RESPONSE || "{}");
  process.exit(value.ok === true && String(value.appVersion || "").replace(/^v/, "") === process.env.EXPECTED_VERSION ? 0 : 1);
} catch { process.exit(1); }
NODE
}

wait_for_release_health() {
  local expected="$1" attempt
  for attempt in {1..30}; do
    release_health_ok "$expected" && return 0
    /bin/sleep 1
  done
  return 1
}

enabled="$(json_value "$CONFIG_FILE" enabled)"
repository="$(json_value "$CONFIG_FILE" repository)"
ref="$(json_value "$CONFIG_FILE" ref)"
[[ "$enabled" == "true" ]] || enabled="false"
[[ -n "$repository" ]] || repository="$DEFAULT_REPOSITORY"
[[ -n "$ref" ]] || ref="$DEFAULT_REF"
[[ "$repository" =~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' ]] || die "invalid GitHub repository"
[[ "$ref" == "stable" || "$ref" =~ '^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$' ]] || die "updates require the stable channel or an exact release tag"

UPDATE_PORT="$("$NODE_BIN" - "$HOME/.pi/agent/device.json" <<'NODE'
const fs = require("node:fs");
try { const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); process.stdout.write(Number.isInteger(value.port) ? String(value.port) : "3140"); }
catch { process.stdout.write("3140"); }
NODE
)"
[[ "$UPDATE_PORT" =~ '^[0-9]{2,5}$' ]] || UPDATE_PORT=3140

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
installed_version="$(current_version)"
if [[ "$enabled" != "true" && "$FORCE_UPDATE" != "1" ]]; then
  write_state "" "$now" "$installed_version" "$installed_version" "" "disabled" ""
  exit 0
fi

if ! mkdir -p "${LOCK_DIR:h}" 2>/dev/null || ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "another update check is already running"
  exit 0
fi
# Mark the check explicitly so the status endpoint never presents a stale
# deferred phase while GitHub metadata or a verified archive is being fetched.
write_state "" "$now" "" "$installed_version" "" "checking" ""
work_dir=""
stage_dir=""
cleanup_all() {
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
  [[ -z "$work_dir" || "$work_dir" != "${TMPDIR:-/tmp}/pi-harbor-update."* ]] || /bin/rm -rf -- "$work_dir"
  [[ -z "$stage_dir" || "$stage_dir" != "$HOME/.local/share/pi-harbor.update."* ]] || /bin/rm -rf -- "$stage_dir"
}
trap cleanup_all EXIT

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-harbor-update.XXXXXX")"
metadata="$work_dir/release.json"
if ! fetch_release_metadata "$metadata"; then
  write_state "Could not read the latest GitHub release" "$now" "" "$installed_version" "" "error" ""
  die "could not read release metadata"
fi

latest_version="$(release_field "$metadata" tag)"
archive_url="$(release_field "$metadata" archive)"
checksum_url="$(release_field "$metadata" checksum)"
if [[ ! "$latest_version" =~ '^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$' || -z "$archive_url" || -z "$checksum_url" ]]; then
  write_state "The release is missing a verified archive" "$now" "$latest_version" "$installed_version" "" "error" ""
  die "release assets are incomplete"
fi

if ! release_is_newer "$installed_version" "$latest_version"; then
  write_state "" "$now" "$installed_version" "$installed_version" "" "up_to_date" ""
  exit 0
fi

if active_rpc_running; then
  write_state "" "$now" "$latest_version" "$installed_version" "" "deferred" "active_rpc_running"
  log "$latest_version is available; update deferred until the current Pi work finishes"
  exit 0
fi

archive="$work_dir/pi-harbor.tar.gz"
checksum="$work_dir/pi-harbor.tar.gz.sha256"
"$CURL_BIN" -fsSL --max-time 300 "$archive_url" -o "$archive" || die "release download failed"
"$CURL_BIN" -fsSL --max-time 180 "$checksum_url" -o "$checksum" || die "checksum download failed"
expected="$(awk 'NR == 1 { print $1 }' "$checksum")"
actual="$("$SHASUM_BIN" -a 256 "$archive" | awk '{ print $1 }')"
[[ "$expected" =~ '^[0-9a-f]{64}$' && "$actual" == "$expected" ]] || die "release checksum verification failed"

extract_dir="$work_dir/source"
preflight_archive "$archive" || die "release archive failed safety preflight"
mkdir -p "$extract_dir"
"$TAR_BIN" -xzf "$archive" -C "$extract_dir" || die "release extraction failed"
source_dir="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -n "$source_dir" && -f "$source_dir/server.js" && -f "$source_dir/public/index.html" ]] || die "release archive is incomplete"

stage_dir="$INSTALL_DIR.update.$$"
backup_dir="$INSTALL_DIR.previous"
[[ "$stage_dir" == "$HOME/.local/share/pi-harbor.update."* && "$backup_dir" == "$HOME/.local/share/pi-harbor.previous" ]] || die "unsafe update path"
mkdir -p "$stage_dir"
cp -a "$source_dir"/. "$stage_dir"/
# This is the final safety gate immediately before replacing the live install.
# The server-side hook also schedules this check only after all RPCs settle.
if active_rpc_running; then
  write_state "" "$now" "$latest_version" "$installed_version" "" "deferred" "active_rpc_running"
  log "$latest_version is available; update deferred until the current Pi work finishes"
  exit 0
fi
[[ ! -e "$backup_dir" ]] || rm -rf -- "$backup_dir"
[[ ! -e "$INSTALL_DIR" ]] || mv "$INSTALL_DIR" "$backup_dir"
if ! mv "$stage_dir" "$INSTALL_DIR"; then
  [[ ! -e "$backup_dir" ]] || mv "$backup_dir" "$INSTALL_DIR"
  die "could not activate the release"
fi

updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_state "" "$now" "$latest_version" "$latest_version" "$updated_at" "updated" ""
"$LAUNCHCTL_BIN" kickstart -k "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 || log "release installed; launchd restart was not available"
write_state "" "$now" "$latest_version" "$latest_version" "$updated_at" "health_check" ""
if ! wait_for_release_health "$latest_version"; then
  log "the new release did not pass its health check; rolling back"
  write_state "The new release did not become healthy and was rolled back" "$now" "$latest_version" "$installed_version" "$updated_at" "rollback" "health_check_failed"
  if [[ -e "$INSTALL_DIR" ]]; then rm -rf -- "$INSTALL_DIR"; fi
  if [[ -e "$backup_dir" ]]; then mv "$backup_dir" "$INSTALL_DIR"; else die "rollback was requested but the previous release is missing"; fi
  "$LAUNCHCTL_BIN" kickstart -k "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 || true
  wait_for_release_health "$installed_version" || log "rollback installed but the previous release is not healthy yet"
  die "release health check failed; previous release restored"
fi
log "updated Pi Harbor to $latest_version"
