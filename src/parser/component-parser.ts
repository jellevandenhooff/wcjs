/**
 * Component binary parser.
 * Reads a component binary (Uint8Array) and produces a ParsedComponent
 * with a flat list of sections in order.
 *
 * Tracks index spaces (core modules, core funcs, core instances, core memories,
 * component funcs, component instances, components, types) to assign correct
 * indices to each item as they appear.
 */
import { BinaryReader } from './binary-reader.ts';
import type {
  ParsedComponent, Section,
  CoreInstance, ComponentInstance, Alias,
  ComponentImport, ComponentExport,
  ComponentTypeEntry, CanonicalFunc,
  CoreSort,
} from './types.ts';
import { readTypeSection } from './type-parser.ts';
import { readCanonicalSection } from './canonical-parser.ts';
import {
  readCoreInstanceSection,
  readComponentInstanceSection,
  readAliasSection,
  readImportSection,
  readExportSection,
} from './section-parsers.ts';
import { readComponentNameSection, createEmptyNames } from './name-section-parser.ts';
import type { ComponentNames } from './types.ts';

// Component binary header constants
const WASM_MAGIC = 0x6d736100; // '\0asm' as u32 LE
const COMPONENT_VERSION = 0x0d; // version 13
const COMPONENT_LAYER = 0x01;   // layer 1 (component)

// Section IDs
const SECTION_CUSTOM = 0;
const SECTION_CORE_MODULE = 1;
const SECTION_CORE_INSTANCE = 2;
const SECTION_CORE_TYPE = 3;
const SECTION_COMPONENT = 4;
const SECTION_COMPONENT_INSTANCE = 5;
const SECTION_ALIAS = 6;
const SECTION_TYPE = 7;
const SECTION_CANONICAL = 8;
const SECTION_START = 9;
const SECTION_IMPORT = 10;
const SECTION_EXPORT = 11;

/** Index spaces tracked during parsing. */
interface IndexSpaces {
  coreModules: number;
  coreFuncs: number;
  coreInstances: number;
  coreMemories: number;
  coreTables: number;
  coreGlobals: number;
  coreTypes: number;
  compFuncs: number;
  compInstances: number;
  components: number;
  compTypes: number;
  compValues: number;
}

