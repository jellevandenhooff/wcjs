import { describe, it, assert } from '../runner.ts';
import {
  createFuture,
  FutureEnd,
  ReadableFutureEnd,
  WritableFutureEnd,
  futureCopyAsync,
} from '../../src/runtime/future.ts';
import type { OnFutureCopyDone } from '../../src/runtime/future.ts';
import type {
  WritableStreamBuffer,
  ReadableStreamBuffer,
  StreamBuffer,
} from '../../src/runtime/types.ts';
import { EventCode, CopyResult, CopyState } from '../../src/runtime/types.ts';
import { WaitableSet } from '../../src/runtime/waitable-set.ts';

class TestWritableBuffer implements WritableStreamBuffer {
  items: unknown[] = [];
  progress = 0;
  private _count: number;
  constructor(count: number) { this._count = count; }
  remain(): number { return this._count - this.progress; }
  isZeroLength(): boolean { return this._count === 0; }
  write(items: unknown[]): void {
    this.items.push(...items);
    this.progress += items.length;
  }
}

class TestReadableBuffer implements ReadableStreamBuffer {
  progress = 0;
  private _items: unknown[];
  constructor(items: unknown[]) { this._items = items; }
  remain(): number { return this._items.length - this.progress; }
  isZeroLength(): boolean { return this._items.length === 0; }
  read(n: number): unknown[] {
    const result = this._items.slice(this.progress, this.progress + n);
    this.progress += n;
    return result;
  }
}

