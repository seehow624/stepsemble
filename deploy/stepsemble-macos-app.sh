#!/bin/zsh
# Stepsemble app for macOS: signs Stepsemble.app for this Mac, installs it in
# ~/Applications, and lets the Host's LaunchAgent start the Host through it.
#
# macOS remembers folder access (Documents, Desktop, Downloads, iCloud Drive,
# other drives) for an app's signing identity. Each Mac signs its copy with a
# certificate made here once and kept, so access granted to Stepsemble
# survives Stepsemble and Node.js updates. The certificate signs only this app
# and never leaves this Mac. install.sh and the updater call this script.
#
# Usage:
#   stepsemble-macos-app.sh install <Stepsemble.app>  sign a copy for this Mac and install it
#   stepsemble-macos-app.sh restore                   put back the app that install replaced
#   stepsemble-macos-app.sh check [version]           succeed when the installed app is signed
#                                                     by this Mac (and has that version)
#   stepsemble-macos-app.sh launch-mode <plist>       print app, node, or other
#   stepsemble-macos-app.sh use-app <plist>           start the Host through the installed app
#   stepsemble-macos-app.sh use-node <plist>          start the Host directly again
set -eu
setopt NO_NOMATCH PIPE_FAIL
umask 077

readonly BUNDLE_ID="com.stepsemble.app"
readonly APP_PATH="${STEPSEMBLE_APP_PATH:-$HOME/Applications/Stepsemble.app}"
readonly SUPPORT_DIR="${STEPSEMBLE_APP_SUPPORT_DIR:-$HOME/Library/Application Support/Stepsemble}"
readonly SIGNING_DIR="$SUPPORT_DIR/signing"
readonly PREVIOUS_APP="$SUPPORT_DIR/previous/Stepsemble.app"
readonly APP_EXECUTABLE="$APP_PATH/Contents/MacOS/Stepsemble"
readonly LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

die() { print -u2 -r -- "stepsemble-macos-app: $*"; exit 1; }

