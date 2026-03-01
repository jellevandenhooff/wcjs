import { describe, it, assert } from '../runner.ts';
import {
  CallbackCode,
  EventCode,
  SubtaskState,
  BLOCKED,
  unpackCallbackResult,
} from '../../src/runtime/types.ts';

describe('types', () => {
  describe('unpackCallbackResult', () => {
    it('unpacks EXIT with no waitable set', () => {
      const [code, wsIndex] = unpackCallbackResult(0);
      assert.strictEqual(code, CallbackCode.EXIT);
      assert.strictEqual(wsIndex, 0);
    });

    it('unpacks YIELD', () => {
      const [code, wsIndex] = unpackCallbackResult(1);
      assert.strictEqual(code, CallbackCode.YIELD);
      assert.strictEqual(wsIndex, 0);
    });

    it('unpacks WAIT with waitable set index', () => {
      const [code, wsIndex] = unpackCallbackResult(50);
      assert.strictEqual(code, CallbackCode.WAIT);
      assert.strictEqual(wsIndex, 3);
    });

    it('unpacks large waitable set indices', () => {
      const [code, wsIndex] = unpackCallbackResult(4082);
      assert.strictEqual(code, CallbackCode.WAIT);
      assert.strictEqual(wsIndex, 255);
    });
  });

  describe('enum values', () => {
    it('EventCode values match spec', () => {
      assert.strictEqual(EventCode.NONE, 0);
      assert.strictEqual(EventCode.SUBTASK, 1);
      assert.strictEqual(EventCode.STREAM_READ, 2);
      assert.strictEqual(EventCode.STREAM_WRITE, 3);
      assert.strictEqual(EventCode.FUTURE_READ, 4);
      assert.strictEqual(EventCode.FUTURE_WRITE, 5);
    });

    it('SubtaskState values match spec', () => {
      assert.strictEqual(SubtaskState.STARTING, 0);
      assert.strictEqual(SubtaskState.STARTED, 1);
      assert.strictEqual(SubtaskState.RETURNED, 2);
    });

    it('BLOCKED sentinel', () => {
      assert.strictEqual(BLOCKED, 0xffff_ffff);
    });
  });
});
