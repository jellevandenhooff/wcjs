# wcjs

See `README.md` for project overview, architecture, and project structure.

## Scripts

```bash
npm test                           # Run all tests (unit + integration, parallel)
npm test -- stream                 # Filter by name substring
npm test -- "test4-deferred"       # Filter by exact name
P3_TRACE=1 npm test -- test1       # With runtime tracing
npm run check                      # Type check with tsgo

npm run test:go -- fmt -short      # Run Go stdlib tests via wcjs
npm run test:go-dist               # Run Go dist tests via wcjs
npm run test:go-wasmtime -- fmt    # Run Go tests via wasmtime (comparison)

npm run demo:build                 # Build demo (Rust guest + browser bundle)
npm run demo:node                  # Run demo in Node.js
npm run demo:serve                 # Serve browser demo

npm run gen-host-types             # Regenerate WASI TypeScript types from WIT
```

No build step — TypeScript runs directly via `node --experimental-transform-types`.

## Reference

These are expected as sibling repos (clone into the same parent directory):

- Component model spec: `../component-model/` — https://github.com/WebAssembly/component-model
  - Canonical ABI definitions (Python): `design/mvp/canonical-abi/definitions.py`
  - Spec async tests: `test/async/`
- Go (wasip3 fork): `../go/` — https://github.com/jellevandenhooff/go (branch `wasip3-prototype`)
- Wasmtime: `../wasmtime/` — https://github.com/bytecodealliance/wasmtime
  - Tests: `crates/misc/component-async-tests/`
