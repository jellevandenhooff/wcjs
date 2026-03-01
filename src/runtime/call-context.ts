// Cross-component call support.
// Manages the PrepareCall → AsyncStartCall/SyncStartCall handoff for
// generated adapter trampolines.

import { jspiMode } from './component-state.ts';
import type { ComponentState } from './component-state.ts';
import { AsyncTask } from './task.ts';
import { Subtask } from './subtask.ts';
import { SubtaskState } from './types.ts';
import type { EventLoop } from './event-loop.ts';
import { trace } from './trace.ts';

// Metadata stored by prepareCall, consumed by asyncStartCall/syncStartCall.
interface PendingCall {
  startFn: Function | null;
  returnFn: Function | null;
  callerInstanceIdx: number;
  calleeInstanceIdx: number;
  isCalleeAsync: boolean;
  resultPtr: number | null;
  // Flat parameter values from the caller, forwarded to startFn.
  // The startFn lifts these (e.g., does stream.transfer for stream params).
  flatParams: unknown[];
}

// Manages cross-component call state.
// Each generated component module creates one CallContext instance.
export class CallContext {
  private _pendingCall: PendingCall | null = null;
  private _eventLoop: EventLoop;

  constructor(eventLoop: EventLoop) {
    this._eventLoop = eventLoop;
  }


  // Called by generated adapter trampoline before a cross-component call.
  //
  // Fixed args (0-7): startFn, returnFn, callerInstanceIdx, calleeInstanceIdx,
  //   taskReturnTypeIdx, isCalleeAsync, stringEncoding, resultCountOrAsync
  //
  // Trailing args (8+): flat parameter values from the caller.
  // When resultCountOrAsync == -2 (async with result pointer), the LAST
  // trailing arg is the result pointer (retptr); the rest are flat params.
  // The retptr is last because wasm appends it as the final core parameter.
  prepareCall(...args: unknown[]): void {
    const resultCountOrAsync = args[7] as number;

    // Extract trailing values (everything after the 8 fixed metadata args)
    const trailing = Array.prototype.slice.call(args, 8);

    let resultPtr: number | null = null;
    let flatParams: unknown[];

    if (resultCountOrAsync === -2) {
      // Async call with result pointer: retptr is the last trailing arg
      resultPtr = (trailing.pop() as number) ?? null;
      flatParams = trailing;
    } else {
      // Async without retptr (-1), or sync (>= 0): all trailing are flat params
      flatParams = trailing;
    }

    this._pendingCall = {
      startFn: (args[0] as Function) || null,
      returnFn: (args[1] as Function) || null,
      callerInstanceIdx: args[2] as number,
      calleeInstanceIdx: args[3] as number,
      isCalleeAsync: (args[5] as number) !== 0,
      resultPtr,
      flatParams,
    };
  }

  // Lift parameters: startFn transforms flat params (e.g., stream handle transfer).
  // If startFn returns an array, it's the full args list.
  // If startFn returns a single value, wrap in array.
  // If no startFn, forward flat params directly.
  private _liftArgs(call: PendingCall): unknown[] {
    if (call.startFn) {
      const liftedResult = (call.startFn as (...a: unknown[]) => unknown)(...call.flatParams);
      if (Array.isArray(liftedResult)) {
        return liftedResult;
      } else if (liftedResult !== undefined) {
        return [liftedResult];
      } else {
        return [];
      }
    } else {
      return call.flatParams;
    }
  }

