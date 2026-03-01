import type { EventTuple } from './types.ts';
import { EventCode } from './types.ts';
import type { Waitable } from './waitable.ts';

// A WaitableSet collects Waitables and allows waiting for events from any of them.
// This implements the spec's WaitableSet with:
//   - poll(): synchronous, returns NONE if no events pending
//   - wait(): async, blocks until an event is available
//
// Per the spec, get_pending_event shuffles the list for fairness.
export class WaitableSet {
  private elems: Waitable[] = [];
  private numWaiting = 0;
  private waiter: (() => void) | null = null;
  private _rejecter: ((err: Error) => void) | null = null;

  // Callback to notify the owning event loop when events arrive.
  // Set by ComponentState.waitableSetNew().
  notifyFn: (() => void) | null = null;

  // Add a waitable to this set. Called by Waitable.join().
  addWaitable(w: Waitable): void {
    this.elems.push(w);
    // If the waitable already has a pending event, notify the event loop
    // so waiting tasks can be woken up.
    if (w.hasPendingEvent()) {
      this.notify();
    }
  }

  // Remove a waitable from this set. Called by Waitable.join().
  removeWaitable(w: Waitable): void {
    const idx = this.elems.indexOf(w);
    if (idx >= 0) {
      this.elems.splice(idx, 1);
    }
  }

  // Check if any waitable has a pending event.
  hasPendingEvent(): boolean {
    return this.elems.some((w) => w.hasPendingEvent());
  }

  // Get a pending event from any waitable in the set.
  // Per spec: shuffles the list for fairness, then returns first found.
  // Returns null if no events are pending.
  private consumePendingEvent(): EventTuple | null {
    // Fisher-Yates shuffle for fairness (per spec)
    const arr = this.elems;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    for (const w of arr) {
      if (w.hasPendingEvent()) {
        return w.getPendingEvent();
      }
    }
    return null;
  }

  // Synchronous poll: returns pending event or NONE.
  poll(): EventTuple {
    const event = this.consumePendingEvent();
    if (event) return event;
    return { code: EventCode.NONE, index: 0, payload: 0 };
  }

  // Async wait: blocks until an event is available.
  // Returns a Promise that resolves with the next event.
  // The promise is rejected if abort() is called (e.g., component destroyed).
  //
  // Per spec: the event closure is NOT evaluated until the waiter resumes.
  // This is critical for partial stream copies: multiple rendezvous can
  // overwrite the pending event before it's consumed, accumulating progress.
  async wait(): Promise<EventTuple> {
    // Check synchronously first
    const immediate = this.consumePendingEvent();
    if (immediate) return immediate;

    // Block until notified. notify() just wakes us up; we consume the event
    // here after resuming, ensuring the lazy event closure sees final state.
    this.numWaiting++;
    try {
      await new Promise<void>((resolve, reject) => {
        this.waiter = resolve;
        this._rejecter = reject;
      });
      // Now consume the event (closure evaluated here, with latest progress)
      const event = this.consumePendingEvent();
      if (!event) {
        throw new Error('woke from wait but no pending event');
      }
      return event;
    } finally {
      this.numWaiting--;
      this._rejecter = null;
    }
  }

  // Called by Waitable.setPendingEvent() when an event becomes available.
  // Just wakes up a waiting thread (if any). Does NOT consume the event —
  // the waiter consumes it after resuming. This is critical because the
  // event closure may be overwritten by subsequent rendezvous before the
  // waiter runs (e.g., partial stream copies).
  notify(): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve();
    }
    this.notifyFn?.();
  }

  // Number of waitables in this set.
  get size(): number {
    return this.elems.length;
  }

  // Abort any pending wait(). Rejects the waiting promise so event loops
  // can terminate. Called by ComponentState.destroy() or EventLoop deadlock.
  abort(error?: Error): void {
    if (this._rejecter) {
      const reject = this._rejecter;
      this._rejecter = null;
      this.waiter = null;
      reject(error ?? new Error('component destroyed'));
    }
  }

  // Track callback-mode tasks waiting on this set via the event loop.
  // Called by EventLoop when adding/removing tasks from the waiting map.
  addCallbackWaiter(): void {
    this.numWaiting++;
  }

  removeCallbackWaiter(): void {
    this.numWaiting--;
  }

  // Drop this set. Per spec: trap if not empty or threads are waiting.
  drop(): void {
    if (this.elems.length > 0) {
      throw new Error('cannot drop waitable set with waiters');
    }
    if (this.numWaiting > 0) {
      throw new Error('cannot drop waitable set with waiters');
    }
  }
}
