// Bundle GOROOT/src into a tar file for the browser demo.
// Uses the system `tar` command.
//
// Usage: node --experimental-transform-types bundle-goroot.ts <goroot> <output.tar>

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';

const GOROOT = resolve(process.argv[2] || '.');
const OUTPUT = resolve(process.argv[3] || 'goroot.tar');

console.log(`Bundling GOROOT: ${GOROOT}`);

// Create tar of src/ (excluding testdata, test files, and cmd/)
// plus VERSION.cache, go.env, pkg/include
const tarArgs = ['cf', OUTPUT];
if (platform() === 'darwin') tarArgs.push('--no-mac-metadata');
tarArgs.push(
  '--exclude=testdata',
  '--exclude=*_test.go',
  '--exclude=src/cmd',
  '-C', GOROOT,
  'src',
  'VERSION.cache',
  'go.env',
  'pkg/include',
);
execFileSync('tar', tarArgs, { stdio: 'inherit' });

const size = statSync(OUTPUT).size;
console.log(`  Written: ${OUTPUT} (${(size / 1024 / 1024).toFixed(1)} MB)`);
