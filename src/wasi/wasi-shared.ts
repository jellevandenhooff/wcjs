// Shared WASI host helpers — browser-safe, no Node.js dependencies.
//
// Used by both wasi-host.ts (Node.js) and wasi-browser.ts (browser).

import type { ReadableStreamEnd } from '../runtime/stream.ts';
import type { WritableStreamBuffer, CopyResult } from '../runtime/types.ts';
import type { ComponentState } from '../runtime/component-state.ts';

// ---- Host context ----

export interface HostContext {
  state: ComponentState | null;
  /** When true, response.new eagerly drains body stream and trailers future. */
  handlerMode?: boolean;
}

// ---- Host-side stream helpers ----

export class HostWritableBuffer implements WritableStreamBuffer {
  capacity: number;
  data: number[];
  progress: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.data = [];
    this.progress = 0;
  }
  remain(): number { return this.capacity - this.progress; }
  isZeroLength(): boolean { return this.capacity === 0; }
  write(items: unknown[]): void {
    for (let i = 0; i < items.length; i++) this.data.push(items[i] as number);
    this.progress += items.length;
  }
}

/**
 * Read a chunk from a ReadableStreamEnd on the host side.
 * Returns Uint8Array of data, or null if the stream was dropped/closed.
 */
export function hostReadChunk(readableEnd: ReadableStreamEnd): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const buffer = new HostWritableBuffer(65536);
    const onCopy = (reclaimBuffer: () => void) => {
      reclaimBuffer();
      resolve(new Uint8Array(buffer.data));
    };
    const onCopyDone = (result: CopyResult) => {
      // CopyResult: 0=COMPLETED, 1=DROPPED, 2=CANCELLED
      if (result === 1 || result === 2) {
        resolve(null);
      } else {
        resolve(new Uint8Array(buffer.data));
      }
    };
    readableEnd.copy(buffer, onCopy, onCopyDone);
  });
}

/**
 * Consume all data from a ReadableStreamEnd, collecting decoded text into output array.
 */
export async function consumeReadableStream(readableEnd: ReadableStreamEnd, output: string[]): Promise<void> {
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await hostReadChunk(readableEnd);
    if (!chunk) break;
    if (chunk.length > 0) {
      output.push(decoder.decode(chunk, { stream: true }));
    }
  }
}

/**
 * Consume all data from a ReadableStreamEnd, writing to a writable stream (e.g. process.stdout).
 */
export async function consumeAndPrint(readableEnd: ReadableStreamEnd, stream: { write(s: string): void }): Promise<void> {
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await hostReadChunk(readableEnd);
    if (!chunk) break;
    if (chunk.length > 0) {
      stream.write(decoder.decode(chunk, { stream: true }));
    }
  }
}

// ---- Stream factory helpers ----

export function makeWriteViaStream(ctx: HostContext, target: string[] | { write(s: string): void }): (streamEndIdx: number) => Promise<{ tag: 'ok' }> {
  return (streamEndIdx: number) => {
    const state = ctx.state!;
    const streamEnd = state.liftStreamEnd(0, streamEndIdx) as ReadableStreamEnd;
    const consume = Array.isArray(target)
      ? consumeReadableStream(streamEnd, target)
      : consumeAndPrint(streamEnd, target);
    return consume.then(() => ({ tag: 'ok' as const }));
  };
}

export function makeReadViaStream(ctx: HostContext): () => number[] {
  return () => {
    const state = ctx.state!;
    const sPacked = state.streamNew(0);
    const sRi = Number(sPacked & 0xFFFFFFFFn);
    const sWi = Number(sPacked >> 32n);
    const fPacked = state.futureNew(0);
    const fRi = Number(fPacked & 0xFFFFFFFFn);
    const fWi = Number(fPacked >> 32n);
    state.streamDropWritable(0, sWi);
    state.futureWriteHost(0, fWi, [{ tag: 'ok' }]);
    return [sRi, fRi];
  };
}

// ---- Tracing ----

export const WASI_TRACE = typeof process !== 'undefined' && !!process.env?.P3_TRACE;

