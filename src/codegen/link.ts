/**
 * Phase 1: Walk ParsedComponent sections → build index spaces → LinkedComponent.
 *
 * Maintains core/component index spaces and links references
 * (e.g., canon lower targets, fromExports bags) into concrete items
 * that the emitter can walk to produce TypeScript.
 *
 * Supports nested components: each nested component gets its own
 * ComponentScope with a unique stateIdx, sharing the same global state
 * (modules, trampolines, etc.).
 */

import type {
  ParsedComponent, Section, ComponentTypeEntry, CanonicalFunc,
  CanonOpt, CoreSort, ComponentFuncType, ComponentValType,
} from '../parser/types.ts';
import type {
  LinkedComponent, ImportBinding, Trampoline,
  TaskReturnKind, ExportedFunc, ExportLiftInfo, CalleeRef, StateRelationship,
  StartFn, ReturnFn, TransferKind, FlatValType,
  LinkedModule, LinkedInstance, LinkedTrampoline,
  LinkedMemory, LinkedCallback,
} from './link-types.ts';
import type { HostFuncTypeInfo, HostValType, HostImportLowerInfo } from './host-types.ts';
import { flattenHostValType, hostValTypeByteSize, hostValTypeAlignment } from './host-types.ts';
import { extractInstanceExportTypes, convertValTypeLocal } from './link-host-types.ts';
import { flattenType, elemByteSize, type TypeFallback } from './flatten.ts';
import { parseComponent } from '../parser/parse.ts';


/** Maximum number of flat params that can be passed directly (beyond → memory). */
const MAX_FLAT_PARAMS = 16;
/** Maximum number of flat results that can be returned directly (beyond → memory). */
const MAX_FLAT_RESULTS = 1;

// -----------------------------------------------------------------------
// Internal resolver types
// -----------------------------------------------------------------------

type CoreFuncDef =
  | { tag: 'trampoline'; trampolineIdx: number }
  | { tag: 'lower'; funcIdx: number; memoryIdx: number | null; reallocIdx: number | null; isAsync: boolean }
  | { tag: 'alias'; coreInstanceIdx: number; name: string };

type CoreInstanceDef =
  | { tag: 'instantiation'; runtimeIdx: number }
  | { tag: 'fromExports'; exports: Array<{ name: string; kind: CoreSort; index: number }> };

type CompFuncDef =
  | { tag: 'import'; name: string; typeIdx: number }
  | { tag: 'lift'; coreFuncIdx: number; callbackCoreFuncIdx: number | null;
      isAsync: boolean; hasAsyncOption: boolean; memoryIdx: number | null; reallocIdx: number | null; typeIdx: number }
  | { tag: 'aliasExport'; compInstanceIdx: number; name: string }
  | { tag: 'boundImport'; resolved: ResolvedFunc }
  | { tag: 'hostInstanceExport'; importName: string; exportName: string; typeInfo: HostFuncTypeInfo | null; instanceIdx: number };

type CompInstanceDef =
  | { tag: 'instantiation'; componentIdx: number;
      args: Array<{ name: string; sort: string; index: number }> }
  | { tag: 'fromExports';
      exports: Array<{ name: string; sort: string; index: number }> }
  | { tag: 'mergedExports'; exports: Map<string, MergedItem>; stateIdx: number;
      types?: Map<string, MergedType> }
  | { tag: 'hostImport'; importName: string; typeIndex: number;
      exportTypes: Map<string, HostFuncTypeInfo>;
      exportedValTypes?: Map<string, HostValType> };

type MergedItem =
  | { tag: 'func'; func: ExportedFunc; calleeRef: CalleeRef;
      resultFlatTypes: FlatValType[]; paramFlatTypes: FlatValType[];
      funcType: ComponentFuncType | null; hasAsyncOption: boolean;
      needsJSPI: boolean; transfers: TransferInfo;
      calleeMemoryIdx?: number;
      calleeRealloc?: { runtimeInstanceIdx: number; exportName: string };
      callbackInfo?: { runtimeInstanceIdx: number; exportName: string } };

/** Resolved type info for cross-component type aliases. */
interface MergedType {
  entry: ComponentTypeEntry;
  /** For resource types: resolved destructor location */
  dtor?: { runtimeInstanceIdx: number; exportName: string };
}

/** Pre-resolved result/param transfer info (avoids cross-scope type lookups). */
interface TransferInfo {
  resultStreamTransfer?: { tableIdx: number };
  resultFutureTransfer?: { tableIdx: number };
  resultResourceTransfer?: boolean;
  paramStreamTransfers?: Array<{ paramFlatIdx: number; tableIdx: number }>;
  paramFutureTransfers?: Array<{ paramFlatIdx: number; tableIdx: number }>;
  paramResourceTransfers?: Array<{ paramFlatIdx: number; kind: 'own' | 'borrow'; calleeDefinesResource: boolean }>;
}

/** Resolved function info carried when binding parent funcs to child imports. */
interface ResolvedFunc {
  callee: CalleeRef;
  /** Whether the function type declares async (controls export wrapper) */
  isAsync: boolean;
  /** Whether the canon lift has the (async) option (controls retptr/promising) */
  hasAsyncOption: boolean;
  /** Whether the callee's component has suspending (JSPI) imports */
  needsJSPI: boolean;
  stateIdx: number;
  callback?: { runtimeInstanceIdx: number; exportName: string };
  /** Allocated callback index from the lift (-1 if none) */
  callbackIdx: number;
  /** Flat param types (for determining param count and transfers) */
  paramFlatTypes: FlatValType[];
  /** Flat result types */
  resultFlatTypes: FlatValType[];
  /** Component func type info for transfer detection */
  funcType: ComponentFuncType | null;
  /** Pre-resolved transfer info (avoids cross-scope type lookups) */
  transfers: TransferInfo;
  /** Callee's global memory index (from canon lift memory option) */
  calleeMemoryIdx?: number;
  /** Callee's realloc info (from canon lift realloc option) */
  calleeRealloc?: { runtimeInstanceIdx: number; exportName: string };
}

interface CoreMemoryRef {
  coreInstanceIdx: number;
  name: string;
}

// -----------------------------------------------------------------------
// Global state (shared across all component scopes)
// -----------------------------------------------------------------------

class GlobalState {
  modules: LinkedModule[] = [];
  instances: LinkedInstance[] = [];
  trampolines: LinkedTrampoline[] = [];
  memories: LinkedMemory[] = [];
  callbacks: LinkedCallback[] = [];
  nextTrampoline = 0;
  nextRuntimeInstance = 0;
  nextCallback = 0;
  nextModuleIdx = 0;
  nextMemory = 0;
  nextStateIdx = 1; // state0 = root
  stateRelationships: StateRelationship[] = [];
  resolvedExports = new Map<string, Map<string, ExportedFunc>>();
}

// -----------------------------------------------------------------------
// Component scope (per nested component)
// -----------------------------------------------------------------------

class ComponentScope {
  global: GlobalState;
  stateIdx: number;

  // Local index spaces (reset per component)
  moduleIdxMap: number[] = [];
  coreFuncs: CoreFuncDef[] = [];
  coreInstances: CoreInstanceDef[] = [];
  coreMemories: CoreMemoryRef[] = [];
  memoryIdxMap: number[] = []; // local memory index → global memory index
  compFuncs: CompFuncDef[] = [];
  compInstances: CompInstanceDef[] = [];
  compTypes: ComponentTypeEntry[] = [];
  components: Uint8Array[] = [];

  // Parent scope's compTypes for resolving outer type aliases
  parentCompTypes: ComponentTypeEntry[] | null = null;

  // Bound imports from parent
  boundFuncs = new Map<string, ResolvedFunc>();
  boundInstances = new Map<string, { exports: Map<string, MergedItem>; stateIdx: number; types?: Map<string, MergedType> }>();

  // Whether this component's core module has any suspending (JSPI) imports
  needsJSPI = false;

  // Core table tracking
  coreTables: Array<{ coreInstanceIdx: number; name: string }> = [];

  // Resolved destructors for cross-component resource type aliases
  resolvedDtors = new Map<number, { runtimeInstanceIdx: number; exportName: string }>();
  // Next type index for alias-created types
  nextTypeIdx = 0;
  // Maps component type index → export type info for instance types
  pendingInstanceTypeExports = new Map<number, Map<string, HostFuncTypeInfo>>();
  // Type indices for resource types defined locally (in type section, not imported/aliased)
  localResourceTypes = new Set<number>();
  // Maps host import instance index → { resource name → component type index }
  hostImportResourceTypes?: Map<number, Map<string, number>>;
  // Maps component type index → HostValType for types aliased from host imports
  // Used as fallback for byte size computation when compTypes entry is unavailable
  hostValTypes = new Map<number, HostValType>();

  // Stream/future/resource table indices (per-component)
  private streamTableMap = new Map<number, number>();
  private nextStreamTable = 0;
  private futureTableMap = new Map<number, number>();
  private nextFutureTable = 0;
  private resourceTableMap = new Map<number, number>();
  private nextResourceTable = 0;
  // Maps duplicate type aliases to canonical type index (for resource table dedup)
  resourceTypeAliasMap = new Map<number, number>();

  constructor(global: GlobalState, stateIdx: number) {
    this.global = global;
    this.stateIdx = stateIdx;
  }

  // Fallback for elemByteSize/elemAlignment when type indices are missing from compTypes
  // (e.g., types aliased from host import instances).
  hostValTypesFallback(): TypeFallback {
    return (index: number) => {
      const hvt = this.hostValTypes.get(index);
      if (!hvt) return null;
      return { size: hostValTypeByteSize(hvt), align: hostValTypeAlignment(hvt) };
    };
  }

  /** Shared structural-typing dedup for stream/future table indices. */
  private getTableIdx(
    tag: 'stream' | 'future',
    tableMap: Map<number, number>,
    typeIndex: number,
  ): number {
    let idx = tableMap.get(typeIndex);
    if (idx !== undefined) return idx;

    // Structural typing: two different type indices for the same element type
    // should map to the same table (e.g., (stream u8) defined in imports vs canon section)
    const fb = this.hostValTypesFallback();
    const entry = this.compTypes[typeIndex];
    if (entry?.tag === 'defined' && entry.type.tag === tag) {
      const targetElemSize = elemByteSize(entry.type.type, this.compTypes, fb);
      for (const [existingTypeIdx, existingTableIdx] of tableMap) {
        const existingEntry = this.compTypes[existingTypeIdx];
        if (existingEntry?.tag === 'defined' && existingEntry.type.tag === tag) {
          if (elemByteSize(existingEntry.type.type, this.compTypes, fb) === targetElemSize) {
            tableMap.set(typeIndex, existingTableIdx);
            return existingTableIdx;
          }
        }
      }
    }

    idx = tag === 'stream' ? this.nextStreamTable++ : this.nextFutureTable++;
    tableMap.set(typeIndex, idx);
    return idx;
  }

  getStreamTableIdx(typeIndex: number): number {
    return this.getTableIdx('stream', this.streamTableMap, typeIndex);
  }

  getStreamElemSize(typeIndex: number): number {
    const entry = this.compTypes[typeIndex];
    if (entry?.tag === 'defined' && entry.type.tag === 'stream') {
      return elemByteSize(entry.type.type, this.compTypes, this.hostValTypesFallback());
    }
    return 0;
  }

  getStreamElemHostValType(typeIndex: number): import('./host-types.ts').HostValType | null {
    const entry = this.compTypes[typeIndex];
    if (entry?.tag === 'defined' && entry.type.tag === 'stream' && entry.type.type) {
      // Check hostValTypes fallback for types aliased from host imports
      if (entry.type.type.tag === 'typeIndex' && !this.compTypes[entry.type.type.index]) {
        const hvt = this.hostValTypes.get(entry.type.type.index);
        if (hvt) return hvt;
      }
      return convertValTypeLocal(entry.type.type, [], this.compTypes, undefined, this.hostValTypes);
    }
    return null;
  }

