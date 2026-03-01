import { Waitable } from './waitable.ts';
import { CopyResult, CopyState, EventCode } from './types.ts';
import type { EventTuple, StreamBuffer, ReadableStreamBuffer, WritableStreamBuffer } from './types.ts';

// Re-export buffer types and CopyState for backward compatibility
export { CopyState } from './types.ts';
export type { StreamBuffer, ReadableStreamBuffer, WritableStreamBuffer } from './types.ts';

// Callback types for stream copy operations
export type ReclaimBuffer = () => void;
export type OnCopy = (reclaimBuffer: ReclaimBuffer) => void;
export type OnCopyDone = (result: CopyResult) => void;

// SharedStreamImpl: the core rendezvous logic for streams.
// Shared between a ReadableStreamEnd and WritableStreamEnd pair.
export class SharedStreamImpl {
  dropped = false;
  private pendingBuffer: StreamBuffer | null = null;
  private pendingOnCopy: OnCopy | null = null;
  private pendingOnCopyDone: OnCopyDone | null = null;
  private pendingIsWriter = false;

  private resetPending(): void {
    this.pendingBuffer = null;
    this.pendingOnCopy = null;
    this.pendingOnCopyDone = null;
    this.pendingIsWriter = false;
  }

  // Check if a zero-length reader is pending (waiting for data availability
  // notification). Used by host code to decide whether to wake the reader
  // with COMPLETED before dropping the writer.
  hasPendingZeroLengthReader(): boolean {
    return !!this.pendingBuffer && !this.pendingIsWriter &&
           this.pendingBuffer.remain() === 0;
  }

  // Host-side write: push items into the stream without wasm callbacks.
  // If a reader is pending, rendezvous happens immediately. Any remaining
  // data is stored as pending writer for future reads.
  // Optional onConsumed callback fires when pending data is fully consumed
  // by a reader, enabling flow control (e.g., flushing queued chunks).
  writeHost(buffer: ReadableStreamBuffer, onConsumed?: () => void): void {
    if (this.dropped) return;

    if (this.pendingBuffer && !this.pendingIsWriter) {
      // Reader is pending — rendezvous directly.
      const dstBuffer = this.pendingBuffer as WritableStreamBuffer;
      const readerOnCopyDone = this.pendingOnCopyDone!;

      if (dstBuffer.remain() > 0 && buffer.remain() > 0) {
        const n = Math.min(dstBuffer.remain(), buffer.remain());
        dstBuffer.write(buffer.read(n));
      }

      // Clear pending reader state immediately (no deferred cleanup).
      this.resetPending();

      // Notify reader that data was transferred.
      readerOnCopyDone(CopyResult.COMPLETED);
    }

    // Store remaining data (or all data if no reader was pending)
    // as pending writer for future reads.
    if (buffer.remain() > 0) {
      this.pendingBuffer = buffer;
      // Use onCopy slot to carry the onConsumed callback.
      // When the reader consumes this data, writerOnCopy fires.
      // Only reclaim (clear pending) and notify when ALL data is consumed,
      // otherwise partial data would be lost.
      this.pendingOnCopy = onConsumed ? (reclaimBuffer) => {
        if (buffer.remain() === 0) {
          reclaimBuffer();
          onConsumed();
        }
        // If data remains, don't reclaim — next read will consume more.
      } : null;
      this.pendingOnCopyDone = null;
      this.pendingIsWriter = true;
    } else if (onConsumed) {
      // All data was consumed immediately (reader was pending) — notify now.
      onConsumed();
    }
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
    if (!this.dropped) {
      this.dropped = true;
      if (this.pendingBuffer) {
        this.resetAndNotifyPending(CopyResult.DROPPED);
      }
    }
  }

  // Writer side is dropping. If pending writer data remains, keep it
  // so the reader can still consume it (stream close with buffered data).
  dropWriter(): void {
    if (!this.dropped) {
      this.dropped = true;
      if (this.pendingBuffer) {
        if (this.pendingIsWriter) {
          // Writer dropping with its own buffered data — keep for future reads.
          // Clear only the callbacks (writer is gone), keep the buffer.
          this.pendingOnCopy = null;
          this.pendingOnCopyDone = null;
        } else {
          // Reader is pending — notify it that the writer dropped.
          this.resetAndNotifyPending(CopyResult.DROPPED);
        }
      }
      if (this.onDropped) this.onDropped();
    }
  }

  // Reader side is dropping.
  dropReader(): void {
    if (!this.dropped) {
      this.dropped = true;
      if (this.pendingBuffer) {
        if (this.pendingIsWriter) {
          // Writer is pending — notify it that the reader dropped.
          this.resetAndNotifyPending(CopyResult.DROPPED);
        } else {
          // Reader dropping its own pending buffer — just clear it.
          this.resetPending();
        }
      }
      if (this.onDropped) this.onDropped();
    }
  }

