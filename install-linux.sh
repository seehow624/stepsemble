#!/usr/bin/env bash
# Pi Harbor one-click installer for Linux.
#
# The Linux service is a user-level systemd unit. Node.js 22.19+ is required;
# keeping the runtime managed by the distribution (or fnm/volta) avoids a
# privileged installer and lets the user choose how Node is patched.
set -euo pipefail
umask 077

readonly REPOSITORY="${PI_HARBOR_REPOSITORY:-seehow624/pi-harbor}"
readonly INSTALL_DIR="${PI_HARBOR_INSTALL_DIR:-$HOME/.local/share/pi-harbor}"
readonly BIN_DIR="${PI_HARBOR_BIN_DIR:-$HOME/.local/share/pi-harbor-bin}"
readonly CONFIG_DIR="${PI_HARBOR_CONFIG_DIR:-$HOME/.config/pi-harbor}"
readonly TOKEN_FILE="${PI_HARBOR_TOKEN_FILE:-$CONFIG_DIR/token}"
readonly STATE_DIR="${PI_HARBOR_STATE_DIR:-$HOME/.local/state/pi-harbor}"
readonly SERVICE_DIR="$HOME/.config/systemd/user"
readonly SERVICE_NAME="pi-harbor.service"
readonly UPDATER_SERVICE_NAME="pi-harbor-updater.service"
readonly UPDATER_TIMER_NAME="pi-harbor-updater.timer"

REQUESTED_VERSION="${PI_HARBOR_VERSION:-}"
YES=0
INSTALL_UPDATES=1
SOURCE_DIR="${PI_HARBOR_SOURCE_DIR:-}"

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf 'Pi Harbor installer: %s\n' "$*" >&2; exit 1; }

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
[[ "$INSTALL_DIR" == "$HOME/.local/share/pi-harbor" ]] || die "refusing unexpected application path"
[[ "$BIN_DIR" == "$HOME/.local/share/pi-harbor-bin" ]] || die "refusing unexpected binary path"
[[ "$CONFIG_DIR" == "$HOME/.config/pi-harbor" ]] || die "refusing unexpected config path"
[[ "$TOKEN_FILE" == "$CONFIG_DIR/token" ]] || die "use PI_HARBOR_CONFIG_DIR instead of a custom token path"
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
const fail = (message) => { console.error(`Pi Harbor installer: archive rejected: ${message}`); process.exit(1); };
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

work_dir=""
cleanup() { [[ -z "$work_dir" || "$work_dir" != /tmp/pi-harbor-linux.* ]] || rm -rf -- "$work_dir"; }
trap cleanup EXIT

source_root="$SOURCE_DIR"
if [[ -n "$source_root" ]]; then
  source_root="$(cd "$source_root" && pwd -P)"
  [[ -f "$source_root/server.js" && -f "$source_root/public/index.html" ]] || die "local source is not a Pi Harbor checkout"
  latest_version="v$(node -p 'require(process.argv[1]).version' "$source_root/package.json")"
