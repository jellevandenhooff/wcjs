/**
 * Phase 2: Walk LinkedComponent → emit TypeScript source.
 *
 * Produces thin TypeScript that imports from @jellevdh/wcjs/runtime.
 * The output matches the format in test-wasip3/out/ *.ts files.
 */

import type { LinkedComponent, ImportBinding, Trampoline, StartFn, ReturnFn, LinkedTrampoline, ExportLiftInfo } from './link-types.ts';
import type { HostValType, HostImportLowerInfo } from './host-types.ts';
import { flattenHostValType, hostValTypeAlignment, hostValTypeByteSize, hostValTypeToTS } from './host-types.ts';

export interface EmitResult {
  source: string;
  declarations?: string;
  coreModules: Array<{ fileName: string; bytes: Uint8Array }>;
}

export type EmitMode = 'ts' | 'js' | 'standalone';

export function emit(linked: LinkedComponent, name: string, jspiMode = false, mode: EmitMode = 'ts'): EmitResult {
  const ctx = new EmitContext(linked, name, jspiMode, mode);
  ctx.emit();
  const result: EmitResult = {
    source: ctx.output(),
    coreModules: ctx.buildCoreModules(),
  };
  if (mode === 'standalone') {
    result.declarations = ctx.emitDeclarations();
  }
  return result;
}

// -----------------------------------------------------------------------
// Emit context
// -----------------------------------------------------------------------

class EmitContext {
  private lines: string[] = [];
  private indent = '';
  private linked: LinkedComponent;
  private name: string;

  // Pre-scanned counts
  private trampolineCount = 0;
  private moduleCount = 0;
  private instanceCount = 0;
  private memoryCount = 0;
  private callbackCount = 0;
  private hasCallbacks = false;
  private jspiEnabled = false;
  private nextTmpVar = 0;
  private currentStateIdx = 0;
  /** Map from versioned import name → local variable name for typed host interfaces. */
  private hostIfaceVarNames = new Map<string, string>();

  // Host import info (collected in preScan, used by emitImportsType + emitTypedHostInterfaces)
  private ifaceMethods = new Map<string, { exportName: string; lowerInfo: HostImportLowerInfo; isAsync: boolean; isFutureResult: boolean }[]>();
  private ifaceDrops = new Map<string, string[]>();
  private ifacePassthrough = new Set<string>();
  private bareFuncImports = new Map<string, { paramCount: number; isAsync: boolean }>();
  private needsStream = false;
  private needsFuture = false;
  /** True if all host imports are wasi:* prefixed (enables WasiHost type assertion). */
  private isAllWasi = false;
  /** When true, emit plain JS (no type annotations, casts, or imports). */
  private jsMode = false;
  /** When true, emit standalone JS module with import statements. */
  private standaloneMode = false;

  constructor(linked: LinkedComponent, name: string, jspiMode: boolean, mode: EmitMode = 'ts') {
    this.linked = linked;
    this.name = name;
    this.jspiEnabled = jspiMode;
    this.jsMode = mode === 'js' || mode === 'standalone';
    this.standaloneMode = mode === 'standalone';
    this.preScan();
  }

  /** Return text only in TS mode (type annotations, casts). Empty string in JS mode. */
  private ts(text: string): string {
    return this.jsMode ? '' : text;
  }

  output(): string {
    return this.lines.join('\n') + '\n';
  }

  buildCoreModules(): Array<{ fileName: string; bytes: Uint8Array }> {
    return this.linked.modules.map(m => {
      const suffix = m.moduleIdx === 0 ? '' : `${m.moduleIdx + 1}`;
      return { fileName: `${this.name}.core${suffix}.wasm`, bytes: m.bytes };
    });
  }

  // -------------------------------------------------------------------
  // Pre-scan: count everything for declarations
  // -------------------------------------------------------------------

  private preScan(): void {
    for (const t of this.linked.trampolines) {
      this.trampolineCount = Math.max(this.trampolineCount, t.trampolineIdx + 1);
      this.validateJspi(t.trampoline);
    }
    for (const m of this.linked.modules) {
      this.moduleCount = Math.max(this.moduleCount, m.moduleIdx + 1);
    }
    for (const inst of this.linked.instances) {
      this.instanceCount = Math.max(this.instanceCount, inst.runtimeIdx + 1);
    }
    for (const mem of this.linked.memories) {
      this.memoryCount = Math.max(this.memoryCount, mem.memoryIdx + 1);
    }
    for (const cb of this.linked.callbacks) {
      this.callbackCount = Math.max(this.callbackCount, cb.callbackIdx + 1);
      this.hasCallbacks = true;
    }
    this.collectHostImportInfo();
  }

  /** Collect host import info for Imports type and typed host interfaces. */
  private collectHostImportInfo(): void {
    for (const rt of this.linked.trampolines) {
      const t = rt.trampoline;
      if (t.tag === 'lowerHostImport' && t.lowerInfo) {
        if (!this.ifaceMethods.has(t.importName)) this.ifaceMethods.set(t.importName, []);
        const stripAsync = (n: string) =>
          n.startsWith('[async]') ? n.slice(7) :
          n.startsWith('[async ') ? '[' + n.slice(7) : n;
        const addAsync = (n: string) =>
          n.startsWith('[') ? '[async ' + n.slice(1) : '[async]' + n;
        // Name selection must match emitLowerHostImportTrampoline:
        // future-returning functions → [async] name; otherwise → sync name.
        const isFutureResult = !!(t.lowerInfo.resultType &&
          typeof t.lowerInfo.resultType === 'object' && t.lowerInfo.resultType.tag === 'future');
        const funcName = isFutureResult
          ? addAsync(stripAsync(t.exportName))
          : stripAsync(t.exportName);
        const existing = this.ifaceMethods.get(t.importName)!;
        if (!existing.some(m => m.exportName === funcName)) {
          existing.push({ exportName: funcName, lowerInfo: t.lowerInfo, isAsync: t.isAsync, isFutureResult });
        }
      } else if (t.tag === 'lowerHostImport' && !t.lowerInfo) {
        if (!this.ifaceMethods.has(t.importName)) this.ifacePassthrough.add(t.importName);
      } else if (t.tag === 'resourceDrop' && t.hostDropIface && t.hostDropName) {
        if (!this.ifaceDrops.has(t.hostDropIface)) this.ifaceDrops.set(t.hostDropIface, []);
        const drops = this.ifaceDrops.get(t.hostDropIface)!;
        if (!drops.includes(t.hostDropName)) drops.push(t.hostDropName);
      } else if (t.tag === 'lowerImport') {
        if (!this.bareFuncImports.has(t.name)) {
          this.bareFuncImports.set(t.name, { paramCount: t.paramCount, isAsync: t.isAsync });
        }
      }
    }

    // Detect Stream/Future usage in host import types
    const checkStreamFuture = (ty: HostValType): void => {
      if (typeof ty === 'object' && ty !== null) {
        if (ty.tag === 'stream') { this.needsStream = true; if (ty.elem) checkStreamFuture(ty.elem); }
        else if (ty.tag === 'future') { this.needsFuture = true; if (ty.elem) checkStreamFuture(ty.elem); }
        else if (ty.tag === 'variant') { for (const c of ty.cases) if (c.type) checkStreamFuture(c.type); }
        else if (ty.tag === 'record') { for (const f of ty.fields) checkStreamFuture(f.type); }
        else if (ty.tag === 'tuple') { for (const e of ty.elems) checkStreamFuture(e); }
        else if (ty.tag === 'list') { checkStreamFuture(ty.elem); }
        else if (ty.tag === 'option') { checkStreamFuture(ty.inner); }
        else if (ty.tag === 'result') { if (ty.ok) checkStreamFuture(ty.ok); if (ty.err) checkStreamFuture(ty.err); }
      }
    };
    for (const methods of this.ifaceMethods.values()) {
      for (const m of methods) {
        for (const pt of m.lowerInfo.paramTypes) checkStreamFuture(pt);
        if (m.lowerInfo.resultType) checkStreamFuture(m.lowerInfo.resultType);
      }
    }

    // Detect if all host imports are wasi:* prefixed
    const hasImports = this.ifaceMethods.size > 0 || this.ifaceDrops.size > 0
      || this.ifacePassthrough.size > 0 || this.bareFuncImports.size > 0;
    if (hasImports && this.bareFuncImports.size === 0) {
      const allWasi = (keys: Iterable<string>) => {
        for (const k of keys) if (!k.startsWith('wasi:')) return false;
        return true;
      };
      this.isAllWasi = allWasi(this.ifaceMethods.keys())
        && allWasi(this.ifaceDrops.keys())
        && allWasi(this.ifacePassthrough);
    }
  }

  /** Validate that JSPI mode is enabled when required trampolines are present. */
  private validateJspi(t: Trampoline): void {
    if (this.jspiEnabled) return;

    let reason: string | null = null;
    switch (t.tag) {
      case 'waitableSetWait':
      case 'threadYield':
      case 'threadSuspend':
      case 'threadSwitchTo':
      case 'threadYieldTo':
      case 'threadSuspendTo':
        reason = 'uses blocking builtins (waitable-set.wait, thread operations, etc.)';
        break;
      case 'subtaskCancel':
        if (!t.isAsync) {
          reason = 'has sync subtask.cancel (requires JSPI suspension)';
        }
        break;
      case 'asyncAdapter':
        if (!t.callerIsAsync) {
          reason = 'has a sync-caller async adapter';
        }
        break;
      case 'waitableSetPoll':
        if (t.cancellable) {
          reason = 'uses cancellable waitable-set.poll';
        }
        break;
      case 'streamRead':
      case 'streamWrite':
      case 'futureRead':
      case 'futureWrite':
        if (!t.isAsync) {
          reason = 'has blocking stream/future operations';
        }
        break;
    }

    if (reason) {
      throw new Error(
        `component requires JSPI (${reason}); set jspiMode: true in generate options`
      );
    }
  }

  // -------------------------------------------------------------------
  // Main emit
  // -------------------------------------------------------------------

  emit(): void {
    this.emitHeader();
    this.emitImportsType();
    this.emitInstantiateOpen();
    this.pushIndent();

    this.emitComponentState();
    this.emitTypedHostInterfaces();
    this.emitMemoryDeclarations();
    this.emitCallbackDeclarations();
    this.emitTrampolines();
    this.emitModuleDeclarations();
    this.emitInstanceDeclarations();
    this.emitInstantiations();
    this.emitMemoryExtractions();
    this.emitCallbackExtractions();
    this.emitExportFunctions();
    this.emitReturnObject();

    this.popIndent();
    this.line('}');
  }

  // -------------------------------------------------------------------
  // Declarations (.d.ts)
  // -------------------------------------------------------------------

  emitDeclarations(): string {
    const lines: string[] = [];
    const line = (s: string) => lines.push(s);

    line("import type { ComponentState } from '@jellevdh/wcjs/runtime';");
    line('');

    // Emit Stream/Future type aliases
    if (this.needsStream) line('type Stream<_T> = number;');
    if (this.needsFuture) line('type Future<_T> = number;');

    // Emit Imports type
    const hasImports = this.ifaceMethods.size > 0 || this.ifaceDrops.size > 0
      || this.ifacePassthrough.size > 0 || this.bareFuncImports.size > 0;

    if (!hasImports) {
      line('export type Imports = {};');
    } else {
      line('export type Imports = {');
      const remainingDrops = new Map(this.ifaceDrops);
      for (const [ifaceName, methods] of this.ifaceMethods) {
        const sigs: string[] = [];
        for (const m of methods) {
          const params = m.lowerInfo.paramTypes.map((pt, i) => `p${i}: ${hostValTypeToTS(pt)}`).join(', ');
          // For future-returning [async] functions: use the inner type of the future.
          // Async lowering: linker already stripped future, resultType = T.
          // Sync lowering: future preserved, resultType = {tag:'future', elem: T}.
          let rt = m.lowerInfo.resultType;
          if (m.isFutureResult && rt && typeof rt === 'object' && rt.tag === 'future') {
            rt = rt.elem;
          }
          const baseRetType = rt !== null ? hostValTypeToTS(rt) : 'void';
          // Host functions may return T or Promise<T> (async trampolines handle promises)
          const retType = baseRetType !== 'void'
            ? `${baseRetType} | Promise<${baseRetType}>`
            : 'void | Promise<void>';
          const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(m.exportName) ? m.exportName : `'${m.exportName}'`;
          sigs.push(`${key}(${params}): ${retType}`);
        }
        const drops = remainingDrops.get(ifaceName);
        if (drops) {
          for (const name of drops) sigs.push(`'${name}'(rep: number): void`);
          remainingDrops.delete(ifaceName);
        }
        line(`  '${ifaceName}': { ${sigs.join('; ')} };`);
      }
      for (const [ifaceName, drops] of remainingDrops) {
        const sigs = drops.map(name => `'${name}'(rep: number): void`);
        line(`  '${ifaceName}': { ${sigs.join('; ')} };`);
      }
      for (const ifaceName of this.ifacePassthrough) {
        if (this.ifaceMethods.has(ifaceName)) continue;
        line(`  '${ifaceName}': Record<string, Function>;`);
      }
      for (const [name] of this.bareFuncImports) {
        line(`  '${name}': Function;`);
      }
      line('};');
    }

    if (this.isAllWasi) {
      line("import type { WasiHost } from '@jellevdh/wcjs/wasi';");
      line('type _AssertHostSatisfiesImports<_T extends Imports> = true;');
      line('type _HostCheck = _AssertHostSatisfiesImports<WasiHost>;');
    }

    line('');

    // Emit instantiate function signature
    line('export declare function instantiate(');
    line('  imports: Imports,');
    line('  instantiateCore?: (module: WebAssembly.Module, imports: WebAssembly.Imports) => Promise<WebAssembly.Instance>,');
    line('): Promise<{');

    for (const [interfacePath, funcMap] of this.linked.exports) {
      const parts: string[] = [];
      for (const [, funcInfo] of funcMap) {
        const jsName = this.sanitizeName(funcInfo.name);
        // In JSPI mode all exports return Promise (sync exports use promising()).
        // In callback mode only async exports return Promise.
        const isPromise = this.jspiEnabled || funcInfo.isAsync;

        if (funcInfo.liftInfo) {
          // Typed signature from canonical ABI info
          const info = funcInfo.liftInfo;
          const params = info.paramTypes.map((pt, i) => {
            const name = this.sanitizeName(info.paramNames[i] ?? `p${i}`);
            return `${name}: ${hostValTypeToTS(pt)}`;
          }).join(', ');
          const baseRetType = info.resultType !== null ? hostValTypeToTS(info.resultType) : 'void';
          const returnType = isPromise ? `Promise<${baseRetType}>` : baseRetType;
          parts.push(`${jsName}(${params}): ${returnType}`);
        } else {
          const returnType = isPromise ? 'Promise<unknown>' : 'unknown';
          parts.push(`${jsName}(...args: unknown[]): ${returnType}`);
        }
      }
      line(`  '${interfacePath}': { ${parts.join('; ')} };`);
    }

    line('  $states: ComponentState[];');
    line('  $destroy: () => void;');
    line('}>;');

    return lines.join('\n') + '\n';
  }

  // -------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------

  private emitHeader(): void {
    if (this.standaloneMode) {
      // Standalone mode: ES module with import statements, no type annotations
      const symbols = ['ComponentState', 'ResourceHandle', 'Subtask', 'CallContext', 'EventLoop'];
      if (this.jspiEnabled) symbols.push('suspending', 'promising', 'setJspiMode');
      this.line(`import { ${symbols.join(', ')} } from '@jellevdh/wcjs/runtime';`);
      this.line('');
      this.line("const __base = new URL('.', import.meta.url);");
      this.line('async function __loadCoreModule(name) {');
      this.line("  const url = new URL(name, __base);");
      this.line("  if (typeof globalThis.process !== 'undefined') {");
      this.line("    const { readFile } = await import('node:fs/promises');");
      this.line("    return new WebAssembly.Module(await readFile(url));");
      this.line('  }');
      this.line('  return WebAssembly.compileStreaming(fetch(url));');
      this.line('}');
    } else if (this.jsMode) {
      // In JS mode, runtime symbols are passed via the wrapper function parameter
      const symbols = ['ComponentState', 'ResourceHandle', 'Subtask', 'CallContext', 'EventLoop'];
      if (this.jspiEnabled) symbols.push('suspending', 'promising', 'setJspiMode');
      this.line(`const { ${symbols.join(', ')} } = runtime;`);
    } else {
      this.line('import {');
      this.line('  ComponentState,');
      this.line('  ResourceHandle,');
      this.line('  Subtask,');
      this.line('  CallContext,');
      this.line('  EventLoop,');
      if (this.jspiEnabled) {
        this.line('  suspending,');
        this.line('  promising,');
        this.line('  setJspiMode,');
      }
      this.line("} from '@jellevdh/wcjs/runtime';");
      if (this.isAllWasi) {
        this.line("import type { WasiHost } from '@jellevdh/wcjs/wasi';");
      }
      this.line('');
      this.line('type CoreModule = WebAssembly.Module;');
      this.line('type GetCoreModule = (name: string) => CoreModule;');
      this.line('type InstantiateCore = (module: CoreModule, imports: WebAssembly.Imports) => Promise<WebAssembly.Instance>;');
    }
  }

  // -------------------------------------------------------------------
  // Imports type
  // -------------------------------------------------------------------

