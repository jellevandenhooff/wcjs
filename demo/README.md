# Calculator demo

A Rust WASI P3 component running in both Node.js and the browser.

```bash
# Build guest, generate bindings, bundle for browser
npm run demo:build

# Run in Node.js
npm run demo:node

# Serve browser demo
npm run demo:serve
```

## Source maps

**JS**: The browser bundle includes source maps (`--sourcemap` via esbuild). Chrome DevTools Sources panel shows the original TypeScript files.

**Wasm**: The build script uses [`cargo-wasm2map`](https://crates.io/crates/cargo-wasm2map) to generate standard source maps from the DWARF debug info preserved in the `.core.wasm` files. Chrome DevTools natively shows the Rust source files (including `lib.rs` and stdlib) in the Sources panel, no extensions needed.
