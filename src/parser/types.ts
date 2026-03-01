/**
 * IR types representing a parsed component binary.
 *
 * These mirror the component model binary sections at a structural level,
 * suitable for printing back to WAT text format.
 */

// -----------------------------------------------------------------------
// Component-level value types
// -----------------------------------------------------------------------

/** Primitive value types used in component model. */
export type PrimValType =
  | 'bool' | 'u8' | 's8' | 'u16' | 's16' | 'u32' | 's32'
  | 'u64' | 's64' | 'f32' | 'f64' | 'char' | 'string';

/** A component-level value type. */
export type ComponentValType =
  | { tag: 'primitive'; type: PrimValType }
  | { tag: 'typeIndex'; index: number };

/** A defined (compound) type. */
export type DefinedType =
  | { tag: 'primitive'; type: PrimValType }
  | { tag: 'record'; fields: Array<{ name: string; type: ComponentValType }> }
  | { tag: 'variant'; cases: Array<{ name: string; type: ComponentValType | null; refines: number | null }> }
  | { tag: 'list'; elementType: ComponentValType }
  | { tag: 'tuple'; types: ComponentValType[] }
  | { tag: 'flags'; names: string[] }
  | { tag: 'enum'; names: string[] }
  | { tag: 'option'; type: ComponentValType }
  | { tag: 'result'; ok: ComponentValType | null; err: ComponentValType | null }
  | { tag: 'own'; typeIndex: number }
  | { tag: 'borrow'; typeIndex: number }
  | { tag: 'future'; type: ComponentValType | null }
  | { tag: 'stream'; type: ComponentValType | null }
  | { tag: 'errorContext' };

// -----------------------------------------------------------------------
// Component types (type section entries)
// -----------------------------------------------------------------------

/** A component function type. */
export interface ComponentFuncType {
  params: Array<{ name: string; type: ComponentValType }>;
  result: ComponentValType | null;
  isAsync: boolean;
}

/** A resource type declaration. */
export interface ResourceType {
  dtor: number | null;
  rep: CoreType;
}

/** A component type definition (entry in type section). */
export type ComponentTypeEntry =
  | { tag: 'defined'; type: DefinedType }
  | { tag: 'func'; type: ComponentFuncType }
  | { tag: 'component'; entries: ComponentTypeEntry[] }
  | { tag: 'instance'; entries: InstanceTypeDecl[] }
  | { tag: 'resource'; resource: ResourceType };

/** Declarations within an instance type. */
export type InstanceTypeDecl =
  | { tag: 'type'; entry: ComponentTypeEntry }
  | { tag: 'alias'; alias: Alias }
  | { tag: 'exportType'; name: string; type: ExternType };

/** An extern type (type reference in import/export). */
export type ExternType =
  | { tag: 'type'; typeIndex: number; bounds: TypeBounds }
  | { tag: 'func'; typeIndex: number }
  | { tag: 'value'; type: ComponentValType }
  | { tag: 'instance'; typeIndex: number }
  | { tag: 'component'; typeIndex: number };

/** Type bounds for extern type declarations. */
export type TypeBounds =
  | { tag: 'eq'; typeIndex: number }
  | { tag: 'subResource' };

// -----------------------------------------------------------------------
// Core types
// -----------------------------------------------------------------------

export type CoreType = 'i32' | 'i64' | 'f32' | 'f64';

/** A core function type. */
export interface CoreFuncType {
  params: CoreType[];
  results: CoreType[];
}

// -----------------------------------------------------------------------
// Canonical functions
// -----------------------------------------------------------------------

/** Canonical option for lift/lower. */
export type CanonOpt =
  | { tag: 'utf8' }
  | { tag: 'utf16' }
  | { tag: 'compactUtf16' }
  | { tag: 'memory'; index: number }
  | { tag: 'realloc'; index: number }
  | { tag: 'postReturn'; index: number }
  | { tag: 'async' }
  | { tag: 'callback'; index: number };

