/**
 * Parser for component type section (section ID 0x07).
 * Handles function types, defined types, resource types, instance types, component types.
 */
import { BinaryReader } from './binary-reader.ts';
import type {
  ComponentValType, PrimValType, DefinedType,
  ComponentTypeEntry, ComponentFuncType, ResourceType,
  InstanceTypeDecl, ExternType, TypeBounds,
  CoreType, Alias, ExternalSort,
} from './types.ts';

// -----------------------------------------------------------------------
// Value type readers
// -----------------------------------------------------------------------

/** Read a primitive value type from its byte encoding. */
export function readPrimValType(byte: number): PrimValType {
  switch (byte) {
    case 0x7f: return 'bool';
    case 0x7e: return 's8';
    case 0x7d: return 'u8';
    case 0x7c: return 's16';
    case 0x7b: return 'u16';
    case 0x7a: return 's32';
    case 0x79: return 'u32';
    case 0x78: return 's64';
    case 0x77: return 'u64';
    case 0x76: return 'f32';
    case 0x75: return 'f64';
    case 0x74: return 'char';
    case 0x73: return 'string';
    default: throw new Error(`unknown primitive type 0x${byte.toString(16)}`);
  }
}

/** Read a component value type (either primitive or type index). */
export function readComponentValType(r: BinaryReader): ComponentValType {
  const byte = r.peekU8();
  if (byte >= 0x73 && byte <= 0x7f) {
    r.readU8();
    return { tag: 'primitive', type: readPrimValType(byte) };
  }
  // Type index (signed LEB128, but always non-negative for type refs)
  const index = r.readS33LEB();
  return { tag: 'typeIndex', index };
}

/** Read a component value type or null (for optional fields like result ok/err). */
function readOptionalComponentValType(r: BinaryReader): ComponentValType | null {
  const marker = r.readU8();
  if (marker === 0x00) return null;
  if (marker !== 0x01) throw new Error(`expected 0x00 or 0x01, got 0x${marker.toString(16)}`);
  return readComponentValType(r);
}

// -----------------------------------------------------------------------
// Defined type readers
// -----------------------------------------------------------------------

/** Read a defined (compound) type. If tag is provided, uses it; otherwise reads it from the reader. */
function readDefinedType(r: BinaryReader, tag?: number): DefinedType {
  if (tag === undefined) tag = r.readU8();
  switch (tag) {
    case 0x72: { // record
      const count = r.readU32LEB();
      const fields: Array<{ name: string; type: ComponentValType }> = [];
      for (let i = 0; i < count; i++) {
        const name = r.readString();
        const type = readComponentValType(r);
        fields.push({ name, type });
      }
      return { tag: 'record', fields };
    }
    case 0x71: { // variant
      const count = r.readU32LEB();
      const cases: Array<{ name: string; type: ComponentValType | null; refines: number | null }> = [];
      for (let i = 0; i < count; i++) {
        const name = r.readString();
        const type = readOptionalComponentValType(r);
        const hasRefines = r.readU8();
        const refines = hasRefines ? r.readU32LEB() : null;
        cases.push({ name, type, refines });
      }
      return { tag: 'variant', cases };
    }
    case 0x70: { // list
      const elementType = readComponentValType(r);
      return { tag: 'list', elementType };
    }
    case 0x6f: { // tuple
      const count = r.readU32LEB();
      const types: ComponentValType[] = [];
      for (let i = 0; i < count; i++) {
        types.push(readComponentValType(r));
      }
      return { tag: 'tuple', types };
    }
    case 0x6e: { // flags
      const count = r.readU32LEB();
      const names: string[] = [];
      for (let i = 0; i < count; i++) {
        names.push(r.readString());
      }
      return { tag: 'flags', names };
    }
    case 0x6d: { // enum
      const count = r.readU32LEB();
      const names: string[] = [];
      for (let i = 0; i < count; i++) {
        names.push(r.readString());
      }
      return { tag: 'enum', names };
    }
    case 0x6b: { // option
      const type = readComponentValType(r);
      return { tag: 'option', type };
    }
    case 0x6a: { // result
      const ok = readOptionalComponentValType(r);
      const err = readOptionalComponentValType(r);
      return { tag: 'result', ok, err };
    }
    case 0x69: { // own
      const typeIndex = r.readU32LEB();
      return { tag: 'own', typeIndex };
    }
    case 0x68: { // borrow
      const typeIndex = r.readU32LEB();
      return { tag: 'borrow', typeIndex };
    }
    case 0x66: { // stream
      const type = readOptionalComponentValType(r);
      return { tag: 'stream', type };
    }
    case 0x65: { // future
      const type = readOptionalComponentValType(r);
      return { tag: 'future', type };
    }
    case 0x64: { // error-context
      return { tag: 'errorContext' };
    }
    default:
      // Could be a primitive value type used as a defined type
      if (tag >= 0x73 && tag <= 0x7f) {
        return { tag: 'primitive', type: readPrimValType(tag) };
      }
      throw new Error(`unknown defined type tag 0x${tag.toString(16)}`);
  }
}