  isStreamResource(typeIndex: number): boolean {
    const entry = this.compTypes[typeIndex];
    if (entry?.tag === 'defined' && entry.type.tag === 'stream' && entry.type.type) {
      if (entry.type.type.tag === 'typeIndex') {
        const elemEntry = this.compTypes[entry.type.type.index];
        if (elemEntry?.tag === 'defined' && (elemEntry.type.tag === 'own' || elemEntry.type.tag === 'borrow')) {
          return true;
        }
      }
    }
    return false;
  }

  // Get the resource table index for the element type of a resource stream.
  getStreamResourceTableIdx(typeIndex: number): number {
    const entry = this.compTypes[typeIndex];
    if (entry?.tag === 'defined' && entry.type.tag === 'stream' && entry.type.type) {
      if (entry.type.type.tag === 'typeIndex') {
        const elemEntry = this.compTypes[entry.type.type.index];
        if (elemEntry?.tag === 'defined' && (elemEntry.type.tag === 'own' || elemEntry.type.tag === 'borrow')) {
          return this.getResourceTableIdx(elemEntry.type.typeIndex);
        }
      }
    }
    throw new Error(`stream type ${typeIndex} is not a resource stream`);
  }

  getFutureTableIdx(typeIndex: number): number {
    return this.getTableIdx('future', this.futureTableMap, typeIndex);
  }

  getFutureElemSize(typeIndex: number): number {
    const entry = this.compTypes[typeIndex];
    if (entry?.tag === 'defined' && entry.type.tag === 'future') {
      return elemByteSize(entry.type.type, this.compTypes, this.hostValTypesFallback());
    }
    return 0;
  }

  getFutureElemHostValType(typeIndex: number): import('./host-types.ts').HostValType | null {
    const entry = this.compTypes[typeIndex];
    if (entry?.tag === 'defined' && entry.type.tag === 'future' && entry.type.type) {
      if (entry.type.type.tag === 'typeIndex' && !this.compTypes[entry.type.type.index]) {
        const hvt = this.hostValTypes.get(entry.type.type.index);
        if (hvt) return hvt;
      }
      return convertValTypeLocal(entry.type.type, [], this.compTypes, undefined, this.hostValTypes);
    }
    return null;
  }

  getResourceTableIdx(typeIndex: number): number {
    // Resolve through alias map to canonical type index
    const canonical = this.resourceTypeAliasMap.get(typeIndex) ?? typeIndex;
    let idx = this.resourceTableMap.get(canonical);
    if (idx !== undefined) {
      this.resourceTableMap.set(typeIndex, idx);
      return idx;
    }
    idx = this.nextResourceTable++;
    this.resourceTableMap.set(canonical, idx);
    this.resourceTableMap.set(typeIndex, idx);
    return idx;
  }

  /** Map a local memory index (from canon option) to a global memory index. */
  getGlobalMemoryIdx(localIdx: number): number {
    return this.memoryIdxMap[localIdx] ?? localIdx;
  }
}

// -----------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------

export function link(parsed: ParsedComponent): LinkedComponent {
  const global = new GlobalState();
  const scope = new ComponentScope(global, 0); // state0 = root

  for (const section of parsed.sections) {
    processSection(scope, section);
  }

  // Re-extract host import instance types now that all type aliases are resolved.
  // During initial processing, outer aliases within instance types may reference
  // component-level types created by later alias operations (forward references).
  reExtractHostImportTypes(scope);

  // Emit memory extractions after all instances are resolved
  emitMemoryExtractions(scope);

  return {
    modules: global.modules,
    instances: global.instances,
    trampolines: global.trampolines,
    memories: global.memories,
    callbacks: global.callbacks,
    exports: global.resolvedExports,
    numStates: global.nextStateIdx,
    stateRelationships: global.stateRelationships,
  };
}

/**
 * Re-extract host import instance types after all sections are processed.
 * This resolves forward references where instance type declarations contain
 * outer aliases to types created by later alias operations.
 */
function reExtractHostImportTypes(scope: ComponentScope): void {
  for (const ci of scope.compInstances) {
    if (ci.tag !== 'hostImport') continue;
    const entry = scope.compTypes[ci.typeIndex];
    if (entry?.tag !== 'instance') continue;
    const extracted = extractInstanceExportTypes(
      entry.entries, scope.compTypes, scope.hostValTypes,
    );
    // Update function types with correctly resolved signatures
    for (const [name, info] of extracted.funcTypes) {
      ci.exportTypes.set(name, info);
    }
    // Update value types
    if (extracted.valTypes.size > 0) {
      if (!ci.exportedValTypes) ci.exportedValTypes = new Map();
      for (const [name, hvt] of extracted.valTypes) {
        ci.exportedValTypes.set(name, hvt);
      }
    }
    // Also update hostValTypes for any newly resolved types
    if (ci.exportedValTypes) {
      // Find all instanceExport aliases that reference this instance
      // and update their hostValTypes entries
      for (let i = 0; i < scope.compInstances.length; i++) {
        if (scope.compInstances[i] !== ci) continue;
        // Walk through any type aliases from this instance
        for (const [name, hvt] of ci.exportedValTypes) {
          // Find the corresponding type index via hostImportResourceTypes
          const instanceMap = scope.hostImportResourceTypes?.get(i);
          if (instanceMap) {
            const typeIdx = instanceMap.get(name);
            if (typeIdx !== undefined && !scope.hostValTypes.has(typeIdx)) {
              scope.hostValTypes.set(typeIdx, hvt);
            }
          }
        }
      }
    }
  }
}

// -----------------------------------------------------------------------
// Section dispatch
// -----------------------------------------------------------------------

function processSection(scope: ComponentScope, section: Section): void {
  switch (section.tag) {
    case 'coreModule': {
      const globalIdx = scope.global.nextModuleIdx++;
      scope.moduleIdxMap[section.index] = globalIdx;
      scope.global.modules.push({ moduleIdx: globalIdx, bytes: section.bytes });
      break;
    }

    case 'type':
      for (let i = 0; i < section.entries.length; i++) {
        const typeIdx = section.startIndex + i;
        scope.compTypes[typeIdx] = section.entries[i]!;
        // Track locally-defined resource types
        const entry = section.entries[i]!;
        if (entry.tag === 'resource') {
          scope.localResourceTypes.add(typeIdx);
        }
        // Extract function export type info from instance types
        if (entry.tag === 'instance') {
          const { funcTypes } = extractInstanceExportTypes(entry.entries, scope.compTypes, scope.hostValTypes);
          if (funcTypes.size > 0) {
            scope.pendingInstanceTypeExports.set(typeIdx, funcTypes);
          }
        }
      }
      scope.nextTypeIdx = Math.max(scope.nextTypeIdx, section.startIndex + section.entries.length);
      break;

    case 'import':
      processImport(scope, section.import);
      break;

    case 'canonical':
      processCanonicalSection(scope, section.startIndex, section.funcs);
      break;

    case 'alias':
      processAlias(scope, section.alias);
      break;

    case 'coreInstance':
      processCoreInstance(scope, section.index, section.instance);
      break;

    case 'component':
      scope.components[section.index] = section.bytes;
      break;

    case 'componentInstance':
      processComponentInstance(scope, section.index, section.instance);
      break;

    case 'export':
      processExport(scope, section.export);
      break;

    // coreType — not needed for current tests
  }
}

// -----------------------------------------------------------------------
// Import handling
// -----------------------------------------------------------------------

function processImport(
  scope: ComponentScope,
  imp: { name: string; type: { tag: string; typeIndex?: number } },
): void {
  if (imp.type.tag === 'func' && imp.type.typeIndex !== undefined) {
    // Check if this import is pre-bound from a parent component
    const bound = scope.boundFuncs.get(imp.name);
    if (bound) {
      scope.compFuncs.push({ tag: 'boundImport', resolved: bound });
    } else {
      scope.compFuncs.push({
        tag: 'import',
        name: imp.name,
        typeIdx: imp.type.typeIndex,
      });
    }
  } else if (imp.type.tag === 'type') {
    // Type imports allocate a type index
    scope.nextTypeIdx++;
  } else if (imp.type.tag === 'instance') {
    // Instance import — check if bound from parent
    const bound = scope.boundInstances.get(imp.name);
    if (bound) {
      // Strip callbackIdx from bound instance funcs — when the child aliases from
      // this instance and lowers, it should allocate new callbacks (Rust BoundExports behavior).
      const strippedExports = new Map<string, MergedItem>();
      for (const [name, item] of bound.exports) {
        if (item.tag === 'func') {
          strippedExports.set(name, { ...item, func: { ...item.func, callbackIdx: -1 } });
        } else {
          strippedExports.set(name, item);
        }
      }
      scope.compInstances.push({
        tag: 'mergedExports',
        exports: strippedExports,
        stateIdx: bound.stateIdx,
        types: bound.types,
      });
    } else {
      // Unbound host instance import — track with type info
      const exportTypes = scope.pendingInstanceTypeExports.get(imp.type.typeIndex!) ?? new Map();
      // Extract exported value types (records, enums, etc.) for stream element size computation
      const instanceTypeEntry = imp.type.typeIndex != null ? scope.compTypes[imp.type.typeIndex] : undefined;
      let exportedValTypes: Map<string, HostValType> | undefined;
      if (instanceTypeEntry?.tag === 'instance') {
        const extracted = extractInstanceExportTypes(instanceTypeEntry.entries, scope.compTypes, scope.hostValTypes);
        if (extracted.valTypes.size > 0) {
          exportedValTypes = extracted.valTypes;
        }
      }
      scope.compInstances.push({
        tag: 'hostImport',
        importName: imp.name,
        typeIndex: imp.type.typeIndex!,
        exportTypes,
        exportedValTypes,
      });
    }
  }
}

// -----------------------------------------------------------------------
// Canonical section handling
// -----------------------------------------------------------------------

function processCanonicalSection(
  scope: ComponentScope,
  _startIndex: number,
  funcs: CanonicalFunc[],
): void {
  for (const func of funcs) {
    processCanonicalFunc(scope, func);
  }
}

