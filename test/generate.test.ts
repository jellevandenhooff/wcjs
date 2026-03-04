// Integration test for `wcjs generate` — standalone emit mode.
//
// Generates .js + .d.ts from a test component, type-checks the declarations,
// then imports and runs the generated module.

import { describe, it, assert } from './runner.ts';
import { parseComponent, generateCode } from '../src/codegen/index.ts';
import { createWasiHost } from '../src/wasi/wasi-host.ts';
import { compileWat, spawnAsync } from './pipeline.ts';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WAT_DIR = join(__dirname, 'wat');
const GEN_OUT = join(__dirname, 'out', 'generate');
const GUEST_OUT = join(__dirname, 'guest', 'out');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface GenerateOpts {
  jspiMode?: boolean;
}

/** Generate standalone JS + .d.ts from a component wasm, write to outDir. */
function generateAndWrite(
  name: string, wasmBytes: Uint8Array, opts: GenerateOpts = {},
): string {
  const outDir = join(GEN_OUT, name);
  mkdirSync(outDir, { recursive: true });

  const parsed = parseComponent(wasmBytes);
  const result = generateCode(parsed, name, {
    jspiMode: opts.jspiMode ?? false,
    mode: 'standalone',
  });

  writeFileSync(join(outDir, `${name}.js`), result.source);
  assert.ok(result.declarations, 'declarations should be present');
  writeFileSync(join(outDir, `${name}.d.ts`), result.declarations);
  for (const mod of result.coreModules) {
    const modPath = join(outDir, mod.fileName);
    mkdirSync(dirname(modPath), { recursive: true });
    writeFileSync(modPath, mod.bytes);
  }
  return outDir;
}

/** Type-check a test script against the generated .d.ts. */
async function typeCheck(outDir: string, testScript: string): Promise<void> {
  const testTsPath = join(outDir, '_test.ts');
  writeFileSync(testTsPath, testScript);

  await spawnAsync('npx', [
    'tsgo', '--ignoreConfig',
    '--module', 'ES2022', '--target', 'ES2022',
    '--moduleResolution', 'bundler',
    '--allowImportingTsExtensions', 'true',
    '--rewriteRelativeImportExtensions', 'true',
    '--declaration', 'false', '--sourceMap', 'false',
    '--strict', 'true', '--skipLibCheck', 'true',
    '--rootDir', '.',
    '--noEmit',
    testTsPath,
  ], { cwd: ROOT });
}

/** Import the generated JS module and instantiate it. */
async function importAndInstantiate(
  outDir: string, name: string, imports: Record<string, unknown>,
): Promise<Record<string, any>> {
  const jsUrl = pathToFileURL(join(outDir, `${name}.js`)).href;
  const module = await import(jsUrl + `?t=${Date.now()}`);
  return module.instantiate(imports);
}

/** Read a guest component wasm, or return null if not built. */
function readGuest(guestName: string): Uint8Array | null {
  const p = join(GUEST_OUT, guestName, 'component.wasm');
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
}

