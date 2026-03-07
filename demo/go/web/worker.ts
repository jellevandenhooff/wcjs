// Web Worker: runs the Go compiler toolchain off the main thread.
//
// Messages IN:  { type: 'build', source: string }
//               { type: 'fmt', source: string }
// Messages OUT: { type: 'log', text: string, cls: string }
//               { type: 'status', text: string }
//               { type: 'progress', pct: number }
//               { type: 'ready' }
//               { type: 'done', ok: boolean, elapsed: string }
//               { type: 'artifacts', artifacts: object }
//               { type: 'fmt-ok', source: string }
//               { type: 'fmt-err', error: string }

import { parseComponent, generateCode } from '@jellevdh/wcjs/codegen';
import * as runtime from '@jellevdh/wcjs/runtime';
import { createCommonP3Ifaces, versionP3Ifaces, p2Stubs, hostReadChunk } from '../../../src/wasi/wasi-shared.ts';
import { MemFS, createMemFSHost } from '../../../src/wasi/memfs.ts';

function log(text: string, cls = '') {
  postMessage({ type: 'log', text, cls });
}
function setStatus(text: string) {
  postMessage({ type: 'status', text });
}
function setProgress(pct: number) {
  postMessage({ type: 'progress', pct });
}

const memfs = new MemFS();
let goInstantiate: Function;
let goCoreModules: Map<string, WebAssembly.Module>;
let componentizePrepared: { instantiate: Function; coreModules: Map<string, WebAssembly.Module> };
let goimportsPrepared: { instantiate: Function; coreModules: Map<string, WebAssembly.Module> };
const componentCache = new Map<string, { instantiate: Function; coreModules: Map<string, WebAssembly.Module> }>();

// Manifest mapping logical → content-hashed filenames
let manifest: Record<string, string> = {};

interface FetchResult { data: Uint8Array; compressedSize: number }

