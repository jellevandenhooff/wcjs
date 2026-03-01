/**
 * Linked IR types produced by the link phase.
 *
 * These represent the categorized items that the emitter walks to produce
 * TypeScript source code. Mirrors the Rust p3_component.rs Action/Trampoline.
 */

import type { HostImportLowerInfo, HostValType } from './host-types.ts';
export type { HostImportLowerInfo } from './host-types.ts';
export type { HostValType } from './host-types.ts';

// -----------------------------------------------------------------------
// Flat value types (canonical ABI)
// -----------------------------------------------------------------------

export type FlatValType = 'i32' | 'i64' | 'f32' | 'f64';

// -----------------------------------------------------------------------
// Task return result classification
// -----------------------------------------------------------------------

/** How a task.return's result type maps to generated code. */
export type TaskReturnKind =
  | 'none'           // no result → resolve(undefined)
  | 'resultType'     // result<_, _> → discriminant-based ok/err
  | 'primitive'      // single primitive → resolve(value)
  | 'flatValues';    // multi-flat values → (...values) => resolve(values)

// -----------------------------------------------------------------------
// Callee reference (for AsyncAdapter)
// -----------------------------------------------------------------------

export type CalleeRef =
  | { tag: 'coreExport'; runtimeInstanceIdx: number; exportName: string }
  | { tag: 'trampoline'; trampolineIdx: number };

// -----------------------------------------------------------------------
// Start/Return function types for cross-component calls
// -----------------------------------------------------------------------

/** Parameter lifting function for cross-component calls. */
export type StartFn =
  | null
  | { tag: 'handleTransfer'; transfers: ParamTransfer[] }
  | { tag: 'memoryRead'; memoryIdx: number; reads: FlatRead[]; realloc?: ReallocInfo }

export interface ParamTransfer {
  paramIdx: number;
  kind: TransferKind;
}

export type TransferKind =
  | { tag: 'streamEnd'; tableIdx: number; fromStateIdx: number; toStateIdx: number }
  | { tag: 'futureEnd'; tableIdx: number; fromStateIdx: number; toStateIdx: number }
  | { tag: 'resourceRep'; fromStateIdx: number }
  | { tag: 'borrowHandle'; fromStateIdx: number; toStateIdx: number }
  | { tag: 'ownResource'; fromStateIdx: number; toStateIdx: number }

export interface FlatRead {
  offset: number;
  getter: string;  // e.g., 'getInt32', 'getBigInt64'
  flatType: FlatValType;
}

export interface ReallocInfo {
  runtimeInstanceIdx: number;
  exportName: string;
  dstMemoryIdx: number;
  alignment: number;
  byteSize: number;
}

/** Result lowering function for cross-component calls. */
export type ReturnFn =
  | null
  | { tag: 'typed'; memoryIdx: number; writes: FlatWrite[] }
  | { tag: 'memoryCopy'; srcMemoryIdx: number; dstMemoryIdx: number; copies: FlatCopy[]; resultIsArray: boolean }
  | { tag: 'streamTransfer'; tableIdx: number; fromStateIdx: number; toStateIdx: number }
  | { tag: 'futureTransfer'; tableIdx: number; fromStateIdx: number; toStateIdx: number }
  | { tag: 'resourceTransfer'; fromStateIdx: number; toStateIdx: number }
  | { tag: 'typedWithTransfer'; memoryIdx: number; writes: FlatWrite[]; preTransfer: ReturnFn }

export interface FlatWrite {
  offset: number;
  setter: string;  // e.g., 'setInt32', 'setBigInt64'
  cast: string;    // e.g., 'as number', 'as bigint'
  isArray: boolean; // true if reading from result array, false if from result directly
  arrayIdx?: number; // index into result array
}

export interface FlatCopy {
  offset: number;
  getter: string;
  setter: string;
  cast: string;
}

// -----------------------------------------------------------------------
// Trampoline variants
// -----------------------------------------------------------------------