  private emitImportsType(): void {
    // All type-only — skip entirely in JS mode
    if (this.jsMode) return;

    this.line('');
    if (this.needsStream) this.line('type Stream<_T> = number;');
    if (this.needsFuture) this.line('type Future<_T> = number;');

    const hasImports = this.ifaceMethods.size > 0 || this.ifaceDrops.size > 0
      || this.ifacePassthrough.size > 0 || this.bareFuncImports.size > 0;

    if (!hasImports) {
      this.line('export type Imports = {};');
      return;
    }

    this.line('export type Imports = {');

    // Interface-based imports (lowerHostImport with type info)
    // Clone ifaceDrops so we can consume entries that attach to typed interfaces
    const remainingDrops = new Map(this.ifaceDrops);
    for (const [ifaceName, methods] of this.ifaceMethods) {
      const sigs: string[] = [];
      for (const m of methods) {
        const params = m.lowerInfo.paramTypes.map((pt, i) => `p${i}: ${hostValTypeToTS(pt)}`).join(', ');
        let rt = m.lowerInfo.resultType;
        if (m.isFutureResult && rt && typeof rt === 'object' && rt.tag === 'future') {
          rt = rt.elem;
        }
        const baseRetType = rt !== null ? hostValTypeToTS(rt) : 'void';
        const retType = baseRetType !== 'void'
          ? `${baseRetType} | Promise<${baseRetType}>`
          : 'void | Promise<void>';
        const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(m.exportName) ? m.exportName : `'${m.exportName}'`;
        sigs.push(`${key}(${params}): ${retType}`);
      }
      // Attach resource drops for this interface
      const drops = remainingDrops.get(ifaceName);
      if (drops) {
        for (const name of drops) sigs.push(`'${name}'(rep: number): void`);
        remainingDrops.delete(ifaceName);
      }
      this.line(`  '${ifaceName}': { ${sigs.join('; ')} };`);
    }

    // Remaining resource drops not attached to a typed interface
    for (const [ifaceName, drops] of remainingDrops) {
      const sigs = drops.map(name => `'${name}'(rep: number): void`);
      this.line(`  '${ifaceName}': { ${sigs.join('; ')} };`);
    }

    // Passthrough imports (no type info)
    for (const ifaceName of this.ifacePassthrough) {
      if (this.ifaceMethods.has(ifaceName)) continue;
      this.line(`  '${ifaceName}': Record<string, Function>;`);
    }

    // Bare function imports (lowerImport)
    for (const [name] of this.bareFuncImports) {
      this.line(`  '${name}': Function;`);
    }

    this.line('};');

    // Compile-time assertion: WasiHost satisfies this component's Imports
    if (this.isAllWasi) {
      this.line('type _AssertHostSatisfiesImports<_T extends Imports> = true;');
      this.line('type _HostCheck = _AssertHostSatisfiesImports<WasiHost>;');
    }
  }

  // -------------------------------------------------------------------
  // Instantiate function
  // -------------------------------------------------------------------

  private emitInstantiateOpen(): void {
    this.line('');
    if (this.standaloneMode) {
      this.line('export async function instantiate(imports, instantiateCore = WebAssembly.instantiate) {');
    } else if (this.jsMode) {
      this.line('return async function instantiate(getCoreModule, imports, instantiateCore = WebAssembly.instantiate) {');
    } else {
      this.line('export async function instantiate(');
      this.line('getCoreModule: GetCoreModule,');
      this.line('imports: Imports,');
      this.line('instantiateCore: InstantiateCore = WebAssembly.instantiate as unknown as InstantiateCore,');
      this.line(') {');
    }
  }

  // -------------------------------------------------------------------
  // Component state setup
  // -------------------------------------------------------------------

  private emitComponentState(): void {
    const numStates = this.linked.numStates;

    this.line(`const _eventLoop${this.ts(': EventLoop')} = new EventLoop();`);
    if (this.jspiEnabled) {
      this.line('setJspiMode(true);');
    }

    for (let i = 0; i < numStates; i++) {
      this.line(`const state${i}${this.ts(': ComponentState')} = new ComponentState(${i});`);
      this.line(`state${i}.setEventLoop(_eventLoop);`);
      this.line(`_eventLoop.registerComponentState(state${i});`);
    }

    // Emit parent/child relationships
    for (const rel of this.linked.stateRelationships) {
      this.line(`state${rel.child}.setParent(state${rel.parent});`);
    }

    // Emit _states array and CallContext when multi-component
    if (numStates > 1) {
      const stateVars = Array.from({ length: numStates }, (_, i) => `state${i}`);
      this.line(`const _states${this.ts(': ComponentState[]')} = [${stateVars.join(', ')}];`);
      this.line(`const _callCtx${this.ts(': CallContext')} = new CallContext(_eventLoop);`);
    }
  }

  // -------------------------------------------------------------------
  // Typed host interface variables
  // -------------------------------------------------------------------

  private emitTypedHostInterfaces(): void {
    if (this.ifaceMethods.size === 0 && this.ifaceDrops.size === 0 && this.ifacePassthrough.size === 0) return;

    this.line('');
    let varIdx = 0;
    const remainingDrops = new Map(this.ifaceDrops);

    for (const [ifaceName] of this.ifaceMethods) {
      const varName = `_hostIface${varIdx++}`;
      this.hostIfaceVarNames.set(ifaceName, varName);
      remainingDrops.delete(ifaceName);
      this.line(`const ${varName} = imports['${ifaceName}'];`);
    }

    // Remaining resource drops not attached to a typed interface
    for (const [ifaceName] of remainingDrops) {
      const varName = `_hostIface${varIdx++}`;
      this.hostIfaceVarNames.set(ifaceName, varName);
      this.line(`const ${varName} = imports['${ifaceName}'];`);
    }

    // Pass-through imports without type info
    for (const ifaceName of this.ifacePassthrough) {
      if (this.hostIfaceVarNames.has(ifaceName)) continue;
      const varName = `_hostIface${varIdx++}`;
      this.hostIfaceVarNames.set(ifaceName, varName);
      this.line(`const ${varName} = imports['${ifaceName}'];`);
    }
  }

  // -------------------------------------------------------------------
  // Memory declarations
  // -------------------------------------------------------------------

  private emitMemoryDeclarations(): void {
    if (this.memoryCount === 0) return;
    this.line('');
    for (let i = 0; i < this.memoryCount; i++) {
      this.line(`let memory${i}${this.ts(': WebAssembly.Memory')};`);
    }
  }

  // -------------------------------------------------------------------
  // Callback declarations
  // -------------------------------------------------------------------

  private emitCallbackDeclarations(): void {
    if (!this.hasCallbacks) return;
    this.line('');
    if (!this.jsMode) this.line('type CallbackFn = (eventCode: number, p1: number, p2: number) => number;');
    for (let i = 0; i < this.callbackCount; i++) {
      this.line(`let callback_${i}${this.ts(': CallbackFn')};`);
    }
  }

  // -------------------------------------------------------------------
  // Trampolines
  // -------------------------------------------------------------------

  private emitTrampolines(): void {
    if (this.linked.trampolines.length === 0) return;
    this.line('');

    for (const t of this.linked.trampolines) {
      this.emitTrampoline(t.trampolineIdx, t.trampoline);
    }
  }

  private emitTrampoline(idx: number, t: Trampoline): void {
    const stateVar = t.tag === 'asyncAdapter' ? '' : `state${t.stateIdx}`;

    switch (t.tag) {
      case 'taskReturn':
        this.emitTaskReturnTrampoline(idx, t, stateVar);
        break;

      case 'contextGet':
        this.line(`const trampoline${idx} = ()${this.ts(': number')} => ${stateVar}.contextGet(${t.slot});`);
        break;

      case 'contextSet':
        this.line(`const trampoline${idx} = (val${this.ts(': number')})${this.ts(': void')} => ${stateVar}.contextSet(${t.slot}, val);`);
        break;

      case 'waitableSetNew':
        this.line(`const trampoline${idx} = ()${this.ts(': number')} => ${stateVar}.waitableSetNew();`);
        break;

      case 'waitableSetDrop':
        this.line(`const trampoline${idx} = (wsIdx${this.ts(': number')})${this.ts(': void')} => ${stateVar}.waitableSetDrop(wsIdx);`);
        break;

      case 'waitableJoin':
        this.line(`const trampoline${idx} = (waitableIdx${this.ts(': number')}, wsIdx${this.ts(': number')})${this.ts(': void')} => ${stateVar}.waitableJoin(waitableIdx, wsIdx);`);
        break;

      case 'subtaskDrop':
        this.line(`const trampoline${idx} = (subtaskIdx${this.ts(': number')})${this.ts(': void')} => ${stateVar}.subtaskDrop(subtaskIdx);`);
        break;

      case 'subtaskCancel':
        if (t.isAsync && this.jspiEnabled) {
          this.line(`const trampoline${idx} = suspending((subtaskIdx${this.ts(': number')})${this.ts(': number | Promise<number>')} => ${stateVar}.subtaskCancel(subtaskIdx, true));`);
        } else if (t.isAsync) {
          this.line(`const trampoline${idx} = (subtaskIdx${this.ts(': number')})${this.ts(': number')} => ${stateVar}.subtaskCancel(subtaskIdx, true)${this.ts(' as number')};`);
        } else {
          this.line(`const trampoline${idx} = suspending((subtaskIdx${this.ts(': number')})${this.ts(': number | Promise<number>')} => { ${stateVar}.checkSyncBlock(); return ${stateVar}.subtaskCancel(subtaskIdx, false); });`);
        }
        break;

      case 'taskCancel':
        this.line(`const trampoline${idx} = ()${this.ts(': void')} => ${stateVar}.taskCancel();`);
        break;

      case 'streamNew':
        this.line(`const trampoline${idx} = ()${this.ts(': bigint')} => ${stateVar}.streamNew(${t.tableIdx});`);
        break;

      case 'streamRead':
        this.emitStreamReadTrampoline(idx, t, stateVar);
        break;

      case 'streamWrite':
        this.emitStreamWriteTrampoline(idx, t, stateVar);
        break;

      case 'streamCancelRead':
        this.line(`const trampoline${idx} = (endIdx${this.ts(': number')})${this.ts(': number')} => { ${stateVar}.checkSyncBlock(); return ${stateVar}.streamCancelRead(${t.tableIdx}, endIdx, ${t.isAsync}); };`);
        break;

      case 'streamCancelWrite':
        this.line(`const trampoline${idx} = (endIdx${this.ts(': number')})${this.ts(': number')} => { ${stateVar}.checkSyncBlock(); return ${stateVar}.streamCancelWrite(${t.tableIdx}, endIdx, ${t.isAsync}); };`);
        break;

      case 'streamDropReadable':
        this.line(`const trampoline${idx} = (endIdx${this.ts(': number')})${this.ts(': void')} => ${stateVar}.streamDropReadable(${t.tableIdx}, endIdx);`);
        break;

      case 'streamDropWritable':
        this.line(`const trampoline${idx} = (endIdx${this.ts(': number')})${this.ts(': void')} => ${stateVar}.streamDropWritable(${t.tableIdx}, endIdx);`);
        break;

      case 'futureNew':
        this.line(`const trampoline${idx} = ()${this.ts(': bigint')} => ${stateVar}.futureNew(${t.tableIdx});`);
        break;

      case 'futureRead':
        this.emitFutureReadTrampoline(idx, t, stateVar);
        break;

      case 'futureWrite':
        this.emitFutureWriteTrampoline(idx, t, stateVar);
        break;

      case 'futureCancelRead':
        this.line(`const trampoline${idx} = (endIdx${this.ts(': number')})${this.ts(': number')} => { ${stateVar}.checkSyncBlock(); return ${stateVar}.futureCancelRead(${t.tableIdx}, endIdx, ${t.isAsync}); };`);
        break;

      case 'futureCancelWrite':
        this.line(`const trampoline${idx} = (endIdx${this.ts(': number')})${this.ts(': number')} => { ${stateVar}.checkSyncBlock(); return ${stateVar}.futureCancelWrite(${t.tableIdx}, endIdx, ${t.isAsync}); };`);
        break;

      case 'futureDropReadable':
        this.line(`const trampoline${idx} = (endIdx${this.ts(': number')})${this.ts(': void')} => ${stateVar}.futureDropReadable(${t.tableIdx}, endIdx);`);
        break;

      case 'futureDropWritable':
        this.line(`const trampoline${idx} = (endIdx${this.ts(': number')})${this.ts(': void')} => ${stateVar}.futureDropWritable(${t.tableIdx}, endIdx);`);
        break;

      case 'waitableSetWait':
        if (t.cancellable) {
          this.line(`const trampoline${idx} = suspending((wsIdx${this.ts(': number')}, ptr${this.ts(': number')})${this.ts(': number | Promise<number>')} => {`);
          this.line(`    return ${stateVar}.waitableSetWaitCancellable(memory${t.memoryIdx}, wsIdx, ptr);`);
          this.line('});');
        } else {
          this.line(`const trampoline${idx} = suspending((wsIdx${this.ts(': number')}, ptr${this.ts(': number')})${this.ts(': number | Promise<number>')} => {`);
          this.line(`    return ${stateVar}.waitableSetWait(memory${t.memoryIdx}, wsIdx, ptr);`);
          this.line('});');
        }
        break;

      case 'waitableSetPoll':
        if (t.cancellable) {
          this.line(`const trampoline${idx} = suspending((wsIdx${this.ts(': number')}, ptr${this.ts(': number')})${this.ts(': number | Promise<number>')} => {`);
          this.line(`    return ${stateVar}.waitableSetPollCancellable(memory${t.memoryIdx}, wsIdx, ptr);`);
          this.line('});');
        } else {
          this.line(`const trampoline${idx} = (wsIdx${this.ts(': number')}, ptr${this.ts(': number')})${this.ts(': number')} => {`);
          this.line(`    return ${stateVar}.waitableSetPoll(memory${t.memoryIdx}, wsIdx, ptr);`);
          this.line('};');
        }
        break;

      case 'lowerImport':
        this.emitLowerImportTrampoline(idx, t, stateVar);
        break;

      case 'lowerHostImport':
        this.emitLowerHostImportTrampoline(idx, t, stateVar);
        break;

      case 'resourceNew':
        this.line(`const trampoline${idx} = (rep${this.ts(': number')})${this.ts(': number')} => ${stateVar}.resourceNew(${t.tableIdx}, rep);`);
        break;

      case 'resourceRep':
        this.line(`const trampoline${idx} = (handle${this.ts(': number')})${this.ts(': number')} => ${stateVar}.resourceRep(${t.tableIdx}, handle);`);
        break;

      case 'resourceDrop':
        if (t.dtorInstanceIdx !== undefined && t.dtorExportName !== undefined) {
          this.line(`const trampoline${idx} = (handle${this.ts(': number')})${this.ts(': void')} => { ${stateVar}.resourceDrop(${t.tableIdx}, handle, (rep${this.ts(': number')}) => (instance${t.dtorInstanceIdx}.exports['${t.dtorExportName}']${this.ts(' as Function')})(rep)); };`);
        } else if (t.hostDropIface !== undefined && t.hostDropName !== undefined) {
          const dropIfaceVar = this.hostIfaceVarNames.get(t.hostDropIface);
          if (dropIfaceVar) {
            this.line(`const trampoline${idx} = (handle${this.ts(': number')})${this.ts(': void')} => { ${stateVar}.resourceDrop(${t.tableIdx}, handle, (rep${this.ts(': number')}) => ${dropIfaceVar}['${t.hostDropName}'](rep)); };`);
          } else {
            this.line(`const trampoline${idx} = (handle${this.ts(': number')})${this.ts(': void')} => { ${stateVar}.resourceDrop(${t.tableIdx}, handle, (rep${this.ts(': number')}) => (imports['${t.hostDropIface}']${this.ts(' as Record<string, Function>')})['${t.hostDropName}'](rep)); };`);
          }
        } else {
          this.line(`const trampoline${idx} = (handle${this.ts(': number')})${this.ts(': void')} => { ${stateVar}.resourceDrop(${t.tableIdx}, handle); };`);
        }
        break;

      case 'threadYield':
        if (t.cancellable) {
          this.line(`const trampoline${idx} = suspending(()${this.ts(': Promise<number>')} => ${stateVar}.threadYieldCancellable());`);
        } else {
          this.line(`const trampoline${idx} = suspending(async ()${this.ts(': Promise<void>')} => { await new Promise${this.ts('<void>')}(r => setTimeout(r, 0)); });`);
        }
        break;

      case 'threadIndex':
        this.line(`const trampoline${idx} = ()${this.ts(': number')} => 0;`);
        break;

      case 'threadNewIndirect':
        this.line(`const trampoline${idx} = (funcIdx${this.ts(': number')}, arg${this.ts(': number')})${this.ts(': number')} => ${stateVar}.threadNewIndirect(instance${t.tableRuntimeInstanceIdx}.exports['${t.tableExportName}']${this.ts(' as WebAssembly.Table')}, funcIdx, arg);`);
        break;

      case 'threadSuspend':
        this.line(`const trampoline${idx} = suspending(()${this.ts(': number | Promise<number>')} => ${stateVar}.threadSuspend());`);
        break;

      case 'threadSwitchTo':
        this.line(`const trampoline${idx} = suspending((threadIdx${this.ts(': number')})${this.ts(': number | Promise<number>')} => ${stateVar}.threadSwitchTo(threadIdx));`);
        break;

      case 'threadYieldTo':
        this.line(`const trampoline${idx} = suspending((threadIdx${this.ts(': number')})${this.ts(': number | Promise<number>')} => ${stateVar}.threadYieldTo(threadIdx));`);
        break;

      case 'threadSuspendTo':
        this.line(`const trampoline${idx} = suspending((threadIdx${this.ts(': number')})${this.ts(': number | Promise<number>')} => ${stateVar}.threadSwitchTo(threadIdx));`);
        break;

      case 'threadResumeLater':
        this.line(`const trampoline${idx} = (threadIdx${this.ts(': number')})${this.ts(': void')} => ${stateVar}.threadResumeLater(threadIdx);`);
        break;

      case 'asyncAdapter':
        this.emitAsyncAdapterTrampoline(idx, t);
        break;

      default:
        this.line(`const trampoline${idx} = () => { throw new Error('unimplemented trampoline: ${(t as Trampoline).tag}'); };`);
    }
  }

