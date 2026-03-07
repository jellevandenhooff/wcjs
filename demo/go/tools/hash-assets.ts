// Content-hash assets, gzip them, and generate manifest.json.
//
// Usage: node --experimental-transform-types hash-assets.ts <outdir> <distdir>
//
// Reads .component.wasm and .tar files from outdir, gzips + content-hashes
// them into distdir, and writes manifest.json. All large files end up
// as .gz on disk so we don't rely on the CDN/server for compression.

import { readdirSync, readFileSync, writeFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const OUTDIR = process.argv[2]!;
const DISTDIR = process.argv[3]!;

const manifest: Record<string, string> = {};

for (const file of readdirSync(OUTDIR)) {
  if (file.endsWith('.component.wasm') || file.endsWith('.tar')) {
    const data = readFileSync(join(OUTDIR, file));
    const hash = createHash('sha256').update(data).digest('hex').slice(0, 12);

    const ext = file.endsWith('.component.wasm') ? '.component.wasm' : '.tar';
    const base = file.slice(0, file.length - ext.length);
    const hashedName = `${base}-${hash}${ext}.gz`;

    const compressed = gzipSync(data);
    writeFileSync(join(DISTDIR, hashedName), compressed);
    manifest[file] = hashedName;

    const rawMB = (data.length / 1024 / 1024).toFixed(1);
    const gzMB = (compressed.length / 1024 / 1024).toFixed(1);
    console.log(`  ${file} → ${hashedName} (${rawMB} MB → ${gzMB} MB gz)`);
  }
}

// Gzip gocache files individually
const gocacheDir = join(OUTDIR, 'gocache');
if (existsSync(gocacheDir)) {
  const cacheManifest: { path: string; size: number }[] = JSON.parse(readFileSync(join(OUTDIR, 'gocache-manifest.json'), 'utf8'));
  let totalRaw = 0, totalGz = 0;
  const gzManifest: { path: string; size: number }[] = [];
  for (const entry of cacheManifest) {
    const src = join(gocacheDir, entry.path);
    const destDir = join(DISTDIR, 'gocache', ...entry.path.split('/').slice(0, -1));
    mkdirSync(destDir, { recursive: true });
    const data = readFileSync(src);
    const compressed = gzipSync(data);
    writeFileSync(join(DISTDIR, 'gocache', entry.path + '.gz'), compressed);
    gzManifest.push({ path: entry.path + '.gz', size: entry.size });
    totalRaw += data.length;
    totalGz += compressed.length;
  }
  writeFileSync(join(DISTDIR, 'gocache-manifest.json'), JSON.stringify(gzManifest));
  console.log(`  gocache/ gzipped (${cacheManifest.length} files, ${(totalRaw / 1024 / 1024).toFixed(1)} MB → ${(totalGz / 1024 / 1024).toFixed(1)} MB gz)`);
}

writeFileSync(join(DISTDIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`  manifest.json written (${Object.keys(manifest).length} entries)`);
