/**
 * Host import type system for generating typed ABI lowering trampolines.
 *
 * HostValType is a self-contained component-level type descriptor used when
 * lowering functions aliased from host-imported instances. Unlike ComponentValType
 * which references type indices, HostValType is fully resolved and portable.
 */

import type { FlatValType } from './link-types.ts';

// -----------------------------------------------------------------------
// Host value types (self-contained, no type index references)
// -----------------------------------------------------------------------

export type HostValType =
  | 'bool' | 'u8' | 's8' | 'u16' | 's16' | 'u32' | 's32' | 'u64' | 's64'
  | 'f32' | 'f64' | 'char'
  | 'string'
  | { tag: 'list'; elem: HostValType }
  | { tag: 'record'; fields: { name: string; type: HostValType }[] }
  | { tag: 'tuple'; elems: HostValType[] }
  | { tag: 'option'; inner: HostValType }
  | { tag: 'result'; ok: HostValType | null; err: HostValType | null }
  | { tag: 'enum'; names: string[] }
  | { tag: 'flags'; count: number }
  | { tag: 'variant'; cases: { name: string; type: HostValType | null }[] }
  | 'own' | 'borrow' | 'stream' | 'future'
  | { tag: 'own'; tableIdx: number }
  | { tag: 'own'; name: string }
  | { tag: 'borrow'; tableIdx: number }
  | { tag: 'borrow'; name: string }
  | { tag: 'stream'; elem: HostValType | null }
  | { tag: 'future'; elem: HostValType | null };

/** Type info for a host-imported function. */
export interface HostFuncTypeInfo {
  paramTypes: HostValType[];
  resultType: HostValType | null;
}

/** Lowering info for a host import trampoline that needs memory/realloc. */
export interface HostImportLowerInfo {
  paramTypes: HostValType[];
  resultType: HostValType | null;
  paramFlatTypes: FlatValType[];
  resultFlatTypes: FlatValType[];
  memoryIdx: number | null;
  realloc: { runtimeInstanceIdx: number; exportName: string } | null;
}

// -----------------------------------------------------------------------
// Flatten HostValType to flat core ABI types
// -----------------------------------------------------------------------

export function flattenHostValType(ty: HostValType): FlatValType[] {
  if (typeof ty === 'string') {
    switch (ty) {
      case 'bool': case 'u8': case 's8':
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
      case 'own': case 'borrow':
      case 'stream': case 'future':
        return ['i32'];
    }
  }

  switch (ty.tag) {
    case 'list':
      return ['i32', 'i32']; // ptr + len
    case 'record':
      return ty.fields.flatMap(f => flattenHostValType(f.type));
    case 'tuple':
      return ty.elems.flatMap(flattenHostValType);
    case 'option': {
      const flat: FlatValType[] = ['i32']; // discriminant
      flat.push(...flattenHostValType(ty.inner));
      return flat;
    }
    case 'result': {
      const flat: FlatValType[] = ['i32']; // discriminant
      const okFlat = ty.ok ? flattenHostValType(ty.ok) : [];
      const errFlat = ty.err ? flattenHostValType(ty.err) : [];
      const maxLen = Math.max(okFlat.length, errFlat.length);
      for (let i = 0; i < maxLen; i++) {
        const okTy = okFlat[i];
        const errTy = errFlat[i];
        if (okTy !== undefined && errTy !== undefined) {
          flat.push(okTy === errTy ? okTy : 'i32'); // simplified join
        } else {
          flat.push(okTy ?? errTy ?? 'i32');
        }
      }
      return flat;
    }
    case 'variant': {
      const flat: FlatValType[] = ['i32']; // discriminant
      const caseFlats = ty.cases.map(c => c.type ? flattenHostValType(c.type) : []);
      const maxLen = Math.max(0, ...caseFlats.map(f => f.length));
      for (let i = 0; i < maxLen; i++) {
        const types = caseFlats.map(f => f[i]).filter((t): t is FlatValType => t !== undefined);
        if (types.length === 0) {
          flat.push('i32');
        } else if (types.every(t => t === types[0])) {
          flat.push(types[0]!);
        } else {
          flat.push('i32'); // simplified join
        }
      }
      return flat;
    }
    case 'own': case 'borrow':
    case 'stream': case 'future':
      return ['i32'];
    case 'enum':
      return ['i32'];
    case 'flags': {
      const numI32s = Math.max(1, Math.ceil(ty.count / 32));
      return Array(numI32s).fill('i32' as FlatValType);
    }
  }
}

// -----------------------------------------------------------------------
// Alignment and byte size helpers (canonical ABI)
// -----------------------------------------------------------------------

