// Minimal test runner with parallelism and trace integration.
//
// Usage:
//   npm test                          # all tests, suites run in parallel
//   npm test -- stream                # filter by name
//   P3_TRACE=1 npm test -- stream     # with runtime call tracing
//
// Parallelism: top-level describe() suites run concurrently (default 8).
// Tests within a suite run sequentially (important for shared-state WAST groups).
// Output is buffered per-suite and printed in registration order.

import { trace } from '../src/runtime/index.ts';
import { strict as assert } from 'node:assert';

export { assert };

// ---- Types ----

interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
  skip: boolean;
}

interface Suite {
  name: string;
  tests: TestCase[];
  suites: Suite[];
  beforeAllFn?: () => void | Promise<void>;
}

interface SuiteResult {
  passed: number;
  failed: number;
  skipped: number;
  errors: Array<{ name: string; error: unknown }>;
  lines: string[];
}

// ---- State ----

const rootSuite: Suite = { name: '', tests: [], suites: [] };
let currentSuite: Suite = rootSuite;

// ---- Public API ----

export function describe(name: string, fn: () => void): void {
  const suite: Suite = { name, tests: [], suites: [] };
  currentSuite.suites.push(suite);
  const parent = currentSuite;
  currentSuite = suite;
  fn();
  currentSuite = parent;
}

export function test(name: string, fn: () => void | Promise<void>): void {
  currentSuite.tests.push({ name, fn, skip: false });
}

export const it = test;

test.skip = (name: string, _fn: () => void | Promise<void>): void => {
  currentSuite.tests.push({ name, fn: _fn, skip: true });
};

describe.skip = (name: string, fn: () => void): void => {
  const suite: Suite = { name, tests: [], suites: [] };
  currentSuite.suites.push(suite);
  const parent = currentSuite;
  currentSuite = suite;
  fn();
  const skipAll = (s: Suite) => {
    for (const t of s.tests) t.skip = true;
    for (const sub of s.suites) skipAll(sub);
  };
  skipAll(suite);
  currentSuite = parent;
};

export function beforeAll(fn: () => void | Promise<void>): void {
  currentSuite.beforeAllFn = fn;
}

// ---- Suite runner (sequential within suite, captures output) ----

function emit(result: SuiteResult, streaming: boolean, line: string): void {
  if (streaming) {
    process.stdout.write(line + '\n');
  } else {
    result.lines.push(line);
  }
}

async function runSuite(
  suite: Suite,
  prefix: string,
  result: SuiteResult,
  filter: string | undefined,
  tracing: boolean,
  streaming: boolean = false,
): Promise<void> {
  const fullPrefix = prefix ? `${prefix} > ${suite.name}` : suite.name;

  // Defer header — only print if the suite has matching tests
  const linesBefore = result.lines.length;
  let headerInserted = false;

  if (suite.beforeAllFn) {
    // Only run beforeAll if there are potentially matching tests
    const hasMatch = !filter || suite.tests.some(t => {
      const fn = fullPrefix ? `${fullPrefix} > ${t.name}` : t.name;
      return fn.toLowerCase().includes(filter.toLowerCase());
    }) || suite.suites.length > 0;
    if (hasMatch) await suite.beforeAllFn();
  }

  for (const t of suite.tests) {
    const fullName = fullPrefix ? `${fullPrefix} > ${t.name}` : t.name;

    if (filter && !fullName.toLowerCase().includes(filter.toLowerCase())) {
      continue;
    }

    // Insert suite header before first matching test
    if (suite.name && !headerInserted) {
      if (streaming) {
        process.stdout.write(fullPrefix + '\n');
      } else {
        result.lines.splice(linesBefore, 0, fullPrefix);
      }
      headerInserted = true;
    }

    if (t.skip) {
      result.skipped++;
      emit(result, streaming, `  - ${t.name} (skipped)`);
      continue;
    }

    // In streaming mode, capture console.error too so debug logs interleave
    // with trace output. In buffered mode, only capture console.log.
    const traceLines: string[] = [];
    const savedLog = console.log;
    const savedError = console.error;
    if (tracing) {
      const captureLine = (line: string) => {
        if (streaming) {
          process.stderr.write(`    ${line}\n`);
        } else {
          traceLines.push(line);
        }
      };
      console.log = (...args: unknown[]) => {
        const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        if (line.startsWith('[c') || line.startsWith('[wasi]') || line.startsWith('event loop') || line.startsWith('asyncStartCall') || line.startsWith('[guest')) {
          captureLine(line);
        } else {
          savedLog(...args);
        }
      };
      console.error = (...args: unknown[]) => {
        const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        captureLine(line);
      };
    }

    try {
      await t.fn();
      if (tracing) { console.log = savedLog; console.error = savedError; }
      result.passed++;
      emit(result, streaming, `  ok ${t.name}`);
      if (traceLines.length > 0) {
        for (const line of traceLines) emit(result, streaming, `    ${line}`);
      }
    } catch (e) {
      if (tracing) { console.log = savedLog; console.error = savedError; }
      result.failed++;
      result.errors.push({ name: fullName, error: e });
      emit(result, streaming, `  FAIL ${t.name}`);
      if (traceLines.length > 0) {
        for (const line of traceLines) emit(result, streaming, `    ${line}`);
      }
      const msg = e instanceof Error ? e.message : String(e);
      const firstLine = msg.split('\n')[0]!;
      emit(result, streaming, `    ${firstLine}`);
    }
  }

  for (const sub of suite.suites) {
    await runSuite(sub, fullPrefix, result, filter, tracing, streaming);
  }
}

