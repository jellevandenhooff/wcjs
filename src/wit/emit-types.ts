/**
 * Emit TypeScript type declarations for host-imported functions.
 *
 * Converts parsed WIT interface definitions to HostValType-based function
 * signatures, then emits TypeScript interfaces with named type aliases
 * for enums, variants, and records.
 */

import type { HostValType } from '../codegen/host-types.ts';
import { hostValTypeToTS, canonicalKey } from '../codegen/host-types.ts';
import type { WitPackage, WitInterface, WitTypeRef, WitTypeDef, WitFunc } from './parser.ts';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

function wrapComplex(ts: string): string {
  return ts.includes('|') ? `(${ts})` : ts;
}

function isValidIdent(s: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s);
}

/** Estimate complexity of a type (number of leaf nodes). */
function typeComplexity(ty: HostValType): number {
  if (typeof ty === 'string') return 1;
  switch (ty.tag) {
    case 'list': return 1 + typeComplexity(ty.elem);
    case 'record': return ty.fields.reduce((s, f) => s + typeComplexity(f.type), 0);
    case 'tuple': return ty.elems.reduce((s, e) => s + typeComplexity(e), 0);
    case 'option': return 1 + typeComplexity(ty.inner);
    case 'result':
      return 1 + (ty.ok ? typeComplexity(ty.ok) : 0) + (ty.err ? typeComplexity(ty.err) : 0);
    case 'enum': return ty.names.length;
    case 'flags': return 1;
    case 'variant': return ty.cases.reduce((s, c) => s + 1 + (c.type ? typeComplexity(c.type) : 0), 0);
    case 'own': case 'borrow': return 1;
    case 'stream': return 1 + (ty.elem ? typeComplexity(ty.elem) : 0);
    case 'future': return 1 + (ty.elem ? typeComplexity(ty.elem) : 0);
  }
}

/** Recursively collect all composite types. */
function collectTypes(ty: HostValType, types: Map<string, { type: HostValType; count: number }>): void {
  if (typeof ty === 'string') return;

  const key = canonicalKey(ty);
  const existing = types.get(key);
  if (existing) {
    existing.count++;
    return;
  }
  types.set(key, { type: ty, count: 1 });

  switch (ty.tag) {
    case 'list': collectTypes(ty.elem, types); break;
    case 'record': ty.fields.forEach(f => collectTypes(f.type, types)); break;
    case 'tuple': ty.elems.forEach(e => collectTypes(e, types)); break;
    case 'option': collectTypes(ty.inner, types); break;
    case 'result':
      if (ty.ok) collectTypes(ty.ok, types);
      if (ty.err) collectTypes(ty.err, types);
      break;
    case 'variant': ty.cases.forEach(c => { if (c.type) collectTypes(c.type, types); }); break;
    case 'stream': if (ty.elem) collectTypes(ty.elem, types); break;
    case 'future': if (ty.elem) collectTypes(ty.elem, types); break;
  }
}