  private emitTaskReturnTrampoline(idx: number, t: Trampoline & { tag: 'taskReturn' }, stateVar: string): void {
    switch (t.resultKind) {
      case 'none':
        this.line(`const trampoline${idx} = ()${this.ts(': void')} => {`);
        this.line(`    ${stateVar}.currentTask${this.ts('!')}.resolve(undefined);`);
        this.line('};');
        break;
      case 'resultType':
        this.line(`const trampoline${idx} = (discriminant${this.ts(': number')})${this.ts(': void')} => {`);
        this.line(`    ${stateVar}.currentTask${this.ts('!')}.resolve(discriminant === 0 ? { tag: 'ok' } : { tag: 'err' });`);
        this.line('};');
        break;
      case 'primitive':
        this.line(`const trampoline${idx} = (value${this.ts(': number')})${this.ts(': void')} => {`);
        this.line(`    ${stateVar}.currentTask${this.ts('!')}.resolve(value);`);
        this.line('};');
        break;
      case 'flatValues':
        this.line(`const trampoline${idx} = (...values${this.ts(': unknown[]')})${this.ts(': void')} => {`);
        this.line(`    ${stateVar}.currentTask${this.ts('!')}.resolve(values);`);
        this.line('};');
        break;
    }
  }

  private emitStreamReadTrampoline(idx: number, t: Trampoline & { tag: 'streamRead' }, stateVar: string): void {
    const elemArg = t.isResource ? '' : `, ${t.elemSize}`;
    // Generate store function for non-scalar stream element types
    let storeFnName: string | null = null;
    if (!t.isResource && t.elemHostType && t.reallocInfo) {
      storeFnName = `_streamStoreFn${idx}`;
      const reallocExpr = `(instance${t.reallocInfo.runtimeInstanceIdx}.exports['${t.reallocInfo.exportName}']${this.ts(' as Function')})`;
      const memIdx = t.memoryIdx;
      this.line(`const ${storeFnName} = (_off${this.ts(': number')}, _item${this.ts(': unknown')})${this.ts(': void')} => {`);
      this.genStoreResult(t.elemHostType, memIdx, reallocExpr, '_off', '_item', 0);
      this.line('};');
    }
    const storeFnArg = storeFnName ? `, ${storeFnName}` : '';
    if (t.isAsync) {
      const method = t.isResource ? 'streamReadResources' : 'streamReadAsync';
      const typeArg = t.isResource && t.resourceTableIdx !== undefined ? t.resourceTableIdx : t.tableIdx;
      this.line(`const trampoline${idx} = (endIdx${this.ts(': number')}, ptr${this.ts(': number')}, count${this.ts(': number')})${this.ts(': number')} => {`);
      this.line(`    return ${stateVar}.${method}(${typeArg}, endIdx, memory${t.memoryIdx}, ptr, count${elemArg}${storeFnArg})${this.ts(' as number')};`);
      this.line('};');
    } else {
      const method = t.isResource ? 'streamReadResources' : 'streamReadSync';
      const typeArg = t.isResource && t.resourceTableIdx !== undefined ? t.resourceTableIdx : t.tableIdx;
      this.line(`const trampoline${idx} = suspending((endIdx${this.ts(': number')}, ptr${this.ts(': number')}, count${this.ts(': number')})${this.ts(': number | Promise<number>')} => {`);
      this.line(`    ${stateVar}.checkSyncBlock(); return ${stateVar}.${method}(${typeArg}, endIdx, memory${t.memoryIdx}, ptr, count${elemArg}${storeFnArg});`);
      this.line('});');
    }
  }

  private emitStreamWriteTrampoline(idx: number, t: Trampoline & { tag: 'streamWrite' }, stateVar: string): void {
    const elemArg = t.isResource ? '' : `, ${t.elemSize}`;
    if (t.isAsync) {
      const method = t.isResource ? 'streamWriteResources' : 'streamWriteAsync';
      const typeArg = t.isResource && t.resourceTableIdx !== undefined ? t.resourceTableIdx : t.tableIdx;
      this.line(`const trampoline${idx} = (endIdx${this.ts(': number')}, ptr${this.ts(': number')}, count${this.ts(': number')})${this.ts(': number')} => {`);
      this.line(`    return ${stateVar}.${method}(${typeArg}, endIdx, memory${t.memoryIdx}, ptr, count${elemArg})${this.ts(' as number')};`);
      this.line('};');
    } else {
      const method = t.isResource ? 'streamWriteResources' : 'streamWriteSync';
      const typeArg = t.isResource && t.resourceTableIdx !== undefined ? t.resourceTableIdx : t.tableIdx;
      this.line(`const trampoline${idx} = suspending((endIdx${this.ts(': number')}, ptr${this.ts(': number')}, count${this.ts(': number')})${this.ts(': number | Promise<number>')} => {`);
      this.line(`    ${stateVar}.checkSyncBlock(); return ${stateVar}.${method}(${typeArg}, endIdx, memory${t.memoryIdx}, ptr, count${elemArg});`);
      this.line('});');
    }
  }

  private emitFutureReadTrampoline(idx: number, t: Trampoline & { tag: 'futureRead' }, stateVar: string): void {
    const memExpr = t.elemSize === 0 ? (this.jsMode ? 'null' : 'null!') : `memory${t.memoryIdx}`;
    const ptrParam = t.elemSize === 0 ? '_ptr' : 'ptr';
    const ptrArg = t.elemSize === 0 ? '0' : 'ptr';
    // Generate storeFn for complex element types (size > 8)
    let storeFnName: string | undefined;
    if (t.elemHostType) {
      storeFnName = `_futureStoreFn${idx}`;
      const reallocExpr = t.reallocInfo ? `(instance${t.reallocInfo.runtimeInstanceIdx}.exports['${t.reallocInfo.exportName}']${this.ts(' as Function')})` : 'null';
      const memIdx = t.memoryIdx;
      this.line(`const ${storeFnName} = (_off${this.ts(': number')}, _item${this.ts(': unknown')})${this.ts(': void')} => {`);
      this.genStoreResult(t.elemHostType, memIdx, reallocExpr, '_off', '_item', 0);
      this.line('};');
    }
    const storeFnArg = storeFnName ? `, ${storeFnName}` : '';
    if (t.isAsync) {
      this.line(`const trampoline${idx} = (endIdx${this.ts(': number')}, ${ptrParam}${this.ts(': number')})${this.ts(': number')} => {`);
      this.line(`    return ${stateVar}.futureReadAsync(${t.tableIdx}, endIdx, ${memExpr}, ${ptrArg}, ${t.elemSize}${storeFnArg})${this.ts(' as number')};`);
      this.line('};');
    } else {
      this.line(`const trampoline${idx} = (endIdx${this.ts(': number')}, ${ptrParam}${this.ts(': number')})${this.ts(': number')} => {`);
      this.line(`    ${stateVar}.checkSyncBlock(); return ${stateVar}.futureReadSync(${t.tableIdx}, endIdx, ${memExpr}, ${ptrArg}, ${t.elemSize}${storeFnArg})${this.ts(' as number')};`);
      this.line('};');
    }
  }

  private emitFutureWriteTrampoline(idx: number, t: Trampoline & { tag: 'futureWrite' }, stateVar: string): void {
    const memExpr = t.elemSize === 0 ? (this.jsMode ? 'null' : 'null!') : `memory${t.memoryIdx}`;
    const ptrParam = t.elemSize === 0 ? '_ptr' : 'ptr';
    const ptrArg = t.elemSize === 0 ? '0' : 'ptr';
    if (t.isAsync) {
      this.line(`const trampoline${idx} = (endIdx${this.ts(': number')}, ${ptrParam}${this.ts(': number')})${this.ts(': number')} => {`);
      this.line(`    return ${stateVar}.futureWriteAsync(${t.tableIdx}, endIdx, ${memExpr}, ${ptrArg}, ${t.elemSize})${this.ts(' as number')};`);
      this.line('};');
    } else {
      this.line(`const trampoline${idx} = (endIdx${this.ts(': number')}, ${ptrParam}${this.ts(': number')})${this.ts(': number')} => {`);
      this.line(`    ${stateVar}.checkSyncBlock(); return ${stateVar}.futureWriteSync(${t.tableIdx}, endIdx, ${memExpr}, ${ptrArg}, ${t.elemSize})${this.ts(' as number')};`);
      this.line('};');
    }
  }

  private emitLowerImportTrampoline(idx: number, t: Trampoline & { tag: 'lowerImport' }, stateVar: string): void {
    const params = Array.from({ length: t.paramCount }, (_, i) => `p${i}${this.ts(': number')}`).join(', ');
    const args = Array.from({ length: t.paramCount }, (_, i) => `p${i}`).join(', ');

    if (t.isAsync) {
      this.line(`const trampoline${idx} = (${params})${this.ts(': number')} => {`);
      this.line(`    const hostFn = imports['${t.name}'];`);
      this.line(`    const result = hostFn(${args});`);
      this.line(`    return ${stateVar}.lowerImportAsync(result);`);
      this.line('};');
    } else {
      this.line(`const trampoline${idx} = (${params})${this.ts(': number')} => {`);
      this.line(`    const hostFn = imports['${t.name}'];`);
      this.line(`    return hostFn(${args})${this.ts(' as number')};`);
      this.line('};');
    }
  }

  private emitLowerHostImportTrampoline(idx: number, t: Trampoline & { tag: 'lowerHostImport' }, stateVar: string): void {
    this.nextTmpVar = 0; // Reset for each trampoline
    this.currentStateIdx = t.stateIdx;
    const stripAsync = (n: string) =>
      n.startsWith('[async]') ? n.slice(7) :
      n.startsWith('[async ') ? '[' + n.slice(7) : n;
    const addAsync = (n: string) =>
      n.startsWith('[') ? '[async ' + n.slice(1) : '[async]' + n;
    const isFutureResult = t.lowerInfo?.resultType &&
      typeof t.lowerInfo.resultType === 'object' && t.lowerInfo.resultType.tag === 'future';
    const hostExportName = isFutureResult
      ? addAsync(stripAsync(t.exportName))
      : stripAsync(t.exportName);
    const ifaceVar = this.hostIfaceVarNames.get(t.importName);
    const hostFnLookup = ifaceVar
      ? `${ifaceVar}['${hostExportName}']`
      : `(imports['${t.importName}']${this.ts(' as Record<string, Function>')})['${hostExportName}']`;

    if (!t.lowerInfo) {
      // Pass-through: no type info available, forward args directly
      if (t.isAsync) {
        this.line(`const trampoline${idx} = (...args${this.ts(': unknown[]')})${this.ts(': number')} => {`);
        this.line(`    const result = ${hostFnLookup}(...args);`);
        this.line(`    return ${stateVar}.lowerImportAsync(result);`);
        this.line('};');
      } else {
        this.line(`const trampoline${idx} = (...args${this.ts(': unknown[]')})${this.ts(': unknown')} => {`);
        this.line(`    return ${hostFnLookup}(...args);`);
        this.line('};');
      }
      return;
    }

    // Typed lowering with ABI conversion
    const info = t.lowerInfo;
    const memIdx = info.memoryIdx;
    // For async-lowered imports, the return value is the packed subtask state,
    // so the actual result is ALWAYS written via retptr when there is a result type.
    const hasRetptr = t.isAsync
      ? info.resultType !== null
      : info.resultFlatTypes.length > 1;
    // For async lower, MAX_FLAT_PARAMS = 4; when exceeded, params are spilled to memory
    const asyncSpilledParams = t.isAsync && info.paramFlatTypes.length > 4;

    if (asyncSpilledParams) {
      // Memory-based param reading: shim passes (argPtr[, retptr]) instead of flat params
      // Params are stored in canonical ABI record layout (NOT flat layout)
      const paramParts = [`argPtr${this.ts(': number')}`];
      if (hasRetptr) paramParts.push(`retptr${this.ts(': number')}`);

      this.line(`const trampoline${idx} = (${paramParts.join(', ')})${this.ts(': number')} => {`);
      this.line(`    const hostFn = ${hostFnLookup};`);
      this.line(`    const _dv = new DataView(memory${memIdx}.buffer);`);

      // Load parameters from canonical ABI record layout and lift to JS values
      const liftedArgs: string[] = [];
      let recordOffset = 0;
      for (let i = 0; i < info.paramTypes.length; i++) {
        const pt = info.paramTypes[i]!;
        const align = hostValTypeAlignment(pt);
        recordOffset = (recordOffset + align - 1) & ~(align - 1);
        const argExpr = this.genCanonicalLoad(pt, memIdx!, i, recordOffset);
        liftedArgs.push(argExpr.varName);
        recordOffset += hostValTypeByteSize(pt);
      }

      const callArgs = liftedArgs.join(', ');
      this.line(`    const result = hostFn(${callArgs});`);

      if (hasRetptr && info.resultType !== null) {
        const reallocExpr = info.realloc
          ? `(instance${info.realloc.runtimeInstanceIdx}.exports['${info.realloc.exportName}']${this.ts(' as Function')})`
          : 'null';
        // Support async host functions: if result is a Promise, defer memory write
        const storeType = hostValTypeToTS(info.resultType);
        this.line(`    const _store = (_r${this.ts(': ' + storeType)})${this.ts(': void')} => {`);
        this.genStoreResult(info.resultType, memIdx!, reallocExpr, 'retptr', '_r', 0, true);
        this.line(`    };`);
        this.line(`    if (result instanceof Promise) {`);
        this.line(`        return ${stateVar}.lowerImportAsync((result${this.ts(' as Promise<' + storeType + '>')}).then(_store));`);
        this.line(`    }`);
        this.line(`    _store(result);`);
        this.line(`    return ${stateVar}.lowerImportAsync(undefined);`);
      } else {
        this.line(`    return ${stateVar}.lowerImportAsync(result);`);
      }

      this.line('};');
      return;
    }

    // Build typed parameter list (individual flat params)
    const paramParts: string[] = [];
    for (let i = 0; i < info.paramTypes.length; i++) {
      const flat = flattenHostValType(info.paramTypes[i]!);
      for (let j = 0; j < flat.length; j++) {
        const tsType = flat[j] === 'i64' ? 'bigint' : 'number';
        if (flat.length === 1) {
          paramParts.push(`p${i}${this.ts(': ' + tsType)}`);
        } else {
          paramParts.push(`p${i}_${j}${this.ts(': ' + tsType)}`);
        }
      }
    }
    if (hasRetptr) {
      paramParts.push(`retptr${this.ts(': number')}`);
    }

    const returnType = t.isAsync
      ? 'number'
      : hasRetptr
        ? 'void'
        : info.resultFlatTypes.length === 1
          ? (info.resultFlatTypes[0] === 'i64' ? 'bigint' : 'number')
          : 'void';

    this.line(`const trampoline${idx} = (${paramParts.join(', ')})${this.ts(': ' + returnType)} => {`);
    this.line(`    const hostFn = ${hostFnLookup};`);

    // Lift parameters from flat core args to JS values
    const liftedArgs: string[] = [];
    let flatIdx = 0;
    for (let i = 0; i < info.paramTypes.length; i++) {
      const pt = info.paramTypes[i]!;
      const flat = flattenHostValType(pt);
      const liftExpr = this.genLiftParam(pt, i, flatIdx, memIdx);
      const argName = flat.length === 1 ? `p${i}` : `p${i}_0`;
      if (liftExpr !== argName) {
        this.line(`    const arg${i} = ${liftExpr};`);
        liftedArgs.push(`arg${i}`);
      } else {
        liftedArgs.push(argName);
      }
      flatIdx += flat.length;
    }

    const callArgs = liftedArgs.join(', ');

    if (info.resultType === null) {
      // No result
      if (t.isAsync) {
        this.line(`    const result = hostFn(${callArgs});`);
        this.line(`    return ${stateVar}.lowerImportAsync(result);`);
      } else {
        this.line(`    hostFn(${callArgs});`);
      }
    } else if (hasRetptr) {
      // Result stored to memory via retptr
      this.line(`    const result = hostFn(${callArgs});`);
      const reallocExpr = info.realloc
        ? `(instance${info.realloc.runtimeInstanceIdx}.exports['${info.realloc.exportName}']${this.ts(' as Function')})`
        : 'null';
      if (t.isAsync) {
        // Support async host functions: if result is a Promise, defer memory write
        const storeType = hostValTypeToTS(info.resultType!);
        this.line(`    const _store = (_r${this.ts(': ' + storeType)})${this.ts(': void')} => {`);
        this.genStoreResult(info.resultType!, memIdx!, reallocExpr, 'retptr', '_r', 0, true);
        this.line(`    };`);
        this.line(`    if (result instanceof Promise) {`);
        this.line(`        return ${stateVar}.lowerImportAsync((result${this.ts(' as Promise<' + storeType + '>')}).then(_store));`);
        this.line(`    }`);
        this.line(`    _store(result);`);
        this.line(`    return ${stateVar}.lowerImportAsync(undefined);`);
      } else {
        this.genStoreResult(info.resultType!, memIdx!, reallocExpr, 'retptr', 'result', 0);
      }
    } else if (isFutureResult) {
      this.line(`    const result = hostFn(${callArgs});`);
      this.line(`    const _fp = ${stateVar}.futureNew(0);`);
      this.line(`    const _fri = Number(_fp & 0xFFFFFFFFn);`);
      this.line(`    const _fwi = Number(_fp >> 32n);`);
      this.line(`    if (result instanceof Promise) {`);
      this.line(`        ${stateVar}.trackHostAsync(result.then(`);
      this.line(`            _v => { ${stateVar}.futureWriteHost(0, _fwi, [_v]); },`);
      this.line(`            () => { try { ${stateVar}.futureWriteHost(0, _fwi, [{ tag: 'ok' }]); } catch (_) {} }`);
      this.line(`        ));`);
      this.line(`    } else {`);
      this.line(`        ${stateVar}.futureWriteHost(0, _fwi, [result]);`);
      this.line(`    }`);
      this.line(`    return _fri;`);
    } else {
      // Single flat result — return directly
      // For own resources, wrap the host rep with resourceNew()
      const isOwnResult = typeof info.resultType === 'object' && info.resultType.tag === 'own';
      if (isOwnResult) {
        const tableIdx = (info.resultType as { tag: 'own'; tableIdx: number }).tableIdx;
        if (t.isAsync) {
          this.line(`    const result = hostFn(${callArgs});`);
          this.line(`    return ${stateVar}.lowerImportAsync(Promise.resolve(result).then(r => ${stateVar}.resourceNew(${tableIdx}, r${this.ts(' as number')})));`);
        } else {
          this.line(`    return ${stateVar}.resourceNew(${tableIdx}, hostFn(${callArgs})${this.ts(' as number')});`);
        }
      } else if (typeof info.resultType === 'object' && info.resultType !== null && info.resultType.tag === 'enum') {
        // Enum result: convert string name to discriminant
        const names = info.resultType.names;
        const mapEntries = names.map((n: string, i: number) => `'${n}':${i}`).join(',');
        if (t.isAsync) {
          this.line(`    const result = hostFn(${callArgs});`);
          this.line(`    const _enumMap${this.ts(': Record<string,number>')} = {${mapEntries}};`);
          this.line(`    return ${stateVar}.lowerImportAsync(Promise.resolve(result).then(r => _enumMap[r${this.ts(' as string')}]));`);
        } else {
          this.line(`    const _enumMap${this.ts(': Record<string,number>')} = {${mapEntries}};`);
          this.line(`    return _enumMap[hostFn(${callArgs})${this.ts(' as string')}];`);
        }
      } else if (typeof info.resultType === 'object' && info.resultType !== null && info.resultType.tag === 'result') {
        // Result type returned as single flat i32: convert {tag:'ok'}/{tag:'err'} to discriminant
        if (t.isAsync) {
          this.line(`    const result = hostFn(${callArgs});`);
          this.line(`    return ${stateVar}.lowerImportAsync(Promise.resolve(result).then(r => (r${this.ts(' as {tag:string}')}).tag === 'ok' ? 0 : 1));`);
        } else {
          this.line(`    return (hostFn(${callArgs})${this.ts(' as {tag:string}')}).tag === 'ok' ? 0 : 1;`);
        }
      } else if (info.resultType === 'bool') {
        // Bool result: convert boolean to number
        if (t.isAsync) {
          this.line(`    const result = hostFn(${callArgs});`);
          this.line(`    return ${stateVar}.lowerImportAsync(Promise.resolve(result).then(r => r ? 1 : 0));`);
        } else {
          this.line(`    return hostFn(${callArgs}) ? 1 : 0;`);
        }
      } else if (t.isAsync) {
        this.line(`    const result = hostFn(${callArgs});`);
        this.line(`    return ${stateVar}.lowerImportAsync(result);`);
      } else {
        this.line(`    return hostFn(${callArgs})${this.ts(' as ' + returnType)};`);
      }
    }

    this.line('};');
  }

