// Host imports for test7-clock-now
// Provides monotonic clock functions
export default {
  'monotonic-now': () => process.hrtime.bigint(),
  'monotonic-resolution': () => 1n, // 1 nanosecond resolution
};
