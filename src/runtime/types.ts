// Event codes delivered via WaitableSet (from component model spec)
export const EventCode = {
  NONE: 0,
  SUBTASK: 1,
  STREAM_READ: 2,
  STREAM_WRITE: 3,
  FUTURE_READ: 4,
  FUTURE_WRITE: 5,
  TASK_CANCELLED: 6,
} as const;
export type EventCode = (typeof EventCode)[keyof typeof EventCode];

// Callback return codes from wasm (packed in lower 4 bits of i32)
export const CallbackCode = {
  EXIT: 0,
  YIELD: 1,
  WAIT: 2,
} as const;
export type CallbackCode = (typeof CallbackCode)[keyof typeof CallbackCode];

// Subtask states per the spec
export const SubtaskState = {
  STARTING: 0,
  STARTED: 1,
  RETURNED: 2,
  CANCELLED_BEFORE_STARTED: 3,
  CANCELLED_BEFORE_RETURNED: 4,
} as const;
export type SubtaskState = (typeof SubtaskState)[keyof typeof SubtaskState];

// Copy results for stream/future operations
export const CopyResult = {
  COMPLETED: 0,
  DROPPED: 1,
  CANCELLED: 2,
} as const;
export type CopyResult = (typeof CopyResult)[keyof typeof CopyResult];

// CopyState for stream/future ends (per spec)
export const CopyState = {
  IDLE: 1,
  SYNC_COPYING: 2,
  ASYNC_COPYING: 3,
  CANCELLING_COPY: 4,
  DONE: 5,
} as const;
export type CopyState = (typeof CopyState)[keyof typeof CopyState];

// Sentinel value: async canonical operation would block
export const BLOCKED = 0xffff_ffff;

// Instance flag bits (per component model spec, shared between adapter.ts and component-state.ts)
export const MAY_ENTER = 1;
export const MAY_LEAVE = 2;

// Buffer interface for stream/future data transfer.
// The generated code creates these wrapping wasm linear memory.
export interface StreamBuffer {
  remain(): number;
  isZeroLength(): boolean;
  progress: number;
}

// Readable buffer: can read N items from it
export interface ReadableStreamBuffer extends StreamBuffer {
  read(n: number): unknown[];
}

// Writable buffer: can write items into it
export interface WritableStreamBuffer extends StreamBuffer {
  write(items: unknown[]): void;
}

// Event tuple delivered by waitable set
export interface EventTuple {
  code: EventCode;
  index: number; // waitable index in the set
  payload: number; // event-specific data
}

// Unpack a callback result i32: lower 4 bits = code, upper bits = waitable set index
export function unpackCallbackResult(
  packed: number,
): [CallbackCode, number] {
  const code = (packed & 0xf) as CallbackCode;
  const waitableSetIndex = packed >>> 4;
  return [code, waitableSetIndex];
}