  private _liftId = 0;

  /** Generate code to lift a list from wasm memory into a JS array. */
  private genLiftListFromMemory(ty: { tag: 'list'; elem: HostValType }, memIdx: number, ptrExpr: string, lenExpr: string, varName: string, indent: string): void {
    const elemSize = hostValTypeByteSize(ty.elem);
    const iVar = `_i${this._liftId++}`;
    const arrVar = varName;
    const baseVar = `_base${this._liftId}`;
    this.line(`${indent}const ${baseVar} = ${ptrExpr};`);
    this.line(`${indent}const ${arrVar}${this.ts(': any[]')} = [];`);
    this.line(`${indent}for (let ${iVar} = 0; ${iVar} < (${lenExpr}); ${iVar}++) {`);
    const elemExpr = this.genLiftElemFromMemory(ty.elem, memIdx, `${baseVar} + ${iVar} * ${elemSize}`, indent + '  ');
    this.line(`${indent}  ${arrVar}.push(${elemExpr});`);
    this.line(`${indent}}`);
  }

  /** Generate an expression to lift a single element from wasm memory at a given offset expression. */
  private genLiftElemFromMemory(ty: HostValType, memIdx: number, offExpr: string, indent: string): string {
    const id = this._liftId++;
    const dv = `new DataView(memory${memIdx}.buffer)`;

    if (typeof ty === 'string') {
      switch (ty) {
        case 'bool':
          return `!!${dv}.getUint8(${offExpr})`;
        case 'u8':
          return `${dv}.getUint8(${offExpr})`;
        case 's8':
          return `${dv}.getInt8(${offExpr})`;
        case 'u16':
          return `${dv}.getUint16(${offExpr}, true)`;
        case 's16':
          return `${dv}.getInt16(${offExpr}, true)`;
        case 'u32': case 'char':
          return `${dv}.getUint32(${offExpr}, true)`;
        case 's32':
          return `${dv}.getInt32(${offExpr}, true)`;
        case 'u64':
          return `${dv}.getBigUint64(${offExpr}, true)`;
        case 's64':
          return `${dv}.getBigInt64(${offExpr}, true)`;
        case 'f32':
          return `${dv}.getFloat32(${offExpr}, true)`;
        case 'f64':
          return `${dv}.getFloat64(${offExpr}, true)`;
        case 'string': {
          const pv = `_sp${id}`;
          const lv = `_sl${id}`;
          this.line(`${indent}const ${pv} = ${dv}.getInt32(${offExpr}, true);`);
          this.line(`${indent}const ${lv} = ${dv}.getInt32((${offExpr}) + 4, true);`);
          return `new TextDecoder().decode(new Uint8Array(memory${memIdx}.buffer, ${pv}, ${lv}))`;
        }
        case 'own': case 'borrow':
        case 'stream': case 'future':
          return `${dv}.getInt32(${offExpr}, true)`;
      }
    }

    if (typeof ty === 'object') {
      switch (ty.tag) {
        case 'own': case 'borrow':
        case 'stream': case 'future':
          return `${dv}.getInt32(${offExpr}, true)`;

        case 'list': {
          if (ty.elem === 'u8') {
            const pv = `_lp${id}`;
            const lv = `_ll${id}`;
            this.line(`${indent}const ${pv} = ${dv}.getInt32(${offExpr}, true);`);
            this.line(`${indent}const ${lv} = ${dv}.getInt32((${offExpr}) + 4, true);`);
            return `new Uint8Array(memory${memIdx}.buffer.slice(${pv}, ${pv} + ${lv}))`;
          }
          const vn = `_nl${id}`;
          const pv = `_lp${id}`;
          const lv = `_ll${id}`;
          this.line(`${indent}const ${pv} = ${dv}.getInt32(${offExpr}, true);`);
          this.line(`${indent}const ${lv} = ${dv}.getInt32((${offExpr}) + 4, true);`);
          this.genLiftListFromMemory(ty, memIdx, pv, lv, vn, indent);
          return vn;
        }

        case 'tuple': {
          const parts: string[] = [];
          let elemOff = 0;
          for (let e = 0; e < ty.elems.length; e++) {
            const eType = ty.elems[e]!;
            const align = hostValTypeAlignment(eType);
            elemOff = (elemOff + align - 1) & ~(align - 1);
            const expr = this.genLiftElemFromMemory(eType, memIdx, `(${offExpr}) + ${elemOff}`, indent);
            parts.push(expr);
            elemOff += hostValTypeByteSize(eType);
          }
          return `[${parts.join(', ')}]`;
        }

        case 'record': {
          const parts: string[] = [];
          let fieldOff = 0;
          for (const field of ty.fields) {
            const align = hostValTypeAlignment(field.type);
            fieldOff = (fieldOff + align - 1) & ~(align - 1);
            const expr = this.genLiftElemFromMemory(field.type, memIdx, `(${offExpr}) + ${fieldOff}`, indent);
            const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(field.name) ? field.name : `'${field.name}'`;
            parts.push(`${key}: ${expr}`);
            fieldOff += hostValTypeByteSize(field.type);
          }
          return `{${parts.join(', ')}}`;
        }

        case 'option': {
          const discSize = 1;
          const innerAlign = hostValTypeAlignment(ty.inner);
          const payloadOff = Math.max(discSize, innerAlign);
          const innerExpr = this.genLiftElemFromMemory(ty.inner, memIdx, `(${offExpr}) + ${payloadOff}`, indent);
          return `(${dv}.getUint8(${offExpr}) === 0 ? null : ${innerExpr})`;
        }

        case 'variant': {
          const n = ty.cases.length;
          const discSize = n <= 256 ? 1 : n <= 65536 ? 2 : 4;
          const caseAligns = ty.cases.map(c => c.type ? hostValTypeAlignment(c.type) : 1);
          const payloadAlign = Math.max(1, ...caseAligns);
          const payloadOff = Math.max(discSize, payloadAlign);
          const discExpr = discSize === 1
            ? `${dv}.getUint8(${offExpr})`
            : discSize === 2
              ? `${dv}.getUint16(${offExpr}, true)`
              : `${dv}.getUint32(${offExpr}, true)`;
          const dVar = `_vd${id}`;
          this.line(`${indent}const ${dVar} = ${discExpr};`);
          const caseParts = ty.cases.map((c, ci) => {
            if (c.type === null) {
              return `${dVar} === ${ci} ? {tag: '${c.name}'${this.ts(' as const')}}`;
            }
            const cExpr = this.genLiftElemFromMemory(c.type, memIdx, `(${offExpr}) + ${payloadOff}`, indent);
            return `${dVar} === ${ci} ? {tag: '${c.name}'${this.ts(' as const')}, val: ${cExpr}}`;
          });
          return `(${caseParts.join(' : ')} : null${this.ts(' as never')})`;
        }

        case 'enum': {
          const namesArr = `[${ty.names.map(n => `'${n}'`).join(',')}]`;
          if (ty.names.length <= 256) {
            return `${namesArr}[${dv}.getUint8(${offExpr})]`;
          }
          return `${namesArr}[${dv}.getInt32(${offExpr}, true)]`;
        }

        case 'flags': {
          if (ty.count <= 8) return `${dv}.getUint8(${offExpr})`;
          if (ty.count <= 16) return `${dv}.getUint16(${offExpr}, true)`;
          return `${dv}.getInt32(${offExpr}, true)`;
        }

        case 'result': {
          const discExpr = `${dv}.getUint8(${offExpr})`;
          const okAlign = ty.ok ? hostValTypeAlignment(ty.ok) : 1;
          const errAlign = ty.err ? hostValTypeAlignment(ty.err) : 1;
          const payloadOff = Math.max(1, Math.max(okAlign, errAlign));
          const okExpr = ty.ok ? this.genLiftElemFromMemory(ty.ok, memIdx, `(${offExpr}) + ${payloadOff}`, indent) : null;
          const errExpr = ty.err ? this.genLiftElemFromMemory(ty.err, memIdx, `(${offExpr}) + ${payloadOff}`, indent) : null;
          const okPart = okExpr ? `{tag: 'ok'${this.ts(' as const')}, val: ${okExpr}}` : `{tag: 'ok'${this.ts(' as const')}}`;
          const errPart = errExpr ? `{tag: 'err'${this.ts(' as const')}, val: ${errExpr}}` : `{tag: 'err'${this.ts(' as const')}}`;
          return `(${discExpr} === 0 ? ${okPart} : ${errPart})`;
        }
      }
    }

    return `${dv}.getInt32(${offExpr}, true)`;
  }

  /** Generate a lifting expression for a single component-level parameter. */
  /**
   * Lift a type from arbitrary flat param expressions.
   * `flatExprs` are the JS expression strings for each flat value.
   */
  private genLiftFromFlat(ty: HostValType, flatExprs: string[], memIdx: number | null): string {
    if (typeof ty === 'string') {
      switch (ty) {
        case 'bool': return `(${flatExprs[0]} !== 0)`;
        case 'string':
          return `new TextDecoder().decode(new Uint8Array(memory${memIdx}.buffer, ${flatExprs[0]}${this.ts(' as number')}, ${flatExprs[1]}${this.ts(' as number')}))`;
        default: return flatExprs[0]!;
      }
    }
    if (typeof ty === 'object') {
      if (ty.tag === 'enum') {
        const mapExpr = ty.names.map((n: string, i: number) => `${i}:'${n}'`).join(',');
        return `({${mapExpr}}${this.ts(' as Record<number,string>')})[${flatExprs[0]}${this.ts(' as number')}]`;
      }
      if (ty.tag === 'variant') {
        const caseParts: string[] = [];
        for (let ci = 0; ci < ty.cases.length; ci++) {
          const c = ty.cases[ci]!;
          if (c.type === null) {
            caseParts.push(`${flatExprs[0]} === ${ci} ? {tag: '${c.name}'${this.ts(' as const')}}`);
          } else {
            const caseFlat = flattenHostValType(c.type);
            const innerExprs = flatExprs.slice(1, 1 + caseFlat.length);
            const valExpr = this.genLiftFromFlat(c.type, innerExprs, memIdx);
            caseParts.push(`${flatExprs[0]} === ${ci} ? {tag: '${c.name}'${this.ts(' as const')}, val: ${valExpr}}`);
          }
        }
        caseParts.push(`{tag: 'unknown'}${this.ts(' as any')}`);
        return `(${caseParts.join(' : ')})`;
      }
      if (ty.tag === 'record') {
        const parts: string[] = [];
        let fi = 0;
        for (const field of ty.fields) {
          const fFlat = flattenHostValType(field.type);
          const fieldExprs = flatExprs.slice(fi, fi + fFlat.length);
          parts.push(`'${field.name}': ${this.genLiftFromFlat(field.type, fieldExprs, memIdx)}`);
          fi += fFlat.length;
        }
        return `({${parts.join(', ')}})`;
      }
      if (ty.tag === 'tuple') {
        const parts: string[] = [];
        let fi = 0;
        for (const e of ty.elems) {
          const eFlat = flattenHostValType(e);
          parts.push(this.genLiftFromFlat(e, flatExprs.slice(fi, fi + eFlat.length), memIdx));
          fi += eFlat.length;
        }
        return `[${parts.join(', ')}]`;
      }
      if (ty.tag === 'option') {
        const innerFlat = flattenHostValType(ty.inner);
        const innerExprs = flatExprs.slice(1, 1 + innerFlat.length);
        const innerExpr = innerFlat.length === 0 ? 'true' : this.genLiftFromFlat(ty.inner, innerExprs, memIdx);
        return `(${flatExprs[0]} === 0 ? null : ${innerExpr})`;
      }
      if (ty.tag === 'result') {
        const okFlat = ty.ok ? flattenHostValType(ty.ok) : [];
        const errFlat = ty.err ? flattenHostValType(ty.err) : [];
        const payloadLen = Math.max(okFlat.length, errFlat.length);
        if (payloadLen === 0) {
          return `(${flatExprs[0]} === 0 ? {tag: 'ok'${this.ts(' as const')}} : {tag: 'err'${this.ts(' as const')}})`;
        }
        const okExpr = okFlat.length > 0 ? `, val: ${this.genLiftFromFlat(ty.ok!, flatExprs.slice(1, 1 + okFlat.length), memIdx)}` : '';
        const errExpr = errFlat.length > 0 ? `, val: ${this.genLiftFromFlat(ty.err!, flatExprs.slice(1, 1 + errFlat.length), memIdx)}` : '';
        return `(${flatExprs[0]} === 0 ? {tag: 'ok'${this.ts(' as const')}${okExpr}} : {tag: 'err'${this.ts(' as const')}${errExpr}})`;
      }
      if (ty.tag === 'list' && ty.elem === 'u8') {
        return `new Uint8Array(memory${memIdx}.buffer.slice(${flatExprs[0]}${this.ts(' as number')}, (${flatExprs[0]}${this.ts(' as number')}) + (${flatExprs[1]}${this.ts(' as number')})))`;
      }
      if (ty.tag === 'borrow') {
        return `state${this.currentStateIdx}.getResourceHandle(${flatExprs[0]}${this.ts(' as number')}).rep`;
      }
      // stream, future, own, list: pass through
      return flatExprs[0]!;
    }
    return flatExprs[0]!;
  }