export type Trampoline =
  | { tag: 'taskReturn'; resultKind: TaskReturnKind; stateIdx: number }
  | { tag: 'contextGet'; slot: number; stateIdx: number }
  | { tag: 'contextSet'; slot: number; stateIdx: number }
  | { tag: 'waitableSetNew'; stateIdx: number }
  | { tag: 'waitableSetDrop'; stateIdx: number }
  | { tag: 'waitableSetWait'; memoryIdx: number; cancellable: boolean; stateIdx: number }
  | { tag: 'waitableSetPoll'; memoryIdx: number; cancellable: boolean; stateIdx: number }
  | { tag: 'waitableJoin'; stateIdx: number }
  | { tag: 'subtaskDrop'; stateIdx: number }
  | { tag: 'subtaskCancel'; isAsync: boolean; stateIdx: number }
  | { tag: 'taskCancel'; stateIdx: number }
  | { tag: 'streamNew'; tableIdx: number; stateIdx: number }
  | { tag: 'streamRead'; tableIdx: number; memoryIdx: number; elemSize: number; isResource: boolean; resourceTableIdx?: number; isAsync: boolean; stateIdx: number; elemHostType?: HostValType; reallocInfo?: { runtimeInstanceIdx: number; exportName: string } }
  | { tag: 'streamWrite'; tableIdx: number; memoryIdx: number; elemSize: number; isResource: boolean; resourceTableIdx?: number; isAsync: boolean; stateIdx: number }
  | { tag: 'streamCancelRead'; tableIdx: number; isAsync: boolean; stateIdx: number }
  | { tag: 'streamCancelWrite'; tableIdx: number; isAsync: boolean; stateIdx: number }
  | { tag: 'streamDropReadable'; tableIdx: number; stateIdx: number }
  | { tag: 'streamDropWritable'; tableIdx: number; stateIdx: number }
  | { tag: 'futureNew'; tableIdx: number; stateIdx: number }
  | { tag: 'futureRead'; tableIdx: number; memoryIdx: number; elemSize: number; isAsync: boolean; stateIdx: number; elemHostType?: HostValType; reallocInfo?: { runtimeInstanceIdx: number; exportName: string } }
  | { tag: 'futureWrite'; tableIdx: number; memoryIdx: number; elemSize: number; isAsync: boolean; stateIdx: number; elemHostType?: HostValType; reallocInfo?: { runtimeInstanceIdx: number; exportName: string } }
  | { tag: 'futureCancelRead'; tableIdx: number; isAsync: boolean; stateIdx: number }
  | { tag: 'futureCancelWrite'; tableIdx: number; isAsync: boolean; stateIdx: number }
  | { tag: 'futureDropReadable'; tableIdx: number; stateIdx: number }
  | { tag: 'futureDropWritable'; tableIdx: number; stateIdx: number }
  | { tag: 'threadYield'; cancellable: boolean; stateIdx: number }
  | { tag: 'threadIndex'; stateIdx: number }
  | { tag: 'threadNewIndirect'; tableRuntimeInstanceIdx: number; tableExportName: string; stateIdx: number }
  | { tag: 'threadSuspend'; stateIdx: number }
  | { tag: 'threadSwitchTo'; stateIdx: number }
  | { tag: 'threadYieldTo'; stateIdx: number }
  | { tag: 'threadSuspendTo'; stateIdx: number }
  | { tag: 'threadResumeLater'; stateIdx: number }
  | { tag: 'lowerImport'; name: string; isAsync: boolean; paramCount: number; stateIdx: number }
  | { tag: 'lowerHostImport'; importName: string; exportName: string;
      isAsync: boolean; stateIdx: number; lowerInfo: HostImportLowerInfo | null }
  | { tag: 'resourceNew'; tableIdx: number; stateIdx: number }
  | { tag: 'resourceRep'; tableIdx: number; stateIdx: number }
  | { tag: 'resourceDrop'; tableIdx: number; stateIdx: number;
      dtorInstanceIdx?: number; dtorExportName?: string;
      hostDropIface?: string; hostDropName?: string }
  | { tag: 'asyncAdapter';
      callerStateIdx: number;
      calleeStateIdx: number;
      callee: CalleeRef;
      calleeCallbackIdx: number | null;
      callerIsAsync: boolean;
      calleeIsAsync: boolean;
      calleeNeedsJSPI: boolean;
      startFn: StartFn;
      returnFn: ReturnFn;
      resultCountOrAsync: number;
    };

