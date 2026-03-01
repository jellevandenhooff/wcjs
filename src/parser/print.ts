/**
 * Print a ParsedComponent IR to WAT-like text format.
 * Matches `wasm-tools print` output at the component level,
 * with core module and nested component bodies omitted.
 */
import type {
  ParsedComponent, Section, ComponentNames,
  ComponentValType, DefinedType,
  ComponentTypeEntry, ComponentFuncType,
  CanonicalFunc, CanonOpt,
  Alias, CoreInstance, ComponentInstance,
  ComponentImport, ComponentExport,
  ExternType, InstanceTypeDecl, TypeBounds,
} from './types.ts';

/** Print a parsed component to WAT text. */
export function printComponent(parsed: ParsedComponent): string {
  const p = new Printer(parsed.names);
  p.printParsedComponent(parsed);
  return p.output();
}

class Printer {
  private lines: string[] = [];
  private indent = 0;
  private names: ComponentNames;

  // Index counters for annotations like (;0;)
  private coreModuleIdx = 0;
  private coreFuncIdx = 0;
  private coreInstanceIdx = 0;
  private coreMemoryIdx = 0;
  private compFuncIdx = 0;
  private compInstanceIdx = 0;
  private componentIdx = 0;
  private compTypeIdx = 0;

  constructor(names: ComponentNames) {
    this.names = names;
  }

  output(): string {
    return this.lines.join('\n');
  }

  private line(s: string): void {
    this.lines.push('  '.repeat(this.indent) + s);
  }

  /** Returns `$name ` prefix for definition sites, or empty string. */
  private def(map: Map<number, string>, idx: number): string {
    const n = map.get(idx);
    return n ? `$${n} ` : '';
  }

  /** Returns `$name` for reference sites, or numeric index. */
  private ref(map: Map<number, string>, idx: number): string {
    const n = map.get(idx);
    return n ? `$${n}` : `${idx}`;
  }

  printParsedComponent(parsed: ParsedComponent): void {
    const compName = this.names.componentName ? ` $${this.names.componentName}` : '';
    this.line(`(component${compName}`);
    this.indent++;

    for (const section of parsed.sections) {
      this.printSection(section);
    }

    this.indent--;
    this.line(')');
  }

