// WASI P3 Host Implementation
//
// Provides default WASI host function implementations for running
// WASI P3 components. Used by both the test harness and the CLI runner.

import { createSocketHost, createNameLookupHost } from './wasi-sockets.ts';
import { createFilesystemHost } from './wasi-filesystem.ts';
import { createHttpTypesHost, createHttpClientHost, createHttpHandlerHost } from './wasi-http.ts';
import { createExecHost } from './wasi-exec.ts';
import {
  type HostContext,
  WASI_TRACE,
  traceWrap,
  p2Stubs,
  versionP3Ifaces,
  createCommonP3Ifaces,
} from './wasi-shared.ts';
import type { WasiHostInterfaces } from './wasi-types.generated.ts';

// Re-export shared helpers for backward compatibility
export { HostWritableBuffer, hostReadChunk, consumeReadableStream, consumeAndPrint } from './wasi-shared.ts';
export type { HostContext } from './wasi-shared.ts';

// ---- Options ----

interface WasiHostOptions {
  args?: string[];
  env?: [string, string][];
  cwd?: string;
  stdout?: string[] | { write(s: string): void };
  stderr?: string[] | { write(s: string): void };
  preopens?: [string, string][];  // [guest-path, host-path] pairs
}

// ---- WasiHost type ----

export type WasiHost = WasiHostInterfaces & {
  _stdout: string[] | { write(s: string): void };
  _stderr: string[] | { write(s: string): void };
  _ctx: HostContext;
};

// ---- Main host factory ----

export function createWasiHost(opts: WasiHostOptions = {}): WasiHost {
  const stdoutArr = opts.stdout || ([] as string[]);
  const stderrArr = opts.stderr || ([] as string[]);

  // When tracing, tee guest output to console so it interleaves with trace logs
  const stdoutTarget: string[] | { write(s: string): void } = WASI_TRACE
    ? { write(s: string) { if (Array.isArray(stdoutArr)) stdoutArr.push(s); console.log(`[guest stdout] ${s.trimEnd()}`); } }
    : stdoutArr;
  const stderrTarget: string[] | { write(s: string): void } = WASI_TRACE
    ? { write(s: string) { if (Array.isArray(stderrArr)) stderrArr.push(s); console.log(`[guest stderr] ${s.trimEnd()}`); } }
    : stderrArr;

  const ctx: HostContext = { state: null };
  const fsHost = createFilesystemHost(ctx, { preopens: opts.preopens });

  // Build common P3 interfaces (clocks, random, CLI, stdio)
  const common = createCommonP3Ifaces(ctx, {
    args: opts.args,
    env: opts.env || [['HOME', '/tmp']],
    cwd: opts.cwd,
    stdoutTarget,
    stderrTarget,
  });

  // Build full P3 interface set (common + Node.js-specific)
  const p3Ifaces: Record<string, object> = {
    ...common,
    // Node.js-specific: high-resolution monotonic clock
    'wasi:clocks/monotonic-clock': {
      'now': () => process.hrtime.bigint(),
      'get-resolution': () => 1n,
      'wait-for': (durationNs: bigint) => {
        if (durationNs <= 0n) return;
        const target = process.hrtime.bigint() + durationNs;
        const ms = Number(durationNs) / 1_000_000;
        return new Promise<void>(resolve => {
          const check = () => {
            if (process.hrtime.bigint() >= target) resolve();
            else setTimeout(check, 0);
          };
          setTimeout(check, ms);
        });
      },
      'wait-until': (when: bigint) => {
        const now = process.hrtime.bigint();
        if (when <= now) return;
        const ms = Number(when - now) / 1_000_000;
        return new Promise<void>(resolve => {
          const check = () => {
            if (process.hrtime.bigint() >= when) resolve();
            else setTimeout(check, 0);
          };
          setTimeout(check, ms);
        });
      },
    },
    // Node.js-specific: full implementations
    'wasi:http/types': createHttpTypesHost(ctx),
    'wasi:http/client': createHttpClientHost(ctx),
    'wasi:http/handler': createHttpHandlerHost(ctx),
    'wasi:filesystem/types': fsHost.types,
    'wasi:filesystem/preopens': fsHost.preopens,
    'wasi:sockets/types': createSocketHost(ctx),
    'wasi:sockets/ip-name-lookup': createNameLookupHost(),
  };

  // Apply tracing to all interfaces when P3_TRACE is enabled
  if (WASI_TRACE) {
    for (const key of Object.keys(p3Ifaces)) {
      const shortName = key.replace(/^wasi:/, '');
      p3Ifaces[key] = traceWrap(shortName, p3Ifaces[key]!);
    }
  }

  // Create wasi:exec/exec interface (versioned separately from WASI P3)
  const execHost = createExecHost(ctx, {
    preopens: opts.preopens,
    parentCtx: ctx,
  });
  const execVersioned: Record<string, object> = {
    'wasi:exec/exec@0.1.0': execHost,
  };

  return {
    _stdout: stdoutArr,
    _stderr: stderrArr,
    _ctx: ctx,
    ...versionP3Ifaces(p3Ifaces),
    ...execVersioned,
    ...p2Stubs({ args: opts.args, env: opts.env, cwd: opts.cwd }, stdoutArr),
  } as WasiHost;
}
