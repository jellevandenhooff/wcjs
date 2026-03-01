/**
 * Canonical ABI type flattening.
 *
 * Converts ComponentValType → FlatValType[] for determining trampoline
 * signatures and stream/future element sizes.
 */

import type { ComponentValType, ComponentTypeEntry, DefinedType } from '../parser/types.ts';
import type { FlatValType } from './link-types.ts';

/**
 * Flatten a ComponentValType into its flat ABI representation.
 * Used to determine parameter counts for lowered import trampolines.
 */
export function flattenType(
  valType: ComponentValType,
  typeTable: ComponentTypeEntry[],
): FlatValType[] {
  if (valType.tag === 'primitive') {
    return flattenPrimitive(valType.type);
  }
  // typeIndex → look up in type table
  const entry = typeTable[valType.index];
  if (!entry) return ['i32'];
  if (entry.tag === 'func') return ['i32']; // func ref
  if (entry.tag === 'resource') return ['i32']; // resource handle
  if (entry.tag === 'defined') {
    return flattenDefined(entry.type, typeTable);
  }
  return ['i32'];
}

function flattenPrimitive(prim: string): FlatValType[] {
  switch (prim) {
    case 'bool':
    case 'u8': case 's8':
    case 'u16': case 's16':
    case 'u32': case 's32':
    case 'char':
      return ['i32'];
    case 'u64': case 's64':
      return ['i64'];
    case 'f32':
      return ['f32'];
    case 'f64':
      return ['f64'];
    case 'string':
      return ['i32', 'i32']; // ptr + len
    default:
      return ['i32'];
  }
}

/**
 * Per spec: join(a, b) widens two flat types into a common supertype.
 * Same type → same; i32/f32 mix → i32; anything else → i64.
 */
function join(a: FlatValType, b: FlatValType): FlatValType {
  if (a === b) return a;
  if ((a === 'i32' && b === 'f32') || (a === 'f32' && b === 'i32')) return 'i32';
  return 'i64';
}

/**
 * Per spec: flatten_variant(cases) = [discriminant, ...joined_payloads].
 * Each case's flattened payload is positionally joined with all others.
 */
function flattenVariantCases(
  caseTypes: (ComponentValType | null)[],
  typeTable: ComponentTypeEntry[],
): FlatValType[] {
  const numCases = caseTypes.length;
  // Per spec: discriminant_type based on number of cases
  // <=256 → U8 (i32), <=65536 → U16 (i32), else U32 (i32). All flatten to i32.
  const flat: FlatValType[] = ['i32'];
  for (const ct of caseTypes) {
    if (ct === null) continue;
    const caseFlat = flattenType(ct, typeTable);
    for (let i = 0; i < caseFlat.length; i++) {
      if (i < flat.length - 1) {
        // Join with existing payload slot (offset by 1 for discriminant)
        flat[i + 1] = join(flat[i + 1]!, caseFlat[i]!);
      } else {
        flat.push(caseFlat[i]!);
      }
    }
  }
  return flat;
}

function flattenDefined(
  def: DefinedType,
  typeTable: ComponentTypeEntry[],
): FlatValType[] {
  switch (def.tag) {
    case 'primitive':
      return flattenPrimitive(def.type);
    case 'record':
      return def.fields.flatMap(f => flattenType(f.type, typeTable));
    case 'tuple':
      return def.types.flatMap(t => flattenType(t, typeTable));
    case 'list':
      return ['i32', 'i32']; // ptr + len
    case 'flags': {
      const count = Math.ceil(def.names.length / 32);
      return Array(count || 1).fill('i32' as FlatValType);
    }
    case 'enum':
      return ['i32']; // discriminant
    case 'option':
      // Per spec: option<T> despecializes to variant { none, some(T) }
      return flattenVariantCases([null, def.type], typeTable);
    case 'result':
      // Per spec: result<ok, err> despecializes to variant { ok(ok), error(err) }
      return flattenVariantCases([def.ok, def.err], typeTable);
    case 'variant':
      return flattenVariantCases(def.cases.map(c => c.type), typeTable);
    case 'own':
    case 'borrow':
      return ['i32']; // handle
    case 'future':
    case 'stream':
      return ['i32']; // handle
    case 'errorContext':
      return ['i32'];
    default:
      return ['i32'];
  }
}

/**
 * Fallback for missing type indices in compTypes.
 * Returns size and alignment for types aliased from host imports
 * that aren't populated in the type table.
 */
export type TypeFallback = (index: number) => { size: number; align: number } | null;

/**
 * Compute the element byte size for a stream/future element type.
 * Returns 0 if the type is null (untyped stream/future).
 */
export function elemByteSize(
  valType: ComponentValType | null,
  typeTable: ComponentTypeEntry[],
  fallback?: TypeFallback,
): number {
  if (valType === null) return 0;
  if (valType.tag === 'primitive') {
    return primByteSize(valType.type);
  }
  const entry = typeTable[valType.index];
  if (!entry || entry.tag !== 'defined') {
    const fb = fallback?.(valType.index);
    return fb ? fb.size : 4;
  }
  return definedByteSize(entry.type, typeTable, fallback);
}

function primByteSize(prim: string): number {
  switch (prim) {
    case 'bool': case 'u8': case 's8': return 1;
    case 'u16': case 's16': return 2;
    case 'u32': case 's32': case 'char': case 'f32': return 4;
    case 'u64': case 's64': case 'f64': return 8;
    case 'string': return 8; // ptr + len
    default: return 4;
  }
}

function alignTo(offset: number, align: number): number {
  return (offset + align - 1) & ~(align - 1);
}

