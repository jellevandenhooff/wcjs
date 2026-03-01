// JSPI (JavaScript Promise Integration) helpers.
// Wraps blocking wasm imports/exports so they can suspend on Promise returns.
//
// Usage in generated code:
//   import { suspending, promising } from '@jellevdh/wcjs/runtime';
//   const waitImport = suspending((wsIdx, ptr) => state.waitableSetWait(mem, wsIdx, ptr));
//   const run = () => promising(instance.exports['run'] as Function)();
//
// Requires --experimental-wasm-jspi flag in Node.js 23/24, or Node.js 25+.
// Throws a clear error if JSPI is not available.

const _Suspending = (WebAssembly as any).Suspending as
  | (new (fn: Function) => Function)
  | undefined;
const _promising = (WebAssembly as any).promising as
  | ((fn: Function) => Function)
  | undefined;

function requireJSPI(): void {
  if (!_Suspending || !_promising) {
    throw new Error(
      'JSPI (WebAssembly.Suspending/promising) is required for blocking builtins like waitable-set.wait. ' +
      'Run with --experimental-wasm-jspi flag (Node.js 23/24) or use Node.js 25+.',
    );
  }
}

// Wrap a JS import function so wasm can suspend when it returns a Promise.
// JSPI makes the Promise transparent to wasm: the wasm side sees a plain return value.
// So the output type strips Promise from the return type.
export function suspending<A extends unknown[], R>(
  fn: (...args: A) => R | Promise<R>,
): (...args: A) => R {
  requireJSPI();
  return new _Suspending!(fn) as unknown as (...args: A) => R;
}

// A function that may have been wrapped by promising(), with _raw pointing
// to the original unwrapped function.
export type MaybePromised = Function & { _raw?: Function };

// Wrap a wasm export function so it returns a Promise when wasm suspends.
// Stashes the original unwrapped function as `._raw` for cases where we need
// to call it synchronously (e.g., inline cancel of a callback).
export function promising<T extends Function>(fn: T): T {
  requireJSPI();
  const wrapped = _promising!(fn) as unknown as T;
  (wrapped as MaybePromised)._raw = fn;
  return wrapped;
}