export function hostValTypeAlignment(ty: HostValType): number {
  if (typeof ty === 'string') {
    switch (ty) {
      case 'bool': case 'u8': case 's8': return 1;
      case 'u16': case 's16': return 2;
      case 'u32': case 's32': case 'f32': case 'char': return 4;
      case 'u64': case 's64': case 'f64': return 8;
      case 'string': return 4; // ptr(i32) + len(i32)
      case 'own': case 'borrow':
      case 'stream': case 'future': return 4;
    }
  }

  switch (ty.tag) {
    case 'list': return 4;
    case 'record':
      return ty.fields.reduce((max, f) => Math.max(max, hostValTypeAlignment(f.type)), 1);
    case 'tuple':
      return ty.elems.reduce((max, e) => Math.max(max, hostValTypeAlignment(e)), 1);
    case 'option':
      return Math.max(1, hostValTypeAlignment(ty.inner)); // discriminant is 1 byte (2 cases)
    case 'result': {
      const okA = ty.ok ? hostValTypeAlignment(ty.ok) : 1;
      const errA = ty.err ? hostValTypeAlignment(ty.err) : 1;
      return Math.max(1, okA, errA); // discriminant is 1 byte (2 cases)
    }
    case 'variant': {
      const n = ty.cases.length;
      const discAlign = n <= 256 ? 1 : n <= 65536 ? 2 : 4;
      const caseAlign = ty.cases.reduce((max, c) => c.type ? Math.max(max, hostValTypeAlignment(c.type)) : max, 1);
      return Math.max(discAlign, caseAlign);
    }
    case 'own': case 'borrow':
    case 'stream': case 'future':
      return 4;
    case 'enum':
      return ty.names.length <= 256 ? 1 : ty.names.length <= 65536 ? 2 : 4;
    case 'flags':
      return ty.count <= 8 ? 1 : ty.count <= 16 ? 2 : 4;
  }
}

// -----------------------------------------------------------------------
// HostValType → TypeScript type string
// -----------------------------------------------------------------------

/** Convert a HostValType to its TypeScript type representation. */
export function hostValTypeToTS(ty: HostValType, namedTypes?: Map<string, string>): string {
  // Check if this type has a named alias
  if (namedTypes) {
    const key = canonicalKey(ty);
    const name = namedTypes.get(key);
    if (name) return name;
  }

  if (typeof ty === 'string') {
    switch (ty) {
      case 'bool': return 'boolean';
      case 'u8': case 's8': case 'u16': case 's16':
      case 'u32': case 's32': case 'f32': case 'f64':
      case 'char':
        return 'number';
      case 'u64': case 's64':
        return 'bigint';
      case 'string': return 'string';
      // Resource handles and stream/future handles are numbers at the ABI level
      case 'own': case 'borrow':
      case 'stream': case 'future':
        return 'number';
    }
  }

  if (typeof ty === 'object') {
    switch (ty.tag) {
      case 'list': {
        if (ty.elem === 'u8') return 'Uint8Array';
        const elemTS = hostValTypeToTS(ty.elem, namedTypes);
        // Wrap union types in parens so [] applies to the whole union
        return `${_wrapComplex(elemTS)}[]`;
      }
      case 'record': {
        const fields = ty.fields.map(f => {
          const key = _isValidIdent(f.name) ? f.name : `'${f.name}'`;
          return `${key}: ${hostValTypeToTS(f.type, namedTypes)}`;
        });
        return `{ ${fields.join('; ')} }`;
      }
      case 'tuple': {
        const elems = ty.elems.map(e => hostValTypeToTS(e, namedTypes));
        return `[${elems.join(', ')}]`;
      }
      case 'option':
        return `${_wrapComplex(hostValTypeToTS(ty.inner, namedTypes))} | null`;
      case 'result': {
        const parts: string[] = [];
        if (ty.ok !== null) {
          parts.push(`{ tag: 'ok'; val: ${hostValTypeToTS(ty.ok, namedTypes)} }`);
        } else {
          parts.push(`{ tag: 'ok' }`);
        }
        if (ty.err !== null) {
          parts.push(`{ tag: 'err'; val: ${hostValTypeToTS(ty.err, namedTypes)} }`);
        } else {
          parts.push(`{ tag: 'err' }`);
        }
        return parts.join(' | ');
      }
      case 'enum':
        return ty.names.map(n => `'${n}'`).join(' | ');
      case 'flags':
        return 'number';
      case 'variant': {
        const parts = ty.cases.map(c => {
          if (c.type === null) {
            return `{ tag: '${c.name}' }`;
          }
          return `{ tag: '${c.name}'; val: ${hostValTypeToTS(c.type, namedTypes)} }`;
        });
        return parts.join('\n  | ');
      }
      case 'own': case 'borrow':
        return 'number';
      case 'stream':
        return ty.elem !== null
          ? `Stream<${hostValTypeToTS(ty.elem, namedTypes)}>`
          : 'Stream<void>';
      case 'future':
        return ty.elem !== null
          ? `Future<${hostValTypeToTS(ty.elem, namedTypes)}>`
          : 'Future<void>';
    }
  }

  // Should never reach here with well-formed HostValType
  return `never /* unhandled: ${JSON.stringify(ty)} */`;
}

