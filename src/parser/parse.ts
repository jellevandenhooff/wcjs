/**
 * Entry point: Uint8Array → ParsedComponent
 */
import type { ParsedComponent } from './types.ts';
import { parseComponentBinary } from './component-parser.ts';

/**
 * Parse a component binary into a ParsedComponent IR.
 *
 * @param bytes - The raw component binary (Uint8Array)
 * @returns Parsed component with ordered list of sections
 * @throws Error if the binary is malformed or contains unsupported sections
 */
export function parseComponent(bytes: Uint8Array): ParsedComponent {
  return parseComponentBinary(bytes);
}
