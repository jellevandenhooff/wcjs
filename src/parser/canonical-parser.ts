/**
 * Parser for canonical section (section ID 0x08).
 * Reads canon lift, lower, and builtin opcodes.
 */
import { BinaryReader } from './binary-reader.ts';
import type { CanonicalFunc, CanonOpt, ComponentValType } from './types.ts';
import { readComponentValType } from './type-parser.ts';

/** Read canonical options list. */
export function readCanonOpts(r: BinaryReader): CanonOpt[] {
  const opts: CanonOpt[] = [];
  const count = r.readU32LEB();
  for (let i = 0; i < count; i++) {
    const tag = r.readU8();
    switch (tag) {
      case 0x00: opts.push({ tag: 'utf8' }); break;
      case 0x01: opts.push({ tag: 'utf16' }); break;
      case 0x02: opts.push({ tag: 'compactUtf16' }); break;
      case 0x03: opts.push({ tag: 'memory', index: r.readU32LEB() }); break;
      case 0x04: opts.push({ tag: 'realloc', index: r.readU32LEB() }); break;
      case 0x05: opts.push({ tag: 'postReturn', index: r.readU32LEB() }); break;
      case 0x06: opts.push({ tag: 'async' }); break;
      case 0x07: opts.push({ tag: 'callback', index: r.readU32LEB() }); break;
      default: throw new Error(`unknown canon option 0x${tag.toString(16)}`);
    }
  }
  return opts;
}

/** Read result list (option encoding used by task.return and func types). */
function readResultList(r: BinaryReader): ComponentValType | null {
  const tag = r.readU8();
  switch (tag) {
    case 0x00: return readComponentValType(r);
    case 0x01: {
      const zero = r.readU8();
      if (zero !== 0x00) throw new Error(`expected 0x00 after result list 0x01, got 0x${zero.toString(16)}`);
      return null;
    }
    default: throw new Error(`unexpected result list tag 0x${tag.toString(16)}`);
  }
}

/** Read a canonical function section. */
export function readCanonicalSection(r: BinaryReader): CanonicalFunc[] {
  const funcs: CanonicalFunc[] = [];
  const count = r.readU32LEB();
  for (let i = 0; i < count; i++) {
    funcs.push(readCanonicalFunc(r));
  }
  return funcs;
}

