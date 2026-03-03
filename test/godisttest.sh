#!/usr/bin/env bash
# Run Go dist tests using wcjs as the WASI runtime.
# Usage: test/godisttest.sh [extra flags for dist test...]
set -eo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GODIR="${GODIR:-$REPO_ROOT/../go}"
export GOROOT="$GODIR"
export GOOS=wasip3
export GOARCH=wasm32
export GOWASIRUNTIME=wcjs
export WCJS="$REPO_ROOT"
export PATH="$GODIR/lib/wasm:$PATH"
export P3_MAX_RSS_MB="${P3_MAX_RSS_MB:-4096}"

exec "$GODIR/bin/go" tool dist test "$@"