function processCanonicalFunc(scope: ComponentScope, func: CanonicalFunc): void {
  switch (func.tag) {
    case 'lift': {
      const opts = extractCanonOpts(func.options);
      // Type-level async is from the function type declaration
      // Option-level async is from the canon lift (async) option
      const funcType = getFuncType(scope, func.typeIndex);
      const typeIsAsync = funcType?.isAsync ?? false;
      const isAsync = opts.isAsync || typeIsAsync;
      scope.compFuncs.push({
        tag: 'lift',
        coreFuncIdx: func.coreFuncIndex,
        callbackCoreFuncIdx: opts.callbackIdx,
        isAsync,
        hasAsyncOption: opts.isAsync,
        memoryIdx: opts.memoryIdx,
        reallocIdx: opts.reallocIdx,
        typeIdx: func.typeIndex,
      });
      break;
    }

    case 'lower': {
      const opts = extractCanonOpts(func.options);
      scope.coreFuncs.push({
        tag: 'lower',
        funcIdx: func.funcIndex,
        memoryIdx: opts.memoryIdx,
        reallocIdx: opts.reallocIdx,
        isAsync: opts.isAsync,
      });
      break;
    }

    case 'taskReturn': {
      const resultKind = classifyTaskReturn(func.result, scope.compTypes);
      emitBuiltinTrampoline(scope, { tag: 'taskReturn', resultKind, stateIdx: scope.stateIdx });
      break;
    }

    case 'contextGet':
      emitBuiltinTrampoline(scope, { tag: 'contextGet', slot: func.index, stateIdx: scope.stateIdx });
      break;

    case 'contextSet':
      emitBuiltinTrampoline(scope, { tag: 'contextSet', slot: func.index, stateIdx: scope.stateIdx });
      break;

    case 'waitableSetNew':
      emitBuiltinTrampoline(scope, { tag: 'waitableSetNew', stateIdx: scope.stateIdx });
      break;

    case 'waitableSetDrop':
      emitBuiltinTrampoline(scope, { tag: 'waitableSetDrop', stateIdx: scope.stateIdx });
      break;

    case 'waitableSetWait':
      scope.needsJSPI = true;
      emitBuiltinTrampoline(scope, {
        tag: 'waitableSetWait', memoryIdx: scope.getGlobalMemoryIdx(func.memoryIndex),
        cancellable: func.async, stateIdx: scope.stateIdx,
      });
      break;

    case 'waitableSetPoll': {
      const isCancellable = func.async;
      if (isCancellable) scope.needsJSPI = true;
      emitBuiltinTrampoline(scope, {
        tag: 'waitableSetPoll', memoryIdx: scope.getGlobalMemoryIdx(func.memoryIndex),
        cancellable: isCancellable, stateIdx: scope.stateIdx,
      });
      break;
    }

    case 'waitableJoin':
      emitBuiltinTrampoline(scope, { tag: 'waitableJoin', stateIdx: scope.stateIdx });
      break;

    case 'subtaskDrop':
      emitBuiltinTrampoline(scope, { tag: 'subtaskDrop', stateIdx: scope.stateIdx });
      break;

    case 'subtaskCancel':
      scope.needsJSPI = true;
      emitBuiltinTrampoline(scope, { tag: 'subtaskCancel', isAsync: func.async, stateIdx: scope.stateIdx });
      break;

    case 'taskCancel':
      emitBuiltinTrampoline(scope, { tag: 'taskCancel', stateIdx: scope.stateIdx });
      break;

    case 'streamNew': {
      const tableIdx = scope.getStreamTableIdx(func.typeIndex);
      emitBuiltinTrampoline(scope, { tag: 'streamNew', tableIdx, stateIdx: scope.stateIdx });
      break;
    }

    case 'streamRead': {
      const tableIdx = scope.getStreamTableIdx(func.typeIndex);
      const opts = extractCanonOpts(func.options);
      const memoryIdx = scope.getGlobalMemoryIdx(opts.memoryIdx ?? 0);
      const elemSize = scope.getStreamElemSize(func.typeIndex);
      const isResource = scope.isStreamResource(func.typeIndex);
      if (!opts.isAsync) scope.needsJSPI = true;
      // For non-scalar stream types, resolve element type and realloc for store function
      let elemHostType: import('./host-types.ts').HostValType | undefined;
      let reallocInfo: { runtimeInstanceIdx: number; exportName: string } | undefined;
      if (!isResource && elemSize > 8) {
        const hvt = scope.getStreamElemHostValType(func.typeIndex);
        if (hvt) {
          elemHostType = hvt;
          if (opts.reallocIdx != null) {
            const cf = scope.coreFuncs[opts.reallocIdx];
            if (cf) {
              try {
                const binding = resolveCoreFuncBinding(scope, cf);
                if (binding.tag === 'coreExport') {
                  reallocInfo = { runtimeInstanceIdx: binding.runtimeInstanceIdx, exportName: binding.name };
                }
              } catch (_) { /* skip store function if realloc can't be resolved */ }
            }
          }
        }
      }
      const resourceTableIdx = isResource ? scope.getStreamResourceTableIdx(func.typeIndex) : undefined;
      emitBuiltinTrampoline(scope, {
        tag: 'streamRead', tableIdx, memoryIdx, elemSize, isResource, resourceTableIdx, isAsync: opts.isAsync, stateIdx: scope.stateIdx,
        elemHostType, reallocInfo,
      });
      break;
    }

    case 'streamWrite': {
      const tableIdx = scope.getStreamTableIdx(func.typeIndex);
      const opts = extractCanonOpts(func.options);
      const memoryIdx = scope.getGlobalMemoryIdx(opts.memoryIdx ?? 0);
      const elemSize = scope.getStreamElemSize(func.typeIndex);
      const isResource = scope.isStreamResource(func.typeIndex);
      if (!opts.isAsync) scope.needsJSPI = true;
      const resourceTableIdx2 = isResource ? scope.getStreamResourceTableIdx(func.typeIndex) : undefined;
      emitBuiltinTrampoline(scope, {
        tag: 'streamWrite', tableIdx, memoryIdx, elemSize, isResource, resourceTableIdx: resourceTableIdx2, isAsync: opts.isAsync, stateIdx: scope.stateIdx,
      });
      break;
    }

    case 'streamCancelRead': {
      const tableIdx = scope.getStreamTableIdx(func.typeIndex);
      emitBuiltinTrampoline(scope, { tag: 'streamCancelRead', tableIdx, isAsync: func.async, stateIdx: scope.stateIdx });
      break;
    }

    case 'streamCancelWrite': {
      const tableIdx = scope.getStreamTableIdx(func.typeIndex);
      emitBuiltinTrampoline(scope, { tag: 'streamCancelWrite', tableIdx, isAsync: func.async, stateIdx: scope.stateIdx });
      break;
    }

    case 'streamDropReadable': {
      const tableIdx = scope.getStreamTableIdx(func.typeIndex);
      emitBuiltinTrampoline(scope, { tag: 'streamDropReadable', tableIdx, stateIdx: scope.stateIdx });
      break;
    }

    case 'streamDropWritable': {
      const tableIdx = scope.getStreamTableIdx(func.typeIndex);
      emitBuiltinTrampoline(scope, { tag: 'streamDropWritable', tableIdx, stateIdx: scope.stateIdx });
      break;
    }

    case 'futureNew': {
      const tableIdx = scope.getFutureTableIdx(func.typeIndex);
      emitBuiltinTrampoline(scope, { tag: 'futureNew', tableIdx, stateIdx: scope.stateIdx });
      break;
    }

    case 'futureRead': {
      const tableIdx = scope.getFutureTableIdx(func.typeIndex);
      const opts = extractCanonOpts(func.options);
      const memoryIdx = scope.getGlobalMemoryIdx(opts.memoryIdx ?? 0);
      const elemSize = scope.getFutureElemSize(func.typeIndex);
      if (!opts.isAsync) scope.needsJSPI = true;
      // For non-scalar future types, resolve element type and realloc for store function
      let elemHostType: import('./host-types.ts').HostValType | undefined;
      let reallocInfo: { runtimeInstanceIdx: number; exportName: string } | undefined;
      if (elemSize > 0) {
        const hvt = scope.getFutureElemHostValType(func.typeIndex);
        if (hvt) {
          elemHostType = hvt;
          if (opts.reallocIdx != null) {
            const cf = scope.coreFuncs[opts.reallocIdx];
            if (cf) {
              try {
                const binding = resolveCoreFuncBinding(scope, cf);
                if (binding.tag === 'coreExport') {
                  reallocInfo = { runtimeInstanceIdx: binding.runtimeInstanceIdx, exportName: binding.name };
                }
              } catch (_) { /* skip store function if realloc can't be resolved */ }
            }
          }
        }
      }
      emitBuiltinTrampoline(scope, {
        tag: 'futureRead', tableIdx, memoryIdx, elemSize, isAsync: opts.isAsync, stateIdx: scope.stateIdx,
        elemHostType, reallocInfo,
      });
      break;
    }

    case 'futureWrite': {
      const tableIdx = scope.getFutureTableIdx(func.typeIndex);
      const opts = extractCanonOpts(func.options);
      const memoryIdx = scope.getGlobalMemoryIdx(opts.memoryIdx ?? 0);
      const elemSize = scope.getFutureElemSize(func.typeIndex);
      if (!opts.isAsync) scope.needsJSPI = true;
      // For non-scalar future types, resolve element type and realloc for load function
      let elemHostType2: import('./host-types.ts').HostValType | undefined;
      let reallocInfo2: { runtimeInstanceIdx: number; exportName: string } | undefined;
      if (elemSize > 0) {
        const hvt = scope.getFutureElemHostValType(func.typeIndex);
        if (hvt) {
          elemHostType2 = hvt;
          if (opts.reallocIdx != null) {
            const cf = scope.coreFuncs[opts.reallocIdx];
            if (cf) {
              try {
                const binding = resolveCoreFuncBinding(scope, cf);
                if (binding.tag === 'coreExport') {
                  reallocInfo2 = { runtimeInstanceIdx: binding.runtimeInstanceIdx, exportName: binding.name };
                }
              } catch (_) { /* skip load function if realloc can't be resolved */ }
            }
          }
        }
      }
      emitBuiltinTrampoline(scope, {
        tag: 'futureWrite', tableIdx, memoryIdx, elemSize, isAsync: opts.isAsync, stateIdx: scope.stateIdx,
        elemHostType: elemHostType2, reallocInfo: reallocInfo2,
      });
      break;
    }

    case 'futureCancelRead': {
      const tableIdx = scope.getFutureTableIdx(func.typeIndex);
      emitBuiltinTrampoline(scope, { tag: 'futureCancelRead', tableIdx, isAsync: func.async, stateIdx: scope.stateIdx });
      break;
    }

    case 'futureCancelWrite': {
      const tableIdx = scope.getFutureTableIdx(func.typeIndex);
      emitBuiltinTrampoline(scope, { tag: 'futureCancelWrite', tableIdx, isAsync: func.async, stateIdx: scope.stateIdx });
      break;
    }

    case 'futureDropReadable': {
      const tableIdx = scope.getFutureTableIdx(func.typeIndex);
      emitBuiltinTrampoline(scope, { tag: 'futureDropReadable', tableIdx, stateIdx: scope.stateIdx });
      break;
    }

    case 'futureDropWritable': {
      const tableIdx = scope.getFutureTableIdx(func.typeIndex);
      emitBuiltinTrampoline(scope, { tag: 'futureDropWritable', tableIdx, stateIdx: scope.stateIdx });
      break;
    }

    case 'threadYield': {
      const isCancellable = func.async;
      scope.needsJSPI = true;
      emitBuiltinTrampoline(scope, { tag: 'threadYield', cancellable: isCancellable, stateIdx: scope.stateIdx });
      break;
    }

    case 'threadIndex':
      emitBuiltinTrampoline(scope, { tag: 'threadIndex', stateIdx: scope.stateIdx });
      break;

    case 'threadNewIndirect': {
      // Resolve the core table reference
      const tableRef = scope.coreTables[func.tableIndex];
      if (tableRef) {
        const ci = scope.coreInstances[tableRef.coreInstanceIdx];
        if (ci?.tag === 'instantiation') {
          emitBuiltinTrampoline(scope, {
            tag: 'threadNewIndirect',
            tableRuntimeInstanceIdx: ci.runtimeIdx,
            tableExportName: tableRef.name,
            stateIdx: scope.stateIdx,
          });
        } else {
          emitBuiltinTrampoline(scope, {
            tag: 'threadNewIndirect',
            tableRuntimeInstanceIdx: 0,
            tableExportName: '__indirect_function_table',
            stateIdx: scope.stateIdx,
          });
        }
      } else {
        emitBuiltinTrampoline(scope, {
          tag: 'threadNewIndirect',
          tableRuntimeInstanceIdx: 0,
          tableExportName: '__indirect_function_table',
          stateIdx: scope.stateIdx,
        });
      }
      break;
    }

    case 'threadSuspend':
      scope.needsJSPI = true;
      emitBuiltinTrampoline(scope, { tag: 'threadSuspend', stateIdx: scope.stateIdx });
      break;

    case 'threadSwitchTo':
      scope.needsJSPI = true;
      emitBuiltinTrampoline(scope, { tag: 'threadSwitchTo', stateIdx: scope.stateIdx });
      break;

    case 'threadYieldTo':
      scope.needsJSPI = true;
      emitBuiltinTrampoline(scope, { tag: 'threadYieldTo', stateIdx: scope.stateIdx });
      break;

    case 'threadSuspendTo':
      scope.needsJSPI = true;
      emitBuiltinTrampoline(scope, { tag: 'threadSuspendTo', stateIdx: scope.stateIdx });
      break;

    case 'threadResumeLater':
      scope.needsJSPI = true;
      emitBuiltinTrampoline(scope, { tag: 'threadResumeLater', stateIdx: scope.stateIdx });
      break;

    case 'resourceNew': {
      const tableIdx = scope.getResourceTableIdx(func.typeIndex);
      emitBuiltinTrampoline(scope, { tag: 'resourceNew', tableIdx, stateIdx: scope.stateIdx });
      break;
    }

    case 'resourceRep': {
      const tableIdx = scope.getResourceTableIdx(func.typeIndex);
      emitBuiltinTrampoline(scope, { tag: 'resourceRep', tableIdx, stateIdx: scope.stateIdx });
      break;
    }

    case 'resourceDrop': {
      const tableIdx = scope.getResourceTableIdx(func.typeIndex);
      // Look up the resource type to find the destructor
      let dtorInstanceIdx: number | undefined;
      let dtorExportName: string | undefined;
      const entry = scope.compTypes[func.typeIndex];
      if (entry?.tag === 'resource' && entry.resource.dtor !== null) {
        const dtorCoreFuncDef = scope.coreFuncs[entry.resource.dtor];
        if (dtorCoreFuncDef?.tag === 'alias') {
          const dtorCi = scope.coreInstances[dtorCoreFuncDef.coreInstanceIdx];
          if (dtorCi?.tag === 'instantiation') {
            dtorInstanceIdx = dtorCi.runtimeIdx;
            dtorExportName = dtorCoreFuncDef.name;
          }
        }
      }
      // Check cross-component resolved dtors (from instanceExport type aliases)
      if (dtorInstanceIdx === undefined) {
        const resolvedDtor = scope.resolvedDtors.get(func.typeIndex);
        if (resolvedDtor) {
          dtorInstanceIdx = resolvedDtor.runtimeInstanceIdx;
          dtorExportName = resolvedDtor.exportName;
        }
      }
      // Check if this resource belongs to a host import (for host destructors)
      let hostDropIface: string | undefined;
      let hostDropName: string | undefined;
      if (dtorInstanceIdx === undefined && scope.hostImportResourceTypes) {
        const targetTypeIdx = scope.resourceTypeAliasMap.get(func.typeIndex) ?? func.typeIndex;
        for (const [instanceIdx, nameMap] of scope.hostImportResourceTypes) {
          for (const [resourceName, typeIdx] of nameMap) {
            if (typeIdx === targetTypeIdx || typeIdx === func.typeIndex) {
              const ci = scope.compInstances[instanceIdx];
              if (ci?.tag === 'hostImport') {
                hostDropIface = ci.importName;
                hostDropName = `[resource-drop]${resourceName}`;
              }
              break;
            }
          }
          if (hostDropIface) break;
        }
      }
      emitBuiltinTrampoline(scope, {
        tag: 'resourceDrop', tableIdx, stateIdx: scope.stateIdx,
        dtorInstanceIdx, dtorExportName,
        hostDropIface, hostDropName,
      });
      break;
    }

    // Remaining canon ops not needed for current test coverage
  }
}

