#!/bin/bash
set -euo pipefail

# Usage: build-go.sh [filter]
# Builds Go guest components. Optional filter matches against directory names.
# Examples:
#   ./build-go.sh           # build all
#   ./build-go.sh hello     # build only go/hello

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GO_DIR="$SCRIPT_DIR/go"
OUT_DIR="$SCRIPT_DIR/out"
GOROOT="$REPO_ROOT/../go"
GO="$GOROOT/bin/go"
WIT_DIR="$GOROOT/src/internal/wasi/wit"
FILTER="${1:-}"

if [ ! -x "$GO" ]; then
  echo "error: Go toolchain not found at $GO" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

for dir in "$GO_DIR"/*/; do
  name="$(basename "$dir")"

  # Apply filter if provided
  if [ -n "$FILTER" ] && [[ "$name" != *"$FILTER"* ]]; then
    continue
  fi

  dest="$OUT_DIR/go-$name"
  mkdir -p "$dest"

  echo "building go/$name ..."

  # Ensure go.mod exists
  if [ ! -f "$dir/go.mod" ]; then
    (cd "$dir" && GOROOT="$GOROOT" "$GO" mod init "$name" 2>/dev/null)
  fi

  (cd "$dir" && GOROOT="$GOROOT" GOOS=wasip3 GOARCH=wasm32 "$GO" build -o "$dest/prog.wasm" .)
  wasm-tools component embed "$WIT_DIR" --world command "$dest/prog.wasm" -o "$dest/embedded.wasm"
  wasm-tools component new "$dest/embedded.wasm" -o "$dest/component.wasm"
  echo "  -> $dest/component.wasm"
done

echo "done."
