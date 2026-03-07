import { HandleTable } from './handle-table.ts';
import { CopyResult, CopyState, EventCode, BLOCKED, SubtaskState, MAY_ENTER } from './types.ts';
import type { ReadableStreamBuffer, WritableStreamBuffer, StreamBuffer } from './types.ts';
import { Waitable } from './waitable.ts';
import { WaitableSet } from './waitable-set.ts';
import { Subtask } from './subtask.ts';
import {
  StreamEnd,
  createStream,
  streamCopyAsync,
  streamCopySync,
  ReadableStreamEnd,
  WritableStreamEnd,
} from './stream.ts';
import type { OnCopy, OnCopyDone } from './stream.ts';
import {
  FutureEnd,
  createFuture,
  futureCopyAsync,
  futureCopySync,
  ReadableFutureEnd,
  WritableFutureEnd,
} from './future.ts';
import type { OnFutureCopyDone } from './future.ts';
import { AsyncTask } from './task.ts';
import type { EventLoop } from './event-loop.ts';
import { trace } from './trace.ts';
import { promising } from './jspi.ts';

// JSPI mode flag (module-level global). When true, JSPI is available and
// sync callers can block via promising()/suspending(). When false, all
// components use callback mode exclusively.
// Set once by generated code based on the `p3Jspi` transpile option.
export let jspiMode = false;
export function setJspiMode(v: boolean): void { jspiMode = v; }

// Per spec: a resource handle in inst.handles.
export class ResourceHandle {
  // Per spec: borrow_scope — the task that created this borrow handle.
  // When the borrow is dropped, borrowTask.numBorrows is decremented.
  borrowTask: AsyncTask | null = null;

  // Per spec: num_lends tracks how many subtasks have borrowed this handle
  // via lift_borrow. The handle cannot be dropped while num_lends > 0.
  numLends = 0;

  constructor(
    public readonly typeIdx: number,  // TypeResourceTableIndex
    public readonly rep: number,      // representation value
    public readonly own: boolean,     // true = own, false = borrow
  ) {}
}

// Union type for all entries in the shared handle table.
// Per spec: inst.handles: Table[ResourceHandle | Waitable | WaitableSet | ErrorContext]
// In our implementation: Waitable covers Subtask, StreamEnd, and FutureEnd.
type HandleEntry = Waitable | WaitableSet | ResourceHandle;

// Writable buffer backed by wasm linear memory.
// Used by stream.read: data from the stream is written INTO wasm memory.
/** Store function for structured stream elements: stores a lifted item at the given memory offset. */
export type StreamStoreFn = (offset: number, item: unknown) => void;

class WasmWritableBuffer implements WritableStreamBuffer {
  private memory: WebAssembly.Memory;
  private ptr: number;
  private elemSize: number;
  private count: number;
  private storeFn?: StreamStoreFn;
  progress: number = 0;

  constructor(memory: WebAssembly.Memory, ptr: number, count: number, elemSize: number, storeFn?: StreamStoreFn) {
    this.memory = memory;
    this.ptr = ptr;
    this.count = count;
    this.elemSize = elemSize;
    this.storeFn = storeFn;
  }

  remain(): number { return this.count - this.progress; }
  isZeroLength(): boolean { return this.count === 0; }

  write(items: unknown[]): void {
    if (this.elemSize === 0) {
      // Void stream/future: no actual data to write, just count items
      this.progress += items.length;
      return;
    }
    if (this.storeFn) {
      // Structured element type: use generated store function
      for (let i = 0; i < items.length; i++) {
        const offset = this.ptr + (this.progress + i) * this.elemSize;
        this.storeFn(offset, items[i]);
      }
      this.progress += items.length;
      return;
    }
    const view = new DataView(this.memory.buffer);
    for (let i = 0; i < items.length; i++) {
      const offset = this.ptr + (this.progress + i) * this.elemSize;
      if (this.elemSize === 1) view.setUint8(offset, items[i] as number);
      else if (this.elemSize === 2) view.setUint16(offset, items[i] as number, true);
      else if (this.elemSize === 4) view.setUint32(offset, items[i] as number, true);
      else if (this.elemSize === 8) view.setBigUint64(offset, typeof items[i] === 'bigint' ? items[i] as bigint : BigInt(items[i] as number), true);
      else if (items[i] instanceof Uint8Array) {
        // Raw bytes from a WasmReadableBuffer without loadFn
        new Uint8Array(this.memory.buffer, offset, this.elemSize).set(items[i] as Uint8Array);
      }
      else throw new Error(`unsupported element size: ${this.elemSize}`);
    }
    this.progress += items.length;
  }
}

// Host-side readable buffer for future/stream operations.
// Used when the host needs to write data to a future without wasm memory.
class HostReadableBuffer implements ReadableStreamBuffer {
  private items: unknown[];
  progress: number = 0;

  constructor(items: unknown[]) {
    this.items = items;
  }

  remain(): number { return this.items.length - this.progress; }
  isZeroLength(): boolean { return this.items.length === 0; }

  read(n: number): unknown[] {
    const result = this.items.slice(this.progress, this.progress + n);
    this.progress += n;
    return result;
  }
}

/** Load function for structured stream elements: loads a lifted item from the given memory offset. */
export type StreamLoadFn = (offset: number) => unknown;

// Readable buffer backed by wasm linear memory.
// Used by stream.write: data is read FROM wasm memory into the stream.
class WasmReadableBuffer implements ReadableStreamBuffer {
  private memory: WebAssembly.Memory;
  private ptr: number;
  private elemSize: number;
  private count: number;
  private loadFn?: StreamLoadFn;
  progress: number = 0;

  constructor(memory: WebAssembly.Memory, ptr: number, count: number, elemSize: number, loadFn?: StreamLoadFn) {
    this.memory = memory;
    this.ptr = ptr;
    this.count = count;
    this.elemSize = elemSize;
    this.loadFn = loadFn;
  }

  remain(): number { return this.count - this.progress; }
  isZeroLength(): boolean { return this.count === 0; }

  read(n: number): unknown[] {
    if (this.elemSize === 0) {
      // Void stream/future: produce undefined items, no actual memory read
      this.progress += n;
      return new Array(n).fill(undefined);
    }
    if (this.loadFn) {
      // Structured element type: use generated load function
      const items: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const offset = this.ptr + (this.progress + i) * this.elemSize;
        items.push(this.loadFn(offset));
      }
      this.progress += n;
      return items;
    }
    const view = new DataView(this.memory.buffer);
    const items: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const offset = this.ptr + (this.progress + i) * this.elemSize;
      if (this.elemSize === 1) items.push(view.getUint8(offset));
      else if (this.elemSize === 2) items.push(view.getUint16(offset, true));
      else if (this.elemSize === 4) items.push(view.getUint32(offset, true));
      else if (this.elemSize === 8) items.push(view.getBigUint64(offset, true));
      else {
        // Large element without loadFn: copy raw bytes
        items.push(new Uint8Array(this.memory.buffer, offset, this.elemSize).slice());
      }
    }
    this.progress += n;
    return items;
  }
}

// Readable buffer for resource-carrying streams (writer side).
// Reads i32 handle indices from wasm memory, then lifts them by removing
// the ResourceHandle from the owning ComponentState's handle table.
// The rendezvous passes ResourceHandle objects to the reader side.
class ResourceReadableBuffer implements ReadableStreamBuffer {
  private memory: WebAssembly.Memory;
  private ptr: number;
  private count: number;
  private state: ComponentState;
  progress: number = 0;

  constructor(state: ComponentState, memory: WebAssembly.Memory, ptr: number, count: number) {
    this.state = state;
    this.memory = memory;
    this.ptr = ptr;
    this.count = count;
  }

  remain(): number { return this.count - this.progress; }
  isZeroLength(): boolean { return this.count === 0; }

  read(n: number): unknown[] {
    const view = new DataView(this.memory.buffer);
    const items: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const offset = this.ptr + (this.progress + i) * 4;
      const handleIdx = view.getUint32(offset, true);
      // Lift: remove ownership from writer's handle table
      const handle = this.state.removeResourceHandle(handleIdx);
      items.push(handle);
    }
    this.progress += n;
    return items;
  }
}

// Writable buffer for resource-carrying streams (reader side).
// Receives ResourceHandle objects from the rendezvous, adds them to the
// owning ComponentState's handle table, and writes the new i32 handle
// indices to wasm memory.
class ResourceWritableBuffer implements WritableStreamBuffer {
  private memory: WebAssembly.Memory;
  private ptr: number;
  private count: number;
  private state: ComponentState;
  private resourceTypeIdx: number;
  progress: number = 0;

