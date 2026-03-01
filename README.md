# wcjs

Runtime, codegen, and CLI for using [WebAssembly components](https://component-model.bytecodealliance.org/) and [WASI P3](https://wasi.dev/roadmap#upcoming-wasi-03-releases) in the browser and Node.js. Call and expose asynchronous WebAssembly code with ergonomic, fully-typed TypeScript bindings.

> **Warning:** This project is extremely experimental. APIs will change, things will break, and it's not easy to use yet. All code was written by LLM, with plenty of review and feedback. That said, a large test suite passes (including the component model spec tests and ported wasmtime integration tests) and it does seem to work.

Implements the full [async component model](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Concurrency.md) including streams, futures, and concurrent tasks, with both stackless and stackful async ABIs.

## How it compares to [jco](https://github.com/bytecodealliance/jco)

| | wcjs | jco |
|---|---|---|
| Maturity | Extremely experimental | More usage and production experience |
| Dependencies | Zero. Parser, codegen, and runtime all from scratch in TypeScript | Compiles wasmtime-environ and other Rust crates to Wasm for use in its JS-based compiler |
| Language | Fully TypeScript (even generated code) | Mix of JavaScript and Rust |
| Generated size | Small. Generated code calls into a shared typed runtime (`@jellevdh/wcjs/runtime`) | Large. Each component gets its own copy of lift/lower helpers |
| JSPI | Optional, for sync-calling-async (though most guests need it) | — |
| JS components | No, embedding/running Wasm components only | Yes, can create components from JS |

> **Note:** Currently Node.js only — the WASI host implementation uses low-level Node APIs (net, fs, etc.). Deno and Bun are not yet supported.

## What's supported

### WASI P3

Targets WASI P3 version `0.3.0-rc-2026-02-09`. WASI P2 compatibility stubs are provided for `0.2.0` through `0.2.6`.

| Interface | Node.js | Browser |
|---|---|---|
| `wasi:cli` (args, env, exit, stdio) | Yes | Yes |
| `wasi:clocks` (monotonic, wall) | Yes | Yes |
| `wasi:random` | Yes | Yes |
| `wasi:filesystem` (read, write, stat, readdir, remove, preopens) | Yes | No |
| `wasi:sockets` (TCP, UDP, DNS) | Yes | No |
| `wasi:http` (client, handler) | Yes | No |

Tests:
- **Go stdlib tests**: Go standard library tests (`os`, `time`, `path/filepath`, `net`) compiled to wasip3 with a [custom Go fork](https://github.com/jellevandenhooff/go/tree/wasip3-prototype) and run against wcjs
- **Ported wasmtime tests**: the Rust integration tests wasmtime uses to test its own wasip3 implementation, ported and passing on wcjs

### Async component model

Full implementation of the [async component model](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Concurrency.md). Supported canon builtins:

| Category | Builtins |
|---|---|
| Lifting and lowering | `canon lift` (sync, async stackless, async stackful), `canon lower` (sync, async) |
| Tasks | `task.return`, `task.cancel`, `context.get`, `context.set` |
| Subtasks | `subtask.drop`, `subtask.cancel` |
| Streams | `stream.new`, `stream.read`, `stream.write`, `stream.cancel-read`, `stream.cancel-write`, `stream.drop-readable`, `stream.drop-writable` |
| Futures | `future.new`, `future.read`, `future.write`, `future.cancel-read`, `future.cancel-write`, `future.drop-readable`, `future.drop-writable` |
| Waitable sets | `waitable-set.new`, `waitable-set.wait`, `waitable-set.poll`, `waitable-set.drop`, `waitable.join` |
| Backpressure | `backpressure.inc`, `backpressure.dec` |
| Resources | `resource.new`, `resource.drop`, `resource.rep` |
| Error contexts | `error-context.new`, `error-context.debug-message`, `error-context.drop` |
| Threads | `thread.new-indirect`, `thread.index`, `thread.yield`, `thread.suspend`, `thread.switch-to`, `thread.yield-to`, `thread.suspend-to`, `thread.resume-later` |

Tested by all 24 spec WAST tests from the [component-model repo](https://github.com/WebAssembly/component-model/tree/main/test/async), as well as indirectly by the WASI P3 tests above which exercise the async component model end-to-end. Tracks the component-model spec at [`c7176a5`](https://github.com/WebAssembly/component-model/commit/c7176a512c0bbe4654849f4ba221c1a71c7cf514) (2026-02-17).

### JavaScript integration

`npx @jellevdh/wcjs generate` produces a JS module with an async API to instantiate and interact with a component. Exported functions map to `async` JS functions; streams and futures map to handle numbers. The generated `.d.ts` file provides full TypeScript types for all imports and exports, so host implementations are type-checked at compile time.

## Demo

The `demo/` directory contains a complete example: a Rust WASI P3 component running in both Node.js and the browser.

### WIT definition

```wit
package demo:calculator;

interface host {
  slow-double: async func(n: u32) -> u32;
  log: func(msg: string);
}

interface calc {
  add: func(a: s32, b: s32) -> s32;
  double-and-add: async func(a: u32, b: u32) -> u32;
}

world calculator {
  import host;
  export calc;
}
```

### Guest code (Rust)

```rust
impl Guest for Component {
    fn add(a: i32, b: i32) -> i32 {
        a + b
    }

    async fn double_and_add(a: u32, b: u32) -> u32 {
        let (da, db) = futures::join!(host::slow_double(a), host::slow_double(b));
        da + db
    }
}
```

The guest calls `slow-double` **concurrently** on both arguments using `futures::join!`. With a 1-second delay per call, both resolve in ~1s instead of ~2s.

### Host code (TypeScript)

```ts
import { instantiate } from './generated/calculator.js';

const instance = await instantiate({
  'demo:calculator/host': {
    'slow-double': async (n: number) => {
      await new Promise(r => setTimeout(r, 1000));
      return n * 2;
    },
    log: (msg: string) => console.log(msg),
  },
});

const calc = instance['demo:calculator/calc'];
console.log(await calc.add(3, 4));           // 7
console.log(await calc.doubleAndAdd(5, 7));  // 24 (in ~1s, not ~2s)
```

Async WIT functions map to `async` JS functions that return a `Promise`. The guest suspends until it resolves. All exports are `async` and return `Promise`s. The generated `.d.ts` provides full types for imports and exports.

### Building and running

```bash
# Build guest, generate bindings, bundle for browser
npm run demo:build

# Run in Node.js
npm run demo:node

# Serve browser demo
npm run demo:serve
```

## CLI

```bash
# Run a WASI component
npx @jellevdh/wcjs run <component.wasm> [--dir guest=host] [--env K=V] [--inherit-env] [--inherit-network] [--no-jspi] [-- guest-args...]

# Generate importable JS + .d.ts + .core.wasm from a component
npx @jellevdh/wcjs generate <component.wasm> [-o <dir>] [--name <name>] [--no-jspi]

# Generate TypeScript host type declarations from WIT
npx @jellevdh/wcjs gen-types <p3-wit-path>... [--p2 <p2-wit-path>...] [-o <output>]
```

### `npx @jellevdh/wcjs run`

Instantiates and runs a WASI component directly. Supports filesystem mapping, environment variables, and network access:

```bash
npx @jellevdh/wcjs run my-app.wasm --dir /data=./local-data --inherit-env --inherit-network
```

### `npx @jellevdh/wcjs generate`

Generates a standalone ES module from a component binary. The output includes a `.js` file, `.d.ts` type declarations, and `.core.wasm` files:

```bash
npx @jellevdh/wcjs generate my-component.wasm -o lib/ --name my-component
```

The generated code imports from `@jellevdh/wcjs/runtime` and `@jellevdh/wcjs/wasi`, and can be bundled for the browser with esbuild or similar.

## How it works

A WebAssembly component bundles one or more core wasm modules together with type information and canonical ABI adapter instructions describing how to convert between wasm's flat integer/float values and high-level types like strings, records, variants, lists, and streams. wcjs processes these components in three steps:

1. **Parse.** A from-scratch binary parser reads the `.wasm` bytes into an in-memory IR, extracting core modules, type definitions, imports, exports, and adapter instructions.

2. **Generate code.** The codegen analyzes the parsed component's types and adapter instructions, then generates JavaScript that instantiates the core wasm modules via `WebAssembly.instantiate` and wires them together with trampoline functions that lift (wasm to JS) and lower (JS to wasm) values according to the canonical ABI. The generated code delegates to the shared `wcjs/runtime` package for async operations.

3. **Generate types.** A `.d.ts` file is generated with full TypeScript types for all imports and exports. WIT types map to TypeScript: records become interfaces, variants become discriminated unions, enums become string unions, async functions become `Promise`-returning functions. Hosts get compile-time type checking against the component's interface. Types can also be generated directly from WIT files via `wcjs gen-types`.

`wcjs generate` bundles all of this into a self-contained ES module (`.js` + `.d.ts` + `.core.wasm` files). The output uses the browser's standard `WebAssembly.compileStreaming` / `WebAssembly.instantiate` APIs with no custom loader or bundler plugin required.

### Async runtime

The runtime implements the async component model on top of JavaScript promises. Each async export call creates a task; async import calls create subtasks backed by promises that deliver events when the host resolves them. Streams are pairs of readable/writable ends with a shared buffer and backpressure, where writes from one component resolve reads in another. Futures are one-shot streams. An event loop drives it all: the guest yields control back to the host, the event loop waits for promises to settle, delivers events, and calls back into the guest until the task completes.

For guests that make synchronous imports into asynchronous hosts, wcjs uses [JSPI](https://github.com/nicolo-ribaudo/tc39-proposal-jspi) (`WebAssembly.promising` / `WebAssembly.Suspending`) to suspend the wasm stack while a promise resolves. JSPI is optional but most guests need it. Currently available in Chrome and Node.js; all major browsers plan to ship support in 2026.

### WASI host

wcjs includes a WASI P3 host implementation (`src/wasi/`) that maps the WASI spec interfaces to platform APIs. On Node.js this includes filesystem, sockets, and HTTP. In the browser it covers clocks, random, stdio, and environment. WASI P2 compatibility stubs let existing P2 guests run without modification.

## Development

No build step. TypeScript runs directly via `node --experimental-transform-types`.

### Quick start

```bash
npm install
npm test        # runs unit tests + WAT/WAST integration tests
npm run check   # type check with tsgo
```

This requires [`wasm-tools`](https://github.com/bytecodealliance/wasm-tools) in your PATH (install via `cargo install wasm-tools`). Guest integration tests and wasmtime P3 tests will be skipped — see below for full setup.

```bash
# Filter tests by name
npm test -- stream
npm test -- "test4-deferred"

# With runtime tracing
P3_TRACE=1 npm test -- test1-callback
```

### Full test setup

To run all tests (including Go guest and wasmtime P3 integration tests), clone sibling repos into the same parent directory:

```
parent/
  wcjs/                  # this repo
  component-model/       # spec reference (not needed for tests, useful for development)
  go/                    # Go wasip3 fork (needed for Go guest tests)
  wasmtime/              # wasmtime (needed for wasmtime P3 tests)
```

```bash
# Component model spec (reference only)
git clone https://github.com/WebAssembly/component-model ../component-model

# Go wasip3 fork — build the toolchain
git clone -b wasip3-prototype https://github.com/jellevandenhooff/go ../go
cd ../go/src && ./make.bash && cd -

# Wasmtime — build test programs
git clone https://github.com/bytecodealliance/wasmtime ../wasmtime
cd ../wasmtime && git submodule update --init && cargo test -p test-programs-artifacts --no-run && cd -
```

Then build the guest test components:

```bash
bash test/guest/build.sh              # build Go + Rust guest components
bash test/guest/copy-wasmtime-tests.sh # copy wasmtime P3 test binaries
npm test                               # all ~410 tests
```

## Project structure

```
cli.ts                        CLI entry point (run, generate, gen-types)
src/
  runtime/                    Async component model runtime
    index.ts                    Package exports
    types.ts                    EventCode, CallbackCode, SubtaskState, constants
    component-state.ts          Per-component tables, exclusive lock, backpressure
    event-loop.ts               EventLoop (drives callback-mode tasks)
    stream.ts                   SharedStreamImpl + ReadableStreamEnd/WritableStreamEnd
    future.ts                   ReadableFutureEnd/WritableFutureEnd (one-shot)
    subtask.ts                  Subtask (tracks async import calls)
    task.ts                     AsyncTask (id, result, context storage)
    waitable.ts                 Waitable base class (has pending event, belongs to set)
    waitable-set.ts             WaitableSet (poll/wait for events)
    handle-table.ts             Generic sparse array for handles
    call-context.ts             Cross-component call support
    jspi.ts                     JSPI helpers (promising/suspending)
    trace.ts                    Runtime tracing (P3_TRACE=1)
  parser/                     Component binary parser
    parse.ts                    Entry point: Uint8Array → ParsedComponent
    types.ts                    IR types for parsed component binary
    binary-reader.ts            Low-level binary cursor (LEB128, strings, vectors)
    component-parser.ts         Main component binary parser
    canonical-parser.ts         Canon lift/lower/builtin opcodes
    type-parser.ts              Component type section parser
    section-parsers.ts          Other section parsers
    name-section-parser.ts      Name section parser
    print.ts                    WAT-like text printer for ParsedComponent
  codegen/                    Code generator
    index.ts                    Package exports
    codegen.ts                  Entry point: ParsedComponent → generated source
    link.ts                     Phase 1: index space linking
    link-types.ts               Linked IR types (trampolines, instances, memories)
    link-host-types.ts          Instance type scope resolution for host imports
    emit.ts                     Phase 2: JS/TS source emission
    flatten.ts                  Canonical ABI type flattening
    host-types.ts               Host import type descriptors and TS conversion
  wasi/                       WASI host implementations
    index.ts                    Package exports
    wasi-host.ts                Node.js WASI host
    wasi-browser.ts             Browser WASI host
    wasi-shared.ts              Shared WASI helpers (P2/P3 stubs, version maps)
    wasi-filesystem.ts          Filesystem implementation
    wasi-sockets.ts             TCP/UDP/DNS implementation
    wasi-http.ts                HTTP client/handler implementation
    wasi-types.generated.ts     Generated TypeScript types from WIT
  wit/                        WIT parser and type emitter
    parser.ts                   WIT text parser (tokenizer + recursive descent)
    emit-types.ts               WIT → TypeScript type declarations
test/
    runner.ts                   Custom parallel test runner
    run.ts                      Entry point (imports all tests, calls run())
    integration.ts              WAT + spec WAST integration pipeline
    generate.test.ts            End-to-end test for standalone codegen
    guest-integration.ts        Go/Rust guest integration tests
    pipeline.ts                 Test pipeline helpers
    wasmtime-p3.ts              Ported wasmtime P3 tests
    unit/                       Runtime unit tests
    wat/                        Custom WAT integration tests
    spec/                       Component model spec WAST tests
    guest/                      Go and Rust guest test components
    imports/                    Host import implementations for tests
demo/                         Calculator demo (Rust guest, browser + Node.js)
```

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at your option.
