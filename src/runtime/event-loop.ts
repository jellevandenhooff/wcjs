import { CallbackCode, EventCode, unpackCallbackResult } from './types.ts';
import type { EventTuple } from './types.ts';
import type { ComponentState } from './component-state.ts';
import type { AsyncTask } from './task.ts';
import { trace } from './trace.ts';

// Yield to the next macrotask, ensuring all pending microtasks are drained.
//
// Cross-component JSPI calls create multi-level microtask chains for event
// delivery (Promise resolution → JSPI wasm resumption → subtask completion →
// wake). A single `await Promise.resolve()` only drains one microtask level.
// A macrotask boundary guarantees ALL microtasks complete before we resume.
//
// Uses MessageChannel (available in Node.js 15+ and all modern browsers) for
// near-zero overhead — no timer delay like setTimeout. Same mechanism React
// uses for task scheduling.
function nextMacrotask(): Promise<void> {
  if (typeof MessageChannel !== 'undefined') {
    return new Promise(resolve => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(null);
    });
  }
  // Fallback for environments without MessageChannel
  return new Promise(resolve => setTimeout(resolve, 0));
}

// A work item represents a single callback-mode task in the event loop.
interface WorkItem {
  id: number;
  task: AsyncTask;
  componentState: ComponentState;
  callbackFn: (eventCode: number, p1: number, p2: number) => number | Promise<number>;
  resolve: () => void;
  reject: (err: Error) => void;
  // Set when this item was woken from WAIT — the waitable set to poll for the event.
  wokenFromWsIndex: number;
}

// Entry in the waiting map: a work item plus the waitable set it's blocked on.
interface WaitingEntry {
  item: WorkItem;
  waitableSetIndex: number;
}

// Single global event loop that drives all callback-mode tasks.
//
// Mirrors wasmtime's concurrent.rs design:
//   - highPriority: event deliveries (processed as a batch)
//   - lowPriority: yields (processed one at a time)
//   - waiting: tasks blocked on waitable sets
//   - pendingAsyncCount: external async operations (JSPI tasks)
//
// Deadlock detection: when only waiting tasks remain, no work queued,
// and no pending async operations, the loop cannot make progress → trap.
export class EventLoop {
  private highPriority: WorkItem[] = [];
  private lowPriority: WorkItem[] = [];
  private waiting: Map<number, WaitingEntry> = new Map();
  private running = false;
  private wakeResolver: (() => void) | null = null;
  private pendingAsyncCount = 0;
  private nextId = 1;
  // Rejection function for fatal errors (deadlock). Set by runAsyncExport.
  private _rejecter: ((e: Error) => void) | null = null;
  // All registered component states (for deadlock propagation).
  private componentStates: Set<ComponentState> = new Set();

  // Register a component state with this event loop.
  // Called by generated code so the event loop can propagate errors.
  registerComponentState(state: ComponentState): void {
    this.componentStates.add(state);
  }

  // Register a callback-mode task with the event loop.
  // The initialResult is the packed i32 from the initial wasm call.
  // If EXIT, resolves immediately. Otherwise enqueues and starts the loop.
  addTask(
    task: AsyncTask,
    componentState: ComponentState,
    callbackFn: (eventCode: number, p1: number, p2: number) => number | Promise<number>,
    initialResult: number,
  ): Promise<void> {
    const [code, wsIdx] = unpackCallbackResult(initialResult);

    if (code === CallbackCode.EXIT) {
      return Promise.resolve();
    }

    // Per spec: WAIT is only allowed when the task has on_block (i.e., was
    // created by a cross-component call). Top-level export calls from the
    // host do NOT have on_block, so WAIT must trap.
    if (code === CallbackCode.WAIT && !task.mayBlock) {
      componentState.releaseExclusive();
      componentState.leave();
      return Promise.reject(new Error('cannot block a synchronous task before returning'));
    }

    // Validate callback code — only EXIT (0), YIELD (1), WAIT (2) are valid.
    if (code !== CallbackCode.YIELD && code !== CallbackCode.WAIT) {
      componentState.releaseExclusive();
      componentState.leave();
      return Promise.reject(new Error(`unsupported callback code: ${code}`));
    }

    return new Promise<void>((resolve, reject) => {
      const item: WorkItem = {
        id: this.nextId++,
        task,
        componentState,
        callbackFn,
        resolve,
        reject,
        wokenFromWsIndex: 0,
      };

      if (code === CallbackCode.YIELD) {
        componentState.releaseExclusive();
        componentState.leave();
        this.lowPriority.push(item);
      } else if (code === CallbackCode.WAIT) {
        componentState.releaseExclusive();
        componentState.leave();
        // Check if the waitable set already has a pending event (the event
        // may have been set during the wasm call, before the task was added
        // to the event loop). If so, go directly to high-priority.
        const ws = componentState.getWaitableSet(wsIdx);
        if (ws.hasPendingEvent() || task.isCancelPending() || task.isCancelled()) {
          item.wokenFromWsIndex = wsIdx;
          this.highPriority.push(item);
        } else {
          this.waiting.set(item.id, { item, waitableSetIndex: wsIdx });
          ws.addCallbackWaiter();
        }
      }

      this._ensureRunning();
    });
  }

