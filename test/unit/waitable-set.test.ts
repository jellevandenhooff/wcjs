import { describe, it, assert } from '../runner.ts';
import { Waitable } from '../../src/runtime/waitable.ts';
import { WaitableSet } from '../../src/runtime/waitable-set.ts';
import { EventCode } from '../../src/runtime/types.ts';

describe('Waitable', () => {
  it('starts with no pending event', () => {
    const w = new Waitable();
    assert.strictEqual(w.hasPendingEvent(), false);
    assert.strictEqual(w.getPendingEvent(), null);
  });

  it('can set and consume a pending event', () => {
    const w = new Waitable();
    w.setPendingEvent(() => ({
      code: EventCode.SUBTASK,
      index: 1,
      payload: 2,
    }));
    assert.strictEqual(w.hasPendingEvent(), true);

    const event = w.getPendingEvent();
    assert.deepStrictEqual(event, { code: EventCode.SUBTASK, index: 1, payload: 2 });
    assert.strictEqual(w.hasPendingEvent(), false);
  });

  it('pending event is a closure called on get', () => {
    let callCount = 0;
    const w = new Waitable();
    w.setPendingEvent(() => {
      callCount++;
      return { code: EventCode.STREAM_READ, index: 5, payload: 10 };
    });
    assert.strictEqual(callCount, 0);
    w.getPendingEvent();
    assert.strictEqual(callCount, 1);
  });

  it('join/leave waitable set', () => {
    const w = new Waitable();
    const ws = new WaitableSet();
    w.join(ws);
    assert.strictEqual(ws.size, 1);
    assert.strictEqual(w.waitableSet, ws);

    w.join(null);
    assert.strictEqual(ws.size, 0);
    assert.strictEqual(w.waitableSet, null);
  });

  it('joining a new set leaves the old set', () => {
    const w = new Waitable();
    const ws1 = new WaitableSet();
    const ws2 = new WaitableSet();
    w.join(ws1);
    assert.strictEqual(ws1.size, 1);
    w.join(ws2);
    assert.strictEqual(ws1.size, 0);
    assert.strictEqual(ws2.size, 1);
  });

  it('drop() removes from set', () => {
    const w = new Waitable();
    const ws = new WaitableSet();
    w.join(ws);
    w.drop();
    assert.strictEqual(ws.size, 0);
  });

  it('drop() throws if pending event exists', () => {
    const w = new Waitable();
    w.setPendingEvent(() => ({ code: EventCode.NONE, index: 0, payload: 0 }));
    assert.throws(() => w.drop(), { message: /cannot drop waitable with pending event/ });
  });
});

describe('WaitableSet', () => {
  it('poll() returns NONE when empty', () => {
    const ws = new WaitableSet();
    const event = ws.poll();
    assert.strictEqual(event.code, EventCode.NONE);
  });

  it('poll() returns NONE when no pending events', () => {
    const ws = new WaitableSet();
    const w = new Waitable();
    w.join(ws);
    const event = ws.poll();
    assert.strictEqual(event.code, EventCode.NONE);
  });

  it('poll() returns pending event', () => {
    const ws = new WaitableSet();
    const w = new Waitable();
    w.join(ws);
    w.setPendingEvent(() => ({
      code: EventCode.SUBTASK,
      index: 7,
      payload: 42,
    }));

    const event = ws.poll();
    assert.deepStrictEqual(event, { code: EventCode.SUBTASK, index: 7, payload: 42 });

    const event2 = ws.poll();
    assert.strictEqual(event2.code, EventCode.NONE);
  });

  it('poll() with multiple waitables returns one event', () => {
    const ws = new WaitableSet();
    const w1 = new Waitable();
    const w2 = new Waitable();
    w1.join(ws);
    w2.join(ws);

    w1.setPendingEvent(() => ({
      code: EventCode.SUBTASK,
      index: 1,
      payload: 0,
    }));
    w2.setPendingEvent(() => ({
      code: EventCode.STREAM_READ,
      index: 2,
      payload: 0,
    }));

    const event1 = ws.poll();
    assert.ok(event1.code === EventCode.SUBTASK || event1.code === EventCode.STREAM_READ);

    const event2 = ws.poll();
    assert.ok(event2.code === EventCode.SUBTASK || event2.code === EventCode.STREAM_READ);
    assert.notStrictEqual(event2.code, event1.code);

    assert.strictEqual(ws.poll().code, EventCode.NONE);
  });

  it('wait() resolves immediately if event is pending', async () => {
    const ws = new WaitableSet();
    const w = new Waitable();
    w.join(ws);
    w.setPendingEvent(() => ({
      code: EventCode.SUBTASK,
      index: 3,
      payload: 99,
    }));

    const event = await ws.wait();
    assert.deepStrictEqual(event, { code: EventCode.SUBTASK, index: 3, payload: 99 });
  });

  it('wait() blocks until event arrives', async () => {
    const ws = new WaitableSet();
    const w = new Waitable();
    w.join(ws);

    let resolved = false;
    const waitPromise = ws.wait().then((event) => {
      resolved = true;
      return event;
    });

    await Promise.resolve();
    assert.strictEqual(resolved, false);

    w.setPendingEvent(() => ({
      code: EventCode.STREAM_WRITE,
      index: 4,
      payload: 100,
    }));

    const event = await waitPromise;
    assert.strictEqual(resolved, true);
    assert.deepStrictEqual(event, {
      code: EventCode.STREAM_WRITE,
      index: 4,
      payload: 100,
    });
  });

  it('drop() succeeds when empty', () => {
    const ws = new WaitableSet();
    ws.drop(); // should not throw
  });

  it('drop() throws when waitables are joined', () => {
    const ws = new WaitableSet();
    const w = new Waitable();
    w.join(ws);
    assert.throws(() => ws.drop(), { message: /cannot drop waitable set with waiters/ });
  });

  it('multiple waitables can join and leave', () => {
    const ws = new WaitableSet();
    const w1 = new Waitable();
    const w2 = new Waitable();
    const w3 = new Waitable();

    w1.join(ws);
    w2.join(ws);
    w3.join(ws);
    assert.strictEqual(ws.size, 3);

    w2.join(null);
    assert.strictEqual(ws.size, 2);

    w1.join(null);
    w3.join(null);
    assert.strictEqual(ws.size, 0);
  });
});
