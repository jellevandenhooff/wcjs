/**
 * Entry point: ParsedComponent → generated TypeScript + core module bytes.
 */

import type { ParsedComponent } from '../parser/types.ts';
import { link } from './link.ts';
import { emit, type EmitResult, type EmitMode } from './emit.ts';

export interface GenerateResult {
  /** Generated source code (TypeScript or JavaScript depending on mode). */
  source: string;
  /** TypeScript declarations (.d.ts content, standalone mode only). */
  declarations?: string;
  /** Core wasm module files to write alongside the source. */
  coreModules: Array<{ fileName: string; bytes: Uint8Array }>;
}

/**
 * Generate TypeScript source from a parsed component.
 *
 * @param parsed - The parsed component IR (from parseComponent)
 * @param name - Base name for the output (e.g., 'test1-callback')
 * @returns Generated source and core module bytes
 */
export interface GenerateOptions {
  /** Enable JSPI mode (suspending/promising wrappers, setJspiMode call). */
  jspiMode?: boolean;
  /** Emit mode: 'ts' for TypeScript (default), 'js' for plain JS (no type annotations). */
  mode?: EmitMode;
}

export function generateCode(parsed: ParsedComponent, name: string, opts?: GenerateOptions): GenerateResult {
  const linked = link(parsed);
  return emit(linked, name, opts?.jspiMode ?? false, opts?.mode ?? 'ts');
}
