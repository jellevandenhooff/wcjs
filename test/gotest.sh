#!/usr/bin/env bash
# Run Go tests using wcjs as the WASI runtime.
# Usage: test/gotest.sh <pkg> [go test flags...]
# Example: npm run test:go -- fmt -short -count=1
set -eo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GODIR="${GODIR:-$REPO_ROOT/../go}"
export GOROOT="$GODIR"
export GOOS=wasip3
export GOARCH=wasm32
export GOWASIRUNTIME=wcjs
export WCJS="$REPO_ROOT"
export PATH="$GODIR/lib/wasm:$PATH"

pkg="$1"; shift
exec "$GODIR/bin/go" test "$pkg" "$@"