  private genLiftParam(ty: HostValType, paramIdx: number, flatIdx: number, memIdx: number | null): string {
    if (typeof ty === 'string') {
      switch (ty) {
        case 'bool':
          return `(p${paramIdx} !== 0)`;
        case 'u8': case 's8':
        case 'u16': case 's16':
        case 'u32': case 's32':
        case 'char':
        case 'u64': case 's64':
        case 'f32': case 'f64':
        case 'own': case 'borrow':
        case 'stream': case 'future':
          return `p${paramIdx}`;
        case 'string':
          return `new TextDecoder().decode(new Uint8Array(memory${memIdx}.buffer, p${paramIdx}_0${this.ts(' as number')}, p${paramIdx}_1${this.ts(' as number')}))`;
      }
    }
    if (typeof ty === 'object' && ty.tag === 'list' && ty.elem === 'u8') {
      return `new Uint8Array(memory${memIdx}.buffer.slice(p${paramIdx}_0${this.ts(' as number')}, (p${paramIdx}_0${this.ts(' as number')}) + (p${paramIdx}_1${this.ts(' as number')})))`;
    }
    if (typeof ty === 'object' && ty.tag === 'list') {
      // Generic list: read elements from memory
      const varName = `_list${paramIdx}`;
      this.genLiftListFromMemory(ty, memIdx!, `p${paramIdx}_0${this.ts(' as number')}`, `p${paramIdx}_1${this.ts(' as number')}`, varName, '    ');
      return varName;
    }
    if (typeof ty === 'object' && ty.tag === 'option') {
      const innerFlat = flattenHostValType(ty.inner);
      const innerExprs = Array.from({ length: innerFlat.length }, (_, i) => `p${paramIdx}_${i + 1}`);
      const innerExpr = innerFlat.length === 0
        ? 'true'
        : innerFlat.length === 1 && ty.inner !== 'bool' && ty.inner !== 'string'
          && !(typeof ty.inner === 'object' && ty.inner.tag === 'enum')
          ? `p${paramIdx}_1`
          : this.genLiftFromFlat(ty.inner, innerExprs, memIdx);
      return `(p${paramIdx}_0 === 0 ? null : ${innerExpr})`;
    }
    if (typeof ty === 'object' && ty.tag === 'result') {
      const okFlat = ty.ok ? flattenHostValType(ty.ok) : [];
      const errFlat = ty.err ? flattenHostValType(ty.err) : [];
      const payloadLen = Math.max(okFlat.length, errFlat.length);
      if (payloadLen === 0) {
        // flat length is 1 (just discriminant), so param is p${paramIdx} not p${paramIdx}_0
        return `(p${paramIdx} === 0 ? { tag: 'ok'${this.ts(' as const')} } : { tag: 'err'${this.ts(' as const')} })`;
      }
      const valExpr = payloadLen === 1 ? `p${paramIdx}_1` : `[${Array.from({ length: payloadLen }, (_, i) => `p${paramIdx}_${i + 1}`).join(', ')}]`;
      return `(p${paramIdx}_0 === 0 ? { tag: 'ok'${this.ts(' as const')}, val: ${valExpr} } : { tag: 'err'${this.ts(' as const')}, val: ${valExpr} })`;
    }
    if (typeof ty === 'object' && ty.tag === 'record') {
      const flat = flattenHostValType(ty);
      if (flat.length <= 1) return `p${paramIdx}`;
      // Build named object from flat params
      const parts: string[] = [];
      let fi = 0;
      for (const field of ty.fields) {
        const fieldFlat = flattenHostValType(field.type);
        const fieldVal = fieldFlat.length === 1
          ? `p${paramIdx}_${fi}`
          : `[${Array.from({ length: fieldFlat.length }, (_, j) => `p${paramIdx}_${fi + j}`).join(', ')}]`;
        parts.push(`'${field.name}': ${fieldVal}`);
        fi += fieldFlat.length;
      }
      return `({${parts.join(', ')}})`;
    }
    if (typeof ty === 'object' && ty.tag === 'tuple') {
      const flat = flattenHostValType(ty);
      if (flat.length <= 1) return `p${paramIdx}`;
      const parts = Array.from({ length: flat.length }, (_, i) => `p${paramIdx}_${i}`);
      return `[${parts.join(', ')}]`;
    }
    if (typeof ty === 'object' && ty.tag === 'variant') {
      // Reconstruct variant as {tag, val} object from flat params
      const flat = flattenHostValType(ty);
      const discVar = flat.length === 1 ? `p${paramIdx}` : `p${paramIdx}_0`;
      const flatExprs = flat.length === 1
        ? [`p${paramIdx}`]
        : Array.from({ length: flat.length }, (_, i) => `p${paramIdx}_${i}`);
      return this.genLiftFromFlat(ty, flatExprs, memIdx);
    }
    // stream/future with element type: pass handle through (same as string form)
    if (typeof ty === 'object' && (ty.tag === 'stream' || ty.tag === 'future')) {
      return `p${paramIdx}`;
    }
    // borrow with tableIdx: convert handle index to rep for host function
    if (typeof ty === 'object' && ty.tag === 'borrow') {
      return `state${this.currentStateIdx}.getResourceHandle(p${paramIdx}${this.ts(' as number')}).rep`;
    }
    // own with tableIdx: convert handle index to rep for host function
    if (typeof ty === 'object' && ty.tag === 'own') {
      return `state${this.currentStateIdx}.getResourceHandle(p${paramIdx}${this.ts(' as number')}).rep`;
    }
    // enum: map discriminant to string name
    if (typeof ty === 'object' && ty.tag === 'enum') {
      const namesArray = `([${ty.names.map(n => `'${n}'`).join(',')}]${this.ts(' as const')})`;
      return `${namesArray}[p${paramIdx}${this.ts(' as number')}]`;
    }
    // flags and other single-flat types
    // Safety: if this type has multiple flat params, we can't just reference p${paramIdx}
    // because the params were split into p${paramIdx}_0, p${paramIdx}_1, etc.
    const flat = flattenHostValType(ty);
    if (flat.length > 1) {
      const parts = Array.from({ length: flat.length }, (_, i) => `p${paramIdx}_${i}`);
      return `[${parts.join(', ')}]`;
    }
    return `p${paramIdx}`;
  }

  /** Generate code to store a JS result value to memory at a given pointer.
   *  When typed=true, valExpr is already properly typed (no casts needed for field/element access). */
  private genStoreResult(
    ty: HostValType, memIdx: number, reallocExpr: string,
    ptrExpr: string, valExpr: string, offset: number,
    typed = false,
  ): void {
    if (typeof ty === 'string') {
      switch (ty) {
        case 'bool': case 'u8':
          this.line(`    new DataView(memory${memIdx}.buffer).setUint8(${ptrExpr} + ${offset}, ${valExpr}${this.ts(' as number')});`);
          return;
        case 's8':
          this.line(`    new DataView(memory${memIdx}.buffer).setInt8(${ptrExpr} + ${offset}, ${valExpr}${this.ts(' as number')});`);
          return;
        case 'u16':
          this.line(`    new DataView(memory${memIdx}.buffer).setUint16(${ptrExpr} + ${offset}, ${valExpr}${this.ts(' as number')}, true);`);
          return;
        case 's16':
          this.line(`    new DataView(memory${memIdx}.buffer).setInt16(${ptrExpr} + ${offset}, ${valExpr}${this.ts(' as number')}, true);`);
          return;
        case 'u32': case 's32': case 'char':
        case 'own': case 'borrow':
        case 'stream': case 'future':
          this.line(`    new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, ${valExpr}${this.ts(' as number')}, true);`);
          return;
        case 'f32':
          this.line(`    new DataView(memory${memIdx}.buffer).setFloat32(${ptrExpr} + ${offset}, ${valExpr}${this.ts(' as number')}, true);`);
          return;
        case 'u64': case 's64':
          this.line(`    new DataView(memory${memIdx}.buffer).setBigInt64(${ptrExpr} + ${offset}, ${valExpr}${this.ts(' as bigint')}, true);`);
          return;
        case 'f64':
          this.line(`    new DataView(memory${memIdx}.buffer).setFloat64(${ptrExpr} + ${offset}, ${valExpr}${this.ts(' as number')}, true);`);
          return;
        case 'string': {
          const t = this.nextTmpVar++;
          this.line(`    const _enc${t} = new TextEncoder().encode(${valExpr}${this.ts(' as string')});`);
          this.line(`    const _ptr${t} = ${reallocExpr}(0, 0, 1, _enc${t}.length)${this.ts(' as number')};`);
          this.line(`    new Uint8Array(memory${memIdx}.buffer, _ptr${t}, _enc${t}.length).set(_enc${t});`);
          this.line(`    new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, _ptr${t}, true);`);
          this.line(`    new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset + 4}, _enc${t}.length, true);`);
          return;
        }
      }
    }

    switch (ty.tag) {
      case 'list':
        this.genStoreList(ty.elem, memIdx, reallocExpr, ptrExpr, valExpr, offset);
        break;
      case 'record': {
        let elemOffset = offset;
        for (const field of ty.fields) {
          const align = hostValTypeAlignment(field.type);
          elemOffset = (elemOffset + align - 1) & ~(align - 1);
          const elemExpr = typed || this.jsMode
            ? `${valExpr}['${field.name}']`
            : `(${valExpr} as Record<string,unknown>)['${field.name}']`;
          this.genStoreResult(field.type, memIdx, reallocExpr, ptrExpr, elemExpr, elemOffset);
          elemOffset += hostValTypeByteSize(field.type);
        }
        break;
      }
      case 'tuple': {
        let elemOffset = offset;
        for (let i = 0; i < ty.elems.length; i++) {
          const elemTy = ty.elems[i]!;
          const align = hostValTypeAlignment(elemTy);
          elemOffset = (elemOffset + align - 1) & ~(align - 1);
          const elemExpr = typed || this.jsMode ? `${valExpr}[${i}]` : `(${valExpr} as unknown[])[${i}]`;
          this.genStoreResult(elemTy, memIdx, reallocExpr, ptrExpr, elemExpr, elemOffset);
          elemOffset += hostValTypeByteSize(elemTy);
        }
        break;
      }
      case 'option': {
        const innerAlign = hostValTypeAlignment(ty.inner);
        const discSize = 1; // 2 cases → 1 byte
        const payloadOffset = offset + Math.max(discSize, innerAlign);
        this.line(`    if (${valExpr} == null) {`);
        this.line(`      new DataView(memory${memIdx}.buffer).setUint8(${ptrExpr} + ${offset}, 0);`);
        this.line(`    } else {`);
        this.line(`      new DataView(memory${memIdx}.buffer).setUint8(${ptrExpr} + ${offset}, 1);`);
        this.genStoreResult(ty.inner, memIdx, reallocExpr, ptrExpr, valExpr, payloadOffset);
        this.line(`    }`);
        break;
      }
      case 'result': {
        const okAlign = ty.ok ? hostValTypeAlignment(ty.ok) : 1;
        const errAlign = ty.err ? hostValTypeAlignment(ty.err) : 1;
        const discSize = 1; // 2 cases → 1 byte
        const payloadAlign = Math.max(okAlign, errAlign);
        const payloadOffset = offset + Math.max(discSize, payloadAlign);
        const t = this.nextTmpVar++;
        this.line(`    const _rv${t} = ${valExpr}${this.ts(' as { tag: string; val?: unknown }')};`);
        this.line(`    if (_rv${t}.tag === 'ok') {`);
        this.line(`      new DataView(memory${memIdx}.buffer).setUint8(${ptrExpr} + ${offset}, 0);`);
        if (ty.ok) {
          this.genStoreResult(ty.ok, memIdx, reallocExpr, ptrExpr, `_rv${t}.val`, payloadOffset);
        }
        this.line(`    } else {`);
        this.line(`      new DataView(memory${memIdx}.buffer).setUint8(${ptrExpr} + ${offset}, 1);`);
        if (ty.err) {
          this.genStoreResult(ty.err, memIdx, reallocExpr, ptrExpr, `_rv${t}.val`, payloadOffset);
        }
        this.line(`    }`);
        break;
      }
      case 'own': {
        // Host returns rep → register in ComponentState to get handle index
        const stateVar = `state${this.currentStateIdx}`;
        const ownTableIdx = 'tableIdx' in ty ? ty.tableIdx : 0;
        this.line(`    new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, ${stateVar}.resourceNew(${ownTableIdx}, ${valExpr}${this.ts(' as number')}), true);`);
        break;
      }
      case 'borrow':
      case 'stream': case 'future':
        this.line(`    new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, ${valExpr}${this.ts(' as number')}, true);`);
        break;
      case 'enum': {
        // Enum values are string names; generate a name-to-discriminant map
        const t = this.nextTmpVar++;
        const mapEntries = ty.names.map((name, i) => `'${name}':${i}`).join(',');
        this.line(`    const _em${t}${this.ts(': Record<string,number>')} = {${mapEntries}};`);
        const setter = ty.names.length <= 256 ? 'setUint8' : ty.names.length <= 65536 ? 'setUint16' : 'setInt32';
        const le = ty.names.length > 256 ? ', true' : '';
        this.line(`    new DataView(memory${memIdx}.buffer).${setter}(${ptrExpr} + ${offset}, _em${t}[${valExpr}${this.ts(' as string')}]${le});`);
        break;
      }
      case 'flags':
        if (ty.count <= 8) {
          this.line(`    new DataView(memory${memIdx}.buffer).setUint8(${ptrExpr} + ${offset}, ${valExpr}${this.ts(' as number')});`);
        } else if (ty.count <= 16) {
          this.line(`    new DataView(memory${memIdx}.buffer).setUint16(${ptrExpr} + ${offset}, ${valExpr}${this.ts(' as number')}, true);`);
        } else {
          this.line(`    new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, ${valExpr}${this.ts(' as number')}, true);`);
        }
        break;
      case 'variant': {
        // Variant stored as {tag: string, val?: ...} object
        const n = ty.cases.length;
        const discSize = n <= 256 ? 1 : n <= 65536 ? 2 : 4;
        const discSetter = discSize === 1 ? 'setUint8' : discSize === 2 ? 'setUint16' : 'setInt32';
        const discLE = discSize > 1 ? ', true' : '';
        const caseAligns = ty.cases.map(c => c.type ? hostValTypeAlignment(c.type) : 1);
        const payloadAlign = Math.max(1, ...caseAligns);
        const payloadOff = Math.max(discSize, payloadAlign);
        const t = this.nextTmpVar++;
        this.line(`    const _vo${t} = ${valExpr}${this.ts(' as {tag: string; val?: unknown}')};`);
        for (let ci = 0; ci < ty.cases.length; ci++) {
          const c = ty.cases[ci]!;
          const cond = ci === 0 ? 'if' : 'else if';
          this.line(`    ${cond} (_vo${t}.tag === '${c.name}') {`);
          this.line(`      new DataView(memory${memIdx}.buffer).${discSetter}(${ptrExpr} + ${offset}, ${ci}${discLE});`);
          if (c.type) {
            this.genStoreResult(c.type, memIdx, reallocExpr, ptrExpr, `_vo${t}.val`, offset + payloadOff);
          }
          this.line(`    }`);
        }
        break;
      }
    }
  }

  /** Generate code to store a list to memory. */
  private genStoreList(
    elemTy: HostValType, memIdx: number, reallocExpr: string,
    ptrExpr: string, valExpr: string, offset: number,
  ): void {
    const elemSize = hostValTypeByteSize(elemTy);
    const elemAlign = hostValTypeAlignment(elemTy);
    const t = this.nextTmpVar++;

    if (elemTy === 'u8') {
      // Optimized path for list<u8>
      this.line(`    const _arr${t} = ${valExpr}${this.ts(' as Uint8Array')};`);
      this.line(`    const _aptr${t} = ${reallocExpr}(0, 0, ${elemAlign}, _arr${t}.length)${this.ts(' as number')};`);
      this.line(`    new Uint8Array(memory${memIdx}.buffer, _aptr${t}, _arr${t}.length).set(_arr${t});`);
      this.line(`    new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, _aptr${t}, true);`);
      this.line(`    new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset + 4}, _arr${t}.length, true);`);
    } else if (elemTy === 'string') {
      // list<string>
      this.line(`    const _ls${t} = ${valExpr}${this.ts(' as string[]')};`);
      this.line(`    const _lb${t} = ${reallocExpr}(0, 0, ${elemAlign}, _ls${t}.length * ${elemSize})${this.ts(' as number')};`);
      this.line(`    for (let _i${t} = 0; _i${t} < _ls${t}.length; _i${t}++) {`);
      this.line(`      const _se${t} = new TextEncoder().encode(_ls${t}[_i${t}]);`);
      this.line(`      const _sp${t} = ${reallocExpr}(0, 0, 1, _se${t}.length)${this.ts(' as number')};`);
      this.line(`      new Uint8Array(memory${memIdx}.buffer, _sp${t}, _se${t}.length).set(_se${t});`);
      this.line(`      new DataView(memory${memIdx}.buffer).setInt32(_lb${t} + _i${t} * ${elemSize}, _sp${t}, true);`);
      this.line(`      new DataView(memory${memIdx}.buffer).setInt32(_lb${t} + _i${t} * ${elemSize} + 4, _se${t}.length, true);`);
      this.line(`    }`);
      this.line(`    new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, _lb${t}, true);`);
      this.line(`    new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset + 4}, _ls${t}.length, true);`);
    } else {
      // Generic list
      this.line(`    const _gl${t} = ${valExpr}${this.ts(' as unknown[]')};`);
      this.line(`    const _gb${t} = ${reallocExpr}(0, 0, ${elemAlign}, _gl${t}.length * ${elemSize})${this.ts(' as number')};`);
      this.line(`    for (let _i${t} = 0; _i${t} < _gl${t}.length; _i${t}++) {`);
      this.genStoreResult(elemTy, memIdx, reallocExpr, `_gb${t} + _i${t} * ${elemSize}`, `_gl${t}[_i${t}]`, 0);
      this.line(`    }`);
      this.line(`    new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, _gb${t}, true);`);
      this.line(`    new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset + 4}, _gl${t}.length, true);`);
    }
  }