export function traceWrap<T extends object>(iface: string, methods: T): T {
  if (!WASI_TRACE) return methods;
  const wrapped: Record<string, Function> = {};
  for (const [name, fn] of Object.entries(methods)) {
    wrapped[name] = (...args: any[]) => {
      const argStr = args.map(a => {
        if (a instanceof Uint8Array) return `Uint8Array(${a.length})`;
        if (typeof a === 'bigint') return `${a}n`;
        if (typeof a === 'string' && a.length > 80) return `"${a.slice(0, 80)}..."`;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(', ');
      let result: any;
      try {
        result = fn(...args);
      } catch (e) {
        console.log(`[wasi] ${iface}#${name}(${argStr}) threw: ${e}`);
        throw e;
      }
      if (result instanceof Promise) {
        console.log(`[wasi] ${iface}#${name}(${argStr}) → Promise`);
        return result;
      }
      const resStr = typeof result === 'bigint' ? `${result}n`
        : result instanceof Uint8Array ? `Uint8Array(${result.length})`
        : (() => { try { return JSON.stringify(result, (_, v) => typeof v === 'bigint' ? `${v}n` : v); } catch { return String(result); } })();
      console.log(`[wasi] ${iface}#${name}(${argStr}) → ${resStr}`);
      return result;
    };
  }
  return wrapped as T;
}

// ---- P2 stubs ----

interface P2StubOptions {
  args?: string[];
  env?: [string, string][];
  cwd?: string;
}

export function p2Stubs(opts: P2StubOptions, stdoutTarget: string[] | { write(s: string): void }): Record<string, Record<string, (...args: any[]) => any>> {
  const writeOutput = (_handle: number, bytes: string | Uint8Array) => {
    const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
    if (Array.isArray(stdoutTarget)) {
      stdoutTarget.push(text);
    } else {
      stdoutTarget.write(text);
    }
    return { tag: 'ok' };
  };

  const defs: Record<string, Record<string, (...args: any[]) => any>> = {
    'wasi:cli/environment': {
      'get-environment': () => opts.env || [],
      'get-arguments': () => opts.args || [],
      'initial-cwd': () => opts.cwd || null,
    },
    'wasi:cli/exit': {
      'exit': (status: any) => {
        if (status?.tag === 'err') throw new Error('exit with error');
        if (status !== 0 && status?.tag !== 'ok') throw new Error(`exit with status ${status}`);
      },
    },
    'wasi:cli/stdin': { 'get-stdin': () => 0 },
    'wasi:cli/stdout': { 'get-stdout': () => 0 },
    'wasi:cli/stderr': { 'get-stderr': () => 0 },
    'wasi:cli/terminal-stdin': { 'get-terminal-stdin': () => null },
    'wasi:cli/terminal-stdout': { 'get-terminal-stdout': () => null },
    'wasi:cli/terminal-stderr': { 'get-terminal-stderr': () => null },
    'wasi:io/poll': { '[method]pollable.block': () => {} },
    'wasi:io/streams': {
      '[resource-drop]input-stream': () => {},
      '[resource-drop]output-stream': () => {},
      '[method]output-stream.check-write': () => ({ tag: 'ok', val: 4096n }),
      '[method]output-stream.write': writeOutput,
      '[method]output-stream.blocking-flush': () => ({ tag: 'ok' }),
      '[method]output-stream.blocking-write-and-flush': writeOutput,
      '[method]output-stream.subscribe': () => 0,
    },
    'wasi:io/error': { '[resource-drop]error': () => {} },
    'wasi:clocks/wall-clock': {
      'now': () => {
        const ms = Date.now();
        return { seconds: BigInt(Math.floor(ms / 1000)), nanoseconds: (ms % 1000) * 1_000_000 };
      },
      'get-resolution': () => 1_000_000n,
    },
    'wasi:filesystem/types': {
      '[resource-drop]descriptor': () => {},
      '[resource-drop]directory-entry-stream': () => {},
      '[method]descriptor.append-via-stream': () => ({ tag: 'err', val: 'unsupported' }),
      '[method]descriptor.get-type': () => ({ tag: 'err', val: 'unsupported' }),
      '[method]descriptor.get-flags': () => ({ tag: 'err', val: 'unsupported' }),
      '[method]descriptor.stat': () => ({ tag: 'err', val: 'unsupported' }),
      '[method]descriptor.write-via-stream': () => ({ tag: 'err', val: 'unsupported' }),
      'filesystem-error-code': () => null,
    },
    'wasi:filesystem/preopens': { 'get-directories': () => [] },
  };
  const result: Record<string, Record<string, (...args: any[]) => any>> = {};
  for (const ver of ['0.2.0', '0.2.1', '0.2.2', '0.2.3', '0.2.4', '0.2.5', '0.2.6']) {
    for (const [iface, methods] of Object.entries(defs)) {
      result[`${iface}@${ver}`] = methods;
    }
  }
  return result;
}

// ---- Async aliasing ----

/**
 * Add [async] aliases for all methods in P3 interfaces, and reverse sync wrappers.
 */
export function addAsyncAliases(p3Ifaces: Record<string, Record<string, Function>>, ctx: HostContext): void {
  for (const methods of Object.values(p3Ifaces)) {
    for (const name of Object.keys(methods)) {
      if (typeof methods[name] !== 'function') continue;
      if (name.startsWith('[async]') || name.startsWith('[async ')) continue;
      const asyncName = name.startsWith('[') ? '[async ' + name.slice(1) : '[async]' + name;
      if (!(asyncName in methods)) {
        methods[asyncName] = methods[name]!;
      }
    }
  }

  // Reverse: [async]foo → foo sync wrapper with future handle
  for (const methods of Object.values(p3Ifaces)) {
    for (const name of Object.keys(methods)) {
      if (typeof methods[name] !== 'function') continue;
      if (!name.startsWith('[async]') && !name.startsWith('[async ')) continue;
      const syncName = name.startsWith('[async]') ? name.slice(7) : '[' + name.slice(7);
      if (syncName in methods) continue;
      const asyncFn = methods[name]!;
      methods[syncName] = (...args: unknown[]) => {
        const result = asyncFn(...args);
        if (result && typeof (result as any).then === 'function') {
          const state = ctx.state!;
          const fPacked = state.futureNew(0);
          const fRi = Number(fPacked & 0xFFFFFFFFn);
          const fWi = Number(fPacked >> 32n);
          state.trackHostAsync((result as Promise<unknown>).then(
            val => { state.futureWriteHost(0, fWi, [val]); },
            () => { try { state.futureWriteHost(0, fWi, [{ tag: 'ok' }]); } catch (_) {} }
          ));
          return fRi;
        }
        return result;
      };
    }
  }
}

// ---- Versioned P3 interface registration ----

export const P3_VERSIONS = ['0.3.0-rc-2025-09-16', '0.3.0-rc-2026-02-09'];

export function versionP3Ifaces(p3Ifaces: Record<string, object>): Record<string, object> {
  const result: Record<string, object> = {};
  for (const [iface, methods] of Object.entries(p3Ifaces)) {
    for (const ver of P3_VERSIONS) {
      result[`${iface}@${ver}`] = methods;
    }
  }
  return result;
}

// ---- Common P3 interface implementations (browser-safe) ----

export function createSystemClockImpl() {
  return {
    'now': () => {
      const ms = Date.now();
      return { seconds: BigInt(Math.floor(ms / 1000)), nanoseconds: (ms % 1000) * 1_000_000 };
    },
    'get-resolution': () => 1_000_000n,
  };
}

export function createInsecureRandomImpl() {
  return {
    'get-insecure-random-bytes': (len: bigint) => {
      const n = Number(len);
      const buf = new Uint8Array(n);
      for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
      return buf;
    },
    'get-insecure-random-u64': () => {
      const hi = BigInt(Math.floor(Math.random() * 2 ** 32));
      const lo = BigInt(Math.floor(Math.random() * 2 ** 32));
      return (hi << 32n) | lo;
    },
  };
}

export function createRandomImpl() {
  return {
    'get-random-bytes': (len: bigint) => {
      const n = Number(len);
      const buf = new Uint8Array(n);
      // globalThis.crypto works in both Node 19+ and browsers
      for (let i = 0; i < n; i += 65536) {
        globalThis.crypto.getRandomValues(buf.subarray(i, Math.min(i + 65536, n)));
      }
      return buf;
    },
    'get-random-u64': () => {
      const buf = new Uint8Array(8);
      globalThis.crypto.getRandomValues(buf);
      const view = new DataView(buf.buffer);
      return view.getBigUint64(0, true);
    },
  };
}

export function createCommonP3Ifaces(ctx: HostContext, opts: {
  args?: string[];
  env?: [string, string][];
  cwd?: string;
  stdoutTarget: string[] | { write(s: string): void };
  stderrTarget: string[] | { write(s: string): void };
}): Record<string, Record<string, Function>> {
  const insecureSeed = [
    BigInt(Math.floor(Math.random() * 2 ** 52)),
    BigInt(Math.floor(Math.random() * 2 ** 52)),
  ];

  return {
    'wasi:clocks/types': {},
    'wasi:clocks/system-clock': createSystemClockImpl(),
    'wasi:random/random': createRandomImpl(),
    'wasi:random/insecure': createInsecureRandomImpl(),
    'wasi:random/insecure-seed': {
      'get-insecure-seed': () => insecureSeed,
    },
    'wasi:cli/stdout': {
      '[async]write-via-stream': makeWriteViaStream(ctx, opts.stdoutTarget),
    },
    'wasi:cli/stdin': {
      'read-via-stream': makeReadViaStream(ctx),
    },
    'wasi:cli/stderr': {
      '[async]write-via-stream': makeWriteViaStream(ctx, opts.stderrTarget),
    },
    'wasi:cli/types': {},
    'wasi:cli/environment': {
      'get-arguments': () => opts.args || [],
      'get-environment': () => opts.env || [],
      'get-initial-cwd': () => opts.cwd || null,
    },
    'wasi:cli/exit': {
      'exit': (status: any) => {
        if (status?.tag === 'err') throw new Error('exit with error');
        if (status !== 0 && status?.tag !== 'ok') throw new Error(`exit with status ${status}`);
      },
      'exit-with-code': (code: number) => { if (code !== 0) throw new Error(`exit with code ${code}`); },
    },
    'wasi:cli/terminal-input': { '[resource-drop]terminal-input': () => {} },
    'wasi:cli/terminal-output': { '[resource-drop]terminal-output': () => {} },
    'wasi:cli/terminal-stdin': { 'get-terminal-stdin': () => null },
    'wasi:cli/terminal-stdout': { 'get-terminal-stdout': () => null },
    'wasi:cli/terminal-stderr': { 'get-terminal-stderr': () => null },
  };
}
