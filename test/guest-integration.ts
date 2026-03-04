// Guest integration tests: compiled WASI P3 guest components → codegen → run
//
// Expects pre-compiled guest components in test/guest/out/<name>/component.wasm
// (built by test/guest/build-go.sh or test/guest/build-rust.sh).
// Tests both 'ts' and 'js' codegen modes.

import { describe, it, assert } from './runner.ts';
import { createWasiHost } from '../src/wasi/wasi-host.ts';
import { instantiate, MODES, type CodegenMode } from './pipeline.ts';
import { readFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUEST_OUT = join(__dirname, 'guest', 'out');
const GEN_OUT = join(__dirname, 'out', 'guest');

// =====================================================================
// Guest test runner
// =====================================================================

interface GuestTestConfig {
  name: string;
  wasmPath: string;
  args?: string[];
  env?: [string, string][];
  preopens?: [string, string][];
  assertStdout?: (stdout: string) => void;
  assertResult?: (result: unknown) => void;
  timeout?: number;
}

async function runGuestTest(config: GuestTestConfig, mode: CodegenMode): Promise<void> {
  // Create WASI host with stdout capture
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const wasiHost = createWasiHost({
    args: config.args || [config.name],
    env: config.env || [['HOME', '/tmp']],
    stdout: stdoutBuf,
    stderr: stderrBuf,
    preopens: config.preopens,
  });

  // Load and instantiate
  const instance = await instantiate(config.name, config.wasmPath, wasiHost, {
    jspi: true, mode, outDir: join(GEN_OUT, config.name),
  });

  // Wire component state into host context
  wasiHost._ctx.state = instance.$states[0];

  // Run wasi:cli/run
  const TEST_TIMEOUT = config.timeout || 30_000;
  try {
    const runExport = instance['wasi:cli/run@0.3.0-rc-2026-02-09'];
    if (!runExport || typeof runExport.run !== 'function') {
      throw new Error(`no wasi:cli/run export found (exports: ${JSON.stringify(Object.keys(instance))})`);
    }

    const result = await Promise.race([
      runExport.run(),
      new Promise((_, reject) => setTimeout(() => {
        reject(new Error(`guest test timed out after ${TEST_TIMEOUT}ms`));
      }, TEST_TIMEOUT)),
    ]);

    // Check result
    if (config.assertResult) {
      config.assertResult(result);
    } else if (result && typeof result === 'object' && 'tag' in (result as any)) {
      if ((result as any).tag !== 'ok') {
        const stdout = stdoutBuf.join('');
        if (stdout) console.error('  guest stdout:', stdout.trimEnd());
        const stderr = stderrBuf.join('');
        if (stderr) console.error('  guest stderr:', stderr.trimEnd());
      }
      assert.strictEqual((result as any).tag, 'ok', `guest returned error: ${JSON.stringify(result)}`);
    }

    // Check stdout
    if (config.assertStdout) {
      const stdout = stdoutBuf.join('');
      config.assertStdout(stdout);
    }
  } finally {
    if (instance.$destroy && typeof instance.$destroy === 'function') {
      instance.$destroy();
    }
  }
}

// =====================================================================
// Discover and register guest tests
// =====================================================================

if (!existsSync(GUEST_OUT)) {
  describe('Guest', () => {
    it.skip('no guest components built (run test/guest/build-go.sh first)', () => {});
  });
} else {
  const guestDirs = readdirSync(GUEST_OUT).filter(d => {
    return existsSync(join(GUEST_OUT, d, 'component.wasm'));
  }).sort();

  if (guestDirs.length === 0) {
    describe('Guest', () => {
      it.skip('no guest components found in test/guest/out/', () => {});
    });
  } else {
    // Go hello world
    if (guestDirs.includes('go-hello')) {
      describe('Guest: go-hello', () => {
        for (const mode of MODES) {
          it(`prints hello [${mode}]`, async () => {
            await runGuestTest({
              name: 'go-hello',
              wasmPath: join(GUEST_OUT, 'go-hello', 'component.wasm'),
              assertStdout: (stdout) => {
                assert.ok(stdout.includes('hello from Go wasip3'), `expected "hello from Go wasip3" in stdout, got: ${JSON.stringify(stdout)}`);
              },
            }, mode);
          });
        }
      });
    }

    // Go args-env
    if (guestDirs.includes('go-args-env')) {
      describe('Guest: go-args-env', () => {
        for (const mode of MODES) {
          it(`reads args and env [${mode}]`, async () => {
            await runGuestTest({
              name: 'go-args-env',
              wasmPath: join(GUEST_OUT, 'go-args-env', 'component.wasm'),
              args: ['test-program', '--flag', 'value'],
              env: [['HOME', '/home/test'], ['FOO', 'bar']],
              assertStdout: (stdout) => {
                assert.ok(stdout.includes('test-program'), `expected args to contain "test-program", got: ${JSON.stringify(stdout)}`);
                assert.ok(stdout.includes('HOME=/home/test'), `expected HOME=/home/test in stdout, got: ${JSON.stringify(stdout)}`);
              },
            }, mode);
          });
        }
      });
    }

    // Go clock-sleep
    if (guestDirs.includes('go-clock-sleep')) {
      describe('Guest: go-clock-sleep', () => {
        for (const mode of MODES) {
          it(`sleeps and measures time [${mode}]`, async () => {
            await runGuestTest({
              name: 'go-clock-sleep',
              wasmPath: join(GUEST_OUT, 'go-clock-sleep', 'component.wasm'),
              assertStdout: (stdout) => {
                const match = stdout.match(/elapsed=(\d+)ms/);
                assert.ok(match, `expected elapsed=Nms in stdout, got: ${JSON.stringify(stdout)}`);
                const elapsed = parseInt(match![1]!);
                assert.ok(elapsed >= 10, `expected elapsed >= 10ms, got: ${elapsed}ms`);
              },
            }, mode);
          });
        }
      });
    }

    // Go filesystem
    if (guestDirs.includes('go-filesystem')) {
      describe('Guest: go-filesystem', () => {
        for (const mode of MODES) {
          it(`reads, writes, stats, and removes files [${mode}]`, async () => {
            const testDir = join(tmpdir(), `wasip3-fs-test-${mode}-${Date.now()}`);
            mkdirSync(testDir, { recursive: true });
            try {
              await runGuestTest({
                name: 'go-filesystem',
                wasmPath: join(GUEST_OUT, 'go-filesystem', 'component.wasm'),
                env: [['HOME', '/tmp'], ['TMPDIR', '/tmp']],
                preopens: [['/tmp', testDir]],
                assertStdout: (stdout) => {
                  assert.ok(stdout.includes('write ok'), `expected "write ok" in stdout, got: ${JSON.stringify(stdout)}`);
                  assert.ok(stdout.includes('read ok: hello filesystem'), `expected read ok in stdout, got: ${JSON.stringify(stdout)}`);
                  assert.ok(stdout.includes('stat ok:'), `expected stat ok in stdout, got: ${JSON.stringify(stdout)}`);
                  assert.ok(stdout.includes('readdir ok: found=true'), `expected readdir ok in stdout, got: ${JSON.stringify(stdout)}`);
                  assert.ok(stdout.includes('remove ok'), `expected remove ok in stdout, got: ${JSON.stringify(stdout)}`);
                  assert.ok(stdout.includes('all filesystem tests passed'), `expected all tests passed in stdout, got: ${JSON.stringify(stdout)}`);
                },
              }, mode);
            } finally {
              rmSync(testDir, { recursive: true, force: true });
            }
          });
        }
      });
    }

    // Go sockets
    if (guestDirs.includes('go-sockets')) {
      describe('Guest: go-sockets', () => {
        for (const mode of MODES) {
          it(`TCP listen, dial, send, receive [${mode}]`, async () => {
            await runGuestTest({
              name: 'go-sockets',
              wasmPath: join(GUEST_OUT, 'go-sockets', 'component.wasm'),
              timeout: 30_000,
              assertStdout: (stdout) => {
                assert.ok(stdout.includes('listening on'), `expected "listening on" in stdout, got: ${JSON.stringify(stdout)}`);
                assert.ok(stdout.includes('accepted connection'), `expected "accepted connection" in stdout, got: ${JSON.stringify(stdout)}`);
                assert.ok(stdout.includes('received: hello sockets'), `expected "received: hello sockets" in stdout, got: ${JSON.stringify(stdout)}`);
                assert.ok(stdout.includes('all socket tests passed'), `expected all tests passed in stdout, got: ${JSON.stringify(stdout)}`);
              },
            }, mode);
          });
        }
      });
    }

    // Generic fallback for any other guest
    for (const name of guestDirs) {
      if (['go-hello', 'go-args-env', 'go-clock-sleep', 'go-filesystem', 'go-sockets', 'rust-types-test', 'rust-multi-export', 'rust-async-types'].includes(name)) continue;
      describe(`Guest: ${name}`, () => {
        for (const mode of MODES) {
          it(`run [${mode}]`, async () => {
            await runGuestTest({
              name,
              wasmPath: join(GUEST_OUT, name, 'component.wasm'),
            }, mode);
          });
        }
      });
    }
  }
}
