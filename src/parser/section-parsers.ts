/**
 * Per-section binary decoders for the component model format.
 * Each reads from a BinaryReader positioned at section content.
 */
import { BinaryReader } from './binary-reader.ts';
import type {
  CoreInstance, ComponentInstance, Alias,
  ComponentImport, ComponentExport, ExternType,
  CoreSort, ExternalSort,
} from './types.ts';
import { readComponentValType, readComponentTypeEntry, readTypeBounds, readExternName } from './type-parser.ts';

// -----------------------------------------------------------------------
// Core ExternalKind (single byte)
// -----------------------------------------------------------------------

function readCoreExternalKind(byte: number): CoreSort {
  switch (byte) {
    case 0x00: return 'func';
    case 0x01: return 'table';
    case 0x02: return 'memory';
    case 0x03: return 'global';
    case 0x04: return 'func'; // tag, mapped to func
    default: throw new Error(`unknown core external kind 0x${byte.toString(16)}`);
  }
}

// -----------------------------------------------------------------------
// ComponentExternalKind (1 or 2 bytes)
// The sort encoding is:
//   0x00 0x11 = Module
//   0x01 = Func
//   0x02 = Value
//   0x03 = Type
//   0x04 = Component
//   0x05 = Instance
// -----------------------------------------------------------------------

interface SortInfo {
  sort: ExternalSort;
  isCore: boolean;
  byte1: number;
  byte2: number | null;
}

function readComponentExternalKind(r: BinaryReader): SortInfo {
  const byte1 = r.readU8();
  if (byte1 === 0x00) {
    const byte2 = r.readU8();
    return { sort: 'func', isCore: true, byte1, byte2 }; // core module (0x11) or other core
  }
  switch (byte1) {
    case 0x01: return { sort: 'func', isCore: false, byte1, byte2: null };
    case 0x02: return { sort: 'value', isCore: false, byte1, byte2: null };
    case 0x03: return { sort: 'type', isCore: false, byte1, byte2: null };
    case 0x04: return { sort: 'component', isCore: false, byte1, byte2: null };
    case 0x05: return { sort: 'instance', isCore: false, byte1, byte2: null };
    default: throw new Error(`unknown component external kind 0x${byte1.toString(16)}`);
  }
}

/** Read just the ExternalSort from the component external kind bytes. */
function readExternalSort(r: BinaryReader): ExternalSort {
  return readComponentExternalKind(r).sort;
}

// -----------------------------------------------------------------------
// Section 2: Core instance section
// -----------------------------------------------------------------------

export function readCoreInstanceSection(r: BinaryReader): CoreInstance[] {
  const count = r.readU32LEB();
  const instances: CoreInstance[] = [];
  for (let i = 0; i < count; i++) {
    instances.push(readCoreInstance(r));
  }
  return instances;
}

function readCoreInstance(r: BinaryReader): CoreInstance {
  const tag = r.readU8();
  switch (tag) {
    case 0x00: { // instantiate
      const moduleIndex = r.readU32LEB();
      const argCount = r.readU32LEB();
      const args: Array<{ name: string; kind: CoreSort; index: number }> = [];
      for (let i = 0; i < argCount; i++) {
        const name = r.readString();
        const sortByte = r.readU8();
        // Core instance args are always instances (sort 0x12 = instance)
        if (sortByte !== 0x12) {
          throw new Error(`unexpected core instance arg sort 0x${sortByte.toString(16)}`);
        }
        const index = r.readU32LEB();
        // The arg kind is "instance" but we store it for printing
        args.push({ name, kind: 'func', index });
      }
      return { tag: 'instantiate', moduleIndex, args };
    }
    case 0x01: { // from exports
      const count = r.readU32LEB();
      const exports: Array<{ name: string; kind: CoreSort; index: number }> = [];
      for (let i = 0; i < count; i++) {
        const name = r.readString();
        const sortByte = r.readU8();
        const kind = readCoreExternalKind(sortByte);
        const index = r.readU32LEB();
        exports.push({ name, kind, index });
      }
      return { tag: 'fromExports', exports };
    }
    default:
      throw new Error(`unknown core instance tag 0x${tag.toString(16)}`);
  }
}

// -----------------------------------------------------------------------
// Section 5: Component instance section
// -----------------------------------------------------------------------

export function readComponentInstanceSection(r: BinaryReader): ComponentInstance[] {
  const count = r.readU32LEB();
  const instances: ComponentInstance[] = [];
  for (let i = 0; i < count; i++) {
    instances.push(readComponentInstance(r));
  }
  return instances;
}

function readComponentInstance(r: BinaryReader): ComponentInstance {
  const tag = r.readU8();
  switch (tag) {
    case 0x00: { // instantiate
      const componentIndex = r.readU32LEB();
      const argCount = r.readU32LEB();
      const args: Array<{ name: string; sort: ExternalSort; index: number }> = [];
      for (let i = 0; i < argCount; i++) {
        // Component instantiation args use plain strings, not extern names
        const name = r.readString();
        const sort = readExternalSort(r);
        const index = r.readU32LEB();
        args.push({ name, sort, index });
      }
      return { tag: 'instantiate', componentIndex, args };
    }
    case 0x01: { // from exports
      const count = r.readU32LEB();
      const exports: Array<{ name: string; sort: ExternalSort; index: number }> = [];
      for (let i = 0; i < count; i++) {
        const name = readExternName(r);
        const sort = readExternalSort(r);
        const index = r.readU32LEB();
        exports.push({ name, sort, index });
      }
      return { tag: 'fromExports', exports };
    }
    default:
      throw new Error(`unknown component instance tag 0x${tag.toString(16)}`);
  }
}

