#!/bin/zsh
# Builds Stepsemble.app for macOS from macos/Stepsemble: one universal
# (Apple silicon and Intel) executable, the icon, and the text macOS shows when
# it asks for folder access. The app is left unsigned; each Mac signs its own
# copy when it installs it (deploy/stepsemble-macos-app.sh), so macOS keeps
# that Mac's folder permissions for Stepsemble across updates.
#
# Usage: macos/build-app.sh [--host-only] <output .app path>
#   --host-only  build for this Mac's processor only (local source installs;
#                Command Line Tools may lack the other architecture's runtime)
set -eu
setopt NO_NOMATCH PIPE_FAIL

die() { print -u2 -r -- "build-app: $*"; exit 1; }
architectures=(arm64 x86_64)
if [[ "${1:-}" == "--host-only" ]]; then
  architectures=("$(/usr/bin/uname -m)")
  shift
fi
(( $# == 1 )) || die "usage: build-app.sh [--host-only] <output .app path>"
readonly SOURCE_DIR="${0:A:h}/Stepsemble"
readonly ROOT="${0:A:h:h}"
readonly OUTPUT="${1:A}"
readonly LANGUAGES=(zh-Hant zh-Hans ja ko tr fr de es pt-BR it)
[[ "$OUTPUT" == *.app ]] || die "the output must end in .app"
[[ ! -e "$OUTPUT" ]] || die "the output already exists: $OUTPUT"
version="$(/usr/bin/sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$ROOT/package.json")"
[[ "$version" =~ '^[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$' ]] || die "could not read the version from package.json"

work="$(mktemp -d "${TMPDIR:-/tmp}/stepsemble-app-build.XXXXXX")"
trap '/bin/rm -rf -- "$work"' EXIT
contents="$work/Stepsemble.app/Contents"
mkdir -p "$contents/MacOS" "$contents/Resources"

# macOS 11 is the oldest system Node.js 22 runs on.
for arch in "${architectures[@]}"; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos11.0" \
    -o "$work/Stepsemble-$arch" "$SOURCE_DIR/main.swift" "$SOURCE_DIR/Notifications.swift"
done
xcrun lipo -create -output "$contents/MacOS/Stepsemble" "$work"/Stepsemble-*(N)
chmod 755 "$contents/MacOS/Stepsemble"

/usr/bin/sed "s/__VERSION__/$version/g" "$SOURCE_DIR/Info.plist" > "$contents/Info.plist"
/usr/bin/plutil -lint "$contents/Info.plist" >/dev/null
print -rn -- 'APPL????' > "$contents/PkgInfo"

iconset="$work/Stepsemble.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$SOURCE_DIR/AppIcon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  /usr/bin/sips -z "$(( size * 2 ))" "$(( size * 2 ))" "$SOURCE_DIR/AppIcon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns -o "$contents/Resources/Stepsemble.icns" "$iconset"

# English is in Info.plist; each translation becomes <language>.lproj/InfoPlist.strings.
for language in "${LANGUAGES[@]}"; do
  mkdir -p "$contents/Resources/$language.lproj"
  /usr/bin/plutil -extract "$language" xml1 -o "$contents/Resources/$language.lproj/InfoPlist.strings" "$SOURCE_DIR/InfoPlist.json"
done

mkdir -p "${OUTPUT:h}"
mv "$work/Stepsemble.app" "$OUTPUT"
print -r -- "$OUTPUT"
