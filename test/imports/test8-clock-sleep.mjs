// Host imports for test8-clock-sleep
// Provides monotonic clock now and async wait-for
export default {
  'monotonic-now': () => process.hrtime.bigint(),
  'wait-for': (durationNs) => {
    if (durationNs <= 0n) return; // instant completion
    const ms = Number(durationNs / 1_000_000n);
    return new Promise(resolve => setTimeout(resolve, Math.max(ms, 1)));
  },
};
