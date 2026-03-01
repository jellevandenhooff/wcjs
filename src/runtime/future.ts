import { Waitable } from './waitable.ts';
import { CopyResult, CopyState, EventCode } from './types.ts';
import type { EventTuple, StreamBuffer, ReadableStreamBuffer, WritableStreamBuffer } from './types.ts';

// Callback type for future copy completion
export type OnFutureCopyDone = (result: CopyResult) => void;

// SharedFutureImpl: the core rendezvous logic for futures.
// Simpler than SharedStreamImpl because futures are one-shot:
// - No zero-length buffer complexity
// - Both sides always complete on rendezvous
export class SharedFutureImpl {
  dropped = false;
  // When true, drop() is a no-op. Used when the host has claimed ownership
  // of this future's data (e.g., HTTP request trailers). The canonical ABI
  // adapter drops the readable end as part of ownership transfer, but in our
  // single-table implementation this would prematurely signal DROPPED.
  hostOwned = false;
  private pendingBuffer: StreamBuffer | null = null;
  private pendingOnCopyDone: OnFutureCopyDone | null = null;

  private resetPending(): void {
    this.pendingBuffer = null;
    this.pendingOnCopyDone = null;
  }

  private resetAndNotifyPending(result: CopyResult): void {
    const onCopyDone = this.pendingOnCopyDone;
    this.resetPending();
    if (onCopyDone) onCopyDone(result);
  }

  cancel(): void {
    if (!this.pendingBuffer) {
      return;
    }
    this.resetAndNotifyPending(CopyResult.CANCELLED);
  }

  drop(): void {
    if (this.hostOwned) return;
    if (!this.dropped) {
      this.dropped = true;
      if (this.pendingBuffer) {
        this.resetAndNotifyPending(CopyResult.DROPPED);
      }
    }
  }

  // Read side: a reader wants to receive data into dstBuffer.
  read(dstBuffer: WritableStreamBuffer, onCopyDone: OnFutureCopyDone): void {
    if (this.dropped) {
      onCopyDone(CopyResult.DROPPED);
    } else if (!this.pendingBuffer) {
      this.pendingBuffer = dstBuffer;
      this.pendingOnCopyDone = onCopyDone;
    } else {
      // Writer is pending - rendezvous!
      const srcBuffer = this.pendingBuffer as ReadableStreamBuffer;
      if (srcBuffer.remain() > 0 && dstBuffer.remain() > 0) {
        const n = Math.min(dstBuffer.remain(), srcBuffer.remain());
        dstBuffer.write(srcBuffer.read(n));
      }
      // Futures: both sides always complete on rendezvous
      this.resetAndNotifyPending(CopyResult.COMPLETED);
      onCopyDone(CopyResult.COMPLETED);
    }
  }

  // Write side: a writer wants to send data from srcBuffer.
  write(srcBuffer: ReadableStreamBuffer, onCopyDone: OnFutureCopyDone): void {
    if (this.dropped) {
      onCopyDone(CopyResult.DROPPED);
    } else if (!this.pendingBuffer) {
      this.pendingBuffer = srcBuffer;
      this.pendingOnCopyDone = onCopyDone;
    } else {
      // Reader is pending - rendezvous!
      const dstBuffer = this.pendingBuffer as WritableStreamBuffer;
      if (dstBuffer.remain() > 0 && srcBuffer.remain() > 0) {
        const n = Math.min(srcBuffer.remain(), dstBuffer.remain());
        dstBuffer.write(srcBuffer.read(n));
      }
      // Futures: both sides always complete on rendezvous
      this.resetAndNotifyPending(CopyResult.COMPLETED);
      onCopyDone(CopyResult.COMPLETED);
    }
  }
}

// FutureEnd: base class for ReadableFutureEnd and WritableFutureEnd.
// Extends Waitable so future ends can be joined to WaitableSets.
export class FutureEnd extends Waitable {
  state: CopyState = CopyState.IDLE;
  readonly shared: SharedFutureImpl;

  constructor(shared: SharedFutureImpl) {
    super();
    this.shared = shared;
  }

  copying(): boolean {
    return (
      this.state === CopyState.SYNC_COPYING ||
      this.state === CopyState.ASYNC_COPYING ||
      this.state === CopyState.CANCELLING_COPY
    );
  }

  doneErrorMessage(): string {
    return 'future copy: end is not IDLE';
  }

  liftDoneErrorMessage(): string {
    return this.doneErrorMessage();
  }

