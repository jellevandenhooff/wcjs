import type { EventTuple } from './types.ts';
import type { WaitableSet } from './waitable-set.ts';

// A Waitable is something that can deliver events to a WaitableSet.
// Subtasks, stream ends, and future ends are all Waitables.
//
// Per the spec, pending_event is a callable (closure) that generates
// the EventTuple when called. This allows capturing local state at
// the time the event becomes available.
export class Waitable {
  private pendingEvent: (() => EventTuple) | null = null;
  private _wset: WaitableSet | null = null;
  private _pendingEventResolve: (() => void) | null = null;

  hasPendingEvent(): boolean {
    return this.pendingEvent !== null;
  }

  // Consume and return the pending event. Calls the closure to generate
  // the actual EventTuple. Returns null if no event is pending.
  getPendingEvent(): EventTuple | null {
    const fn = this.pendingEvent;
    if (!fn) return null;
    this.pendingEvent = null;
    return fn();
  }

  // Set a pending event closure. When a WaitableSet checks for events,
  // this closure will be called to produce the EventTuple.
  // Also notifies the joined WaitableSet that an event is available,
  // and resolves any waitForPendingEvent() Promise.
  setPendingEvent(eventFn: () => EventTuple): void {
    this.pendingEvent = eventFn;
    if (this._pendingEventResolve) {
      const resolve = this._pendingEventResolve;
      this._pendingEventResolve = null;
      resolve();
    }
    if (this._wset) {
      this._wset.notify();
    }
  }

  // Wait for a pending event to arrive. Used by sync stream operations
  // that need to block (via JSPI) until the rendezvous completes.
  waitForPendingEvent(): Promise<void> {
    if (this.hasPendingEvent()) return Promise.resolve();
    return new Promise((resolve) => {
      this._pendingEventResolve = resolve;
    });
  }

  // Join this waitable to a WaitableSet (or leave current set if null).
  // Automatically removes from old set first.
  join(wset: WaitableSet | null): void {
    if (this._wset) {
      this._wset.removeWaitable(this);
    }
    this._wset = wset;
    if (wset) {
      wset.addWaitable(this);
    }
  }

  // Get the current WaitableSet this waitable belongs to.
  get waitableSet(): WaitableSet | null {
    return this._wset;
  }

  // Drop this waitable. Per spec: trap if pending event exists.
  drop(): void {
    if (this.pendingEvent) {
      throw new Error('cannot drop waitable with pending event');
    }
    this.join(null);
  }
}
