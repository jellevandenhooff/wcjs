// Post-process wasm source map: embed sourcesContent, prefix all paths with wasm/.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const mapPath = process.argv[2]!;
const map = JSON.parse(readFileSync(mapPath, 'utf8'));

// Discover lookup roots
const sysroot = execSync('rustc --print sysroot', { encoding: 'utf8' }).trim();
const sysrootLib = `${sysroot}/lib/rustlib/src/rust/`;
const cargoRegistry = `${process.env.HOME}/.cargo/registry/src`;

// Extract crate directories from the absolute paths already in the source map.
// This gives us the exact versions used, so relative paths resolve correctly.
const crateDirs = new Map<string, string>();
for (const src of map.sources as string[]) {
  const m = src.match(/(.+\/([^/]+)-[\d.]+)\//);
  if (m && src.includes('.cargo/registry')) {
    const [, dir, name] = m;
    if (!crateDirs.has(name!)) crateDirs.set(name!, dir!);
  }
}
const witBindgenDir = crateDirs.get('wit-bindgen') ?? '';

// Scan cargo registry for a crate containing a relative src/ path
function findInRegistry(relPath: string): [string, string] | null {
  try {
    const dirs = execSync(`ls -d ${cargoRegistry}/*/`, { encoding: 'utf8' }).trim().split('\n');
    for (const registryDir of dirs) {
      const entries = execSync(`ls "${registryDir}"`, { encoding: 'utf8' }).trim().split('\n');
      for (const entry of entries) {
        const abs = `${registryDir}${entry}/${relPath}`;
        if (existsSync(abs)) {
          const m = entry.match(/^(.+)-[\d.]+$/);
          const name = m ? m[1] : entry;
          return [abs, `crates/${name}/${relPath.slice(4)}`];
        }
      }
    }
  } catch {}
  return null;
}

function tryRead(...paths: string[]): string | null {
  for (const p of paths) {
    if (!p) continue;
    try { if (existsSync(p)) return readFileSync(p, 'utf8'); } catch {}
  }
  return null;
}

// Resolve a raw source path to [absolutePath, cleanDisplayPath]
function resolve(src: string): [string | null, string] {
  // 1. Absolute: /Users/.../.rustup/.../library/...
  const rustupStd = src.match(/\.rustup\/.*\/library\/(.+)$/);
  if (rustupStd) return [src, `std/${rustupStd[1]}`];

  // 2. Absolute: /rustc/<hash>/library/...
  const rustcStd = src.match(/\/rustc\/[^/]+\/library\/(.+)$/);
  if (rustcStd) return [`${sysrootLib}library/${rustcStd[1]}`, `std/${rustcStd[1]}`];

  // 3. Absolute: /.../.cargo/registry/.../crate-version/src/...
  const crate_ = src.match(/\/([^/]+)-([\d.]+)\/src\/(.+)$/);
  if (crate_ && src.includes('.cargo/registry'))
    return [src, `crates/${crate_[1]}/${crate_[3]}`];

  // 4. Absolute: wit-bindgen without registry pattern
  const witAbs = src.match(/\/wit-bindgen[^/]*\/src\/(.+)$/);
  if (witAbs) return [src, `crates/wit-bindgen/${witAbs[1]}`];

  // 5. Relative: target/debug/build/wit-bindgen-rust-macro-.../out/... — macro output
  const macroOut = src.match(/target\/debug\/build\/wit-bindgen-rust-macro[^/]*\/out\/(.+)$/);
  if (macroOut)
    return [`demo/guest/${src}`, `guest/${macroOut[1]} (generated)`];

  // 6. Relative: src/lib.rs — guest code
  if (src === 'src/lib.rs')
    return ['demo/guest/src/lib.rs', 'guest/lib.rs'];


  // 7. Relative: src/... — try known crate directories, then scan registry
  if (src.startsWith('src/')) {
    for (const [name, dir] of crateDirs) {
      const abs = `${dir}/${src}`;
      if (existsSync(abs)) return [abs, `crates/${name}/${src.slice(4)}`];
    }
    // Scan registry for any crate containing this relative path
    const found = findInRegistry(src);
    if (found) return found;
    // Fallback to wit-bindgen (for generated files that may not exist on disk)
    if (witBindgenDir)
      return [`${witBindgenDir}/${src}`, `crates/wit-bindgen/${src.slice(4)}`];
  }

  // 8. Relative: library/... — Rust std from different comp_dir
  if (src.startsWith('library/'))
    return [`${sysrootLib}${src}`, `std/${src.slice(8)}`];

  // 9. Relative: other (dlmalloc, libc-bottom-half, etc.)
  return [null, src];
}

// Two passes: first resolve absolute paths (authoritative), then relative paths.
// This ensures duplicates always get the content from the correct (absolute) source.
const resolved: [string | null, string][] = (map.sources as string[]).map(resolve);
const contentCache = new Map<string, string | null>();

// Pass 1: absolute paths populate the cache first
for (const [absPath, cleanPath] of resolved) {
  if (!absPath || !absPath.startsWith('/')) continue;
  const prefixed = `wasm/${cleanPath}`;
  if (!contentCache.has(prefixed)) {
    contentCache.set(prefixed, tryRead(absPath));
  }
}

// Pass 2: all paths — use cache if available, else try reading
const sourcesContent: (string | null)[] = [];
const cleanSources: string[] = [];

for (const [absPath, cleanPath] of resolved) {
  const prefixed = `wasm/${cleanPath}`;

  let content: string | null;
  if (contentCache.has(prefixed)) {
    content = contentCache.get(prefixed)!;
  } else {
    content = absPath ? tryRead(absPath) : null;
    contentCache.set(prefixed, content);
  }

  sourcesContent.push(content);
  cleanSources.push(prefixed);
}

map.sources = cleanSources;
map.sourcesContent = sourcesContent;
writeFileSync(mapPath!, JSON.stringify(map));

const total = cleanSources.length;
const embedded = sourcesContent.filter(c => c !== null).length;
const unique = new Set(cleanSources).size;
console.log(`  ${embedded}/${total} sources embedded (${unique} unique files)`);