  // Called by generated adapter trampoline for an async-lowered cross-component call.
  // Returns packed i32: subtaskState (if resolved) or (subtaskHandle << 4) | subtaskState
  asyncStartCall(
    states: ComponentState[],
    callbackFn: Function | null,
    callee: Function,
    _paramCount: number,
    _resultCount: number,
    _flags: number,
  ): number {
    const call = this._pendingCall!;
    this._pendingCall = null;
    const callerState = states[call.callerInstanceIdx]!;
    const calleeState = states[call.calleeInstanceIdx]!;

    // Per spec: call_might_be_recursive(caller, callee_inst)
    // Trap if caller and callee are in an ancestor-descendant relationship.
    if (callerState.isReflexiveAncestorOf(calleeState) ||
        calleeState.isReflexiveAncestorOf(callerState)) {
      throw new Error('wasm trap: cannot enter component instance');
    }

    // Auto-backpressure: if callee is busy (exclusive lock held or backpressure),
    // queue the call. Per spec: task.enter() checks backpressure/exclusive.
    // We use isExclusive()/hasBackpressure() instead of enter() because the
    // async adapter trampoline doesn't check instance flags. The instance flags
    // may be dirty from ancestor/descendant propagation, but that doesn't mean
    // the callee is actually busy.
    if (calleeState.isExclusive() || calleeState.hasBackpressure()) {
      const subtask = new Subtask();
      const handle = callerState.addSubtask(subtask);
      // Don't call onStart() — stays STARTING
      calleeState.queuePendingCall(() => {
        this._startDeferredCall(call, calleeState, callbackFn, callee, subtask);
      });
      return (handle << 4) | subtask.getState();
    }

    // Enter callee component. Use forceEnter() because we already checked
    // call_might_be_recursive and backpressure above — the _mayEnter flag may
    // be false from ancestor/descendant propagation but that's not actual reentrancy.
    calleeState.forceEnter();

    return this._executeCallee(call, callerState, calleeState, callbackFn, callee, null);
  }

  private _enterCallee(state: ComponentState, task: AsyncTask): void {
    state.currentTask = task;
    state.acquireExclusive();
  }

  private _exitCallee(state: ComponentState, restoreTask: AsyncTask | null, doLeave = true): void {
    state.currentTask = restoreTask;
    state.releaseExclusive();
    if (doLeave) state.leave();
  }

