import { describe, it, assert } from '../runner.ts';
import { HandleTable } from '../../src/runtime/handle-table.ts';

describe('HandleTable', () => {
  it('inserts and retrieves items', () => {
    const table = new HandleTable<string>();
    const rep = table.insert('hello');
    assert.ok(rep > 0);
    assert.strictEqual(table.get(rep), 'hello');
  });

  it('returns undefined for invalid handles', () => {
    const table = new HandleTable<string>();
    assert.strictEqual(table.get(0), undefined);
    assert.strictEqual(table.get(1), undefined);
    assert.strictEqual(table.get(-1), undefined);
    assert.strictEqual(table.get(999), undefined);
  });

  it('removes items and reuses slots', () => {
    const table = new HandleTable<string>();
    const rep1 = table.insert('a');
    const rep2 = table.insert('b');
    assert.strictEqual(table.size, 2);

    const removed = table.remove(rep1);
    assert.strictEqual(removed, 'a');
    assert.strictEqual(table.get(rep1), undefined);
    assert.strictEqual(table.has(rep1), false);
    assert.strictEqual(table.size, 1);

    const rep3 = table.insert('c');
    assert.strictEqual(rep3, rep1);
    assert.strictEqual(table.get(rep3), 'c');
  });

  it('has() works correctly', () => {
    const table = new HandleTable<number>();
    const rep = table.insert(42);
    assert.strictEqual(table.has(rep), true);
    assert.strictEqual(table.has(0), false);
    assert.strictEqual(table.has(999), false);
    table.remove(rep);
    assert.strictEqual(table.has(rep), false);
  });

  it('handles multiple inserts and removals', () => {
    const table = new HandleTable<number>();
    const reps: number[] = [];
    for (let i = 0; i < 10; i++) {
      reps.push(table.insert(i));
    }
    assert.strictEqual(table.size, 10);

    for (let i = 0; i < 10; i += 2) {
      table.remove(reps[i]!);
    }
    assert.strictEqual(table.size, 5);

    for (let i = 1; i < 10; i += 2) {
      assert.strictEqual(table.get(reps[i]!), i);
    }
  });

  it('remove returns undefined for already-removed items', () => {
    const table = new HandleTable<string>();
    const rep = table.insert('x');
    table.remove(rep);
    assert.strictEqual(table.remove(rep), undefined);
  });
});