/** Emit a builtin trampoline and record the core func. */
function emitBuiltinTrampoline(scope: ComponentScope, trampoline: Trampoline): void {
  const trampolineIdx = scope.global.nextTrampoline++;
  scope.global.trampolines.push({ trampolineIdx, trampoline });
  scope.coreFuncs.push({ tag: 'trampoline', trampolineIdx });
}

// -----------------------------------------------------------------------
// Alias handling
// -----------------------------------------------------------------------

function processAlias(
  scope: ComponentScope,
  alias: { tag: string; instanceIndex?: number; name?: string; sort?: string;
    outerCount?: number; index?: number },
): void {
  switch (alias.tag) {
    case 'coreInstanceExport': {
      const sort = alias.sort as CoreSort;
      if (sort === 'func') {
        scope.coreFuncs.push({
          tag: 'alias',
          coreInstanceIdx: alias.instanceIndex!,
          name: alias.name!,
        });
      } else if (sort === 'memory') {
        const localIdx = scope.coreMemories.length;
        scope.coreMemories.push({
          coreInstanceIdx: alias.instanceIndex!,
          name: alias.name!,
        });
        scope.memoryIdxMap[localIdx] = scope.global.nextMemory++;
      } else if (sort === 'table') {
        scope.coreTables.push({
          coreInstanceIdx: alias.instanceIndex!,
          name: alias.name!,
        });
      }
      // global — not needed for current tests
      break;
    }
    case 'instanceExport': {
      const sort = alias.sort as string;
      if (sort === 'func') {
        // Check if aliasing from a host-imported instance
        const ci = scope.compInstances[alias.instanceIndex!];
        if (ci?.tag === 'hostImport') {
          scope.compFuncs.push({
            tag: 'hostInstanceExport',
            importName: ci.importName,
            exportName: alias.name!,
            typeInfo: ci.exportTypes.get(alias.name!) ?? null,
            instanceIdx: alias.instanceIndex!,
          });
        } else {
          scope.compFuncs.push({
            tag: 'aliasExport',
            compInstanceIdx: alias.instanceIndex!,
            name: alias.name!,
          });
        }
      } else if (sort === 'type') {
        // Track type alias index for resource dtor resolution
        // The alias creates a new type index — we compute it from the
        // next available slot (matching the parser's index space tracking)
        const typeIdx = scope.nextTypeIdx++;
        // Propagate type info from child instance's merged types
        const ci = scope.compInstances[alias.instanceIndex!];
        if (ci?.tag === 'mergedExports' && ci.types) {
          const mergedType = ci.types.get(alias.name!);
          if (mergedType) {
            scope.compTypes[typeIdx] = mergedType.entry;
            if (mergedType.dtor) {
              scope.resolvedDtors.set(typeIdx, mergedType.dtor);
            }
          }
        }
        // Track type aliases from host imports
        if (ci?.tag === 'hostImport') {
          if (!scope.hostImportResourceTypes) scope.hostImportResourceTypes = new Map();
          let instanceMap = scope.hostImportResourceTypes.get(alias.instanceIndex!);
          if (!instanceMap) {
            instanceMap = new Map();
            scope.hostImportResourceTypes.set(alias.instanceIndex!, instanceMap);
          }
          // If this (instance, name) pair already has a type index, record the alias
          // so that getResourceTableIdx maps both to the same resource table
          const existingTypeIdx = instanceMap.get(alias.name!);
          if (existingTypeIdx !== undefined) {
            scope.resourceTypeAliasMap.set(typeIdx, existingTypeIdx);
          }
          instanceMap.set(alias.name!, typeIdx);
          // Store HostValType for non-resource types (records, enums, etc.)
          // so stream element byte sizes can be computed correctly
          if (ci.exportedValTypes) {
            const hvt = ci.exportedValTypes.get(alias.name!);
            if (hvt) {
              scope.hostValTypes.set(typeIdx, hvt);
            }
          }
        }
      }
      break;
    }
    case 'outer':
      if ((alias.sort as string) === 'type') {
        const typeIdx = scope.nextTypeIdx++;
        // Propagate type definition from parent scope so stream/future element
        // types can be resolved for size calculations and store functions.
        if (scope.parentCompTypes && alias.index != null) {
          const parentEntry = scope.parentCompTypes[alias.index];
          if (parentEntry) {
            scope.compTypes[typeIdx] = parentEntry;
          }
        }
      }
      break;
  }
}

// -----------------------------------------------------------------------
// Core instance handling
// -----------------------------------------------------------------------

function processCoreInstance(
  scope: ComponentScope,
  index: number,
  instance: { tag: string; moduleIndex?: number;
    args?: Array<{ name: string; kind: CoreSort; index: number }>;
    exports?: Array<{ name: string; kind: CoreSort; index: number }> },
): void {
  if (instance.tag === 'fromExports') {
    scope.coreInstances[index] = {
      tag: 'fromExports',
      exports: instance.exports!,
    };
    return;
  }

  // instantiate
  const runtimeIdx = scope.global.nextRuntimeInstance++;
  scope.coreInstances[index] = { tag: 'instantiation', runtimeIdx };

  // Map local module index to global
  const localModuleIdx = instance.moduleIndex!;
  const globalModuleIdx = scope.moduleIdxMap[localModuleIdx] ?? localModuleIdx;

  const resolvedImports = resolveInstantiateImports(scope, instance.args ?? []);

  scope.global.instances.push({
    runtimeIdx,
    moduleIdx: globalModuleIdx,
    imports: resolvedImports,
  });
}

/** Resolve all import args for a core instance instantiation. */
function resolveInstantiateImports(
  scope: ComponentScope,
  args: Array<{ name: string; kind: CoreSort; index: number }>,
): Array<[string, Array<[string, ImportBinding]> | ImportBinding]> {
  const result: Array<[string, Array<[string, ImportBinding]> | ImportBinding]> = [];

  for (const arg of args) {
    // Note: the parser stores kind='func' as placeholder for core instance args
    // (binary sort 0x12 = instance). All args are core instance references.
    const ci = scope.coreInstances[arg.index];
    if (!ci) continue;

    if (ci.tag === 'fromExports') {
      // Expand bag into individual bindings
      // Sort alphabetically BEFORE resolving to ensure trampoline indices
      // are allocated in alphabetical order (matches Rust codegen output)
      const sortedExports = [...ci.exports].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const bindings: Array<[string, ImportBinding]> = [];
      for (const exp of sortedExports) {
        if (exp.kind === 'func') {
          const cf = scope.coreFuncs[exp.index];
          if (cf) {
            const binding = resolveCoreFuncBinding(scope, cf);
            bindings.push([exp.name, binding]);
          }
        } else if (exp.kind === 'memory') {
          const memRef = scope.coreMemories[exp.index];
          if (memRef) {
            const memCi = scope.coreInstances[memRef.coreInstanceIdx];
            if (memCi?.tag === 'instantiation') {
              bindings.push([exp.name, {
                tag: 'coreExport',
                runtimeInstanceIdx: memCi.runtimeIdx,
                name: memRef.name,
              }]);
            }
          }
        } else if (exp.kind === 'table') {
          const tableRef = scope.coreTables[exp.index];
          if (tableRef) {
            const tableCi = scope.coreInstances[tableRef.coreInstanceIdx];
            if (tableCi?.tag === 'instantiation') {
              bindings.push([exp.name, {
                tag: 'coreExport',
                runtimeInstanceIdx: tableCi.runtimeIdx,
                name: tableRef.name,
              }]);
            }
          }
        }
      }
      result.push([arg.name, bindings]);
    } else {
      // Real instantiation → pass whole exports object
      result.push([arg.name, {
        tag: 'instanceExports',
        runtimeInstanceIdx: ci.runtimeIdx,
      }]);
    }
  }

  // Sort import namespaces alphabetically
  result.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

  return result;
}

