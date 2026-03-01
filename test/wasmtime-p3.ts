// Wasmtime P3 test suite: ported from wasmtime's test-programs
//
// Expects pre-compiled wasmtime P3 test component binaries in
// test/guest/out/wasmtime-p3/<name>.component.wasm
// (copied by test/guest/copy-wasmtime-tests.sh).
// Tests both 'ts' and 'js' codegen modes.

import { describe, it, assert } from './runner.ts';
import { createWasiHost, hostReadChunk } from '../src/wasi/wasi-host.ts';
import { fieldsOf, requestsOf, responsesOf, newRep } from '../src/wasi/wasi-http.ts';
import type { HttpHostContext } from '../src/wasi/wasi-http.ts';
import { instantiate, MODES, type CodegenMode } from './pipeline.ts';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import type { ReadableStreamEnd } from '../src/runtime/stream.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(__dirname, 'guest', 'out', 'wasmtime-p3');
const GEN_OUT = join(__dirname, 'out', 'wasmtime-p3');

// =====================================================================
// Test runner
// =====================================================================

interface P3TestConfig {
  name: string;
  args?: string[];
  env?: [string, string][];
  preopens?: [string, string][];
  timeout?: number;
}

async function runP3Test(config: P3TestConfig, mode: CodegenMode): Promise<{ stdout: string; stderr: string }> {
  const wasmPath = join(WASM_DIR, `${config.name}.component.wasm`);
  if (!existsSync(wasmPath)) {
    throw new Error(`wasmtime test component not found: ${wasmPath}\nRun: bash test/guest/copy-wasmtime-tests.sh`);
  }

  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const wasiHost = createWasiHost({
    args: config.args || [config.name, '.'],
    env: config.env || [['HOME', '/tmp']],
    stdout: stdoutBuf,
    stderr: stderrBuf,
    preopens: config.preopens,
  });

  const instance = await instantiate(config.name, wasmPath, wasiHost, {
    jspi: true, mode, outDir: join(GEN_OUT, config.name),
  });
  wasiHost._ctx.state = instance.$states[0];

  const TEST_TIMEOUT = config.timeout || 30_000;
  try {
    // Find the wasi:cli/run export (version may vary between wasmtime builds)
    const runKey = Object.keys(instance).find(k => k.startsWith('wasi:cli/run@'));
    const runExport = runKey ? instance[runKey] as Record<string, Function> : null;
    if (!runExport || typeof runExport.run !== 'function') {
      throw new Error(`no wasi:cli/run export found (exports: ${JSON.stringify(Object.keys(instance))})`);
    }

    let result: unknown;
    try {
      result = await Promise.race([
        runExport.run(),
        new Promise((_, reject) => setTimeout(() => {
          reject(new Error(`wasmtime P3 test timed out after ${TEST_TIMEOUT}ms`));
        }, TEST_TIMEOUT)),
      ]);
    } catch (err) {
      const stdout = stdoutBuf.join('');
      const stderr = stderrBuf.join('');
      if (stdout) console.error('  stdout:', stdout.trimEnd());
      if (stderr) console.error('  stderr:', stderr.trimEnd());
      throw err;
    }

    if (result && typeof result === 'object' && 'tag' in (result as any)) {
      if ((result as any).tag !== 'ok') {
        const stdout = stdoutBuf.join('');
        const stderr = stderrBuf.join('');
        if (stdout) console.error('  stdout:', stdout.trimEnd());
        if (stderr) console.error('  stderr:', stderr.trimEnd());
        throw new Error(`guest returned error: ${JSON.stringify(result)}`);
      }
    }
  } finally {
    if (instance.$destroy && typeof instance.$destroy === 'function') {
      instance.$destroy();
    }
  }

  return { stdout: stdoutBuf.join(''), stderr: stderrBuf.join('') };
}

// =====================================================================
// HTTP handler test runner
// =====================================================================

interface HttpHandlerConfig {
  name: string;
  request: {
    method?: string;
    uri?: string;
    headers?: [string, string][];
    body?: Uint8Array;
    trailers?: [string, string][];
  };
  env?: [string, string][];
  timeout?: number;
}

