export { parseComponent } from '../parser/parse.ts';
export { printComponent } from '../parser/print.ts';
export { generateCode } from './codegen.ts';
export type { GenerateResult, GenerateOptions } from './codegen.ts';
export type {
  ParsedComponent,
  Section,
  ComponentNames,
  ComponentValType,
  DefinedType,
  ComponentTypeEntry,
  ComponentFuncType,
  CanonicalFunc,
  CanonOpt,
  Alias,
  CoreInstance,
  ComponentInstance,
  ComponentImport,
  ComponentExport,
  ExternType,
} from '../parser/types.ts';