/** Resolve a core func def to an import binding. */
function resolveCoreFuncBinding(
  scope: ComponentScope,
  cf: CoreFuncDef,
): ImportBinding {
  switch (cf.tag) {
    case 'trampoline':
      return { tag: 'trampoline', idx: cf.trampolineIdx };

    case 'alias': {
      const ci = scope.coreInstances[cf.coreInstanceIdx];
      if (!ci) throw new Error(`core instance ${cf.coreInstanceIdx} not found`);
      if (ci.tag === 'instantiation') {
        return {
          tag: 'coreExport',
          runtimeInstanceIdx: ci.runtimeIdx,
          name: cf.name,
        };
      }
      // fromExports bag — follow the chain
      const exp = ci.exports.find(e => e.name === cf.name && e.kind === 'func');
      if (exp) {
        const innerCf = scope.coreFuncs[exp.index];
        if (innerCf) return resolveCoreFuncBinding(scope, innerCf);
      }
      throw new Error(`cannot resolve alias in fromExports bag: ${cf.name}`);
    }

    case 'lower': {
      // Resolve canon lower → look up the component func
      const compFunc = scope.compFuncs[cf.funcIdx];
      if (!compFunc) throw new Error(`comp func ${cf.funcIdx} not found`);

      if (compFunc.tag === 'import') {
        // Host import → create LowerImport trampoline
        const funcType = getFuncType(scope, compFunc.typeIdx);
        const paramCount = funcType
          ? countFlatParams(funcType, scope.compTypes)
          : 0;
        const trampolineIdx = scope.global.nextTrampoline++;
        scope.global.trampolines.push({
          trampolineIdx,
          trampoline: {
            tag: 'lowerImport',
            name: compFunc.name,
            isAsync: cf.isAsync,
            paramCount,
            stateIdx: scope.stateIdx,
          },
        });
        return { tag: 'trampoline', idx: trampolineIdx };
      }

      if (compFunc.tag === 'boundImport') {
        // Cross-component call → create AsyncAdapter trampoline
        return resolveBoundImportLower(scope, compFunc.resolved, cf.isAsync, cf.memoryIdx);
      }

      if (compFunc.tag === 'lift') {
        // Same-component export call → resolve to core export
        const innerCf = scope.coreFuncs[compFunc.coreFuncIdx];
        if (innerCf) return resolveCoreFuncBinding(scope, innerCf);
      }

      if (compFunc.tag === 'aliasExport') {
        // Follow alias chain through component instances
        const mergedFunc = resolveMergedExport(scope, compFunc.compInstanceIdx, compFunc.name);
        if (mergedFunc) {
          return resolveBoundImportLower(scope, mergedFunc, cf.isAsync, cf.memoryIdx);
        }
        throw new Error(`unsupported lower target: aliasExport (instance ${compFunc.compInstanceIdx}, name '${compFunc.name}', ci tag: ${scope.compInstances[compFunc.compInstanceIdx]?.tag ?? 'undefined'})`);
      }

      if (compFunc.tag === 'hostInstanceExport') {
        // Host instance export → create LowerHostImport trampoline
        const trampolineIdx = scope.global.nextTrampoline++;
        let lowerInfo: HostImportLowerInfo | null = null;
        if (compFunc.typeInfo) {
          // Find resource table indices for this host import instance
          const instanceResources = scope.hostImportResourceTypes?.get(compFunc.instanceIdx);
          // Collect all resource table indices (for single-resource shortcut)
          const resourceTableIndices: number[] = [];
          if (instanceResources) {
            for (const typeIdx of instanceResources.values()) {
              resourceTableIndices.push(scope.getResourceTableIdx(typeIdx));
            }
          }
          // Resolve own/borrow string types to typed forms with resource table indices
          const resolveResourceTypes = (ty: HostValType): HostValType => {
            if (ty === 'own' && resourceTableIndices.length > 0) {
              return { tag: 'own', tableIdx: resourceTableIndices[0]! };
            }
            if (ty === 'borrow' && resourceTableIndices.length > 0) {
              return { tag: 'borrow', tableIdx: resourceTableIndices[0]! };
            }
            if (typeof ty === 'object' && ty.tag === 'own' && 'name' in ty) {
              // Named resource: look up by export name in the instance's resource map
              const typeIdx = instanceResources?.get(ty.name);
              if (typeIdx !== undefined) return { tag: 'own', tableIdx: scope.getResourceTableIdx(typeIdx) };
              return { tag: 'own', tableIdx: resourceTableIndices[0]! };
            }
            if (typeof ty === 'object' && ty.tag === 'borrow' && 'name' in ty) {
              const typeIdx = instanceResources?.get(ty.name);
              if (typeIdx !== undefined) return { tag: 'borrow', tableIdx: scope.getResourceTableIdx(typeIdx) };
              return { tag: 'borrow', tableIdx: resourceTableIndices[0]! };
            }
            if (typeof ty === 'object' && ty.tag === 'own') {
              return { tag: 'own', tableIdx: scope.getResourceTableIdx(ty.tableIdx) };
            }
            if (typeof ty === 'object' && ty.tag === 'borrow') {
              return { tag: 'borrow', tableIdx: scope.getResourceTableIdx(ty.tableIdx) };
            }
            if (typeof ty === 'object' && ty.tag === 'list') {
              return { tag: 'list', elem: resolveResourceTypes(ty.elem) };
            }
            if (typeof ty === 'object' && ty.tag === 'tuple') {
              return { tag: 'tuple', elems: ty.elems.map(resolveResourceTypes) };
            }
            if (typeof ty === 'object' && ty.tag === 'option') {
              return { tag: 'option', inner: resolveResourceTypes(ty.inner) };
            }
            if (typeof ty === 'object' && ty.tag === 'result') {
              return {
                tag: 'result',
                ok: ty.ok ? resolveResourceTypes(ty.ok) : null,
                err: ty.err ? resolveResourceTypes(ty.err) : null,
              };
            }
            if (typeof ty === 'object' && ty.tag === 'record') {
              return { tag: 'record', fields: ty.fields.map(f => ({ name: f.name, type: resolveResourceTypes(f.type) })) };
            }
            if (typeof ty === 'object' && ty.tag === 'variant') {
              return { tag: 'variant', cases: ty.cases.map(c => ({ name: c.name, type: c.type ? resolveResourceTypes(c.type) : null })) };
            }
            if (typeof ty === 'object' && ty.tag === 'future') {
              return { tag: 'future', elem: ty.elem ? resolveResourceTypes(ty.elem) : null };
            }
            if (typeof ty === 'object' && ty.tag === 'stream') {
              return { tag: 'stream', elem: ty.elem ? resolveResourceTypes(ty.elem) : null };
            }
            return ty;
          };
          const paramTypes = compFunc.typeInfo.paramTypes.map(resolveResourceTypes);
          const resultType = compFunc.typeInfo.resultType
            ? resolveResourceTypes(compFunc.typeInfo.resultType) : null;
          const paramFlat = paramTypes.flatMap(flattenHostValType);
          const resultFlat = resultType ? flattenHostValType(resultType) : [];
          const globalMemIdx = cf.memoryIdx != null ? scope.getGlobalMemoryIdx(cf.memoryIdx) : null;
          // Resolve realloc if present
          let realloc: { runtimeInstanceIdx: number; exportName: string } | null = null;
          if (cf.reallocIdx != null) {
            const reallocBinding = resolveCoreFuncBinding(scope, scope.coreFuncs[cf.reallocIdx]!);
            if (reallocBinding.tag === 'coreExport') {
              realloc = { runtimeInstanceIdx: reallocBinding.runtimeInstanceIdx, exportName: reallocBinding.name };
            }
          }
          lowerInfo = {
            paramTypes,
            resultType,
            paramFlatTypes: paramFlat,
            resultFlatTypes: resultFlat,
            memoryIdx: globalMemIdx,
            realloc,
          };
        }
        scope.global.trampolines.push({
          trampolineIdx,
          trampoline: {
            tag: 'lowerHostImport',
            importName: compFunc.importName,
            exportName: compFunc.exportName,
            isAsync: cf.isAsync,
            stateIdx: scope.stateIdx,
            lowerInfo,
          },
        });
        return { tag: 'trampoline', idx: trampolineIdx };
      }

      throw new Error(`unsupported lower target: ${compFunc.tag}`);
    }
  }
}

/** Resolve a canon lower that targets a bound import (cross-component call). */
function resolveBoundImportLower(
  scope: ComponentScope,
  resolved: ResolvedFunc,
  callerIsAsync: boolean,
  callerMemoryIdx: number | null,
): ImportBinding {
  // Sync-caller asyncAdapters use suspending(), marking this scope as needing JSPI
  if (!callerIsAsync) {
    scope.needsJSPI = true;
  }

  const trampolineIdx = scope.global.nextTrampoline++;

  // Determine callback for the callee:
  // - If callbackIdx >= 0, it came from a MergedExport (already allocated at lift time) → reuse
  // - If callbackIdx === -1 but callback info exists, it came from BoundImport/Resolved → allocate new
  let calleeCallbackIdx: number | null = null;
  if (resolved.callbackIdx >= 0) {
    calleeCallbackIdx = resolved.callbackIdx;
  } else if (resolved.callback) {
    calleeCallbackIdx = scope.global.nextCallback++;
    scope.global.callbacks.push({
      callbackIdx: calleeCallbackIdx,
      runtimeInstanceIdx: resolved.callback.runtimeInstanceIdx,
      exportName: resolved.callback.exportName,
    });
  }

  // Determine result handling
  // -1 = no retptr needed
  // -2 = retptr (results written to caller's memory via returnFn)
  const resultFlatCount = resolved.resultFlatTypes.length;
  let resultCountOrAsync: number;
  if (resultFlatCount > 0 && callerMemoryIdx !== null) {
    // Caller has memory and there are results → always use retptr
    resultCountOrAsync = -2;
  } else if (callerIsAsync && resultFlatCount > 0) {
    // Async caller with results → retptr
    resultCountOrAsync = -2;
  } else {
    resultCountOrAsync = -1;
  }

  // Build startFn and returnFn
  const startFn = buildStartFn(scope, resolved, callerIsAsync, callerMemoryIdx);
  const returnFn = buildReturnFn(scope, resolved, resultCountOrAsync, callerMemoryIdx);

  scope.global.trampolines.push({
    trampolineIdx,
    trampoline: {
      tag: 'asyncAdapter',
      callerStateIdx: scope.stateIdx,
      calleeStateIdx: resolved.stateIdx,
      callee: resolved.callee,
      calleeCallbackIdx,
      callerIsAsync,
      calleeIsAsync: resolved.isAsync,
      calleeNeedsJSPI: resolved.needsJSPI,
      startFn,
      returnFn,
      resultCountOrAsync,
    },
  });

  return { tag: 'trampoline', idx: trampolineIdx };
}

