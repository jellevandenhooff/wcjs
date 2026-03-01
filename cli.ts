#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning --stack-size=4194304
// wcjs — WebAssembly Component JS toolchain
//
// Usage:
//   wcjs run <component.wasm> [options] [-- guest-args...]
//   wcjs generate <component.wasm> [-o <dir>] [--name <name>] [--jspi]

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseComponent, generateCode } from './src/codegen/index.ts';
import { createWasiHost } from './src/wasi/wasi-host.ts';
import * as runtime from './src/runtime/index.ts';
import { parseWitDirectory, parseWitSource } from './src/wit/parser.ts';
import { emitHostImportTypesFromWit } from './src/wit/emit-types.ts';

// ---- Subcommand dispatch ----

const USAGE = `usage: wcjs <command> [args...]

Commands:
  run          Run a WASI component
  generate     Generate JS + .d.ts from a component
  gen-types    Generate TypeScript host type declarations from WIT`;

const subcommand = process.argv[2];
if (!subcommand || subcommand === '--help' || subcommand === '-h') {
  console.error(USAGE);
  process.exit(2);
}

switch (subcommand) {
  case 'run':
    runCommand(process.argv.slice(3));
    break;
  case 'generate':
    generateCommand(process.argv.slice(3));
    break;
  case 'gen-types':
    genTypesCommand(process.argv.slice(3));
    break;
  default:
    console.error(`error: unknown command: ${subcommand}\n\n${USAGE}`);
    process.exit(2);
}

// ---- run command ----

interface RunArgs {
  wasmPath: string;
  guestArgs: string[];
  dirs: [string, string][];
  env: [string, string][];
  inheritEnv: boolean;
  inheritNetwork: boolean;
  jspi: boolean;
}

function parseRunArgs(argv: string[]): RunArgs {
  const dirs: [string, string][] = [];
  const env: [string, string][] = [];
  let inheritEnv = false;
  let inheritNetwork = false;
  let jspi = false;
  let wasmPath: string | null = null;
  let guestArgs: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '--') {
      guestArgs = argv.slice(i + 1);
      break;
    }
    if (arg === '--dir') {
      const val = argv[++i];
      if (!val) { console.error('error: --dir requires a value (guest=host)'); process.exit(2); }
      const eq = val.indexOf('=');
      if (eq === -1) { console.error('error: --dir value must be guest=host'); process.exit(2); }
      dirs.push([val.slice(0, eq), val.slice(eq + 1)]);
    } else if (arg === '--env') {
      const val = argv[++i];
      if (!val) { console.error('error: --env requires KEY=VALUE'); process.exit(2); }
      const eq = val.indexOf('=');
      if (eq === -1) { console.error('error: --env value must be KEY=VALUE'); process.exit(2); }
      env.push([val.slice(0, eq), val.slice(eq + 1)]);
    } else if (arg === '--inherit-env') {
      inheritEnv = true;
    } else if (arg === '--inherit-network') {
      inheritNetwork = true;
    } else if (arg === '--jspi') {
      jspi = true;
    } else if (arg === '--no-jspi') {
      jspi = false;
    } else if (arg.startsWith('-')) {
      console.error(`error: unknown option: ${arg}`);
      process.exit(2);
    } else {
      wasmPath = arg;
      if (i + 1 < argv.length && argv[i + 1] === '--') {
        guestArgs = argv.slice(i + 2);
      } else {
        guestArgs = argv.slice(i + 1);
      }
      break;
    }
    i++;
  }

  if (!wasmPath) {
    console.error(`usage: wcjs run [options] <component.wasm> [-- guest-args...]

Options:
  --dir <guest=host>    Mount host directory at guest path (repeatable)
  --env KEY=VALUE       Set guest env var (repeatable)
  --inherit-env         Pass all host env vars to guest
  --inherit-network     Allow TCP, UDP, DNS
  --jspi                Enable JSPI mode (default: callback mode)`);
    process.exit(2);
  }

  return { wasmPath, guestArgs, dirs, env, inheritEnv, inheritNetwork, jspi };
}

function runCommand(argv: string[]): void {
  const args = parseRunArgs(argv);

  async function main() {
    if (process.env.P3_TRACE) runtime.trace.enabled = true;

    // Memory watchdog
    const maxRssMb = parseInt(process.env.P3_MAX_RSS_MB || '4096', 10);
    const memWatchdog = setInterval(() => {
      const rssMb = process.memoryUsage.rss() / (1024 * 1024);
      if (rssMb > maxRssMb) {
        console.error(`wcjs: OOM killed (RSS ${Math.round(rssMb)}MB > ${maxRssMb}MB cap)`);
        process.exit(137);
      }
    }, 1000);
    memWatchdog.unref();

    const wasmBytes = new Uint8Array(readFileSync(args.wasmPath));
    const name = basename(args.wasmPath, '.wasm').replace(/\.component$/, '');
    const parsed = parseComponent(wasmBytes);
    const result = generateCode(parsed, name, { jspiMode: args.jspi, mode: 'js' });

    const coreModules = new Map(result.coreModules.map(m => [m.fileName, m.bytes]));
    const getCoreModule = (path: string) => new WebAssembly.Module(coreModules.get(path)! as BufferSource);

    const envVars: [string, string][] = [...args.env];
    if (args.inheritEnv) {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) envVars.push([k, v]);
      }
    }

    const preopens: [string, string][] | undefined = args.dirs.length > 0 ? args.dirs : undefined;

    const wasiHost = createWasiHost({
      args: [basename(args.wasmPath), ...args.guestArgs],
      env: envVars.length > 0 ? envVars : undefined,
      stdout: process.stdout,
      stderr: process.stderr,
      preopens,
    });

    const instantiate = new Function('runtime', result.source)(runtime);
    const instance = await instantiate(getCoreModule, wasiHost);
    wasiHost._ctx.state = instance.$states[0];

    const runKey = Object.keys(instance).find(k => k.startsWith('wasi:cli/run@'));
    if (!runKey || typeof instance[runKey]?.run !== 'function') {
      console.error(`error: component does not export wasi:cli/run (exports: ${Object.keys(instance).join(', ')})`);
      process.exit(1);
    }

    const runResult = await instance[runKey].run();
    if (instance.$destroy) instance.$destroy();

    const exitCode = (runResult && typeof runResult === 'object' && 'tag' in runResult && runResult.tag === 'err') ? 1 : 0;
    process.exit(exitCode);
  }

  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// ---- generate command ----

