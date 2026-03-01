// AsyncTask represents the execution of a guest async function.
// In callback mode, the task is driven by the EventLoop.
export class AsyncTask {
  private static nextId = 1;

  readonly id: number;
  private result: unknown = undefined;
  private resultSet = false;
  private storage: number[] = [0, 0]; // context slots (per spec)

  // Per spec: on_block — true when the task was created by a cross-component
  // call (async lower → async lift). False for top-level export calls from
  // the host. Only tasks with mayBlock=true can use WAIT; others must trap
  // with "cannot block a synchronous task before returning".
  mayBlock = false;

  // Per spec: num_borrows — tracks outstanding borrow handles created by
  // lower_borrow for this task. Must be 0 when the task finishes.
  numBorrows = 0;

  // Callback to notify the owning event loop when cancellation is requested.
  // Set by ComponentState.runAsyncExport() or CallContext._executeCallee().
  notifyFn: (() => void) | null = null;

  // Cancellation support
  private _cancelled = false;
  private _cancelResolve: (() => void) | null = null;

  // Per spec: cancel_pending — set by subtask.cancel, consumed by cancellable builtins.
  private _cancelPending = false;

  // Per spec: cancellable — true when the task is blocked in a cancellable
  // wait/poll/yield. Used by subtaskCancel to determine if the cancel can
  // complete immediately (the callee will wake up and process it).
  private _cancellable = false;

  constructor() {
    this.id = AsyncTask.nextId++;
  }

  // Resolve the task with a result (called by task.return trampoline)
  resolve(result: unknown): void {
    this.result = result;
    this.resultSet = true;
  }

  // Check if the task has been resolved
  isResolved(): boolean {
    return this.resultSet;
  }

  // Get the result (after resolution)
  getResult(): unknown {
    if (!this.resultSet) {
      throw new Error('task not yet resolved');
    }
    return this.result;
  }

  // Mark this task as cancelled (called by task.cancel trampoline inside callee)
  cancel(): void {
    this._cancelled = true;
    this.resultSet = true;
    this.result = undefined;
  }

  isCancelled(): boolean {
    return this._cancelled;
  }

  // Returns a Promise that resolves when requestCancellation() is called.
  // Used by event loop to race against ws.wait().
  getCancelPromise(): Promise<void> {
    if (this._cancelPending) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this._cancelResolve = resolve;
    });
  }

  // Signal the event loop that cancellation has been requested (from caller side).
  // Sets cancel_pending and wakes any cancellable wait/poll/yield.
  requestCancellation(): void {
    this._cancelPending = true;
    if (this._cancelResolve) {
      const resolve = this._cancelResolve;
      this._cancelResolve = null;
      resolve();
    }
    this.notifyFn?.();
  }

  // Per spec: deliver_pending_cancel — check and consume the cancel_pending flag.
  // Returns true if a pending cancel was consumed (only when cancellable=true).
  consumeCancelPending(): boolean {
    if (this._cancelPending) {
      this._cancelPending = false;
      return true;
    }
    return false;
  }

  isCancelPending(): boolean {
    return this._cancelPending;
  }

  // Track whether the task is in a cancellable blocking point.
  setCancellable(cancellable: boolean): void {
    this._cancellable = cancellable;
  }

  isCancellable(): boolean {
    return this._cancellable;
  }

  // Track whether the callee is currently suspended inside a blocking builtin
  // (waitableSetWait, waitableSetWaitCancellable, waitableSetPollCancellable,
  // threadYieldCancellable). When true, the callee's wasm is in V8's JSPI stack
  // and calling its callback would be incorrect (the callback may be unreachable).
  private _suspendedInBuiltin = false;

  setSuspendedInBuiltin(suspended: boolean): void {
    this._suspendedInBuiltin = suspended;
  }

  isSuspendedInBuiltin(): boolean {
    return this._suspendedInBuiltin;
  }

  // Context get/set for task-local storage (per spec)
  contextGet(slot: number): number {
    return this.storage[slot] ?? 0;
  }

  contextSet(slot: number, value: number): void {
    this.storage[slot] = value;
  }
}