  private printSection(section: Section): void {
    switch (section.tag) {
      case 'coreModule':
        this.printCoreModule(section.index);
        break;
      case 'coreInstance':
        this.printCoreInstance(section.index, section.instance);
        break;
      case 'type':
        this.printTypeSection(section.startIndex, section.entries);
        break;
      case 'canonical':
        this.printCanonicalSection(section.startIndex, section.funcs);
        break;
      case 'component':
        this.printNestedComponent(section.index);
        break;
      case 'componentInstance':
        this.printComponentInstance(section.index, section.instance);
        break;
      case 'alias':
        this.printAlias(section.alias);
        break;
      case 'import':
        this.printImport(section.import);
        break;
      case 'export':
        this.printExport(section.export);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Core module
  // -----------------------------------------------------------------------

  private printCoreModule(_index: number): void {
    const idx = this.coreModuleIdx++;
    this.line(`(core module ${this.def(this.names.coreModule,idx)}(;${idx};) ...)`);
  }

  // -----------------------------------------------------------------------
  // Core instance
  // -----------------------------------------------------------------------

  private printCoreInstance(index: number, instance: CoreInstance): void {
    const idx = this.coreInstanceIdx++;
    const def = this.def(this.names.coreInstance,idx);
    switch (instance.tag) {
      case 'instantiate': {
        const modRef = this.ref(this.names.coreModule,instance.moduleIndex);
        if (instance.args.length > 0) {
          this.line(`(core instance ${def}(;${idx};) (instantiate ${modRef}`);
          this.indent += 2;
          for (const a of instance.args) {
            // Core instance instantiate args are always core instances
            this.line(`(with "${a.name}" (instance ${this.ref(this.names.coreInstance,a.index)}))`);
          }
          this.indent -= 2;
          this.indent++;
          this.line(')');
          this.indent--;
          this.line(')');
        } else {
          this.line(`(core instance ${def}(;${idx};) (instantiate ${modRef}))`);
        }
        break;
      }
      case 'fromExports': {
        this.line(`(core instance ${def}(;${idx};)`);
        this.indent++;
        for (const exp of instance.exports) {
          const ref = exp.kind === 'func' ? this.ref(this.names.coreFunc,exp.index)
            : exp.kind === 'memory' ? this.ref(this.names.coreMemory,exp.index)
            : `${exp.index}`;
          this.line(`(export "${exp.name}" (${exp.kind} ${ref}))`);
        }
        this.indent--;
        this.line(')');
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Type section
  // -----------------------------------------------------------------------

  private printTypeSection(startIndex: number, entries: ComponentTypeEntry[]): void {
    for (let i = 0; i < entries.length; i++) {
      this.printTypeEntry(entries[i]!);
    }
  }

  private printTypeEntry(entry: ComponentTypeEntry): void {
    const idx = this.compTypeIdx++;
    const def = this.def(this.names.type,idx);
    switch (entry.tag) {
      case 'defined':
        this.line(`(type ${def}(;${idx};) ${this.formatDefinedType(entry.type)})`);
        break;
      case 'func':
        this.line(`(type ${def}(;${idx};) ${this.formatFuncType(entry.type)})`);
        break;
      case 'resource': {
        const dtor = entry.resource.dtor !== null ? ` (dtor (func ${entry.resource.dtor}))` : '';
        this.line(`(type ${def}(;${idx};) (resource (rep ${entry.resource.rep})${dtor}))`);
        break;
      }
      case 'component':
        this.line(`(type ${def}(;${idx};) (component ...))`);
        break;
      case 'instance':
        this.printInstanceType(idx, entry.entries);
        break;
    }
  }

  private printInstanceType(idx: number, entries: InstanceTypeDecl[]): void {
    const def = this.def(this.names.type,idx);
    this.line(`(type ${def}(;${idx};) (instance`);
    this.indent++;
    for (const decl of entries) {
      switch (decl.tag) {
        case 'type':
          // Nested type in instance type — use local index
          this.line(`(type ${this.formatTypeEntryInline(decl.entry)})`);
          break;
        case 'alias':
          this.printAlias(decl.alias);
          break;
        case 'exportType':
          this.line(`(export "${decl.name}" ${this.formatExternType(decl.type)})`);
          break;
      }
    }
    this.indent--;
    this.line('))');
  }

  private formatTypeEntryInline(entry: ComponentTypeEntry): string {
    switch (entry.tag) {
      case 'defined': return this.formatDefinedType(entry.type);
      case 'func': return this.formatFuncType(entry.type);
      case 'resource': return '(resource)';
      default: return '...';
    }
  }

  // -----------------------------------------------------------------------
  // Defined types
  // -----------------------------------------------------------------------

  private formatDefinedType(type: DefinedType): string {
    switch (type.tag) {
      case 'primitive':
        return type.type;
      case 'record': {
        const fields = type.fields.map(f =>
          `(field "${f.name}" ${this.formatValType(f.type)})`).join(' ');
        return `(record ${fields})`;
      }
      case 'variant': {
        const cases = type.cases.map(c => {
          const ty = c.type ? ` ${this.formatValType(c.type)}` : '';
          return `(case "${c.name}"${ty})`;
        }).join(' ');
        return `(variant ${cases})`;
      }
      case 'list':
        return `(list ${this.formatValType(type.elementType)})`;
      case 'tuple': {
        const types = type.types.map(t => this.formatValType(t)).join(' ');
        return `(tuple ${types})`;
      }
      case 'flags': {
        const flags = type.names.map(n => `"${n}"`).join(' ');
        return `(flags ${flags})`;
      }
      case 'enum': {
        const names = type.names.map(n => `"${n}"`).join(' ');
        return `(enum ${names})`;
      }
      case 'option':
        return `(option ${this.formatValType(type.type)})`;
      case 'result': {
        const parts: string[] = [];
        if (type.ok) parts.push(`(ok ${this.formatValType(type.ok)})`);
        if (type.err) parts.push(`(error ${this.formatValType(type.err)})`);
        if (parts.length === 0) return '(result)';
        return `(result ${parts.join(' ')})`;
      }
      case 'own':
        return `(own ${type.typeIndex})`;
      case 'borrow':
        return `(borrow ${type.typeIndex})`;
      case 'future': {
        if (type.type) return `(future ${this.formatValType(type.type)})`;
        return '(future)';
      }
      case 'stream': {
        if (type.type) return `(stream ${this.formatValType(type.type)})`;
        return '(stream)';
      }
      case 'errorContext':
        return '(error-context)';
    }
  }

  private formatValType(type: ComponentValType): string {
    if (type.tag === 'primitive') return type.type;
    return this.ref(this.names.type,type.index);
  }

  // -----------------------------------------------------------------------
  // Function types
  // -----------------------------------------------------------------------

  private formatFuncType(type: ComponentFuncType): string {
    const asyncStr = type.isAsync ? ' async' : '';
    const params = type.params.map(p =>
      `(param "${p.name}" ${this.formatValType(p.type)})`).join(' ');
    const result = type.result ? ` (result ${this.formatValType(type.result)})` : '';
    if (params) {
      return `(func${asyncStr} ${params}${result})`;
    }
    return `(func${asyncStr}${result})`;
  }

  // -----------------------------------------------------------------------
  // Canonical functions
  // -----------------------------------------------------------------------

  private printCanonicalSection(startIndex: number, funcs: CanonicalFunc[]): void {
    for (const func of funcs) {
      this.printCanonicalFunc(func);
    }
  }

  private printCanonicalFunc(func: CanonicalFunc): void {
    switch (func.tag) {
      case 'lift': {
        const idx = this.compFuncIdx++;
        const def = this.def(this.names.func,idx);
        const opts = this.formatCanonOpts(func.options);
        this.line(`(func ${def}(;${idx};) (type ${this.ref(this.names.type,func.typeIndex)}) (canon lift (core func ${this.ref(this.names.coreFunc,func.coreFuncIndex)})${opts}))`);
        break;
      }
      case 'lower': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const opts = this.formatCanonOpts(func.options);
        this.line(`(core func ${def}(;${idx};) (canon lower (func ${this.ref(this.names.func,func.funcIndex)})${opts}))`);
        break;
      }
      case 'resourceNew': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon resource.new ${this.ref(this.names.type,func.typeIndex)}))`);
        break;
      }
      case 'resourceDrop': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon resource.drop ${this.ref(this.names.type,func.typeIndex)}))`);
        break;
      }
      case 'resourceDropAsync': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon resource.drop-async ${this.ref(this.names.type,func.typeIndex)}))`);
        break;
      }
      case 'resourceRep': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon resource.rep ${this.ref(this.names.type,func.typeIndex)}))`);
        break;
      }
      case 'taskReturn': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const opts = this.formatCanonOpts(func.options);
        if (func.result) {
          this.line(`(core func ${def}(;${idx};) (canon task.return (result ${this.formatValType(func.result)})${opts}))`);
        } else {
          this.line(`(core func ${def}(;${idx};) (canon task.return${opts}))`);
        }
        break;
      }
      case 'contextGet': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon context.get i32 ${func.index}))`);
        break;
      }
      case 'contextSet': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon context.set i32 ${func.index}))`);
        break;
      }
      case 'taskCancel': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon task.cancel))`);
        break;
      }
      case 'subtaskCancel': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const async_ = func.async ? ' async' : '';
        this.line(`(core func ${def}(;${idx};) (canon subtask.cancel${async_}))`);
        break;
      }
      case 'subtaskDrop': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon subtask.drop))`);
        break;
      }
      case 'streamNew': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon stream.new ${this.ref(this.names.type,func.typeIndex)}))`);
        break;
      }
      case 'streamRead': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const opts = this.formatCanonOpts(func.options);
        this.line(`(core func ${def}(;${idx};) (canon stream.read ${this.ref(this.names.type,func.typeIndex)}${opts}))`);
        break;
      }
      case 'streamWrite': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const opts = this.formatCanonOpts(func.options);
        this.line(`(core func ${def}(;${idx};) (canon stream.write ${this.ref(this.names.type,func.typeIndex)}${opts}))`);
        break;
      }
      case 'streamCancelRead': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const async_ = func.async ? ' async' : '';
        this.line(`(core func ${def}(;${idx};) (canon stream.cancel-read ${this.ref(this.names.type,func.typeIndex)}${async_}))`);
        break;
      }
      case 'streamCancelWrite': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const async_ = func.async ? ' async' : '';
        this.line(`(core func ${def}(;${idx};) (canon stream.cancel-write ${this.ref(this.names.type,func.typeIndex)}${async_}))`);
        break;
      }
      case 'streamDropReadable': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon stream.drop-readable ${this.ref(this.names.type,func.typeIndex)}))`);
        break;
      }
      case 'streamDropWritable': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon stream.drop-writable ${this.ref(this.names.type,func.typeIndex)}))`);
        break;
      }
      case 'futureNew': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon future.new ${this.ref(this.names.type,func.typeIndex)}))`);
        break;
      }
      case 'futureRead': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const opts = this.formatCanonOpts(func.options);
        this.line(`(core func ${def}(;${idx};) (canon future.read ${this.ref(this.names.type,func.typeIndex)}${opts}))`);
        break;
      }
      case 'futureWrite': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const opts = this.formatCanonOpts(func.options);
        this.line(`(core func ${def}(;${idx};) (canon future.write ${this.ref(this.names.type,func.typeIndex)}${opts}))`);
        break;
      }
      case 'futureCancelRead': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const async_ = func.async ? ' async' : '';
        this.line(`(core func ${def}(;${idx};) (canon future.cancel-read ${this.ref(this.names.type,func.typeIndex)}${async_}))`);
        break;
      }
      case 'futureCancelWrite': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const async_ = func.async ? ' async' : '';
        this.line(`(core func ${def}(;${idx};) (canon future.cancel-write ${this.ref(this.names.type,func.typeIndex)}${async_}))`);
        break;
      }
      case 'futureDropReadable': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon future.drop-readable ${this.ref(this.names.type,func.typeIndex)}))`);
        break;
      }
      case 'futureDropWritable': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon future.drop-writable ${this.ref(this.names.type,func.typeIndex)}))`);
        break;
      }
      case 'errorContextNew': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const opts = this.formatCanonOpts(func.options);
        this.line(`(core func ${def}(;${idx};) (canon error-context.new${opts}))`);
        break;
      }
      case 'errorContextDebugMessage': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const opts = this.formatCanonOpts(func.options);
        this.line(`(core func ${def}(;${idx};) (canon error-context.debug-message${opts}))`);
        break;
      }
      case 'errorContextDrop': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon error-context.drop))`);
        break;
      }
      case 'waitableSetNew': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon waitable-set.new))`);
        break;
      }
      case 'waitableSetWait': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const async_ = func.async ? ' async' : '';
        this.line(`(core func ${def}(;${idx};) (canon waitable-set.wait${async_} (memory ${this.ref(this.names.coreMemory,func.memoryIndex)})))`);
        break;
      }
      case 'waitableSetPoll': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const async_ = func.async ? ' async' : '';
        this.line(`(core func ${def}(;${idx};) (canon waitable-set.poll${async_} (memory ${this.ref(this.names.coreMemory,func.memoryIndex)})))`);
        break;
      }
      case 'waitableSetDrop': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon waitable-set.drop))`);
        break;
      }
      case 'waitableJoin': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon waitable.join))`);
        break;
      }
      case 'backpressureInc': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon backpressure.inc))`);
        break;
      }
      case 'backpressureDec': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon backpressure.dec))`);
        break;
      }
      case 'threadYield': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const async_ = func.async ? ' async' : '';
        this.line(`(core func ${def}(;${idx};) (canon thread.yield${async_}))`);
        break;
      }
      case 'threadIndex': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon thread.index))`);
        break;
      }
      case 'threadNewIndirect': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon thread.new-indirect ${func.funcTypeIndex} ${func.tableIndex}))`);
        break;
      }
      case 'threadSuspend': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const async_ = func.async ? ' async' : '';
        this.line(`(core func ${def}(;${idx};) (canon thread.suspend${async_}))`);
        break;
      }
      case 'threadSwitchTo': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const async_ = func.async ? ' async' : '';
        this.line(`(core func ${def}(;${idx};) (canon thread.switch-to${async_}))`);
        break;
      }
      case 'threadYieldTo': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        const async_ = func.async ? ' async' : '';
        this.line(`(core func ${def}(;${idx};) (canon thread.yield-to${async_}))`);
        break;
      }
      case 'threadResumeLater': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon thread.resume-later))`);
        break;
      }
      case 'threadSpawnRef': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon thread.spawn-ref ${func.funcTypeIndex}))`);
        break;
      }
      case 'threadSpawnIndirect': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon thread.spawn-indirect ${func.funcTypeIndex} ${func.tableIndex}))`);
        break;
      }
      case 'threadAvailableParallelism': {
        const idx = this.coreFuncIdx++;
        const def = this.def(this.names.coreFunc,idx);
        this.line(`(core func ${def}(;${idx};) (canon thread.available-parallelism))`);
        break;
      }
    }
  }

  private formatCanonOpts(opts: CanonOpt[]): string {
    if (opts.length === 0) return '';
    const parts: string[] = [];
    for (const opt of opts) {
      switch (opt.tag) {
        case 'utf8': parts.push('utf8'); break;
        case 'utf16': parts.push('utf16'); break;
        case 'compactUtf16': parts.push('compact-utf16'); break;
        case 'memory': parts.push(`(memory ${this.ref(this.names.coreMemory,opt.index)})`); break;
        case 'realloc': parts.push(`(realloc ${opt.index})`); break;
        case 'postReturn': parts.push(`(post-return ${opt.index})`); break;
        case 'async': parts.push('async'); break;
        case 'callback': parts.push(`(callback ${this.ref(this.names.coreFunc,opt.index)})`); break;
      }
    }
    return ' ' + parts.join(' ');
  }

  // -----------------------------------------------------------------------
  // Nested component
  // -----------------------------------------------------------------------

  private printNestedComponent(_index: number): void {
    const idx = this.componentIdx++;
    this.line(`(component ${this.def(this.names.component,idx)}(;${idx};) ...)`);
  }

  // -----------------------------------------------------------------------
  // Component instance
  // -----------------------------------------------------------------------

  private printComponentInstance(index: number, instance: ComponentInstance): void {
    const idx = this.compInstanceIdx++;
    const def = this.def(this.names.instance,idx);
    switch (instance.tag) {
      case 'instantiate': {
        const compRef = this.ref(this.names.component,instance.componentIndex);
        if (instance.args.length > 0) {
          this.line(`(instance ${def}(;${idx};) (instantiate ${compRef}`);
          this.indent += 2;
          for (const a of instance.args) {
            const ref = this.refBySort(a.sort, a.index);
            this.line(`(with "${a.name}" (${a.sort} ${ref}))`);
          }
          this.indent -= 2;
          this.indent++;
          this.line(')');
          this.indent--;
          this.line(')');
        } else {
          this.line(`(instance ${def}(;${idx};) (instantiate ${compRef}))`);
        }
        break;
      }
      case 'fromExports': {
        this.line(`(instance ${def}(;${idx};)`);
        this.indent++;
        for (const exp of instance.exports) {
          const ref = this.refBySort(exp.sort, exp.index);
          this.line(`(export "${exp.name}" (${exp.sort} ${ref}))`);
        }
        this.indent--;
        this.line(')');
        break;
      }
    }
  }

  /** Resolve a reference by component-level sort. */
  private refBySort(sort: string, index: number): string {
    switch (sort) {
      case 'func': return this.ref(this.names.func,index);
      case 'instance': return this.ref(this.names.instance,index);
      case 'component': return this.ref(this.names.component,index);
      case 'type': return this.ref(this.names.type,index);
      default: return `${index}`;
    }
  }

  // -----------------------------------------------------------------------
  // Alias
  // -----------------------------------------------------------------------

  private printAlias(alias: Alias): void {
    switch (alias.tag) {
      case 'coreInstanceExport': {
        const idx = this.advanceAliasIndex(alias);
        const instRef = this.ref(this.names.coreInstance,alias.instanceIndex);
        const def = alias.sort === 'func' ? this.def(this.names.coreFunc,idx)
          : alias.sort === 'memory' ? this.def(this.names.coreMemory,idx)
          : '';
        this.line(`(alias core export ${instRef} "${alias.name}" (core ${alias.sort} ${def}(;${idx};)))`);
        break;
      }
      case 'instanceExport': {
        const idx = this.advanceCompAliasIndex(alias);
        const instRef = this.ref(this.names.instance,alias.instanceIndex);
        const def = this.defBySort(alias.sort, idx);
        this.line(`(alias export ${instRef} "${alias.name}" (${alias.sort} ${def}(;${idx};)))`);
        break;
      }
      case 'outer': {
        const idx = this.advanceCompAliasIndex(alias);
        const def = this.defBySort(alias.sort, idx);
        this.line(`(alias outer ${alias.outerCount} ${alias.index} (${alias.sort} ${def}(;${idx};)))`);
        break;
      }
    }
  }

  /** Get def name prefix by component-level sort. */
  private defBySort(sort: string, idx: number): string {
    switch (sort) {
      case 'func': return this.def(this.names.func,idx);
      case 'instance': return this.def(this.names.instance,idx);
      case 'component': return this.def(this.names.component,idx);
      case 'type': return this.def(this.names.type,idx);
      default: return '';
    }
  }

  private advanceAliasIndex(alias: Alias & { tag: 'coreInstanceExport' }): number {
    switch (alias.sort) {
      case 'func': return this.coreFuncIdx++;
      case 'memory': return this.coreMemoryIdx++;
      default: return 0;
    }
  }

  private advanceCompAliasIndex(alias: Alias & { tag: 'instanceExport' | 'outer' }): number {
    switch (alias.sort) {
      case 'func': return this.compFuncIdx++;
      case 'instance': return this.compInstanceIdx++;
      case 'type': return this.compTypeIdx++;
      case 'component': return this.componentIdx++;
      default: return 0;
    }
  }

  // -----------------------------------------------------------------------
  // Import
  // -----------------------------------------------------------------------

  private printImport(imp: ComponentImport): void {
    const idx = this.advanceImportIndex(imp);
    const typeStr = this.formatImportExternType(imp.type, idx);
    this.line(`(import "${imp.name}" ${typeStr})`);
  }

  private advanceImportIndex(imp: ComponentImport): number {
    switch (imp.type.tag) {
      case 'func': return this.compFuncIdx++;
      case 'instance': return this.compInstanceIdx++;
      case 'component': return this.componentIdx++;
      case 'type': return this.compTypeIdx++;
      case 'value': return 0;
    }
  }

  private formatImportExternType(type: ExternType, idx: number): string {
    switch (type.tag) {
      case 'func':
        return `(func ${this.def(this.names.func,idx)}(;${idx};) (type ${this.ref(this.names.type,type.typeIndex)}))`;
      case 'instance':
        return `(instance ${this.def(this.names.instance,idx)}(;${idx};) (type ${this.ref(this.names.type,type.typeIndex)}))`;
      case 'component':
        return `(component ${this.def(this.names.component,idx)}(;${idx};) (type ${this.ref(this.names.type,type.typeIndex)}))`;
      case 'type':
        return `(type ${this.def(this.names.type,idx)}(;${idx};) ${this.formatTypeBounds(type.bounds)})`;
      case 'value':
        return `(value (;${idx};) ${this.formatValType(type.type)})`;
    }
  }

  private formatTypeBounds(bounds: TypeBounds): string {
    switch (bounds.tag) {
      case 'eq': return `(eq ${this.ref(this.names.type,bounds.typeIndex)})`;
      case 'subResource': return '(sub resource)';
    }
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  private printExport(exp: ComponentExport): void {
    const idx = this.advanceExportIndex(exp);
    const ref = this.refBySort(exp.sort, exp.index);
    const typeAscription = exp.type ? ` ${this.formatExportTypeAscription(exp.type)}` : '';
    this.line(`(export (;${idx};) "${exp.name}" (${exp.sort} ${ref})${typeAscription})`);
  }

  private advanceExportIndex(exp: ComponentExport): number {
    switch (exp.sort) {
      case 'func': return this.compFuncIdx++;
      case 'instance': return this.compInstanceIdx++;
      case 'component': return this.componentIdx++;
      case 'type': return this.compTypeIdx++;
      case 'value': return 0;
      default: return 0;
    }
  }

  private formatExportTypeAscription(type: ExternType): string {
    switch (type.tag) {
      case 'func': return `(func (type ${this.ref(this.names.type,type.typeIndex)}))`;
      case 'instance': return `(instance (type ${this.ref(this.names.type,type.typeIndex)}))`;
      case 'component': return `(component (type ${this.ref(this.names.type,type.typeIndex)}))`;
      case 'type': return `(type ${this.formatTypeBounds(type.bounds)})`;
      case 'value': return `(value ${this.formatValType(type.type)})`;
    }
  }

  private formatExternType(type: ExternType): string {
    switch (type.tag) {
      case 'func': return `(func (type ${this.ref(this.names.type,type.typeIndex)}))`;
      case 'instance': return `(instance (type ${this.ref(this.names.type,type.typeIndex)}))`;
      case 'component': return `(component (type ${this.ref(this.names.type,type.typeIndex)}))`;
      case 'type': return `(type ${this.formatTypeBounds(type.bounds)})`;
      case 'value': return `(value ${this.formatValType(type.type)})`;
    }
  }
}