  // Execute the callee after entering the component. If existingSubtask is
  // non-null, this is a deferred call from the backpressure queue.
  private _executeCallee(
    call: PendingCall,
    callerState: ComponentState | undefined,
    calleeState: ComponentState,
    callbackFn: Function | null,
    callee: Function,
    existingSubtask: Subtask | null,
  ): number {
    const calleeTask = new AsyncTask();
    // Per spec: may_block() returns ft.async_ || state == RESOLVED.
    // Only async-lifted callees have ft.async_ = true; sync callees start with
    // may_block() = false and can't use blocking builtins (WAIT, etc.).
    calleeTask.mayBlock = call.isCalleeAsync;
    calleeTask.notifyFn = () => this._eventLoop.wake();
    // Set currentTask so task.return resolves the correct task. Both async
    // and sync callees need their own task for sync barge-in: a sync callee
    // may enter a component that already has an async task blocked in JSPI.
    this._enterCallee(calleeState, calleeTask);

    const liftedArgs = this._liftArgs(call);

    // Transition deferred subtask STARTING → STARTED (delivers event)
    if (existingSubtask) {
      existingSubtask.onStart();
    }

    // Call the callee with the lifted arguments.
    trace.log(call.calleeInstanceIdx, 'asyncStartCall.callee', ...liftedArgs);
    const initialResult = (callee as (...args: unknown[]) => number | Promise<number>)(...liftedArgs);

    // JSPI path: callee returned a Promise (wasm suspended via promising()).
    // Only possible when jspiMode is enabled.
    //
    // Per spec: keep exclusive held while callee is suspended. This provides
    // backpressure — new async calls to the same component will be queued.
    // But leave() to restore may_enter flags so sync-to-sync core wasm
    // adapters (which check may_enter directly) can still call the component
    // for non-exclusive operations.
    if (jspiMode && initialResult instanceof Promise) {
      // Restore may_enter flags (for sync-to-sync core wasm adapters) but keep
      // exclusive lock held (for async backpressure). Pending calls will be
      // processed when releaseExclusive() is called in the .then() handler.
      calleeState.restoreEnterRefs();

      let subtask: Subtask;
      let handle = 0;
      if (existingSubtask) {
        subtask = existingSubtask;
      } else {
        subtask = new Subtask();
        if (callerState) handle = callerState.addSubtask(subtask);
        subtask.onStart();
      }

      // Wire callee references for cancellation.
      // When callbackFn is non-null, the callee is a callback-mode function that
      // can handle inline cancel via tryInlineCancel. This works even in the JSPI
      // path because tryInlineCancel uses the raw (non-promising) callback, which
      // can be called while the callee's promising()-wrapped Promise is pending.
      subtask.calleeTask = calleeTask;
      subtask.calleeState = calleeState;
      if (callbackFn) {
        subtask.calleeCallbackFn = callbackFn as (eventCode: number, p1: number, p2: number) => number | Promise<number>;
      }

      initialResult.then((wasmReturnValue) => {
        if (calleeTask.isCancelled()) {
          // Callee accepted cancellation. Resolve the subtask if not already done.
          // tryInlineCancel may have already cleaned up (released exclusive, resolved
          // subtask), so guard against double cleanup.
          calleeState.currentTask = null;
          if (calleeState.isExclusive()) {
            calleeState.releaseExclusive();
          }
          if (!subtask.resolved()) {
            subtask.onResolve(undefined);
          }
          return;
        }

        if (callbackFn) {
          // Callback-mode callee: wasmReturnValue is the packed callback code.
          const code = wasmReturnValue & 0xf;
          const earlyReturn = calleeTask.isResolved();
          if (earlyReturn) this._callReturnFn(call, calleeTask, callerState);

          if (code === 0) {
            // EXIT: instant completion
            if (!earlyReturn) this._callReturnFn(call, calleeTask, callerState);
            this._checkBorrows(calleeTask);
            this._exitCallee(calleeState, null, false);
            subtask.onResolve(true);
            return;
          }

          // YIELD/WAIT: add to event loop. The event loop manages
          // exclusive release/acquire and enter/leave lifecycle.
          const cbFn = callbackFn as (eventCode: number, p1: number, p2: number) => number | Promise<number>;
          this._eventLoop.addTask(
            calleeTask,
            calleeState,
            cbFn,
            wasmReturnValue,
          ).then(() => {
            if (calleeTask.isCancelled()) return;
            this._checkBorrows(calleeTask);
            if (!earlyReturn) this._callReturnFn(call, calleeTask, callerState);
            subtask.onResolve(true);
          }).catch((e) => {
            calleeState.currentTask = null;
            if (!subtask.resolved()) subtask.onResolve(undefined);
            if (!(e instanceof Error && e.message === 'component destroyed')) {
              console.error('asyncStartCall event loop error:', e);
            }
          });
          return;
        }

        // JSPI-mode callee (no callback): release exclusive now.
        // Resolve with the wasm return value if not already resolved by task.return.
        if (!calleeTask.isResolved()) {
          calleeTask.resolve(wasmReturnValue);
        }
        this._checkBorrows(calleeTask);
        this._callReturnFn(call, calleeTask, callerState);
        this._exitCallee(calleeState, null);
        subtask.onResolve(true);
      }).catch((e) => {
        this._exitCallee(calleeState, null, false);
        if (!subtask.resolved()) subtask.onResolve(undefined);
        if (!(e instanceof Error && e.message === 'component destroyed')) {
          console.error('asyncStartCall callee error:', e);
        }
      });

      if (existingSubtask) return 0;
      return (handle << 4) | subtask.getState();
    }

    // Non-callback callee that completed synchronously: return value is
    // the flat result, not a packed callback code.
    if (callbackFn === null) {
      if (!calleeTask.isResolved()) {
        calleeTask.resolve(initialResult);
      }
      this._checkBorrows(calleeTask);
      this._callReturnFn(call, calleeTask, callerState);
      this._exitCallee(calleeState, null);

      if (existingSubtask) {
        existingSubtask.onResolve(true);
        return 0;
      }
      return SubtaskState.RETURNED;
    }

    // Callback-mode callee: return value is a packed callback code
    const code = (initialResult as number) & 0xf;
    const earlyReturn = calleeTask.isResolved();
    trace.logResult(call.calleeInstanceIdx, 'asyncStartCall.callee', `code=${code} earlyReturn=${earlyReturn}`);

    if (earlyReturn) {
      this._callReturnFn(call, calleeTask, callerState);
    }

    if (code === 0) {
      // EXIT: instant completion
      if (!earlyReturn) {
        this._callReturnFn(call, calleeTask, callerState);
      }
      this._checkBorrows(calleeTask);
      this._exitCallee(calleeState, null);
      if (existingSubtask) {
        existingSubtask.onResolve(true);
        return 0;
      }
      return SubtaskState.RETURNED;
    }

    // YIELD/WAIT: callee is suspending.
    // Keep exclusive held — the event loop expects to start with exclusive
    // held. Its first iteration will release exclusive + leave, then
    // re-enter + re-acquire before each callback.

    const cbFn = callbackFn as (eventCode: number, p1: number, p2: number) => number | Promise<number>;

    if (earlyReturn) {
      this._eventLoop.addTask(
        calleeTask,
        calleeState,
        cbFn,
        initialResult as number,
      ).catch((e) => {
        if (!(e instanceof Error && e.message === 'component destroyed')) {
          console.error('event loop error (early-return path):', e);
        }
        calleeState.currentTask = null;
      });
      if (existingSubtask) {
        existingSubtask.onResolve(true);
        return 0;
      }
      return SubtaskState.RETURNED;
    }

    // Not resolved yet — create subtask or use existing
    let subtask: Subtask;
    let handle = 0;
    if (existingSubtask) {
      subtask = existingSubtask;
    } else {
      subtask = new Subtask();
      if (callerState) handle = callerState.addSubtask(subtask);
      subtask.onStart();
    }

    // Wire callee references for cancellation support
    subtask.calleeTask = calleeTask;
    subtask.calleeState = calleeState;
    subtask.calleeCallbackFn = cbFn;

    this._eventLoop.addTask(
      calleeTask,
      calleeState,
      cbFn,
      initialResult as number,
    ).then(() => {
      if (calleeTask.isCancelled()) return;
      this._checkBorrows(calleeTask);
      this._callReturnFn(call, calleeTask, callerState);
      subtask.onResolve(true);
    }).catch((e) => {
      calleeState.currentTask = null;
      if (!subtask.resolved()) subtask.onResolve(undefined);
      if (!(e instanceof Error && e.message === 'component destroyed')) {
        console.error('event loop error:', e);
      }
    });

    if (existingSubtask) return 0;
    return (handle << 4) | subtask.getState();
  }