  // Check if a writer is pending and return its remaining byte count.
  // Used by host code (e.g., Content-Length enforcement) to inspect the
  // pending write before deciding whether to accept or reject it.
  pendingWriteSize(): number | null {
    if (this.pendingBuffer && this.pendingIsWriter) {
      return this.pendingBuffer.remain();
    }
    return null;
  }

  // Optional callback invoked when either end drops.
  // Used by host code (e.g. receive) to detect guest-side stream drops.
  onDropped: (() => void) | null = null;

  // Read side: a reader wants to receive data into dstBuffer.
  // If a writer is already pending, rendezvous happens synchronously.
  read(
    dstBuffer: WritableStreamBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    if (this.dropped) {
      if (this.pendingBuffer && this.pendingIsWriter) {
        // Writer dropped but left buffered data — consume it.
        const srcBuffer = this.pendingBuffer as ReadableStreamBuffer;
        if (srcBuffer.remain() > 0 && dstBuffer.remain() > 0) {
          const n = Math.min(dstBuffer.remain(), srcBuffer.remain());
          dstBuffer.write(srcBuffer.read(n));
        }
        if (srcBuffer.remain() === 0) {
          // All data consumed — signal DROPPED (end of stream).
          this.resetPending();
          onCopyDone(CopyResult.DROPPED);
        } else {
          // More data remains — signal COMPLETED so reader reads again.
          onCopyDone(CopyResult.COMPLETED);
        }
      } else {
        onCopyDone(CopyResult.DROPPED);
      }
    } else if (!this.pendingBuffer) {
      // No writer yet - store as pending reader
      this.pendingBuffer = dstBuffer;
      this.pendingOnCopy = onCopy;
      this.pendingOnCopyDone = onCopyDone;
      this.pendingIsWriter = false;
    } else {
      // Writer is pending - rendezvous!
      const srcBuffer = this.pendingBuffer as ReadableStreamBuffer;
      const writerOnCopy = this.pendingOnCopy;

      if (srcBuffer.remain() > 0) {
        if (dstBuffer.remain() > 0) {
          const n = Math.min(dstBuffer.remain(), srcBuffer.remain());
          dstBuffer.write(srcBuffer.read(n));
          if (writerOnCopy) {
            // Guest writer: notify via callback with deferred cleanup
            const resetPending = () => this.resetPending();
            writerOnCopy(resetPending);
          } else if (srcBuffer.remain() === 0) {
            // Host writer (writeHost): no callbacks, just clear pending when consumed
            this.resetPending();
          }
        }
        onCopyDone(CopyResult.COMPLETED);
      } else {
        // Writer had remain()=0 — complete the writer, store reader.
        // Per spec: even if both zero-length, the reader blocks here.
        this.resetAndNotifyPending(CopyResult.COMPLETED);
        this.pendingBuffer = dstBuffer;
        this.pendingOnCopy = onCopy;
        this.pendingOnCopyDone = onCopyDone;
        this.pendingIsWriter = false;
      }
    }
  }

  // Write side: a writer wants to send data from srcBuffer.
  // If a reader is already pending, rendezvous happens synchronously.
  write(
    srcBuffer: ReadableStreamBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    if (this.dropped) {
      onCopyDone(CopyResult.DROPPED);
    } else if (!this.pendingBuffer) {
      // No reader yet - store as pending writer
      this.pendingBuffer = srcBuffer;
      this.pendingOnCopy = onCopy;
      this.pendingOnCopyDone = onCopyDone;
      this.pendingIsWriter = true;
    } else {
      // Reader is pending - rendezvous!
      const dstBuffer = this.pendingBuffer as WritableStreamBuffer;

      if (dstBuffer.remain() > 0) {
        if (srcBuffer.remain() > 0) {
          const n = Math.min(srcBuffer.remain(), dstBuffer.remain());
          dstBuffer.write(srcBuffer.read(n));
          const resetPending = () => this.resetPending();
          const readerOnCopy = this.pendingOnCopy!;
          readerOnCopy(resetPending);
        }
        onCopyDone(CopyResult.COMPLETED);
      } else if (srcBuffer.isZeroLength() && dstBuffer.isZeroLength()) {
        // Both zero-length: only writer completes.
        // Per spec: reader stays pending (woken by next non-zero write or drop).
        onCopyDone(CopyResult.COMPLETED);
      } else {
        // Reader had zero-length buffer but writer has data —
        // complete the reader and store writer as pending.
        this.resetAndNotifyPending(CopyResult.COMPLETED);
        this.pendingBuffer = srcBuffer;
        this.pendingOnCopy = onCopy;
        this.pendingOnCopyDone = onCopyDone;
        this.pendingIsWriter = true;
      }
    }
  }
}