/** Compute a canonical key for deduplication of HostValTypes. */
export function canonicalKey(ty: HostValType): string {
  return JSON.stringify(ty);
}

function _wrapComplex(ts: string): string {
  return ts.includes('|') ? `(${ts})` : ts;
}

function _isValidIdent(s: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s);
}

// -----------------------------------------------------------------------
// Byte size helpers (canonical ABI)
// -----------------------------------------------------------------------

export function hostValTypeByteSize(ty: HostValType): number {
  if (typeof ty === 'string') {
    switch (ty) {
      case 'bool': case 'u8': case 's8': return 1;
      case 'u16': case 's16': return 2;
      case 'u32': case 's32': case 'f32': case 'char': return 4;
      case 'u64': case 's64': case 'f64': return 8;
      case 'string': return 8; // ptr(i32=4) + len(i32=4)
      case 'own': case 'borrow':
      case 'stream': case 'future': return 4;
    }
  }

  switch (ty.tag) {
    case 'list': return 8; // ptr + len
    case 'record': {
      let offset = 0;
      for (const field of ty.fields) {
        const align = hostValTypeAlignment(field.type);
        offset = (offset + align - 1) & ~(align - 1);
        offset += hostValTypeByteSize(field.type);
      }
      const align = hostValTypeAlignment(ty);
      return (offset + align - 1) & ~(align - 1);
    }
    case 'tuple': {
      let offset = 0;
      for (const elem of ty.elems) {
        const align = hostValTypeAlignment(elem);
        offset = (offset + align - 1) & ~(align - 1);
        offset += hostValTypeByteSize(elem);
      }
      const align = hostValTypeAlignment(ty);
      return (offset + align - 1) & ~(align - 1);
    }
    case 'option': {
      const align = hostValTypeAlignment(ty);
      const discSize = 1; // 2 cases → 1 byte discriminant
      const payloadOffset = Math.max(discSize, hostValTypeAlignment(ty.inner));
      const total = payloadOffset + hostValTypeByteSize(ty.inner);
      return (total + align - 1) & ~(align - 1);
    }
    case 'result': {
      const align = hostValTypeAlignment(ty);
      const okSize = ty.ok ? hostValTypeByteSize(ty.ok) : 0;
      const errSize = ty.err ? hostValTypeByteSize(ty.err) : 0;
      const okAlign = ty.ok ? hostValTypeAlignment(ty.ok) : 1;
      const errAlign = ty.err ? hostValTypeAlignment(ty.err) : 1;
      const discSize = 1; // 2 cases → 1 byte discriminant
      const payloadAlign = Math.max(okAlign, errAlign);
      const payloadOffset = Math.max(discSize, payloadAlign);
      const total = payloadOffset + Math.max(okSize, errSize);
      return (total + align - 1) & ~(align - 1);
    }
    case 'variant': {
      const align = hostValTypeAlignment(ty);
      const n = ty.cases.length;
      const discSize = n <= 256 ? 1 : n <= 65536 ? 2 : 4;
      const caseAligns = ty.cases.map(c => c.type ? hostValTypeAlignment(c.type) : 1);
      const payloadAlign = Math.max(1, ...caseAligns);
      const payloadOffset = Math.max(discSize, payloadAlign);
      const caseSizes = ty.cases.map(c => c.type ? hostValTypeByteSize(c.type) : 0);
      const total = payloadOffset + Math.max(0, ...caseSizes);
      return (total + align - 1) & ~(align - 1);
    }
    case 'own': case 'borrow':
    case 'stream': case 'future':
      return 4;
    case 'enum':
      return ty.names.length <= 256 ? 1 : ty.names.length <= 65536 ? 2 : 4;
    case 'flags': {
      if (ty.count <= 8) return 1;
      if (ty.count <= 16) return 2;
      return Math.ceil(ty.count / 32) * 4;
    }
  }
}