/** Build startFn for parameter transfers (null if no transforms needed). */
function buildStartFn(scope: ComponentScope, resolved: ResolvedFunc, callerIsAsync: boolean, callerMemoryIdx: number | null): StartFn {
  const info = resolved.transfers;
  const transfers: import('./link-types.ts').ParamTransfer[] = [];

  // Use pre-resolved transfer info (avoids cross-scope type lookups)
  if (info.paramStreamTransfers) {
    for (const t of info.paramStreamTransfers) {
      transfers.push({
        paramIdx: t.paramFlatIdx,
        kind: {
          tag: 'streamEnd',
          tableIdx: t.tableIdx,
          fromStateIdx: scope.stateIdx,
          toStateIdx: resolved.stateIdx,
        },
      });
    }
  }
  if (info.paramFutureTransfers) {
    for (const t of info.paramFutureTransfers) {
      transfers.push({
        paramIdx: t.paramFlatIdx,
        kind: {
          tag: 'futureEnd',
          tableIdx: t.tableIdx,
          fromStateIdx: scope.stateIdx,
          toStateIdx: resolved.stateIdx,
        },
      });
    }
  }
  if (info.paramResourceTransfers) {
    for (const t of info.paramResourceTransfers) {
      if (t.kind === 'own') {
        transfers.push({
          paramIdx: t.paramFlatIdx,
          kind: {
            tag: 'resourceRep',
            fromStateIdx: scope.stateIdx,
          },
        });
      } else if (t.kind === 'borrow') {
        if (t.calleeDefinesResource && !callerIsAsync) {
          // Sync adapter calling the defining component: just extract the rep
          transfers.push({
            paramIdx: t.paramFlatIdx,
            kind: {
              tag: 'resourceRep',
              fromStateIdx: scope.stateIdx,
            },
          });
        } else {
          // Async adapter or callee doesn't define the resource: create borrow handle
          transfers.push({
            paramIdx: t.paramFlatIdx,
            kind: {
              tag: 'borrowHandle',
              fromStateIdx: scope.stateIdx,
              toStateIdx: resolved.stateIdx,
            },
          });
        }
      }
    }
  }

  if (transfers.length > 0) {
    return { tag: 'handleTransfer', transfers };
  }

  // Check if params need memory-based passing
  // For async lower: MAX_FLAT = 4; for sync lower: MAX_FLAT = 16
  const maxFlatForCaller = callerIsAsync ? 4 : MAX_FLAT_PARAMS;
  if (resolved.paramFlatTypes.length > maxFlatForCaller &&
      callerMemoryIdx !== null) {
    const globalCallerMemIdx = scope.getGlobalMemoryIdx(callerMemoryIdx);
    const reads = buildFlatReads(resolved.paramFlatTypes);

    // If callee also needs memory-based params (> MAX_FLAT_PARAMS), include realloc
    if (resolved.paramFlatTypes.length > MAX_FLAT_PARAMS &&
        resolved.calleeMemoryIdx !== undefined &&
        resolved.calleeRealloc !== undefined) {
      const { totalSize, maxAlign } = computeAlignedLayout(resolved.paramFlatTypes);
      return {
        tag: 'memoryRead',
        memoryIdx: globalCallerMemIdx,
        reads,
        realloc: {
          runtimeInstanceIdx: resolved.calleeRealloc.runtimeInstanceIdx,
          exportName: resolved.calleeRealloc.exportName,
          dstMemoryIdx: resolved.calleeMemoryIdx,
          alignment: maxAlign,
          byteSize: totalSize,
        },
      };
    }

    // Caller's memory → read flat values, pass as flat args to callee
    return {
      tag: 'memoryRead',
      memoryIdx: globalCallerMemIdx,
      reads,
    };
  }

  return null;
}

/** Build returnFn for result transforms. */
function buildReturnFn(
  scope: ComponentScope,
  resolved: ResolvedFunc,
  resultCountOrAsync: number,
  callerMemoryIdx: number | null,
): ReturnFn {
  if (resultCountOrAsync >= 0) {
    // No retptr needed → no returnFn
    return null;
  }
  if (resolved.resultFlatTypes.length === 0) {
    return null;
  }

  const info = resolved.transfers;

  // Build pre-transfer if stream/future/resource result transfer is needed
  let preTransfer: ReturnFn = null;
  if (info.resultStreamTransfer) {
    preTransfer = {
      tag: 'streamTransfer',
      tableIdx: info.resultStreamTransfer.tableIdx,
      fromStateIdx: resolved.stateIdx,
      toStateIdx: scope.stateIdx,
    };
  } else if (info.resultFutureTransfer) {
    preTransfer = {
      tag: 'futureTransfer',
      tableIdx: info.resultFutureTransfer.tableIdx,
      fromStateIdx: resolved.stateIdx,
      toStateIdx: scope.stateIdx,
    };
  } else if (info.resultResourceTransfer) {
    preTransfer = {
      tag: 'resourceTransfer',
      fromStateIdx: resolved.stateIdx,
      toStateIdx: scope.stateIdx,
    };
  }

  // If there's a transfer but no retptr needed, return just the transfer
  if (preTransfer && resultCountOrAsync !== -2) {
    return preTransfer;
  }

  // For -2 (retptr), generate memory writes
  if (resultCountOrAsync === -2 && callerMemoryIdx !== null) {
    const globalCallerMemIdx = scope.getGlobalMemoryIdx(callerMemoryIdx);

    // Check if callee stores results in memory (retptr on callee side)
    // This happens when callee has > MAX_FLAT_RESULTS result types AND has memory
    const calleeHasRetptr = resolved.resultFlatTypes.length > MAX_FLAT_RESULTS &&
                            resolved.calleeMemoryIdx !== undefined;

    if (calleeHasRetptr) {
      // Memory copy: callee stored results in its memory, copy to caller memory
      // When callee is async (has callback), result comes as array → (result as unknown[])[0]
      // When callee is sync, result is the pointer directly → result as number
      const copies = buildFlatCopies(resolved.resultFlatTypes);
      const memoryCopyFn: ReturnFn = {
        tag: 'memoryCopy',
        srcMemoryIdx: resolved.calleeMemoryIdx!,
        dstMemoryIdx: globalCallerMemIdx,
        copies,
        resultIsArray: resolved.hasAsyncOption,
      };
      if (preTransfer) {
        return { tag: 'typedWithTransfer', memoryIdx: globalCallerMemIdx, writes: buildFlatWrites(resolved.resultFlatTypes), preTransfer };
      }
      return memoryCopyFn;
    } else {
      // Typed write: callee returned flat values, write to caller memory
      const writes = buildFlatWrites(resolved.resultFlatTypes);
      if (preTransfer) {
        return { tag: 'typedWithTransfer', memoryIdx: globalCallerMemIdx, writes, preTransfer };
      }
      return { tag: 'typed', memoryIdx: globalCallerMemIdx, writes };
    }
  }

  return null;
}

/** Build FlatWrite[] from flat result types with proper alignment. */
function buildFlatWrites(flatTypes: FlatValType[]): import('./link-types.ts').FlatWrite[] {
  const { offsets } = computeAlignedLayout(flatTypes);
  const writes: import('./link-types.ts').FlatWrite[] = [];
  for (let i = 0; i < flatTypes.length; i++) {
    const ft = flatTypes[i]!;
    const { setter, cast } = flatTypeInfo(ft);
    writes.push({
      offset: offsets[i]!,
      setter,
      cast,
      isArray: flatTypes.length > 1,
      arrayIdx: flatTypes.length > 1 ? i : undefined,
    });
  }
  return writes;
}

/** Build FlatCopy[] for memoryCopy returnFn (callee mem → caller mem). */
function buildFlatCopies(flatTypes: FlatValType[]): import('./link-types.ts').FlatCopy[] {
  const { offsets } = computeAlignedLayout(flatTypes);
  const copies: import('./link-types.ts').FlatCopy[] = [];
  for (let i = 0; i < flatTypes.length; i++) {
    const ft = flatTypes[i]!;
    const { getter, setter, cast } = flatTypeInfo(ft);
    copies.push({
      offset: offsets[i]!,
      getter,
      setter,
      cast,
    });
  }
  return copies;
}

/** Build FlatRead[] for memoryRead startFn (caller mem → callee mem via realloc). */
function buildFlatReads(flatTypes: FlatValType[]): import('./link-types.ts').FlatRead[] {
  const { offsets } = computeAlignedLayout(flatTypes);
  const reads: import('./link-types.ts').FlatRead[] = [];
  for (let i = 0; i < flatTypes.length; i++) {
    const ft = flatTypes[i]!;
    const { getter } = flatTypeInfo(ft);
    reads.push({
      offset: offsets[i]!,
      getter,
      flatType: ft,
    });
  }
  return reads;
}

function flatTypeInfo(ft: FlatValType): { getter: string; setter: string; cast: string; size: number; align: number } {
  switch (ft) {
    case 'i32': return { getter: 'getInt32', setter: 'setInt32', cast: 'as number', size: 4, align: 4 };
    case 'i64': return { getter: 'getBigInt64', setter: 'setBigInt64', cast: 'as bigint', size: 8, align: 8 };
    case 'f32': return { getter: 'getFloat32', setter: 'setFloat32', cast: 'as number', size: 4, align: 4 };
    case 'f64': return { getter: 'getFloat64', setter: 'setFloat64', cast: 'as number', size: 8, align: 8 };
  }
}

/** Compute aligned offset for a flat type. */
function alignUp(offset: number, align: number): number {
  return (offset + align - 1) & ~(align - 1);
}

/** Compute aligned offsets for a sequence of flat types. Returns { offsets, totalSize, maxAlign }. */
function computeAlignedLayout(flatTypes: FlatValType[]): { offsets: number[]; totalSize: number; maxAlign: number } {
  let offset = 0;
  let maxAlign = 1;
  const offsets: number[] = [];
  for (const ft of flatTypes) {
    const info = flatTypeInfo(ft);
    offset = alignUp(offset, info.align);
    offsets.push(offset);
    offset += info.size;
    if (info.align > maxAlign) maxAlign = info.align;
  }
  // totalSize is just the final offset (not rounded up to maxAlign)
  return { offsets, totalSize: offset, maxAlign };
}

/** Resolve a merged export from a component instance. */
function resolveMergedExport(
  scope: ComponentScope,
  compInstanceIdx: number,
  name: string,
): ResolvedFunc | null {
  const ci = scope.compInstances[compInstanceIdx];
  if (!ci) return null;
  if (ci.tag === 'mergedExports') {
    const item = ci.exports.get(name);
    if (item?.tag === 'func') {
      return {
        callee: item.calleeRef,
        isAsync: item.func.isAsync,
        hasAsyncOption: item.hasAsyncOption,
        needsJSPI: item.needsJSPI,
        stateIdx: item.func.stateIdx,
        callback: item.callbackInfo,
        callbackIdx: item.func.callbackIdx,
        paramFlatTypes: item.paramFlatTypes,
        resultFlatTypes: item.resultFlatTypes,
        funcType: item.funcType,
        transfers: item.transfers,
        calleeMemoryIdx: item.calleeMemoryIdx,
        calleeRealloc: item.calleeRealloc,
      };
    }
  }

  // Handle fromExports: look up the comp func by name in the exports
  if (ci.tag === 'fromExports') {
    const exp = ci.exports.find((e: { name: string; sort: string; index: number }) => e.name === name && e.sort === 'func');
    if (exp) {
      return resolveCompFuncForBinding(scope, exp.index);
    }
  }

  // Handle simple instantiation: use shim mapping to trace through
  if (ci.tag === 'instantiation') {
    const mapping = parseNestedComponentExports(scope, ci.componentIdx);
    const importName = mapping.get(name);
    if (importName) {
      const arg = ci.args.find((a: { name: string }) => a.name === importName);
      if (arg && arg.sort === 'func') {
        return resolveCompFuncForBinding(scope, arg.index);
      }
    }
  }

  return null;
}

/** Find callback extraction info by callback index. */
function findCallbackInfo(
  scope: ComponentScope,
  callbackIdx: number,
): { runtimeInstanceIdx: number; exportName: string } | undefined {
  for (const cb of scope.global.callbacks) {
    if (cb.callbackIdx === callbackIdx) {
      return { runtimeInstanceIdx: cb.runtimeInstanceIdx, exportName: cb.exportName };
    }
  }
  return undefined;
}

// -----------------------------------------------------------------------
// Component instance handling
// -----------------------------------------------------------------------

