// Pre-warm the Go build cache by running `go build` in-memory via wcjs.
// Outputs individual cache files alongside the tool wasm files.
//
// Usage: node --experimental-transform-types --stack-size=4194304 bundle-cache.ts <godir> <outdir>

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { parseComponent, generateCode } from '../../../src/codegen/index.ts';
import * as runtime from '../../../src/runtime/index.ts';
import { createCommonP3Ifaces, versionP3Ifaces, p2Stubs, hostReadChunk } from '../../../src/wasi/wasi-shared.ts';
import { MemFS, createMemFSHost } from '../../../src/wasi/memfs.ts';

const GODIR = resolve(process.argv[2] || '.');
const OUTDIR = resolve(process.argv[3] || '.');
const GOROOT_GUEST = '/goroot';

console.log('Building in-memory filesystem...');
const memfs = new MemFS();

// Load GOROOT from goroot.tar
const GOROOT_TAR = join(OUTDIR, 'goroot.tar');
console.log(`  Loading from ${GOROOT_TAR}...`);

const tmpDir = mkdtempSync(join(tmpdir(), 'goroot-'));
execFileSync('tar', ['xf', GOROOT_TAR, '-C', tmpDir]);

let fileCount = 0;
function walkDir(hostDir: string, guestDir: string): void {
  for (const ent of readdirSync(hostDir, { withFileTypes: true })) {
    const hp = join(hostDir, ent.name);
    const gp = guestDir + '/' + ent.name;
    if (ent.isDirectory()) {
      memfs.addDir(gp);
      walkDir(hp, gp);
    } else if (ent.isFile()) {
      memfs.addFile(gp, new Uint8Array(readFileSync(hp)));
      fileCount++;
    }
  }
}
walkDir(tmpDir, GOROOT_GUEST);
rmSync(tmpDir, { recursive: true, force: true });
console.log(`  Loaded ${fileCount} files`);

// Load tool components
console.log('  Loading tool components...');
const toolDir = GOROOT_GUEST + '/pkg/tool/wasip3_wasm32';
for (const tool of ['compile', 'asm', 'link']) {
  const data = new Uint8Array(readFileSync(join(OUTDIR, `${tool}.component.wasm`)));
  memfs.addFile(`${toolDir}/${tool}`, data);
  console.log(`    ${tool}: ${(data.length / 1024 / 1024).toFixed(1)} MB`);
}

// Set up filesystem dirs
memfs.addFile('/dev/null', new Uint8Array(0));
memfs.addDir('/tmp');
memfs.addDir('/tmp/gocache');
memfs.addDir('/tmp/gopath');
memfs.addDir('/out');

// Prepare go.component.wasm
console.log('Loading go.component.wasm...');
const goWasmBytes = new Uint8Array(readFileSync(join(OUTDIR, 'go.component.wasm')));
const parsed = parseComponent(goWasmBytes);
const result = generateCode(parsed, 'go', { jspiMode: false, mode: 'js' });
const goCoreModules = new Map(result.coreModules.map((m: any) => [m.fileName, new WebAssembly.Module(m.bytes)]));
const goInstantiate = new Function('runtime', result.source)(runtime);

const componentCache = new Map<string, { instantiate: Function; coreModules: Map<string, WebAssembly.Module> }>();

function prepareComponent(name: string, wasmBytes: Uint8Array) {
  const p = parseComponent(wasmBytes);
  const r = generateCode(p, name, { jspiMode: false, mode: 'js' });
  const coreModules = new Map(r.coreModules.map((m: any) => [m.fileName, new WebAssembly.Module(m.bytes)]));
  const instantiate = new Function('runtime', r.source)(runtime);
  return { instantiate, coreModules };
}

