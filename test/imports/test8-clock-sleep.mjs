// Host imports for test8-clock-sleep
// Provides monotonic clock now and async wait-for
export default {
  'monotonic-now': () => process.hrtime.bigint(),
  'wait-for': (durationNs) => {
    if (durationNs <= 0n) return; // instant completion
    const target = process.hrtime.bigint() + durationNs;
    const ms = Number(durationNs / 1_000_000n);
    return new Promise(resolve => {
      const check = () => {
        if (process.hrtime.bigint() >= target) resolve();
        else setTimeout(check, 0);
      };
      setTimeout(check, Math.max(ms, 1));
    });
  },
};