[[ "$(/usr/bin/uname -s)" == "Darwin" ]] || die "Stepsemble.app is for macOS"
[[ "$HOME" == /* && "$HOME" != "/" ]] || die "HOME is not a safe user directory"
[[ "$APP_PATH" == /*/Stepsemble.app && "$APP_PATH" != *$'\n'* ]] || die "unexpected app path: $APP_PATH"
[[ "$SUPPORT_DIR" == /*/Stepsemble && "$SUPPORT_DIR" != *$'\n'* ]] || die "unexpected support path: $SUPPORT_DIR"

plist_value() { /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null || true; }

# Runs a command, stopping it after a number of seconds. codesign could
# otherwise wait forever on a keychain question nobody is there to answer. It
# polls rather than leaving a timer process behind, which would hold the
# caller's output open (install.sh reads this script's output).
bounded() {
  local seconds="$1" pid result=0 tenths=0
  shift
  "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if (( tenths >= seconds * 10 )); then
      kill -TERM "$pid" 2>/dev/null
      break
    fi
    /bin/sleep 0.1
    (( tenths += 1 ))
  done
  wait "$pid" || result=$?
  return "$result"
}

certificate_hash() {
  /usr/bin/openssl x509 -noout -fingerprint -sha1 -in "$SIGNING_DIR/certificate.pem" | /usr/bin/cut -d= -f2 | /usr/bin/tr -d ':'
}

# A self-signed code-signing certificate for this Mac, made once. Replacing it
# would make macOS ask for every folder again.
ensure_identity() {
  local work
  [[ ! -L "$SUPPORT_DIR" && ! -L "$SIGNING_DIR" ]] || die "refusing a symlinked signing directory"
  mkdir -p "$SIGNING_DIR"
  chmod 700 "$SUPPORT_DIR" "$SIGNING_DIR"
  [[ -s "$SIGNING_DIR/certificate.pem" && -s "$SIGNING_DIR/key.pem" ]] && return 0
  work="$(mktemp -d "$SIGNING_DIR/.new.XXXXXX")"
  cat > "$work/certificate.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Stepsemble on this Mac
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
  if ! /usr/bin/openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 7300 -config "$work/certificate.cnf" \
    -keyout "$work/key.pem" -out "$work/certificate.pem" >/dev/null 2>&1; then
    /bin/rm -rf -- "$work"
    die "could not make this Mac's signing certificate"
  fi
  chmod 600 "$work/key.pem" "$work/certificate.pem"
  mv -f "$work/key.pem" "$SIGNING_DIR/key.pem"
  mv -f "$work/certificate.pem" "$SIGNING_DIR/certificate.pem"
  /bin/rm -rf -- "$work"
}

SIGN_WORK=""
SIGN_KEYCHAIN=""
SAVED_KEYCHAINS=()
SEARCH_LIST_CHANGED=0
# Idempotent; also runs when the script exits or is stopped while signing.
finish_signing() {
  if (( SEARCH_LIST_CHANGED )); then
    /usr/bin/security list-keychains -d user -s "${SAVED_KEYCHAINS[@]}" >/dev/null 2>&1 || true
    SEARCH_LIST_CHANGED=0
  fi
  [[ -z "$SIGN_KEYCHAIN" ]] || /usr/bin/security delete-keychain "$SIGN_KEYCHAIN" >/dev/null 2>&1 || true
  SIGN_KEYCHAIN=""
  [[ -z "$SIGN_WORK" ]] || /bin/rm -rf -- "$SIGN_WORK"
  SIGN_WORK=""
}
trap 'finish_signing' EXIT
trap 'exit 130' INT TERM

# codesign takes identities only from a keychain in the user's search list. A
# throwaway keychain holds this Mac's certificate for the moment of signing;
# the search list is put back as it was.
sign_bundle() {
  local bundle="$1" keychain_password p12_password identity result=0
  SIGN_WORK="$(mktemp -d "${TMPDIR:-/tmp}/stepsemble-sign.XXXXXX")"
  SIGN_KEYCHAIN="$SIGN_WORK/signing.keychain-db"
  keychain_password="$(/usr/bin/openssl rand -hex 24)"
  p12_password="$(/usr/bin/openssl rand -hex 24)"
  identity="$(certificate_hash)"
  # Each step is checked: callers use this in conditions, where errexit is off.
  if [[ ! "$identity" =~ '^[0-9A-F]{40}$' || -z "$keychain_password" || -z "$p12_password" ]] \
    || ! STEPSEMBLE_P12_PASSWORD="$p12_password" /usr/bin/openssl pkcs12 -export -name "Stepsemble" \
      -inkey "$SIGNING_DIR/key.pem" -in "$SIGNING_DIR/certificate.pem" \
      -out "$SIGN_WORK/identity.p12" -passout env:STEPSEMBLE_P12_PASSWORD >/dev/null 2>&1 \
    || ! /usr/bin/security create-keychain -p "$keychain_password" "$SIGN_KEYCHAIN" >/dev/null \
    || ! /usr/bin/security set-keychain-settings "$SIGN_KEYCHAIN" \
    || ! /usr/bin/security unlock-keychain -p "$keychain_password" "$SIGN_KEYCHAIN" \
    || ! /usr/bin/security import "$SIGN_WORK/identity.p12" -k "$SIGN_KEYCHAIN" -P "$p12_password" -T /usr/bin/codesign >/dev/null \
    || ! /usr/bin/security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$SIGN_KEYCHAIN" >/dev/null; then
    finish_signing
    return 1
  fi
  SAVED_KEYCHAINS=("${(@f)$(/usr/bin/security list-keychains -d user | /usr/bin/sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')}")
  SAVED_KEYCHAINS=(${SAVED_KEYCHAINS:#})
  SEARCH_LIST_CHANGED=1
  if /usr/bin/security list-keychains -d user -s "${SAVED_KEYCHAINS[@]}" "$SIGN_KEYCHAIN"; then
    bounded 120 /usr/bin/codesign --force --timestamp=none --keychain "$SIGN_KEYCHAIN" -s "$identity" -i "$BUNDLE_ID" "$bundle" \
      2>"$SIGN_WORK/codesign.log" || result=$?
    (( result == 0 )) || /bin/cat "$SIGN_WORK/codesign.log" >&2
  else
    result=1
  fi
  finish_signing
  return "$result"
}

# Signed by this Mac's certificate as Stepsemble, intact, and runnable.
bundle_is_signed_here() {
  local bundle="$1" requirement identity
  [[ -x "$bundle/Contents/MacOS/Stepsemble" && -s "$SIGNING_DIR/certificate.pem" ]] || return 1
  /usr/bin/codesign --verify --strict "$bundle" >/dev/null 2>&1 || return 1
  requirement="$(/usr/bin/codesign -d -r- "$bundle" 2>&1)" || return 1
  identity="$(certificate_hash | /usr/bin/tr 'A-F' 'a-f')"
  [[ "$requirement" == *"identifier \"$BUNDLE_ID\""* && "$requirement" == *"certificate leaf = H\"$identity\""* ]]
}

check_app() {
  local expected="${1:-}"
  bundle_is_signed_here "$APP_PATH" || return 1
  [[ -z "$expected" || "$(plist_value "$APP_PATH/Contents/Info.plist" CFBundleShortVersionString)" == "${expected#v}" ]]
}

install_app() {
  local source="${1:A}" version stage_root stage reported
  [[ -d "$source/Contents/MacOS" && -x "$source/Contents/MacOS/Stepsemble" ]] || die "not a Stepsemble app: $source"
  [[ "$(plist_value "$source/Contents/Info.plist" CFBundleIdentifier)" == "$BUNDLE_ID" ]] || die "not a Stepsemble app: $source"
  version="$(plist_value "$source/Contents/Info.plist" CFBundleShortVersionString)"
  [[ -n "$version" ]] || die "the app has no version"
  ensure_identity
  /bin/rm -rf -- "$SUPPORT_DIR/staging"
  mkdir -p "$SUPPORT_DIR/staging" "${PREVIOUS_APP:h}" "${APP_PATH:h}"
  stage_root="$(mktemp -d "$SUPPORT_DIR/staging/install.XXXXXX")"
  stage="$stage_root/Stepsemble.app"
  # Extended attributes (quarantine, Finder info) would fail codesign.
  if ! /usr/bin/ditto --norsrc --noextattr --noacl "$source" "$stage" || ! sign_bundle "$stage" \
    || ! bundle_is_signed_here "$stage"; then
    /bin/rm -rf -- "$stage_root"
    die "could not sign Stepsemble.app for this Mac"
  fi
  reported="$("$stage/Contents/MacOS/Stepsemble" --version 2>/dev/null || true)"
  if [[ "$reported" != "$version" ]]; then
    /bin/rm -rf -- "$stage_root"
    die "the signed app does not start"
  fi
  /bin/rm -rf -- "$PREVIOUS_APP"
  if [[ -e "$APP_PATH" ]]; then
    mv "$APP_PATH" "$PREVIOUS_APP"
    "$LSREGISTER" -u "$PREVIOUS_APP" >/dev/null 2>&1 || true
  fi
  if ! mv "$stage" "$APP_PATH"; then
    [[ ! -e "$PREVIOUS_APP" ]] || mv "$PREVIOUS_APP" "$APP_PATH"
    /bin/rm -rf -- "$stage_root"
    die "could not install Stepsemble.app"
  fi
  /bin/rm -rf -- "$stage_root"
  "$LSREGISTER" -f "$APP_PATH" >/dev/null 2>&1 || true
  print -r -- "$APP_PATH"
}

# The app that install replaced comes back; after a first install, the app is
# removed.
restore_app() {
  if [[ -d "$PREVIOUS_APP" ]]; then
    /bin/rm -rf -- "$APP_PATH"
    mv "$PREVIOUS_APP" "$APP_PATH"
    "$LSREGISTER" -f "$APP_PATH" >/dev/null 2>&1 || true
  else
    [[ ! -e "$APP_PATH" ]] || "$LSREGISTER" -u "$APP_PATH" >/dev/null 2>&1 || true
    /bin/rm -rf -- "$APP_PATH"
  fi
}

# app: the LaunchAgent starts the Host through Stepsemble.app. node: it starts
# Node.js with server.js directly. other: anything else (the SSH launcher).
launch_mode() {
  local plist="$1" first second
  [[ -f "$plist" ]] || { print other; return 0; }
  first="$(plist_value "$plist" ProgramArguments:0)"
  second="$(plist_value "$plist" ProgramArguments:1)"
  if [[ "$first" == /*/Stepsemble.app/Contents/MacOS/Stepsemble && "$second" == "--serve" ]]; then
    print app
  elif [[ "$first" == /*/node && "$(plist_value "$plist" ProgramArguments)" == *"/server.js"* ]]; then
    print node
  else
    print other
  fi
}

use_app() {
  local plist="$1"
  case "$(launch_mode "$plist")" in
    app) return 0 ;;
    node) ;;
    *) die "this LaunchAgent does not start the Host with Node.js" ;;
  esac
  check_app || die "Stepsemble.app is not installed and signed for this Mac"
  /usr/bin/plutil -insert ProgramArguments.0 -string "$APP_EXECUTABLE" "$plist"
  /usr/bin/plutil -insert ProgramArguments.1 -string "--serve" "$plist"
  /usr/bin/plutil -lint "$plist" >/dev/null
  [[ "$(launch_mode "$plist")" == "app" ]] || die "could not update the LaunchAgent"
}

use_node() {
  local plist="$1"
  [[ "$(launch_mode "$plist")" == "app" ]] || return 0
  /usr/bin/plutil -remove ProgramArguments.0 "$plist"
  /usr/bin/plutil -remove ProgramArguments.0 "$plist"
  /usr/bin/plutil -lint "$plist" >/dev/null
  [[ "$(launch_mode "$plist")" == "node" ]] || die "could not update the LaunchAgent"
}

case "${1:-}" in
  install) (( $# == 2 )) || die "usage: install <Stepsemble.app>"; install_app "$2" ;;
  restore) restore_app ;;
  check) check_app "${2:-}" ;;
  launch-mode) (( $# == 2 )) || die "usage: launch-mode <plist>"; launch_mode "$2" ;;
  use-app) (( $# == 2 )) || die "usage: use-app <plist>"; use_app "$2" ;;
  use-node) (( $# == 2 )) || die "usage: use-node <plist>"; use_node "$2" ;;
  *) die "usage: install|restore|check|launch-mode|use-app|use-node" ;;
esac
