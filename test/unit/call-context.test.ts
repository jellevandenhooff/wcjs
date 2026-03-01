import { describe, it, assert } from '../runner.ts';
import { CallContext } from '../../src/runtime/call-context.ts';
import { ComponentState } from '../../src/runtime/component-state.ts';
import { AsyncTask } from '../../src/runtime/task.ts';
import { EventLoop } from '../../src/runtime/event-loop.ts';
import { CallbackCode, SubtaskState } from '../../src/runtime/types.ts';

// Simple mock function tracker (replaces vi.fn())
function mockFn(impl?: (...args: unknown[]) => unknown) {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
    return impl?.(...args);
  };
  fn.calls = calls;
  fn.called = () => calls.length > 0;
  fn.calledWith = (...expected: unknown[]) =>
    calls.some(c => c.length === expected.length && c.every((v, i) => v === expected[i]));
  return fn;
}

interface PrepareCallArgs {
  startFn?: Function | number | null;
  returnFn?: Function | number | null;
  callerIdx?: number;
  calleeIdx?: number;
  taskReturnTypeIdx?: number;
  isCalleeAsync?: number;
  stringEncoding?: number;
  resultCountOrAsync?: number;
  resultPtr?: number;
}

function prepare(ctx: CallContext, args: PrepareCallArgs = {}): void {
  const positional: unknown[] = [
    args.startFn ?? null,
    args.returnFn ?? null,
    args.callerIdx ?? 0,
    args.calleeIdx ?? 1,
    args.taskReturnTypeIdx ?? 0,
    args.isCalleeAsync ?? 0,
    args.stringEncoding ?? 0,
    args.resultCountOrAsync ?? 0,
  ];
  if (args.resultPtr !== undefined) positional.push(args.resultPtr);
  ctx.prepareCall(...positional);
}