  override drop(): void {
    if (this.copying()) {
      throw new Error('cannot drop future end while copy is in progress');
    }
    this.shared.drop();
    super.drop();
  }
}

// ReadableFutureEnd: the read side of a future pair.
export class ReadableFutureEnd extends FutureEnd {
  copy(dstBuffer: WritableStreamBuffer, onCopyDone: OnFutureCopyDone): void {
    this.shared.read(dstBuffer, onCopyDone);
  }

  override doneErrorMessage(): string {
    return 'cannot read from future after previous read succeeded';
  }

  override liftDoneErrorMessage(): string {
    return 'cannot lift future after previous read succeeded';
  }
}

// WritableFutureEnd: the write side of a future pair.
// Unlike streams, dropping the writable end without writing traps.
export class WritableFutureEnd extends FutureEnd {
  private _written = false;

  copy(srcBuffer: ReadableStreamBuffer, onCopyDone: OnFutureCopyDone): void {
    this._written = true;
    this.shared.write(srcBuffer, onCopyDone);
  }

  get hasBeenWritten(): boolean {
    return this._written;
  }

  override doneErrorMessage(): string {
    if (this.shared.dropped) {
      return 'cannot write to future after previous write succeeded or readable end dropped';
    }
    return 'cannot write to future after previous write succeeded';
  }

  override drop(): void {
    // Per spec: trap_if(self.state != CopyState.DONE)
    // But allow drop if readable end was already dropped (no writer can complete).
    if (this.state !== CopyState.DONE && !this.shared.dropped) {
      throw new Error('cannot drop future write end without first writing a value');
    }
    super.drop();
  }
}

// Create a new future pair. Returns readable and writable ends.
export function createFuture(): {
  readable: ReadableFutureEnd;
  writable: WritableFutureEnd;
} {
  const shared = new SharedFutureImpl();
  return {
    readable: new ReadableFutureEnd(shared),
    writable: new WritableFutureEnd(shared),
  };
}

// Set up future copy callbacks and initiate the copy.
// Returns the event payload if completed synchronously, or undefined if pending.
function futureCopyStart(
  end: FutureEnd,
  eventCode: EventCode,
  handleIndex: number,
  buffer: StreamBuffer,
  copyFn: (buffer: StreamBuffer, onCopyDone: OnFutureCopyDone) => void,
): number | undefined {
  if (end.state !== CopyState.IDLE) {
    throw new Error(end.doneErrorMessage());
  }

  const futureEvent = (result: CopyResult): EventTuple => {
    // Futures: DONE after COMPLETED or DROPPED (one-shot)
    end.state = (result === CopyResult.DROPPED || result === CopyResult.COMPLETED)
      ? CopyState.DONE : CopyState.IDLE;
    // Futures don't pack progress — payload is just the result
    return { code: eventCode, index: handleIndex, payload: result };
  };

  const onCopyDone: OnFutureCopyDone = (result) => {
    end.setPendingEvent(() => futureEvent(result));
  };

  copyFn(buffer, onCopyDone);

  if (end.hasPendingEvent()) {
    const event = end.getPendingEvent()!;
    return event.payload;
  }

  return undefined; // pending
}

// Callback mode: returns event payload (sync completion) or null (BLOCKED).
// The caller polls/waits via waitable set for the pending event.
export function futureCopyAsync(
  end: FutureEnd,
  eventCode: EventCode,
  handleIndex: number,
  buffer: StreamBuffer,
  copyFn: (buffer: StreamBuffer, onCopyDone: OnFutureCopyDone) => void,
): number | null {
  const result = futureCopyStart(end, eventCode, handleIndex, buffer, copyFn);
  if (result !== undefined) return result;

  end.state = CopyState.ASYNC_COPYING;
  return null; // BLOCKED
}

// JSPI mode: returns event payload (sync completion) or Promise<number>
// (JSPI suspends the wasm until the pending event arrives).
export function futureCopySync(
  end: FutureEnd,
  eventCode: EventCode,
  handleIndex: number,
  buffer: StreamBuffer,
  copyFn: (buffer: StreamBuffer, onCopyDone: OnFutureCopyDone) => void,
): number | Promise<number> {
  const result = futureCopyStart(end, eventCode, handleIndex, buffer, copyFn);
  if (result !== undefined) return result;

  end.state = CopyState.SYNC_COPYING;
  return end.waitForPendingEvent().then(() => {
    const event = end.getPendingEvent()!;
    return event.payload;
  });
}