function readCanonicalFunc(r: BinaryReader): CanonicalFunc {
  const opcode = r.readU8();

  switch (opcode) {
    case 0x00: {
      // Lift: sub-opcode 0x00
      const sub = r.readU8();
      if (sub !== 0x00) throw new Error(`unexpected lift sub-opcode 0x${sub.toString(16)}`);
      const coreFuncIndex = r.readU32LEB();
      const options = readCanonOpts(r);
      const typeIndex = r.readU32LEB();
      return { tag: 'lift', coreFuncIndex, options, typeIndex };
    }
    case 0x01: {
      // Lower: sub-opcode 0x00
      const sub = r.readU8();
      if (sub !== 0x00) throw new Error(`unexpected lower sub-opcode 0x${sub.toString(16)}`);
      const funcIndex = r.readU32LEB();
      const options = readCanonOpts(r);
      return { tag: 'lower', funcIndex, options };
    }
    case 0x02: return { tag: 'resourceNew', typeIndex: r.readU32LEB() };
    case 0x03: return { tag: 'resourceDrop', typeIndex: r.readU32LEB() };
    case 0x04: return { tag: 'resourceRep', typeIndex: r.readU32LEB() };
    case 0x05: return { tag: 'taskCancel' };
    case 0x06: return { tag: 'subtaskCancel', async: r.readU8() !== 0 };
    case 0x07: return { tag: 'resourceDropAsync', typeIndex: r.readU32LEB() };
    case 0x09: {
      const result = readResultList(r);
      const options = readCanonOpts(r);
      return { tag: 'taskReturn', result, options };
    }
    case 0x0a: {
      // context.get: sub-opcode 0x7f (i32), then slot index
      const sub = r.readU8();
      if (sub !== 0x7f) throw new Error(`unexpected context.get sub-opcode 0x${sub.toString(16)}`);
      const index = r.readU32LEB();
      return { tag: 'contextGet', index };
    }
    case 0x0b: {
      // context.set: sub-opcode 0x7f (i32), then slot index
      const sub = r.readU8();
      if (sub !== 0x7f) throw new Error(`unexpected context.set sub-opcode 0x${sub.toString(16)}`);
      const index = r.readU32LEB();
      return { tag: 'contextSet', index };
    }
    case 0x0c: return { tag: 'threadYield', async: r.readU8() !== 0 };
    case 0x0d: return { tag: 'subtaskDrop' };
    case 0x0e: return { tag: 'streamNew', typeIndex: r.readU32LEB() };
    case 0x0f: {
      const typeIndex = r.readU32LEB();
      const options = readCanonOpts(r);
      return { tag: 'streamRead', typeIndex, options };
    }
    case 0x10: {
      const typeIndex = r.readU32LEB();
      const options = readCanonOpts(r);
      return { tag: 'streamWrite', typeIndex, options };
    }
    case 0x11: return { tag: 'streamCancelRead', typeIndex: r.readU32LEB(), async: r.readU8() !== 0 };
    case 0x12: return { tag: 'streamCancelWrite', typeIndex: r.readU32LEB(), async: r.readU8() !== 0 };
    case 0x13: return { tag: 'streamDropReadable', typeIndex: r.readU32LEB() };
    case 0x14: return { tag: 'streamDropWritable', typeIndex: r.readU32LEB() };
    case 0x15: return { tag: 'futureNew', typeIndex: r.readU32LEB() };
    case 0x16: {
      const typeIndex = r.readU32LEB();
      const options = readCanonOpts(r);
      return { tag: 'futureRead', typeIndex, options };
    }
    case 0x17: {
      const typeIndex = r.readU32LEB();
      const options = readCanonOpts(r);
      return { tag: 'futureWrite', typeIndex, options };
    }
    case 0x18: return { tag: 'futureCancelRead', typeIndex: r.readU32LEB(), async: r.readU8() !== 0 };
    case 0x19: return { tag: 'futureCancelWrite', typeIndex: r.readU32LEB(), async: r.readU8() !== 0 };
    case 0x1a: return { tag: 'futureDropReadable', typeIndex: r.readU32LEB() };
    case 0x1b: return { tag: 'futureDropWritable', typeIndex: r.readU32LEB() };
    case 0x1c: {
      const options = readCanonOpts(r);
      return { tag: 'errorContextNew', options };
    }
    case 0x1d: {
      const options = readCanonOpts(r);
      return { tag: 'errorContextDebugMessage', options };
    }
    case 0x1e: return { tag: 'errorContextDrop' };
    case 0x1f: return { tag: 'waitableSetNew' };
    case 0x20: {
      const async_ = r.readU8() !== 0;
      const memoryIndex = r.readU32LEB();
      return { tag: 'waitableSetWait', async: async_, memoryIndex };
    }
    case 0x21: {
      const async_ = r.readU8() !== 0;
      const memoryIndex = r.readU32LEB();
      return { tag: 'waitableSetPoll', async: async_, memoryIndex };
    }
    case 0x22: return { tag: 'waitableSetDrop' };
    case 0x23: return { tag: 'waitableJoin' };
    case 0x24: return { tag: 'backpressureInc' };
    case 0x25: return { tag: 'backpressureDec' };
    case 0x26: return { tag: 'threadIndex' };
    case 0x27: {
      const funcTypeIndex = r.readU32LEB();
      const tableIndex = r.readU32LEB();
      return { tag: 'threadNewIndirect', funcTypeIndex, tableIndex };
    }
    case 0x28: return { tag: 'threadSwitchTo', async: r.readU8() !== 0 };
    case 0x29: return { tag: 'threadSuspend', async: r.readU8() !== 0 };
    case 0x2a: return { tag: 'threadResumeLater' };
    case 0x2b: return { tag: 'threadYieldTo', async: r.readU8() !== 0 };
    case 0x2c: return { tag: 'threadSuspendTo', cancellable: r.readU8() !== 0 };
    case 0x40: return { tag: 'threadSpawnRef', funcTypeIndex: r.readU32LEB() };
    case 0x41: {
      const funcTypeIndex = r.readU32LEB();
      const tableIndex = r.readU32LEB();
      return { tag: 'threadSpawnIndirect', funcTypeIndex, tableIndex };
    }
    case 0x42: return { tag: 'threadAvailableParallelism' };
    default:
      throw new Error(`unknown canon opcode 0x${opcode.toString(16)}`);
  }
}
