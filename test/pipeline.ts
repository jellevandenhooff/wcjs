// Shared compilation and instantiation pipeline for tests.
//
// Handles both codegen modes:
//   'ts' — generate TypeScript, compile with tsgo, dynamic import
//   'js' — generate plain JS, execute via new Function()

import { parseComponent, generateCode } from '../src/codegen/index.ts';
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as runtime from '../src/runtime/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export type CodegenMode = 'ts' | 'js';
export const MODES: CodegenMode[] = ['ts', 'js'];

export function spawnAsync(
  cmd: string, args: string[], opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = nodeSpawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout!.on('data', (d: Buffer) => { stdout += d; });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(' ')} failed (exit ${code}):\nstdout: ${stdout}\nstderr: ${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

export async function compileWat(watPath: string, wasmPath: string): Promise<void> {
  await spawnAsync('wasm-tools', ['parse', watPath, '-o', wasmPath]);
  await spawnAsync('wasm-tools', [
    'validate', '--features', 'cm-async,cm-async-builtins,cm-async-stackful,cm-threading', wasmPath,
  ]);
}

/**
 * Parse, generate code, and instantiate a component.
 *
 * In 'ts' mode: writes TS + core modules to outDir, compiles via tsgo,
 * dynamically imports the resulting JS.
 *
 * In 'js' mode: generates plain JS in-memory, executes via new Function().
 * No disk writes needed (except the wasm file must already exist).
 */
export async function instantiate(
  name: string,
  wasmPath: string,
  imports: Record<string, unknown>,
  opts: { jspi?: boolean; mode?: CodegenMode; outDir?: string } = {},
): Promise<any> {
  const mode = opts.mode || 'ts';
  const jspi = opts.jspi || false;

  const wasmBytes = new Uint8Array(readFileSync(wasmPath));
  const parsed = parseComponent(wasmBytes);

  if (mode === 'js') {
    const result = generateCode(parsed, name, { jspiMode: jspi, mode: 'js' });
    const coreModules = new Map(result.coreModules.map(m => [m.fileName, m.bytes]));
    const getCoreModule = (path: string) => {
      const bytes = coreModules.get(path)!;
      return new WebAssembly.Module(bytes as unknown as BufferSource);
    };
    const instantiateFn = new Function('runtime', result.source)(runtime);
    return instantiateFn(getCoreModule, imports);
  } else {
    const outDir = opts.outDir;
    if (!outDir) throw new Error('outDir is required for ts mode');

    const result = generateCode(parsed, name, { jspiMode: jspi });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${name}.ts`), result.source);
    for (const mod of result.coreModules) {
      const modPath = join(outDir, mod.fileName);
      mkdirSync(dirname(modPath), { recursive: true });
      writeFileSync(modPath, mod.bytes);
    }

    const tsPath = join(outDir, `${name}.ts`);
    await spawnAsync('npx', [
      'tsgo', '--ignoreConfig',
      '--module', 'ES2022', '--target', 'ES2022',
      '--moduleResolution', 'bundler',
      '--allowImportingTsExtensions', 'true',
      '--rewriteRelativeImportExtensions', 'true',
      '--declaration', 'false', '--sourceMap', 'false',
      '--strict', 'true', '--skipLibCheck', 'true',
      '--rootDir', outDir,
      '--outDir', outDir,
      tsPath,
    ], { cwd: ROOT });

    const jsPath = tsPath.replace(/\.ts$/, '.js');
    const module = await import(jsPath + `?t=${Date.now()}`);
    const getCoreModule = (path: string) => {
      const bytes = readFileSync(join(outDir, path));
      return new WebAssembly.Module(bytes);
    };
    return module.instantiate(getCoreModule, imports);
  }
}
