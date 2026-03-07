// WASI Exec Host — wasi:exec/exec implementation
//
// Provides the exec host function that loads, instantiates, and runs
// child WASI components. Used by the Go compiler toolchain when running
// as a wasip3 component inside wcjs.

import { readFileSync } from 'node:fs';
import { basename, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseComponent, generateCode } from '../codegen/index.ts';
import * as runtime from '../runtime/index.ts';
import { createWasiHost } from './wasi-host.ts';
import type { HostContext } from './wasi-shared.ts';

// Cache of compiled components: path → { instantiate, coreModules }
const componentCache = new Map<string, {
  instantiate: Function;
  coreModules: Map<string, WebAssembly.Module>;
}>();

// Cache of wasm-tools converted components: core module path → component bytes
const conversionCache = new Map<string, Uint8Array>();

interface ExecHostOptions {
  /** Parent's preopens for filesystem sharing */
  preopens?: [string, string][];
  /** WIT directory for core→component conversion */
  witDir?: string;
  /** Parent's HostContext */
  parentCtx: HostContext;
}

/**
 * Create the wasi:exec/exec host interface.
 */
export function createExecHost(ctx: HostContext, opts: ExecHostOptions) {
  return {
    // The host function returns a Promise. The component model's
    // async-lower machinery handles suspending the caller.
    'exec': async (
      path: string,
      args: string[],
      env: string[],
      cwd: string | null,
      stdoutPath: string,
      stderrPath: string,
    ): Promise<{ tag: 'ok'; val: number } | { tag: 'err'; val: string }> => {
      try {
        // Resolve path relative to cwd if not absolute
        const resolvedPath = path.startsWith('/') ? path : resolve(cwd || '.', path);

        // Read the wasm file
        let wasmBytes: Uint8Array;
        try {
          wasmBytes = new Uint8Array(readFileSync(resolvedPath));
        } catch (e: any) {
          return { tag: 'err', val: `exec: cannot read ${resolvedPath}: ${e.message}` };
        }

        // Check if this is a core module or component.
        // Component magic: 00 61 73 6d 0d 00 01 00 (version 13, layer 1)
        // Core module magic: 00 61 73 6d 01 00 00 00 (version 1, layer 0)
        const isComponent = wasmBytes[4] === 0x0d && wasmBytes[7] === 0x01;

        if (!isComponent) {
          // Convert core module to component using wasm-tools
          const cached = conversionCache.get(resolvedPath);
          if (cached) {
            wasmBytes = cached;
          } else {
            const converted = convertCoreToComponent(resolvedPath, wasmBytes, opts.witDir);
            if (!converted) {
              return { tag: 'err', val: `exec: failed to convert core module to component: ${resolvedPath}` };
            }
            wasmBytes = converted;
            conversionCache.set(resolvedPath, wasmBytes);
          }
        }

        // Check cache for parsed/generated code
        let cached = componentCache.get(resolvedPath);
        if (!cached) {
          const name = basename(resolvedPath, '.wasm').replace(/\.component$/, '');
          const parsed = parseComponent(wasmBytes);
          const result = generateCode(parsed, name, { jspiMode: false, mode: 'js' });
          const coreModules = new Map(
            result.coreModules.map(m => [m.fileName, new WebAssembly.Module(m.bytes as BufferSource)])
          );
          const instantiate = new Function('runtime', result.source)(runtime);
          cached = { instantiate, coreModules };
          componentCache.set(resolvedPath, cached);
        }

        // Build child env
        const envPairs: [string, string][] = env.map(e => {
          const eq = e.indexOf('=');
          if (eq === -1) return [e, ''] as [string, string];
          return [e.slice(0, eq), e.slice(eq + 1)] as [string, string];
        });

        // Capture stdout and stderr
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];

        // Create child WASI host with captured output
        const childWasiHost = createWasiHost({
          args: args,
          env: envPairs,
          cwd: cwd || undefined,
          stdout: stdoutChunks,
          stderr: stderrChunks,
          preopens: opts.preopens,
        });

        // Instantiate child component
        const getCoreModule = (p: string) => cached!.coreModules.get(p)!;
        const instance = await cached.instantiate(getCoreModule, childWasiHost);
        childWasiHost._ctx.state = instance.$states[0];

        // Run the child's wasi:cli/run export
        const runKey = Object.keys(instance).find(k => k.startsWith('wasi:cli/run@'));
        if (!runKey || typeof instance[runKey]?.run !== 'function') {
          if (instance.$destroy) instance.$destroy();
          return { tag: 'err', val: `exec: component does not export wasi:cli/run` };
        }

        let exitCode = 0;
        try {
          const runResult = await instance[runKey].run();
          if (runResult && typeof runResult === 'object' && 'tag' in runResult && runResult.tag === 'err') {
            exitCode = 1;
          }
        } catch (e: any) {
          // Check for exit-with-code pattern
          const m = e.message?.match(/exit with code (\d+)/);
          if (m) {
            exitCode = parseInt(m[1], 10);
          } else if (e.message?.includes('exit with error')) {
            exitCode = 1;
          } else {
            // Unexpected error — report it
            stderrChunks.push(`exec: ${e.message}\n`);
            exitCode = 1;
          }
        }

        if (instance.$destroy) instance.$destroy();

        // Write captured output to temp files for the caller to read
        const stdoutData = stdoutChunks.join('');
        const stderrData = stderrChunks.join('');
        if (stdoutData.length > 0) {
          writeFileSync(stdoutPath, stdoutData);
        }
        if (stderrData.length > 0) {
          writeFileSync(stderrPath, stderrData);
        }

        return { tag: 'ok', val: exitCode };
      } catch (e: any) {
        return { tag: 'err', val: `exec: ${e.message}` };
      }
    },
  };
}

/**
 * Convert a core wasm module to a component using wasm-tools.
 * Returns the component bytes, or null on failure.
 */
function convertCoreToComponent(
  path: string,
  coreBytes: Uint8Array,
  witDir?: string,
): Uint8Array | null {
  if (!witDir) {
    // Try to find WIT dir from GOROOT
    const goroot = process.env.GOROOT;
    if (goroot) {
      witDir = join(goroot, 'src', 'internal', 'wasi', 'wit');
    }
  }
  if (!witDir || !existsSync(witDir)) {
    console.error(`exec: WIT directory not found: ${witDir}`);
    return null;
  }

  try {
    // Write core module to temp file
    const tmp = mkdtempSync(join(tmpdir(), 'wcjs-exec-'));
    const corePath = join(tmp, 'core.wasm');
    const embeddedPath = join(tmp, 'embedded.wasm');
    const componentPath = join(tmp, 'component.wasm');

    writeFileSync(corePath, coreBytes);

    // Run wasm-tools component embed + new
    execFileSync('wasm-tools', [
      'component', 'embed', witDir, '--world', 'command', corePath, '-o', embeddedPath,
    ]);
    execFileSync('wasm-tools', [
      'component', 'new', embeddedPath, '-o', componentPath,
    ]);

    const result = new Uint8Array(readFileSync(componentPath));

    // Cleanup
    try { unlinkSync(corePath); } catch {}
    try { unlinkSync(embeddedPath); } catch {}
    try { unlinkSync(componentPath); } catch {}
    try { rmdirSync(tmp); } catch {}

    return result;
  } catch (e: any) {
    console.error(`exec: wasm-tools conversion failed: ${e.message}`);
    return null;
  }
}