  // Increment the pending async counter (for JSPI/async operations).
  addPendingAsync(): void {
    this.pendingAsyncCount++;
  }

  // Decrement the pending async counter.
  removePendingAsync(): void {
    this.pendingAsyncCount--;
  }

  // Wake the event loop: move ready waiters to high-priority queue.
  // Called by WaitableSet.notify() and AsyncTask.requestCancellation()
  // via their notifyFn callbacks.
  wake(): void {
    for (const [id, entry] of this.waiting) {
      const ws = entry.item.componentState.getWaitableSet(entry.waitableSetIndex);
      if (ws.hasPendingEvent() || entry.item.task.isCancelPending() || entry.item.task.isCancelled()) {
        this.waiting.delete(id);
        ws.removeCallbackWaiter();
        entry.item.wokenFromWsIndex = entry.waitableSetIndex;
        this.highPriority.push(entry.item);
      }
    }
    if (this.wakeResolver && (this.highPriority.length > 0 || this.pendingAsyncCount === 0)) {
      const resolve = this.wakeResolver;
      this.wakeResolver = null;
      resolve();
    }
  }

  // Remove all tasks belonging to a component (for component destruction).
  removeTasksForComponent(componentState: ComponentState): void {
    for (let i = this.highPriority.length - 1; i >= 0; i--) {
      if (this.highPriority[i]!.componentState === componentState) {
        const item = this.highPriority.splice(i, 1)[0]!;
        item.resolve();
      }
    }
    for (let i = this.lowPriority.length - 1; i >= 0; i--) {
      if (this.lowPriority[i]!.componentState === componentState) {
        const item = this.lowPriority.splice(i, 1)[0]!;
        item.resolve();
      }
    }
    for (const [id, entry] of this.waiting) {
      if (entry.item.componentState === componentState) {
        this.waiting.delete(id);
        if (!componentState.isDestroyed()) {
          const ws = componentState.getWaitableSet(entry.waitableSetIndex);
          ws.removeCallbackWaiter();
        }
        entry.item.resolve();
      }
    }
  }

  // Set a rejection handler for fatal errors (deadlock).
  setRejecter(rejecter: ((e: Error) => void) | null): void {
    this._rejecter = rejecter;
  }

  private _ensureRunning(): void {
    if (!this.running) {
      this.running = true;
      this._run().catch((e) => {
        this.running = false;
        // Propagate fatal error (deadlock) to the rejecter
        if (this._rejecter) {
          this._rejecter(e);
        }
        // Reject all pending items with the error
        this._rejectAll(e);
      });
    }
  }

  private _rejectAll(error: Error): void {
    const items: WorkItem[] = [];
    for (const item of this.highPriority) items.push(item);
    for (const item of this.lowPriority) items.push(item);
    for (const [, entry] of this.waiting) {
      if (!entry.item.componentState.isDestroyed()) {
        const ws = entry.item.componentState.getWaitableSet(entry.waitableSetIndex);
        ws.removeCallbackWaiter();
      }
      items.push(entry.item);
    }
    this.highPriority = [];
    this.lowPriority = [];
    this.waiting.clear();
    for (const item of items) item.reject(error);
  }

