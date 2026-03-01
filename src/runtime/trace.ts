// Runtime call tracing for debugging.
// Enable with: import { trace } from '@jellevdh/wcjs/runtime'; trace.enabled = true;

export const trace = {
  enabled: false,

  log(componentIdx: number, op: string, ...args: unknown[]): void {
    if (!this.enabled) return;
    const argsStr = args.map(a => {
      if (typeof a === 'bigint') return `${a}n`;
      if (typeof a === 'function') return '<fn>';
      if (a instanceof WebAssembly.Memory) return '<memory>';
      return JSON.stringify(a);
    }).join(', ');
    console.log(`[c${componentIdx}] ${op}(${argsStr})`);
  },

  logResult(componentIdx: number, op: string, result: unknown): void {
    if (!this.enabled) return;
    const resStr = typeof result === 'bigint' ? `${result}n` : JSON.stringify(result);
    console.log(`[c${componentIdx}] ${op} → ${resStr}`);
  },
};