interface HttpHandlerResponse {
  status: number;
  headers: [string, Uint8Array][];
  body: Uint8Array;
  trailers: [string, Uint8Array][] | null;
}

async function runHttpHandler(config: HttpHandlerConfig, mode: CodegenMode): Promise<HttpHandlerResponse> {
  const wasmPath = join(WASM_DIR, `${config.name}.component.wasm`);
  if (!existsSync(wasmPath)) {
    throw new Error(`wasmtime test component not found: ${wasmPath}\nRun: bash test/guest/copy-wasmtime-tests.sh`);
  }

  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const wasiHost = createWasiHost({
    args: [config.name],
    env: config.env || [['HOME', '/tmp']],
    stdout: stdoutBuf,
    stderr: stderrBuf,
  });

  const instance = await instantiate(config.name, wasmPath, wasiHost, {
    jspi: true, mode, outDir: join(GEN_OUT, config.name),
  });
  const state = instance.$states[0];
  const ctx = wasiHost._ctx as HttpHostContext;
  ctx.state = state;
  ctx.handlerMode = true;

  const TEST_TIMEOUT = config.timeout || 30_000;

  try {
    // Find the handler export
    const handlerKey = Object.keys(instance).find(k => k.startsWith('wasi:http/handler@'));
    const handlerExport = handlerKey ? instance[handlerKey] as Record<string, Function> : null;
    if (!handlerExport || typeof handlerExport.handle !== 'function') {
      throw new Error(`no wasi:http/handler export found (exports: ${JSON.stringify(Object.keys(instance))})`);
    }

    // Create request resources in the host
    const enc = new TextEncoder();
    const reqHeaders = config.request.headers || [];

    // 1. Create fields resource
    const headersRep = newRep(ctx);
    fieldsOf(ctx).set(headersRep, {
      entries: reqHeaders.map(([n, v]) => [n, enc.encode(v)] as [string, Uint8Array]),
      immutable: false,
    });

    // 2. Create body stream pair (host writes → component reads)
    let bodyStreamRi: number | null = null;
    let bodyStreamWi: number | null = null;
    if (config.request.body && config.request.body.length > 0) {
      const sPacked = state.streamNew(0);
      bodyStreamRi = Number(sPacked & 0xFFFFFFFFn);
      bodyStreamWi = Number(sPacked >> 32n);
    }

    // 3. Create trailers future pair (host writes → component reads)
    const fPacked = state.futureNew(0);
    const trailersFutureRi = Number(fPacked & 0xFFFFFFFFn);
    const trailersFutureWi = Number(fPacked >> 32n);

    // 4. Create request resource
    const reqRep = newRep(ctx);
    requestsOf(ctx).set(reqRep, {
      method: config.request.method
        ? (['get', 'head', 'post', 'put', 'delete', 'connect', 'options', 'trace', 'patch'].includes(config.request.method.toLowerCase())
          ? { tag: config.request.method.toLowerCase() as any }
          : { tag: 'other', val: config.request.method })
        : { tag: 'get' },
      pathWithQuery: config.request.uri ? new URL(config.request.uri).pathname + (new URL(config.request.uri).search || '') : '/',
      scheme: config.request.uri
        ? (new URL(config.request.uri).protocol === 'https:' ? { tag: 'HTTPS' as const } : { tag: 'HTTP' as const })
        : { tag: 'HTTP' as const },
      authority: config.request.uri ? new URL(config.request.uri).host : 'localhost',
      headersRep,
      bodyStreamHandle: bodyStreamRi,
      trailersFutureHandle: trailersFutureRi,
      optionsRep: null,
    });

    // Mark headers as immutable
    const hdr = fieldsOf(ctx).get(headersRep);
    if (hdr) hdr.immutable = true;

    // 5. Register request rep in the component state's resource table
    // Resource type index for 'request' — type index 1 based on generated code
    const requestHandle = state.resourceNew(1, reqRep);

    // 6. Write body + trailers (must happen concurrently with handler)
    // Use streamWriteHost with callback to ensure flow control
    const writeBodyAndTrailers = () => {
      if (bodyStreamWi !== null && config.request.body) {
        state.streamWriteHost(0, bodyStreamWi, Array.from(config.request.body), () => {
          state.streamDropWritable(0, bodyStreamWi!);
        });
      }

      // Write trailers
      if (config.request.trailers && config.request.trailers.length > 0) {
        const trailersRep = newRep(ctx);
        fieldsOf(ctx).set(trailersRep, {
          entries: config.request.trailers.map(([n, v]) => [n, enc.encode(v)] as [string, Uint8Array]),
          immutable: true,
        });
        state.futureWriteHost(0, trailersFutureWi, [{ tag: 'ok', val: trailersRep }]);
      } else {
        state.futureWriteHost(0, trailersFutureWi, [{ tag: 'ok', val: null }]);
      }
    };

    // 7. Start handler and write body concurrently
    writeBodyAndTrailers();
    const handleResult = await Promise.race([
      handlerExport.handle!(requestHandle),
      new Promise((_, reject) => setTimeout(() => {
        reject(new Error(`HTTP handler test timed out after ${TEST_TIMEOUT}ms`));
      }, TEST_TIMEOUT)),
    ]);

    // 8. Check result
    if (handleResult && typeof handleResult === 'object' && 'tag' in (handleResult as any)) {
      if ((handleResult as any).tag !== 'ok') {
        const stdout = stdoutBuf.join('');
        const stderr = stderrBuf.join('');
        if (stdout) console.error('  stdout:', stdout.trimEnd());
        if (stderr) console.error('  stderr:', stderr.trimEnd());
        throw new Error(`handler returned error: ${JSON.stringify(handleResult)}`);
      }
    }

    // 9. Find the response from lastResponseRep
    const respRep = ctx.lastResponseRep;
    if (respRep === undefined) {
      throw new Error('handler did not create a response');
    }
    const resp = responsesOf(ctx).get(respRep);
    if (!resp) {
      throw new Error(`response rep ${respRep} not found in responsesOf(ctx)`);
    }

    // 10. Read response data
    const respStatus = resp.statusCode;
    const respHeaders = fieldsOf(ctx).get(resp.headersRep)?.entries || [];

    // Read response body: either eagerly drained (response.new) or from nodeResponse
    let respBody = resp.body;
    if (resp.nodeResponse && respBody.length === 0) {
      // Body from outbound HTTP response — drain the IncomingMessage
      const chunks: Buffer[] = [];
      for await (const chunk of resp.nodeResponse) {
        if (chunk && chunk.length > 0) chunks.push(chunk as Buffer);
      }
      if (chunks.length > 0) {
        respBody = Buffer.concat(chunks);
      }
    }

    // Response trailers not read (future was drained in response.new)
    const respTrailers: [string, Uint8Array][] | null = null;

    // Clean up response
    responsesOf(ctx).delete(respRep);

    return {
      status: respStatus,
      headers: respHeaders,
      body: respBody,
      trailers: respTrailers,
    };
  } finally {
    if (instance.$destroy && typeof instance.$destroy === 'function') {
      instance.$destroy();
    }
  }
}