// -----------------------------------------------------------------------
// Section 6: Alias section
// Alias binary format:
//   byte1 = first sort byte
//   byte2 = if byte1 == 0x00, read second sort byte (for core sorts)
//   target_byte:
//     0x00 = InstanceExport (component instance)
//     0x01 = CoreInstanceExport
//     0x02 = Outer
// -----------------------------------------------------------------------

export function readAliasSection(r: BinaryReader): Alias[] {
  const count = r.readU32LEB();
  const aliases: Alias[] = [];
  for (let i = 0; i < count; i++) {
    aliases.push(readAlias(r));
  }
  return aliases;
}

function readAlias(r: BinaryReader): Alias {
  // Read sort bytes (1 or 2 bytes)
  const byte1 = r.readU8();
  const byte2 = byte1 === 0x00 ? r.readU8() : null;

  // Read target
  const target = r.readU8();

  switch (target) {
    case 0x00: { // InstanceExport (component-level)
      const instanceIndex = r.readU32LEB();
      const name = r.readString();  // plain string, no extern name tag
      const sort = componentSortFromBytes(byte1, byte2);
      return { tag: 'instanceExport', instanceIndex, name, sort };
    }
    case 0x01: { // CoreInstanceExport
      if (byte2 === null) {
        throw new Error(`core instance export alias requires 0x00 prefix, got 0x${byte1.toString(16)}`);
      }
      const coreSort = readCoreExternalKind(byte2);
      const instanceIndex = r.readU32LEB();
      const name = r.readString();
      return { tag: 'coreInstanceExport', instanceIndex, name, sort: coreSort };
    }
    case 0x02: { // Outer
      const sort = outerAliasSortFromBytes(byte1, byte2);
      const outerCount = r.readU32LEB();
      const index = r.readU32LEB();
      return { tag: 'outer', outerCount, index, sort };
    }
    default:
      throw new Error(`unknown alias target 0x${target.toString(16)}`);
  }
}

function componentSortFromBytes(byte1: number, byte2: number | null): ExternalSort {
  if (byte1 === 0x00) {
    // Core sort in component context — typically 0x00 0x11 = module
    return 'func'; // shouldn't normally appear in InstanceExport
  }
  switch (byte1) {
    case 0x01: return 'func';
    case 0x02: return 'value';
    case 0x03: return 'type';
    case 0x04: return 'component';
    case 0x05: return 'instance';
    default: throw new Error(`unknown component sort byte 0x${byte1.toString(16)}`);
  }
}

function outerAliasSortFromBytes(byte1: number, byte2: number | null): ExternalSort {
  if (byte1 === 0x00) {
    switch (byte2) {
      case 0x10: return 'type'; // CoreType
      case 0x11: return 'type'; // CoreModule (treated as type for simplicity)
      default: throw new Error(`unknown outer alias core sort 0x00 0x${(byte2 ?? 0).toString(16)}`);
    }
  }
  switch (byte1) {
    case 0x03: return 'type';
    case 0x04: return 'component';
    default: throw new Error(`unknown outer alias sort 0x${byte1.toString(16)}`);
  }
}

// -----------------------------------------------------------------------
// Section 10: Import section
// -----------------------------------------------------------------------

export function readImportSection(r: BinaryReader): ComponentImport[] {
  const count = r.readU32LEB();
  const imports: ComponentImport[] = [];
  for (let i = 0; i < count; i++) {
    const name = readExternName(r);
    const type = readComponentTypeRef(r);
    imports.push({ name, type });
  }
  return imports;
}

/** Read a ComponentTypeRef (used in imports and export type ascriptions). */
function readComponentTypeRef(r: BinaryReader): ExternType {
  const kind = readComponentExternalKind(r);
  switch (kind.byte1) {
    case 0x00: {
      // Module: 0x00 0x11 → module type index
      const typeIndex = r.readU32LEB();
      return { tag: 'component', typeIndex }; // treated as component for simplicity
    }
    case 0x01: { // Func
      const typeIndex = r.readU32LEB();
      return { tag: 'func', typeIndex };
    }
    case 0x02: { // Value
      const type = readComponentValType(r);
      return { tag: 'value', type };
    }
    case 0x03: { // Type + bounds
      const bounds = readTypeBounds(r);
      return { tag: 'type', typeIndex: -1, bounds };
    }
    case 0x04: { // Component
      const typeIndex = r.readU32LEB();
      return { tag: 'component', typeIndex };
    }
    case 0x05: { // Instance
      const typeIndex = r.readU32LEB();
      return { tag: 'instance', typeIndex };
    }
    default:
      throw new Error(`unknown component type ref kind 0x${kind.byte1.toString(16)}`);
  }
}

// -----------------------------------------------------------------------
// Section 11: Export section
// -----------------------------------------------------------------------

export function readExportSection(r: BinaryReader): ComponentExport[] {
  const count = r.readU32LEB();
  const exports: ComponentExport[] = [];
  for (let i = 0; i < count; i++) {
    const name = readExternName(r);
    const sort = readExternalSort(r);
    const index = r.readU32LEB();
    // Optional type ascription: 0x00 = none, 0x01 = present
    const hasType = r.readU8();
    let type: ExternType | null = null;
    if (hasType === 0x01) {
      type = readComponentTypeRef(r);
    } else if (hasType !== 0x00) {
      throw new Error(`unexpected export type ascription tag 0x${hasType.toString(16)}`);
    }
    exports.push({ name, sort, index, type });
  }
  return exports;
}
