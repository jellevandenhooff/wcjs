// Host imports for test4-deferred-import
// slow-compute returns a Promise that resolves after a short delay
export default {
  'slow-compute': () => new Promise(resolve => setTimeout(() => resolve(42), 10)),
};