// -----------------------------------------------------------------------
// Import bindings (for core instance imports)
// -----------------------------------------------------------------------

/** How a core instance import is satisfied. */
export type ImportBinding =
  | { tag: 'trampoline'; idx: number }
  | { tag: 'coreExport'; runtimeInstanceIdx: number; name: string }
  | { tag: 'instanceExports'; runtimeInstanceIdx: number };

// -----------------------------------------------------------------------
// Categorized linked items
// -----------------------------------------------------------------------

export interface LinkedModule {
  moduleIdx: number;
  bytes: Uint8Array;
}

export interface LinkedInstance {
  runtimeIdx: number;
  moduleIdx: number;
  imports: Array<[string, Array<[string, ImportBinding]> | ImportBinding]>;
}

export interface LinkedTrampoline {
  trampolineIdx: number;
  trampoline: Trampoline;
}

export interface LinkedMemory {
  memoryIdx: number;
  runtimeInstanceIdx: number;
  exportName: string;
}

export interface LinkedCallback {
  callbackIdx: number;
  runtimeInstanceIdx: number;
  exportName: string;
}

// -----------------------------------------------------------------------
// Exported function info
// -----------------------------------------------------------------------

/** How to lift the result of an async export (e.g., future/stream end transfer). */
export type ExportLiftResult =
  | { tag: 'liftFutureEnd'; tableIdx: number }
  | { tag: 'liftStreamEnd'; tableIdx: number };

/** Type info for generating canonical ABI lowering/lifting in export wrappers. */
export interface ExportLiftInfo {
  paramNames: string[];
  paramTypes: HostValType[];
  resultType: HostValType | null;
  paramFlatTypes: FlatValType[];
  resultFlatTypes: FlatValType[];
  memoryIdx: number | null;
  realloc: { runtimeInstanceIdx: number; exportName: string } | null;
}

export interface ExportedFunc {
  /** The JS name of the function (e.g., 'run') */
  name: string;
  /** Runtime instance index where the core entry func lives */
  runtimeInstanceIdx: number;
  /** Export name of the core entry function (e.g., 'run') */
  coreExportName: string;
  /** Callback index (into callback_N variables), -1 if no callback */
  callbackIdx: number;
  /** Whether the export is async */
  isAsync: boolean;
  /** State index for this export */
  stateIdx: number;
  /** If set, the result needs lifting (e.g., future/stream end transfer) */
  liftResult?: ExportLiftResult;
  /** If set, canonical ABI type info for param lowering and result lifting */
  liftInfo?: ExportLiftInfo;
}

// -----------------------------------------------------------------------
// State relationships
// -----------------------------------------------------------------------

export interface StateRelationship {
  child: number;
  parent: number;
}

// -----------------------------------------------------------------------
// Linked component
// -----------------------------------------------------------------------

export interface LinkedComponent {
  modules: LinkedModule[];
  instances: LinkedInstance[];
  trampolines: LinkedTrampoline[];
  memories: LinkedMemory[];
  callbacks: LinkedCallback[];
  /** Maps interface path → { funcName → ExportedFunc } */
  exports: Map<string, Map<string, ExportedFunc>>;
  /** Number of component states needed */
  numStates: number;
  /** Parent/child state relationships */
  stateRelationships: StateRelationship[];
}