  constructor(state: ComponentState, memory: WebAssembly.Memory, ptr: number, count: number, resourceTypeIdx: number) {
    this.state = state;
    this.memory = memory;
    this.ptr = ptr;
    this.count = count;
    this.resourceTypeIdx = resourceTypeIdx;
  }

  remain(): number { return this.count - this.progress; }
  isZeroLength(): boolean { return this.count === 0; }

  write(items: unknown[]): void {
    const view = new DataView(this.memory.buffer);
    for (let i = 0; i < items.length; i++) {
      let handle = items[i];
      // Host streams may write raw reps (numbers) instead of ResourceHandle objects.
      // Wrap them in a ResourceHandle with the stream's resource type.
      if (!(handle instanceof ResourceHandle)) {
        handle = new ResourceHandle(this.resourceTypeIdx, handle as number, true);
      }
      const offset = this.ptr + (this.progress + i) * 4;
      // Lower: add to reader's handle table, write new index to memory
      const newIdx = this.state.addResourceHandle(handle as ResourceHandle);
      trace.log(this.state.componentIdx, 'resource.stream-write', `rep=${(handle as ResourceHandle).rep} typeIdx=${(handle as ResourceHandle).typeIdx} → handle=${newIdx} @mem[${offset}]`);
      view.setUint32(offset, newIdx, true);
    }
    this.progress += items.length;
  }
}

// Per-component instance state.
// Each component instance has its own handle tables, lock state, etc.
export class ComponentState {
  readonly componentIdx: number;

  // Shared handle table (per spec: inst.handles).
  // All handle types share one index space: waitables, waitable sets,
  // subtasks, stream ends, future ends.
  readonly handles = new HandleTable<HandleEntry>();

  // The currently executing async task for this component
  currentTask: AsyncTask | null = null;

  // Exclusive lock (per spec: inst.exclusive)
  // In callback mode, the component holds exclusive while wasm is executing
  private _exclusive = 0;

  // may_leave flag (per spec)
  mayLeave = true;

  // Reentrancy guard with reference counting.
  //
  // When a component enters, may_enter is cleared for SELF plus all ancestors
  // and descendants (core wasm adapters check instance flags for sync-to-sync
  // calls that bypass our JS trampolines). Reference counting (_enterRefCount)
  // ensures that concurrent entries (e.g., sibling components both entered)
  // don't incorrectly restore flags when one leaves while others are still in.
  private _mayEnter = true;
  private _instanceFlags: WebAssembly.Global | null = null;
  private _enterRefCount = 0;

  // Backpressure counter
  private _backpressure = 0;

  // Pending calls waiting for may_enter (auto-backpressure queue).
  // When asyncStartCall finds may_enter=false, the call is queued here.
  // Processing happens in leave() when may_enter is restored.
  private _pendingCalls: Array<() => void> = [];

  // Parent component instance (for reentrancy checks).
  // Per spec: ComponentInstance.parent
  private _parent: ComponentState | null = null;

  // Children of this component instance (populated by setParent).
  private _children: ComponentState[] = [];

  // Lifecycle: when destroyed, all event loops and pending waits are cancelled.
  private _destroyed = false;

  // Reference to the global event loop (set by generated code via setEventLoop).
  private _eventLoop: EventLoop | null = null;

  constructor(componentIdx: number) {
    this.componentIdx = componentIdx;
  }

  // Set the event loop for this component state.
  // Called by generated code or runAsyncExport.
  setEventLoop(eventLoop: EventLoop): void {
    this._eventLoop = eventLoop;
  }

  // Set parent component instance (called by generated code).
  setParent(parent: ComponentState): void {
    this._parent = parent;
    parent._children.push(this);
  }

  // Per spec: ComponentInstance.is_reflexive_ancestor_of(other)
  // Returns true if this instance appears in other's parent chain (including self).
  isReflexiveAncestorOf(other: ComponentState): boolean {
    let cur: ComponentState | null = other;
    while (cur !== null) {
      if (cur === this) return true;
      cur = cur._parent;
    }
    return false;
  }

  // Register the WebAssembly.Global used as instance flags by core wasm adapters.
  setInstanceFlags(flags: WebAssembly.Global): void {
    this._instanceFlags = flags;
  }

  // Increment enter ref count and clear may_enter flags (both JS + wasm global).
  private _addEnterRef(): void {
    this._enterRefCount++;
    this._mayEnter = false;
    if (this._instanceFlags) {
      this._instanceFlags.value = (this._instanceFlags.value as number) & ~MAY_ENTER;
    }
  }

  // Decrement enter ref count; restore may_enter only when count reaches 0.
  private _removeEnterRef(): void {
    this._enterRefCount--;
    if (this._enterRefCount === 0) {
      this._mayEnter = true;
      if (this._instanceFlags) {
        this._instanceFlags.value = (this._instanceFlags.value as number) | MAY_ENTER;
      }
    }
  }

  // Enter this component (canon lift). Returns false if already entered
  // (re-entry denied).
  //
  // Clears may_enter for SELF, all ANCESTORS, and all DESCENDANTS via
  // reference counting. Core wasm adapters check instance flags to implement
  // the spec's call_might_be_recursive check. Clearing flags on both ancestors
  // and descendants ensures any direct wasm-to-wasm call between related
  // instances will trap.
  //
  // Instance flags layout (from types.ts: MAY_ENTER=1, MAY_LEAVE=2):
  enter(): boolean {
    if (!this._mayEnter) return false;
    this._doEnter();
    return true;
  }

  // Force-enter this component, bypassing the _mayEnter check.
  // Used by asyncStartCall/syncStartCall where the adapter trampoline does NOT
  // check instance flags — it delegates to our JS code which does its own
  // call_might_be_recursive check.
  //
  // The _mayEnter flag may be false due to ancestor/descendant propagation
  // (e.g., a sibling entered), but this is fine for non-sync-to-sync calls.
  forceEnter(): void {
    this._doEnter();
  }

  private _doEnter(): void {
    // Ref-count self
    this._addEnterRef();
    // Ref-count all ancestors
    let cur = this._parent;
    while (cur) {
      cur._addEnterRef();
      cur = cur._parent;
    }
    // Ref-count all descendants
    this._addEnterRefDescendants();
  }

  private _addEnterRefDescendants(): void {
    for (const child of this._children) {
      child._addEnterRef();
      child._addEnterRefDescendants();
    }
  }

  // Leave this component (canon lift return). Decrements ref counts for self,
  // ancestors, and descendants. Restores may_enter only when ref count hits 0.
  leave(): void {
    this.restoreEnterRefs();
  }

  private _removeEnterRefDescendants(): void {
    for (const child of this._children) {
      child._removeEnterRef();
      child._removeEnterRefDescendants();
    }
  }

  // Queue a deferred call for when this component becomes available.
  // Used by asyncStartCall when may_enter is false (auto-backpressure).
  queuePendingCall(fn: () => void): void {
    this._pendingCalls.push(fn);
  }

  // Destroy this component state, aborting all pending operations.
  // This breaks any infinite event loops and rejects pending waitable-set waits.
  // Also drops all remaining stream/future ends so that host-side consumers
  // (e.g. consumeReadableStream) get the DROPPED signal and can finish.
  destroy(): void {
    this._destroyed = true;
    // Drop all stream/future ends first (before aborting waitable sets) so
    // that host-side consumers (e.g. consumeReadableStream) get the DROPPED
    // signal and their promises can resolve.
    for (const entry of this.handles.values()) {
      if (entry instanceof WritableStreamEnd) {
        entry.shared.dropWriter();
      } else if (entry instanceof ReadableStreamEnd) {
        entry.shared.dropReader();
      } else if (entry instanceof FutureEnd) {
        entry.shared.drop();
      }
    }
    this.abortAll(new Error('component destroyed'));
  }

  // Abort all pending waitable-set waits with a specific error.
  // Used by EventLoop for deadlock propagation and by destroy().
  abortAll(error: Error): void {
    for (const entry of this.handles.values()) {
      if (entry instanceof WaitableSet) {
        entry.abort(error);
      }
    }
  }

  isDestroyed(): boolean {
    return this._destroyed;
  }

  // Restore may_enter flags without processing pending calls.
  // Used when we need to allow sync-to-sync core wasm adapters to proceed
  // but the component is still logically "busy" (exclusive held).
  restoreEnterRefs(): void {
    this._removeEnterRef();
    let cur = this._parent;
    while (cur) {
      cur._removeEnterRef();
      cur = cur._parent;
    }
    this._removeEnterRefDescendants();
  }

