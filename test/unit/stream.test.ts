import { describe, it, assert } from '../runner.ts';
import {
  createStream,
  CopyState,
  streamCopyAsync,
} from '../../src/runtime/stream.ts';
import type {
  ReadableStreamBuffer,
  WritableStreamBuffer,
} from '../../src/runtime/stream.ts';
import { WaitableSet } from '../../src/runtime/waitable-set.ts';
import { EventCode, CopyResult } from '../../src/runtime/types.ts';

function makeReadBuffer(items: unknown[]): ReadableStreamBuffer {
  let pos = 0;
  return {
    progress: 0,
    remain() { return items.length - pos; },
    isZeroLength() { return items.length === 0; },
    read(n: number) {
      const result = items.slice(pos, pos + n);
      pos += n;
      this.progress += n;
      return result;
    },
  };
}

function makeWriteBuffer(capacity: number): WritableStreamBuffer & { items: unknown[] } {
  const items: unknown[] = [];
  return {
    items,
    progress: 0,
    remain() { return capacity - items.length; },
    isZeroLength() { return capacity === 0; },
    write(data: unknown[]) {
      items.push(...data);
      this.progress += data.length;
    },
  };
}

describe('Stream', () => {
  describe('createStream', () => {
    it('creates readable and writable ends', () => {
      const { readable, writable } = createStream();
      assert.ok(readable);
      assert.ok(writable);
      assert.strictEqual(readable.state, CopyState.IDLE);
      assert.strictEqual(writable.state, CopyState.IDLE);
    });
  });

  describe('sync rendezvous (writer first, then reader)', () => {
    it('transfers data when writer arrives first', () => {
      const { readable, writable } = createStream();

      writable.copy(makeReadBuffer([1, 2, 3]), () => {}, () => {});

      const dst = makeWriteBuffer(10);
      let readResult: CopyResult | null = null;
      readable.copy(dst, () => {}, (result) => { readResult = result; });

      assert.strictEqual(readResult, CopyResult.COMPLETED);
      assert.deepStrictEqual(dst.items, [1, 2, 3]);
    });

    it('transfers data when reader arrives first', () => {
      const { readable, writable } = createStream();

      const dst = makeWriteBuffer(10);
      let readResult: CopyResult | null = null;
      readable.copy(dst, () => {}, (result) => { readResult = result; });

      writable.copy(makeReadBuffer([4, 5, 6]), () => {}, () => {});

      // Writer completes first, reader gets data
      assert.deepStrictEqual(dst.items, [4, 5, 6]);
    });
  });

  describe('partial transfers', () => {
    it('transfers min(src, dst) items', () => {
      const { readable, writable } = createStream();

      writable.copy(makeReadBuffer([10, 20, 30, 40, 50]), () => {}, () => {});

      const dst = makeWriteBuffer(3);
      let readResult: CopyResult | null = null;
      readable.copy(dst, () => {}, (result) => { readResult = result; });

      assert.strictEqual(readResult, CopyResult.COMPLETED);
      assert.deepStrictEqual(dst.items, [10, 20, 30]);
    });
  });

  describe('drop behavior', () => {
    it('writer drop notifies pending reader', () => {
      const { readable, writable } = createStream();

      readable.copy(makeWriteBuffer(10), () => {}, () => {});
      writable.drop();

      let readResult2: CopyResult | null = null;
      readable.copy(makeWriteBuffer(10), () => {}, (result) => { readResult2 = result; });
      assert.strictEqual(readResult2, CopyResult.DROPPED);
    });

    it('reader drop notifies pending writer', () => {
      const { readable, writable } = createStream();

      writable.copy(makeReadBuffer([1, 2]), () => {}, () => {});
      readable.drop();

      let writeResult2: CopyResult | null = null;
      writable.copy(makeReadBuffer([3, 4]), () => {}, (result) => { writeResult2 = result; });
      assert.strictEqual(writeResult2, CopyResult.DROPPED);
    });
  });

  describe('streamCopyAsync helper', () => {
    it('returns payload for sync completion', () => {
      const { readable, writable } = createStream();

      writable.copy(makeReadBuffer([1, 2, 3]), () => {}, () => {});

      const dst = makeWriteBuffer(10);
      const payload = streamCopyAsync(
        readable, EventCode.STREAM_READ, 1, dst,
        (buffer, onCopy, onCopyDone) => {
          readable.copy(buffer as WritableStreamBuffer, onCopy, onCopyDone);
        },
      );

      assert.ok(payload !== null);
      assert.deepStrictEqual(dst.items, [1, 2, 3]);
    });

    it('returns null (BLOCKED) for async pending', () => {
      const { readable } = createStream();

      const dst = makeWriteBuffer(10);
      const payload = streamCopyAsync(
        readable, EventCode.STREAM_READ, 1, dst,
        (buffer, onCopy, onCopyDone) => {
          readable.copy(buffer as WritableStreamBuffer, onCopy, onCopyDone);
        },
      );

      assert.strictEqual(payload, null);
      assert.strictEqual(readable.state, CopyState.ASYNC_COPYING);
    });
  });

  describe('WaitableSet integration', () => {
    it('delivers stream event via WaitableSet', async () => {
      const { readable, writable } = createStream();
      const ws = new WaitableSet();
      readable.join(ws);

      const dst = makeWriteBuffer(10);
      streamCopyAsync(
        readable, EventCode.STREAM_READ, 42, dst,
        (buffer, onCopy, onCopyDone) => {
          readable.copy(buffer as WritableStreamBuffer, onCopy, onCopyDone);
        },
      );

      const waitPromise = ws.wait();

      writable.copy(makeReadBuffer([7, 8, 9]), () => {}, () => {});

      const event = await waitPromise;
      assert.strictEqual(event.code, EventCode.STREAM_READ);
      assert.strictEqual(event.index, 42);
      assert.deepStrictEqual(dst.items, [7, 8, 9]);
    });
  });
});