  // Start a deferred call from the backpressure queue.
  private _startDeferredCall(
    call: PendingCall,
    calleeState: ComponentState,
    callbackFn: Function | null,
    callee: Function,
    subtask: Subtask,
  ): void {
    // Use forceEnter() — call_might_be_recursive was already checked when
    // the call was originally queued. The callee is now available.
    calleeState.forceEnter();
    // callerState is not needed for deferred path (handle already allocated)
    this._executeCallee(call, undefined, calleeState, callbackFn, callee, subtask);
  }

  // Called by generated adapter trampoline for a sync-lowered cross-component call.
  // Handles instant completion directly. For non-instant (callee suspends),
  // starts the event loop and returns a Promise — JSPI suspends the calling
  // wasm while the callee runs asynchronously.
  syncStartCall(
    states: ComponentState[],
    callbackFn: Function | null,
    callee: Function,
    _flags: number,
  ): number | Promise<number> {
    const call = this._pendingCall!;
    this._pendingCall = null;
    const callerState = states[call.callerInstanceIdx]!;
    const calleeState = states[call.calleeInstanceIdx]!;

    // CheckBlocking: if the callee is async WITHOUT callback mode and the
    // caller has no active task (i.e., the caller is a sync-lifted function),
    // blocking is not allowed. Without callback mode, the callee uses pure
    // JSPI and will always block. With callback mode, the callee might return
    // EXIT immediately, so we defer the blocking check to the event loop
    // (which traps on WAIT when task.mayBlock is false).
    if (call.isCalleeAsync && callbackFn === null && !callerState.currentTask?.mayBlock) {
      throw new Error('cannot block a synchronous task before returning');
    }

    // Per spec: call_might_be_recursive(caller, callee_inst)
    if (callerState.isReflexiveAncestorOf(calleeState) ||
        calleeState.isReflexiveAncestorOf(callerState)) {
      throw new Error('wasm trap: cannot enter component instance');
    }

    // Enter callee component. Use forceEnter() because call_might_be_recursive
    // was already checked above — the _mayEnter flag may be false from
    // ancestor/descendant propagation but that's not actual reentrancy.
    calleeState.forceEnter();

    // Save the previous currentTask so we can restore it when done.
    // This is critical for sync barge-in: a sync callee can enter a
    // component that already has an async task blocked in JSPI. We must
    // not clobber that task when the sync call completes.
    const savedTask = calleeState.currentTask;

    const calleeTask = new AsyncTask();
    // Per spec: may_block() = ft.async_ || state == RESOLVED.
    // Sync-lifted callees have ft.async_ = false, so may_block() = false.
    calleeTask.mayBlock = call.isCalleeAsync;
    calleeTask.notifyFn = () => this._eventLoop.wake();
    // Set currentTask so task.return resolves the correct task. Both async
    // and sync callees need their own task for sync barge-in: a sync callee
    // may enter a component that already has an async task blocked in JSPI.
    // Blocking builtins use task.mayBlock (not currentTask presence) to
    // determine whether blocking is allowed.
    this._enterCallee(calleeState, calleeTask);

    const liftedArgs = this._liftArgs(call);

    // Call the callee with the lifted arguments.
    const initialResultRaw = (callee as (...args: unknown[]) => number | Promise<number>)(...liftedArgs);

    // JSPI path: callee returned a Promise (JSPI suspension or V8 artifact).
    // Only possible when jspiMode is enabled.
    // Restore may_enter flags (for sync-to-sync core wasm adapters) but keep
    // exclusive held for backpressure. Pending calls processed in .then().
    if (jspiMode && initialResultRaw instanceof Promise) {
      // Per spec: trap_if(not task.may_block() and ft.async_ and not opts.async_)
      // When the callee returns a Promise, it would block via JSPI. If the
      // caller's task can't block (sync task with no currentTask), trap.
      if (call.isCalleeAsync && !callerState.currentTask?.mayBlock) {
        // Suppress the unhandled rejection from the JSPI Promise.
        (initialResultRaw as Promise<unknown>).catch(() => {});
        this._exitCallee(calleeState, savedTask);
        throw new Error('cannot block a synchronous task before returning');
      }
      calleeState.restoreEnterRefs();

      // Early return detection: the callee may have called task.return
      // synchronously before suspending on a blocking import (e.g., sync
      // stream.write). If so, return the result to the caller immediately
      // and let the callee's continuation run in the background.
      if (calleeTask.isResolved()) {
        this._checkBorrows(calleeTask);
        const retVal = this._getReturnValue(call, calleeTask, callerState);
        // Callee's background continuation: when the Promise resolves,
        // clean up the callee state and add to event loop if needed.
        (initialResultRaw as Promise<number>).then(async (wasmReturnValue) => {
          if (callbackFn) {
            const code = wasmReturnValue & 0xf;
            if (code === 0) {
              // EXIT: callee fully done
              this._exitCallee(calleeState, savedTask, false);
              return;
            }
            // YIELD/WAIT: add to event loop for callee cleanup
            const cbFn = callbackFn as (eventCode: number, p1: number, p2: number) => number | Promise<number>;
            await this._eventLoop.addTask(
              calleeTask,
              calleeState,
              cbFn,
              wasmReturnValue,
            );
          } else {
            this._exitCallee(calleeState, savedTask, false);
          }
        }).catch((e) => {
          calleeState.currentTask = savedTask;
          if (calleeState.isExclusive()) calleeState.releaseExclusive();
          if (calleeState.isDestroyed()) return;
          if (e instanceof WebAssembly.RuntimeError) return;
          if (e instanceof Error && e.message === 'component destroyed') return;
          console.error('syncStartCall JSPI early-return background error:', e);
        });
        return retVal;
      }

      return (initialResultRaw as Promise<number>).then(async (wasmReturnValue) => {
        if (callbackFn) {
          // Callback-mode callee: wasmReturnValue is the packed callback code.
          const code = wasmReturnValue & 0xf;
          const earlyReturn = calleeTask.isResolved();

          if (earlyReturn) {
            this._callReturnFn(call, calleeTask, callerState);
          }

          if (code === 0) {
            // EXIT: callee completed
            this._checkBorrows(calleeTask);
            this._exitCallee(calleeState, savedTask, false);
            return this._getReturnValue(call, calleeTask, callerState);
          }

          // YIELD/WAIT: add to event loop.
          const cbFn = callbackFn as (eventCode: number, p1: number, p2: number) => number | Promise<number>;
          await this._eventLoop.addTask(
            calleeTask,
            calleeState,
            cbFn,
            wasmReturnValue,
          );
          // If earlyReturn, returnFn was already called above for side effects.
          // Return the result value regardless.
          if (!earlyReturn) {
            return this._getReturnValue(call, calleeTask, callerState);
          }
          // For early return with no returnFn, still return the callee's result
          return (calleeTask.getResult() as number) ?? 0;
        }

        // JSPI-mode callee (no callback): wasmReturnValue is the function's result.
        // Resolve with the wasm return value if not already resolved by task.return.
        if (!calleeTask.isResolved()) {
          calleeTask.resolve(wasmReturnValue);
        }
        this._checkBorrows(calleeTask);
        this._exitCallee(calleeState, savedTask);
        return this._getReturnValue(call, calleeTask, callerState);
      });
    }

    // After JSPI branch: initialResult is always a number here.
    const initialResult = initialResultRaw as number;

    // Non-callback callee that completed synchronously: return value is
    // the flat result, not a packed callback code.
    if (callbackFn === null) {
      if (!calleeTask.isResolved()) {
        calleeTask.resolve(initialResult);
      }
      this._checkBorrows(calleeTask);
      const retVal = this._getReturnValue(call, calleeTask, callerState);
      this._exitCallee(calleeState, savedTask);
      return retVal;
    }

    const code = initialResult & 0xf;

    if (code === 0) {
      // EXIT: instant completion
      this._checkBorrows(calleeTask);
      const retVal = this._getReturnValue(call, calleeTask, callerState);
      this._exitCallee(calleeState, savedTask);
      return retVal;
    }

    // Non-instant: callee is suspending (YIELD or WAIT).
    // Check if callee returned result early (before suspending for cleanup).
    const earlyReturn = calleeTask.isResolved();
    let retVal: number = 0;
    if (earlyReturn) {
      retVal = this._getReturnValue(call, calleeTask, callerState);
    }

    // Release exclusive so event loop can re-enter the callee.
    calleeState.releaseExclusive();

    if (!callbackFn) {
      calleeState.currentTask = savedTask;
      calleeState.leave();
      throw new Error(
        'SyncStartCall: callee did not complete instantly and no callback provided',
      );
    }

    const cbFn = callbackFn as (eventCode: number, p1: number, p2: number) => number | Promise<number>;

    // Add to event loop. The event loop handles enter/leave for each
    // callback invocation cycle.
    const loopPromise = this._eventLoop.addTask(
      calleeTask,
      calleeState,
      cbFn,
      initialResult,
    );

    if (earlyReturn) {
      // Callee already returned a value — return immediately.
      // The event loop continues in the background for cleanup.
      loopPromise.catch((e) => {
        if (!(e instanceof Error && e.message === 'component destroyed')) {
          console.error('syncStartCall event loop error (early return):', e);
        }
      });
      return retVal;
    }

    // Callee hasn't returned yet — block until it does.
    return loopPromise.then(() => {
      this._checkBorrows(calleeTask);
      return this._getReturnValue(call, calleeTask, callerState);
    });
  }