describe('CallContext', () => {
  describe('prepareCall', () => {
    it('stores pending call metadata', () => {
      const eventLoop = new EventLoop();
      const ctx = new CallContext(eventLoop);
      const startFn = () => {};
      const returnFn = () => {};
      prepare(ctx, { startFn, returnFn, isCalleeAsync: 1, resultCountOrAsync: 1 });
      const states = [new ComponentState(0), new ComponentState(1)];
      const callee = () => { states[1]!.currentTask!.resolve(undefined); return 0; };
      const result = ctx.asyncStartCall(states, null, callee, 0, 0, 0);
      assert.strictEqual(typeof result, 'number');
    });

    it('stores null startFn/returnFn when 0/null passed', () => {
      const eventLoop = new EventLoop();
      const ctx = new CallContext(eventLoop);
      prepare(ctx, { startFn: 0, returnFn: 0, isCalleeAsync: 1 });
      const states = [new ComponentState(0), new ComponentState(1)];
      const callee = () => { states[1]!.currentTask!.resolve(undefined); return 0; };
      const result = ctx.asyncStartCall(states, null, callee, 0, 0, 0);
      assert.strictEqual(typeof result, 'number');
    });

    it('captures resultPtr when resultCountOrAsync < 0', () => {
      const eventLoop = new EventLoop();
      const ctx = new CallContext(eventLoop);
      prepare(ctx, { resultCountOrAsync: -1, resultPtr: 42, isCalleeAsync: 1 });
      const states = [new ComponentState(0), new ComponentState(1)];
      const callee = () => { states[1]!.currentTask!.resolve(undefined); return 0; };
      const result = ctx.asyncStartCall(states, null, callee, 0, 0, 0);
      assert.strictEqual(typeof result, 'number');
    });
  });

  describe('asyncStartCall', () => {
    it('handles EXIT with early return (instant completion)', () => {
      const eventLoop = new EventLoop();
      const ctx = new CallContext(eventLoop);
      const startFn = mockFn();
      const returnFn = mockFn();
      prepare(ctx, { startFn, returnFn, isCalleeAsync: 1, resultCountOrAsync: 1 });

      const states = [new ComponentState(0), new ComponentState(1)];
      const callee = () => {
        states[1]!.currentTask!.resolve(42);
        return 0; // EXIT
      };

      const result = ctx.asyncStartCall(states, null, callee, 0, 1, 0);

      assert.ok(startFn.called());
      assert.ok(returnFn.calledWith(42));
      assert.strictEqual(result, SubtaskState.RETURNED);
    });

    it('handles YIELD/WAIT (async completion, no early return)', async () => {
      const eventLoop = new EventLoop();
      const ctx = new CallContext(eventLoop);
      const startFn = mockFn();
      const returnFn = mockFn();
      prepare(ctx, { startFn, returnFn, isCalleeAsync: 1, resultCountOrAsync: 1 });

      const states = [new ComponentState(0), new ComponentState(1)];

      let callbackCalls = 0;
      const callbackFn = (_code: number, _p1: number, _p2: number): number => {
        callbackCalls++;
        states[1]!.currentTask!.resolve(99);
        return CallbackCode.EXIT;
      };

      const callee = () => 1; // YIELD

      const result = ctx.asyncStartCall(states, callbackFn, callee, 0, 1, 0);

      assert.ok(startFn.called());
      const handle = result >> 4;
      assert.ok(handle > 0);

      await new Promise(resolve => setTimeout(resolve, 50));

      assert.strictEqual(callbackCalls, 1);
      assert.ok(returnFn.calledWith(99));
    });

    it('returns RETURNED without handle when callee resolves eagerly', () => {
      const eventLoop = new EventLoop();
      const ctx = new CallContext(eventLoop);
      prepare(ctx, { isCalleeAsync: 1, resultCountOrAsync: 1 });

      const states = [new ComponentState(0), new ComponentState(1)];
      const callee = () => {
        states[1]!.currentTask!.resolve(undefined);
        return 0;
      };

      const result = ctx.asyncStartCall(states, null, callee, 0, 0, 0);
      assert.strictEqual(result, SubtaskState.RETURNED);
    });

    it('creates subtask handle when callee does not resolve eagerly', async () => {
      const eventLoop = new EventLoop();
      const ctx = new CallContext(eventLoop);
      prepare(ctx, { isCalleeAsync: 1, resultCountOrAsync: 1 });

      const states = [new ComponentState(0), new ComponentState(1)];

      const callbackFn = (_code: number, _p1: number, _p2: number): number => {
        states[1]!.currentTask!.resolve(42);
        return CallbackCode.EXIT;
      };

      const callee = () => 1; // YIELD

      const result = ctx.asyncStartCall(states, callbackFn, callee, 0, 0, 0);
      const handle = result >> 4;
      assert.ok(handle > 0);

      await new Promise(resolve => setTimeout(resolve, 50));
    });
  });

  describe('syncStartCall', () => {
    it('handles EXIT (instant completion)', () => {
      const eventLoop = new EventLoop();
      const ctx = new CallContext(eventLoop);
      const returnFn = mockFn((_result: unknown) => 7);
      prepare(ctx, { returnFn, isCalleeAsync: 1, resultCountOrAsync: 1 });

      const states = [new ComponentState(0), new ComponentState(1)];
      const callerTask = new AsyncTask();
      callerTask.mayBlock = true;
      states[0]!.currentTask = callerTask;
      const callee = () => {
        states[1]!.currentTask!.resolve(42);
        return 0;
      };

      const result = ctx.syncStartCall(states, null, callee, 0);
      assert.ok(returnFn.calledWith(42));
      assert.strictEqual(result, 7);
    });

    it('treats non-callback callee return as plain value', () => {
      const eventLoop = new EventLoop();
      const ctx = new CallContext(eventLoop);
      const returnFn = mockFn((_result: unknown) => 99);
      prepare(ctx, { returnFn, resultCountOrAsync: 1 });

      const states = [new ComponentState(0), new ComponentState(1)];
      const callee = () => 1;

      const result = ctx.syncStartCall(states, null, callee, 0);
      assert.ok(returnFn.calledWith(1));
      assert.strictEqual(result, 99);
    });

    it('returns 0 when no returnFn', () => {
      const eventLoop = new EventLoop();
      const ctx = new CallContext(eventLoop);
      prepare(ctx);

      const states = [new ComponentState(0), new ComponentState(1)];
      const callee = () => 0;

      const result = ctx.syncStartCall(states, null, callee, 0);
      assert.strictEqual(typeof result, 'number');
    });

    it('traps when sync caller without task calls async callee without callback', () => {
      const eventLoop = new EventLoop();
      const ctx = new CallContext(eventLoop);
      prepare(ctx, { isCalleeAsync: 1 });

      const states = [new ComponentState(0), new ComponentState(1)];
      assert.strictEqual(states[0]!.currentTask, null);

      const callee = () => 0;

      assert.throws(() => ctx.syncStartCall(states, null, callee, 0),
        { message: /cannot block a synchronous task before returning/ });
    });

    it('allows sync call to async callee when caller has a current task', () => {
      const eventLoop = new EventLoop();
      const ctx = new CallContext(eventLoop);
      prepare(ctx, { isCalleeAsync: 1 });

      const states = [new ComponentState(0), new ComponentState(1)];
      const callerTask = new AsyncTask();
      callerTask.mayBlock = true;
      states[0]!.currentTask = callerTask;

      const callee = () => {
        states[1]!.currentTask!.resolve(42);
        return 0;
      };

      const result = ctx.syncStartCall(states, null, callee, 0);
      assert.strictEqual(typeof result, 'number');
    });
  });
});