  private emitAsyncAdapterTrampoline(idx: number, t: Trampoline & { tag: 'asyncAdapter' }): void {
    // Build callee expression
    let calleeExpr: string;
    if (t.callee.tag === 'coreExport') {
      calleeExpr = `instance${t.callee.runtimeInstanceIdx}.exports['${t.callee.exportName}']${this.ts(' as Function')}`;
    } else {
      calleeExpr = `trampoline${t.callee.trampolineIdx}`;
    }

    // Wrap callee with promising() when the callee's component has suspending
    // (JSPI) imports. This is needed even for async→async calls when the
    // callee internally blocks via JSPI (e.g., sync-lowering an async import).
    // Only core exports (wasm functions) need promising; trampolines are JS functions.
    if (t.calleeNeedsJSPI && t.callee.tag === 'coreExport') {
      calleeExpr = `promising(${calleeExpr})`;
    }

    // Build callback expression
    const callbackExpr = t.calleeCallbackIdx !== null
      ? `callback_${t.calleeCallbackIdx}`
      : 'null';

    // Build prepareCall args
    const startFnExpr = this.emitStartFnExpr(t.startFn);
    const returnFnExpr = this.emitReturnFnExpr(t.returnFn);
    const calleeAsyncFlag = t.calleeIsAsync ? 1 : 0;

    if (t.callerIsAsync) {
      // Async caller → asyncStartCall (no suspending wrapper)
      this.line(`const trampoline${idx} = (...args${this.ts(': unknown[]')})${this.ts(': number')} => {`);
      this.line(`    _callCtx.prepareCall(${startFnExpr}, ${returnFnExpr}, ${t.callerStateIdx}, ${t.calleeStateIdx}, 0, ${calleeAsyncFlag}, 0, ${t.resultCountOrAsync}, ...args);`);
      this.line(`    return _callCtx.asyncStartCall(_states, ${callbackExpr}, ${calleeExpr}, 0, 1, 0);`);
      this.line('};');
    } else {
      // Sync caller → syncStartCall with suspending wrapper
      this.line(`const trampoline${idx} = suspending((...args${this.ts(': unknown[]')})${this.ts(': number | Promise<number>')} => {`);
      this.line(`    _callCtx.prepareCall(${startFnExpr}, ${returnFnExpr}, ${t.callerStateIdx}, ${t.calleeStateIdx}, 0, ${calleeAsyncFlag}, 0, ${t.resultCountOrAsync}, ...args);`);
      this.line(`    return _callCtx.syncStartCall(_states, ${callbackExpr}, ${calleeExpr}, 0);`);
      this.line('});');
    }
  }

  private emitStartFnExpr(startFn: StartFn): string {
    if (startFn === null) return 'null';
    if (startFn.tag === 'handleTransfer') {
      const transfers = startFn.transfers.map(t => {
        const k = t.kind;
        switch (k.tag) {
          case 'streamEnd':
            return `{ const end = state${k.fromStateIdx}.removeStreamEnd(${k.tableIdx}, out[${t.paramIdx}]${this.ts(' as number')}); out[${t.paramIdx}] = state${k.toStateIdx}.addStreamEnd(${k.tableIdx}, end); }`;
          case 'futureEnd':
            return `{ const end = state${k.fromStateIdx}.removeFutureEnd(${k.tableIdx}, out[${t.paramIdx}]${this.ts(' as number')}); out[${t.paramIdx}] = state${k.toStateIdx}.addFutureEnd(${k.tableIdx}, end); }`;
          case 'resourceRep':
            return `{ out[${t.paramIdx}] = state${k.fromStateIdx}.getResourceHandle(out[${t.paramIdx}]${this.ts(' as number')}).rep; }`;
          case 'borrowHandle':
            return `{ const h = state${k.fromStateIdx}.getResourceHandle(out[${t.paramIdx}]${this.ts(' as number')}); out[${t.paramIdx}] = state${k.toStateIdx}.addBorrowHandle(h.typeIdx, h.rep); }`;
          case 'ownResource':
            return `{ const h = state${k.fromStateIdx}.removeResourceHandle(out[${t.paramIdx}]${this.ts(' as number')}); out[${t.paramIdx}] = state${k.toStateIdx}.addResourceHandle(h); }`;
          default:
            return '';
        }
      }).filter(s => s).join(' ');
      return `(...flatArgs${this.ts(': unknown[]')})${this.ts(': unknown[]')} => { const out${this.ts(': unknown[]')} = [...flatArgs]; ${transfers} return out; }`;
    }
    if (startFn.tag === 'memoryRead') {
      // Read params from caller memory, optionally realloc into callee memory, write there
      const reads = startFn.reads.map((r, i) =>
        `const p${i} = src.${r.getter}(ptr + ${r.offset}, true);`
      ).join(' ');

      if (startFn.realloc) {
        const re = startFn.realloc;
        const writes = startFn.reads.map((r, i) => {
          const info = this.flatTypeWriteInfo(r.flatType);
          return `dst.${info.setter}(dstPtr + ${r.offset}, p${i} ${info.cast}, true);`;
        }).join(' ');
        return `(ptr${this.ts(': number')})${this.ts(': unknown[]')} => { const src = new DataView(memory${startFn.memoryIdx}.buffer); ${reads} const dstPtr = (instance${re.runtimeInstanceIdx}.exports['${re.exportName}']${this.ts(' as Function')})(0, 0, ${re.alignment}, ${re.byteSize})${this.ts(' as number')}; const dst = new DataView(memory${re.dstMemoryIdx}.buffer); ${writes} return [dstPtr]; }`;
      }
      // Without realloc — just read values, use dv/v0 naming to match reference
      const readsSimple = startFn.reads.map((r, i) =>
        `const v${i} = dv.${r.getter}(ptr + ${r.offset}, true);`
      ).join(' ');
      const vars = startFn.reads.map((_, i) => `v${i}`).join(', ');
      return `(ptr${this.ts(': number')})${this.ts(': unknown[]')} => { const dv = new DataView(memory${startFn.memoryIdx}.buffer); ${readsSimple} return [${vars}]; }`;
    }
    return 'null';
  }

  /**
   * Generate code to load a HostValType from canonical ABI record memory.
   * Uses canonical alignment/size (e.g., flags with ≤8 labels → 1 byte).
   * Emits variable declarations and returns the variable name for the loaded value.
   */
  private genCanonicalLoad(ty: HostValType, memIdx: number, paramIdx: number, offset: number): { varName: string } {
    if (typeof ty === 'string') {
      switch (ty) {
        case 'bool':
          this.line(`    const p${paramIdx} = !!_dv.getUint8(argPtr + ${offset});`);
          return { varName: `p${paramIdx}` };
        case 'u8':
          this.line(`    const p${paramIdx} = _dv.getUint8(argPtr + ${offset});`);
          return { varName: `p${paramIdx}` };
        case 's8':
          this.line(`    const p${paramIdx} = _dv.getInt8(argPtr + ${offset});`);
          return { varName: `p${paramIdx}` };
        case 'u16':
          this.line(`    const p${paramIdx} = _dv.getUint16(argPtr + ${offset}, true);`);
          return { varName: `p${paramIdx}` };
        case 's16':
          this.line(`    const p${paramIdx} = _dv.getInt16(argPtr + ${offset}, true);`);
          return { varName: `p${paramIdx}` };
        case 'u32': case 'char':
          this.line(`    const p${paramIdx} = _dv.getUint32(argPtr + ${offset}, true);`);
          return { varName: `p${paramIdx}` };
        case 's32':
          this.line(`    const p${paramIdx} = _dv.getInt32(argPtr + ${offset}, true);`);
          return { varName: `p${paramIdx}` };
        case 'u64':
          this.line(`    const p${paramIdx} = _dv.getBigUint64(argPtr + ${offset}, true);`);
          return { varName: `p${paramIdx}` };
        case 's64':
          this.line(`    const p${paramIdx} = _dv.getBigInt64(argPtr + ${offset}, true);`);
          return { varName: `p${paramIdx}` };
        case 'f32':
          this.line(`    const p${paramIdx} = _dv.getFloat32(argPtr + ${offset}, true);`);
          return { varName: `p${paramIdx}` };
        case 'f64':
          this.line(`    const p${paramIdx} = _dv.getFloat64(argPtr + ${offset}, true);`);
          return { varName: `p${paramIdx}` };
        case 'string': {
          const ptrVar = `_sp${paramIdx}`;
          const lenVar = `_sl${paramIdx}`;
          this.line(`    const ${ptrVar} = _dv.getInt32(argPtr + ${offset}, true);`);
          this.line(`    const ${lenVar} = _dv.getInt32(argPtr + ${offset + 4}, true);`);
          this.line(`    const p${paramIdx} = new TextDecoder().decode(new Uint8Array(memory${memIdx}.buffer, ${ptrVar}, ${lenVar}));`);
          return { varName: `p${paramIdx}` };
        }
        case 'own': case 'borrow':
          this.line(`    const p${paramIdx} = _dv.getInt32(argPtr + ${offset}, true);`);
          return { varName: `p${paramIdx}` };
        case 'stream': case 'future':
          this.line(`    const p${paramIdx} = _dv.getInt32(argPtr + ${offset}, true);`);
          return { varName: `p${paramIdx}` };
      }
    }

    // Object types
    switch (ty.tag) {
      case 'own':
        this.line(`    const p${paramIdx} = state${this.currentStateIdx}.getResourceHandle(_dv.getInt32(argPtr + ${offset}, true)).rep;`);
        return { varName: `p${paramIdx}` };
      case 'borrow':
        this.line(`    const p${paramIdx} = state${this.currentStateIdx}.getResourceHandle(_dv.getInt32(argPtr + ${offset}, true)).rep;`);
        return { varName: `p${paramIdx}` };
      case 'stream': case 'future':
        this.line(`    const p${paramIdx} = _dv.getInt32(argPtr + ${offset}, true);`);
        return { varName: `p${paramIdx}` };
      case 'list': {
        if (ty.elem === 'u8') {
          const ptrVar = `_lp${paramIdx}`;
          const lenVar = `_ll${paramIdx}`;
          this.line(`    const ${ptrVar} = _dv.getInt32(argPtr + ${offset}, true);`);
          this.line(`    const ${lenVar} = _dv.getInt32(argPtr + ${offset + 4}, true);`);
          this.line(`    const p${paramIdx} = new Uint8Array(memory${memIdx}.buffer.slice(${ptrVar}, ${ptrVar} + ${lenVar}));`);
        } else {
          // Generic list: read ptr + len, then lift elements
          const ptrVar = `_lp${paramIdx}`;
          const lenVar = `_ll${paramIdx}`;
          this.line(`    const ${ptrVar} = _dv.getInt32(argPtr + ${offset}, true);`);
          this.line(`    const ${lenVar} = _dv.getInt32(argPtr + ${offset + 4}, true);`);
          this.genLiftListFromMemory(ty, memIdx, ptrVar, lenVar, `p${paramIdx}`, '    ');
        }
        return { varName: `p${paramIdx}` };
      }
      case 'enum': {
        // Enum: read discriminant and map to string name
        const namesArray = `[${ty.names.map(n => `'${n}'`).join(',')}]`;
        if (ty.names.length <= 256) {
          this.line(`    const p${paramIdx} = ${namesArray}[_dv.getUint8(argPtr + ${offset})];`);
        } else {
          this.line(`    const p${paramIdx} = ${namesArray}[_dv.getInt32(argPtr + ${offset}, true)];`);
        }
        return { varName: `p${paramIdx}` };
      }
      case 'flags': {
        if (ty.count <= 8) {
          this.line(`    const p${paramIdx} = _dv.getUint8(argPtr + ${offset});`);
        } else if (ty.count <= 16) {
          this.line(`    const p${paramIdx} = _dv.getUint16(argPtr + ${offset}, true);`);
        } else {
          this.line(`    const p${paramIdx} = _dv.getInt32(argPtr + ${offset}, true);`);
        }
        return { varName: `p${paramIdx}` };
      }
      case 'option': {
        // Discriminant + payload with canonical layout
        // option has 2 cases → 1 byte discriminant
        const innerAlign = hostValTypeAlignment(ty.inner);
        const discSize = 1;
        const payloadOffset = Math.max(discSize, innerAlign);
        const ot = this.nextTmpVar++;
        this.line(`    const _od${ot} = _dv.getUint8(argPtr + ${offset});`);
        const it = this.nextTmpVar++;
        const innerLoad = this.genCanonicalLoad(ty.inner, memIdx, 9000 + it, offset + payloadOffset);
        this.line(`    const p${paramIdx} = _od${ot} === 0 ? null : ${innerLoad.varName};`);
        return { varName: `p${paramIdx}` };
      }
      case 'result': {
        // result has 2 cases → 1 byte discriminant
        const discSize = 1;
        const okAlign = ty.ok ? hostValTypeAlignment(ty.ok) : 1;
        const errAlign = ty.err ? hostValTypeAlignment(ty.err) : 1;
        const payloadOffset = Math.max(discSize, okAlign, errAlign);
        const rt = this.nextTmpVar++;
        this.line(`    const _rd${rt} = _dv.getUint8(argPtr + ${offset});`);
        if (ty.ok && ty.err) {
          const okt = this.nextTmpVar++;
          const okLoad = this.genCanonicalLoad(ty.ok, memIdx, 9000 + okt, offset + payloadOffset);
          const errt = this.nextTmpVar++;
          const errLoad = this.genCanonicalLoad(ty.err, memIdx, 9000 + errt, offset + payloadOffset);
          this.line(`    const p${paramIdx} = _rd${rt} === 0 ? { tag: 'ok'${this.ts(' as const')}, val: ${okLoad.varName} } : { tag: 'err'${this.ts(' as const')}, val: ${errLoad.varName} };`);
        } else if (ty.ok) {
          const okt = this.nextTmpVar++;
          const okLoad = this.genCanonicalLoad(ty.ok, memIdx, 9000 + okt, offset + payloadOffset);
          this.line(`    const p${paramIdx} = _rd${rt} === 0 ? { tag: 'ok'${this.ts(' as const')}, val: ${okLoad.varName} } : { tag: 'err'${this.ts(' as const')} };`);
        } else if (ty.err) {
          const errt = this.nextTmpVar++;
          const errLoad = this.genCanonicalLoad(ty.err, memIdx, 9000 + errt, offset + payloadOffset);
          this.line(`    const p${paramIdx} = _rd${rt} === 0 ? { tag: 'ok'${this.ts(' as const')} } : { tag: 'err'${this.ts(' as const')}, val: ${errLoad.varName} };`);
        } else {
          this.line(`    const p${paramIdx} = _rd${rt} === 0 ? { tag: 'ok'${this.ts(' as const')} } : { tag: 'err'${this.ts(' as const')} };`);
        }
        return { varName: `p${paramIdx}` };
      }
      case 'record': {
        const parts: string[] = [];
        let elemOffset = 0;
        for (let e = 0; e < ty.fields.length; e++) {
          const field = ty.fields[e]!;
          const eAlign = hostValTypeAlignment(field.type);
          elemOffset = (elemOffset + eAlign - 1) & ~(eAlign - 1);
          const eLoad = this.genCanonicalLoad(field.type, memIdx, paramIdx * 100 + e, offset + elemOffset);
          parts.push(`'${field.name}': ${eLoad.varName}`);
          elemOffset += hostValTypeByteSize(field.type);
        }
        this.line(`    const p${paramIdx} = {${parts.join(', ')}};`);
        return { varName: `p${paramIdx}` };
      }
      case 'tuple': {
        const parts: string[] = [];
        let elemOffset = 0;
        for (let e = 0; e < ty.elems.length; e++) {
          const eType = ty.elems[e]!;
          const eAlign = hostValTypeAlignment(eType);
          elemOffset = (elemOffset + eAlign - 1) & ~(eAlign - 1);
          const eLoad = this.genCanonicalLoad(eType, memIdx, paramIdx * 100 + e, offset + elemOffset);
          parts.push(eLoad.varName);
          elemOffset += hostValTypeByteSize(eType);
        }
        if (!this.jsMode) {
          // Use tuple type annotation so TS doesn't widen to T[]
          const tupleType = `[${ty.elems.map(e => hostValTypeToTS(e)).join(', ')}]`;
          this.line(`    const p${paramIdx}: ${tupleType} = [${parts.join(', ')}];`);
        } else {
          this.line(`    const p${paramIdx} = [${parts.join(', ')}];`);
        }
        return { varName: `p${paramIdx}` };
      }
      case 'variant': {
        // Read discriminant + payload, produce {tag, val} object
        const n = ty.cases.length;
        const discSize = n <= 256 ? 1 : n <= 65536 ? 2 : 4;
        const discReader = discSize === 1 ? 'getUint8' : discSize === 2 ? 'getUint16' : 'getInt32';
        const discLE = discSize > 1 ? ', true' : '';
        const vt = this.nextTmpVar++;
        this.line(`    const _vd${vt} = _dv.${discReader}(argPtr + ${offset}${discLE});`);

        const caseAligns = ty.cases.map(c => c.type ? hostValTypeAlignment(c.type) : 1);
        const payloadAlign = Math.max(1, ...caseAligns);
        const payloadOff = Math.max(discSize, payloadAlign);

        this.line(`    let p${paramIdx}${this.ts(': ' + hostValTypeToTS(ty))};`);
        for (let ci = 0; ci < ty.cases.length; ci++) {
          const c = ty.cases[ci]!;
          const cond = ci === 0 ? `if` : `else if`;
          this.line(`    ${cond} (_vd${vt} === ${ci}) {`);
          if (c.type) {
            const ct = this.nextTmpVar++;
            const caseLoad = this.genCanonicalLoad(c.type, memIdx, 9000 + ct, offset + payloadOff);
            this.line(`        p${paramIdx} = { tag: '${c.name}', val: ${caseLoad.varName} };`);
          } else {
            this.line(`        p${paramIdx} = { tag: '${c.name}' };`);
          }
          this.line(`    }`);
        }
        this.line(`    else { p${paramIdx} = { tag: 'unknown' }${this.ts(' as any')}; }`);
        return { varName: `p${paramIdx}` };
      }
    }

    // Fallback
    this.line(`    const p${paramIdx} = _dv.getInt32(argPtr + ${offset}, true);`);
    return { varName: `p${paramIdx}` };
  }