/** Check if any function uses a type with the given tag. */
function hasTypeTagInFuncs(funcs: HostFuncSig[], tag: string): boolean {
  function check(ty: HostValType): boolean {
    if (typeof ty === 'string') return ty === tag;
    if (ty.tag === tag) return true;
    switch (ty.tag) {
      case 'list': return check(ty.elem);
      case 'record': return ty.fields.some(f => check(f.type));
      case 'tuple': return ty.elems.some(check);
      case 'option': return check(ty.inner);
      case 'result': return (ty.ok !== null && check(ty.ok)) || (ty.err !== null && check(ty.err));
      case 'variant': return ty.cases.some(c => c.type !== null && check(c.type));
      case 'stream': return ty.elem !== null && check(ty.elem);
      case 'future': return ty.elem !== null && check(ty.elem);
      default: return false;
    }
  }
  for (const func of funcs) {
    for (const p of func.params) if (check(p.type)) return true;
    if (func.result && check(func.result)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Function signature types
// ---------------------------------------------------------------------------

/** Info about a single host-imported function. */
interface HostFuncSig {
  name: string;
  params: { name: string; type: HostValType }[];
  result: HostValType | null;
  /** True if this function is async (host may return a Promise). */
  isAsync: boolean;
}

/** Scoped signatures: P2 and/or P3 function signatures for one bare interface. */
interface ScopedSigs {
  p2?: HostFuncSig[];
  p3?: HostFuncSig[];
}

// ---------------------------------------------------------------------------
// WIT → HostValType conversion
// ---------------------------------------------------------------------------

/** Type resolution context built from parsed WIT packages. */
interface TypeContext {
  /** Global type lookup: "namespace:package/interface.typeName" → WitTypeDef */
  globalTypes: Map<string, WitTypeDef>;
  /** Per-interface local type namespace (resolved uses + local defs). */
  localTypes: Map<string, WitTypeDef>;
  /** Package info for the current resolution context. */
  pkg: WitPackage;
}

/** Build a global type lookup from all packages. */
function buildGlobalTypes(packages: WitPackage[]): Map<string, WitTypeDef> {
  const global = new Map<string, WitTypeDef>();
  for (const pkg of packages) {
    for (const iface of pkg.interfaces) {
      for (const [name, def] of iface.typeDefs) {
        const key = `${pkg.namespace}:${pkg.name}/${iface.name}.${name}`;
        global.set(key, def);
      }
    }
  }
  return global;
}

/** Build local type namespace for an interface by resolving uses.
 *  Imports ALL types from each source interface (not just explicitly named ones)
 *  so that transitive type references (e.g. variant cases referencing type aliases)
 *  resolve correctly. */
function buildLocalTypes(
  iface: WitInterface,
  pkg: WitPackage,
  globalTypes: Map<string, WitTypeDef>,
): Map<string, WitTypeDef> {
  const local = new Map<string, WitTypeDef>();

  // Add local type definitions
  for (const [name, def] of iface.typeDefs) {
    local.set(name, def);
  }

  // Resolve use statements — import all types from source interface for
  // transitive resolution, then add explicit aliases (which may rename)
  for (const use of iface.uses) {
    let resolvedPrefix: string;
    if (use.from.includes(':')) {
      const bare = use.from.replace(/@.*$/, '');
      resolvedPrefix = bare;
    } else {
      resolvedPrefix = `${pkg.namespace}:${pkg.name}/${use.from}`;
    }

    // Import all types from the source interface so transitive refs work
    const prefix = resolvedPrefix + '.';
    for (const [key, def] of globalTypes) {
      if (key.startsWith(prefix)) {
        const typeName = key.slice(prefix.length);
        if (!local.has(typeName)) {
          local.set(typeName, def);
        }
      }
    }

    // Add explicit renames from the use statement
    for (const [localName, remoteName] of use.names) {
      if (localName !== remoteName) {
        const key = `${resolvedPrefix}.${remoteName}`;
        const def = globalTypes.get(key);
        if (def) {
          local.set(localName, def);
        }
      }
    }
  }

  return local;
}

/** Convert a WIT type reference to a HostValType. */
function witTypeRefToHostVal(ref: WitTypeRef, ctx: TypeContext): HostValType {
  if (typeof ref === 'string') {
    // Check primitives
    switch (ref) {
      case 'bool': case 'u8': case 's8': case 'u16': case 's16':
      case 'u32': case 's32': case 'u64': case 's64':
      case 'f32': case 'f64': case 'char': case 'string':
        return ref;
    }

    // Look up in local types
    const def = ctx.localTypes.get(ref);
    if (!def) {
      // Unknown named type — treat as opaque (shouldn't happen for well-formed WIT)
      return 'u32';
    }

    return witTypeDefToHostVal(def, ctx);
  }

  switch (ref.tag) {
    case 'list':
      return { tag: 'list', elem: witTypeRefToHostVal(ref.elem, ctx) };
    case 'option':
      return { tag: 'option', inner: witTypeRefToHostVal(ref.inner, ctx) };
    case 'result': {
      const ok = ref.ok !== null ? witTypeRefToHostVal(ref.ok, ctx) : null;
      const err = ref.err !== null ? witTypeRefToHostVal(ref.err, ctx) : null;
      return { tag: 'result', ok, err };
    }
    case 'tuple':
      return { tag: 'tuple', elems: ref.elems.map(e => witTypeRefToHostVal(e, ctx)) };
    case 'stream': {
      const elem = ref.elem !== null ? witTypeRefToHostVal(ref.elem, ctx) : null;
      return { tag: 'stream', elem };
    }
    case 'future': {
      const elem = ref.elem !== null ? witTypeRefToHostVal(ref.elem, ctx) : null;
      return { tag: 'future', elem };
    }
    case 'borrow':
    case 'own':
      return ref.tag;
  }
}

/** Convert a WIT type definition to a HostValType. */
function witTypeDefToHostVal(def: WitTypeDef, ctx: TypeContext): HostValType {
  switch (def.tag) {
    case 'alias':
      return witTypeRefToHostVal(def.type, ctx);
    case 'record':
      return {
        tag: 'record',
        fields: def.fields.map(f => ({ name: f.name, type: witTypeRefToHostVal(f.type, ctx) })),
      };
    case 'variant':
      return {
        tag: 'variant',
        cases: def.cases.map(c => ({
          name: c.name,
          type: c.type !== null ? witTypeRefToHostVal(c.type, ctx) : null,
        })),
      };
    case 'enum':
      return { tag: 'enum', names: [...def.cases] };
    case 'flags':
      return { tag: 'flags', count: def.flags.length };
    case 'resource':
      return 'own'; // resources are handle numbers
  }
}

/** Convert a WIT function to a HostFuncSig. */
function witFuncToSig(func: WitFunc, ctx: TypeContext): HostFuncSig {
  let name = func.name;

  // Prefix with [method], [static], or [constructor] for resource methods
  if (func.kind === 'method') {
    name = `[method]${func.resourceName}.${func.name}`;
  } else if (func.kind === 'static') {
    name = `[static]${func.resourceName}.${func.name}`;
  } else if (func.kind === 'constructor') {
    name = `[constructor]${func.resourceName}`;
  }

  const params: { name: string; type: HostValType }[] = [];

  // Methods get implicit self param (resource handle = number)
  if (func.kind === 'method') {
    params.push({ name: 'p0', type: 'u32' });
  }

  // Convert explicit params
  for (const p of func.params) {
    params.push({ name: `p${params.length}`, type: witTypeRefToHostVal(p.type, ctx) });
  }

  // Constructors implicitly return a resource handle (i32 rep)
  const result = func.kind === 'constructor' ? 'u32'
    : func.result !== null ? witTypeRefToHostVal(func.result, ctx) : null;

  return { name, params, result, isAsync: func.isAsync };
}

// ---------------------------------------------------------------------------
// WIT → ScopedSigs conversion
// ---------------------------------------------------------------------------

/** Convert WIT packages to scoped function signatures, grouped by bare interface name. */
function witPackagesToSigs(
  p3Packages: WitPackage[],
  p2Packages: WitPackage[],
): Map<string, ScopedSigs> {
  const allPackages = [...p3Packages, ...p2Packages];
  const globalTypes = buildGlobalTypes(allPackages);
  const result = new Map<string, ScopedSigs>();

  function processPkg(pkg: WitPackage, family: 'p2' | 'p3'): void {
    for (const iface of pkg.interfaces) {
      const bareIface = `${pkg.namespace}:${pkg.name}/${iface.name}`;
      const localTypes = buildLocalTypes(iface, pkg, globalTypes);
      const ctx: TypeContext = { globalTypes, localTypes, pkg };

      const funcs: HostFuncSig[] = [];

      // Freestanding functions
      for (const func of iface.functions) {
        funcs.push(witFuncToSig(func, ctx));
      }

      // Resource methods and resource-drop
      for (const [typeName, typeDef] of iface.typeDefs) {
        if (typeDef.tag !== 'resource') continue;
        for (const method of typeDef.methods) {
          funcs.push(witFuncToSig(method, ctx));
        }
        // Add synthetic [resource-drop]
        funcs.push({
          name: `[resource-drop]${typeName}`,
          params: [{ name: 'rep', type: 'u32' }],
          result: null,
          isAsync: false,
        });
      }

      if (funcs.length === 0) continue;

      if (!result.has(bareIface)) result.set(bareIface, {});
      result.get(bareIface)![family] = funcs;
    }
  }

  for (const pkg of p3Packages) processPkg(pkg, 'p3');
  for (const pkg of p2Packages) processPkg(pkg, 'p2');

  return result;
}

// ---------------------------------------------------------------------------
// Named type resolution from WIT definitions
// ---------------------------------------------------------------------------

/** Derive a TypeScript name for a WIT type, disambiguating collisions.
 *  For types in a "types" interface, prefix with the package name on collision.
 *  For types in named interfaces, prefix with the interface name. */
function deriveTypeName(
  typeName: string,
  pkg: WitPackage,
  iface: WitInterface,
  collisionCounts: Map<string, number>,
): string {
  const baseName = kebabToPascal(typeName);
  const count = collisionCounts.get(baseName) ?? 0;
  if (count <= 1) return baseName;

  // Disambiguate: use package name for generic "types" interfaces, interface name otherwise
  const prefix = iface.name === 'types' ? kebabToPascal(pkg.name) : kebabToPascal(iface.name);
  return prefix + baseName;
}

/** Build a mapping from HostValType canonical key → TypeScript name for all
 *  enums, records, and variants defined in P3 WIT packages. */
function buildNamedTypesFromWit(
  p3Packages: WitPackage[],
  globalTypes: Map<string, WitTypeDef>,
): { namedTypes: Map<string, string>; nameToType: Map<string, HostValType> } {
  // Count base PascalCase names across all P3 packages for collision detection
  const baseNameCounts = new Map<string, number>();
  for (const pkg of p3Packages) {
    for (const iface of pkg.interfaces) {
      for (const [name, def] of iface.typeDefs) {
        if (def.tag === 'enum' || def.tag === 'variant' || def.tag === 'record') {
          const base = kebabToPascal(name);
          baseNameCounts.set(base, (baseNameCounts.get(base) ?? 0) + 1);
        }
      }
    }
  }

  const namedTypes = new Map<string, string>();
  const nameToType = new Map<string, HostValType>();

  for (const pkg of p3Packages) {
    for (const iface of pkg.interfaces) {
      const localTypes = buildLocalTypes(iface, pkg, globalTypes);
      const ctx: TypeContext = { globalTypes, localTypes, pkg };

      for (const [name, def] of iface.typeDefs) {
        if (def.tag === 'resource' || def.tag === 'alias' || def.tag === 'flags') continue;

        const hostVal = witTypeDefToHostVal(def, ctx);
        const key = canonicalKey(hostVal);

        // Don't override if a name was already assigned to this key
        if (namedTypes.has(key)) continue;

        const tsName = deriveTypeName(name, pkg, iface, baseNameCounts);
        namedTypes.set(key, tsName);
        nameToType.set(tsName, hostVal);
      }
    }
  }

  return { namedTypes, nameToType };
}

// ---------------------------------------------------------------------------
// Interface emission
// ---------------------------------------------------------------------------

/** Compute the [async]-prefixed name for a method. */
function asyncName(name: string): string {
  if (name.startsWith('[')) {
    return '[async ' + name.slice(1);
  }
  return '[async]' + name;
}

/** Unwrap a bare Future<T> result type. Returns the inner type or null if not a bare Future. */
function unwrapFuture(ty: HostValType | null): HostValType | null {
  if (ty !== null && typeof ty === 'object' && ty.tag === 'future' && ty.elem !== null) {
    return ty.elem;
  }
  return null;
}

/** Emit a single interface declaration.
 *  Emits only the methods the host must explicitly implement:
 *  - Base methods (non-Future returning)
 *  - [async method] variants for Future-returning methods (unwrapped return)
 *  Auto-generated methods (sync wrappers, [async] aliases) are covered by
 *  Record<string, ...> in WasiHostInterfaces.
 */
function emitInterface(lines: string[], tsName: string, funcs: HostFuncSig[], namedTypes: Map<string, string>): void {
  lines.push(`export interface ${tsName} {`);
  for (const func of funcs) {
    // Skip sync methods that return Future<T> — auto-generated at runtime
    if (unwrapFuture(func.result) !== null) continue;
    const paramList = func.params
      .map(p => `${p.name}: ${hostValTypeToTS(p.type, namedTypes)}`)
      .join(', ');
    const baseRetType = func.result !== null
      ? hostValTypeToTS(func.result, namedTypes)
      : 'void';
    const retType = func.isAsync && baseRetType !== 'void'
      ? `${wrapComplex(baseRetType)} | Promise<${wrapComplex(baseRetType)}>`
      : baseRetType;
    const key = isValidIdent(func.name) ? func.name : `'${func.name}'`;
    lines.push(`  ${key}(${paramList}): ${retType};`);
  }
  // For methods that return bare Future<T>, add an explicit [async] variant
  // with the unwrapped return type T | Promise<T>.
  for (const func of funcs) {
    if (func.name.startsWith('[resource-drop]')) continue;
    const inner = unwrapFuture(func.result);
    if (inner === null) continue;
    const aName = asyncName(func.name);
    const paramList = func.params
      .map(p => `${p.name}: ${hostValTypeToTS(p.type, namedTypes)}`)
      .join(', ');
    const baseRetType = hostValTypeToTS(inner, namedTypes);
    const retType = baseRetType !== 'void'
      ? `${wrapComplex(baseRetType)} | Promise<${wrapComplex(baseRetType)}>`
      : baseRetType;
    lines.push(`  '${aName}'(${paramList}): ${retType};`);
  }
  lines.push('}');
  lines.push('');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Emit TypeScript source declaring interfaces for all WASI host imports,
 * derived from parsed WIT packages.
 */
export function emitHostImportTypesFromWit(p3Packages: WitPackage[], p2Packages: WitPackage[]): string {
  const sigs = witPackagesToSigs(p3Packages, p2Packages);

  // Collect all funcs for stream/future detection
  const allFuncs: HostFuncSig[] = [];
  for (const scoped of sigs.values()) {
    if (scoped.p3) allFuncs.push(...scoped.p3);
    if (scoped.p2) allFuncs.push(...scoped.p2);
  }

  // Build named types from WIT definitions (P3 only for naming)
  const globalTypes = buildGlobalTypes([...p3Packages, ...p2Packages]);
  const { namedTypes, nameToType } = buildNamedTypesFromWit(p3Packages, globalTypes);

  const lines: string[] = [];
  lines.push('// Auto-generated WASI host import types.');
  lines.push('// Do not edit manually — regenerate with: npm run gen-host-types');
  lines.push('');

  // Check if any stream/future types are used
  const hasStream = hasTypeTagInFuncs(allFuncs, 'stream');
  const hasFuture = hasTypeTagInFuncs(allFuncs, 'future');
  if (hasStream || hasFuture) {
    if (hasStream) {
      lines.push('/** Handle to a stream carrying elements of type T. At the ABI level, this is a number (handle index). */');
      lines.push('export type Stream<_T> = number;');
    }
    if (hasFuture) {
      lines.push('/** Handle to a future resolving to a value of type T. At the ABI level, this is a number (handle index). */');
      lines.push('export type Future<_T> = number;');
    }
    lines.push('');
  }

  // Emit named type aliases
  const emittedNames = new Set<string>();
  for (const [key, name] of namedTypes) {
    if (emittedNames.has(name)) continue;
    emittedNames.add(name);

    const ty = nameToType.get(name);
    if (!ty) continue;

    if (typeof ty === 'object' && ty.tag === 'enum') {
      const entries = ty.names.map(n => `  ${kebabToPascal(n)}: '${n}'`);
      lines.push(`export const ${name} = {`);
      lines.push(entries.join(',\n'));
      lines.push('} as const;');
      lines.push(`export type ${name} = typeof ${name}[keyof typeof ${name}];`);
    } else {
      // For non-enum named types, exclude self from named type map to avoid circular references
      const selfExcluded = new Map(namedTypes);
      selfExcluded.delete(key);
      const ts = hostValTypeToTS(ty, selfExcluded);
      lines.push(`export type ${name} =`);
      lines.push(`  ${ts};`);
    }
    lines.push('');
  }

  // Emit interfaces — separate for P2 and P3 when both exist
  let hasP2 = false, hasP3 = false;
  for (const [iface, scoped] of sigs) {
    const baseName = ifaceToTSName(iface);
    const hasBoth = !!scoped.p2 && !!scoped.p3;

    if (scoped.p3) {
      hasP3 = true;
      emitInterface(lines, baseName, scoped.p3, namedTypes);
    }
    if (scoped.p2) {
      hasP2 = true;
      const p2Name = hasBoth ? baseName + 'P2' : baseName;
      emitInterface(lines, p2Name, scoped.p2, namedTypes);
    }
  }

  // Emit WasiHostInterfaces type
  if (sigs.size > 0 && (hasP2 || hasP3)) {
    // WithAliases: adds both [async] aliases from sync methods AND
    // sync stubs from [async] methods (auto-generated at runtime).
    lines.push('type AsyncKey<K extends string> =');
    lines.push("  K extends `[${infer P}]${infer R}` ? `[async ${P}]${R}` : `[async]${K}`;");
    lines.push('type SyncKey<K extends string> =');
    lines.push("  K extends `[async]${infer R}` ? R :");
    lines.push("  K extends `[async ${infer P}]${infer R}` ? `[${P}]${R}` : never;");
    lines.push('type WithAliases<T> = T & {');
    lines.push('  [K in keyof T as K extends string ?');
    lines.push("    (K extends `[async${string}` ? never :");
    lines.push("     K extends `[resource-drop]${string}` ? never :");
    lines.push('     AsyncKey<K> extends keyof T ? never :');
    lines.push('     AsyncKey<K>) : never]:');
    lines.push('    T[K] extends (...args: infer A) => infer R');
    lines.push('      ? (...args: A) => R | Promise<Awaited<R>>');
    lines.push('      : T[K];');
    lines.push('} & {');
    lines.push('  [K in keyof T as K extends string ?');
    lines.push("    (K extends `[async]${string}` | `[async ${string}` ?");
    lines.push('      SyncKey<K> extends keyof T ? never : SyncKey<K>');
    lines.push('    : never) : never]:');
    lines.push('    (...args: any[]) => any;');
    lines.push('};');
    lines.push('');

    // Version type aliases
    const p3Versions = deriveVersions(p3Packages);
    const p2Versions = deriveVersions(p2Packages);
    if (hasP3 && p3Versions.length > 0)
      lines.push(`type P3Version = ${p3Versions.map(v => `'${v}'`).join(' | ')};`);
    if (hasP2 && p2Versions.length > 0)
      lines.push(`type P2Version = ${p2Versions.map(v => `'${v}'`).join(' | ')};`);
    lines.push('');

    // Build WasiHostInterfaces as intersection of mapped types
    const parts: string[] = [];
    for (const [bare, scoped] of sigs) {
      const baseName = ifaceToTSName(bare);
      const hasBoth = !!scoped.p2 && !!scoped.p3;
      if (scoped.p3)
        parts.push(`  { [K in \`${bare}@\${P3Version}\`]: WithAliases<${baseName}> }`);
      if (scoped.p2) {
        const p2Name = hasBoth ? baseName + 'P2' : baseName;
        parts.push(`  { [K in \`${bare}@\${P2Version}\`]: ${p2Name} }`);
      }
    }
    lines.push('export type WasiHostInterfaces =');
    lines.push(parts.join('\n  & ') + ';');
    lines.push('');
  }

  return lines.join('\n');
}

/** Derive version strings from WIT packages (matching createWasiHost registration). */
function deriveVersions(packages: WitPackage[]): string[] {
  const versions = new Set<string>();
  for (const pkg of packages) {
    versions.add(pkg.version);
  }
  // All packages in a family should share a version, but collect all unique ones
  const ver = [...versions].sort()[0];
  if (!ver) return [];

  // For P2 (0.2.x): expand to all patch versions 0.2.0 through 0.2.{patch}
  if (ver.startsWith('0.2.')) {
    const patch = parseInt(ver.split('.')[2]!, 10);
    return Array.from({ length: patch + 1 }, (_, i) => `0.2.${i}`);
  }

  // For P3 (0.3.0-rc-...): list known RC versions matching createWasiHost
  if (ver.startsWith('0.3.')) {
    return ['0.3.0-rc-2025-09-16', ver].filter((v, i, a) => a.indexOf(v) === i).sort();
  }

  return [ver];
}

/** Convert a WASI interface name to a TypeScript interface name. */
function ifaceToTSName(iface: string): string {
  const bare = iface.replace(/@.*$/, '');
  const parts = bare.split(/[:/]/);
  return parts.map(p =>
    p.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
  ).join('');
}

/** Convert a kebab-case WIT name to PascalCase for use as a const key. */
function kebabToPascal(s: string): string {
  return s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}