// =====================================================================
// Test registration
// =====================================================================

if (!existsSync(WASM_DIR)) {
  describe('Wasmtime P3', () => {
    it.skip('no wasmtime P3 test components (run test/guest/copy-wasmtime-tests.sh)', () => {});
  });
} else {
  // --- CLI tests ---
  describe('Wasmtime P3: cli-hello-stdout', () => {
    for (const mode of MODES) {
      it(`prints hello world [${mode}]`, async () => {
        const { stdout } = await runP3Test({ name: 'p3_cli_hello_stdout' }, mode);
        assert.ok(stdout.includes('hello, world'), `expected "hello, world" in stdout, got: ${JSON.stringify(stdout)}`);
      });
    }
  });

  describe('Wasmtime P3: cli', () => {
    for (const mode of MODES) {
      it(`basic CLI operations [${mode}]`, async () => {
        await runP3Test({ name: 'p3_cli', args: ['p3_cli.component', '.'] }, mode);
      });
    }
  });

  describe('Wasmtime P3: cli-much-stdout', () => {
    for (const mode of MODES) {
      it(`writes large stdout [${mode}]`, async () => {
        await runP3Test({ name: 'p3_cli_much_stdout', args: ['p3_cli_much_stdout', 'x', '100'] }, mode);
      });
    }
  });

  // --- Random tests ---
  describe('Wasmtime P3: random-imports', () => {
    for (const mode of MODES) {
      it(`random number generation [${mode}]`, async () => {
        await runP3Test({ name: 'p3_random_imports' }, mode);
      });
    }
  });

  // --- Clock tests ---
  describe('Wasmtime P3: clocks-sleep', () => {
    for (const mode of MODES) {
      it(`monotonic clock sleep [${mode}]`, async () => {
        await runP3Test({ name: 'p3_clocks_sleep' }, mode);
      });
    }
  });

  // --- Filesystem tests ---
  const fsTests = ['p3_filesystem_file_read_write', 'p3_readdir', 'p3_file_write'];
  for (const name of fsTests) {
    const label = name.replace(/^p3_/, '').replace(/_/g, '-');
    describe(`Wasmtime P3: ${label}`, () => {
      for (const mode of MODES) {
        it(`runs [${mode}]`, async () => {
          const testDir = join(tmpdir(), `wasip3-wt-${name}-${mode}-${Date.now()}`);
          mkdirSync(testDir, { recursive: true });
          try {
            await runP3Test({
              name,
              args: [name, '.'],
              preopens: [['.', testDir]],
              timeout: 30_000,
            }, mode);
          } finally {
            rmSync(testDir, { recursive: true, force: true });
          }
        });
      }
    });
  }

  // --- TCP socket tests ---
  const tcpTests = [
    'p3_sockets_tcp_bind',
    'p3_sockets_tcp_connect',
    'p3_sockets_tcp_sample_application',
    'p3_sockets_tcp_sockopts',
    'p3_sockets_tcp_states',
    'p3_sockets_tcp_streams',
  ];
  for (const name of tcpTests) {
    const label = name.replace(/^p3_/, '').replace(/_/g, '-');
    describe(`Wasmtime P3: ${label}`, () => {
      for (const mode of MODES) {
        it(`runs [${mode}]`, async () => {
          await runP3Test({ name, timeout: 30_000 }, mode);
        });
      }
    });
  }

  // --- UDP socket tests ---
  const udpTests = [
    'p3_sockets_udp_bind',
    'p3_sockets_udp_connect',
    'p3_sockets_udp_sockopts',
    'p3_sockets_udp_states',
  ];
  for (const name of udpTests) {
    const label = name.replace(/^p3_/, '').replace(/_/g, '-');
    describe(`Wasmtime P3: ${label}`, () => {
      for (const mode of MODES) {
        it(`runs [${mode}]`, async () => {
          await runP3Test({ name, timeout: 30_000 }, mode);
        });
      }
    });
  }

  // Skipped: p3_sockets_udp_sample_application
  // The second join! in the guest doesn't poll both futures within a single
  // callback turn (wit-bindgen async runtime limitation). The send side of
  // the join is never started, so the receive hangs waiting for a message
  // that is never sent.

  // --- DNS tests ---
  describe('Wasmtime P3: ip-name-lookup', () => {
    for (const mode of MODES) {
      it(`resolves addresses [${mode}]`, async () => {
        await runP3Test({ name: 'p3_sockets_ip_name_lookup', timeout: 30_000 }, mode);
      });
    }
  });

  // --- HTTP tests ---

  // Echo HTTP server: reflects method, URI, and body in the response.
  // Returns x-wasmtime-test-method and x-wasmtime-test-uri headers.
  let httpServer: http.Server | null = null;
  let httpAddr = '';

  async function startEchoServer(): Promise<string> {
    if (httpServer) return httpAddr;
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        // Stream the request body directly as the response body (like
        // wasmtime's test server). Send response headers immediately so the
        // client can resolve the fetch before the body is fully received.
        res.setHeader('x-wasmtime-test-method', req.method || 'GET');
        res.setHeader('x-wasmtime-test-uri', req.url || '/');
        res.writeHead(200);
        res.flushHeaders();
        req.pipe(res);
      });
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as { port: number };
        httpAddr = `127.0.0.1:${addr.port}`;
        httpServer = srv;
        srv.unref(); // Don't keep process alive
        resolve(httpAddr);
      });
    });
  }

  // -- HTTP outbound tests (need echo server) --
  const httpOutboundEchoTests = [
    'p3_http_outbound_request_get',
    'p3_http_outbound_request_post',
    'p3_http_outbound_request_put',
    'p3_http_outbound_request_large_post',
    'p3_http_outbound_request_content_length',
    'p3_http_outbound_request_missing_path_and_query',
  ];
  for (const name of httpOutboundEchoTests) {
    const label = name.replace(/^p3_/, '').replace(/_/g, '-');
    describe(`Wasmtime P3: ${label}`, () => {
      for (const mode of MODES) {
        it(`runs [${mode}]`, async () => {
          const addr = await startEchoServer();
          await runP3Test({
            name,
            env: [['HOME', '/tmp'], ['HTTP_SERVER', addr]],
            timeout: 30_000,
          }, mode);
        });
      }
    });
  }

  // -- HTTP outbound tests (no server needed) --
  const httpOutboundNoServerTests = [
    'p3_http_outbound_request_invalid_dnsname',
    'p3_http_outbound_request_response_build',
    'p3_http_outbound_request_invalid_port',
    'p3_http_outbound_request_unknown_method',
    'p3_http_outbound_request_unsupported_scheme',
    'p3_http_outbound_request_invalid_header',
  ];
  for (const name of httpOutboundNoServerTests) {
    const label = name.replace(/^p3_/, '').replace(/_/g, '-');
    describe(`Wasmtime P3: ${label}`, () => {
      for (const mode of MODES) {
        it(`runs [${mode}]`, async () => {
          await runP3Test({ name, timeout: 30_000 }, mode);
        });
      }
    });
  }

  // -- HTTP handler tests --
  describe('Wasmtime P3: http-echo', () => {
    for (const mode of MODES) {
      it(`echoes request headers, body, and trailers [${mode}]`, async () => {
        const body = new TextEncoder().encode('And the mome raths outgrabe');
        const response = await runHttpHandler({
          name: 'p3_http_echo',
          request: {
            method: 'GET',
            uri: 'http://localhost/',
            headers: [['foo', 'bar']],
            body,
            trailers: [['fizz', 'buzz']],
          },
          timeout: 30_000,
        }, mode);

        assert.strictEqual(response.status, 200, `expected status 200, got ${response.status}`);

        // Check headers echoed back
        const fooHeader = response.headers.find(([n]) => n.toLowerCase() === 'foo');
        assert.ok(fooHeader, 'expected foo header in response');
        assert.strictEqual(new TextDecoder().decode(fooHeader![1]), 'bar');

        // Check body echoed back
        const respBodyStr = new TextDecoder().decode(response.body);
        assert.strictEqual(respBodyStr, 'And the mome raths outgrabe',
          `expected echoed body, got: ${JSON.stringify(respBodyStr)}`);
      });
    }
  });

  describe('Wasmtime P3: http-proxy', () => {
    for (const mode of MODES) {
      it(`forwards request to outbound HTTP [${mode}]`, async () => {
        const addr = await startEchoServer();
        const body = new TextEncoder().encode('And the mome raths outgrabe');
        const response = await runHttpHandler({
          name: 'p3_http_proxy',
          request: {
            method: 'GET',
            uri: 'http://localhost/',
            headers: [['url', `http://${addr}/`]],
            body,
          },
          timeout: 30_000,
        }, mode);

        assert.strictEqual(response.status, 200, `expected status 200, got ${response.status}`);

        // The proxy forwards the request body to the echo server
        // The echo server echoes it back as the response body
        const respBodyStr = new TextDecoder().decode(response.body);
        assert.strictEqual(respBodyStr, 'And the mome raths outgrabe',
          `expected forwarded body, got: ${JSON.stringify(respBodyStr)}`);
      });
    }
  });
}