  // Exclusive lock management (counter-based for reentrant sync barge-in)
  acquireExclusive(): void {
    this._exclusive++;
  }

  releaseExclusive(): void {
    this._exclusive--;
    // Per spec: when exclusive is fully released and a task exits, pending calls
    // (from backpressured callers) are processed.
    if (this._exclusive === 0 && this._pendingCalls.length > 0) {
      const next = this._pendingCalls.shift()!;
      next();
    }
  }

  isExclusive(): boolean {
    return this._exclusive > 0;
  }

  // Backpressure management
  hasBackpressure(): boolean {
    return this._backpressure > 0;
  }

  setBackpressure(enabled: boolean): void {
    if (enabled) {
      this._backpressure++;
    } else {
      if (this._backpressure <= 0) {
        throw new Error('backpressure underflow');
      }
      this._backpressure--;
    }
  }

  // Per spec: trap_if(not inst.may_leave). Called at the start of canon builtins
  // to prevent guest code from calling builtins during value lowering (e.g., from
  // a realloc callback). In single-threaded JS this is mostly defensive, but the
  // spec requires it.
  private checkMayLeave(): void {
    if (!this.mayLeave) {
      throw new Error('wasm trap: cannot call canon builtin while may_leave is false');
    }
  }

  // WaitableSet operations (canon builtins)
  waitableSetNew(): number {
    this.checkMayLeave();
    const ws = new WaitableSet();
    ws.notifyFn = () => this._eventLoop?.wake();
    const h = this.handles.insert(ws);
    trace.logResult(this.componentIdx, 'waitable-set.new', h);
    return h;
  }

  getWaitableSet(rep: number): WaitableSet {
    const entry = this.handles.get(rep);
    if (!(entry instanceof WaitableSet)) throw new Error(`unknown waitable set handle ${rep}`);
    return entry;
  }

  waitableSetDrop(rep: number): void {
    this.checkMayLeave();
    const entry = this.handles.remove(rep);
    if (!(entry instanceof WaitableSet)) throw new Error(`unknown waitable set handle ${rep}`);
    entry.drop();
  }

  // Waitable operations
  waitableJoin(waitableRep: number, waitableSetRep: number): void {
    this.checkMayLeave();
    trace.log(this.componentIdx, 'waitable.join', waitableRep, waitableSetRep);
    const w = this.handles.get(waitableRep);
    if (!(w instanceof Waitable)) throw new Error(`unknown waitable handle ${waitableRep}`);
    if (waitableSetRep === 0) {
      w.join(null);
    } else {
      const ws = this.handles.get(waitableSetRep);
      if (!(ws instanceof WaitableSet)) throw new Error(`unknown waitable set handle ${waitableSetRep}`);
      w.join(ws);
    }
  }

  // Subtask operations
  addSubtask(subtask: Subtask): number {
    const rep = this.handles.insert(subtask);
    subtask.setHandleIndex(rep);
    return rep;
  }

  getSubtask(rep: number): Subtask {
    const entry = this.handles.get(rep);
    if (!(entry instanceof Subtask)) throw new Error(`unknown subtask handle ${rep}`);
    return entry;
  }

  subtaskDrop(rep: number): void {
    this.checkMayLeave();
    trace.log(this.componentIdx, 'subtask.drop', rep);
    const entry = this.handles.remove(rep);
    if (!(entry instanceof Subtask)) throw new Error(`unknown subtask handle ${rep}`);
    entry.drop();
  }

  // canon subtask.cancel: cancel a subtask from the caller side.
  // If the callee has a callback, delivers TASK_CANCELLED inline.
  // If the callee is JSPI-mode and in a cancellable blocking point, waits for
  // the callee to process the cancel (returns a Promise via JSPI suspension).
  // Otherwise returns BLOCKED.
  subtaskCancel(rep: number, async_: boolean): number | Promise<number> {
    this.checkMayLeave();
    trace.log(this.componentIdx, 'subtask.cancel', rep);
    const subtask = this.getSubtask(rep);
    if (subtask.resolved()) {
      subtask.getPendingEvent();
      trace.logResult(this.componentIdx, 'subtask.cancel', `already resolved: ${subtask.getState()}`);
      return subtask.getState();
    }

    // If callee is in a cancellable blocking point (e.g., waitable-set.wait-
    // cancellable, poll-cancellable, thread.yield-cancellable), signal
    // cancellation and wait for the callee to process it through the builtin.
    // This takes priority over inline cancel because the callee is actively
    // suspended in JSPI — calling the callback would be incorrect.
    if (subtask.calleeTask && subtask.calleeTask.isCancellable()) {
      subtask.calleeTask.requestCancellation();
      trace.logResult(this.componentIdx, 'subtask.cancel', 'awaiting cancellable callee');
      return subtask.waitForResolution().then(() => {
        subtask.getPendingEvent();
        trace.logResult(this.componentIdx, 'subtask.cancel', `resolved: ${subtask.getState()}`);
        return subtask.getState();
      });
    }

    // Try inline cancel (callback mode — callee has a callback and is NOT
    // in a cancellable blocking point). This delivers TASK_CANCELLED to the
    // callback synchronously.
    if (subtask.tryInlineCancel()) {
      // Consume the pending event so the caller can drop immediately
      subtask.getPendingEvent();
      trace.logResult(this.componentIdx, 'subtask.cancel', `inline cancelled: ${subtask.getState()}`);
      return subtask.getState();
    }

    // Host import subtask (no callee): cancel immediately.
    // The host's Promise is abandoned — its late resolution is ignored
    // by onResolve's terminal-state guard.
    if (!subtask.calleeTask && !subtask.calleeCallbackFn) {
      subtask.onResolve(undefined); // → CANCELLED_BEFORE_*
      subtask.getPendingEvent();
      trace.logResult(this.componentIdx, 'subtask.cancel', `host cancelled: ${subtask.getState()}`);
      return subtask.getState();
    }

    // Signal cancellation to the callee (deferred — returns BLOCKED)
    if (subtask.calleeTask) {
      subtask.calleeTask.requestCancellation();
    }

    trace.logResult(this.componentIdx, 'subtask.cancel', 'BLOCKED');
    return BLOCKED;
  }

  // canon task.cancel: called by the callee to accept cancellation.
  taskCancel(): void {
    this.checkMayLeave();
    if (!this.currentTask) throw new Error('no current task');
    this.currentTask.cancel();
  }

  // canon stream.cancel-read: cancel a pending read on a stream end.
  // Returns packed result: CopyResult | (progress << 4)
  streamCancelRead(typeIdx: number, endIdx: number, _async: boolean): number {
    const end = this.getStreamEnd<ReadableStreamEnd>(typeIdx, endIdx);
    if (end.state !== CopyState.ASYNC_COPYING) {
      throw new Error('stream.cancel-read: end is not ASYNC_COPYING');
    }
    end.state = CopyState.CANCELLING_COPY;
    // If a rendezvous already happened (e.g. writeHost delivered data),
    // the event is already pending — don't cancel the other side's data.
    if (!end.hasPendingEvent()) {
      end.shared.cancel();
    }
    const event = end.getPendingEvent();
    if (!event) {
      throw new Error('stream.cancel-read: no event after cancel');
    }
    // Per spec: cancel converts COMPLETED to CANCELLED, preserving progress.
    // DROPPED is NOT converted (writer already dropped).
    const result = event.payload & 0xF;
    const progress = event.payload >> 4;
    if (result === CopyResult.COMPLETED) {
      return CopyResult.CANCELLED | (progress << 4);
    }
    return event.payload;
  }

  // canon stream.cancel-write: cancel a pending write on a stream end.
  // Returns packed result: CopyResult | (progress << 4)
  streamCancelWrite(typeIdx: number, endIdx: number, _async: boolean): number {
    const end = this.getStreamEnd<WritableStreamEnd>(typeIdx, endIdx);
    if (end.state !== CopyState.ASYNC_COPYING) {
      throw new Error('stream.cancel-write: end is not ASYNC_COPYING');
    }
    end.state = CopyState.CANCELLING_COPY;
    // If a rendezvous already happened, the event is already pending.
    if (!end.hasPendingEvent()) {
      end.shared.cancel();
    }
    const event = end.getPendingEvent();
    if (!event) {
      throw new Error('stream.cancel-write: no event after cancel');
    }
    // Per spec: cancel converts COMPLETED to CANCELLED, preserving progress.
    // DROPPED is NOT converted (reader already dropped).
    const result = event.payload & 0xF;
    const progress = event.payload >> 4;
    if (result === CopyResult.COMPLETED) {
      return CopyResult.CANCELLED | (progress << 4);
    }
    return event.payload;
  }

