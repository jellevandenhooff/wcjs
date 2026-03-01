import { Waitable } from './waitable.ts';
import { CallbackCode, EventCode, SubtaskState, unpackCallbackResult } from './types.ts';
import type { EventTuple } from './types.ts';
import type { AsyncTask } from './task.ts';
import type { ComponentState, ResourceHandle } from './component-state.ts';
import type { MaybePromised } from './jspi.ts';

// A Subtask tracks an async import call from the perspective of the caller.
// It extends Waitable so it can deliver SUBTASK events to a WaitableSet.
//
// State machine (per spec):
//   STARTING → STARTED (on_start)
//   STARTED → RETURNED (on_resolve with result)
//   STARTING → CANCELLED_BEFORE_STARTED (on_resolve with null)
//   STARTED → CANCELLED_BEFORE_RETURNED (on_resolve with null)
export class Subtask extends Waitable {
  private state: SubtaskState = SubtaskState.STARTING;
  private handleIndex = 0; // set when added to handle table
  private resolveDelivered = false;

  // Per spec: lenders tracks resource handles whose num_lends was incremented
  // during lift_borrow (parameter passing to the callee). When the subtask
  // resolves, deliver_resolve() decrements all num_lends, allowing the
  // resources to be dropped.
  private lenders: ResourceHandle[] | null = [];

  // References to the callee side, set by CallContext._executeCallee
  calleeTask: AsyncTask | null = null;
  calleeState: ComponentState | null = null;
  calleeCallbackFn: ((eventCode: number, p1: number, p2: number) => number | Promise<number>) | null = null;

  // Waiter for subtaskCancel to await resolution
  private _resolveWaiter: (() => void) | null = null;

  setHandleIndex(idx: number): void {
    this.handleIndex = idx;
  }

  getState(): SubtaskState {
    return this.state;
  }

  resolved(): boolean {
    return (
      this.state === SubtaskState.RETURNED ||
      this.state === SubtaskState.CANCELLED_BEFORE_STARTED ||
      this.state === SubtaskState.CANCELLED_BEFORE_RETURNED
    );
  }

  isResolveDelivered(): boolean {
    return this.resolveDelivered;
  }

  // Per spec: add_lender(h) — called during lift_borrow when passing a
  // borrow handle as a parameter to the callee. Increments h.num_lends
  // to prevent the resource from being dropped while the callee holds it.
  addLender(h: ResourceHandle): void {
    if (this.lenders === null || this.resolved()) {
      throw new Error('subtask.addLender: subtask already resolved or delivered');
    }
    h.numLends++;
    this.lenders.push(h);
  }

  // Called when the callee starts executing (accepts the arguments).
  // Transitions STARTING → STARTED. Does NOT deliver a pending event —
  // per spec, the STARTED state is communicated via the packed return
  // value of canon_lower (asyncStartCall), not through the waitable set.
  // Only subsequent state changes (RETURNED, CANCELLED) deliver events.
  onStart(): void {
    if (this.state !== SubtaskState.STARTING) {
      throw new Error(`subtask.onStart: unexpected state ${this.state}`);
    }
    this.state = SubtaskState.STARTED;
  }

  // Called when the callee resolves (returns a result or is cancelled).
  // result = undefined means cancellation.
  // Note: state is updated BEFORE delivering the event.
  onResolve(result: unknown): void {
    // Ignore late resolution if already in a terminal state (e.g., host
    // import Promise resolving after the subtask was cancelled).
    if (this.resolved()) return;

    if (result === undefined || result === null) {
      // Cancellation
      if (this.state === SubtaskState.STARTING) {
        this.state = SubtaskState.CANCELLED_BEFORE_STARTED;
      } else if (this.state === SubtaskState.STARTED) {
        this.state = SubtaskState.CANCELLED_BEFORE_RETURNED;
      } else {
        throw new Error(`subtask.onResolve cancel: unexpected state ${this.state}`);
      }
    } else {
      // Normal completion
      if (this.state !== SubtaskState.STARTED) {
        throw new Error(`subtask.onResolve: unexpected state ${this.state}`);
      }
      this.state = SubtaskState.RETURNED;
    }
    this.deliverProgressEvent();
    // Wake any subtaskCancel awaiting resolution
    if (this._resolveWaiter) {
      const waiter = this._resolveWaiter;
      this._resolveWaiter = null;
      waiter();
    }
  }