// -----------------------------------------------------------------------
// Function type
// -----------------------------------------------------------------------

/** Read a component function type. isAsync indicates if this was 0x43 vs 0x40. */
function readFuncType(r: BinaryReader, isAsync: boolean): ComponentFuncType {
  const paramCount = r.readU32LEB();
  const params: Array<{ name: string; type: ComponentValType }> = [];
  for (let i = 0; i < paramCount; i++) {
    const name = r.readString();
    const type = readComponentValType(r);
    params.push({ name, type });
  }
  // Result list: 0x00 type = has single result, 0x01 0x00 = no result
  const resultTag = r.readU8();
  let result: ComponentValType | null = null;
  if (resultTag === 0x00) {
    result = readComponentValType(r);
  } else if (resultTag === 0x01) {
    const zero = r.readU8();
    if (zero !== 0x00) throw new Error(`expected 0x00 after result tag 0x01, got 0x${zero.toString(16)}`);
  } else {
    throw new Error(`unexpected func result tag 0x${resultTag.toString(16)}`);
  }
  return { params, result, isAsync };
}

// -----------------------------------------------------------------------
// Core type
// -----------------------------------------------------------------------

function readCoreType(r: BinaryReader): CoreType {
  const byte = r.readU8();
  switch (byte) {
    case 0x7f: return 'i32';
    case 0x7e: return 'i64';
    case 0x7d: return 'f32';
    case 0x7c: return 'f64';
    default: throw new Error(`unknown core type 0x${byte.toString(16)}`);
  }
}

// -----------------------------------------------------------------------
// Extern type (used in imports/exports and instance type declarations)
// -----------------------------------------------------------------------

export function readExternType(r: BinaryReader): ExternType {
  const sort = r.readU8();
  switch (sort) {
    case 0x00: { // module - not expected in our context
      throw new Error('module extern type not supported');
    }
    case 0x01: { // func
      const typeIndex = r.readU32LEB();
      return { tag: 'func', typeIndex };
    }
    case 0x02: { // value
      const type = readComponentValType(r);
      return { tag: 'value', type };
    }
    case 0x03: { // type + bounds
      const bounds = readTypeBounds(r);
      return { tag: 'type', typeIndex: -1, bounds }; // typeIndex filled later
    }
    case 0x04: { // instance
      const typeIndex = r.readU32LEB();
      return { tag: 'instance', typeIndex };
    }
    case 0x05: { // component
      const typeIndex = r.readU32LEB();
      return { tag: 'component', typeIndex };
    }
    default: throw new Error(`unknown extern sort 0x${sort.toString(16)}`);
  }
}

export function readTypeBounds(r: BinaryReader): TypeBounds {
  const tag = r.readU8();
  switch (tag) {
    case 0x00: return { tag: 'eq', typeIndex: r.readU32LEB() };
    case 0x01: return { tag: 'subResource' };
    default: throw new Error(`unknown type bounds tag 0x${tag.toString(16)}`);
  }
}

// -----------------------------------------------------------------------
// Instance type declarations
// -----------------------------------------------------------------------

function readInstanceTypeDecl(r: BinaryReader): InstanceTypeDecl {
  const tag = r.readU8();
  switch (tag) {
    case 0x00: { // core type
      // skip for now — instance type core type declarations
      throw new Error('core type in instance type not supported');
    }
    case 0x01: { // type
      const entry = readComponentTypeEntry(r);
      return { tag: 'type', entry };
    }
    case 0x02: { // alias
      const alias = readAliasFromTypeDecl(r);
      return { tag: 'alias', alias };
    }
    case 0x04: { // export type
      const name = readExternName(r);
      const type = readExternType(r);
      return { tag: 'exportType', name, type };
    }
    default: throw new Error(`unknown instance type decl tag 0x${tag.toString(16)}`);
  }
}