function processComponentInstance(
  scope: ComponentScope,
  index: number,
  instance: { tag: string; componentIndex?: number;
    args?: Array<{ name: string; sort: string; index: number }>;
    exports?: Array<{ name: string; sort: string; index: number }> },
): void {
  if (instance.tag === 'fromExports') {
    scope.compInstances[index] = {
      tag: 'fromExports',
      exports: instance.exports ?? [],
    };
    return;
  }

  // instantiate nested component
  const compIdx = instance.componentIndex!;
  const compBytes = scope.components[compIdx];
  if (!compBytes) {
    // Fallback: record as simple instantiation
    scope.compInstances[index] = {
      tag: 'instantiation',
      componentIdx: compIdx,
      args: instance.args ?? [],
    };
    return;
  }

  // Parse the nested component
  const childParsed = parseComponent(compBytes);

  // Check if this is a "shim" component (just imports/exports, no core content)
  // Shim components don't need their own state — they're just name mappers
  if (!needsOwnState(childParsed)) {
    scope.compInstances[index] = {
      tag: 'instantiation',
      componentIdx: compIdx,
      args: instance.args ?? [],
    };
    return;
  }

  // Full nested component — assign new state
  const childStateIdx = scope.global.nextStateIdx++;
  scope.global.stateRelationships.push({ child: childStateIdx, parent: scope.stateIdx });

  // Build bound funcs and instances from args
  const boundFuncs = new Map<string, ResolvedFunc>();
  const boundInstances = new Map<string, { exports: Map<string, MergedItem>; stateIdx: number; types?: Map<string, MergedType> }>();
  for (const arg of instance.args ?? []) {
    if (arg.sort === 'func') {
      const resolved = resolveCompFuncForBinding(scope, arg.index);
      if (resolved) {
        boundFuncs.set(arg.name, resolved);
      }
    } else if (arg.sort === 'instance') {
      const ci = scope.compInstances[arg.index];
      if (ci?.tag === 'mergedExports') {
        boundInstances.set(arg.name, { exports: ci.exports, stateIdx: ci.stateIdx, types: ci.types });
      }
    }
  }

  // Resolve nested component with its own scope
  // Skip export sections — they only contribute to merged exports, not global
  const childScope = new ComponentScope(scope.global, childStateIdx);
  childScope.boundFuncs = boundFuncs;
  childScope.boundInstances = boundInstances;
  childScope.parentCompTypes = scope.compTypes;

  for (const section of childParsed.sections) {
    if (section.tag === 'export') {
      // Process type exports during first pass to advance nextTypeIdx
      // and propagate localResourceTypes (func/instance exports handled below)
      if (section.export.sort === 'type') {
        processExport(childScope, section.export);
      }
      continue;
    }
    processSection(childScope, section);
  }

  // Emit memory extractions for child
  emitMemoryExtractions(childScope);

  // Build merged exports from child's export sections
  const mergedExports = new Map<string, MergedItem>();
  const mergedTypes = new Map<string, MergedType>();
  for (const section of childParsed.sections) {
    if (section.tag === 'export' && section.export.sort === 'func') {
      const liftInfo = resolveLiftedFuncWithType(childScope, section.export.index);
      if (liftInfo) {
        liftInfo.func.name = section.export.name;
        mergedExports.set(section.export.name, {
          tag: 'func',
          func: liftInfo.func,
          calleeRef: liftInfo.calleeRef,
          resultFlatTypes: liftInfo.resultFlatTypes,
          paramFlatTypes: liftInfo.paramFlatTypes,
          funcType: liftInfo.funcType,
          hasAsyncOption: liftInfo.hasAsyncOption,
          needsJSPI: childScope.needsJSPI,
          transfers: liftInfo.transfers,
          calleeMemoryIdx: liftInfo.calleeMemoryIdx,
          calleeRealloc: liftInfo.calleeRealloc,
          callbackInfo: liftInfo.callbackInfo,
        });
      }
    } else if (section.tag === 'export' && section.export.sort === 'type') {
      // Track exported type — resolve resource destructors
      const typeIdx = section.export.index;
      const entry = childScope.compTypes[typeIdx];
      if (entry) {
        const merged: MergedType = { entry };
        if (entry.tag === 'resource' && entry.resource.dtor !== null) {
          const dtorCoreFuncDef = childScope.coreFuncs[entry.resource.dtor];
          if (dtorCoreFuncDef?.tag === 'alias') {
            const dtorCi = childScope.coreInstances[dtorCoreFuncDef.coreInstanceIdx];
            if (dtorCi?.tag === 'instantiation') {
              merged.dtor = { runtimeInstanceIdx: dtorCi.runtimeIdx, exportName: dtorCoreFuncDef.name };
            }
          }
        }
        mergedTypes.set(section.export.name, merged);
      }
    }
  }

  scope.compInstances[index] = {
    tag: 'mergedExports',
    exports: mergedExports,
    stateIdx: childStateIdx,
    types: mergedTypes,
  };
}

/** Shared lift resolution: resolve a canon-lifted func to its core parts. */
interface ResolvedLiftCore {
  calleeRef: CalleeRef;
  runtimeInstanceIdx: number;
  coreExportName: string;
  callbackInfo?: { runtimeInstanceIdx: number; exportName: string };
  funcType: ComponentFuncType | null;
  paramFlatTypes: FlatValType[];
  resultFlatTypes: FlatValType[];
  transfers: TransferInfo;
  calleeMemoryIdx?: number;
  calleeRealloc?: { runtimeInstanceIdx: number; exportName: string };
}

/** Convert a ComponentValType to HostValType using the scope's compTypes array. */
function convertCompValType(
  vt: ComponentValType,
  compTypes: ComponentTypeEntry[],
): HostValType {
  if (vt.tag === 'primitive') return vt.type as HostValType;
  const entry = compTypes[vt.index];
  if (!entry) return 'u32';
  if (entry.tag === 'defined') return convertDefinedToHostValType(entry.type, compTypes);
  if (entry.tag === 'resource') return 'own';
  return 'u32';
}

function convertDefinedToHostValType(
  dt: import('../parser/types.ts').DefinedType,
  compTypes: ComponentTypeEntry[],
): HostValType {
  switch (dt.tag) {
    case 'primitive': return dt.type as HostValType;
    case 'record':
      return { tag: 'record', fields: dt.fields.map(f => ({ name: f.name, type: convertCompValType(f.type, compTypes) })) };
    case 'variant':
      return { tag: 'variant', cases: dt.cases.map(c => ({ name: c.name, type: c.type ? convertCompValType(c.type, compTypes) : null })) };
    case 'list':
      return { tag: 'list', elem: convertCompValType(dt.elementType, compTypes) };
    case 'tuple':
      return { tag: 'tuple', elems: dt.types.map(t => convertCompValType(t, compTypes)) };
    case 'flags':
      return { tag: 'flags', count: dt.names.length };
    case 'enum':
      return { tag: 'enum', names: dt.names };
    case 'option':
      return { tag: 'option', inner: convertCompValType(dt.type, compTypes) };
    case 'result':
      return { tag: 'result', ok: dt.ok ? convertCompValType(dt.ok, compTypes) : null, err: dt.err ? convertCompValType(dt.err, compTypes) : null };
    case 'own':
      return { tag: 'own', tableIdx: dt.typeIndex };
    case 'borrow':
      return { tag: 'borrow', tableIdx: dt.typeIndex };
    case 'future':
      return dt.type ? { tag: 'future', elem: convertCompValType(dt.type, compTypes) } : 'future';
    case 'stream':
      return dt.type ? { tag: 'stream', elem: convertCompValType(dt.type, compTypes) } : 'stream';
    case 'errorContext':
      return 'u32';
  }
}

function resolveLiftCore(
  scope: ComponentScope,
  cf: CompFuncDef & { tag: 'lift' },
): ResolvedLiftCore | null {
  const coreFuncDef = scope.coreFuncs[cf.coreFuncIdx];
  if (!coreFuncDef) return null;

  let calleeRef: CalleeRef;
  let runtimeInstanceIdx: number;
  let coreExportName: string;

  if (coreFuncDef.tag === 'alias') {
    const ci = scope.coreInstances[coreFuncDef.coreInstanceIdx];
    if (!ci || ci.tag !== 'instantiation') return null;
    runtimeInstanceIdx = ci.runtimeIdx;
    coreExportName = coreFuncDef.name;
    calleeRef = { tag: 'coreExport', runtimeInstanceIdx, exportName: coreExportName };
  } else if (coreFuncDef.tag === 'trampoline') {
    runtimeInstanceIdx = -1;
    coreExportName = '';
    calleeRef = { tag: 'trampoline', trampolineIdx: coreFuncDef.trampolineIdx };
  } else {
    return null;
  }

  // Resolve callback info
  let callbackInfo: { runtimeInstanceIdx: number; exportName: string } | undefined;
  if (cf.callbackCoreFuncIdx !== null) {
    const cbDef = scope.coreFuncs[cf.callbackCoreFuncIdx];
    if (cbDef?.tag === 'alias') {
      const cbInstance = scope.coreInstances[cbDef.coreInstanceIdx];
      if (cbInstance?.tag === 'instantiation') {
        callbackInfo = { runtimeInstanceIdx: cbInstance.runtimeIdx, exportName: cbDef.name };
      }
    }
  }

  const funcType = getFuncType(scope, cf.typeIdx);
  const resultFlatTypes = funcType?.result
    ? flattenType(funcType.result, scope.compTypes) : [];
  const paramFlatTypes = funcType
    ? funcType.params.flatMap(p => flattenType(p.type, scope.compTypes)) : [];

  let calleeMemoryIdx: number | undefined;
  let calleeRealloc: { runtimeInstanceIdx: number; exportName: string } | undefined;
  if (cf.memoryIdx !== null) {
    calleeMemoryIdx = scope.getGlobalMemoryIdx(cf.memoryIdx);
  }
  if (cf.reallocIdx !== null) {
    const reallocDef = scope.coreFuncs[cf.reallocIdx];
    if (reallocDef?.tag === 'alias') {
      const ri = scope.coreInstances[reallocDef.coreInstanceIdx];
      if (ri?.tag === 'instantiation') {
        calleeRealloc = { runtimeInstanceIdx: ri.runtimeIdx, exportName: reallocDef.name };
      }
    }
  }

  return {
    calleeRef, runtimeInstanceIdx, coreExportName, callbackInfo,
    funcType, paramFlatTypes, resultFlatTypes,
    transfers: buildTransferInfo(scope, funcType),
    calleeMemoryIdx, calleeRealloc,
  };
}

/** Resolve a component func to a ResolvedFunc for parent→child binding. */
function resolveCompFuncForBinding(
  scope: ComponentScope,
  funcIdx: number,
): ResolvedFunc | null {
  const cf = scope.compFuncs[funcIdx];
  if (!cf) return null;

  if (cf.tag === 'lift') {
    const core = resolveLiftCore(scope, cf);
    if (!core) return null;
    return {
      callee: core.calleeRef,
      isAsync: cf.isAsync,
      hasAsyncOption: cf.hasAsyncOption,
      needsJSPI: scope.needsJSPI,
      stateIdx: scope.stateIdx,
      callback: core.callbackInfo,
      callbackIdx: -1, // BoundImport path: resolveBoundImportLower will allocate new
      paramFlatTypes: core.paramFlatTypes,
      resultFlatTypes: core.resultFlatTypes,
      funcType: core.funcType,
      transfers: core.transfers,
      calleeMemoryIdx: core.calleeMemoryIdx,
      calleeRealloc: core.calleeRealloc,
    };
  }

  if (cf.tag === 'aliasExport') {
    const resolved = resolveMergedExport(scope, cf.compInstanceIdx, cf.name);
    if (resolved) {
      return { ...resolved, callbackIdx: -1 };
    }
    return null;
  }

  if (cf.tag === 'boundImport') {
    return cf.resolved;
  }

  return null;
}

// -----------------------------------------------------------------------
// Export handling
// -----------------------------------------------------------------------