  // Returns a Promise that resolves when this subtask reaches a terminal state.
  // Used by subtaskCancel to await callee completion when the callee is cancellable.
  waitForResolution(): Promise<void> {
    if (this.resolved()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this._resolveWaiter = resolve;
    });
  }

  // Deliver the resolve to the caller (consume the resolution).
  // Per spec, this is called when the event is actually retrieved.
  // Decrements num_lends on all lending resource handles.
  deliverResolve(): void {
    if (this.resolveDelivered || !this.resolved()) {
      throw new Error('subtask.deliverResolve: not in resolved state or already delivered');
    }
    // Per spec: decrement num_lends on all lent resource handles
    if (this.lenders) {
      for (const h of this.lenders) {
        h.numLends--;
      }
      this.lenders = null;
    }
    this.resolveDelivered = true;
  }

  // Set a pending event that reports current state.
  // Per spec: the event closure calls deliverResolve if resolved.
  private deliverProgressEvent(): void {
    const idx = this.handleIndex;
    const subtask = this;
    this.setPendingEvent((): EventTuple => {
      if (subtask.resolved()) {
        subtask.deliverResolve();
      }
      return {
        code: EventCode.SUBTASK,
        index: idx,
        payload: subtask.state,
      };
    });
  }

  // Try to cancel the callee inline (synchronously).
  // Enters the callee component, calls the callback with TASK_CANCELLED,
  // and if it returns EXIT, resolves this subtask as cancelled.
  // Returns true if cancellation completed inline, false if callee has no callback
  // (JSPI mode — cancellation must be delivered asynchronously).
  tryInlineCancel(): boolean {
    if (!this.calleeTask || !this.calleeState) return false;
    if (!this.calleeCallbackFn) return false; // no callback = JSPI mode
    // If the callee is suspended in a blocking builtin (JSPI stack is active),
    // we cannot call the callback — it may be unreachable or the callee's
    // wasm state may be inconsistent. Cancel through the builtin instead.
    if (this.calleeTask.isSuspendedInBuiltin()) return false;

    const calleeState = this.calleeState;
    const calleeTask = this.calleeTask;
    const cbFn = this.calleeCallbackFn;

    // Enter callee component to deliver TASK_CANCELLED.
    // Use forceEnter() because call_might_be_recursive was already checked
    // when the call was originally set up. The _mayEnter flag may be false
    // from ancestor/descendant propagation but that's not actual reentrancy.
    calleeState.forceEnter();
    calleeState.acquireExclusive();
    calleeState.currentTask = calleeTask;

    // Use the raw (non-promising-wrapped) callback to get a synchronous result.
    // V8's promising() wrapper always returns a Promise, even for synchronous
    // callbacks, making inline cancel impossible with the wrapped version.
    // The cancel callback only calls task.cancel + EXIT — no suspending imports.
    const rawCbFn = (cbFn as MaybePromised)._raw || cbFn;
    let code: number;
    try {
      const packed = rawCbFn(EventCode.TASK_CANCELLED, 0, 0);
      if (packed instanceof Promise) {
        // Should not happen with raw callback, but be safe
        return false;
      }
      [code] = unpackCallbackResult(packed);
    } finally {
      calleeState.currentTask = null;
      calleeState.releaseExclusive();
      calleeState.leave();
    }

    if (code === CallbackCode.EXIT) {
      // Callee accepted cancellation and exited
      calleeTask.requestCancellation(); // wake the abandoned event loop
      this.onResolve(undefined); // transitions to CANCELLED_BEFORE_*
      return true;
    }

    return false;
  }

  // Override drop: per spec, can only drop after resolve is delivered.
  override drop(): void {
    if (!this.resolveDelivered) {
      throw new Error('cannot drop a subtask which has not yet resolved');
    }
    super.drop();
  }
}