function primAlignment(prim: string): number {
  switch (prim) {
    case 'bool': case 'u8': case 's8': return 1;
    case 'u16': case 's16': return 2;
    case 'u32': case 's32': case 'char': case 'f32': return 4;
    case 'u64': case 's64': case 'f64': return 8;
    case 'string': return 4; // ptr(i32) + len(i32)
    default: return 4;
  }
}

function elemAlignment(valType: ComponentValType, typeTable: ComponentTypeEntry[], fallback?: TypeFallback): number {
  if (valType.tag === 'primitive') return primAlignment(valType.type);
  const entry = typeTable[valType.index];
  if (!entry || entry.tag !== 'defined') {
    const fb = fallback?.(valType.index);
    return fb ? fb.align : 4;
  }
  return definedAlignment(entry.type, typeTable, fallback);
}

function definedAlignment(def: DefinedType, typeTable: ComponentTypeEntry[], fallback?: TypeFallback): number {
  switch (def.tag) {
    case 'primitive': return primAlignment(def.type);
    case 'record':
      return def.fields.reduce((max, f) => Math.max(max, elemAlignment(f.type, typeTable, fallback)), 1);
    case 'tuple':
      return def.types.reduce((max, t) => Math.max(max, elemAlignment(t, typeTable, fallback)), 1);
    case 'list': return 4;
    case 'enum': return def.names.length <= 256 ? 1 : def.names.length <= 65536 ? 2 : 4;
    case 'flags': return def.names.length <= 8 ? 1 : def.names.length <= 16 ? 2 : 4;
    case 'option': return Math.max(1, elemAlignment(def.type, typeTable, fallback));
    case 'result': {
      const okAlign = def.ok ? elemAlignment(def.ok, typeTable, fallback) : 1;
      const errAlign = def.err ? elemAlignment(def.err, typeTable, fallback) : 1;
      return Math.max(1, okAlign, errAlign);
    }
    case 'variant': {
      const discAlign = def.cases.length <= 256 ? 1 : def.cases.length <= 65536 ? 2 : 4;
      let maxPayloadAlign = 1;
      for (const c of def.cases) {
        if (c.type) maxPayloadAlign = Math.max(maxPayloadAlign, elemAlignment(c.type, typeTable, fallback));
      }
      return Math.max(discAlign, maxPayloadAlign);
    }
    case 'own': case 'borrow': return 4;
    case 'future': case 'stream': return 4;
    case 'errorContext': return 4;
    default: return 4;
  }
}

function definedByteSize(def: DefinedType, typeTable: ComponentTypeEntry[], fallback?: TypeFallback): number {
  switch (def.tag) {
    case 'primitive': return primByteSize(def.type);
    case 'record': {
      let offset = 0;
      for (const field of def.fields) {
        const fieldAlign = elemAlignment(field.type, typeTable, fallback);
        offset = alignTo(offset, fieldAlign);
        offset += elemByteSize(field.type, typeTable, fallback);
      }
      const recordAlign = def.fields.reduce((max, f) => Math.max(max, elemAlignment(f.type, typeTable, fallback)), 1);
      return alignTo(offset, recordAlign);
    }
    case 'tuple': {
      let offset = 0;
      for (const t of def.types) {
        const a = elemAlignment(t, typeTable, fallback);
        offset = alignTo(offset, a);
        offset += elemByteSize(t, typeTable, fallback);
      }
      const tupleAlign = def.types.reduce((max, t) => Math.max(max, elemAlignment(t, typeTable, fallback)), 1);
      return alignTo(offset, tupleAlign);
    }
    case 'list': return 8; // ptr + len
    case 'enum': return def.names.length <= 256 ? 1 : def.names.length <= 65536 ? 2 : 4;
    case 'flags': {
      if (def.names.length <= 8) return 1;
      if (def.names.length <= 16) return 2;
      return Math.ceil(def.names.length / 32) * 4;
    }
    case 'option': {
      const innerSize = elemByteSize(def.type, typeTable, fallback);
      const innerAlign = elemAlignment(def.type, typeTable, fallback);
      const payloadOffset = Math.max(1, innerAlign);
      const total = payloadOffset + innerSize;
      return alignTo(total, Math.max(1, innerAlign));
    }
    case 'result': {
      const okSize = def.ok ? elemByteSize(def.ok, typeTable, fallback) : 0;
      const errSize = def.err ? elemByteSize(def.err, typeTable, fallback) : 0;
      const okAlign = def.ok ? elemAlignment(def.ok, typeTable, fallback) : 1;
      const errAlign = def.err ? elemAlignment(def.err, typeTable, fallback) : 1;
      const payloadAlign = Math.max(okAlign, errAlign);
      const payloadOffset = Math.max(1, payloadAlign);
      const total = payloadOffset + Math.max(okSize, errSize);
      return alignTo(total, Math.max(1, payloadAlign));
    }
    case 'variant': {
      const numCases = def.cases.length;
      const discSize = numCases <= 256 ? 1 : numCases <= 65536 ? 2 : 4;
      let maxPayloadSize = 0;
      let maxPayloadAlign = 1;
      for (const c of def.cases) {
        if (c.type) {
          maxPayloadSize = Math.max(maxPayloadSize, elemByteSize(c.type, typeTable, fallback));
          maxPayloadAlign = Math.max(maxPayloadAlign, elemAlignment(c.type, typeTable, fallback));
        }
      }
      const discAlign = discSize <= 1 ? 1 : discSize <= 2 ? 2 : 4;
      const align = Math.max(discAlign, maxPayloadAlign);
      const payloadOffset = alignTo(discSize, maxPayloadAlign);
      const total = payloadOffset + maxPayloadSize;
      return alignTo(total, align);
    }
    case 'own': case 'borrow': return 4;
    case 'future': case 'stream': return 4;
    case 'errorContext': return 4;
    default: return 4;
  }
}