  /** Read a HostValType from canonical memory layout, appending inline read expressions to parts. */
  private genFlatReadFromMemory(ty: HostValType, ptrExpr: string, offset: number, parts: string[]): void {
    if (typeof ty === 'string') {
      switch (ty) {
        case 'bool': case 'u8':
          parts.push(`_dv.getUint8(${ptrExpr} + ${offset})`); return;
        case 's8':
          parts.push(`_dv.getInt8(${ptrExpr} + ${offset})`); return;
        case 'u16':
          parts.push(`_dv.getUint16(${ptrExpr} + ${offset}, true)`); return;
        case 's16':
          parts.push(`_dv.getInt16(${ptrExpr} + ${offset}, true)`); return;
        case 'u32': case 'char':
          parts.push(`_dv.getUint32(${ptrExpr} + ${offset}, true)`); return;
        case 's32':
          parts.push(`_dv.getInt32(${ptrExpr} + ${offset}, true)`); return;
        case 'u64':
          parts.push(`_dv.getBigUint64(${ptrExpr} + ${offset}, true)`); return;
        case 's64':
          parts.push(`_dv.getBigInt64(${ptrExpr} + ${offset}, true)`); return;
        case 'f32':
          parts.push(`_dv.getFloat32(${ptrExpr} + ${offset}, true)`); return;
        case 'f64':
          parts.push(`_dv.getFloat64(${ptrExpr} + ${offset}, true)`); return;
        case 'own': case 'borrow': case 'stream': case 'future':
          parts.push(`_dv.getInt32(${ptrExpr} + ${offset}, true)`); return;
        case 'string':
          parts.push(`_dv.getInt32(${ptrExpr} + ${offset}, true)`);
          parts.push(`_dv.getInt32(${ptrExpr} + ${offset + 4}, true)`); return;
      }
    }
    if (typeof ty === 'object') {
      if (ty.tag === 'record') {
        let off = 0;
        for (const field of ty.fields) {
          const align = hostValTypeAlignment(field.type);
          off = (off + align - 1) & ~(align - 1);
          this.genFlatReadFromMemory(field.type, ptrExpr, offset + off, parts);
          off += hostValTypeByteSize(field.type);
        }
        return;
      }
      if (ty.tag === 'tuple') {
        let off = 0;
        for (const elem of ty.elems) {
          const align = hostValTypeAlignment(elem);
          off = (off + align - 1) & ~(align - 1);
          this.genFlatReadFromMemory(elem, ptrExpr, offset + off, parts);
          off += hostValTypeByteSize(elem);
        }
        return;
      }
      if (ty.tag === 'option') {
        const discSize = 1;
        const innerAlign = hostValTypeAlignment(ty.inner);
        const payloadOff = Math.max(discSize, innerAlign);
        parts.push(`_dv.getUint8(${ptrExpr} + ${offset})`);
        this.genFlatReadFromMemory(ty.inner, ptrExpr, offset + payloadOff, parts);
        return;
      }
      if (ty.tag === 'enum') {
        const namesArray = `[${ty.names.map(n => `'${n}'`).join(',')}]`;
        parts.push(`${namesArray}[_dv.getInt32(${ptrExpr} + ${offset}, true)]`); return;
      }
      if (ty.tag === 'flags' || ty.tag === 'own' || ty.tag === 'borrow' || ty.tag === 'stream' || ty.tag === 'future') {
        parts.push(`_dv.getInt32(${ptrExpr} + ${offset}, true)`); return;
      }
      if (ty.tag === 'list') {
        parts.push(`_dv.getInt32(${ptrExpr} + ${offset}, true)`);
        parts.push(`_dv.getInt32(${ptrExpr} + ${offset + 4}, true)`); return;
      }
    }
    // Fallback
    parts.push(`_dv.getInt32(${ptrExpr} + ${offset}, true)`);
  }

  /** Write values from a flat array to canonical memory layout (inverse of genFlatReadFromMemory). */
  private genFlatWriteToMemory(
    ty: HostValType, memIdx: number, ptrExpr: string, offset: number,
    arrExpr: string, arrIdx: { v: number },
  ): void {
    if (typeof ty === 'string') {
      switch (ty) {
        case 'bool': case 'u8':
          this.line(`      new DataView(memory${memIdx}.buffer).setUint8(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')});`);
          return;
        case 's8':
          this.line(`      new DataView(memory${memIdx}.buffer).setInt8(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')});`);
          return;
        case 'u16':
          this.line(`      new DataView(memory${memIdx}.buffer).setUint16(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')}, true);`);
          return;
        case 's16':
          this.line(`      new DataView(memory${memIdx}.buffer).setInt16(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')}, true);`);
          return;
        case 'u32': case 'char':
          this.line(`      new DataView(memory${memIdx}.buffer).setUint32(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')}, true);`);
          return;
        case 's32':
          this.line(`      new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')}, true);`);
          return;
        case 'u64': case 's64':
          this.line(`      new DataView(memory${memIdx}.buffer).setBigInt64(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as bigint')}, true);`);
          return;
        case 'f32':
          this.line(`      new DataView(memory${memIdx}.buffer).setFloat32(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')}, true);`);
          return;
        case 'f64':
          this.line(`      new DataView(memory${memIdx}.buffer).setFloat64(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')}, true);`);
          return;
        case 'own': case 'borrow': case 'stream': case 'future':
          this.line(`      new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')}, true);`);
          return;
        case 'string':
          this.line(`      new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')}, true);`);
          this.line(`      new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset + 4}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')}, true);`);
          return;
      }
    }
    if (typeof ty === 'object') {
      if (ty.tag === 'record') {
        let off = 0;
        for (const field of ty.fields) {
          const align = hostValTypeAlignment(field.type);
          off = (off + align - 1) & ~(align - 1);
          this.genFlatWriteToMemory(field.type, memIdx, ptrExpr, offset + off, arrExpr, arrIdx);
          off += hostValTypeByteSize(field.type);
        }
        return;
      }
      if (ty.tag === 'tuple') {
        let off = 0;
        for (const elem of ty.elems) {
          const align = hostValTypeAlignment(elem);
          off = (off + align - 1) & ~(align - 1);
          this.genFlatWriteToMemory(elem, memIdx, ptrExpr, offset + off, arrExpr, arrIdx);
          off += hostValTypeByteSize(elem);
        }
        return;
      }
      if (ty.tag === 'enum') {
        const t = this.nextTmpVar++;
        const mapEntries = ty.names.map((name, i) => `'${name}':${i}`).join(',');
        this.line(`      const _em${t}${this.ts(': Record<string,number>')} = {${mapEntries}};`);
        const setter = ty.names.length <= 256 ? 'setUint8' : ty.names.length <= 65536 ? 'setUint16' : 'setInt32';
        const le = ty.names.length > 256 ? ', true' : '';
        this.line(`      new DataView(memory${memIdx}.buffer).${setter}(${ptrExpr} + ${offset}, _em${t}[${arrExpr}[${arrIdx.v++}]${this.ts(' as string')}]${le});`);
        return;
      }
      if (ty.tag === 'flags' || ty.tag === 'own' || ty.tag === 'borrow' || ty.tag === 'stream' || ty.tag === 'future') {
        this.line(`      new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')}, true);`);
        return;
      }
    }
    // Fallback
    this.line(`      new DataView(memory${memIdx}.buffer).setInt32(${ptrExpr} + ${offset}, ${arrExpr}[${arrIdx.v++}]${this.ts(' as number')}, true);`);
  }

  private flatTypeWriteInfo(flatType: import('./link-types.ts').FlatValType): { setter: string; cast: string } {
    if (this.jsMode) {
      switch (flatType) {
        case 'i32': return { setter: 'setInt32', cast: '' };
        case 'i64': return { setter: 'setBigInt64', cast: '' };
        case 'f32': return { setter: 'setFloat32', cast: '' };
        case 'f64': return { setter: 'setFloat64', cast: '' };
      }
    }
    switch (flatType) {
      case 'i32': return { setter: 'setInt32', cast: 'as number' };
      case 'i64': return { setter: 'setBigInt64', cast: 'as bigint' };
      case 'f32': return { setter: 'setFloat32', cast: 'as number' };
      case 'f64': return { setter: 'setFloat64', cast: 'as number' };
    }
  }

  private emitReturnFnExpr(returnFn: ReturnFn): string {
    if (returnFn === null) return 'null';
    switch (returnFn.tag) {
      case 'typed': {
        if (returnFn.writes.length === 1) {
          const w = returnFn.writes[0]!;
          return `(result${this.ts(': unknown')}, ptr${this.ts(': number')}) => { new DataView(memory${returnFn.memoryIdx}.buffer).${w.setter}(ptr, result${this.ts(' ' + w.cast)}, true); }`;
        }
        // Multi-value writes — use shared DataView
        const writes = returnFn.writes.map(w =>
          `dv.${w.setter}(ptr + ${w.offset}, arr[${w.arrayIdx}]${this.ts(' ' + w.cast)}, true);`
        ).join(' ');
        return `(result${this.ts(': unknown[]')}, ptr${this.ts(': number')}) => { const dv = new DataView(memory${returnFn.memoryIdx}.buffer); const arr = result; ${writes} }`;
      }
      case 'memoryCopy': {
        // Copy from callee memory to caller memory
        const copies = returnFn.copies.map(c =>
          `dst.${c.setter}(ptr + ${c.offset}, src.${c.getter}(srcPtr + ${c.offset}, true)${this.ts(' ' + c.cast)}, true);`
        ).join(' ');
        // When callee is async, result is an array (task.return wraps it)
        const ptrExpr = returnFn.resultIsArray
          ? `const srcPtr = (result${this.ts(' as unknown[]')})[0]${this.ts(' as number')};`
          : `const srcPtr = result${this.ts(' as number')};`;
        return `(result${this.ts(': unknown')}, ptr${this.ts(': number')}) => { ${ptrExpr} const src = new DataView(memory${returnFn.srcMemoryIdx}.buffer); const dst = new DataView(memory${returnFn.dstMemoryIdx}.buffer); ${copies} }`;
      }
      case 'streamTransfer':
        return `(result${this.ts(': number')}) => { const end = state${returnFn.fromStateIdx}.removeStreamEnd(${returnFn.tableIdx}, result); return state${returnFn.toStateIdx}.addStreamEnd(${returnFn.tableIdx}, end);  }`;
      case 'futureTransfer':
        return `(result${this.ts(': number')}) => { const end = state${returnFn.fromStateIdx}.removeFutureEnd(${returnFn.tableIdx}, result); return state${returnFn.toStateIdx}.addFutureEnd(${returnFn.tableIdx}, end);  }`;
      case 'resourceTransfer':
        return `(result${this.ts(': number')}) => { const h = state${returnFn.fromStateIdx}.removeResourceHandle(result); return state${returnFn.toStateIdx}.addResourceHandle(h);  }`;
      case 'typedWithTransfer': {
        // Combined: first do the transfer (stream/future end migration), then write to memory
        let transferCode = '';
        if (returnFn.preTransfer && returnFn.preTransfer.tag === 'streamTransfer') {
          const t = returnFn.preTransfer;
          transferCode = `const end = state${t.fromStateIdx}.removeStreamEnd(${t.tableIdx}, result${this.ts(' as number')}); result = state${t.toStateIdx}.addStreamEnd(${t.tableIdx}, end); `;
        } else if (returnFn.preTransfer && returnFn.preTransfer.tag === 'futureTransfer') {
          const t = returnFn.preTransfer;
          transferCode = `const end = state${t.fromStateIdx}.removeFutureEnd(${t.tableIdx}, result${this.ts(' as number')}); result = state${t.toStateIdx}.addFutureEnd(${t.tableIdx}, end); `;
        }
        if (returnFn.writes.length === 1) {
          const w = returnFn.writes[0]!;
          return `(result${this.ts(': unknown')}, ptr${this.ts(': number')}) => { ${transferCode}new DataView(memory${returnFn.memoryIdx}.buffer).${w.setter}(ptr, result${this.ts(' ' + w.cast)}, true); }`;
        }
        const writes = returnFn.writes.map(w =>
          `dv.${w.setter}(ptr + ${w.offset}, arr[${w.arrayIdx}]${this.ts(' ' + w.cast)}, true);`
        ).join(' ');
        return `(result${this.ts(': unknown[]')}, ptr${this.ts(': number')}) => { ${transferCode}const dv = new DataView(memory${returnFn.memoryIdx}.buffer); const arr = result; ${writes} }`;
      }
      default:
        return 'null';
    }
  }

  // -------------------------------------------------------------------
  // Module declarations
  // -------------------------------------------------------------------

  private emitModuleDeclarations(): void {
    this.line('');
    for (const m of this.linked.modules) {
      const suffix = m.moduleIdx === 0 ? '' : `${m.moduleIdx + 1}`;
      const fileName = `${this.name}.core${suffix}.wasm`;
      if (this.standaloneMode) {
        this.line(`const module${m.moduleIdx} = await __loadCoreModule('${fileName}');`);
      } else {
        this.line(`const module${m.moduleIdx}${this.ts(': CoreModule')} = getCoreModule('${fileName}');`);
      }
    }
  }

  // -------------------------------------------------------------------
  // Instance declarations
  // -------------------------------------------------------------------

  private emitInstanceDeclarations(): void {
    for (let i = 0; i < this.instanceCount; i++) {
      this.line(`let instance${i}${this.ts(': WebAssembly.Instance')};`);
    }
  }

  // -------------------------------------------------------------------
  // Core instantiations
  // -------------------------------------------------------------------

  private emitInstantiations(): void {
    this.line('');
    for (const inst of this.linked.instances) {
      this.emitInstantiation(inst);
    }
  }

  private emitInstantiation(inst: import('./link-types.ts').LinkedInstance): void {
    if (inst.imports.length === 0) {
      this.line(`instance${inst.runtimeIdx} = await instantiateCore(module${inst.moduleIdx}, {`);
      this.line('});');
      return;
    }

    this.line(`instance${inst.runtimeIdx} = await instantiateCore(module${inst.moduleIdx}, {`);

    for (const [nsName, nsBinding] of inst.imports) {
      if (!Array.isArray(nsBinding)) {
        // InstanceExports — pass whole exports object
        const binding = nsBinding as ImportBinding & { tag: 'instanceExports' };
        this.line(`    '${nsName}': instance${binding.runtimeInstanceIdx}.exports,`);
      } else {
        // Expanded bindings
        this.line(`    '${nsName}': {`);
        for (const [importName, binding] of nsBinding) {
          const value = this.emitBindingValue(binding);
          this.line(`        '${importName}': ${value},`);
        }
        this.line('    },');
      }
    }

    this.line('});');
  }

  private emitBindingValue(binding: ImportBinding): string {
    switch (binding.tag) {
      case 'trampoline':
        return `trampoline${binding.idx}`;
      case 'coreExport':
        return `instance${binding.runtimeInstanceIdx}.exports['${binding.name}']${this.ts('!')}`;
      case 'instanceExports':
        return `instance${binding.runtimeInstanceIdx}.exports`;
    }
  }

  // -------------------------------------------------------------------
  // Memory extractions
  // -------------------------------------------------------------------

  private emitMemoryExtractions(): void {
    if (this.linked.memories.length === 0) return;
    this.line('');

    for (const mem of this.linked.memories) {
      this.line(`memory${mem.memoryIdx} = instance${mem.runtimeInstanceIdx}.exports['${mem.exportName}']${this.ts(' as WebAssembly.Memory')};`);
    }
  }

  // -------------------------------------------------------------------
  // Callback extractions
  // -------------------------------------------------------------------

  private emitCallbackExtractions(): void {
    if (this.linked.callbacks.length === 0) return;

    for (const cb of this.linked.callbacks) {
      this.line(`callback_${cb.callbackIdx} = instance${cb.runtimeInstanceIdx}.exports['${cb.exportName}']${this.ts(' as CallbackFn')};`);
    }
  }

  // -------------------------------------------------------------------
  // Export functions
  // -------------------------------------------------------------------

