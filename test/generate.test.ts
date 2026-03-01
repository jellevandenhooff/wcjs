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

describe('generate', () => {
  it('produces .js + .d.ts that type-check and run (WAT)', async () => {
    const name = 'test1-callback';
    const outDir = join(GEN_OUT, name);
    mkdirSync(outDir, { recursive: true });

    // Compile WAT → wasm
    const watPath = join(WAT_DIR, `${name}.wat`);
    const wasmPath = join(outDir, `${name}.wasm`);
    await compileWat(watPath, wasmPath);

    // Generate standalone output
    const wasmBytes = new Uint8Array(readFileSync(wasmPath));
    const parsed = parseComponent(wasmBytes);
    const result = generateCode(parsed, name, { jspiMode: false, mode: 'standalone' });

    // Write generated files
    writeFileSync(join(outDir, `${name}.js`), result.source);
    assert.ok(result.declarations, 'declarations should be present');
    writeFileSync(join(outDir, `${name}.d.ts`), result.declarations);
    for (const mod of result.coreModules) {
      const modPath = join(outDir, mod.fileName);
      mkdirSync(dirname(modPath), { recursive: true });
      writeFileSync(modPath, mod.bytes);
    }

    // Type-check the .d.ts
    const testScript = `import { instantiate } from './${name}.js';
export async function main() {
  const instance = await instantiate({});
  return instance;
}
`;
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

    // Run the generated module
    const jsUrl = pathToFileURL(join(outDir, `${name}.js`)).href;
    const module = await import(jsUrl + `?t=${Date.now()}`);
    const instance = await module.instantiate({});

    // Find and run the export
    const runKey = Object.keys(instance).find(k => k !== '$states' && k !== '$destroy');
    assert.ok(runKey, 'should have an export');
    const result2 = await instance[runKey].run();
    assert.deepStrictEqual(result2, { tag: 'ok' });
    if (instance.$destroy) instance.$destroy();
  });

  // Test with a full WASI guest component (go-hello)
  const goHelloPath = join(GUEST_OUT, 'go-hello', 'component.wasm');
  if (existsSync(goHelloPath)) {
    it('produces .js + .d.ts that type-check and run (WASI guest)', async () => {
      const name = 'go-hello';
      const outDir = join(GEN_OUT, name);
      mkdirSync(outDir, { recursive: true });

      // Generate standalone output
      const wasmBytes = new Uint8Array(readFileSync(goHelloPath));
      const parsed = parseComponent(wasmBytes);
      const result = generateCode(parsed, name, { jspiMode: true, mode: 'standalone' });

      // Write generated files
      writeFileSync(join(outDir, `${name}.js`), result.source);
      assert.ok(result.declarations, 'declarations should be present');
      writeFileSync(join(outDir, `${name}.d.ts`), result.declarations);
      for (const mod of result.coreModules) {
        const modPath = join(outDir, mod.fileName);
        mkdirSync(dirname(modPath), { recursive: true });
        writeFileSync(modPath, mod.bytes);
      }

      // Type-check the .d.ts with WasiHost
      const testScript = `import type { Imports } from './${name}.js';
import { instantiate } from './${name}.js';
import type { WasiHost } from '@jellevdh/wcjs/wasi';

const _check: Imports = {} as WasiHost;

export async function main(imports: Imports) {
  const instance = await instantiate(imports);
  return instance;
}
`;
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

      // Run the generated module
      const stdoutBuf: string[] = [];
      const wasiHost = createWasiHost({
        args: ['go-hello'],
        env: [['HOME', '/tmp']],
        stdout: stdoutBuf,
        stderr: [],
      });

      const jsUrl = pathToFileURL(join(outDir, `${name}.js`)).href;
      const module = await import(jsUrl + `?t=${Date.now()}`);
      const instance = await module.instantiate(wasiHost);
      wasiHost._ctx.state = instance.$states[0];

      const runKey = Object.keys(instance).find(k => k.startsWith('wasi:cli/run@'));
      assert.ok(runKey, 'should have wasi:cli/run export');
      await instance[runKey].run();
      if (instance.$destroy) instance.$destroy();

      assert.ok(stdoutBuf.join('').includes('hello'), 'stdout should contain hello');
    });
  }

  // Test with custom WIT types (Rust guest with records, enums, lists, results, async)
  const typesTestPath = join(GUEST_OUT, 'rust-types-test', 'component.wasm');
  if (existsSync(typesTestPath)) {
    it('produces .js + .d.ts that type-check and run (custom WIT)', async () => {
      const name = 'types-test';
      const outDir = join(GEN_OUT, name);
      mkdirSync(outDir, { recursive: true });

      // Generate standalone output with JSPI (required for Rust async guests)
      const wasmBytes = new Uint8Array(readFileSync(typesTestPath));
      const parsed = parseComponent(wasmBytes);
      const result = generateCode(parsed, name, { jspiMode: true, mode: 'standalone' });

      // Write generated files
      writeFileSync(join(outDir, `${name}.js`), result.source);
      assert.ok(result.declarations, 'declarations should be present');
      writeFileSync(join(outDir, `${name}.d.ts`), result.declarations);
      for (const mod of result.coreModules) {
        const modPath = join(outDir, mod.fileName);
        mkdirSync(dirname(modPath), { recursive: true });
        writeFileSync(modPath, mod.bytes);
      }

      // Type-check the .d.ts — verify typed export signatures
      const testScript = `import type { Imports } from './${name}.js';
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
`;
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

      // Set up host imports: WASI stubs + custom host functions
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

      const jsUrl = pathToFileURL(join(outDir, `${name}.js`)).href;
      const module = await import(jsUrl + `?t=${Date.now()}`);
      const instance = await module.instantiate(imports);
      wasiHost._ctx.state = instance.$states[0];

      const api = instance['test:types/api'];
      assert.ok(api, 'should have test:types/api export');

      // Test string passing
      assert.equal(await api.greet('World'), 'Hello, World!');

      // Test record passing + f64
      const dist = await api.computeDistance({ x: 0, y: 0 }, { x: 3, y: 4 });
      assert.equal(dist, 5);

      // Test enum passing
      assert.equal(await api.colorToNumber('red'), 0xFF0000);
      assert.equal(await api.colorToNumber('green'), 0x00FF00);
      assert.equal(await api.colorToNumber('blue'), 0x0000FF);

      // Test record with string + u32
      assert.equal(await api.describePerson({ name: 'Alice', age: 30 }), 'Alice is 30 years old');

      // Test list passing
      assert.deepStrictEqual(await api.reverseList([1, 2, 3, 4, 5]), [5, 4, 3, 2, 1]);

      // Test result type (ok case)
      const divOk = await api.safeDivide(10, 4);
      assert.equal(divOk.tag, 'ok');
      assert.equal(divOk.val, 2.5);

      // Test result type (err case)
      const divErr = await api.safeDivide(1, 0);
      assert.equal(divErr.tag, 'err');
      assert.equal(divErr.val, 'division by zero');

      // Test async export (calls async-double import)
      const sum = await api.doubleSum(3, 4);
      assert.equal(sum, 14); // 3*2 + 4*2 = 14

      // Verify host imports were called
      assert.ok(logs.some(l => l.includes('scaled')), 'scale-point import should have been called');
      assert.ok(logs.some(l => l.includes('sum before reverse')), 'sum-list import should have been called');

      if (instance.$destroy) instance.$destroy();
    });
  }
});