  // Per spec: trap_if(num_borrows > 0) at task exit.
  // All borrow handles created for this task must be dropped before the call ends.
  private _checkBorrows(calleeTask: AsyncTask): void {
    if (calleeTask.numBorrows > 0) {
      throw new Error('wasm trap: borrow handles still remain at the end of the call');
    }
  }

  // Call the returnFn with the callee's result and optional result pointer.
  // The returnFn lowers callee results into caller memory (e.g., stream.transfer,
  // I32Store to write results at retptr).
  //
  // Per wasm convention, the retptr is the LAST parameter (appended after flat results):
  //   With retptr:    returnFn(flat_result1, flat_result2, ..., retptr)
  //   Without retptr: returnFn(flat_result1, flat_result2, ...)
  private _callReturnFn(call: PendingCall, calleeTask: AsyncTask, callerState?: ComponentState): number | undefined {
    if (!call.returnFn) return undefined;
    const result = calleeTask.getResult();
    const returnArgs: unknown[] = [];
    // The result from task.getResult() is the flat value(s) stored by task.return.
    if (result !== undefined) {
      returnArgs.push(result);
    }
    // Retptr comes LAST per wasm calling convention
    if (call.resultPtr !== null) {
      returnArgs.push(call.resultPtr);
    }
    // Per spec: inst.may_leave = False during lower_flat_values.
    // The returnFn lowers callee results into caller memory — prevent the
    // caller from calling canon builtins during this lowering (e.g., from realloc).
    if (callerState) callerState.mayLeave = false;
    try {
      return (call.returnFn as (...a: unknown[]) => number)(...returnArgs);
    } finally {
      if (callerState) callerState.mayLeave = true;
    }
  }

  // Get the return value for the caller: if returnFn exists, use it to
  // transform/write the result; otherwise return the callee's raw result.
  private _getReturnValue(call: PendingCall, calleeTask: AsyncTask, callerState?: ComponentState): number {
    if (call.returnFn) {
      return this._callReturnFn(call, calleeTask, callerState) ?? 0;
    }
    return (calleeTask.getResult() as number) ?? 0;
  }
}
