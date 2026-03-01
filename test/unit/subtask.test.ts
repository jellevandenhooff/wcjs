import { describe, it, assert } from '../runner.ts';
import { Subtask } from '../../src/runtime/subtask.ts';
import { AsyncTask } from '../../src/runtime/task.ts';
import { ComponentState } from '../../src/runtime/component-state.ts';
import { WaitableSet } from '../../src/runtime/waitable-set.ts';
import { EventCode, CallbackCode, SubtaskState } from '../../src/runtime/types.ts';

describe('Subtask', () => {
  it('starts in STARTING state', () => {
    const s = new Subtask();
    assert.strictEqual(s.getState(), SubtaskState.STARTING);
    assert.strictEqual(s.resolved(), false);
  });

  it('transitions STARTING -> STARTED on onStart()', () => {
    const s = new Subtask();
    s.onStart();
    assert.strictEqual(s.getState(), SubtaskState.STARTED);
    assert.strictEqual(s.resolved(), false);
  });

  it('onStart does NOT set a pending event', () => {
    const s = new Subtask();
    s.setHandleIndex(5);
    const ws = new WaitableSet();
    s.join(ws);

    s.onStart();
    assert.strictEqual(s.hasPendingEvent(), false);
  });

  it('transitions STARTED -> RETURNED on onResolve(result)', () => {
    const s = new Subtask();
    s.onStart();
    s.onResolve({ tag: 'ok' });
    assert.strictEqual(s.getState(), SubtaskState.RETURNED);
    assert.strictEqual(s.resolved(), true);
  });

  it('delivers SUBTASK event on resolve', () => {
    const s = new Subtask();
    s.setHandleIndex(3);
    const ws = new WaitableSet();
    s.join(ws);

    s.onStart();
    s.onResolve({ value: 42 });
    assert.strictEqual(s.resolved(), true);
    assert.strictEqual(s.isResolveDelivered(), false);

    const event = ws.poll();
    assert.strictEqual(event.code, EventCode.SUBTASK);
    assert.strictEqual(event.payload, SubtaskState.RETURNED);
    assert.strictEqual(s.isResolveDelivered(), true);
  });

  it('can be dropped after resolve is delivered', () => {
    const s = new Subtask();
    s.setHandleIndex(1);
    const ws = new WaitableSet();
    s.join(ws);

    s.onStart();
    s.onResolve('done');
    ws.poll(); // consume resolve event

    assert.strictEqual(s.isResolveDelivered(), true);
    s.drop(); // should not throw
  });

  it('cannot be dropped before resolve is delivered', () => {
    const s = new Subtask();
    s.onStart();
    s.onResolve('done');
    assert.throws(() => s.drop(), { message: /cannot drop a subtask which has not yet resolved/ });
  });

  it('can be dropped after instant completion', () => {
    const s = new Subtask();
    s.setHandleIndex(1);
    s.onStart();
    s.onResolve(true);
    assert.strictEqual(s.getState(), SubtaskState.RETURNED);
    assert.strictEqual(s.resolved(), true);

    assert.strictEqual(s.hasPendingEvent(), true);
    const event = s.getPendingEvent();
    assert.ok(event !== null);
    assert.strictEqual(event!.code, EventCode.SUBTASK);
    assert.strictEqual(event!.payload, SubtaskState.RETURNED);
    assert.strictEqual(s.isResolveDelivered(), true);

    s.drop(); // should not throw
  });

  it('handles cancellation before start', () => {
    const s = new Subtask();
    s.setHandleIndex(2);
    s.onResolve(undefined);
    assert.strictEqual(s.getState(), SubtaskState.CANCELLED_BEFORE_STARTED);
    assert.strictEqual(s.resolved(), true);
  });

  it('handles cancellation after start', () => {
    const s = new Subtask();
    s.setHandleIndex(2);
    s.onStart();
    s.onResolve(undefined);
    assert.strictEqual(s.getState(), SubtaskState.CANCELLED_BEFORE_RETURNED);
    assert.strictEqual(s.resolved(), true);
  });

  it('tryInlineCancel returns false when callee is suspended in builtin', () => {
    const s = new Subtask();
    s.setHandleIndex(1);
    s.onStart();

    const calleeTask = new AsyncTask();
    const calleeState = new ComponentState(1);
    s.calleeTask = calleeTask;
    s.calleeState = calleeState;
    s.calleeCallbackFn = (_ec: number, _p1: number, _p2: number) => CallbackCode.EXIT;

    calleeTask.setSuspendedInBuiltin(true);

    assert.strictEqual(s.tryInlineCancel(), false);
    assert.strictEqual(s.resolved(), false);
  });

  it('tryInlineCancel works when callee is NOT suspended in builtin', () => {
    const s = new Subtask();
    s.setHandleIndex(1);
    s.onStart();

    const calleeTask = new AsyncTask();
    const calleeState = new ComponentState(1);
    calleeState.currentTask = calleeTask;
    s.calleeTask = calleeTask;
    s.calleeState = calleeState;
    s.calleeCallbackFn = (ec: number, _p1: number, _p2: number) => {
      if (ec === EventCode.TASK_CANCELLED) {
        calleeTask.cancel();
        return CallbackCode.EXIT;
      }
      return CallbackCode.EXIT;
    };

    assert.strictEqual(calleeTask.isSuspendedInBuiltin(), false);
    assert.strictEqual(s.tryInlineCancel(), true);
    assert.strictEqual(s.getState(), SubtaskState.CANCELLED_BEFORE_RETURNED);
    assert.strictEqual(calleeTask.isCancelled(), true);
  });

  it('wait() on set resolves when subtask completes', async () => {
    const s = new Subtask();
    s.setHandleIndex(7);
    const ws = new WaitableSet();
    s.join(ws);

    s.onStart();

    const waitPromise = ws.wait();
    s.onResolve({ value: 'hello' });

    const event = await waitPromise;
    assert.strictEqual(event.code, EventCode.SUBTASK);
    assert.strictEqual(event.index, 7);
    assert.strictEqual(event.payload, SubtaskState.RETURNED);
  });
});
