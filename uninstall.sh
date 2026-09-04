#!/bin/zsh
# Stepsemble uninstaller. Agent sessions, credentials, and project files are
# kept unless the user separately removes them outside this script.
set -eu
setopt NO_NOMATCH
umask 077

readonly INSTALL_DIR="${STEPSEMBLE_INSTALL_DIR:-$HOME/.local/share/stepsemble}"
readonly BIN_DIR="${STEPSEMBLE_BIN_DIR:-$HOME/.local/share/stepsemble-bin}"
readonly CONFIG_DIR="${STEPSEMBLE_CONFIG_DIR:-$HOME/.config/stepsemble}"
readonly STATE_DIR="${STEPSEMBLE_STATE_DIR:-$HOME/.local/state/stepsemble}"
readonly RUNTIME_DIR="${STEPSEMBLE_RUNTIME_DIR:-$HOME/.local/share/stepsemble-runtime}"
readonly LAUNCH_DIR="$HOME/Library/LaunchAgents"
readonly SERVER_PLIST="$LAUNCH_DIR/com.stepsemble.server.plist"
readonly UPDATER_PLIST="$LAUNCH_DIR/com.stepsemble.updater.plist"

YES=0
REMOVE_PI=""

say() { print -r -- "$*"; }
die() { print -u2 -r -- "Stepsemble uninstaller: $*"; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./uninstall.sh [options]

  --keep-pi       Remove Stepsemble and keep Pi Agent
  --with-pi       Remove Stepsemble and the Pi executable
  --yes           Skip the final confirmation
  --help          Show this help

Agent sessions, provider credentials, and project folders are never deleted.
EOF
}

while (( $# )); do
  case "$1" in
    --keep-pi) REMOVE_PI=0 ;;
    --with-pi) REMOVE_PI=1 ;;
    --yes|-y) YES=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

(( EUID != 0 )) || die "run this as your normal macOS user, not with sudo"
[[ "$HOME" == /* && "$HOME" != "/" ]] || die "HOME is not a safe user directory"

if [[ -z "$REMOVE_PI" ]]; then
  if [[ ! -t 0 ]]; then
    REMOVE_PI=0
  else
    say "Remove:"
    say "  1. Stepsemble only (keep Pi Agent)"
    say "  2. Stepsemble and Pi Agent"
    read "choice?Choose 1 or 2 [1]: " || choice="1"
    case "${choice:-1}" in 2) REMOVE_PI=1 ;; *) REMOVE_PI=0 ;; esac
  fi
fi

if (( ! YES )) && [[ -t 0 ]]; then
  read "answer?Move Stepsemble to the Trash? [y/N] " || answer=""
  [[ "$answer" == [yY]* ]] || { say "Canceled."; exit 0; }
fi

plist_label() { /usr/libexec/PlistBuddy -c 'Print :Label' "$1" 2>/dev/null || true; }
stop_plist() {
  local plist="$1" label
  label="$(plist_label "$plist")"
  /bin/launchctl bootout "gui/$UID" "$plist" >/dev/null 2>&1 || true
  [[ -z "$label" ]] || /bin/launchctl bootout "gui/$UID/$label" >/dev/null 2>&1 || true
}

safe_stepsemble_path() {
  case "$1" in
    "$HOME/.local/share/stepsemble"|"$HOME/.local/share/stepsemble-bin"|"$HOME/.config/stepsemble"|"$HOME/.local/state/stepsemble"|"$HOME/.local/share/stepsemble-runtime") return 0 ;;
    *) return 1 ;;
  esac
}

trash_path() {
  local target_path="$1" trash_root="$2"
  [[ -e "$target_path" || -L "$target_path" ]] || return 0
  safe_stepsemble_path "$target_path" || die "refusing unexpected path: $target_path"
  mkdir -p "$trash_root"
  mv "$target_path" "$trash_root/${target_path:t}"
}

remove_managed_pi() {
  local marker="$HOME/.pi/agent/install/managed-install.json" entrypoint launcher parser
  [[ -f "$marker" ]] || return 1
  parser="$(command -v node 2>/dev/null || true)"
  [[ -x "$parser" ]] || parser="$RUNTIME_DIR/current/bin/node"
  [[ -x "$parser" ]] || return 1
  entrypoint="$("$parser" - "$marker" <<'NODE' 2>/dev/null || true
const fs = require("node:fs");
try {
  const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (value.kind === "pi-managed-install" && value.schemaVersion === 1 && value.layout === "releases-v1" && typeof value.entrypoint?.path === "string") process.stdout.write(value.entrypoint.path);
} catch {}
NODE
)"
  launcher="$HOME/.pi/agent/bin/pi"
  case "$entrypoint" in
    ""|"$launcher") ;;
    "$HOME/.local/bin/pi"|"$HOME/bin/pi"|"$HOME/.bin/pi"|"$HOME/local/bin/pi") rm -f -- "$entrypoint" ;;
    *) die "Pi managed-install marker contains an unexpected entry point" ;;
  esac
  rm -f -- "$launcher"
  rm -rf -- "$HOME/.pi/agent/install"
  return 0
}

remove_npm_pi() {
  local npm_bin
  npm_bin="$(command -v npm 2>/dev/null || true)"
  [[ -x "$npm_bin" ]] || npm_bin="$RUNTIME_DIR/current/bin/npm"
  [[ -x "$npm_bin" ]] || return 1
  if "$npm_bin" ls -g --depth=0 @earendil-works/pi-coding-agent >/dev/null 2>&1; then
    "$npm_bin" uninstall -g @earendil-works/pi-coding-agent
    return 0
  fi
  if "$npm_bin" ls -g --depth=0 @mariozechner/pi-coding-agent >/dev/null 2>&1; then
    "$npm_bin" uninstall -g @mariozechner/pi-coding-agent
    return 0
  fi
  return 1
}

stop_plist "$SERVER_PLIST"
stop_plist "$UPDATER_PLIST"
rm -f -- "$SERVER_PLIST" "$UPDATER_PLIST"

timestamp="$(date +%Y%m%d-%H%M%S)"
trash_root="$HOME/.Trash/Stepsemble $timestamp"
trash_path "$INSTALL_DIR" "$trash_root"
trash_path "$BIN_DIR" "$trash_root"
trash_path "$CONFIG_DIR" "$trash_root"
trash_path "$STATE_DIR" "$trash_root"

if (( REMOVE_PI )); then
  if ! remove_managed_pi && ! remove_npm_pi; then
    say "Stepsemble was removed, but the Pi installation method was not recognized. Pi was left in place."
  else
    say "Pi Agent executable removed."
  fi
fi

if [[ -f "$RUNTIME_DIR/installed-by-stepsemble" ]]; then trash_path "$RUNTIME_DIR" "$trash_root"; fi

say "Stepsemble was moved to: $trash_root"
say "Agent sessions, provider credentials, and project folders were preserved."
