import { describe, it, assert } from '../runner.ts';
import { BinaryReader } from '../../src/parser/binary-reader.ts';

describe('BinaryReader', () => {
  describe('readU8', () => {
    it('reads single bytes', () => {
      const r = new BinaryReader(new Uint8Array([0x00, 0x42, 0xff]));
      assert.strictEqual(r.readU8(), 0x00);
      assert.strictEqual(r.readU8(), 0x42);
      assert.strictEqual(r.readU8(), 0xff);
    });

    it('throws at end of data', () => {
      const r = new BinaryReader(new Uint8Array([0x42]));
      r.readU8();
      assert.throws(() => r.readU8(), /unexpected end of data/);
    });
  });

  describe('readU32LEB', () => {
    it('reads 0', () => {
      const r = new BinaryReader(new Uint8Array([0x00]));
      assert.strictEqual(r.readU32LEB(), 0);
    });

    it('reads 127 (single byte max)', () => {
      const r = new BinaryReader(new Uint8Array([0x7f]));
      assert.strictEqual(r.readU32LEB(), 127);
    });

    it('reads 128 (two bytes)', () => {
      const r = new BinaryReader(new Uint8Array([0x80, 0x01]));
      assert.strictEqual(r.readU32LEB(), 128);
    });

    it('reads 624485', () => {
      // 624485 = 0x98765 → LEB128: [0xe5, 0x8e, 0x26]
      const r = new BinaryReader(new Uint8Array([0xe5, 0x8e, 0x26]));
      assert.strictEqual(r.readU32LEB(), 624485);
    });

    it('reads max u32 (4294967295)', () => {
      const r = new BinaryReader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]));
      assert.strictEqual(r.readU32LEB(), 4294967295);
    });

    it('reads 1', () => {
      const r = new BinaryReader(new Uint8Array([0x01]));
      assert.strictEqual(r.readU32LEB(), 1);
    });
  });

  describe('readS33LEB', () => {
    it('reads 0', () => {
      const r = new BinaryReader(new Uint8Array([0x00]));
      assert.strictEqual(r.readS33LEB(), 0);
    });

    it('reads -1', () => {
      const r = new BinaryReader(new Uint8Array([0x7f]));
      assert.strictEqual(r.readS33LEB(), -1);
    });

    it('reads positive values', () => {
      const r = new BinaryReader(new Uint8Array([0x80, 0x01]));
      assert.strictEqual(r.readS33LEB(), 128);
    });

    it('reads -64', () => {
      const r = new BinaryReader(new Uint8Array([0x40]));
      assert.strictEqual(r.readS33LEB(), -64);
    });
  });

  describe('readString', () => {
    it('reads empty string', () => {
      const r = new BinaryReader(new Uint8Array([0x00]));
      assert.strictEqual(r.readString(), '');
    });

    it('reads ASCII string', () => {
      const r = new BinaryReader(new Uint8Array([0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]));
      assert.strictEqual(r.readString(), 'hello');
    });

    it('reads UTF-8 string', () => {
      // "café" in UTF-8: 63 61 66 c3 a9
      const r = new BinaryReader(new Uint8Array([0x05, 0x63, 0x61, 0x66, 0xc3, 0xa9]));
      assert.strictEqual(r.readString(), 'café');
    });
  });

  describe('readVec', () => {
    it('reads empty vector', () => {
      const r = new BinaryReader(new Uint8Array([0x00]));
      assert.deepStrictEqual(r.readVec(() => r.readU8()), []);
    });

    it('reads vector of bytes', () => {
      const r = new BinaryReader(new Uint8Array([0x03, 0x0a, 0x0b, 0x0c]));
      assert.deepStrictEqual(r.readVec(() => r.readU8()), [0x0a, 0x0b, 0x0c]);
    });
  });

  describe('readBytes', () => {
    it('reads raw bytes', () => {
      const r = new BinaryReader(new Uint8Array([0x01, 0x02, 0x03]));
      const bytes = r.readBytes(2);
      assert.deepStrictEqual(Array.from(bytes), [0x01, 0x02]);
      assert.strictEqual(r.position, 2);
    });

    it('throws when not enough bytes', () => {
      const r = new BinaryReader(new Uint8Array([0x01]));
      assert.throws(() => r.readBytes(5), /cannot read 5 bytes/);
    });
  });

  describe('position and remaining', () => {
    it('tracks position', () => {
      const r = new BinaryReader(new Uint8Array([0x01, 0x02, 0x03]));
      assert.strictEqual(r.position, 0);
      assert.strictEqual(r.remaining, 3);
      r.readU8();
      assert.strictEqual(r.position, 1);
      assert.strictEqual(r.remaining, 2);
    });
  });

  describe('skip', () => {
    it('skips bytes', () => {
      const r = new BinaryReader(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
      r.skip(2);
      assert.strictEqual(r.readU8(), 0x03);
    });
  });

  describe('subReader', () => {
    it('creates sub-reader with correct bounds', () => {
      const r = new BinaryReader(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]));
      r.readU8(); // skip first byte
      const sub = r.subReader(3);
      assert.strictEqual(sub.length, 3);
      assert.strictEqual(sub.readU8(), 0x02);
      assert.strictEqual(sub.readU8(), 0x03);
      assert.strictEqual(sub.readU8(), 0x04);
      assert.strictEqual(r.position, 4); // parent advanced past sub-reader range
    });
  });
});
