#!/usr/bin/env bash
# Run Go tests using wasmtime as the WASI runtime (for comparison).
# Usage: test/gotest-wasmtime.sh <pkg> [go test flags...]
# Example: npm run test:go-wasmtime -- os -short -count=1 -run TestFileAndSymlinkStats
set -eo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GODIR="$REPO_ROOT/../go"
export GOROOT="$GODIR"
export GOOS=wasip3
export GOARCH=wasm32
export GOWASIRUNTIME=wasmtime
export WASMTIME="$REPO_ROOT/../wasmtime/target/release/wasmtime"
export PATH="$GODIR/lib/wasm:$PATH"

pkg="$1"; shift
exec "$GODIR/bin/go" test "$pkg" "$@"