describe('Future', () => {
  it('creates a readable and writable pair', () => {
    const { readable, writable } = createFuture();
    assert.ok(readable instanceof ReadableFutureEnd);
    assert.ok(writable instanceof WritableFutureEnd);
  });

  it('write then read: synchronous rendezvous', () => {
    const { readable, writable } = createFuture();

    const srcBuf = new TestReadableBuffer([42]);
    const writeResult = futureCopyAsync(
      writable, EventCode.FUTURE_WRITE, 1, srcBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        writable.copy(buf as ReadableStreamBuffer, onCopyDone),
    );
    assert.strictEqual(writeResult, null);

    const dstBuf = new TestWritableBuffer(1);
    const readResult = futureCopyAsync(
      readable, EventCode.FUTURE_READ, 2, dstBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        readable.copy(buf as WritableStreamBuffer, onCopyDone),
    );
    assert.strictEqual(readResult, CopyResult.COMPLETED);
    assert.deepStrictEqual(dstBuf.items, [42]);
  });

  it('read then write: synchronous rendezvous', () => {
    const { readable, writable } = createFuture();

    const dstBuf = new TestWritableBuffer(1);
    const readResult = futureCopyAsync(
      readable, EventCode.FUTURE_READ, 1, dstBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        readable.copy(buf as WritableStreamBuffer, onCopyDone),
    );
    assert.strictEqual(readResult, null);

    const srcBuf = new TestReadableBuffer([99]);
    const writeResult = futureCopyAsync(
      writable, EventCode.FUTURE_WRITE, 2, srcBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        writable.copy(buf as ReadableStreamBuffer, onCopyDone),
    );
    assert.strictEqual(writeResult, CopyResult.COMPLETED);
    assert.deepStrictEqual(dstBuf.items, [99]);
  });

  it('void future (elem_size=0): read then write rendezvous', () => {
    const { readable, writable } = createFuture();

    const dstBuf = new TestWritableBuffer(0);
    const readResult = futureCopyAsync(
      readable, EventCode.FUTURE_READ, 1, dstBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        readable.copy(buf as WritableStreamBuffer, onCopyDone),
    );
    assert.strictEqual(readResult, null);

    const srcBuf = new TestReadableBuffer([]);
    const writeResult = futureCopyAsync(
      writable, EventCode.FUTURE_WRITE, 2, srcBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        writable.copy(buf as ReadableStreamBuffer, onCopyDone),
    );
    assert.strictEqual(writeResult, CopyResult.COMPLETED);
  });

  it('delivers FUTURE_READ event when write completes pending read', () => {
    const { readable, writable } = createFuture();

    const ws = new WaitableSet();
    readable.join(ws);

    const dstBuf = new TestWritableBuffer(1);
    futureCopyAsync(
      readable, EventCode.FUTURE_READ, 5, dstBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        readable.copy(buf as WritableStreamBuffer, onCopyDone),
    );

    const srcBuf = new TestReadableBuffer([77]);
    futureCopyAsync(
      writable, EventCode.FUTURE_WRITE, 6, srcBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        writable.copy(buf as ReadableStreamBuffer, onCopyDone),
    );

    assert.strictEqual(readable.hasPendingEvent(), true);
    const event = ws.poll();
    assert.strictEqual(event.code, EventCode.FUTURE_READ);
    assert.strictEqual(event.index, 5);
  });

  it('drop-writable traps if not written', () => {
    const { writable } = createFuture();
    assert.throws(() => writable.drop(), { message: /cannot drop future write end without first writing a value/ });
  });

  it('drop-writable succeeds after write+read rendezvous', () => {
    const { readable, writable } = createFuture();

    const srcBuf = new TestReadableBuffer([10]);
    futureCopyAsync(
      writable, EventCode.FUTURE_WRITE, 1, srcBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        writable.copy(buf as ReadableStreamBuffer, onCopyDone),
    );
    assert.strictEqual((writable as WritableFutureEnd).hasBeenWritten, true);

    const dstBuf = new TestWritableBuffer(1);
    futureCopyAsync(
      readable, EventCode.FUTURE_READ, 2, dstBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        readable.copy(buf as WritableStreamBuffer, onCopyDone),
    );
    assert.deepStrictEqual(dstBuf.items, [10]);

    if (writable.hasPendingEvent()) writable.getPendingEvent();
    if (readable.hasPendingEvent()) readable.getPendingEvent();

    writable.drop(); // should not throw
    readable.drop(); // should not throw
  });

  it('drop-writable succeeds when readable was already dropped', () => {
    const { readable, writable } = createFuture();
    readable.drop();
    writable.drop(); // should not throw
  });

  it('drop-readable succeeds without reading', () => {
    const { readable, writable } = createFuture();
    readable.drop(); // should not throw

    const srcBuf = new TestReadableBuffer([10]);
    const writeResult = futureCopyAsync(
      writable, EventCode.FUTURE_WRITE, 1, srcBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        writable.copy(buf as ReadableStreamBuffer, onCopyDone),
    );
    assert.strictEqual(writeResult, CopyResult.DROPPED);

    if (writable.hasPendingEvent()) writable.getPendingEvent();
    writable.drop();
  });

  it('future ends go to DONE state after completion', () => {
    const { readable, writable } = createFuture();

    const srcBuf = new TestReadableBuffer([42]);
    futureCopyAsync(
      writable, EventCode.FUTURE_WRITE, 1, srcBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        writable.copy(buf as ReadableStreamBuffer, onCopyDone),
    );

    const dstBuf = new TestWritableBuffer(1);
    futureCopyAsync(
      readable, EventCode.FUTURE_READ, 2, dstBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        readable.copy(buf as WritableStreamBuffer, onCopyDone),
    );

    if (writable.hasPendingEvent()) writable.getPendingEvent();
    if (readable.hasPendingEvent()) readable.getPendingEvent();

    assert.strictEqual(writable.state, CopyState.DONE);
    assert.strictEqual(readable.state, CopyState.DONE);
  });

  it('futureCopyAsync traps on DONE future', () => {
    const { readable, writable } = createFuture();

    const dstBuf = new TestWritableBuffer(1);
    futureCopyAsync(
      readable, EventCode.FUTURE_READ, 1, dstBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        readable.copy(buf as WritableStreamBuffer, onCopyDone),
    );
    const srcBuf = new TestReadableBuffer([42]);
    futureCopyAsync(
      writable, EventCode.FUTURE_WRITE, 2, srcBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        writable.copy(buf as ReadableStreamBuffer, onCopyDone),
    );

    if (readable.hasPendingEvent()) readable.getPendingEvent();
    if (writable.hasPendingEvent()) writable.getPendingEvent();

    assert.throws(() => futureCopyAsync(
      readable, EventCode.FUTURE_READ, 1, new TestWritableBuffer(1),
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        readable.copy(buf as WritableStreamBuffer, onCopyDone),
    ), { message: /cannot read from future after previous read succeeded/ });

    assert.throws(() => futureCopyAsync(
      writable, EventCode.FUTURE_WRITE, 2, new TestReadableBuffer([1]),
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        writable.copy(buf as ReadableStreamBuffer, onCopyDone),
    ), { message: /cannot write to future after previous write succeeded/ });
  });

  it('future payload does not pack progress', () => {
    const { readable, writable } = createFuture();

    const dstBuf = new TestWritableBuffer(1);
    futureCopyAsync(
      readable, EventCode.FUTURE_READ, 1, dstBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        readable.copy(buf as WritableStreamBuffer, onCopyDone),
    );

    const srcBuf = new TestReadableBuffer([42]);
    const writeResult = futureCopyAsync(
      writable, EventCode.FUTURE_WRITE, 2, srcBuf,
      (buf: StreamBuffer, onCopyDone: OnFutureCopyDone) =>
        writable.copy(buf as ReadableStreamBuffer, onCopyDone),
    );
    assert.strictEqual(writeResult, 0); // CopyResult.COMPLETED
    assert.notStrictEqual(writeResult, 16);
  });
});