  private emitExportFunctions(): void {
    this.line('');
    for (const [, funcMap] of this.linked.exports) {
      for (const [, funcInfo] of funcMap) {
        const jsName = this.sanitizeName(funcInfo.name);
        if (funcInfo.liftInfo && this.needsExportWrapper(funcInfo.liftInfo)) {
          this.emitTypedExportFunction(jsName, funcInfo);
        } else if (funcInfo.isAsync) {
          const callbackExpr = funcInfo.callbackIdx >= 0
            ? `callback_${funcInfo.callbackIdx}`
            : 'undefined';
          let expr = `state${funcInfo.stateIdx}.runAsyncExport(instance${funcInfo.runtimeInstanceIdx}.exports['${funcInfo.coreExportName}']${this.ts(' as Function')}, ${callbackExpr}, _eventLoop, args)`;
          // Add .then() chain for future/stream result lifting
          if (funcInfo.liftResult) {
            const stateVar = `state${funcInfo.stateIdx}`;
            if (funcInfo.liftResult.tag === 'liftFutureEnd') {
              expr += `.then(r => { ${stateVar}.liftFutureEnd(${funcInfo.liftResult.tableIdx}, r${this.ts(' as number')}); return r; })`;
            } else if (funcInfo.liftResult.tag === 'liftStreamEnd') {
              expr += `.then(r => { ${stateVar}.liftStreamEnd(${funcInfo.liftResult.tableIdx}, r${this.ts(' as number')}); return r; })`;
            }
          }
          this.line(`const ${jsName} = (...args${this.ts(': unknown[]')})${this.ts(': Promise<unknown>')} => ${expr};`);
        } else {
          this.line(`const ${jsName} = (...args${this.ts(': unknown[]')})${this.ts(': unknown | Promise<unknown>')} => state${funcInfo.stateIdx}.runSyncExport(instance${funcInfo.runtimeInstanceIdx}.exports['${funcInfo.coreExportName}']${this.ts(' as Function')}, args);`);
        }
      }
    }
  }

  /** Check if an export needs a typed wrapper (has non-trivial param/result types). */
  private needsExportWrapper(info: ExportLiftInfo): boolean {
    // Need wrapper if any param is not a single flat primitive, or result needs lifting
    for (const pt of info.paramTypes) {
      if (typeof pt !== 'string' || pt === 'string' || pt === 'bool') return true;
      const flat = flattenHostValType(pt);
      if (flat.length !== 1) return true;
    }
    if (info.resultType !== null) {
      if (typeof info.resultType !== 'string') return true;
      if (info.resultType === 'string' || info.resultType === 'bool') return true;
      if (info.resultFlatTypes.length > 1) return true;
    }
    return false;
  }

  /** Emit a typed export function with canonical ABI lowering/lifting. */
  private emitTypedExportFunction(jsName: string, funcInfo: import('./link-types.ts').ExportedFunc): void {
    this.nextTmpVar = 0;
    this.currentStateIdx = funcInfo.stateIdx;
    const info = funcInfo.liftInfo!;
    const memIdx = info.memoryIdx;
    const reallocExpr = info.realloc
      ? `(instance${info.realloc.runtimeInstanceIdx}.exports['${info.realloc.exportName}']${this.ts(' as Function')})`
      : 'null';

    // Build parameter list
    const paramNames = info.paramTypes.map((_, i) => `p${i}`);
    const paramList = paramNames.map(n => `${n}${this.ts(': unknown')}`).join(', ');

    // For canon lift: if result flattens to > 1, the core function returns
    // a SINGLE pointer to the result area (not a caller-passed retptr).
    const resultViaPtr = info.resultFlatTypes.length > 1;
    // Determine if params need spilling (flat count > MAX_FLAT_PARAMS=16)
    const totalParamFlat = info.paramFlatTypes.length;
    const spillParams = totalParamFlat > 16;

    if (funcInfo.isAsync) {
      this.line(`const ${jsName} = async (${paramList})${this.ts(': Promise<unknown>')} => {`);
    } else {
      this.line(`const ${jsName} = (${paramList})${this.ts(': unknown | Promise<unknown>')} => {`);
    }
    this.pushIndent();

    // Lower params to flat core args
    const flatArgs: string[] = [];

    if (spillParams && memIdx !== null) {
      // Spill all params to memory as a record
      const totalSize = hostValTypeByteSize({ tag: 'record', fields: info.paramTypes.map((t, i) => ({ name: `p${i}`, type: t })) });
      const totalAlign = Math.max(1, ...info.paramTypes.map(t => hostValTypeAlignment(t)));
      this.line(`const _argPtr = ${reallocExpr}(0, 0, ${totalAlign}, ${totalSize})${this.ts(' as number')};`);
      let offset = 0;
      for (let i = 0; i < info.paramTypes.length; i++) {
        const pt = info.paramTypes[i]!;
        const align = hostValTypeAlignment(pt);
        offset = (offset + align - 1) & ~(align - 1);
        this.genStoreResult(pt, memIdx, reallocExpr, '_argPtr', `p${i}`, offset);
        offset += hostValTypeByteSize(pt);
      }
      flatArgs.push('_argPtr');
    } else {
      // Pass params as individual flat values
      for (let i = 0; i < info.paramTypes.length; i++) {
        const pt = info.paramTypes[i]!;
        const lowered = this.genLowerExportParam(pt, `p${i}`, memIdx, reallocExpr);
        flatArgs.push(...lowered);
      }
    }

    // Build the core function call
    const coreFnExpr = `instance${funcInfo.runtimeInstanceIdx}.exports['${funcInfo.coreExportName}']${this.ts(' as Function')}`;
    const argsExpr = `[${flatArgs.join(', ')}]`;

    if (funcInfo.isAsync) {
      // Async export: task.return trampoline already lifts the result,
      // so we only need to lower params and pass them through.
      const callbackExpr = funcInfo.callbackIdx >= 0
        ? `callback_${funcInfo.callbackIdx}`
        : 'undefined';
      let expr = `state${funcInfo.stateIdx}.runAsyncExport(${coreFnExpr}, ${callbackExpr}, _eventLoop, ${argsExpr})`;
      // Add .then() chain for future/stream result lifting
      if (funcInfo.liftResult) {
        const stateVar = `state${funcInfo.stateIdx}`;
        if (funcInfo.liftResult.tag === 'liftFutureEnd') {
          expr += `.then(r => { ${stateVar}.liftFutureEnd(${funcInfo.liftResult.tableIdx}, r${this.ts(' as number')}); return r; })`;
        } else if (funcInfo.liftResult.tag === 'liftStreamEnd') {
          expr += `.then(r => { ${stateVar}.liftStreamEnd(${funcInfo.liftResult.tableIdx}, r${this.ts(' as number')}); return r; })`;
        }
      }
      this.line(`return ${expr};`);
    } else {
      // Sync export
      this.line(`const _raw = state${funcInfo.stateIdx}.runSyncExport(${coreFnExpr}, ${argsExpr});`);

      if (info.resultType === null) {
        // No return value, just return the raw result
        this.line(`return _raw;`);
      } else if (resultViaPtr && memIdx !== null) {
        // Core function returns a pointer to result area; handle Promise from JSPI
        this._liftId = 0;
        this.line(`const _lift = (_rp${this.ts(': unknown')})${this.ts(': unknown')} => {`);
        const liftExpr = this.genLiftElemFromMemory(info.resultType!, memIdx, `(_rp${this.ts(' as number')})`, '    ');
        this.line(`    return ${liftExpr};`);
        this.line(`};`);
        this.line(`if (_raw instanceof Promise) return (_raw${this.ts(' as Promise<unknown>')}).then(_lift);`);
        this.line(`return _lift(_raw);`);
      } else if (info.resultFlatTypes.length === 1) {
        // Single flat return value
        const liftExpr = this.genLiftFlatResult(info.resultType!, '_raw', memIdx);
        if (liftExpr === '_raw') {
          this.line(`return _raw;`);
        } else {
          this.line(`const _liftR = (_v${this.ts(': unknown')})${this.ts(': unknown')} => ${liftExpr.replace(/_raw/g, '_v')};`);
          this.line(`if (_raw instanceof Promise) return (_raw${this.ts(' as Promise<unknown>')}).then(_liftR);`);
          this.line(`return _liftR(_raw);`);
        }
      } else {
        this.line(`return _raw;`);
      }
    }

    this.popIndent();
    this.line('};');
  }

  /** Lower a JS param to flat core args for export calls. Returns an array of flat arg expressions. */
  private genLowerExportParam(ty: HostValType, jsExpr: string, memIdx: number | null, reallocExpr: string): string[] {
    if (typeof ty === 'string') {
      switch (ty) {
        case 'bool':
          return [`(${jsExpr} ? 1 : 0)`];
        case 'u8': case 's8': case 'u16': case 's16':
        case 'u32': case 's32': case 'char':
        case 'u64': case 's64':
        case 'f32': case 'f64':
          return [jsExpr];
        case 'string': {
          const t = this.nextTmpVar++;
          this.line(`const _enc${t} = new TextEncoder().encode(${jsExpr}${this.ts(' as string')});`);
          this.line(`const _sptr${t} = ${reallocExpr}(0, 0, 1, _enc${t}.length)${this.ts(' as number')};`);
          this.line(`new Uint8Array(memory${memIdx}.buffer, _sptr${t}, _enc${t}.length).set(_enc${t});`);
          return [`_sptr${t}`, `_enc${t}.length`];
        }
        case 'own': case 'borrow':
        case 'stream': case 'future':
          return [jsExpr];
      }
    }

    if (typeof ty !== 'object') return [jsExpr];

    switch (ty.tag) {
      case 'enum': {
        const t = this.nextTmpVar++;
        const mapEntries = ty.names.map((n, i) => `'${n}':${i}`).join(',');
        this.line(`const _em${t}${this.ts(': Record<string,number>')} = {${mapEntries}};`);
        return [`_em${t}[${jsExpr}${this.ts(' as string')}]`];
      }
      case 'list': {
        if (memIdx === null) return [jsExpr];
        const elemSize = hostValTypeByteSize(ty.elem);
        const elemAlign = hostValTypeAlignment(ty.elem);
        const t = this.nextTmpVar++;
        if (ty.elem === 'u8') {
          this.line(`const _la${t} = ${jsExpr}${this.ts(' as Uint8Array')};`);
          this.line(`const _lp${t} = ${reallocExpr}(0, 0, ${elemAlign}, _la${t}.length)${this.ts(' as number')};`);
          this.line(`new Uint8Array(memory${memIdx}.buffer, _lp${t}, _la${t}.length).set(_la${t});`);
          return [`_lp${t}`, `_la${t}.length`];
        }
        this.line(`const _la${t} = ${jsExpr}${this.ts(' as unknown[]')};`);
        this.line(`const _lp${t} = ${reallocExpr}(0, 0, ${elemAlign}, _la${t}.length * ${elemSize})${this.ts(' as number')};`);
        this.line(`for (let _li${t} = 0; _li${t} < _la${t}.length; _li${t}++) {`);
        this.genStoreResult(ty.elem, memIdx, reallocExpr, `_lp${t} + _li${t} * ${elemSize}`, `_la${t}[_li${t}]`, 0);
        this.line(`}`);
        return [`_lp${t}`, `_la${t}.length`];
      }
      case 'record': {
        const flat = flattenHostValType(ty);
        if (flat.length <= 16) {
          // Flatten each field recursively
          const result: string[] = [];
          for (const field of ty.fields) {
            const fieldExpr = this.jsMode
              ? `${jsExpr}['${field.name}']`
              : `(${jsExpr} as Record<string,unknown>)['${field.name}']`;
            result.push(...this.genLowerExportParam(field.type, fieldExpr, memIdx, reallocExpr));
          }
          return result;
        }
        // Too many flat values, spill to memory
        if (memIdx === null) return [jsExpr];
        const t = this.nextTmpVar++;
        const size = hostValTypeByteSize(ty);
        const align = hostValTypeAlignment(ty);
        this.line(`const _rp${t} = ${reallocExpr}(0, 0, ${align}, ${size})${this.ts(' as number')};`);
        this.genStoreResult(ty, memIdx, reallocExpr, `_rp${t}`, jsExpr, 0);
        return [`_rp${t}`];
      }
      case 'tuple': {
        const flat = flattenHostValType(ty);
        if (flat.length <= 16) {
          const result: string[] = [];
          for (let i = 0; i < ty.elems.length; i++) {
            const elemExpr = this.jsMode ? `${jsExpr}[${i}]` : `(${jsExpr} as unknown[])[${i}]`;
            result.push(...this.genLowerExportParam(ty.elems[i]!, elemExpr, memIdx, reallocExpr));
          }
          return result;
        }
        if (memIdx === null) return [jsExpr];
        const t = this.nextTmpVar++;
        const size = hostValTypeByteSize(ty);
        const align = hostValTypeAlignment(ty);
        this.line(`const _tp${t} = ${reallocExpr}(0, 0, ${align}, ${size})${this.ts(' as number')};`);
        this.genStoreResult(ty, memIdx, reallocExpr, `_tp${t}`, jsExpr, 0);
        return [`_tp${t}`];
      }
      case 'option': {
        const innerFlat = flattenHostValType(ty.inner);
        const t = this.nextTmpVar++;
        this.line(`const _ov${t} = ${jsExpr};`);
        // Discriminant
        const parts: string[] = [`(${`_ov${t}`} == null ? 0 : 1)`];
        // Payload: when null, fill with zeros
        for (let i = 0; i < innerFlat.length; i++) {
          parts.push(`(${`_ov${t}`} == null ? 0 : ${this.genLowerExportParam(ty.inner, `_ov${t}`, memIdx, reallocExpr)[i] ?? '0'})`);
        }
        return parts;
      }
      case 'result': {
        const t = this.nextTmpVar++;
        this.line(`const _rv${t} = ${jsExpr}${this.ts(' as {tag:string; val?:unknown}')};`);
        // Discriminant
        const parts: string[] = [`(_rv${t}.tag === 'ok' ? 0 : 1)`];
        const okFlat = ty.ok ? flattenHostValType(ty.ok) : [];
        const errFlat = ty.err ? flattenHostValType(ty.err) : [];
        const payloadLen = Math.max(okFlat.length, errFlat.length);
        for (let i = 0; i < payloadLen; i++) {
          // Use the ok or err payload depending on tag; fill with zeros for missing
          parts.push(`0${this.ts(' as any')}`);
        }
        // Override with actual values — this is too complex for inline,
        // so for result types with complex payloads, use retptr
        return parts;
      }
      case 'variant': {
        const t = this.nextTmpVar++;
        const nameMap = ty.cases.map((c, i) => `'${c.name}':${i}`).join(',');
        this.line(`const _vv${t} = ${jsExpr}${this.ts(' as {tag:string; val?:unknown}')};`);
        this.line(`const _vd${t}${this.ts(': Record<string,number>')} = {${nameMap}};`);
        const parts: string[] = [`_vd${t}[_vv${t}.tag]`];
        // Compute max payload flat length across all cases
        const caseFlatLens = ty.cases.map(c => c.type ? flattenHostValType(c.type).length : 0);
        const maxPayload = Math.max(0, ...caseFlatLens);
        for (let i = 0; i < maxPayload; i++) {
          parts.push(`0${this.ts(' as any')}`);
        }
        return parts;
      }
      case 'flags': {
        return [jsExpr];
      }
      case 'own': case 'borrow':
      case 'stream': case 'future':
        return [jsExpr];
    }

    return [jsExpr];
  }

  /** Lift a single flat result value to a JS value. */
  private genLiftFlatResult(ty: HostValType, rawExpr: string, memIdx: number | null): string {
    if (typeof ty === 'string') {
      switch (ty) {
        case 'bool': return `(${rawExpr} !== 0)`;
        case 'string':
          // String results always use retptr, shouldn't reach here
          return rawExpr;
        default: return rawExpr;
      }
    }
    if (typeof ty === 'object') {
      if (ty.tag === 'enum') {
        const namesArr = `[${ty.names.map(n => `'${n}'`).join(',')}]`;
        return `${namesArr}[${rawExpr}${this.ts(' as number')}]`;
      }
      if (ty.tag === 'result' && !ty.ok && !ty.err) {
        return `(${rawExpr} === 0 ? {tag: 'ok'${this.ts(' as const')}} : {tag: 'err'${this.ts(' as const')}})`;
      }
    }
    return rawExpr;
  }

  // -------------------------------------------------------------------
  // Return object
  // -------------------------------------------------------------------

  private emitReturnObject(): void {
    this.line('');
    this.line('return {');

    for (const [interfacePath, funcMap] of this.linked.exports) {
      const funcNames = [...funcMap.keys()];
      const inner = funcNames.map(n => `${this.sanitizeName(n)}`).join(', ');
      this.line(`    '${interfacePath}': { ${inner} },`);
    }

    // $states
    const numStates = this.linked.numStates;
    const stateVars = Array.from({ length: numStates }, (_, i) => `state${i}`);
    this.line(`    '$states': [${stateVars.join(', ')}],`);

    // $destroy
    const destroyCalls = stateVars.map(s => `${s}.destroy()`).join('; ');
    this.line(`    '$destroy': () => { ${destroyCalls} },`);

    this.line('};');
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  /** Convert a kebab-case name to a valid JS identifier (camelCase). */
  private sanitizeName(name: string): string {
    // Strip [async] prefix if present
    let s = name.replace(/^\[async\]/, '');
    // Convert kebab-case to camelCase
    s = s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    return s;
  }

  private line(text: string): void {
    this.lines.push(this.indent + text);
  }

  private pushIndent(): void {
    this.indent += '    ';
  }

  private popIndent(): void {
    this.indent = this.indent.slice(4);
  }
}
