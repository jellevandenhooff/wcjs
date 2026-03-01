// Integration tests: WAT → wasm → codegen → run
// Also spec WAST tests.
// Tests both 'ts' and 'js' codegen modes via MODES loop.

import { describe, it, assert } from '../test/runner.ts';
import { compileWat, instantiate, MODES, type CodegenMode } from './pipeline.ts';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAT_DIR = join(__dirname, 'wat');
const OUT_DIR = join(__dirname, 'out');
const SPEC_DIR = join(__dirname, 'spec');
const IMPORTS_DIR = join(__dirname, 'imports');

// =====================================================================
// Helpers
// =====================================================================

async function loadTestImports(name: string): Promise<Record<string, unknown>> {
  const importsPath = join(IMPORTS_DIR, `${name}.mjs`);
  if (existsSync(importsPath)) {
    const mod = await import(importsPath);
    return mod.default || {};
  }
  return {};
}

/** Find and call a named export on an instance, with timeout. */
async function runExport(
  instance: any, funcName = 'run', args: unknown[] = [],
): Promise<unknown> {
  const camelName = funcName.replace(/-([a-z0-9])/g, (_: string, c: string) => c.toUpperCase());
  let fn: Function | undefined;
  for (const key of Object.keys(instance)) {
    if (key === '$destroy') continue;
    const val = instance[key];
    if (typeof val === 'function' && (key === funcName || key === camelName)) {
      fn = val;
      break;
    }
    if (val && typeof val === 'object') {
      if (typeof val[funcName] === 'function') { fn = val[funcName]; break; }
      if (typeof val[camelName] === 'function') { fn = val[camelName]; break; }
    }
  }
  if (!fn) throw new Error(`no '${funcName}' export found (exports: ${JSON.stringify(Object.keys(instance))})`);

  const TEST_TIMEOUT = 10_000;
  return Promise.race([
    fn(...args),
    new Promise((_, reject) => setTimeout(() => {
      reject(new Error(`test timed out after ${TEST_TIMEOUT}ms`));
    }, TEST_TIMEOUT)),
  ]);
}

/** Compile WAT, instantiate, run a named export, destroy. */
async function runFullPipeline(
  name: string, watPath: string, mode: CodegenMode, funcName = 'run',
) {
  const wasmPath = watPath.replace(/\.wat$/, '.wasm');
  await compileWat(watPath, wasmPath);
  const testImports = await loadTestImports(name);
  const instance = await instantiate(name, wasmPath, testImports, {
    mode, outDir: join(OUT_DIR, name),
  });
  try {
    return await runExport(instance, funcName);
  } finally {
    if (instance.$destroy) instance.$destroy();
  }
}

/** Run a WAST assertion (assert_return or assert_trap) on an instance. */
async function runWastAssertion(assertion: Assertion, instance: any): Promise<void> {
  if (assertion.type === 'assert_trap') {
    const expected = assertion.expectedMessage;
    try {
      await runExport(instance, assertion.funcName, assertion.args || []);
      assert.fail('expected trap but call succeeded');
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes('expected trap but call succeeded')) throw e;
      if (expected && expected.includes('cannot enter component instance')
          && msg === 'unreachable') {
        // Tolerate
      } else if (expected && expected.includes('cannot block a synchronous task')
          && msg.includes('trying to suspend without')) {
        // Tolerate
      } else if (expected && expected.includes('cannot block a synchronous task')
          && msg.includes('deadlock detected')) {
        // Tolerate
      } else if (expected) {
        assert.ok(msg.includes(expected), `expected "${expected}" in "${msg}"`);
      }
    }
  } else {
    const result = await runExport(instance, assertion.funcName, assertion.args || []);
    if (assertion.expectedValue !== null && assertion.expectedValue !== undefined) {
      assert.strictEqual(result, assertion.expectedValue);
    }
  }
}

// =====================================================================
// WAST Parser
// =====================================================================

