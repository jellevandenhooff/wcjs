// Generic sparse array for managing handles (reps).
// Index 0 is reserved/invalid. All valid handles are >= 1.
// This matches the canonical ABI spec where Table starts with [None]
// and handle 0 is used as a sentinel (e.g., "no waitable set" in waitable.join).

export class HandleTable<T> {
  private items: (T | undefined)[] = [undefined]; // index 0 is invalid
  private freeList: number[] = [];
  private _count = 0;

  // Insert an item and return its handle (rep)
  insert(item: T): number {
    this._count++;
    const idx = this.freeList.pop();
    if (idx !== undefined) {
      this.items[idx] = item;
      return idx;
    }
    const newIdx = this.items.length;
    this.items.push(item);
    return newIdx;
  }

  // Get an item by handle, or undefined if not present
  get(rep: number): T | undefined {
    if (rep <= 0 || rep >= this.items.length) return undefined;
    return this.items[rep];
  }

  // Remove an item by handle and return it
  remove(rep: number): T | undefined {
    if (rep <= 0 || rep >= this.items.length) return undefined;
    const item = this.items[rep];
    if (item === undefined) return undefined;
    this.items[rep] = undefined;
    this.freeList.push(rep);
    this._count--;
    return item;
  }

  // Check if a handle is valid
  has(rep: number): boolean {
    return rep > 0 && rep < this.items.length && this.items[rep] !== undefined;
  }

  // Number of active items
  get size(): number {
    return this._count;
  }

  // Iterate all active items
  *values(): IterableIterator<T> {
    for (let i = 1; i < this.items.length; i++) {
      const item = this.items[i];
      if (item !== undefined) yield item;
    }
  }
}
