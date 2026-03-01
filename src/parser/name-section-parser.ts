/**
 * Parse the `component-name` custom section.
 *
 * Binary format:
 *   - Subsection ID 0: component name (string)
 *   - Subsection ID 1: sort names — sort encoding + namemap
 *     Sort encoding: 0x00 + byte2 for core sorts, single byte for component sorts
 *     Namemap: vec<(u32 index, string name)>
 */
import { BinaryReader } from './binary-reader.ts';
import type { ComponentNames } from './types.ts';

export function createEmptyNames(): ComponentNames {
  return {
    coreFunc: new Map(),
    coreTable: new Map(),
    coreMemory: new Map(),
    coreGlobal: new Map(),
    coreModule: new Map(),
    coreInstance: new Map(),
    func: new Map(),
    type: new Map(),
    component: new Map(),
    instance: new Map(),
  };
}

export function readComponentNameSection(r: BinaryReader): ComponentNames {
  const names = createEmptyNames();

  while (r.remaining > 0) {
    const subsectionId = r.readU8();
    const subsectionSize = r.readU32LEB();
    const sub = r.subReader(subsectionSize);

    switch (subsectionId) {
      case 0: {
        // Component name
        names.componentName = sub.readString();
        break;
      }
      case 1: {
        // Sort names
        const sortByte = sub.readU8();
        let target: Map<number, string> | null = null;

        if (sortByte === 0x00) {
          // Core sort — read second discriminant byte
          const coreSortByte = sub.readU8();
          switch (coreSortByte) {
            case 0x00: target = names.coreFunc; break;
            case 0x01: target = names.coreTable; break;
            case 0x02: target = names.coreMemory; break;
            case 0x03: target = names.coreGlobal; break;
            case 0x11: target = names.coreModule; break;
            case 0x12: target = names.coreInstance; break;
          }
        } else {
          // Component sort
          switch (sortByte) {
            case 0x01: target = names.func; break;
            case 0x03: target = names.type; break;
            case 0x04: target = names.component; break;
            case 0x05: target = names.instance; break;
          }
        }

        if (target) {
          readNameMap(sub, target);
        }
        // else: unknown sort, skip (sub already consumed by subReader)
        break;
      }
      default:
        // Unknown subsection, skip (already consumed by subReader)
        break;
    }
  }

  return names;
}

function readNameMap(r: BinaryReader, map: Map<number, string>): void {
  const count = r.readU32LEB();
  for (let i = 0; i < count; i++) {
    const index = r.readU32LEB();
    const name = r.readString();
    map.set(index, name);
  }
}
