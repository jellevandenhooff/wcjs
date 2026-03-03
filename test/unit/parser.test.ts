// Parser round-trip tests: compile WAT/WAST → parseComponent → printComponent → compare with wasm-tools print.

import { describe, it, assert } from '../runner.ts';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseComponent } from '../../src/parser/parse.ts';
import { printComponent } from '../../src/parser/print.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = resolve(__dirname, '..');
const watDir = resolve(testDir, 'wat');
const specDir = resolve(testDir, 'spec');

function compileWat(watPath: string): Uint8Array {
  const result = execSync(`wasm-tools parse "${watPath}"`, { maxBuffer: 10 * 1024 * 1024 });
  return new Uint8Array(result);
}

// TODO: Remove once wasm-tools supports the new threading builtin names.
const WASM_TOOLS_COMPAT: [string, string][] = [
  ['thread.yield-to', 'thread.yield-to-suspended'],
  ['thread.switch-to', 'thread.suspend-to'],
  ['thread.resume-later', 'thread.unsuspend'],
];

function compileWatText(watText: string): Uint8Array {
  for (const [newName, oldName] of WASM_TOOLS_COMPAT) {
    watText = watText.replaceAll(newName, oldName);
  }
  const result = execSync('wasm-tools parse -', {
    input: Buffer.from(watText),
    maxBuffer: 10 * 1024 * 1024,
  });
  return new Uint8Array(result);
}

function wasmToolsPrint(wasm: Uint8Array): string {
  const result = execSync('wasm-tools print -', {
    input: Buffer.from(wasm),
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.toString('utf-8');
}

/**
 * Normalize `wasm-tools print` output for comparison with our printer.
 *
 * Our printer omits core module and nested component bodies, so we strip those
 * from the wasm-tools output to allow comparison.
 */
function normalizeWasmToolsOutput(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    const indentStr = ' '.repeat(indent);

    // Strip core module bodies — preserve $name and annotation
    if (trimmed.startsWith('(core module ')) {
      const nameAndIdx = extractNameAndAnnotation(trimmed);
      result.push(`${indentStr}(core module ${nameAndIdx}...)`);
      i = skipBlock(lines, i) + 1;
      continue;
    }

    // Strip nested component bodies (not outermost) — preserve $name and annotation
    if (trimmed.startsWith('(component ') && i > 0 && indent > 0) {
      const nameAndIdx = extractNameAndAnnotation(trimmed);
      result.push(`${indentStr}(component ${nameAndIdx}...)`);
      i = skipBlock(lines, i) + 1;
      continue;
    }

    result.push(line);
    i++;
  }

  return result
    .filter(l => l.trim() !== '')
    .map(l => l.trimEnd())
    .join('\n');
}

/** Extract `$name (;N;) ` or `(;N;) ` from a definition line. */
function extractNameAndAnnotation(line: string): string {
  const match = line.match(/(\$[\w.\-]+ )?\(;(\d+);\)/);
  if (match) {
    return `${match[1] ?? ''}(;${match[2]};) `;
  }
  return '';
}

function skipBlock(lines: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    let inString = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      if (ch === '"' && (j === 0 || line[j - 1] !== '\\')) {
        inString = !inString;
      }
      if (!inString) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
      }
    }
    if (depth <= 0) return i;
  }
  return lines.length - 1;
}

/** Normalize whitespace for comparison. */
function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
    .join('\n');
}

/** Compare our parse+print output against wasm-tools print. */
function assertMatchesReference(wasm: Uint8Array, label: string) {
  const reference = wasmToolsPrint(wasm);
  const parsed = parseComponent(wasm);
  const ourOutput = printComponent(parsed);

  const normalizedRef = normalizeWhitespace(normalizeWasmToolsOutput(reference));
  const normalizedOurs = normalizeWhitespace(ourOutput);

  if (normalizedOurs !== normalizedRef) {
    const ourLines = normalizedOurs.split('\n');
    const refLines = normalizedRef.split('\n');
    const maxLen = Math.max(ourLines.length, refLines.length);
    const diffs: string[] = [];
    for (let i = 0; i < maxLen; i++) {
      const ours = ourLines[i] ?? '<missing>';
      const ref = refLines[i] ?? '<missing>';
      if (ours !== ref) {
        diffs.push(`line ${i + 1}:\n  ours: ${ours}\n  ref:  ${ref}`);
      }
    }
    assert.fail(`${label}: Output mismatch (${diffs.length} lines differ):\n${diffs.slice(0, 10).join('\n')}`);
  }
}

/**
 * Extract the top-level (component ...) from a WAST file.
 * Handles `(component definition $Name ...)` by stripping the `definition $Name` keyword.
 */
function extractComponentFromWast(wastPath: string): string | null {
  const source = readFileSync(wastPath, 'utf-8');

  const start = source.indexOf('(component');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let inBlockComment = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (!inString && ch === '(' && next === ';') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (inBlockComment && ch === ';' && next === ')') {
      inBlockComment = false;
      i++;
      continue;
    }
    if (inBlockComment) continue;

    if (!inString && ch === ';' && next === ';') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    if (ch === '"' && (i === start || source[i - 1] !== '\\')) {
      inString = !inString;
    }
    if (!inString) {
      if (ch === '(') depth++;
      if (ch === ')') {
        depth--;
        if (depth === 0) {
          let text = source.substring(start, i + 1);
          // Strip WAST-only `definition $Name` keyword
          text = text.replace(/^\(component\s+definition\s+\$\S+/, '(component');
          return text;
        }
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------
// WAT tests — all .wat files in test/wat/
// -----------------------------------------------------------------------

const watFiles = readdirSync(watDir)
  .filter(f => f.endsWith('.wat'))
  .sort();

describe('Parser: WAT round-trip', () => {
  for (const watFile of watFiles) {
    const watPath = resolve(watDir, watFile);

    it(`parses ${watFile}`, () => {
      const wasm = compileWat(watPath);
      assertMatchesReference(wasm, watFile);
    });
  }
});

// -----------------------------------------------------------------------
// Spec WAST tests — all .wast files in test/spec/
// -----------------------------------------------------------------------

const wastFiles = existsSync(specDir)
  ? readdirSync(specDir).filter(f => f.endsWith('.wast')).sort()
  : [];

describe('Parser: Spec WAST round-trip', () => {
  for (const wastFile of wastFiles) {
    const wastPath = resolve(specDir, wastFile);
    const name = basename(wastFile, '.wast');

    const componentText = extractComponentFromWast(wastPath);
    if (!componentText) {
      it.skip(`${name} (uses WAST-only syntax)`, () => {});
      continue;
    }

    let wasm: Uint8Array;
    try {
      wasm = compileWatText(componentText);
    } catch {
      it.skip(`${name} (wasm-tools parse failed)`, () => {});
      continue;
    }

    it(`parses ${name}`, () => {
      assertMatchesReference(wasm, name);
    });
  }
});

// -----------------------------------------------------------------------
// Error cases
// -----------------------------------------------------------------------

describe('Parser: Error handling', () => {
  it('rejects non-component wasm', () => {
    const coreModule = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    assert.throws(() => parseComponent(coreModule));
  });

  it('rejects invalid magic', () => {
    const bad = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x01, 0x00]);
    assert.throws(() => parseComponent(bad), /invalid wasm magic/);
  });
});