function createFullHost(args: string[], env: [string, string][], cwd: string | undefined, stdoutChunks: any, stderrChunks: any) {
  const ctx: { state: any } = { state: null };
  const fsHost = createMemFSHost(ctx, memfs);
  fsHost.setHostReadChunk(hostReadChunk);
  const common = createCommonP3Ifaces(ctx, { args, env, cwd, stdoutTarget: stdoutChunks, stderrTarget: stderrChunks });
  const monotonicClock = {
    'now': () => process.hrtime.bigint(),
    'get-resolution': () => 1n,
    'wait-for': (ns: bigint) => { if (ns <= 0n) return; return new Promise(r => setTimeout(r, Number(ns) / 1e6)); },
    'wait-until': (when: bigint) => { const now = process.hrtime.bigint(); if (when <= now) return; return new Promise(r => setTimeout(r, Number(when - now) / 1e6)); },
  };
  const execHost = {
    'exec': async (path: string, args: string[], envList: string[], cwd: string | null, stdoutPath: string, stderrPath: string) => {
      try {
        const parts = path.split('/').filter((s: string) => s.length > 0);
        const node = memfs._resolve(parts) as any;
        if (!node || !node.data) return { tag: 'err', val: `exec: cannot read ${path}` };
        let cached = componentCache.get(path);
        if (!cached) {
          const name = path.split('/').pop()!.replace(/\..*$/, '');
          cached = prepareComponent(name, node.data);
          componentCache.set(path, cached);
        }
        const envPairs: [string, string][] = envList.map(e => { const eq = e.indexOf('='); return eq === -1 ? [e, ''] : [e.slice(0, eq), e.slice(eq + 1)]; });
        const childStdout: string[] = [], childStderr: string[] = [];
        const childHost = createFullHost(args, envPairs, cwd || undefined, childStdout, childStderr);
        const instance = await cached.instantiate((p: string) => cached!.coreModules.get(p), childHost) as any;
        childHost._ctx.state = instance.$states[0];
        const runKey = Object.keys(instance).find((k: string) => k.startsWith('wasi:cli/run@'));
        if (!runKey) { if (instance.$destroy) instance.$destroy(); return { tag: 'err', val: 'no run export' }; }
        let exitCode = 0;
        try { const r = await instance[runKey].run(); if (r?.tag === 'err') exitCode = 1; }
        catch (e: any) { const m = e.message?.match(/exit with code (\d+)/); if (m) exitCode = parseInt(m[1]); else if (e.message?.includes('exit with error')) exitCode = 1; else { childStderr.push(`exec: ${e.message}\n`); exitCode = 1; } }
        if (instance.$destroy) instance.$destroy();
        childHost._ctx.state = null;
        for (const key of Object.keys(instance)) delete instance[key];
        const stdoutData = childStdout.join(''), stderrData = childStderr.join('');
        if (stdoutData.length > 0) memfs.addFile(stdoutPath, stdoutData);
        if (stderrData.length > 0) memfs.addFile(stderrPath, stderrData);
        return { tag: 'ok', val: exitCode };
      } catch (e: any) { return { tag: 'err', val: `exec: ${e.message}` }; }
    },
  };
  const p3Ifaces = { ...common, 'wasi:clocks/monotonic-clock': monotonicClock, 'wasi:filesystem/types': fsHost.types, 'wasi:filesystem/preopens': fsHost.preopens };
  return { _stdout: stdoutChunks, _stderr: stderrChunks, _ctx: ctx, ...versionP3Ifaces(p3Ifaces), 'wasi:exec/exec@0.1.0': execHost, ...p2Stubs({ args, env, cwd }, stdoutChunks) };
}

// Run `go build` on commonly used packages to populate cache.
// Building all of std takes too long; these cover the most common imports.
const CACHE_PKGS = [
  'fmt', 'os', 'io', 'strings', 'strconv', 'errors',
  'math', 'sort', 'bytes', 'bufio', 'path/filepath',
  'encoding/json', 'flag', 'log', 'time', 'context',
  'sync', 'maps', 'slices',
];
console.log(`Running go build on ${CACHE_PKGS.length} packages to populate cache...`);
const goArgs = ['go', 'build', '-v', ...CACHE_PKGS];
const goEnv: [string, string][] = [
  ['GOROOT', GOROOT_GUEST],
  ['GOOS', 'wasip3'],
  ['GOARCH', 'wasm32'],
  ['GOPATH', '/tmp/gopath'],
  ['GOCACHE', '/tmp/gocache'],
  ['HOME', '/tmp'],
  ['GOTOOLCHAIN', 'local'],
];

const stdoutChunks = { write(s: string) { process.stdout.write(s); } };
const stderrChunks = { write(s: string) { process.stderr.write(s); } };

const host = createFullHost(goArgs, goEnv, '/', stdoutChunks, stderrChunks);
const instance = await goInstantiate((p: string) => goCoreModules.get(p), host) as any;
host._ctx.state = instance.$states[0];
const runKey = Object.keys(instance).find((k: string) => k.startsWith('wasi:cli/run@'))!;

const t0 = performance.now();
try {
  const r = await instance[runKey].run();
  if (r?.tag === 'err') { console.error('Build failed'); process.exit(1); }
} catch (e: any) {
  const m = e.message?.match(/exit with code (\d+)/);
  if (m && parseInt(m[1]) !== 0) { console.error('Build failed with exit code', m[1]); process.exit(1); }
  if (!m) { console.error('Error:', e.message); process.exit(1); }
}
console.log(`\nBuild completed in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// Extract cache from memfs to individual files in outdir/gocache/
console.log('\nExtracting cache...');
const cacheOutDir = join(OUTDIR, 'gocache');
mkdirSync(cacheOutDir, { recursive: true });

const cacheFiles: { path: string; size: number }[] = [];
let totalCacheSize = 0;

function extractMemfs(node: any, relPath: string, hostDir: string): void {
  if (node.entries) {
    mkdirSync(hostDir, { recursive: true });
    for (const [name, child] of node.entries) {
      extractMemfs(child, relPath ? relPath + '/' + name : name, join(hostDir, name));
    }
  } else if (node.buf !== undefined) {
    writeFileSync(hostDir, node.data);
    cacheFiles.push({ path: relPath, size: node.data.length });
    totalCacheSize += node.data.length;
  }
}

const cacheNode = memfs._resolve(['tmp', 'gocache']);
if (!cacheNode) { console.error('No cache found'); process.exit(1); }
extractMemfs(cacheNode, '', cacheOutDir);

// Write manifest listing all cache files with sizes
const manifestPath = join(OUTDIR, 'gocache-manifest.json');
writeFileSync(manifestPath, JSON.stringify(cacheFiles));
console.log(`  Extracted ${cacheFiles.length} files (${(totalCacheSize / 1024 / 1024).toFixed(1)} MB) to ${cacheOutDir}/`);
console.log(`  Manifest: ${manifestPath}`);

process.exit(0);