  // Stream end operations
  addStreamEnd(_typeIdx: number, end: StreamEnd): number {
    return this.handles.insert(end);
  }

  getStreamEnd<T extends StreamEnd>(_typeIdx: number, rep: number): T {
    const entry = this.handles.get(rep);
    if (!(entry instanceof StreamEnd)) throw new Error(`unknown stream end handle ${rep}`);
    return entry as T;
  }

  removeStreamEnd(_typeIdx: number, rep: number): StreamEnd {
    const entry = this.handles.remove(rep);
    if (!(entry instanceof StreamEnd)) throw new Error(`unknown stream end handle ${rep}`);
    return entry;
  }

  // Lift (transfer) a stream end: remove from this component's table and
  // check that it's not DONE before transferring to another component.
  liftStreamEnd(typeIdx: number, rep: number): StreamEnd {
    const entry = this.handles.get(rep);
    if (!(entry instanceof StreamEnd)) throw new Error(`unknown stream end handle ${rep}`);
    if (entry.state === CopyState.DONE) throw new Error(entry.liftDoneErrorMessage());
    return this.removeStreamEnd(typeIdx, rep);
  }

  // Lower an async import call: create a subtask, call host fn,
  // handle sync/async result. Returns packed i32: (handle << 4) | state.
  lowerImportAsync(hostResult: unknown): number {
    if (hostResult && typeof (hostResult as Promise<unknown>).then === 'function') {
      // Async: allocate a subtask handle and resolve when the Promise settles.
      const subtask = new Subtask();
      const handle = this.addSubtask(subtask);
      trace.log(this.componentIdx, 'lowerImportAsync', `subtask handle=${handle} async=true`);
      subtask.onStart();
      // Track the pending async operation so the event loop doesn't
      // falsely detect deadlock while the host Promise is in flight.
      if (this._eventLoop) this._eventLoop.addPendingAsync();
      (hostResult as Promise<unknown>).then(
        () => { subtask.onResolve(true); if (this._eventLoop) this._eventLoop.removePendingAsync(); },
        () => { subtask.onResolve(true); if (this._eventLoop) this._eventLoop.removePendingAsync(); },
      );
      // Return packed (handle << 4) | STARTED
      return (handle << 4) | subtask.getState();
    } else {
      // Sync: per the spec, no subtask handle is allocated for synchronous
      // completion. Just return the bare RETURNED constant (2).
      trace.log(this.componentIdx, 'lowerImportAsync', `subtask handle=none async=false`);
      return SubtaskState.RETURNED;
    }
  }

  // Track a host-side async operation so the event loop doesn't falsely
  // detect deadlock while it's in flight. Called by host implementations
  // (e.g., preview3-shim) that start background Promise chains.
  trackHostAsync(promise: Promise<unknown>): void {
    if (!this._eventLoop) return;
    this._eventLoop.addPendingAsync();
    promise.then(
      () => { this._eventLoop!.removePendingAsync(); },
      () => { this._eventLoop!.removePendingAsync(); },
    );
  }

  // Resource operations (canon builtins)

  // canon resource.new: create a new owned handle for a resource rep
  resourceNew(typeIdx: number, rep: number): number {
    this.checkMayLeave();
    const h = new ResourceHandle(typeIdx, rep, true);
    const idx = this.handles.insert(h);
    trace.log(this.componentIdx, 'resource.new', `typeIdx=${typeIdx} rep=${rep} → handle=${idx}`);
    return idx;
  }

  // canon resource.rep: get the representation value from a handle
  resourceRep(typeIdx: number, handle: number): number {
    trace.log(this.componentIdx, 'resource.rep', `typeIdx=${typeIdx} handle=${handle}`);
    // Note: spec does NOT check may_leave for resource.rep
    const h = this.handles.get(handle);
    if (!(h instanceof ResourceHandle)) {
      throw new Error(`wasm trap: unknown handle index ${handle}`);
    }
    if (h.typeIdx !== typeIdx) {
      throw new Error(`wasm trap: resource type mismatch`);
    }
    return h.rep;
  }

  // Per spec: lower_borrow — create a borrow handle and track it on the current task.
  // Called during parameter lowering when a borrow resource is passed to a callee.
  addBorrowHandle(typeIdx: number, rep: number): number {
    const h = new ResourceHandle(typeIdx, rep, false);
    h.borrowTask = this.currentTask;
    if (this.currentTask) {
      this.currentTask.numBorrows += 1;
    }
    return this.handles.insert(h);
  }

  // canon resource.drop: remove a handle from the table and call destructor if own.
  // dtor is the destructor function (core wasm function from the defining component).
  // Per spec: if h.own and rt.dtor, call dtor(rep).
  resourceDrop(typeIdx: number, handle: number, dtor?: (rep: number) => void): void {
    this.checkMayLeave();
    trace.log(this.componentIdx, 'resource.drop', `typeIdx=${typeIdx} handle=${handle}`);
    const h = this.handles.remove(handle);
    if (!(h instanceof ResourceHandle)) {
      throw new Error(`wasm trap: unknown handle index ${handle}`);
    }
    if (h.typeIdx !== typeIdx) {
      throw new Error(`wasm trap: resource type mismatch`);
    }
    // Per spec: trap_if(h.num_lends != 0) — cannot drop a resource
    // while it's lent to a callee via a subtask.
    if (h.numLends !== 0) {
      throw new Error(`wasm trap: cannot drop resource with ${h.numLends} outstanding lend(s)`);
    }
    if (h.own) {
      if (dtor) {
        dtor(h.rep);
      }
    } else if (h.borrowTask) {
      // Per spec: dropping a borrow decrements the borrow scope's counter.
      h.borrowTask.numBorrows -= 1;
    }
  }

  // Remove a resource handle from this instance's table, returning it.
  // Used by resource.transfer-own.
  removeResourceHandle(handle: number): ResourceHandle {
    const h = this.handles.remove(handle);
    if (!(h instanceof ResourceHandle)) {
      throw new Error(`wasm trap: unknown handle index ${handle}`);
    }
    return h;
  }

  // Add a resource handle to this instance's table.
  // Used by resource.transfer-own/borrow.
  addResourceHandle(h: ResourceHandle): number {
    return this.handles.insert(h);
  }

  // Add a resource handle with a remapped type index.
  // Used by resource.transfer-own/borrow when the destination's table index
  // differs from the source's (each component has its own numbering).
  addResourceHandleAs(dstTypeIdx: number, h: ResourceHandle): number {
    const remapped = new ResourceHandle(dstTypeIdx, h.rep, h.own);
    return this.handles.insert(remapped);
  }

  // Get a resource handle without removing it (for borrows).
  getResourceHandle(handle: number): ResourceHandle {
    const h = this.handles.get(handle);
    if (!(h instanceof ResourceHandle)) {
      throw new Error(`wasm trap: unknown handle index ${handle}`);
    }
    trace.log(this.componentIdx, 'resource.get', `handle=${handle} → rep=${h.rep} typeIdx=${h.typeIdx}`);
    return h;
  }

  // Stream operations (canon builtins)

  // canon stream.new: create a stream pair, return packed i64
  // Lower 32 bits = readable end handle, upper 32 bits = writable end handle
  streamNew(typeIdx: number): bigint {
    this.checkMayLeave();
    const { readable, writable } = createStream();
    const ri = this.addStreamEnd(typeIdx, readable);
    const wi = this.addStreamEnd(typeIdx, writable);
    const result = BigInt(ri) | (BigInt(wi) << 32n);
    trace.logResult(this.componentIdx, 'stream.new', `r=${ri} w=${wi}`);
    return result;
  }