// StreamEnd: base class for ReadableStreamEnd and WritableStreamEnd.
// Extends Waitable so stream ends can be joined to WaitableSets.
export class StreamEnd extends Waitable {
  state: CopyState = CopyState.IDLE;
  readonly shared: SharedStreamImpl;

  constructor(shared: SharedStreamImpl) {
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
    return 'stream copy: end is not IDLE';
  }

  liftDoneErrorMessage(): string {
    return this.doneErrorMessage();
  }

  override drop(): void {
    if (this.copying()) {
      throw new Error('cannot drop stream end while copy is in progress');
    }
    this.shared.drop();
    super.drop();
  }
}

// ReadableStreamEnd: the read side of a stream pair.
export class ReadableStreamEnd extends StreamEnd {
  copy(
    dstBuffer: WritableStreamBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    this.shared.read(dstBuffer, onCopy, onCopyDone);
  }

  override doneErrorMessage(): string {
    return 'cannot read from stream after being notified that the writable end dropped';
  }

  override liftDoneErrorMessage(): string {
    return 'cannot lift stream after being notified that the writable end dropped';
  }

  override drop(): void {
    if (this.copying()) {
      throw new Error('cannot remove busy stream');
    }
    this.shared.dropReader();
    Waitable.prototype.drop.call(this);
  }
}

// WritableStreamEnd: the write side of a stream pair.
export class WritableStreamEnd extends StreamEnd {
  copy(
    srcBuffer: ReadableStreamBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    this.shared.write(srcBuffer, onCopy, onCopyDone);
  }

  override doneErrorMessage(): string {
    return 'cannot write to stream after being notified that the readable end dropped';
  }

  override drop(): void {
    if (this.copying()) {
      throw new Error('cannot drop busy stream');
    }
    this.shared.dropWriter();
    Waitable.prototype.drop.call(this);
  }
}

// Create a new stream pair. Returns readable and writable ends.
export function createStream(): {
  readable: ReadableStreamEnd;
  writable: WritableStreamEnd;
} {
  const shared = new SharedStreamImpl();
  return {
    readable: new ReadableStreamEnd(shared),
    writable: new WritableStreamEnd(shared),
  };
}

// Set up stream copy callbacks and initiate the copy.
// Returns the event payload if completed synchronously, or undefined if pending.
function streamCopyStart(
  end: StreamEnd,
  eventCode: EventCode,
  handleIndex: number,
  buffer: StreamBuffer,
  copyFn: (
    buffer: StreamBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ) => void,
): number | undefined {
  if (end.state !== CopyState.IDLE) {
    throw new Error(end.doneErrorMessage());
  }

  const streamEvent = (result: CopyResult, reclaimBuffer: ReclaimBuffer): EventTuple => {
    reclaimBuffer();
    // Streams: DONE only after DROPPED
    end.state = (result === CopyResult.DROPPED)
      ? CopyState.DONE : CopyState.IDLE;
    const payload = result | (buffer.progress << 4);
    return { code: eventCode, index: handleIndex, payload };
  };

  const onCopy: OnCopy = (reclaimBuffer) => {
    end.setPendingEvent(() => streamEvent(CopyResult.COMPLETED, reclaimBuffer));
  };

  const onCopyDone: OnCopyDone = (result) => {
    end.setPendingEvent(() => streamEvent(result, () => {}));
  };

  copyFn(buffer, onCopy, onCopyDone);

  if (end.hasPendingEvent()) {
    const event = end.getPendingEvent()!;
    return event.payload;
  }

  return undefined; // pending
}

// Callback mode: returns event payload (sync completion) or null (BLOCKED).
// The caller polls/waits via waitable set for the pending event.
export function streamCopyAsync(
  end: StreamEnd,
  eventCode: EventCode,
  handleIndex: number,
  buffer: StreamBuffer,
  copyFn: (
    buffer: StreamBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ) => void,
): number | null {
  const result = streamCopyStart(end, eventCode, handleIndex, buffer, copyFn);
  if (result !== undefined) return result;

  end.state = CopyState.ASYNC_COPYING;
  return null; // BLOCKED
}

// JSPI mode: returns event payload (sync completion) or Promise<number>
// (JSPI suspends the wasm until the pending event arrives).
export function streamCopySync(
  end: StreamEnd,
  eventCode: EventCode,
  handleIndex: number,
  buffer: StreamBuffer,
  copyFn: (
    buffer: StreamBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ) => void,
): number | Promise<number> {
  const result = streamCopyStart(end, eventCode, handleIndex, buffer, copyFn);
  if (result !== undefined) return result;

  end.state = CopyState.SYNC_COPYING;
  return end.waitForPendingEvent().then(() => {
    const event = end.getPendingEvent()!;
    return event.payload;
  });
}