// ---- Concurrency limiter ----

async function parallelMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---- Main runner ----

export async function run(): Promise<void> {
  const tracing = !!process.env.P3_TRACE;
  if (tracing) trace.enabled = true;

  // Filter from CLI args
  const args = process.argv.slice(2);
  const filter = args.length > 0 ? args.join(' ') : undefined;

  // When tracing, force sequential + streaming so output is not interleaved.
  const concurrency = tracing ? 1 : parseInt(process.env.TEST_CONCURRENCY || '8', 10);
  const streaming = concurrency === 1;

  // Run top-level suites in parallel, buffer output per suite.
  // Flush completed results in registration order as the head completes
  // (like `go test` — parallel execution, ordered output).
  const suiteResults: SuiteResult[] = new Array(rootSuite.suites.length);
  const done: boolean[] = new Array(rootSuite.suites.length).fill(false);
  let printHead = 0;

  const flushCompleted = () => {
    while (printHead < done.length && done[printHead]) {
      const result = suiteResults[printHead]!;
      for (const line of result.lines) console.log(line);
      printHead++;
    }
  };

  await parallelMap(
    rootSuite.suites.map((suite, i) => ({ suite, i })),
    concurrency,
    async ({ suite, i }) => {
      const result: SuiteResult = { passed: 0, failed: 0, skipped: 0, errors: [], lines: [] };
      await runSuite(suite, '', result, filter, tracing, streaming);
      suiteResults[i] = result;
      done[i] = true;
      if (!streaming) flushCompleted();
      return result;
    },
  );

  // Totals
  let passed = 0, failed = 0, skipped = 0;
  const allErrors: Array<{ name: string; error: unknown }> = [];
  for (const r of suiteResults) {
    passed += r.passed;
    failed += r.failed;
    skipped += r.skipped;
    allErrors.push(...r.errors);
  }

  // Summary
  console.log('');
  const parts = [`${passed} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  console.log(parts.join(', '));

  // Show failure details at the end for easy scanning
  if (allErrors.length > 0) {
    console.log('\nFailures:\n');
    for (const { name, error } of allErrors) {
      console.log(`  ${name}`);
      if (error instanceof Error) {
        // Show message + first relevant stack frame
        console.log(`    ${error.message.split('\n')[0]}`);
        const frame = error.stack?.split('\n').find(l => l.includes('test/'));
        if (frame) console.log(`   ${frame.trim()}`);
      } else {
        console.log(`    ${String(error)}`);
      }
      console.log('');
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}
