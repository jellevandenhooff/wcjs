import { describe, it, assert } from '../runner.ts';

// Test the microtask draining optimization in the event loop.
// The optimization tries up to 5 rounds of Promise.resolve() before
// falling back to a macrotask boundary (MessageChannel/setTimeout).

describe('event loop microtask optimization', () => {
  it('single microtask settles in one round', async () => {
    let settled = false;
    Promise.resolve().then(() => { settled = true; });

    // One await drains the microtask queue
    await Promise.resolve();
    assert(settled, 'expected single microtask to settle in one round');
  });

  it('microtask draining avoids macrotask for shallow chains', async () => {
    // The event loop optimization: try microtask rounds before macrotask.
    // This test verifies that a series of already-resolved promises
    // can be drained without a macrotask boundary.
    let macrotaskUsed = false;
    let settled = false;

    // Queue work that settles via microtasks
    Promise.resolve().then(() => {
      Promise.resolve().then(() => { settled = true; });
    });

    // Simulate the event loop's drain loop (5 rounds max)
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      if (settled) break;
    }

    if (!settled) {
      // Fall back to macrotask (as the event loop would)
      macrotaskUsed = true;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }

    assert(settled, 'microtask chain should have settled');
    assert(!macrotaskUsed, 'should not need macrotask for shallow chain');
  });

  it('macrotask boundary drains all microtasks', async () => {
    let settled = false;

    // Even a deep chain settles after a macrotask boundary
    let p = Promise.resolve();
    for (let i = 0; i < 20; i++) {
      p = p.then(() => Promise.resolve());
    }
    p.then(() => { settled = true; });

    // Use MessageChannel macrotask boundary (same as event loop)
    await new Promise<void>(resolve => {
      if (typeof MessageChannel !== 'undefined') {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => resolve();
        ch.port2.postMessage(null);
      } else {
        setTimeout(resolve, 0);
      }
    });

    assert(settled, 'expected all microtasks to settle after macrotask boundary');
  });
});