  // canon stream.read (callback mode): read from stream into wasm memory.
  // Returns packed i32: result | (progress << 4), or BLOCKED (0xFFFFFFFF).
  streamReadAsync(
    typeIdx: number,
    endIdx: number,
    memory: WebAssembly.Memory,
    ptr: number,
    count: number,
    elemSize: number,
    storeFn?: StreamStoreFn,
  ): number {
    trace.log(this.componentIdx, 'stream.read', endIdx, ptr, count);
    const end = this.getStreamEnd<ReadableStreamEnd>(typeIdx, endIdx);
    const buffer = new WasmWritableBuffer(memory, ptr, count, elemSize, storeFn);
    const result = streamCopyAsync(
      end, EventCode.STREAM_READ, endIdx, buffer,
      (buf: StreamBuffer, onCopy: OnCopy, onCopyDone: OnCopyDone) =>
        end.copy(buf as WritableStreamBuffer, onCopy, onCopyDone),
    );
    if (result === null) {
      trace.logResult(this.componentIdx, 'stream.read', 'BLOCKED');
      return BLOCKED;
    }
    trace.logResult(this.componentIdx, 'stream.read', result);
    return result;
  }

  // canon stream.read (JSPI mode): read from stream into wasm memory.
  // Returns packed i32 or Promise<number> (JSPI suspends the wasm).
  streamReadSync(
    typeIdx: number,
    endIdx: number,
    memory: WebAssembly.Memory,
    ptr: number,
    count: number,
    elemSize: number,
    storeFn?: StreamStoreFn,
  ): number | Promise<number> {
    trace.log(this.componentIdx, 'stream.read', endIdx, ptr, count);
    const end = this.getStreamEnd<ReadableStreamEnd>(typeIdx, endIdx);
    const buffer = new WasmWritableBuffer(memory, ptr, count, elemSize, storeFn);
    const result = streamCopySync(
      end, EventCode.STREAM_READ, endIdx, buffer,
      (buf: StreamBuffer, onCopy: OnCopy, onCopyDone: OnCopyDone) =>
        end.copy(buf as WritableStreamBuffer, onCopy, onCopyDone),
    );
    if (result instanceof Promise) {
      return result.then(r => {
        trace.logResult(this.componentIdx, 'stream.read', `${r} (sync-blocked)`);
        return r;
      });
    }
    trace.logResult(this.componentIdx, 'stream.read', result);
    return result;
  }

  // canon stream.write (callback mode): write from wasm memory into stream.
  // Returns packed i32: result | (progress << 4), or BLOCKED (0xFFFFFFFF).
  streamWriteAsync(
    typeIdx: number,
    endIdx: number,
    memory: WebAssembly.Memory,
    ptr: number,
    count: number,
    elemSize: number,
  ): number {
    trace.log(this.componentIdx, 'stream.write', endIdx, ptr, count);
    const end = this.getStreamEnd<WritableStreamEnd>(typeIdx, endIdx);
    const buffer = new WasmReadableBuffer(memory, ptr, count, elemSize);
    const result = streamCopyAsync(
      end, EventCode.STREAM_WRITE, endIdx, buffer,
      (buf: StreamBuffer, onCopy: OnCopy, onCopyDone: OnCopyDone) =>
        end.copy(buf as ReadableStreamBuffer, onCopy, onCopyDone),
    );
    if (result === null) {
      trace.logResult(this.componentIdx, 'stream.write', 'BLOCKED');
      return BLOCKED;
    }
    trace.logResult(this.componentIdx, 'stream.write', result);
    return result;
  }

  // canon stream.write (JSPI mode): write from wasm memory into stream.
  // Returns packed i32 or Promise<number> (JSPI suspends the wasm).
  streamWriteSync(
    typeIdx: number,
    endIdx: number,
    memory: WebAssembly.Memory,
    ptr: number,
    count: number,
    elemSize: number,
  ): number | Promise<number> {
    trace.log(this.componentIdx, 'stream.write', endIdx, ptr, count);
    const end = this.getStreamEnd<WritableStreamEnd>(typeIdx, endIdx);
    const buffer = new WasmReadableBuffer(memory, ptr, count, elemSize);
    const result = streamCopySync(
      end, EventCode.STREAM_WRITE, endIdx, buffer,
      (buf: StreamBuffer, onCopy: OnCopy, onCopyDone: OnCopyDone) =>
        end.copy(buf as ReadableStreamBuffer, onCopy, onCopyDone),
    );
    if (result instanceof Promise) {
      return result.then(r => {
        trace.logResult(this.componentIdx, 'stream.write', `${r} (sync-blocked)`);
        return r;
      });
    }
    trace.logResult(this.componentIdx, 'stream.write', result);
    return result;
  }

  // canon stream.read for resource-carrying streams.
  // Instead of copying raw bytes, lifts ResourceHandle objects from the
  // rendezvous and lowers them into this component's handle table.
  streamReadResources(
    typeIdx: number,
    endIdx: number,
    memory: WebAssembly.Memory,
    ptr: number,
    count: number,
  ): number {
    trace.log(this.componentIdx, 'stream.read(resource)', endIdx, ptr, count);
    const end = this.getStreamEnd<ReadableStreamEnd>(typeIdx, endIdx);
    const buffer = new ResourceWritableBuffer(this, memory, ptr, count, typeIdx);
    // Always callback mode for resource streams
    const result = streamCopyAsync(
      end, EventCode.STREAM_READ, endIdx, buffer,
      (buf: StreamBuffer, onCopy: OnCopy, onCopyDone: OnCopyDone) =>
        end.copy(buf as WritableStreamBuffer, onCopy, onCopyDone),
    );
    if (result === null) {
      trace.logResult(this.componentIdx, 'stream.read(resource)', 'BLOCKED');
      return BLOCKED;
    }
    trace.logResult(this.componentIdx, 'stream.read(resource)', result);
    return result;
  }

  // canon stream.write for resource-carrying streams.
  // Instead of copying raw bytes, lifts handle indices from wasm memory
  // as ResourceHandle objects for the rendezvous to transfer ownership.
  streamWriteResources(
    typeIdx: number,
    endIdx: number,
    memory: WebAssembly.Memory,
    ptr: number,
    count: number,
  ): number {
    trace.log(this.componentIdx, 'stream.write(resource)', endIdx, ptr, count);
    const end = this.getStreamEnd<WritableStreamEnd>(typeIdx, endIdx);
    const buffer = new ResourceReadableBuffer(this, memory, ptr, count);
    // Always callback mode for resource streams
    const result = streamCopyAsync(
      end, EventCode.STREAM_WRITE, endIdx, buffer,
      (buf: StreamBuffer, onCopy: OnCopy, onCopyDone: OnCopyDone) =>
        end.copy(buf as ReadableStreamBuffer, onCopy, onCopyDone),
    );
    if (result === null) {
      trace.logResult(this.componentIdx, 'stream.write(resource)', 'BLOCKED');
      return BLOCKED;
    }
    trace.logResult(this.componentIdx, 'stream.write(resource)', result);
    return result;
  }

  // canon stream.drop-readable
  streamDropReadable(typeIdx: number, endIdx: number): void {
    trace.log(this.componentIdx, 'stream.drop-readable', endIdx);
    const entry = this.handles.get(endIdx);
    if (!(entry instanceof StreamEnd)) {
      // Handle was already transferred (e.g., lifted by a host function).
      // The canonical ABI's cleanup drop is a no-op in this case.
      return;
    }
    this.handles.remove(endIdx);
    entry.drop();
  }

  // canon stream.drop-writable
  streamDropWritable(typeIdx: number, endIdx: number): void {
    trace.log(this.componentIdx, 'stream.drop-writable', endIdx);
    const end = this.removeStreamEnd(typeIdx, endIdx);
    end.drop();
  }

  // Future end operations
  addFutureEnd(_typeIdx: number, end: FutureEnd): number {
    return this.handles.insert(end);
  }

  getFutureEnd<T extends FutureEnd>(_typeIdx: number, rep: number): T {
    const entry = this.handles.get(rep);
    if (!(entry instanceof FutureEnd)) throw new Error(`unknown future end handle ${rep}`);
    return entry as T;
  }

  removeFutureEnd(_typeIdx: number, rep: number): FutureEnd {
    const entry = this.handles.get(rep);
    if (!(entry instanceof FutureEnd)) throw new Error(`unknown future end handle ${rep}`);
    this.handles.remove(rep);
    return entry;
  }

  // Lift (transfer) a future end: remove from this component's table and
  // check that it's not DONE before transferring to another component.
  liftFutureEnd(typeIdx: number, rep: number): FutureEnd {
    const entry = this.handles.get(rep);
    if (!(entry instanceof FutureEnd)) throw new Error(`unknown future end handle ${rep}`);
    if (entry.state === CopyState.DONE) throw new Error(entry.liftDoneErrorMessage());
    return this.removeFutureEnd(typeIdx, rep);
  }

  // Future operations (canon builtins)