function parseWast(source: string) {
  const directives: Array<{ type: string; text: string }> = [];
  let pos = 0;

  function skipWs() {
    while (pos < source.length) {
      if (/\s/.test(source[pos]!)) { pos++; continue; }
      if (source[pos] === ';' && source[pos + 1] === ';') {
        while (pos < source.length && source[pos] !== '\n') pos++;
        continue;
      }
      if (source[pos] === '(' && source[pos + 1] === ';') {
        let depth = 1; pos += 2;
        while (pos < source.length && depth > 0) {
          if (source[pos] === '(' && source[pos + 1] === ';') { depth++; pos += 2; }
          else if (source[pos] === ';' && source[pos + 1] === ')') { depth--; pos += 2; }
          else pos++;
        }
        continue;
      }
      break;
    }
  }

  function extractSExpr(): string | null {
    if (source[pos] !== '(') return null;
    const start = pos;
    let depth = 0, inStr = false;
    while (pos < source.length) {
      const ch = source[pos]!;
      if (inStr) {
        if (ch === '\\') { pos += 2; continue; }
        if (ch === '"') inStr = false;
        pos++; continue;
      }
      if (ch === '"') { inStr = true; pos++; continue; }
      if (ch === ';' && source[pos + 1] === ';') {
        while (pos < source.length && source[pos] !== '\n') pos++;
        continue;
      }
      if (ch === '(' && source[pos + 1] === ';') {
        let d = 1; pos += 2;
        while (pos < source.length && d > 0) {
          if (source[pos] === '(' && source[pos + 1] === ';') { d++; pos += 2; }
          else if (source[pos] === ';' && source[pos + 1] === ')') { d--; pos += 2; }
          else pos++;
        }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { pos++; break; } }
      pos++;
    }
    return source.slice(start, pos);
  }

  while (pos < source.length) {
    skipWs();
    if (pos >= source.length) break;
    if (source[pos] === '(') {
      const expr = extractSExpr();
      if (expr) {
        const match = expr.match(/^\(\s*(\S+)/);
        if (match) directives.push({ type: match[1]!, text: expr });
      }
    } else pos++;
  }
  return directives;
}

function extractComponentFromDirective(directive: { text: string }): string | null {
  const idx = directive.text.indexOf('(component');
  if (idx < 0) return null;
  let pos = idx, depth = 0, inStr = false;
  while (pos < directive.text.length) {
    const ch = directive.text[pos]!;
    if (inStr) { if (ch === '\\') { pos += 2; continue; } if (ch === '"') inStr = false; pos++; continue; }
    if (ch === '"') { inStr = true; pos++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { pos++; break; } }
    pos++;
  }
  return directive.text.slice(idx, pos);
}

function parseInvokeArgs(text: string): unknown[] {
  const args: unknown[] = [];
  const argRegex = /\((bool|u8|u16|u32|i8|i16|i32|u64|i64|f32|f64)\.const\s+([^\s)]+)\)/g;
  const invokeStart = text.indexOf('(invoke');
  if (invokeStart === -1) return args;
  const nameEnd = text.indexOf('"', text.indexOf('"', invokeStart + 7) + 1);
  if (nameEnd === -1) return args;
  let depth = 0;
  let invokeEnd = invokeStart;
  for (let i = invokeStart; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) { invokeEnd = i; break; } }
  }
  const invokeText = text.slice(nameEnd + 1, invokeEnd);
  let m;
  while ((m = argRegex.exec(invokeText)) !== null) {
    const type = m[1]!;
    const val = m[2]!;
    if (type === 'bool') args.push(val === 'true');
    else if (type.startsWith('f')) args.push(parseFloat(val));
    else args.push(parseInt(val));
  }
  return args;
}

