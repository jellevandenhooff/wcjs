/**
 * Instance type scope resolution for host import type extraction.
 *
 * These functions resolve component-level type definitions within instance
 * type scopes (e.g., WIT interface type sections) into HostValType descriptors.
 * Used by the linker to extract typed import signatures for host bindings.
 */

import type {
  ComponentTypeEntry, ComponentValType, InstanceTypeDecl, DefinedType,
} from '../parser/types.ts';
import type { HostFuncTypeInfo, HostValType } from './host-types.ts';

// -----------------------------------------------------------------------
// Local type definitions (scoped to an instance type, not global)
// -----------------------------------------------------------------------

/**
 * A local type definition within an instance type scope.
 * These are NOT added to the global compTypes — they're scoped to the instance.
 */
type LocalTypeDef =
  | { tag: 'defined'; hvt: HostValType }
  | { tag: 'func'; paramTypes: HostValType[]; resultType: HostValType | null }
  | { tag: 'other' };

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Extract function export type information from an instance type's declarations.
 * Mirrors Rust's pending_instance_type_exports logic.
 * The optional hostValTypes map provides fallback type resolution for types
 * that aren't in parentCompTypes (e.g., types created by later alias operations).
 */
export function extractInstanceExportTypes(
  entries: InstanceTypeDecl[],
  parentCompTypes: ComponentTypeEntry[],
  hostValTypes?: Map<number, HostValType>,
): { funcTypes: Map<string, HostFuncTypeInfo>; valTypes: Map<string, HostValType> } {
  const localTypes: LocalTypeDef[] = [];
  // Track local index → parent type index mapping for outer aliases (needed for resource types)
  const localToParentIdx = new Map<number, number>();
  const funcTypes = new Map<string, HostFuncTypeInfo>();
  const valTypes = new Map<string, HostValType>();

  // Pre-scan: build localIdx → exportName map for resource type resolution.
  // Resource exports (subResource bounds) get local type indices, and own(localIdx)
  // in function types references these indices. We track which local indices
  // correspond to resource exports so convertDefinedTypeLocal can produce named forms.
  const localToResourceName = new Map<number, string>();
  {
    let scanIdx = 0;
    for (const decl of entries) {
      if (decl.tag === 'type') {
        scanIdx++;
      } else if (decl.tag === 'alias') {
        scanIdx++;
      } else if (decl.tag === 'exportType' && decl.type.tag === 'type') {
        if (decl.type.bounds?.tag === 'subResource') {
          localToResourceName.set(scanIdx, decl.name);
        } else if (decl.type.bounds?.tag === 'eq') {
          // Propagate resource name through type aliases (e.g. `type headers = fields`)
          const targetName = localToResourceName.get(decl.type.bounds.typeIndex);
          if (targetName !== undefined) {
            localToResourceName.set(scanIdx, targetName);
          }
        }
        scanIdx++;
      }
      // func exports don't push to localTypes, no index increment
    }
  }

  for (const decl of entries) {
    switch (decl.tag) {
      case 'type': {
        const localDef = parseLocalComponentType(decl.entry, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName);
        localTypes.push(localDef);
        break;
      }
      case 'alias': {
        if (decl.alias.tag === 'outer' && decl.alias.sort === 'type') {
          // Resolve from parent's comp_types
          const resolved = parentCompTypes[decl.alias.index];
          let localDef = resolveOuterType(resolved, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName);
          // If not resolved and hostValTypes has it, use that directly
          if (localDef.tag === 'other' && hostValTypes) {
            const hvt = hostValTypes.get(decl.alias.index);
            if (hvt) localDef = { tag: 'defined', hvt };
          }
          localToParentIdx.set(localTypes.length, decl.alias.index);
          localTypes.push(localDef);
        } else {
          localTypes.push({ tag: 'other' });
        }
        break;
      }
      case 'exportType': {
        if (decl.type.tag === 'func') {
          const localIdx = decl.type.typeIndex;
          const lt = localTypes[localIdx];
          if (lt?.tag === 'func') {
            funcTypes.set(decl.name, {
              paramTypes: lt.paramTypes,
              resultType: lt.resultType,
            });
          }
        } else if (decl.type.tag === 'type') {
          // Type exports consume a local type index.
          // Propagate type definition and localToParentIdx from bounds.
          let exportedDef: LocalTypeDef = { tag: 'other' };
          if (decl.type.bounds?.tag === 'eq') {
            const boundsIdx = decl.type.bounds.typeIndex;
            const parentIdx = localToParentIdx.get(boundsIdx);
            if (parentIdx !== undefined) {
              localToParentIdx.set(localTypes.length, parentIdx);
            }
            // Propagate the local type definition so subsequent refs resolve correctly
            const boundsType = localTypes[boundsIdx];
            if (boundsType && boundsType.tag !== 'other') {
              exportedDef = boundsType;
            }
          }
          // Collect exported type definitions (e.g., records, enums) for byte size computation
          if (exportedDef.tag === 'defined') {
            valTypes.set(decl.name, exportedDef.hvt);
          }
          localTypes.push(exportedDef);
        }
        break;
      }
    }
  }

  return { funcTypes, valTypes };
}

/**
 * Convert a ComponentValType to HostValType using local type scope.
 * Exported for use by the resolver when converting types outside instance scopes.
 */