function processExport(
  scope: ComponentScope,
  exp: { name: string; sort: string; index: number },
): void {
  if (exp.sort === 'instance') {
    // Export is an instance — trace through component instance
    const compInst = scope.compInstances[exp.index];
    if (!compInst) return;

    // Exports create a new alias in the instance index space
    const newIdx = scope.compInstances.length;
    scope.compInstances[newIdx] = compInst;

    if (compInst.tag === 'mergedExports') {
      // New path: merged exports from nested component
      const funcMap = new Map<string, ExportedFunc>();
      for (const [exportName, item] of compInst.exports) {
        if (item.tag === 'func') {
          const clone = { ...item.func, name: exportName };
          funcMap.set(exportName, clone);
        }
      }
      scope.global.resolvedExports.set(exp.name, funcMap);
      return;
    }

    if (compInst.tag === 'instantiation') {
      // Legacy path: parse nested component exports
      const mapping = parseNestedComponentExports(scope, compInst.componentIdx);
      const funcMap = new Map<string, ExportedFunc>();

      for (const [exportName, importName] of mapping) {
        const arg = compInst.args.find(a => a.name === importName);
        if (arg && arg.sort === 'func') {
          const funcInfo = resolveLiftedFunc(scope, arg.index);
          if (funcInfo) {
            funcInfo.name = exportName;
            funcMap.set(exportName, funcInfo);
          }
        }
      }

      scope.global.resolvedExports.set(exp.name, funcMap);
    }
  } else if (exp.sort === 'func') {
    // Direct func export
    const funcInfo = resolveLiftedFunc(scope, exp.index);
    if (funcInfo) {
      funcInfo.name = exp.name;
      const funcMap = new Map<string, ExportedFunc>();
      funcMap.set(exp.name, funcInfo);
      scope.global.resolvedExports.set(exp.name, funcMap);
    }
  } else if (exp.sort === 'type') {
    // Type export creates a new type index aliasing the exported type
    const newTypeIdx = scope.nextTypeIdx++;
    const originalEntry = scope.compTypes[exp.index];
    if (originalEntry) {
      scope.compTypes[newTypeIdx] = originalEntry;
      // Propagate local resource status
      if (scope.localResourceTypes.has(exp.index)) {
        scope.localResourceTypes.add(newTypeIdx);
      }
    }
  }
}

interface LiftedFuncWithType {
  func: ExportedFunc;
  calleeRef: CalleeRef;
  resultFlatTypes: FlatValType[];
  paramFlatTypes: FlatValType[];
  funcType: ComponentFuncType | null;
  hasAsyncOption: boolean;
  transfers: TransferInfo;
  calleeMemoryIdx?: number;
  calleeRealloc?: { runtimeInstanceIdx: number; exportName: string };
  /** Raw callback info — NOT yet allocated as an extractCallback action. */
  callbackInfo?: { runtimeInstanceIdx: number; exportName: string };
}

/** Resolve a component func (expected to be a Lift) to ExportedFunc info with type. */
function resolveLiftedFuncWithType(
  scope: ComponentScope,
  funcIdx: number,
): LiftedFuncWithType | null {
  const cf = scope.compFuncs[funcIdx];
  if (!cf || cf.tag !== 'lift') return null;

  const core = resolveLiftCore(scope, cf);
  if (!core) return null;

  // Allocate callback at lift time (Rust codegen does the same)
  let callbackIdx = -1;
  if (core.callbackInfo) {
    callbackIdx = scope.global.nextCallback++;
    scope.global.callbacks.push({
      callbackIdx,
      runtimeInstanceIdx: core.callbackInfo.runtimeInstanceIdx,
      exportName: core.callbackInfo.exportName,
    });
  }

  // Determine if the export result needs lifting (future/stream end)
  let liftResult: import('./link-types.ts').ExportLiftResult | undefined;
  if (core.transfers.resultFutureTransfer) {
    liftResult = { tag: 'liftFutureEnd', tableIdx: core.transfers.resultFutureTransfer.tableIdx };
  } else if (core.transfers.resultStreamTransfer) {
    liftResult = { tag: 'liftStreamEnd', tableIdx: core.transfers.resultStreamTransfer.tableIdx };
  }

  // Build ExportLiftInfo when we have function type info
  let liftInfo: ExportLiftInfo | undefined;
  if (core.funcType) {
    const paramNames = core.funcType.params.map(p => p.name);
    const paramTypes = core.funcType.params.map(p => convertCompValType(p.type, scope.compTypes));
    const resultType = core.funcType.result ? convertCompValType(core.funcType.result, scope.compTypes) : null;
    liftInfo = {
      paramNames,
      paramTypes,
      resultType,
      paramFlatTypes: core.paramFlatTypes,
      resultFlatTypes: core.resultFlatTypes,
      memoryIdx: core.calleeMemoryIdx ?? null,
      realloc: core.calleeRealloc ?? null,
    };
  }

  return {
    func: {
      name: '', // set by caller
      runtimeInstanceIdx: core.runtimeInstanceIdx,
      coreExportName: core.coreExportName,
      callbackIdx,
      isAsync: cf.isAsync,
      stateIdx: scope.stateIdx,
      liftResult,
      liftInfo,
    },
    calleeRef: core.calleeRef,
    resultFlatTypes: core.resultFlatTypes,
    paramFlatTypes: core.paramFlatTypes,
    funcType: core.funcType,
    hasAsyncOption: cf.hasAsyncOption,
    transfers: core.transfers,
    calleeMemoryIdx: core.calleeMemoryIdx,
    calleeRealloc: core.calleeRealloc,
    callbackInfo: core.callbackInfo,
  };
}

/** Resolve a component func (expected to be a Lift) to ExportedFunc info. */
function resolveLiftedFunc(
  scope: ComponentScope,
  funcIdx: number,
): ExportedFunc | null {
  const info = resolveLiftedFuncWithType(scope, funcIdx);
  if (info) return info.func;

  // If not a direct lift, try aliasExport chain
  const cf = scope.compFuncs[funcIdx];
  if (cf?.tag === 'aliasExport') {
    const ci = scope.compInstances[cf.compInstanceIdx];
    if (ci?.tag === 'mergedExports') {
      const item = ci.exports.get(cf.name);
      if (item?.tag === 'func') {
        return { ...item.func };
      }
    }
  }

  return null;
}

/**
 * Parse a nested component (shim) to extract the export→import name mapping.
 *
 * The shim pattern:
 *   (component $shim
 *     (import "import-func-run" (func ...))
 *     (export "run" (func 0) ...)
 *   )
 *
 * Returns Map<exportName, importName>, e.g. "run" → "import-func-run".
 */
function parseNestedComponentExports(
  scope: ComponentScope,
  componentIdx: number,
): Map<string, string> {
  const bytes = scope.components[componentIdx];
  if (!bytes) return new Map();

  const parsed = parseComponent(bytes);

  // Collect func import names in func index order.
  // Only func imports populate the component func index space — type and
  // instance imports go into their own index spaces.
  const funcImportNames: string[] = [];
  for (const section of parsed.sections) {
    if (section.tag === 'import' && section.import.type.tag === 'func') {
      funcImportNames.push(section.import.name);
    }
  }

  // Build export name → import name mapping
  const result = new Map<string, string>();
  for (const section of parsed.sections) {
    if (section.tag === 'export' && section.export.sort === 'func') {
      const importName = funcImportNames[section.export.index];
      if (importName !== undefined) {
        result.set(section.export.name, importName);
      }
    }
  }

  return result;
}

// -----------------------------------------------------------------------
// Memory extraction
// -----------------------------------------------------------------------

function emitMemoryExtractions(scope: ComponentScope): void {
  for (let i = 0; i < scope.coreMemories.length; i++) {
    const mem = scope.coreMemories[i]!;
    const ci = scope.coreInstances[mem.coreInstanceIdx];
    if (ci?.tag === 'instantiation') {
      const globalIdx = scope.memoryIdxMap[i] ?? i;
      scope.global.memories.push({
        memoryIdx: globalIdx,
        runtimeInstanceIdx: ci.runtimeIdx,
        exportName: mem.name,
      });
    }
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/** Check if a nested component has significant content requiring its own state. */
function needsOwnState(parsed: ParsedComponent): boolean {
  for (const section of parsed.sections) {
    if (section.tag === 'coreModule' ||
        section.tag === 'canonical' ||
        section.tag === 'component') {
      return true;
    }
  }
  return false;
}


/** Extract structured options from CanonOpt array. */
function extractCanonOpts(options: CanonOpt[]): {
  isAsync: boolean;
  memoryIdx: number | null;
  callbackIdx: number | null;
  reallocIdx: number | null;
} {
  let isAsync = false;
  let memoryIdx: number | null = null;
  let callbackIdx: number | null = null;
  let reallocIdx: number | null = null;

  for (const opt of options) {
    switch (opt.tag) {
      case 'async': isAsync = true; break;
      case 'memory': memoryIdx = opt.index; break;
      case 'callback': callbackIdx = opt.index; break;
      case 'realloc': reallocIdx = opt.index; break;
    }
  }

  return { isAsync, memoryIdx, callbackIdx, reallocIdx };
}

/** Classify a task.return's result type for code generation. */
function classifyTaskReturn(
  result: ComponentValType | null,
  compTypes: ComponentTypeEntry[],
): TaskReturnKind {
  if (result === null) return 'none';

  // Check for void result<_, _> first — uses single-value discriminant trampoline
  if (result.tag !== 'primitive') {
    const entry = compTypes[result.index];
    if (entry?.tag === 'defined' && entry.type.tag === 'result'
        && !entry.type.ok && !entry.type.err) {
      return 'resultType';
    }
  }

  // Check if this type flattens to multiple values (e.g. string → [ptr, len],
  // result<T, E> → [discriminant, ...payload])
  const flatTypes = flattenType(result, compTypes);
  if (flatTypes.length > 1) {
    return 'flatValues';
  }

  return 'primitive';
}

/** Look up a component func type by type index. */
function getFuncType(
  scope: ComponentScope,
  typeIdx: number,
): ComponentFuncType | null {
  const entry = scope.compTypes[typeIdx];
  if (!entry || entry.tag !== 'func') return null;
  return entry.type;
}

/** Build pre-resolved transfer info using the callee's scope (avoids cross-scope type lookups). */
function buildTransferInfo(scope: ComponentScope, funcType: ComponentFuncType | null): TransferInfo {
  if (!funcType) return {};

  const info: TransferInfo = {};

  // Check result for stream/future/resource
  if (funcType.result?.tag === 'typeIndex') {
    const entry = scope.compTypes[funcType.result.index];
    if (entry?.tag === 'defined') {
      if (entry.type.tag === 'stream') {
        info.resultStreamTransfer = { tableIdx: scope.getStreamTableIdx(funcType.result.index) };
      } else if (entry.type.tag === 'future') {
        info.resultFutureTransfer = { tableIdx: scope.getFutureTableIdx(funcType.result.index) };
      } else if (entry.type.tag === 'own') {
        info.resultResourceTransfer = true;
      }
    }
  }

  // Check params for stream/future/resource
  let flatIdx = 0;
  for (const param of funcType.params) {
    const paramFlatTypes = flattenType(param.type, scope.compTypes);
    if (param.type.tag === 'typeIndex') {
      const entry = scope.compTypes[param.type.index];
      if (entry?.tag === 'defined') {
        if (entry.type.tag === 'stream') {
          if (!info.paramStreamTransfers) info.paramStreamTransfers = [];
          info.paramStreamTransfers.push({
            paramFlatIdx: flatIdx,
            tableIdx: scope.getStreamTableIdx(param.type.index),
          });
        } else if (entry.type.tag === 'future') {
          if (!info.paramFutureTransfers) info.paramFutureTransfers = [];
          info.paramFutureTransfers.push({
            paramFlatIdx: flatIdx,
            tableIdx: scope.getFutureTableIdx(param.type.index),
          });
        } else if (entry.type.tag === 'own' || entry.type.tag === 'borrow') {
          // Check if the underlying resource type is locally defined by this component
          const resourceTypeIdx = entry.type.typeIndex;
          const calleeDefinesResource = scope.localResourceTypes.has(resourceTypeIdx);
          if (!info.paramResourceTransfers) info.paramResourceTransfers = [];
          info.paramResourceTransfers.push({
            paramFlatIdx: flatIdx,
            kind: entry.type.tag,
            calleeDefinesResource,
          });
        }
      }
    }
    flatIdx += paramFlatTypes.length;
  }

  return info;
}

/** Count the number of flat ABI parameters for a component func type. */
function countFlatParams(
  funcType: ComponentFuncType,
  compTypes: ComponentTypeEntry[],
): number {
  let count = 0;
  for (const param of funcType.params) {
    count += flattenType(param.type, compTypes).length;
  }
  return count;
}
