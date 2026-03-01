// Browser WASI P3 Host Implementation
//
// Provides a minimal WasiHost using browser-safe APIs.
// Filesystem, sockets, and HTTP return error stubs; clocks, random, CLI, and
// stdout/stderr work fully. Stdout/stderr are tee'd to console.log/warn.

import type { WasiHost } from './wasi-host.ts';
import {
  type HostContext,
  addAsyncAliases,
  versionP3Ifaces,
  p2Stubs,
  createCommonP3Ifaces,
} from './wasi-shared.ts';

// ---- Options ----

interface BrowserWasiHostOptions {
  args?: string[];
  env?: [string, string][];
  stdout?: string[] | { write(s: string): void };
  stderr?: string[] | { write(s: string): void };
}

// ---- Main browser host factory ----

export function createBrowserWasiHost(opts: BrowserWasiHostOptions = {}): WasiHost {
  const stdoutArr = opts.stdout || ([] as string[]);
  const stderrArr = opts.stderr || ([] as string[]);
  const ctx: HostContext = { state: null };

  // In browser, tee stdout/stderr to console
  const stdoutTarget: { write(s: string): void } = Array.isArray(stdoutArr)
    ? { write(s: string) { (stdoutArr as string[]).push(s); console.log(s.trimEnd()); } }
    : stdoutArr;
  const stderrTarget: { write(s: string): void } = Array.isArray(stderrArr)
    ? { write(s: string) { (stderrArr as string[]).push(s); console.warn(s.trimEnd()); } }
    : stderrArr;

  // Build common P3 interfaces (clocks, random, CLI, stdio)
  const common = createCommonP3Ifaces(ctx, {
    args: opts.args,
    env: opts.env,
    stdoutTarget,
    stderrTarget,
  });

  // Build full P3 interface set (common + browser-specific)
  const p3Ifaces: Record<string, Record<string, Function>> = {
    ...common,
    // Browser-specific: monotonic clock using performance.now()
    'wasi:clocks/monotonic-clock': {
      'now': () => BigInt(Math.round(performance.now() * 1_000_000)),
      'get-resolution': () => 1_000n,
      'wait-for': (durationNs: bigint) => {
        if (durationNs <= 0n) return;
        const ms = Number(durationNs) / 1_000_000;
        return new Promise<void>(resolve => setTimeout(resolve, ms));
      },
      'wait-until': (when: bigint) => {
        const now = BigInt(Math.round(performance.now() * 1_000_000));
        if (when <= now) return;
        const ms = Number(when - now) / 1_000_000;
        return new Promise<void>(resolve => setTimeout(resolve, ms));
      },
    },
    // Filesystem: error stubs (no filesystem in browser)
    'wasi:filesystem/types': {
      '[resource-drop]descriptor': () => {},
      '[resource-drop]directory-entry-stream': () => {},
      'stat': () => ({ tag: 'err', val: 'unsupported' }),
      'stat-at': () => ({ tag: 'err', val: 'unsupported' }),
      'open-at': () => ({ tag: 'err', val: 'unsupported' }),
      'read': () => ({ tag: 'err', val: 'unsupported' }),
      'write': () => ({ tag: 'err', val: 'unsupported' }),
      'read-directory': () => ({ tag: 'err', val: 'unsupported' }),
      'append-via-stream': () => ({ tag: 'err', val: 'unsupported' }),
      'write-via-stream': () => ({ tag: 'err', val: 'unsupported' }),
      'get-type': () => ({ tag: 'err', val: 'unsupported' }),
      'get-flags': () => ({ tag: 'err', val: 'unsupported' }),
      'set-times': () => ({ tag: 'err', val: 'unsupported' }),
      'set-times-at': () => ({ tag: 'err', val: 'unsupported' }),
      'unlink-file-at': () => ({ tag: 'err', val: 'unsupported' }),
      'remove-directory-at': () => ({ tag: 'err', val: 'unsupported' }),
      'rename-at': () => ({ tag: 'err', val: 'unsupported' }),
      'create-directory-at': () => ({ tag: 'err', val: 'unsupported' }),
      'link-at': () => ({ tag: 'err', val: 'unsupported' }),
      'symlink-at': () => ({ tag: 'err', val: 'unsupported' }),
      'readlink-at': () => ({ tag: 'err', val: 'unsupported' }),
      'metadata-hash': () => ({ tag: 'err', val: 'unsupported' }),
      'metadata-hash-at': () => ({ tag: 'err', val: 'unsupported' }),
      'read-via-stream': () => ({ tag: 'err', val: 'unsupported' }),
      'filesystem-error-code': () => null,
    },
    'wasi:filesystem/preopens': {
      'get-directories': () => [],
    },
    // Sockets: error stubs (no raw sockets in browser)
    'wasi:sockets/types': {
      '[resource-drop]tcp-socket': () => {},
      '[resource-drop]udp-socket': () => {},
      'tcp-create-socket': () => ({ tag: 'err', val: 'not-supported' }),
      'udp-create-socket': () => ({ tag: 'err', val: 'not-supported' }),
    },
    'wasi:sockets/ip-name-lookup': {
      'resolve-addresses': () => ({ tag: 'err', val: 'permanent-resolver-failure' }),
    },
    // HTTP: stubs (could use fetch() in a more complete implementation)
    'wasi:http/types': {
      '[resource-drop]fields': () => {},
      '[resource-drop]incoming-request': () => {},
      '[resource-drop]outgoing-request': () => {},
      '[resource-drop]response-outparam': () => {},
      '[resource-drop]incoming-response': () => {},
      '[resource-drop]outgoing-response': () => {},
      '[resource-drop]incoming-body': () => {},
      '[resource-drop]outgoing-body': () => {},
      '[resource-drop]future-incoming-response': () => {},
      'http-error-code': () => null,
    },
    'wasi:http/client': {
      'send': () => ({ tag: 'err', val: 'internal-error' }),
    },
    'wasi:http/handler': {
      'handle': () => ({ tag: 'err', val: 'internal-error' }),
    },
  };

  addAsyncAliases(p3Ifaces, ctx);

  return {
    _stdout: stdoutArr,
    _stderr: stderrArr,
    _ctx: ctx,
    ...versionP3Ifaces(p3Ifaces),
    ...p2Stubs(opts, stdoutArr),
  } as WasiHost;
}