  // canon future.new: create a future pair, return packed i64
  // Lower 32 bits = readable end handle, upper 32 bits = writable end handle
  futureNew(typeIdx: number): bigint {
    this.checkMayLeave();
    const { readable, writable } = createFuture();
    const ri = this.addFutureEnd(typeIdx, readable);
    const wi = this.addFutureEnd(typeIdx, writable);
    trace.logResult(this.componentIdx, 'future.new', `r=${ri} w=${wi}`);
    return BigInt(ri) | (BigInt(wi) << 32n);
  }

  // canon future.read (callback mode): read from future into wasm memory.
  // Returns packed i32: result, or BLOCKED (0xFFFFFFFF).
  futureReadAsync(
    typeIdx: number,
    endIdx: number,
    memory: WebAssembly.Memory,
    ptr: number,
    elemSize: number,
    storeFn?: StreamStoreFn,
  ): number {
    trace.log(this.componentIdx, 'future.read', endIdx, ptr, elemSize);
    const end = this.getFutureEnd<ReadableFutureEnd>(typeIdx, endIdx);
    const count = elemSize > 0 ? 1 : 0;
    const buffer = new WasmWritableBuffer(memory, ptr, count, elemSize, storeFn);
    const result = futureCopyAsync(
      end, EventCode.FUTURE_READ, endIdx, buffer,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        end.copy(buf as WritableStreamBuffer, onCopyDone),
    );
    if (result === null) {
      trace.logResult(this.componentIdx, 'future.read', 'BLOCKED');
      return BLOCKED;
    }
    trace.logResult(this.componentIdx, 'future.read', result);
    return result;
  }

  // canon future.read (JSPI mode): read from future into wasm memory.
  // Returns packed i32 or Promise<number> (JSPI suspends the wasm).
  futureReadSync(
    typeIdx: number,
    endIdx: number,
    memory: WebAssembly.Memory,
    ptr: number,
    elemSize: number,
    storeFn?: StreamStoreFn,
  ): number | Promise<number> {
    trace.log(this.componentIdx, 'future.read', endIdx, ptr, elemSize);
    const end = this.getFutureEnd<ReadableFutureEnd>(typeIdx, endIdx);
    const count = elemSize > 0 ? 1 : 0;
    const buffer = new WasmWritableBuffer(memory, ptr, count, elemSize, storeFn);
    const result = futureCopySync(
      end, EventCode.FUTURE_READ, endIdx, buffer,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        end.copy(buf as WritableStreamBuffer, onCopyDone),
    );
    if (result instanceof Promise) {
      return result.then(r => {
        trace.logResult(this.componentIdx, 'future.read', `${r} (sync-blocked)`);
        return r;
      });
    }
    trace.logResult(this.componentIdx, 'future.read', result);
    return result;
  }

  // canon future.write (callback mode): write from wasm memory into future.
  // Returns result, or BLOCKED (0xFFFFFFFF).
  futureWriteAsync(
    typeIdx: number,
    endIdx: number,
    memory: WebAssembly.Memory,
    ptr: number,
    elemSize: number,
    loadFn?: StreamLoadFn,
  ): number {
    trace.log(this.componentIdx, 'future.write', endIdx, ptr, elemSize);
    const end = this.getFutureEnd<WritableFutureEnd>(typeIdx, endIdx);
    const count = elemSize > 0 ? 1 : 0;
    const buffer = new WasmReadableBuffer(memory, ptr, count, elemSize, loadFn);
    const result = futureCopyAsync(
      end, EventCode.FUTURE_WRITE, endIdx, buffer,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        end.copy(buf as ReadableStreamBuffer, onCopyDone),
    );
    if (result === null) {
      trace.logResult(this.componentIdx, 'future.write', 'BLOCKED');
      return BLOCKED;
    }
    trace.logResult(this.componentIdx, 'future.write', result);
    return result;
  }

  // canon future.write (JSPI mode): write from wasm memory into future.
  // Returns result or Promise<number> (JSPI suspends the wasm).
  futureWriteSync(
    typeIdx: number,
    endIdx: number,
    memory: WebAssembly.Memory,
    ptr: number,
    elemSize: number,
    loadFn?: StreamLoadFn,
  ): number | Promise<number> {
    trace.log(this.componentIdx, 'future.write', endIdx, ptr, elemSize);
    const end = this.getFutureEnd<WritableFutureEnd>(typeIdx, endIdx);
    const count = elemSize > 0 ? 1 : 0;
    const buffer = new WasmReadableBuffer(memory, ptr, count, elemSize, loadFn);
    const result = futureCopySync(
      end, EventCode.FUTURE_WRITE, endIdx, buffer,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        end.copy(buf as ReadableStreamBuffer, onCopyDone),
    );
    if (result instanceof Promise) {
      return result.then(r => {
        trace.logResult(this.componentIdx, 'future.write', `${r} (sync-blocked)`);
        return r;
      });
    }
    trace.logResult(this.componentIdx, 'future.write', result);
    return result;
  }

  // Host-side future write: write items to a future writable end without wasm memory.
  // Used by host implementations that need to resolve futures they created via futureNew.
  // Also frees the writable handle — futures are one-shot, so the host is done after writing.
  // The shared state stays alive through the readable end held by the guest.
  futureWriteHost(typeIdx: number, endIdx: number, items: unknown[]): void {
    const end = this.getFutureEnd<WritableFutureEnd>(typeIdx, endIdx);
    const buffer = new HostReadableBuffer(items);
    end.copy(buffer, () => {});
    // Free handle slot without calling end.drop() (which would discard
    // pending data if the reader hasn't consumed it yet).
    this.handles.remove(endIdx);
  }

  // Host-side stream write: write items to a stream writable end without wasm memory.
  // Used by host implementations (e.g., filesystem read, socket accept) that need to
  // push data into streams they created via streamNew.
  streamWriteHost(typeIdx: number, endIdx: number, items: unknown[], onConsumed?: () => void): void {
    const end = this.getStreamEnd<WritableStreamEnd>(typeIdx, endIdx);
    const buffer = new HostReadableBuffer(items);
    end.shared.writeHost(buffer, onConsumed);
  }

  // Host-side stream write with a custom ReadableStreamBuffer (lazy/on-demand reading).
  // Used by filesystem read-via-stream to read from the file only when the guest consumes data.
  streamWriteHostBuffer(typeIdx: number, endIdx: number, buffer: ReadableStreamBuffer, onConsumed?: () => void): void {
    const end = this.getStreamEnd<WritableStreamEnd>(typeIdx, endIdx);
    end.shared.writeHost(buffer, onConsumed);
  }

  // Register a callback on a stream's shared state that fires when either end drops.
  // Used by host code (e.g., socket receive) to detect when the guest drops the readable end.
  streamOnDropped(typeIdx: number, endIdx: number, cb: () => void): void {
    const end = this.getStreamEnd(typeIdx, endIdx);
    end.shared.onDropped = cb;
  }

  // canon future.cancel-read
  futureCancelRead(typeIdx: number, endIdx: number, _async: boolean): number {
    const end = this.getFutureEnd<ReadableFutureEnd>(typeIdx, endIdx);
    if (end.state !== CopyState.ASYNC_COPYING) {
      throw new Error('future.cancel-read: end is not ASYNC_COPYING');
    }
    end.state = CopyState.CANCELLING_COPY;
    end.shared.cancel();
    const event = end.getPendingEvent();
    if (!event) {
      throw new Error('future.cancel-read: no event after cancel');
    }
    return event.payload;
  }

  // canon future.cancel-write
  futureCancelWrite(typeIdx: number, endIdx: number, _async: boolean): number {
    const end = this.getFutureEnd<WritableFutureEnd>(typeIdx, endIdx);
    if (end.state !== CopyState.ASYNC_COPYING) {
      throw new Error('future.cancel-write: end is not ASYNC_COPYING');
    }
    end.state = CopyState.CANCELLING_COPY;
    end.shared.cancel();
    const event = end.getPendingEvent();
    if (!event) {
      throw new Error('future.cancel-write: no event after cancel');
    }
    return event.payload;
  }

  // canon future.drop-readable
  futureDropReadable(typeIdx: number, endIdx: number): void {
    trace.log(this.componentIdx, 'future.drop-readable', endIdx);
    const entry = this.handles.get(endIdx);
    if (!(entry instanceof FutureEnd)) {
      // Handle was already transferred (e.g., lifted by a host function).
      return;
    }
    this.handles.remove(endIdx);
    entry.drop();
  }