else
  work_dir="$(mktemp -d /tmp/pi-harbor-linux.XXXXXX)"
  metadata="$work_dir/release.json"
  tag="${REQUESTED_VERSION:-}"
  api_url="https://api.github.com/repos/$REPOSITORY/releases/latest"
  [[ -z "$tag" ]] || api_url="https://api.github.com/repos/$REPOSITORY/releases/tags/$tag"
  if ! curl -fsSL --max-time 180 -H 'Accept: application/vnd.github+json' "$api_url" -o "$metadata"; then
    page_url="https://github.com/$REPOSITORY/releases/latest"
    [[ -z "$tag" ]] || page_url="https://github.com/$REPOSITORY/releases/tag/$tag"
    tag="$(curl -fsSL --max-time 60 -o /dev/null -w '%{url_effective}' "$page_url" | sed 's/[?].*$//' | sed 's#.*/##')" || die "could not read GitHub release metadata"
    safe_tag "$tag" || die "GitHub did not return a release tag"
    archive_url="https://github.com/$REPOSITORY/releases/download/$tag/pi-harbor-$tag.tar.gz"
    checksum_url="$archive_url.sha256"
  else
    read -r latest_version archive_url checksum_url < <(node - "$metadata" <<'NODE'
const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[2],"utf8")); const tag=r.tag_name||""; const a=r.assets||[];
const archive=a.find(x=>x.name===`pi-harbor-${tag}.tar.gz`)||a.find(x=>x.name?.endsWith(".tar.gz")); const sum=a.find(x=>x.name===`${archive?.name}.sha256`)||a.find(x=>x.name?.endsWith(".tar.gz.sha256"));
process.stdout.write(`${tag} ${archive?.browser_download_url||""} ${sum?.browser_download_url||""}`);
NODE
)
  fi
  safe_tag "$latest_version" || die "release tag is invalid"
  [[ -n "${archive_url:-}" && -n "${checksum_url:-}" ]] || die "release assets are incomplete"
  installed_version=""
  if [[ -f "$INSTALL_DIR/package.json" ]]; then installed_version="v$(node -p 'require(process.argv[1]).version' "$INSTALL_DIR/package.json" 2>/dev/null || true)"; fi
  if [[ -n "$installed_version" ]] && ! release_is_newer "$installed_version" "$latest_version"; then say "Pi Harbor $installed_version is already up to date"; exit 0; fi
  archive="$work_dir/pi-harbor.tar.gz"; checksum="$work_dir/pi-harbor.tar.gz.sha256"
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
stage="$HOME/.local/share/pi-harbor.update.$$"; backup="$HOME/.local/share/pi-harbor.previous"
[[ "$stage" == "$HOME/.local/share/pi-harbor.update."* && "$backup" == "$HOME/.local/share/pi-harbor.previous" ]] || die "unsafe update path"
mkdir -p "$stage"; cp -a "$source_root"/. "$stage"/
if [[ -e "$backup" ]]; then rm -rf -- "$backup"; fi
if [[ -e "$INSTALL_DIR" ]]; then mv "$INSTALL_DIR" "$backup"; fi
if ! mv "$stage" "$INSTALL_DIR"; then [[ -e "$backup" ]] && mv "$backup" "$INSTALL_DIR"; die "could not activate the release"; fi

if [[ ! -s "$TOKEN_FILE" ]]; then node - <<'NODE' > "$TOKEN_FILE"
const crypto=require("node:crypto"); process.stdout.write(crypto.randomBytes(32).toString("hex")+"\n");
NODE
  note "Created a new Web token"
fi
chmod 600 "$TOKEN_FILE"

# Keep a stable copy for the hourly timer; release archives and local checkouts
# can both be replaced while this executable is running.
cp "$INSTALL_DIR/install-linux.sh" "$BIN_DIR/install-linux.sh"
chmod 700 "$BIN_DIR/install-linux.sh"

node_bin="$(command -v node)"
service_tmp="$SERVICE_DIR/$SERVICE_NAME.$$"
mkdir -p "$SERVICE_DIR"
sed "s|__NODE__|$node_bin|g" "$INSTALL_DIR/deploy/pi-harbor.service" > "$service_tmp"
mv "$service_tmp" "$SERVICE_DIR/$SERVICE_NAME"
if (( INSTALL_UPDATES )); then
  cp "$INSTALL_DIR/deploy/pi-harbor-updater.service" "$SERVICE_DIR/$UPDATER_SERVICE_NAME"
  cp "$INSTALL_DIR/deploy/pi-harbor-updater.timer" "$SERVICE_DIR/$UPDATER_TIMER_NAME"
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
  systemctl --user enable --now "$SERVICE_NAME" || note "systemd user session is unavailable; run: systemctl --user enable --now $SERVICE_NAME"
  if (( INSTALL_UPDATES )); then systemctl --user enable --now "$UPDATER_TIMER_NAME" || note "could not enable the hourly update timer"; fi
  if (( ! INSTALL_UPDATES )); then systemctl --user disable --now "$UPDATER_TIMER_NAME" >/dev/null 2>&1 || true; fi
else
  note "systemctl was not found; start Pi Harbor with: $node_bin $INSTALL_DIR/server.js"
fi
say "Pi Harbor $latest_version is installed."
note "Token: $TOKEN_FILE"
note "Service: systemctl --user status $SERVICE_NAME"