/** A canonical function definition. */
export type CanonicalFunc =
  | { tag: 'lift'; coreFuncIndex: number; options: CanonOpt[]; typeIndex: number }
  | { tag: 'lower'; funcIndex: number; options: CanonOpt[] }
  | { tag: 'resourceNew'; typeIndex: number }
  | { tag: 'resourceDrop'; typeIndex: number }
  | { tag: 'resourceDropAsync'; typeIndex: number }
  | { tag: 'resourceRep'; typeIndex: number }
  | { tag: 'taskReturn'; result: ComponentValType | null; options: CanonOpt[] }
  | { tag: 'contextGet'; index: number }
  | { tag: 'contextSet'; index: number }
  | { tag: 'taskCancel' }
  | { tag: 'subtaskCancel'; async: boolean }
  | { tag: 'subtaskDrop' }
  | { tag: 'streamNew'; typeIndex: number }
  | { tag: 'streamRead'; typeIndex: number; options: CanonOpt[] }
  | { tag: 'streamWrite'; typeIndex: number; options: CanonOpt[] }
  | { tag: 'streamCancelRead'; typeIndex: number; async: boolean }
  | { tag: 'streamCancelWrite'; typeIndex: number; async: boolean }
  | { tag: 'streamDropReadable'; typeIndex: number }
  | { tag: 'streamDropWritable'; typeIndex: number }
  | { tag: 'futureNew'; typeIndex: number }
  | { tag: 'futureRead'; typeIndex: number; options: CanonOpt[] }
  | { tag: 'futureWrite'; typeIndex: number; options: CanonOpt[] }
  | { tag: 'futureCancelRead'; typeIndex: number; async: boolean }
  | { tag: 'futureCancelWrite'; typeIndex: number; async: boolean }
  | { tag: 'futureDropReadable'; typeIndex: number }
  | { tag: 'futureDropWritable'; typeIndex: number }
  | { tag: 'errorContextNew'; options: CanonOpt[] }
  | { tag: 'errorContextDebugMessage'; options: CanonOpt[] }
  | { tag: 'errorContextDrop' }
  | { tag: 'waitableSetNew' }
  | { tag: 'waitableSetWait'; async: boolean; memoryIndex: number }
  | { tag: 'waitableSetPoll'; async: boolean; memoryIndex: number }
  | { tag: 'waitableSetDrop' }
  | { tag: 'waitableJoin' }
  | { tag: 'backpressureInc' }
  | { tag: 'backpressureDec' }
  | { tag: 'threadYield'; async: boolean }
  | { tag: 'threadIndex' }
  | { tag: 'threadNewIndirect'; funcTypeIndex: number; tableIndex: number }
  | { tag: 'threadSuspend'; async: boolean }
  | { tag: 'threadSwitchTo'; async: boolean }
  | { tag: 'threadYieldTo'; async: boolean }
  | { tag: 'threadResumeLater' }
  | { tag: 'threadSuspendTo'; cancellable: boolean }
  | { tag: 'threadSpawnRef'; funcTypeIndex: number }
  | { tag: 'threadSpawnIndirect'; funcTypeIndex: number; tableIndex: number }
  | { tag: 'threadAvailableParallelism' };

// -----------------------------------------------------------------------
// Aliases
// -----------------------------------------------------------------------

/** Sort (kind) of aliased item. */
export type ExternalSort = 'func' | 'table' | 'memory' | 'global' | 'type'
  | 'component' | 'instance' | 'value';

/** Core sort for core aliases. */
export type CoreSort = 'func' | 'table' | 'memory' | 'global' | 'type';

/** An alias declaration. */
export type Alias =
  | { tag: 'coreInstanceExport'; instanceIndex: number; name: string; sort: CoreSort }
  | { tag: 'instanceExport'; instanceIndex: number; name: string; sort: ExternalSort }
  | { tag: 'outer'; outerCount: number; index: number; sort: ExternalSort };

// -----------------------------------------------------------------------
// Instances
// -----------------------------------------------------------------------

/** A core instance definition. */
export type CoreInstance =
  | { tag: 'instantiate'; moduleIndex: number; args: Array<{ name: string; kind: CoreSort; index: number }> }
  | { tag: 'fromExports'; exports: Array<{ name: string; kind: CoreSort; index: number }> };

/** A component instance definition. */
export type ComponentInstance =
  | { tag: 'instantiate'; componentIndex: number; args: Array<{ name: string; sort: ExternalSort; index: number }> }
  | { tag: 'fromExports'; exports: Array<{ name: string; sort: ExternalSort; index: number }> };

// -----------------------------------------------------------------------
// Imports and Exports
// -----------------------------------------------------------------------

/** A component import. */
export interface ComponentImport {
  name: string;
  type: ExternType;
}

/** A component export. */
export interface ComponentExport {
  name: string;
  sort: ExternalSort;
  index: number;
  type: ExternType | null;
}

// -----------------------------------------------------------------------
// Sections — ordered list of parsed sections
// -----------------------------------------------------------------------

/** A parsed section from the component binary. */
export type Section =
  | { tag: 'coreModule'; index: number; bytes: Uint8Array }
  | { tag: 'coreInstance'; index: number; instance: CoreInstance }
  | { tag: 'coreType'; index: number; type: CoreFuncType }
  | { tag: 'type'; startIndex: number; entries: ComponentTypeEntry[] }
  | { tag: 'canonical'; startIndex: number; funcs: CanonicalFunc[] }
  | { tag: 'component'; index: number; bytes: Uint8Array }
  | { tag: 'componentInstance'; index: number; instance: ComponentInstance }
  | { tag: 'alias'; alias: Alias }
  | { tag: 'import'; import: ComponentImport }
  | { tag: 'export'; export: ComponentExport };

// -----------------------------------------------------------------------
// Component names (from component-name custom section)
// -----------------------------------------------------------------------

/** Names extracted from the `component-name` custom section. */
export interface ComponentNames {
  componentName?: string;
  coreFunc: Map<number, string>;
  coreTable: Map<number, string>;
  coreMemory: Map<number, string>;
  coreGlobal: Map<number, string>;
  coreModule: Map<number, string>;
  coreInstance: Map<number, string>;
  func: Map<number, string>;
  type: Map<number, string>;
  component: Map<number, string>;
  instance: Map<number, string>;
}

// -----------------------------------------------------------------------
// Parsed component — top-level result
// -----------------------------------------------------------------------

/** Result of parsing a component binary. */
export interface ParsedComponent {
  sections: Section[];
  names: ComponentNames;
}