  private async _run(): Promise<void> {
    while (this.highPriority.length > 0 || this.lowPriority.length > 0 || this.waiting.size > 0) {

      // 1. Process ALL high-priority items (batch)
      while (this.highPriority.length > 0) {
        const item = this.highPriority.shift()!;

        if (item.componentState.isDestroyed()) {
          item.resolve();
          continue;
        }

        if (item.task.isCancelled()) {
          // Task was cancelled — exit cleanly
          item.resolve();
          continue;
        }

        // Determine the event to deliver
        let event: EventTuple;
        if (item.task.isCancelPending()) {
          event = { code: EventCode.TASK_CANCELLED, index: 0, payload: 0 };
        } else {
          // Poll the waitable set the task was waiting on
          const ws = item.componentState.getWaitableSet(item.wokenFromWsIndex);
          event = ws.poll();
        }

        // Enter component, call callback, handle result
        this._enterCallback(item);
        trace.log(item.componentState.componentIdx, 'callback(WAIT)', event.code, event.index, event.payload);
        try {
          const packed = await item.callbackFn(event.code, event.index, event.payload);
          trace.logResult(item.componentState.componentIdx, 'callback(WAIT)', packed);
          this._handleResult(item, packed);
        } catch (e) {
          this._leaveCallback(item);
          item.reject(e instanceof Error ? e : new Error(String(e)));
        }
      }

      // 2. Process ONE low-priority item (fairness)
      if (this.lowPriority.length > 0) {
        const item = this.lowPriority.shift()!;

        if (item.componentState.isDestroyed()) {
          item.resolve();
          continue;
        }

        // Yield to macrotask queue so the browser can repaint
        await nextMacrotask();

        if (item.componentState.isDestroyed()) {
          item.resolve();
          continue;
        }

        this._enterCallback(item);
        trace.log(item.componentState.componentIdx, 'callback(YIELD)', 0, 0, 0);
        try {
          const packed = await item.callbackFn(0, 0, 0);
          trace.logResult(item.componentState.componentIdx, 'callback(YIELD)', packed);
          this._handleResult(item, packed);
        } catch (e) {
          this._leaveCallback(item);
          item.reject(e instanceof Error ? e : new Error(String(e)));
        }
        continue; // re-check high-priority before next low-priority
      }

      // 3. Only waiting items remain — nothing in queues
      if (this.waiting.size === 0) break;

      // 4. Drain pending microtasks before checking deadlock.
      //
      // Try a few microtask rounds first (cheap). Most async operations
      // (e.g., in-memory filesystem) settle within 1-3 microtask levels.
      // Only fall back to a full macrotask boundary for complex cases
      // (cross-component JSPI chains).
      for (let drainAttempt = 0; drainAttempt < 5; drainAttempt++) {
        await Promise.resolve();
        if (this.highPriority.length > 0 || this.lowPriority.length > 0) break;
      }
      if (this.highPriority.length > 0 || this.lowPriority.length > 0) continue;
      if (this.waiting.size === 0) break;
      // Microtasks didn't resolve anything — full macrotask boundary needed.
      await nextMacrotask();
      if (this.highPriority.length > 0 || this.lowPriority.length > 0) continue;
      if (this.waiting.size === 0) break;

      // 5. Deadlock check: no pending async + no work items = deadlock
      if (this.pendingAsyncCount === 0) {
        const err = new Error('wasm trap: deadlock detected: event loop cannot make further progress');
        // Abort all waitable sets across all registered component states.
        // This breaks JSPI-blocked tasks (e.g., waitable-set.wait Promises)
        // so the deadlock error propagates everywhere.
        for (const state of this.componentStates) {
          state.abortAll(err);
        }
        throw err;
      }

      // 6. Sleep until wake() is called
      await new Promise<void>((r) => {
        this.wakeResolver = r;
      });
    }

    this.running = false;
  }

  private _enterCallback(item: WorkItem): void {
    item.componentState.forceEnter();
    item.componentState.acquireExclusive();
    item.componentState.currentTask = item.task;
  }

  private _leaveCallback(item: WorkItem): void {
    item.componentState.currentTask = null;
    item.componentState.releaseExclusive();
    item.componentState.leave();
  }

  private _suspendCallback(item: WorkItem): void {
    item.componentState.releaseExclusive();
    item.componentState.leave();
  }

  // Handle the callback result: EXIT, YIELD, or WAIT.
  private _handleResult(item: WorkItem, packed: number): void {
    const [code, wsIdx] = unpackCallbackResult(packed);
    switch (code) {
      case CallbackCode.EXIT:
        this._leaveCallback(item);
        item.resolve();
        break;
      case CallbackCode.YIELD:
        this._suspendCallback(item);
        this.lowPriority.push(item);
        break;
      case CallbackCode.WAIT: {
        this._suspendCallback(item);
        // Check if the waitable set already has a pending event (may have
        // been set during the callback execution). If so, go to high-priority.
        const ws = item.componentState.getWaitableSet(wsIdx);
        if (ws.hasPendingEvent() || item.task.isCancelPending() || item.task.isCancelled()) {
          item.wokenFromWsIndex = wsIdx;
          this.highPriority.push(item);
        } else {
          this.waiting.set(item.id, { item, waitableSetIndex: wsIdx });
          ws.addCallbackWaiter();
        }
        break;
      }
      default:
        throw new Error(`unsupported callback code: ${code}`);
    }
  }
}

