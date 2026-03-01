import { instantiate } from '../generated/calculator.js';
import { createBrowserWasiHost } from '../../src/wasi/wasi-browser.ts';

const logEl = document.getElementById('log')!;

function log(msg: string) {
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

async function run() {
  log('instantiating component...');

  const wasiHost = createBrowserWasiHost();

  const instance = await instantiate({
    ...wasiHost,
    'demo:calculator/host': {
      'slow-double': async (n: number) => {
        log(`  host: slow-double(${n}) called, returning a promise...`);
        await new Promise(r => setTimeout(r, 1000));
        const result = n * 2;
        log(`  host: slow-double(${n}) promise resolved → ${result}`);
        return result;
      },
      log: (msg: string) => {
        log(`  guest: ${msg}`);
      },
    },
  });

  const calc = instance['demo:calculator/calc'];

  // Sync export
  log('\nadd(3, 4)');
  const sum = await calc.add(3, 4);
  log(`  => ${sum}`);

  // Async export — guest calls slow-double concurrently via futures::join!
  // Both promises fire simultaneously, resolving in ~1s instead of ~2s
  log('\ndouble-and-add(5, 7)');
  const daa = await calc.doubleAndAdd(5, 7);
  log(`  => ${daa}`);

  log('\ndone.');
}

run().catch(e => {
  log(`\nError: ${e}`);
  console.error(e);
});