describe('generate', () => {
  it('produces .js + .d.ts that type-check and run (WAT)', async () => {
    const name = 'test1-callback';

    // Compile WAT → wasm
    const watPath = join(WAT_DIR, `${name}.wat`);
    const wasmPath = join(GEN_OUT, name, `${name}.wasm`);
    mkdirSync(dirname(wasmPath), { recursive: true });
    await compileWat(watPath, wasmPath);

    const wasmBytes = new Uint8Array(readFileSync(wasmPath));
    const outDir = generateAndWrite(name, wasmBytes);

    await typeCheck(outDir, `import { instantiate } from './${name}.js';
export async function main() {
  const instance = await instantiate({});
  return instance;
}
`);

    const instance = await importAndInstantiate(outDir, name, {});

    const runKey = Object.keys(instance).find(k => k !== '$states' && k !== '$destroy');
    assert.ok(runKey, 'should have an export');
    const result = await instance[runKey].run();
    assert.deepStrictEqual(result, { tag: 'ok' });
    if (instance.$destroy) instance.$destroy();
  });

  // Test with a full WASI guest component (go-hello)
  const goHelloBytes = readGuest('go-hello');
  if (goHelloBytes) {
    it('produces .js + .d.ts that type-check and run (WASI guest)', async () => {
      const name = 'go-hello';
      const outDir = generateAndWrite(name, goHelloBytes, { jspiMode: true });

      await typeCheck(outDir, `import type { Imports } from './${name}.js';
import { instantiate } from './${name}.js';
import type { WasiHost } from '@jellevdh/wcjs/wasi';

const _check: Imports = {} as WasiHost;

export async function main(imports: Imports) {
  const instance = await instantiate(imports);
  return instance;
}
`);

      const stdoutBuf: string[] = [];
      const wasiHost = createWasiHost({
        args: ['go-hello'],
        env: [['HOME', '/tmp']],
        stdout: stdoutBuf,
        stderr: [],
      });

      const instance = await importAndInstantiate(outDir, name, wasiHost);
      wasiHost._ctx.state = instance.$states[0];

      const runKey = Object.keys(instance).find(k => k.startsWith('wasi:cli/run@'));
      assert.ok(runKey, 'should have wasi:cli/run export');
      await instance[runKey].run();
      if (instance.$destroy) instance.$destroy();

      assert.ok(stdoutBuf.join('').includes('hello'), 'stdout should contain hello');
    });
  }

  // Test with custom WIT types (Rust guest with records, enums, lists, results, async)
  const typesTestBytes = readGuest('rust-types-test');
  if (typesTestBytes) {
    it('produces .js + .d.ts that type-check and run (custom WIT)', async () => {
      const name = 'types-test';
      const outDir = generateAndWrite(name, typesTestBytes, { jspiMode: true });

      await typeCheck(outDir, `import type { Imports } from './${name}.js';
import { instantiate } from './${name}.js';
import type { WasiHost } from '@jellevdh/wcjs/wasi';

export async function main(imports: Imports) {
  const instance = await instantiate(imports);
  const api = instance['test:types/api'];

  // Verify typed signatures compile correctly
  const s: string = await api.greet('World');
  const d: number = await api.computeDistance({ x: 0, y: 0 }, { x: 3, y: 4 });
  const c: number = await api.colorToNumber('red');
  const p: string = await api.describePerson({ name: 'Alice', age: 30 });
  const l: number[] = await api.reverseList([1, 2, 3]);
  const r: { tag: 'ok'; val: number } | { tag: 'err'; val: string } = await api.safeDivide(10, 2);
  const n: number = await api.doubleSum(3, 4);

  return { s, d, c, p, l, r, n };
}
`);

      const logs: string[] = [];
      const wasiHost = createWasiHost({ stdout: [], stderr: [] });

      const imports = {
        ...wasiHost,
        'test:types/host-fns': {
          'echo-string': (s: string) => s,
          'add-integers': (a: number, b: number) => a + b,
          'scale-point': (p: { x: number; y: number }, factor: number) => ({
            x: p.x * factor,
            y: p.y * factor,
          }),
          'sum-list': (nums: number[]) => nums.reduce((a: number, b: number) => a + b, 0),
          'async-double': async (n: number) => n * 2,
          'log': (msg: string) => { logs.push(msg); },
        },
      };

      const instance = await importAndInstantiate(outDir, name, imports);
      wasiHost._ctx.state = instance.$states[0];

      const api = instance['test:types/api'];
      assert.ok(api, 'should have test:types/api export');

      assert.equal(await api.greet('World'), 'Hello, World!');
      const dist = await api.computeDistance({ x: 0, y: 0 }, { x: 3, y: 4 });
      assert.equal(dist, 5);
      assert.equal(await api.colorToNumber('red'), 0xFF0000);
      assert.equal(await api.colorToNumber('green'), 0x00FF00);
      assert.equal(await api.colorToNumber('blue'), 0x0000FF);
      assert.equal(await api.describePerson({ name: 'Alice', age: 30 }), 'Alice is 30 years old');
      assert.deepStrictEqual(await api.reverseList([1, 2, 3, 4, 5]), [5, 4, 3, 2, 1]);

      const divOk = await api.safeDivide(10, 4);
      assert.equal(divOk.tag, 'ok');
      assert.equal(divOk.val, 2.5);
      const divErr = await api.safeDivide(1, 0);
      assert.equal(divErr.tag, 'err');
      assert.equal(divErr.val, 'division by zero');

      assert.equal(await api.doubleSum(3, 4), 14); // 3*2 + 4*2
      assert.ok(logs.some(l => l.includes('scaled')), 'scale-point import should have been called');
      assert.ok(logs.some(l => l.includes('sum before reverse')), 'sum-list import should have been called');

      if (instance.$destroy) instance.$destroy();
    });
  }

  // Test component with multiple exported interfaces (regression: export index
  // space tracking — each instance export creates a new index, so the second
  // exported interface must resolve correctly).
  const multiExportBytes = readGuest('rust-multi-export');
  if (multiExportBytes) {
    it('produces .js + .d.ts that type-check and run (multi-export)', async () => {
      const name = 'multi-export';
      const outDir = generateAndWrite(name, multiExportBytes, { jspiMode: true });

      await typeCheck(outDir, `import type { Imports } from './${name}.js';
import { instantiate } from './${name}.js';
import type { WasiHost } from '@jellevdh/wcjs/wasi';

export async function main(imports: Imports) {
  const instance = await instantiate(imports);
  const math = instance['test:multi/math'];
  const greeter = instance['test:multi/greeter'];

  const sum: number = await math.add(1, 2);
  const dsum: number = await math.doubleAdd(3, 4);
  const msg: string = await greeter.greet('World');

  return { sum, dsum, msg };
}
`);

      const wasiHost = createWasiHost({ stdout: [], stderr: [] });
      const imports = {
        ...wasiHost,
        'test:multi/host': {
          double: async (n: number) => n * 2,
        },
      };

      const instance = await importAndInstantiate(outDir, name, imports);
      wasiHost._ctx.state = instance.$states[0];

      const math = instance['test:multi/math'];
      const greeter = instance['test:multi/greeter'];
      assert.ok(math, 'should have test:multi/math export');
      assert.ok(greeter, 'should have test:multi/greeter export');

      assert.equal(await math.add(3, 4), 7);
      assert.equal(await math.doubleAdd(5, 7), 24); // 5*2 + 7*2
      const greeting = await greeter.greet('World');
      assert.equal(greeting, 'Hello, World! (10)'); // len("World")=5, 5*2=10

      if (instance.$destroy) instance.$destroy();
    });
  }

  // Test async exports returning multi-flat types (record, tuple, list, option, string, result)
  const asyncTypesBytes = readGuest('rust-async-types');
  if (asyncTypesBytes) {
    it('produces .js + .d.ts that type-check and run (async flat lifting)', async () => {
      const name = 'async-types';
      const outDir = generateAndWrite(name, asyncTypesBytes, { jspiMode: true });

      await typeCheck(outDir, `import type { Imports } from './${name}.js';
import { instantiate } from './${name}.js';
import type { WasiHost } from '@jellevdh/wcjs/wasi';

export async function main(imports: Imports) {
  const instance = await instantiate(imports);
  const api = instance['test:async-types/api'];

  const pt: { x: number; y: number } = await api.getPoint(1.5, 2.5);
  const pair: [number, number] = await api.getPair(10, 20);
  const list: number[] = await api.getList();
  const some: number | null = await api.getMaybe(true);
  const none: number | null = await api.getMaybe(false);
  const s: string = await api.getName();
  const divOk: { tag: 'ok'; val: number } | { tag: 'err'; val: string } = await api.safeDivide(10, 4);
  const divErr: { tag: 'ok'; val: number } | { tag: 'err'; val: string } = await api.safeDivide(1, 0);

  return { pt, pair, list, some, none, s, divOk, divErr };
}
`);

      const wasiHost = createWasiHost({ stdout: [], stderr: [] });
      const instance = await importAndInstantiate(outDir, name, wasiHost);
      wasiHost._ctx.state = instance.$states[0];

      const api = instance['test:async-types/api'];
      assert.ok(api, 'should have test:async-types/api export');

      assert.deepStrictEqual(await api.getPoint(1.5, 2.5), { x: 1.5, y: 2.5 });
      assert.deepStrictEqual(await api.getPair(10, 20), [10, 20]);
      assert.deepStrictEqual(await api.getList(), [10, 20, 30, 40, 50]);
      assert.equal(await api.getMaybe(true), 42);
      assert.equal(await api.getMaybe(false), null);
      assert.equal(await api.getName(), 'hello from async');

      if (instance.$destroy) instance.$destroy();
    });
  }
});