async function fetchBytes(logicalName: string): Promise<FetchResult> {
  const url = manifest[logicalName] || logicalName;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url}: ${resp.status}`);
  if (url.endsWith('.gz')) {
    const compressed = await resp.arrayBuffer();
    const ds = new DecompressionStream('gzip');
    const decompressed = new Blob([compressed]).stream().pipeThrough(ds);
    const data = new Uint8Array(await new Response(decompressed).arrayBuffer());
    return { data, compressedSize: compressed.byteLength };
  }
  const data = new Uint8Array(await resp.arrayBuffer());
  return { data, compressedSize: data.length };
}

function fmtSize(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

async function prepareComponent(name: string, wasmBytes: Uint8Array) {
  const parsed = parseComponent(wasmBytes);
  const result = generateCode(parsed, name, { jspiMode: false, mode: 'js' });
  const coreModules = new Map<string, WebAssembly.Module>();
  for (const m of result.coreModules) {
    coreModules.set(m.fileName, await WebAssembly.compile(m.bytes as BufferSource));
  }
  const instantiate = new Function('runtime', result.source)(runtime);
  return { instantiate, coreModules };
}

// Simple tar parser for loading goroot and gocache
function parseTar(data: Uint8Array, prefix: string) {
  let off = 0;
  let count = 0;
  while (off + 512 <= data.length) {
    const header = data.subarray(off, off + 512);
    if (header.every((b: number) => b === 0)) break;

    const nameRaw = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*/, '');
    const pfx = new TextDecoder().decode(header.subarray(345, 500)).replace(/\0.*/, '');
    const name = pfx ? pfx + '/' + nameRaw : nameRaw;

    const sizeStr = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = header[156];

    off += 512;
    if (type === 0x30 || type === 0) {
      const fileData = data.slice(off, off + size);
      memfs.addFile(prefix + '/' + name, new Uint8Array(fileData));
      count++;
    }
    off += Math.ceil(size / 512) * 512;
  }
  return count;
}

function createFullHost(args: string[], env: [string, string][], cwd: string | undefined, stdoutChunks: any, stderrChunks: any) {
  const ctx: { state: any } = { state: null };
  const fsHost = createMemFSHost(ctx, memfs);
  fsHost.setHostReadChunk(hostReadChunk);

  const common = createCommonP3Ifaces(ctx, {
    args, env, cwd,
    stdoutTarget: stdoutChunks,
    stderrTarget: stderrChunks,
  });

  const monotonicClock = {
    'now': () => BigInt(Math.round(performance.now() * 1e6)),
    'get-resolution': () => 1000n,
    'wait-for': (ns: bigint) => new Promise(r => setTimeout(r, Number(ns) / 1e6)),
    'wait-until': (when: bigint) => {
      const now = BigInt(Math.round(performance.now() * 1e6));
      if (when <= now) return;
      return new Promise(r => setTimeout(r, Number(when - now) / 1e6));
    },
  };

  const execHost = {
    'exec': async (path: string, args: string[], envList: string[], cwd: string | null, stdoutPath: string, stderrPath: string) => {
      try {
        const toolName = path.split('/').pop()!;
        const parts = path.split('/').filter((s: string) => s.length > 0);
        const node = memfs._resolve(parts) as any;
        if (!node || !node.data) {
          return { tag: 'err', val: `exec: cannot read ${path} from memfs` };
        }

        let cached = componentCache.get(path);
        if (!cached) {
          log(`  Compiling ${toolName}...`, 'log-info');
          const name = toolName.replace(/\..*$/, '');
          cached = await prepareComponent(name, node.data);
          componentCache.set(path, cached);
        }

        const envPairs: [string, string][] = envList.map((e: string) => {
          const eq = e.indexOf('=');
          return eq === -1 ? [e, ''] : [e.slice(0, eq), e.slice(eq + 1)];
        });

        const childStdout: string[] = [];
        const childStderr: string[] = [];
        const childHost = createFullHost(args, envPairs, cwd || undefined, childStdout, childStderr);

        const getCoreModule = (p: string) => cached!.coreModules.get(p)!;
        const instance = await cached.instantiate(getCoreModule, childHost) as any;
        childHost._ctx.state = instance.$states[0];

        const runKey = Object.keys(instance).find((k: string) => k.startsWith('wasi:cli/run@'));
        if (!runKey) {
          if (instance.$destroy) instance.$destroy();
          return { tag: 'err', val: `exec: no wasi:cli/run export` };
        }

        log(`  ${toolName} ${args.slice(1).join(' ').slice(0, 80)}`, 'log-info');

        let exitCode = 0;
        try {
          const runResult = await instance[runKey].run();
          if (runResult?.tag === 'err') exitCode = 1;
        } catch (e: any) {
          const m = e.message?.match(/exit with code (\d+)/);
          if (m) exitCode = parseInt(m[1], 10);
          else if (e.message?.includes('exit with error')) exitCode = 1;
          else { childStderr.push(`exec: ${e.message}\n`); exitCode = 1; }
        }

        if (instance.$destroy) instance.$destroy();
        childHost._ctx.state = null;
        for (const key of Object.keys(instance)) delete instance[key];

        const stdoutData = childStdout.join('');
        const stderrData = childStderr.join('');
        if (stdoutData.length > 0) memfs.addFile(stdoutPath, stdoutData);
        if (stderrData.length > 0) {
          memfs.addFile(stderrPath, stderrData);
          for (const line of stderrData.split('\n')) {
            if (line) log(`  ${line}`, exitCode ? 'log-err' : 'log-info');
          }
        }

        return { tag: 'ok', val: exitCode };
      } catch (e: any) {
        return { tag: 'err', val: `exec: ${e.message}` };
      }
    },
  };

  const p3Ifaces: Record<string, any> = {
    ...common,
    'wasi:clocks/monotonic-clock': monotonicClock,
    'wasi:filesystem/types': fsHost.types,
    'wasi:filesystem/preopens': fsHost.preopens,
  };

  const host: any = {
    _stdout: stdoutChunks,
    _stderr: stderrChunks,
    _ctx: ctx,
    ...versionP3Ifaces(p3Ifaces),
    'wasi:exec/exec@0.1.0': execHost,
    ...p2Stubs({ args, env, cwd }, stdoutChunks),
  };
  return host;
}

async function runInstance(prepared: { instantiate: Function; coreModules: Map<string, WebAssembly.Module> }, args: string[], env: [string, string][], cwd: string | undefined, stdoutTarget: any, stderrTarget: any) {
  const host = createFullHost(args, env, cwd, stdoutTarget, stderrTarget);
  const instance = await prepared.instantiate(
    (p: string) => prepared.coreModules.get(p), host
  ) as any;
  host._ctx.state = instance.$states[0];
  const runKey = Object.keys(instance).find((k: string) => k.startsWith('wasi:cli/run@'));
  if (!runKey) throw new Error('no wasi:cli/run export');

  let exitCode = 0;
  try {
    const r = await instance[runKey].run();
    if (r?.tag === 'err') exitCode = 1;
  } catch (e: any) {
    const m = e.message?.match(/exit with code (\d+)/);
    if (m) exitCode = parseInt(m[1], 10);
    else if (e.message?.includes('exit with error')) exitCode = 1;
    else throw e;
  }

  if (instance.$destroy) instance.$destroy();
  host._ctx.state = null;
  for (const key of Object.keys(instance)) delete instance[key];
  return exitCode;
}

// ---- Init ----

async function init() {
  try {
    setStatus('Loading manifest...');
    setProgress(5);

    // Load asset manifest
    const manifestResp = await fetch('manifest.json');
    manifest = await manifestResp.json();

    setStatus('Loading GOROOT...');
    log('Loading GOROOT...', 'log-info');
    const goroot = await fetchBytes('goroot.tar');
    log(`  Downloaded ${fmtSize(goroot.compressedSize)} (${fmtSize(goroot.data.length)} uncompressed)`, 'log-info');
    const fileCount = parseTar(goroot.data, '/goroot');
    log(`  ${fileCount} files loaded`, 'log-info');

    setProgress(30);
    setStatus('Loading tools...');
    log('Loading tool components...', 'log-info');
    for (const tool of ['compile', 'asm', 'link']) {
      log(`  Loading ${tool}.component.wasm...`, 'log-info');
      const r = await fetchBytes(`${tool}.component.wasm`);
      memfs.addFile(`/goroot/pkg/tool/wasip3_wasm32/${tool}`, r.data);
      log(`    ${fmtSize(r.compressedSize)} (${fmtSize(r.data.length)} uncompressed)`, 'log-info');
    }

    setProgress(60);
    setStatus('Loading go compiler...');
    log('Loading go.component.wasm...', 'log-info');
    const goFetch = await fetchBytes('go.component.wasm');
    log(`  ${fmtSize(goFetch.compressedSize)} (${fmtSize(goFetch.data.length)} uncompressed)`, 'log-info');
    const parsed = parseComponent(goFetch.data);
    const result = generateCode(parsed, 'go', { jspiMode: false, mode: 'js' });
    goCoreModules = new Map();
    for (const m of result.coreModules) {
      goCoreModules.set(m.fileName, await WebAssembly.compile(m.bytes as BufferSource));
    }
    goInstantiate = new Function('runtime', result.source)(runtime);

    log('Loading componentize.component.wasm...', 'log-info');
    const compFetch = await fetchBytes('componentize.component.wasm');
    log(`  ${fmtSize(compFetch.compressedSize)} (${fmtSize(compFetch.data.length)} uncompressed)`, 'log-info');
    componentizePrepared = await prepareComponent('componentize', compFetch.data);

    log('Loading goimports.component.wasm...', 'log-info');
    const goimportsFetch = await fetchBytes('goimports.component.wasm');
    log(`  ${fmtSize(goimportsFetch.compressedSize)} (${fmtSize(goimportsFetch.data.length)} uncompressed)`, 'log-info');
    goimportsPrepared = await prepareComponent('goimports', goimportsFetch.data);

    // Set up filesystem
    memfs.addFile('/dev/null', new Uint8Array(0));
    memfs.addDir('/tmp');
    memfs.addDir('/tmp/gocache');
    memfs.addDir('/tmp/gopath');
    memfs.addDir('/out');
    memfs.addDir('/usr/local/bin');
    memfs.addFile('/usr/local/bin/go', goFetch.data);

    // Register pre-warmed build cache for lazy on-demand loading
    setStatus('Loading build cache manifest...');
    log('Loading build cache manifest...', 'log-info');
    try {
      const cacheManifestResp = await fetch('gocache-manifest.json');
      const cacheFileList: { path: string; size: number }[] = await cacheManifestResp.json();
      for (const { path, size } of cacheFileList) {
        // path has .gz suffix; strip it for the memfs path
        const memfsPath = path.replace(/\.gz$/, '');
        const parts = memfsPath.split('/');
        if (parts.length > 1) {
          memfs.addDir('/tmp/gocache/' + parts.slice(0, -1).join('/'));
        }
        memfs.addLazyFile('/tmp/gocache/' + memfsPath, 'gocache/' + path, size);
      }
      log(`  ${cacheFileList.length} cache files registered (lazy)`, 'log-info');
    } catch (e: any) {
      log(`  Build cache not available: ${e.message}`, 'log-info');
    }

    setProgress(100);
    setStatus('Ready');
    log('Ready! Click "Build & Run" to compile.', 'log-ok');
    postMessage({ type: 'ready' });
  } catch (e: any) {
    log('Init error: ' + e.message, 'log-err');
    log(e.stack, 'log-err');
    setStatus('Error');
  }
}

// ---- Build ----

async function build(source: string) {
  setStatus('Compiling...');
  setProgress(10);

  try {
    memfs.addFile('/work/main.go', source);
    memfs.addFile('/work/go.mod', 'module hello\n\ngo 1.27\n');
    memfs.addDir('/out');

    const goArgs = ['go', 'build', '-C', '/work', '-v', '-o', '/out/hello.wasm', '.'];
    const goEnv: [string, string][] = [
      ['GOROOT', '/goroot'],
      ['GOOS', 'wasip3'],
      ['GOARCH', 'wasm32'],
      ['GOPATH', '/tmp/gopath'],
      ['GOCACHE', '/tmp/gocache'],
      ['HOME', '/tmp'],
      ['GOTOOLCHAIN', 'local'],
    ];

    const stdoutStream = { write(s: string) { log('[stdout] ' + s.trimEnd(), 'log-info'); } };
    const stderrStream = {
      write(s: string) {
        for (const line of s.split('\n')) {
          if (!line) continue;
          if (line.startsWith('# ') || line.includes('Error') || line.includes('error')) {
            log(line, 'log-err');
          } else {
            log(line, 'log-pkg');
          }
        }
      },
    };

    const t0 = performance.now();
    const goPrepared = { instantiate: goInstantiate, coreModules: goCoreModules };
    const exitCode = await runInstance(goPrepared, goArgs, goEnv, '/work', stdoutStream, stderrStream);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

    if (exitCode !== 0) {
      log(`\nBuild failed (exit code ${exitCode}) in ${elapsed}s`, 'log-err');
      setStatus('Build failed');
      setProgress(0);
      postMessage({ type: 'done', ok: false, elapsed });
      return;
    }

    const outNode = memfs._resolve(['out', 'hello.wasm']) as any;
    const size = outNode?.data?.length || 0;
    log(`\nBuild succeeded in ${elapsed}s`, 'log-ok');
    log(`Output: /out/hello.wasm (${(size / 1024).toFixed(0)} KB)`, 'log-ok');

    // Componentize
    if (outNode && outNode.data) {
      log(`\nComponentizing...`, 'log-info');
      setStatus('Componentizing...');
      const compStderr: string[] = [];
      const compExit = await runInstance(
        componentizePrepared,
        ['componentize', '/out/hello.wasm', '/out/hello.component.wasm'],
        [['GOROOT', '/goroot']],
        '/',
        [], compStderr,
      );
      if (compStderr.length > 0) log(compStderr.join(''), 'log-err');
      if (compExit !== 0) {
        log('Componentize failed', 'log-err');
        postMessage({ type: 'done', ok: false, elapsed });
        return;
      }

      // Run + generate downloadable artifacts
      const helloNode = memfs._resolve(['out', 'hello.component.wasm']) as any;
      if (helloNode && helloNode.data) {
        log(`Running...`, 'log-info');
        setStatus('Running...');
        const helloBytes = new Uint8Array(helloNode.data);
        const helloPrepared = await prepareComponent('hello', helloBytes);
        const runStdout = { write(s: string) { log(s.trimEnd(), 'log-ok'); } };
        const runStderr = { write(s: string) { log(s.trimEnd(), 'log-err'); } };
        try {
          await runInstance(helloPrepared, ['hello'], [], undefined, runStdout, runStderr);
        } catch (e: any) {
          if (!e.message?.match(/exit with code 0/)) {
            log('Runtime error: ' + e.message, 'log-err');
          }
        }

        // Generate JS bindings for download
        const parsed = parseComponent(helloBytes);
        const gen = generateCode(parsed, 'hello', { jspiMode: false, mode: 'standalone' });
        const artifacts = {
          componentWasm: helloBytes,
          jsSource: gen.source,
          dtsSource: (gen as any).declarations || '',
          coreModules: gen.coreModules.map((m: any) => ({ fileName: m.fileName, bytes: m.bytes })),
        };
        postMessage({ type: 'artifacts', artifacts });
      }
    }

    setStatus(`Built in ${elapsed}s`);
    setProgress(100);
    postMessage({ type: 'done', ok: true, elapsed });
  } catch (e: any) {
    log('Build error: ' + e.message, 'log-err');
    log(e.stack, 'log-err');
    setStatus('Error');
    postMessage({ type: 'done', ok: false, elapsed: '0' });
  }
}

// ---- Fmt ----

async function fmt(source: string) {
  try {
    memfs.addFile('/work/main.go', source);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const exitCode = await runInstance(
      goimportsPrepared,
      ['goimports', '/work/main.go'],
      [
        ['GOROOT', '/goroot'],
        ['GOPATH', '/tmp/gopath'],
        ['GOCACHE', '/tmp/gocache'],
        ['HOME', '/tmp'],
        ['PATH', '/usr/local/bin'],
        ['GOTOOLCHAIN', 'local'],
      ],
      '/',
      stdoutChunks, stderrChunks,
    );

    const stderr = stderrChunks.join('');
    const stdout = stdoutChunks.join('');
    if (exitCode !== 0) {
      postMessage({ type: 'fmt-err', error: stderr || 'goimports failed' });
    } else {
      postMessage({ type: 'fmt-ok', source: stdout || source });
    }
  } catch (e: any) {
    postMessage({ type: 'fmt-err', error: e.message });
  }
}

// ---- Message handler ----

self.onmessage = (e: MessageEvent) => {
  if (e.data.type === 'build') {
    build(e.data.source);
  } else if (e.data.type === 'fmt') {
    fmt(e.data.source);
  }
};

init();