function findInvokeEnd(text: string): number {
  const invokeStart = text.indexOf('(invoke');
  if (invokeStart === -1) return -1;
  let depth = 0;
  for (let i = invokeStart; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

interface Assertion {
  type: string;
  funcName: string;
  expectedValue?: number | null;
  expectedMessage?: string | null;
  args: unknown[];
  component?: string | null;
  freshInstance?: boolean;
  testIdx: number;
}

function parseAssertion(directive: { type: string; text: string }) {
  if (directive.type === 'assert_return') {
    const invokeMatch = directive.text.match(/\(invoke\s+(?:\$\S+\s+)?"([^"]+)"/);
    const invokeEnd = findInvokeEnd(directive.text);
    const afterInvoke = invokeEnd >= 0 ? directive.text.slice(invokeEnd + 1) : '';
    const returnMatch = afterInvoke.match(/\((u32|i32|u64|i64|f32|f64)\.const\s+(-?\d+)\)/);
    const args = parseInvokeArgs(directive.text);
    return {
      type: 'assert_return',
      funcName: invokeMatch?.[1] || 'run',
      expectedValue: returnMatch ? parseInt(returnMatch[2]!) : null,
      args,
    };
  }
  if (directive.type === 'assert_trap') {
    const msgMatch = directive.text.match(/"([^"]*?)"\s*\)\s*$/);
    const invokeMatch = directive.text.match(/\(invoke\s+(?:\$\S+\s+)?"([^"]+)"/);
    const args = parseInvokeArgs(directive.text);
    return {
      type: 'assert_trap',
      funcName: invokeMatch?.[1] || 'run',
      expectedMessage: msgMatch?.[1] || null,
      args,
    };
  }
  return { type: directive.type, funcName: 'run', args: [] };
}

function extractWastAssertions(wastPath: string): Assertion[] {
  const source = readFileSync(wastPath, 'utf-8');
  const directives = parseWast(source);
  const definitions: Record<string, string> = {};
  const instances: Record<string, string> = {};
  const assertions: Assertion[] = [];
  let topComponent: string | null = null;
  let currentInstanceComponent: string | null = null;
  let testIdx = 0;

  for (const d of directives) {
    if (d.type === 'component') {
      const defMatch = d.text.match(/^\(component\s+definition\s+(\$\S+)/);
      if (defMatch) {
        definitions[defMatch[1]!] = d.text.replace(/^\(component\s+definition\s+\$\S+/, '(component');
        continue;
      }
      const compInstMatch = d.text.match(/^\(component\s+instance\s+(\$\S+)\s+(\$\S+)\s*\)/);
      if (compInstMatch) {
        instances[compInstMatch[1]!] = compInstMatch[2]!;
        currentInstanceComponent = definitions[compInstMatch[2]!] || null;
        continue;
      }
      topComponent = d.text;
    } else if (d.type === 'instance') {
      const instMatch = d.text.match(/^\(instance\s+(\$\S+)\s+(\$\S+)\s*\)/);
      if (instMatch) instances[instMatch[1]!] = instMatch[2]!;
    } else if (d.type === 'assert_return' || d.type === 'assert_trap' || d.type === 'invoke') {
      let assertion: any;
      if (d.type === 'invoke') {
        const invokeMatch = d.text.match(/\(invoke\s+(?:\$\S+\s+)?"([^"]+)"/);
        assertion = { type: 'assert_return', funcName: invokeMatch?.[1] || 'run', expectedValue: null, args: [] };
      } else {
        assertion = parseAssertion(d);
      }
      if (d.type === 'assert_trap') {
        const component = extractComponentFromDirective(d);
        if (component) { assertions.push({ ...assertion, component, testIdx: testIdx++ }); continue; }
      }
      const instInvoke = d.text.match(/\(invoke\s+(\$\S+)\s+"([^"]+)"/);
      if (instInvoke) {
        const defName = instances[instInvoke[1]!];
        const component = defName ? definitions[defName] : topComponent;
        assertions.push({ ...assertion, funcName: instInvoke[2]!, component, testIdx: testIdx++ });
      } else {
        const isFresh = !!currentInstanceComponent;
        assertions.push({
          ...assertion,
          component: currentInstanceComponent || topComponent,
          freshInstance: isFresh,
          testIdx: testIdx++,
        });
      }
    }
  }

  if (assertions.length === 0 && topComponent) {
    assertions.push({ type: 'run', funcName: 'run', component: topComponent, testIdx: 0, args: [] });
  }
  return assertions;
}

// =====================================================================
// WAT Tests
// =====================================================================

const watFiles = existsSync(WAT_DIR) ? readdirSync(WAT_DIR).filter(f => f.endsWith('.wat')) : [];
const watTestNames = watFiles.map(f => basename(f, '.wat'));

for (const name of watTestNames) {
  describe(`WAT: ${name}`, () => {
    for (const mode of MODES) {
      it(`run [${mode}]`, async () => {
        const result = await runFullPipeline(
          name, join(WAT_DIR, `${name}.wat`), mode,
        );
        if (result && typeof result === 'object' && 'tag' in (result as any)) {
          assert.strictEqual((result as any).tag, 'ok', `${name} returned error: ${JSON.stringify(result)}`);
        } else {
          assert.ok(result !== undefined);
        }
      });
    }
  });
}

// =====================================================================
// Spec WAST Tests
// =====================================================================

const wastFiles = existsSync(SPEC_DIR)
  ? readdirSync(SPEC_DIR).filter(f => f.endsWith('.wast'))
  : [];

const SKIP_WAST_SUITES = new Set<string>([]);
const SKIP_WAST_ASSERTIONS: Record<string, Set<number>> = {};

for (const wastFile of wastFiles) {
  const wastName = basename(wastFile, '.wast');
  const wastPath = join(SPEC_DIR, wastFile);
  const assertions = extractWastAssertions(wastPath);

  if (SKIP_WAST_SUITES.has(wastName)) {
    describe.skip(`WAST: ${wastName}`, () => {
      it('skipped (unsupported feature)', () => {});
    });
    continue;
  }

  describe(`WAST: ${wastName}`, () => {
    if (assertions.length === 0) {
      it.skip('no assertions extracted', () => {});
      return;
    }

    const groups: Assertion[][] = [];
    for (const assertion of assertions) {
      if (!assertion.component) {
        groups.push([assertion]);
      } else if (!assertion.freshInstance && groups.length > 0
          && groups[groups.length - 1]![0]!.component === assertion.component
          && !groups[groups.length - 1]![0]!.freshInstance) {
        groups[groups.length - 1]!.push(assertion);
      } else {
        groups.push([assertion]);
      }
    }

    for (const group of groups) {
      if (group.length === 1) {
        const assertion = group[0]!;
        const baseLabel = `[${assertion.testIdx}] ${assertion.funcName} (${assertion.type})`;

        const skipSet = SKIP_WAST_ASSERTIONS[wastName];
        if (!assertion.component || (skipSet && skipSet.has(assertion.testIdx))) {
          it.skip(baseLabel, () => {});
          continue;
        }

        for (const mode of MODES) {
          it(`${baseLabel} [${mode}]`, async () => {
            const outDir = join(OUT_DIR, 'spec', wastName, String(assertion.testIdx));
            const wasmPath = join(outDir, `${wastName}.wasm`);
            if (!existsSync(wasmPath)) {
              mkdirSync(outDir, { recursive: true });
              writeFileSync(join(outDir, `${wastName}.wat`), assertion.component!);
              await compileWat(join(outDir, `${wastName}.wat`), wasmPath);
            }
            let instance: any;
            try {
              instance = await instantiate(wastName, wasmPath, {}, {
                jspi: true, mode, outDir,
              });
            } catch (e: any) {
              // assert_trap may trap during instantiation (e.g. blocking in start function)
              if (assertion.type === 'assert_trap') {
                const msg = e?.message || String(e);
                const expected = assertion.expectedMessage;
                if (expected && expected.includes('cannot block a synchronous task')
                    && (msg.includes('trying to suspend without') || msg.includes('deadlock detected'))) {
                  return; // Tolerate
                }
                if (expected) {
                  assert.ok(msg.includes(expected), `expected "${expected}" in "${msg}"`);
                }
                return;
              }
              throw e;
            }
            try {
              await runWastAssertion(assertion, instance);
            } finally {
              if (instance.$destroy) instance.$destroy();
            }
          });
        }
      } else {
        const labels = group.map(a => `[${a.testIdx}] ${a.funcName} (${a.type})`);
        const baseLabel = labels.join(', ');

        for (const mode of MODES) {
          it(`${baseLabel} [${mode}]`, async () => {
            const outDir = join(OUT_DIR, 'spec', wastName, String(group[0]!.testIdx));
            const wasmPath = join(outDir, `${wastName}.wasm`);
            if (!existsSync(wasmPath)) {
              mkdirSync(outDir, { recursive: true });
              writeFileSync(join(outDir, `${wastName}.wat`), group[0]!.component!);
              await compileWat(join(outDir, `${wastName}.wat`), wasmPath);
            }
            const instance = await instantiate(wastName, wasmPath, {}, {
              jspi: true, mode, outDir,
            });
            try {
              for (const assertion of group) {
                await runWastAssertion(assertion, instance);
              }
            } finally {
              if (instance.$destroy && typeof instance.$destroy === 'function') {
                instance.$destroy();
              }
            }
          });
        }
      }
    }
  });
}