  // canon future.drop-writable
  futureDropWritable(typeIdx: number, endIdx: number): void {
    trace.log(this.componentIdx, 'future.drop-writable', endIdx);
    const end = this.removeFutureEnd(typeIdx, endIdx);
    end.drop();
  }

  // canon waitable-set.wait: poll for event, write to memory.
  // Returns event code. When no event is available, returns a Promise
  // (requires JSPI: the import must be wrapped with WebAssembly.Suspending
  // and the export with WebAssembly.promising).
  waitableSetWait(memory: WebAssembly.Memory, wsIdx: number, ptr: number): number | Promise<number> {
    this.checkMayLeave();
    trace.log(this.componentIdx, 'waitable-set.wait', wsIdx, ptr);
    const ws = this.getWaitableSet(wsIdx);
    const event = ws.poll();
    if (event.code !== EventCode.NONE) {
      // Event available synchronously — no suspension needed
      const view = new DataView(memory.buffer);
      view.setUint32(ptr, event.index, true);
      view.setUint32(ptr + 4, event.payload, true);
      trace.logResult(this.componentIdx, 'waitable-set.wait', `code=${event.code} idx=${event.index} payload=${event.payload}`);
      return event.code;
    }
    // No event available — need to suspend.
    // Per spec: trap_if(not task.may_block()). A sync-lifted task (mayBlock=false)
    // or a top-level sync export (no currentTask) cannot block.
    if (!this.currentTask?.mayBlock) {
      throw new Error('cannot block a synchronous task before returning');
    }
    // Suspend via JSPI (Promise return)
    const task = this.currentTask;
    if (task) task.setSuspendedInBuiltin(true);
    return ws.wait().then(evt => {
      if (task) task.setSuspendedInBuiltin(false);
      const view = new DataView(memory.buffer);
      view.setUint32(ptr, evt.index, true);
      view.setUint32(ptr + 4, evt.payload, true);
      trace.logResult(this.componentIdx, 'waitable-set.wait', `code=${evt.code} idx=${evt.index} payload=${evt.payload} (async)`);
      return evt.code;
    });
  }

  // canon waitable-set.wait cancellable: like wait but races against cancel_pending.
  // Per spec: if cancel_pending, returns TASK_CANCELLED immediately.
  // Otherwise blocks until an event is available or cancellation is requested.
  waitableSetWaitCancellable(memory: WebAssembly.Memory, wsIdx: number, ptr: number): number | Promise<number> {
    this.checkMayLeave();
    trace.log(this.componentIdx, 'waitable-set.wait-cancellable', wsIdx, ptr);
    const task = this.currentTask;
    // Check for pending cancel first (synchronous path)
    if (task && task.consumeCancelPending()) {
      const view = new DataView(memory.buffer);
      view.setUint32(ptr, 0, true);
      view.setUint32(ptr + 4, 0, true);
      trace.logResult(this.componentIdx, 'waitable-set.wait-cancellable', 'TASK_CANCELLED (pending)');
      return EventCode.TASK_CANCELLED;
    }
    const ws = this.getWaitableSet(wsIdx);
    const event = ws.poll();
    if (event.code !== EventCode.NONE) {
      const view = new DataView(memory.buffer);
      view.setUint32(ptr, event.index, true);
      view.setUint32(ptr + 4, event.payload, true);
      trace.logResult(this.componentIdx, 'waitable-set.wait-cancellable', `code=${event.code}`);
      return event.code;
    }
    if (!task?.mayBlock) {
      throw new Error('cannot block a synchronous task before returning');
    }
    // Mark task as cancellable while waiting.
    // Race between ws.wait() and cancellation. If cancel wins, the orphaned
    // ws.wait() may eventually consume an event — this is acceptable because
    // the task is being cancelled and won't process further events.
    task.setCancellable(true);
    task.setSuspendedInBuiltin(true);
    const waitPromise = ws.wait().then(evt => ({ kind: 'event' as const, evt }));
    const cancelPromise = task.getCancelPromise().then(() => ({ kind: 'cancel' as const, evt: null as null }));
    return Promise.race([waitPromise, cancelPromise]).then(result => {
      task.setCancellable(false);
      task.setSuspendedInBuiltin(false);
      const view = new DataView(memory.buffer);
      if (result.kind === 'cancel') {
        // Swallow the orphaned ws.wait() when it eventually resolves/rejects
        waitPromise.catch(() => {});
        task.consumeCancelPending();
        view.setUint32(ptr, 0, true);
        view.setUint32(ptr + 4, 0, true);
        trace.logResult(this.componentIdx, 'waitable-set.wait-cancellable', 'TASK_CANCELLED (async)');
        return EventCode.TASK_CANCELLED;
      }
      const evt = result.evt!;
      view.setUint32(ptr, evt.index, true);
      view.setUint32(ptr + 4, evt.payload, true);
      trace.logResult(this.componentIdx, 'waitable-set.wait-cancellable', `code=${evt.code} (async)`);
      return evt.code;
    });
  }

  // canon waitable-set.poll: synchronous poll + write event to memory.
  // Per spec: returns event code. Writes [index, payload] to memory at ptr.
  // Returns EventCode.NONE (0) if no events available.
  waitableSetPoll(memory: WebAssembly.Memory, wsIdx: number, ptr: number): number {
    this.checkMayLeave();
    const ws = this.getWaitableSet(wsIdx);
    const event = ws.poll();
    const view = new DataView(memory.buffer);
    view.setUint32(ptr, event.index, true);
    view.setUint32(ptr + 4, event.payload, true);
    return event.code;
  }

  // canon waitable-set.poll cancellable: like poll but checks cancel_pending first.
  // Per spec: if cancel_pending, returns TASK_CANCELLED event.
  //
  // When there are no events and no cancel_pending, this returns a Promise
  // that defers to the next microtask. This matches the spec's Thread model
  // where the callee is deferred — it ensures the caller has a chance to call
  // subtask.cancel (setting cancel_pending) before the callee sees the result.
  // The trampoline wraps this with suspending() so V8 can suspend the callee.
  waitableSetPollCancellable(memory: WebAssembly.Memory, wsIdx: number, ptr: number): number | Promise<number> {
    this.checkMayLeave();
    const task = this.currentTask;
    if (task && task.consumeCancelPending()) {
      const view = new DataView(memory.buffer);
      view.setUint32(ptr, 0, true);
      view.setUint32(ptr + 4, 0, true);
      return EventCode.TASK_CANCELLED;
    }
    const ws = this.getWaitableSet(wsIdx);
    const event = ws.poll();
    if (event.code !== EventCode.NONE) {
      const view = new DataView(memory.buffer);
      view.setUint32(ptr, event.index, true);
      view.setUint32(ptr + 4, event.payload, true);
      return event.code;
    }
    // No events and no cancel_pending. Defer to next microtask so the caller
    // can set cancel_pending before we return. Mark as cancellable so
    // subtask.cancel can await our resolution.
    if (task) {
      task.setCancellable(true);
      task.setSuspendedInBuiltin(true);
      return Promise.resolve().then(() => {
        task.setCancellable(false);
        task.setSuspendedInBuiltin(false);
        if (task.consumeCancelPending()) {
          const view = new DataView(memory.buffer);
          view.setUint32(ptr, 0, true);
          view.setUint32(ptr + 4, 0, true);
          return EventCode.TASK_CANCELLED;
        }
        const view = new DataView(memory.buffer);
        view.setUint32(ptr, 0, true);
        view.setUint32(ptr + 4, 0, true);
        return EventCode.NONE;
      });
    }
    const view = new DataView(memory.buffer);
    view.setUint32(ptr, 0, true);
    view.setUint32(ptr + 4, 0, true);
    return EventCode.NONE;
  }

  // canon thread.yield cancellable: yields execution, checks for pending cancel.
  // Per spec: returns SuspendResult (0 = NOT_CANCELLED, 1 = CANCELLED).
  // If cancel_pending, returns CANCELLED immediately without yielding.
  async threadYieldCancellable(): Promise<number> {
    const task = this.currentTask;
    if (task && task.consumeCancelPending()) {
      return 1; // CANCELLED
    }
    // Mark as cancellable during the yield so subtask.cancel can await us.
    if (task) { task.setCancellable(true); task.setSuspendedInBuiltin(true); }
    // Yield to next microtask (matches spec's thread.yield semantics)
    await Promise.resolve();
    if (task) { task.setCancellable(false); task.setSuspendedInBuiltin(false); }
    // Check for cancel that arrived during the yield
    if (task && task.consumeCancelPending()) {
      return 1; // CANCELLED
    }
    return 0; // NOT_CANCELLED
  }

