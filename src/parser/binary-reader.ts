/**
 * Low-level binary cursor over a Uint8Array.
 * Handles LEB128 encoding, strings, and vectors as used in the component model binary format.
 */
export class BinaryReader {
  private data: Uint8Array;
  private pos: number;
  private view: DataView;

  constructor(data: Uint8Array, offset = 0) {
    this.data = data;
    this.pos = offset;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get position(): number {
    return this.pos;
  }

  set position(p: number) {
    this.pos = p;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  get length(): number {
    return this.data.length;
  }

  readU8(): number {
    if (this.pos >= this.data.length) {
      throw new Error(`unexpected end of data at offset ${this.pos}`);
    }
    return this.data[this.pos++]!;
  }

  peekU8(): number {
    if (this.pos >= this.data.length) {
      throw new Error(`unexpected end of data at offset ${this.pos}`);
    }
    return this.data[this.pos]!;
  }

  /** Read an unsigned LEB128 integer (up to 32 bits). */
  readU32LEB(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.readU8();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift >= 35) {
        throw new Error(`LEB128 overflow at offset ${this.pos}`);
      }
    }
    // Convert to unsigned 32-bit
    return result >>> 0;
  }

  /** Read a signed LEB128 integer (up to 33 bits, for type indices). */
  readS33LEB(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    for (;;) {
      byte = this.readU8();
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift >= 40) {
        throw new Error(`LEB128 overflow at offset ${this.pos}`);
      }
    }
    // Sign extend if needed
    if (shift < 33 && (byte & 0x40) !== 0) {
      result |= -(1 << shift);
    }
    return result;
  }

  /** Read a LEB128 length-prefixed UTF-8 string. */
  readString(): string {
    const len = this.readU32LEB();
    const bytes = this.readBytes(len);
    return new TextDecoder().decode(bytes);
  }

  /** Read a LEB128-prefixed vector of items. */
  readVec<T>(fn: () => T): T[] {
    const count = this.readU32LEB();
    const items: T[] = [];
    for (let i = 0; i < count; i++) {
      items.push(fn());
    }
    return items;
  }

  /** Read N raw bytes. */
  readBytes(n: number): Uint8Array {
    if (this.pos + n > this.data.length) {
      throw new Error(
        `cannot read ${n} bytes at offset ${this.pos} (only ${this.remaining} remaining)`,
      );
    }
    const slice = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  /** Skip N bytes. */
  skip(n: number): void {
    if (this.pos + n > this.data.length) {
      throw new Error(
        `cannot skip ${n} bytes at offset ${this.pos} (only ${this.remaining} remaining)`,
      );
    }
    this.pos += n;
  }

  /** Create a sub-reader for a section of the data. */
  subReader(length: number): BinaryReader {
    const sub = new BinaryReader(this.data.subarray(this.pos, this.pos + length));
    this.pos += length;
    return sub;
  }

  /** Read a 32-bit unsigned integer (little-endian). */
  readU32(): number {
    if (this.pos + 4 > this.data.length) {
      throw new Error(`cannot read u32 at offset ${this.pos}`);
    }
    const val = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return val;
  }
}