/** Parse a component binary into sections. */
export function parseComponentBinary(bytes: Uint8Array): ParsedComponent {
  const r = new BinaryReader(bytes);

  // Read and validate header
  const magic = r.readU32();
  if (magic !== WASM_MAGIC) {
    throw new Error(`invalid wasm magic: 0x${magic.toString(16)}`);
  }
  const version = r.readU8();
  r.readU8(); // version high byte (always 0)
  const layer = r.readU8();
  r.readU8(); // layer high byte (always 0)

  if (version !== COMPONENT_VERSION) {
    throw new Error(`unsupported component version: ${version}`);
  }
  if (layer !== COMPONENT_LAYER) {
    throw new Error(`not a component (layer ${layer})`);
  }

  const idx: IndexSpaces = {
    coreModules: 0,
    coreFuncs: 0,
    coreInstances: 0,
    coreMemories: 0,
    coreTables: 0,
    coreGlobals: 0,
    coreTypes: 0,
    compFuncs: 0,
    compInstances: 0,
    components: 0,
    compTypes: 0,
    compValues: 0,
  };

  const sections: Section[] = [];
  let names: ComponentNames | null = null;

  while (r.remaining > 0) {
    const sectionId = r.readU8();
    const sectionSize = r.readU32LEB();
    const sectionEnd = r.position + sectionSize;
    const sectionReader = r.subReader(sectionSize);

    switch (sectionId) {
      case SECTION_CUSTOM: {
        // Check for component-name section
        const sectionName = sectionReader.readString();
        if (sectionName === 'component-name') {
          names = readComponentNameSection(sectionReader);
        }
        break;
      }
      case SECTION_CORE_MODULE: {
        const moduleIndex = idx.coreModules++;
        // The section content IS the module binary (no wrapper)
        // We need to reconstruct the full module bytes with header
        const moduleBytes = bytes.subarray(r.position - sectionSize, r.position);
        sections.push({ tag: 'coreModule', index: moduleIndex, bytes: moduleBytes });
        break;
      }
      case SECTION_CORE_INSTANCE: {
        const instances = readCoreInstanceSection(sectionReader);
        for (const instance of instances) {
          const index = idx.coreInstances++;
          sections.push({ tag: 'coreInstance', index, instance });
          // Track items added to index spaces by this instance
          advanceCoreInstanceIndexSpaces(idx, instance);
        }
        break;
      }
      case SECTION_CORE_TYPE: {
        // Skip core type sections (we track count but don't parse details)
        const count = sectionReader.readU32LEB();
        for (let i = 0; i < count; i++) {
          const index = idx.coreTypes++;
          // Read past the core type definition
          skipCoreTypeDef(sectionReader);
          // We could emit sections but core types aren't needed for component-level printing
        }
        break;
      }
      case SECTION_COMPONENT: {
        const componentIndex = idx.components++;
        const componentBytes = bytes.subarray(r.position - sectionSize, r.position);
        sections.push({ tag: 'component', index: componentIndex, bytes: componentBytes });
        break;
      }
      case SECTION_COMPONENT_INSTANCE: {
        const instances = readComponentInstanceSection(sectionReader);
        for (const instance of instances) {
          const index = idx.compInstances++;
          sections.push({ tag: 'componentInstance', index, instance });
        }
        break;
      }
      case SECTION_ALIAS: {
        const aliases = readAliasSection(sectionReader);
        for (const alias of aliases) {
          advanceAliasIndexSpaces(idx, alias);
          sections.push({ tag: 'alias', alias });
        }
        break;
      }
      case SECTION_TYPE: {
        const entries = readTypeSection(sectionReader);
        const startIndex = idx.compTypes;
        idx.compTypes += entries.length;
        sections.push({ tag: 'type', startIndex, entries });
        break;
      }
      case SECTION_CANONICAL: {
        const funcs = readCanonicalSection(sectionReader);
        const startIndex = idx.coreFuncs;
        advanceCanonicalIndexSpaces(idx, funcs);
        sections.push({ tag: 'canonical', startIndex, funcs });
        break;
      }
      case SECTION_START: {
        // Skip start section (rarely used in P3 components)
        break;
      }
      case SECTION_IMPORT: {
        const imports = readImportSection(sectionReader);
        for (const imp of imports) {
          advanceImportIndexSpaces(idx, imp);
          sections.push({ tag: 'import', import: imp });
        }
        break;
      }
      case SECTION_EXPORT: {
        const exports = readExportSection(sectionReader);
        for (const exp of exports) {
          advanceExportIndexSpaces(idx, exp);
          sections.push({ tag: 'export', export: exp });
        }
        break;
      }
      default:
        throw new Error(`unknown section ID ${sectionId}`);
    }
  }

  return { sections, names: names ?? createEmptyNames() };
}

// -----------------------------------------------------------------------
// Index space advancement helpers
// -----------------------------------------------------------------------

/** Advance index spaces for items created by a core instance. */
function advanceCoreInstanceIndexSpaces(_idx: IndexSpaces, _instance: CoreInstance): void {
  // Core instances themselves are already counted in the main loop.
  // Core instance exports are accessed via aliases, not direct index space entries.
}

/** Advance index spaces for a canonical function definition. */
function advanceCanonicalIndexSpaces(idx: IndexSpaces, funcs: CanonicalFunc[]): void {
  for (const func of funcs) {
    switch (func.tag) {
      case 'lift':
        // Lift produces a component function
        idx.compFuncs++;
        break;
      case 'lower':
      case 'resourceNew':
      case 'resourceDrop':
      case 'resourceDropAsync':
      case 'resourceRep':
      case 'taskReturn':
      case 'contextGet':
      case 'contextSet':
      case 'taskCancel':
      case 'subtaskCancel':
      case 'subtaskDrop':
      case 'streamNew':
      case 'streamRead':
      case 'streamWrite':
      case 'streamCancelRead':
      case 'streamCancelWrite':
      case 'streamDropReadable':
      case 'streamDropWritable':
      case 'futureNew':
      case 'futureRead':
      case 'futureWrite':
      case 'futureCancelRead':
      case 'futureCancelWrite':
      case 'futureDropReadable':
      case 'futureDropWritable':
      case 'errorContextNew':
      case 'errorContextDebugMessage':
      case 'errorContextDrop':
      case 'waitableSetNew':
      case 'waitableSetWait':
      case 'waitableSetPoll':
      case 'waitableSetDrop':
      case 'waitableJoin':
      case 'backpressureInc':
      case 'backpressureDec':
      case 'threadYield':
      case 'threadIndex':
      case 'threadNewIndirect':
      case 'threadSuspend':
      case 'threadSwitchTo':
      case 'threadYieldTo':
      case 'threadResumeLater':
      case 'threadSpawnRef':
      case 'threadSpawnIndirect':
      case 'threadAvailableParallelism':
        // All these produce core functions
        idx.coreFuncs++;
        break;
    }
  }
}