  // Context get/set (per spec: task.context_get/set)
  contextGet(slot: number): number {
    this.checkMayLeave();
    if (!this.currentTask) throw new Error('no current task');
    return this.currentTask.contextGet(slot);
  }

  contextSet(slot: number, value: number): void {
    this.checkMayLeave();
    if (!this.currentTask) throw new Error('no current task');
    this.currentTask.contextSet(slot, value);
  }

  // Run an async export. Sets up the task context, calls the core function,
  // and if a callback is provided, adds the task to the event loop until EXIT.
  //
  // Without a callback, the component uses blocking builtins (waitable-set.wait)
  // instead of callback-based control flow. This requires JSPI: the core function
  // is wrapped with WebAssembly.promising so it can suspend on blocking imports.
  async runAsyncExport(
    coreFn: Function,
    callbackFn?: (eventCode: number, p1: number, p2: number) => number | Promise<number>,
    eventLoop?: EventLoop,
    args: unknown[] = [],
  ): Promise<unknown> {
    if (!this.enter()) {
      throw new Error('wasm trap: cannot enter component instance');
    }
    const task = new AsyncTask();
    // Per spec: may_block() returns ft.async_ || state == RESOLVED.
    // Async-lifted exports always have ft.async_ = true, so may_block() is true.
    task.mayBlock = true;
    const el = eventLoop ?? this._eventLoop;
    if (el) task.notifyFn = () => el.wake();
    this.currentTask = task;
    // Per spec: needs_exclusive() = !async_ || callback. Async exports without
    // a callback (pure JSPI) do NOT hold the exclusive lock, allowing concurrent
    // async tasks within the same component.
    const needsExclusive = !!callbackFn;
    if (needsExclusive) this.acquireExclusive();
    try {
      if (callbackFn) {
        // Callback mode: wasm returns a callback code (EXIT/YIELD/WAIT).
        let initialResult: number;
        if (jspiMode) {
          // JSPI mode: wrap with promising() so the initial wasm call
          // can suspend on suspending imports (like waitable-set.wait).
          const wrappedCoreFn = promising(coreFn);
          initialResult = await (wrappedCoreFn as (...a: unknown[]) => Promise<number>)(...args);
        } else {
          // Callback-only mode: call directly, no JSPI wrapping needed.
          initialResult = await Promise.resolve((coreFn as (...a: unknown[]) => number | Promise<number>)(...args));
        }
        if (eventLoop) {
          // addTask releases exclusive and leaves for YIELD/WAIT, so clear
          // the currentTask marker to prevent double-cleanup in finally.
          const code = initialResult & 0xf;
          if (code !== 0) {
            // YIELD or WAIT: addTask takes ownership of lifecycle
            this.currentTask = null;
          }
          await eventLoop.addTask(task, this, callbackFn, initialResult);
        } else {
          // Fallback for unit tests: handle EXIT inline.
          // YIELD/WAIT without an event loop is not supported.
          const code = initialResult & 0xf;
          if (code !== 0) {
            throw new Error('runAsyncExport: YIELD/WAIT requires an EventLoop');
          }
        }
      } else {
        // No callback: use JSPI to suspend on blocking builtins.
        // promising() wraps the wasm export so it returns a Promise
        // when the wasm suspends (e.g., on waitable-set.wait).
        const wrappedFn = promising(coreFn);
        const returnValue = await (wrappedFn as (...a: unknown[]) => Promise<unknown>)(...args);
        if (!task.isResolved()) {
          task.resolve(returnValue);
        }
      }
    } finally {
      // Only clean up if the event loop didn't take ownership.
      // When the event loop runs the task (YIELD/WAIT), it handles
      // exclusive/leave/currentTask via _handleResult on EXIT.
      if (this.currentTask === task) {
        if (needsExclusive) this.releaseExclusive();
        this.currentTask = null;
        this.leave();
      }
    }
    return task.getResult();
  }

  // Run a sync export. Handles reentrancy guard via instance flags.
  // When jspiMode is enabled, wraps the export with promising() so that
  // suspending() imports (used in cross-component adapter calls) can suspend.
  runSyncExport(coreFn: Function, args: unknown[] = []): unknown | Promise<unknown> {
    if (!this.enter()) {
      throw new Error('wasm trap: cannot enter component instance');
    }
    if (jspiMode) {
      const promisingFn = promising(coreFn) as (...a: unknown[]) => Promise<unknown>;
      return promisingFn(...args).then(
        (result) => { this.leave(); return result; },
        (err) => { this.leave(); throw err; },
      );
    }
    try {
      return (coreFn as (...a: unknown[]) => unknown)(...args);
    } finally {
      this.leave();
    }
  }

  // Per spec: trap_if(opts.sync and not task.may_block()).
  // A synchronous task (no currentTask) cannot block.
  // Called by sync canon builtins before any blocking operation.
  checkSyncBlock(): void {
    if (!this.currentTask?.mayBlock) {
      throw new Error('cannot block a synchronous task before returning');
    }
  }

  // --- Thread builtins ---

  // Fiber state for cooperative threading via JSPI.
  // Index 0 = main thread (implicitly exists). Indices 1+ are created threads.
  private _threads: Array<{
    startFn: (() => Promise<void>) | null;
    resume: ((value: number) => void) | null;
    started: boolean;
  }> = [{ startFn: null, resume: null, started: true }]; // thread 0 = main

  // Track current executing thread index (0 = main thread)
  private _currentThread: number = 0;

  // canon thread.new-indirect: create a new suspended thread from an indirect function table
  threadNewIndirect(table: WebAssembly.Table, funcIdx: number, arg: number): number {
    const fn = table.get(funcIdx) as Function;
    const idx = this._threads.length;
    const self = this;
    this._threads.push({
      startFn: () => {
        const prevThread = self._currentThread;
        self._currentThread = idx;
        const pFn = promising(fn) as (arg: number) => Promise<void>;
        return pFn(arg).then(() => {
          self._currentThread = prevThread;
        });
      },
      resume: null,
      started: false,
    });
    return idx;
  }

  // canon thread.suspend: suspend the current thread.
  // Always blocks — traps if in sync context.
  threadSuspend(): number | Promise<number> {
    this.checkSyncBlock();
    const currentIdx = this._currentThread;
    return new Promise<number>((resolve) => {
      this._threads[currentIdx]!.resume = resolve;
    });
  }

  // canon thread.switch-to: atomically suspend current and resume target thread.
  threadSwitchTo(targetIdx: number): number | Promise<number> {
    const target = this._threads[targetIdx];
    if (!target) throw new Error(`invalid thread index: ${targetIdx}`);

    const currentIdx = this._currentThread;

    return new Promise<number>((resolve) => {
      // Save current thread's resume callback
      this._threads[currentIdx]!.resume = resolve;

      if (!target.started) {
        // Start the target for the first time
        target.started = true;
        target.startFn!().then(() => {
          // Target completed — resume the thread that was waiting for it
          const current = this._threads[currentIdx]!;
          if (current.resume) {
            const r = current.resume;
            current.resume = null;
            r(0);
          }
        });
      } else if (target.resume) {
        // Target is suspended — resume it
        const r = target.resume;
        target.resume = null;
        r(0);
      }
    });
  }

  // canon thread.yield-to: yield to suspended target thread, resume when it suspends/exits.
  threadYieldTo(targetIdx: number): number | Promise<number> {
    const target = this._threads[targetIdx];
    if (!target) throw new Error(`invalid thread index: ${targetIdx}`);

    const currentIdx = this._currentThread;

    if (!target.started) {
      // Start target and wait for it to complete
      target.started = true;
      return target.startFn!().then(() => 0);
    }
    if (target.resume) {
      // Resume a suspended target
      const r = target.resume;
      target.resume = null;
      return new Promise<number>((resolve) => {
        this._threads[currentIdx]!.resume = resolve;
        r(0);
      });
    }
    // Target already running or completed — just yield
    return Promise.resolve(0);
  }

  // canon thread.resume-later: mark a suspended thread as ready (non-blocking).
  threadResumeLater(targetIdx: number): void {
    const target = this._threads[targetIdx];
    if (!target) throw new Error(`invalid thread index: ${targetIdx}`);

    if (!target.started) {
      // Start the thread in the background (fire-and-forget)
      target.started = true;
      target.startFn!();
    } else if (target.resume) {
      // Resume a suspended thread
      const r = target.resume;
      target.resume = null;
      r(0);
    }
  }

}
