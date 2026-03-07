#!/bin/bash
# Build all assets for the Go-in-the-browser demo.
#
# Requires:
#   - GODIR env var pointing to the Go repo (wasip3-prototype branch)
#   - wasm-tools installed
#   - npm ci done in the wcjs repo
#
# Output goes to demo/go/dist/

set -euo pipefail
cd "$(dirname "$0")/../.."

GODIR="${GODIR:?Set GODIR to the Go repo root}"
GOBIN="$GODIR/bin/go"
WIT_DIR="$GODIR/src/internal/wasi/wit"
DIST="demo/go/dist"
OUT="demo/go/dist/out"

if [ ! -x "$GOBIN" ]; then
  echo "Error: $GOBIN not found. Run make.bash in the Go repo first." >&2
  exit 1
fi

if ! command -v wasm-tools &>/dev/null; then
  echo "Error: wasm-tools not found. Install from https://github.com/bytecodealliance/wasm-tools" >&2
  exit 1
fi

rm -rf "$DIST"
mkdir -p "$OUT"

# 1. Build Go tools as wasip3 wasm
echo "==> Building Go tools..."
GOOS=wasip3 GOARCH=wasm32 GOEXPERIMENT=wasiexec "$GOBIN" build -o "$OUT/go.wasm" cmd/go
GOOS=wasip3 GOARCH=wasm32 GOEXPERIMENT=wasiexec "$GOBIN" build -o "$OUT/compile.wasm" cmd/compile
GOOS=wasip3 GOARCH=wasm32 GOEXPERIMENT=wasiexec "$GOBIN" build -o "$OUT/asm.wasm" cmd/asm
GOOS=wasip3 GOARCH=wasm32 GOEXPERIMENT=wasiexec "$GOBIN" build -o "$OUT/link.wasm" cmd/link
GOOS=wasip3 GOARCH=wasm32 GOEXPERIMENT=wasiexec "$GOBIN" build -o "$OUT/componentize.wasm" cmd/componentize

# goimports is an external module — build from a temp module with vendoring
# to patch x/telemetry's mmap_other.go build constraint for wasip3
GOIMPORTS_DIR="$HOME/.cache/wcjs-goimports-build"
mkdir -p "$GOIMPORTS_DIR"
cat > "$GOIMPORTS_DIR/go.mod" <<'GOMOD'
module goimports-build
go 1.27
GOMOD
cat > "$GOIMPORTS_DIR/tools.go" <<'TOOLS'
//go:build tools
package tools
import _ "golang.org/x/tools/cmd/goimports"
TOOLS
"$GOBIN" -C "$GOIMPORTS_DIR" get golang.org/x/tools/cmd/goimports@latest 2>&1
"$GOBIN" -C "$GOIMPORTS_DIR" mod tidy
"$GOBIN" -C "$GOIMPORTS_DIR" mod vendor

# Patch vendored mmap_other.go build constraint to include wasip3
MMAP_VENDOR="$GOIMPORTS_DIR/vendor/golang.org/x/telemetry/internal/mmap/mmap_other.go"
# sed -i works differently on macOS vs Linux; use a temp file approach
sed 's/wasip1/wasip1 || wasip3/' "$MMAP_VENDOR" > "$MMAP_VENDOR.tmp" && mv "$MMAP_VENDOR.tmp" "$MMAP_VENDOR"

GOOS=wasip3 GOARCH=wasm32 GOEXPERIMENT=wasiexec "$GOBIN" build -C "$GOIMPORTS_DIR" -mod=vendor -o "$(pwd)/$OUT/goimports.wasm" golang.org/x/tools/cmd/goimports

# 2. Componentize
echo "==> Componentizing..."
for tool in go compile asm link componentize goimports; do
  wasm-tools component embed "$WIT_DIR" --world command-with-exec "$OUT/$tool.wasm" -o "$OUT/$tool.embedded.wasm"
  wasm-tools component new "$OUT/$tool.embedded.wasm" -o "$OUT/$tool.component.wasm"
  rm "$OUT/$tool.embedded.wasm" "$OUT/$tool.wasm"
done

# 3. Bundle GOROOT source as tar
echo "==> Bundling GOROOT..."
node --experimental-transform-types demo/go/tools/bundle-goroot.ts "$GODIR" "$OUT/goroot.tar"

# 4. Pre-warm build cache
echo "==> Pre-warming build cache..."
node --experimental-transform-types --stack-size=4194304 demo/go/tools/bundle-cache.ts "$GODIR" "$OUT"

# 5. Content-hash all assets and generate manifest
echo "==> Content-hashing assets..."
node --experimental-transform-types demo/go/tools/hash-assets.ts "$OUT" "$DIST"

# 6. Bundle worker.ts with esbuild
echo "==> Bundling worker..."
npx esbuild demo/go/web/worker.ts --bundle --format=esm \
  --alias:@jellevdh/wcjs/runtime=./src/runtime/index.ts \
  --alias:@jellevdh/wcjs/codegen=./src/codegen/index.ts \
  '--external:node:*' \
  --entry-names='[name]-[hash]' \
  --outdir="$DIST" --target=es2022

# 7. Generate final index.html with hashed JS reference
echo "==> Generating index.html..."
WORKER_JS=$(ls "$DIST"/worker-*.js | head -1 | xargs basename)
sed "s|worker.js|${WORKER_JS}|g" demo/go/web/index.html > "$DIST/index.html"

# 8. Copy serve.json for COOP/COEP headers
cp demo/go/serve.json "$DIST/serve.json"

echo "==> Done! Serve $DIST/ to run in the browser."
echo "    Files:"
ls -lhS "$DIST/"