/** Read an extern name (kebab-cased or interface URL). */
export function readExternName(r: BinaryReader): string {
  const tag = r.readU8();
  // 0x00 = kebab-name, 0x01 = interface URL (both are just strings)
  if (tag !== 0x00 && tag !== 0x01) {
    throw new Error(`unknown extern name tag 0x${tag.toString(16)}`);
  }
  return r.readString();
}

/** Read an alias inside a type declaration.
 *  Uses the same binary format as the main alias section:
 *    byte1 [byte2 if byte1==0x00] target_byte ...
 *  target: 0x00=InstanceExport, 0x01=CoreInstanceExport, 0x02=Outer
 */
function readAliasFromTypeDecl(r: BinaryReader): Alias {
  const byte1 = r.readU8();
  const byte2 = byte1 === 0x00 ? r.readU8() : null;
  const target = r.readU8();

  switch (target) {
    case 0x00: { // InstanceExport
      const instanceIndex = r.readU32LEB();
      const name = r.readString();
      const sort = typeDeclSortFromBytes(byte1, byte2);
      return { tag: 'instanceExport', instanceIndex, name, sort };
    }
    case 0x02: { // Outer
      const outerCount = r.readU32LEB();
      const index = r.readU32LEB();
      const sort = typeDeclSortFromBytes(byte1, byte2);
      return { tag: 'outer', outerCount, index, sort };
    }
    default:
      throw new Error(`unexpected alias kind 0x${target.toString(16)} in type decl`);
  }
}

function typeDeclSortFromBytes(byte1: number, byte2: number | null): ExternalSort {
  if (byte1 === 0x00 && byte2 !== null) {
    // Core sorts
    switch (byte2) {
      case 0x10: return 'type';
      case 0x11: return 'func';
      default: return 'type';
    }
  }
  switch (byte1) {
    case 0x01: return 'func';
    case 0x02: return 'value';
    case 0x03: return 'type';
    case 0x04: return 'component';
    case 0x05: return 'instance';
    case 0x07: return 'type';
    default: return 'type';
  }
}

// -----------------------------------------------------------------------
// Resource type
// -----------------------------------------------------------------------

function readResourceType(r: BinaryReader): ResourceType {
  const rep = readCoreType(r);
  const hasDtor = r.readU8();
  const dtor = hasDtor !== 0 ? r.readU32LEB() : null;
  return { dtor, rep };
}

// -----------------------------------------------------------------------
// Component type entry (top-level in type section)
// -----------------------------------------------------------------------

export function readComponentTypeEntry(r: BinaryReader): ComponentTypeEntry {
  const tag = r.readU8();
  switch (tag) {
    case 0x40: { // func (sync)
      const type = readFuncType(r, false);
      return { tag: 'func', type };
    }
    case 0x43: { // func (async)
      const type = readFuncType(r, true);
      return { tag: 'func', type };
    }
    case 0x41: { // component type
      const count = r.readU32LEB();
      const entries: ComponentTypeEntry[] = [];
      for (let i = 0; i < count; i++) {
        entries.push(readComponentTypeEntry(r));
      }
      return { tag: 'component', entries };
    }
    case 0x42: { // instance type
      const count = r.readU32LEB();
      const entries: InstanceTypeDecl[] = [];
      for (let i = 0; i < count; i++) {
        entries.push(readInstanceTypeDecl(r));
      }
      return { tag: 'instance', entries };
    }
    case 0x3f: { // resource
      const resource = readResourceType(r);
      return { tag: 'resource', resource };
    }
    default: {
      // Defined type — pass the already-read tag byte
      return { tag: 'defined', type: readDefinedType(r, tag) };
    }
  }
}

/** Read a complete type section (section ID 0x07). */
export function readTypeSection(r: BinaryReader): ComponentTypeEntry[] {
  const count = r.readU32LEB();
  const entries: ComponentTypeEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push(readComponentTypeEntry(r));
  }
  return entries;
}