export function convertValTypeLocal(
  vt: ComponentValType,
  localTypes: LocalTypeDef[],
  parentCompTypes: ComponentTypeEntry[],
  localToParentIdx?: Map<number, number>,
  hostValTypes?: Map<number, HostValType>,
  localToResourceName?: Map<number, string>,
): HostValType {
  if (vt.tag === 'primitive') {
    return vt.type as HostValType;
  }
  // typeIndex — try local first, then parent
  const local = localTypes[vt.index];
  if (local?.tag === 'defined') return local.hvt;

  // Fall back to parent comp types
  const parent = parentCompTypes[vt.index];
  if (parent) {
    const resolved = resolveOuterType(parent, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName);
    if (resolved.tag === 'defined') return resolved.hvt;
  }

  // Fall back to hostValTypes (for types created by later alias operations)
  if (hostValTypes) {
    const hvt = hostValTypes.get(vt.index);
    if (hvt) return hvt;
  }

  return 'u32'; // fallback
}

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

/** Parse a ComponentTypeEntry from an inner instance type scope into a LocalTypeDef. */
function parseLocalComponentType(
  entry: ComponentTypeEntry,
  localTypes: LocalTypeDef[],
  parentCompTypes: ComponentTypeEntry[],
  localToParentIdx?: Map<number, number>,
  hostValTypes?: Map<number, HostValType>,
  localToResourceName?: Map<number, string>,
): LocalTypeDef {
  if (entry.tag === 'func') {
    const paramTypes = entry.type.params.map(p =>
      convertValTypeLocal(p.type, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName));
    const resultType = entry.type.result
      ? convertValTypeLocal(entry.type.result, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName)
      : null;
    return { tag: 'func', paramTypes, resultType };
  }
  if (entry.tag === 'defined') {
    const hvt = convertDefinedTypeLocal(entry.type, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName);
    return { tag: 'defined', hvt };
  }
  if (entry.tag === 'resource') {
    return { tag: 'defined', hvt: 'own' };
  }
  return { tag: 'other' };
}

/** Resolve an outer type alias to a LocalTypeDef. */
function resolveOuterType(
  resolved: ComponentTypeEntry | undefined,
  localTypes: LocalTypeDef[],
  parentCompTypes: ComponentTypeEntry[],
  localToParentIdx?: Map<number, number>,
  hostValTypes?: Map<number, HostValType>,
  localToResourceName?: Map<number, string>,
): LocalTypeDef {
  if (!resolved) return { tag: 'other' };
  if (resolved.tag === 'defined') {
    const hvt = convertDefinedTypeLocal(resolved.type, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName);
    return hvt === 'u32' && resolved.type.tag !== 'errorContext'
      ? { tag: 'other' }
      : { tag: 'defined', hvt };
  }
  if (resolved.tag === 'func') {
    const paramTypes = resolved.type.params.map(p =>
      convertValTypeLocal(p.type, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName));
    const resultType = resolved.type.result
      ? convertValTypeLocal(resolved.type.result, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName)
      : null;
    return { tag: 'func', paramTypes, resultType };
  }
  if (resolved.tag === 'resource') {
    return { tag: 'defined', hvt: 'own' };
  }
  return { tag: 'other' };
}

/** Convert a DefinedType to HostValType using local type scope. */
function convertDefinedTypeLocal(
  def: DefinedType,
  localTypes: LocalTypeDef[],
  parentCompTypes: ComponentTypeEntry[],
  localToParentIdx?: Map<number, number>,
  hostValTypes?: Map<number, HostValType>,
  localToResourceName?: Map<number, string>,
): HostValType {
  switch (def.tag) {
    case 'primitive': return def.type as HostValType;
    case 'list':
      return { tag: 'list', elem: convertValTypeLocal(def.elementType, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName) };
    case 'tuple': {
      const elems = def.types.map(t => convertValTypeLocal(t, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName));
      return { tag: 'tuple', elems };
    }
    case 'option':
      return { tag: 'option', inner: convertValTypeLocal(def.type, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName) };
    case 'result':
      return {
        tag: 'result',
        ok: def.ok ? convertValTypeLocal(def.ok, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName) : null,
        err: def.err ? convertValTypeLocal(def.err, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName) : null,
      };
    case 'enum': return { tag: 'enum', names: def.names };
    case 'flags': return { tag: 'flags', count: def.names.length };
    case 'variant': {
      const cases = def.cases.map((c: { name: string; type: ComponentValType | null }) => ({
        name: c.name,
        type: c.type ? convertValTypeLocal(c.type, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName) : null,
      }));
      return { tag: 'variant', cases };
    }
    case 'record': {
      const fields = def.fields.map(f => ({
        name: f.name,
        type: convertValTypeLocal(f.type, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName),
      }));
      return { tag: 'record', fields };
    }
    case 'own': {
      const parentIdx = localToParentIdx?.get(def.typeIndex);
      if (parentIdx !== undefined) return { tag: 'own', tableIdx: parentIdx };
      const name = localToResourceName?.get(def.typeIndex);
      if (name !== undefined) return { tag: 'own', name };
      return 'own';
    }
    case 'borrow': {
      const parentIdx = localToParentIdx?.get(def.typeIndex);
      if (parentIdx !== undefined) return { tag: 'borrow', tableIdx: parentIdx };
      const name = localToResourceName?.get(def.typeIndex);
      if (name !== undefined) return { tag: 'borrow', name };
      return 'borrow';
    }
    case 'stream': {
      const elem = def.type
        ? convertValTypeLocal(def.type, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName)
        : null;
      return { tag: 'stream', elem };
    }
    case 'future': {
      const elem = def.type
        ? convertValTypeLocal(def.type, localTypes, parentCompTypes, localToParentIdx, hostValTypes, localToResourceName)
        : null;
      return { tag: 'future', elem };
    }
    case 'errorContext': return 'u32';
    default: return 'u32';
  }
}
