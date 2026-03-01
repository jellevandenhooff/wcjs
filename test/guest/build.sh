#!/bin/bash
set -euo pipefail

# Unified guest component builder for Go and Rust guests.
#
# Usage:
#   ./build.sh              # build all guests
#   ./build.sh go            # build only Go guests
#   ./build.sh rust          # build only Rust guests
#   ./build.sh hello         # build guests matching "hello"
#
# Prerequisites:
#   - Go:   custom wasip3 Go fork (sibling repo ../go)
#   - Rust: cargo + wasm32-wasip1 target, wasi_snapshot_preview1 adapter
#   - wasm-tools CLI
#
# Adding a new guest:
#   Go:   create test/guest/go/<name>/main.go
#   Rust: create test/guest/rust/<name>/{Cargo.toml,src/lib.rs,wit/*.wit}
#
# Output: test/guest/out/{go,rust}-<name>/component.wasm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/out"
FILTER="${1:-}"

# ---- Go guests ----

GO_DIR="$SCRIPT_DIR/go"
GOROOT="$REPO_ROOT/../go"
GO="$GOROOT/bin/go"
GO_WIT_DIR="$GOROOT/src/internal/wasi/wit"

build_go() {
  if [ ! -x "$GO" ]; then
    echo "warning: Go toolchain not found at $GO, skipping Go guests" >&2
    return
  fi

  for dir in "$GO_DIR"/*/; do
    [ -d "$dir" ] || continue
    local name="$(basename "$dir")"

    if [ -n "$FILTER" ] && [[ "$name" != *"$FILTER"* ]] && [[ "go" != *"$FILTER"* ]]; then
      continue
    fi

    local dest="$OUT_DIR/go-$name"
    mkdir -p "$dest"
    echo "building go/$name ..."

    # Ensure go.mod exists
    if [ ! -f "$dir/go.mod" ]; then
      (cd "$dir" && GOROOT="$GOROOT" "$GO" mod init "$name" 2>/dev/null)
    fi

    (cd "$dir" && GOROOT="$GOROOT" GOOS=wasip3 GOARCH=wasm32 "$GO" build -o "$dest/prog.wasm" .)
    wasm-tools component embed "$GO_WIT_DIR" --world command "$dest/prog.wasm" -o "$dest/embedded.wasm"
    wasm-tools component new "$dest/embedded.wasm" -o "$dest/component.wasm"
    echo "  -> $dest/component.wasm"
  done
}

# ---- Rust guests ----

RUST_DIR="$SCRIPT_DIR/rust"
ADAPTER="$REPO_ROOT/../wasmtime/target/wasm32-unknown-unknown/release/wasi_snapshot_preview1.wasm"

build_rust() {
  [ -d "$RUST_DIR" ] || return

  if [ ! -f "$ADAPTER" ]; then
    echo "warning: WASI P1 adapter not found at $ADAPTER, skipping Rust guests" >&2
    return
  fi

  for dir in "$RUST_DIR"/*/; do
    [ -d "$dir" ] || continue
    local name="$(basename "$dir")"

    if [ -n "$FILTER" ] && [[ "$name" != *"$FILTER"* ]] && [[ "rust" != *"$FILTER"* ]]; then
      continue
    fi

    local dest="$OUT_DIR/rust-$name"
    mkdir -p "$dest"
    echo "building rust/$name ..."

    cargo build --target=wasm32-wasip1 --manifest-path "$dir/Cargo.toml" 2>&1 | sed 's/^/  /'

    # Find the cdylib output (name may have hyphens→underscores)
    local crate_name
    crate_name=$(grep '^name' "$dir/Cargo.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/' | tr '-' '_')
    local wasm_path="$dir/target/wasm32-wasip1/debug/${crate_name}.wasm"

    if [ ! -f "$wasm_path" ]; then
      echo "error: expected wasm at $wasm_path" >&2
      exit 1
    fi

    wasm-tools component new "$wasm_path" \
      --adapt "wasi_snapshot_preview1=$ADAPTER" \
      -o "$dest/component.wasm"
    echo "  -> $dest/component.wasm"
  done
}

# ---- Main ----

mkdir -p "$OUT_DIR"
build_go
build_rust
echo "done."
