// Node.js demo: run the calculator component locally.
//
// Usage:
//   node --experimental-transform-types demo/node-demo.ts

import { instantiate } from './generated/calculator.js';
import { createWasiHost } from '../src/wasi/wasi-host.ts';

const wasiHost = createWasiHost({ stdout: [], stderr: [] });

console.log('instantiating component...');

const instance = await instantiate({
  ...wasiHost,
  'demo:calculator/host': {
    'slow-double': async (n: number) => {
      console.log(`  host: slow-double(${n}) called, returning a promise...`);
      await new Promise(r => setTimeout(r, 1000));
      const result = n * 2;
      console.log(`  host: slow-double(${n}) promise resolved → ${result}`);
      return result;
    },
    log: (msg: string) => {
      console.log(`  guest: ${msg}`);
    },
  },
});

const calc = instance['demo:calculator/calc'];

// Sync export
console.log('\nadd(3, 4)');
const sum = await calc.add(3, 4);
console.log(`  => ${sum}`);

// Async export — guest calls slow-double concurrently via futures::join!
// Both promises fire simultaneously, resolving in ~1s instead of ~2s
console.log('\ndouble-and-add(5, 7)');
const daa = await calc.doubleAndAdd(5, 7);
console.log(`  => ${daa}`);

console.log('\ndone.');
instance.$destroy();
process.exit(0);
