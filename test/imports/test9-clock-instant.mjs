// Host imports for test9-clock-instant
// wait-for(0) should return synchronously (non-Promise)
export default {
  'monotonic-now': () => process.hrtime.bigint(),
  'wait-for': (durationNs) => {
    if (durationNs <= 0n) return; // instant completion (returns undefined, not Promise)
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
