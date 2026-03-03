#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

ADAPTER=${WASI_ADAPTER:-../wasmtime/target/wasm32-unknown-unknown/release/wasi_snapshot_preview1.wasm}

echo "==> Building Rust guest..."
cargo build --target=wasm32-wasip1 --manifest-path demo/guest/Cargo.toml

echo "==> Creating component..."
mkdir -p demo/generated
wasm-tools component new demo/guest/target/wasm32-wasip1/debug/calculator.wasm \
  --adapt "wasi_snapshot_preview1=$ADAPTER" \
  -o demo/generated/calculator.wasm

echo "==> Generating JS bindings..."
node --experimental-transform-types cli.ts generate demo/generated/calculator.wasm \
  -o demo/generated --name calculator --jspi

echo "==> Bundling for browser..."
mkdir -p demo/dist
npx esbuild demo/web/main.ts --bundle --format=esm --sourcemap \
  --alias:@jellevdh/wcjs/runtime=./src/runtime/index.ts \
  --alias:@jellevdh/wcjs/wasi=./src/wasi/index.ts \
  '--external:node:*' \
  --outfile=demo/dist/main.js --target=es2022

cp demo/web/index.html demo/dist/
cp demo/generated/*.core*.wasm demo/dist/ 2>/dev/null || true

echo "==> Generating wasm source maps..."
# Generate .wasm.map from DWARF and patch sourceMappingURL into wasm.
cargo wasm2map demo/dist/calculator.core.wasm --patch --base-url "."
# Embed sourcesContent and clean up paths so Chrome can display them inline.
node --experimental-transform-types demo/fix-wasm-sourcemap.ts demo/dist/calculator.core.wasm.map

echo "==> Done! Serve demo/dist/ to run in the browser."