interface GenerateArgs {
  wasmPath: string;
  outDir: string;
  name: string;
  jspi: boolean;
}

function parseGenerateArgs(argv: string[]): GenerateArgs {
  let wasmPath: string | null = null;
  let outDir: string | null = null;
  let name: string | null = null;
  let jspi = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '-o' || arg === '--output') {
      outDir = argv[++i] ?? null;
      if (!outDir) { console.error('error: -o requires a directory path'); process.exit(2); }
    } else if (arg === '--name') {
      name = argv[++i] ?? null;
      if (!name) { console.error('error: --name requires a value'); process.exit(2); }
    } else if (arg === '--jspi') {
      jspi = true;
    } else if (arg === '--no-jspi') {
      jspi = false;
    } else if (arg.startsWith('-')) {
      console.error(`error: unknown option: ${arg}`);
      process.exit(2);
    } else {
      wasmPath = arg;
    }
    i++;
  }

  if (!wasmPath) {
    console.error(`usage: wcjs generate <component.wasm> [-o <dir>] [--name <name>] [--jspi]

Options:
  -o, --output <dir>    Output directory (default: ./<name>)
  --name <name>         Module name (default: derived from wasm filename)
  --jspi                Enable JSPI mode (default: callback mode)`);
    process.exit(2);
  }

  if (!name) {
    name = basename(wasmPath, '.wasm').replace(/\.component$/, '');
  }
  if (!outDir) {
    outDir = resolve('.', name);
  }

  return { wasmPath, outDir: resolve(outDir), name, jspi };
}

function generateCommand(argv: string[]): void {
  const args = parseGenerateArgs(argv);

  const wasmBytes = new Uint8Array(readFileSync(args.wasmPath));
  const parsed = parseComponent(wasmBytes);
  const result = generateCode(parsed, args.name, { jspiMode: args.jspi, mode: 'standalone' });

  mkdirSync(args.outDir, { recursive: true });

  // Write JS module
  const jsPath = join(args.outDir, `${args.name}.js`);
  writeFileSync(jsPath, result.source);
  console.log(`  ${jsPath}`);

  // Write .d.ts declarations
  if (result.declarations) {
    const dtsPath = join(args.outDir, `${args.name}.d.ts`);
    writeFileSync(dtsPath, result.declarations);
    console.log(`  ${dtsPath}`);
  }

  // Write core modules
  for (const mod of result.coreModules) {
    const modPath = join(args.outDir, mod.fileName);
    mkdirSync(join(args.outDir, mod.fileName, '..'), { recursive: true });
    writeFileSync(modPath, mod.bytes);
    console.log(`  ${modPath}`);
  }
}

// ---- gen-types command ----

interface GenTypesArgs {
  p3Sources: string[];
  p2Sources: string[];
  output: string | null;
}

function parseGenTypesArgs(argv: string[]): GenTypesArgs {
  const p3Sources: string[] = [];
  const p2Sources: string[] = [];
  let output: string | null = null;
  let parsingP2 = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '-o' || arg === '--output') {
      output = argv[++i] ?? null;
      if (!output) { console.error('error: -o requires a file path'); process.exit(2); }
      parsingP2 = false;
    } else if (arg === '--p2') {
      parsingP2 = true;
    } else if (arg.startsWith('-')) {
      console.error(`error: unknown option: ${arg}`);
      process.exit(2);
    } else {
      (parsingP2 ? p2Sources : p3Sources).push(resolve(arg));
    }
    i++;
  }

  if (p3Sources.length === 0) {
    console.error(`usage: wcjs gen-types <p3-wit-path>... [--p2 <p2-wit-path>...] [-o <output>]

Generate TypeScript host type declarations from WIT source files.

Positional args are P3 WIT sources (directories or .wit files).
After --p2, args are P2 WIT sources. Output goes to stdout unless -o is given.

Example:
  wcjs gen-types deps/wasi deps/http.wit --p2 deps/wasi-p2 -o src/wasi/types.ts`);
    process.exit(2);
  }

  return { p3Sources, p2Sources, output };
}

function genTypesCommand(argv: string[]): void {
  const args = parseGenTypesArgs(argv);

  function loadWitSources(paths: string[]) {
    const packages = [];
    for (const p of paths) {
      if (statSync(p).isDirectory()) {
        packages.push(...parseWitDirectory(p));
      } else {
        packages.push(parseWitSource(readFileSync(p, 'utf-8')));
      }
    }
    return packages;
  }

  const p3Packages = loadWitSources(args.p3Sources);
  const p2Packages = loadWitSources(args.p2Sources);
  const result = emitHostImportTypesFromWit(p3Packages, p2Packages);

  if (args.output) {
    writeFileSync(args.output, result);
    console.log(`Generated ${args.output}`);
  } else {
    process.stdout.write(result);
  }
}