/** Advance index spaces for an alias. */
function advanceAliasIndexSpaces(idx: IndexSpaces, alias: Alias): void {
  switch (alias.tag) {
    case 'coreInstanceExport':
      switch (alias.sort) {
        case 'func': idx.coreFuncs++; break;
        case 'memory': idx.coreMemories++; break;
        case 'table': idx.coreTables++; break;
        case 'global': idx.coreGlobals++; break;
        case 'type': idx.coreTypes++; break;
      }
      break;
    case 'instanceExport':
      switch (alias.sort) {
        case 'func': idx.compFuncs++; break;
        case 'instance': idx.compInstances++; break;
        case 'type': idx.compTypes++; break;
        case 'component': idx.components++; break;
        case 'value': idx.compValues++; break;
        default: break;
      }
      break;
    case 'outer':
      switch (alias.sort) {
        case 'func': idx.compFuncs++; break;
        case 'type': idx.compTypes++; break;
        case 'component': idx.components++; break;
        case 'instance': idx.compInstances++; break;
        default: break;
      }
      break;
  }
}

/** Advance index spaces for a component import. */
function advanceImportIndexSpaces(idx: IndexSpaces, imp: ComponentImport): void {
  switch (imp.type.tag) {
    case 'func': idx.compFuncs++; break;
    case 'instance': idx.compInstances++; break;
    case 'component': idx.components++; break;
    case 'type': idx.compTypes++; break;
    case 'value': idx.compValues++; break;
  }
}

/** Advance index spaces for a component export. Exports create new indices
 *  in their sort's index space (the exported item gets an additional alias). */
function advanceExportIndexSpaces(idx: IndexSpaces, exp: ComponentExport): void {
  switch (exp.sort) {
    case 'type': idx.compTypes++; break;
    case 'instance': idx.compInstances++; break;
  }
}

/** Skip a core type definition (we don't need to parse these). */
function skipCoreTypeDef(r: BinaryReader): void {
  const tag = r.readU8();
  if (tag === 0x60) {
    // func type: skip params and results
    const paramCount = r.readU32LEB();
    for (let i = 0; i < paramCount; i++) r.readU8(); // param types
    const resultCount = r.readU32LEB();
    for (let i = 0; i < resultCount; i++) r.readU8(); // result types
  } else if (tag === 0x50) {
    // module type — skip sub-declarations
    const count = r.readU32LEB();
    for (let i = 0; i < count; i++) {
      skipModuleTypeDecl(r);
    }
  } else {
    throw new Error(`unknown core type tag 0x${tag.toString(16)}`);
  }
}

function skipModuleTypeDecl(r: BinaryReader): void {
  const declTag = r.readU8();
  switch (declTag) {
    case 0x00: // import
      r.readString(); // module
      r.readString(); // name
      skipImportType(r);
      break;
    case 0x01: // type
      skipCoreTypeDef(r);
      break;
    case 0x02: // alias
      // outer alias
      r.readU8(); // sort
      r.readU8(); // count
      r.readU32LEB(); // index
      break;
    case 0x03: // export
      r.readString(); // name
      skipImportType(r);
      break;
    default:
      throw new Error(`unknown module type decl 0x${declTag.toString(16)}`);
  }
}

function skipImportType(r: BinaryReader): void {
  const typeTag = r.readU8();
  switch (typeTag) {
    case 0x00: r.readU32LEB(); break; // func type index
    case 0x01: // table type
      r.readU8(); // element type
      r.readU8(); // limits flags
      r.readU32LEB(); // min
      // if flags indicate max present, read it
      break;
    case 0x02: // memory type
      r.readU8(); // limits flags
      r.readU32LEB(); // min
      break;
    case 0x03: // global type
      r.readU8(); // val type
      r.readU8(); // mutability
      break;
    default:
      throw new Error(`unknown import type 0x${typeTag.toString(16)}`);
  }
}
