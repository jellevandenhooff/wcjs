// In-memory filesystem for WASI P3
//
// Provides wasi:filesystem/types and wasi:filesystem/preopens backed by
// an in-memory tree. Files are stored as Uint8Array; directories as Maps.
//
// Browser-safe: uses only TextEncoder/TextDecoder.

import type { HostContext } from './wasi-shared.ts';

// Error codes — component model uses kebab-case string variant names
const E = {
  Access: 'access', Already: 'already', BadDescriptor: 'bad-descriptor',
  Busy: 'busy', Deadlock: 'deadlock', Quota: 'quota', Exist: 'exist',
  FileTooLarge: 'file-too-large', IllegalByteSequence: 'illegal-byte-sequence',
  InProgress: 'in-progress', Interrupted: 'interrupted', Invalid: 'invalid',
  Io: 'io', IsDirectory: 'is-directory', Loop: 'loop',
  TooManyLinks: 'too-many-links', MessageSize: 'message-size',
  NameTooLong: 'name-too-long', NoDevice: 'no-device', NoEntry: 'no-entry',
  NoLock: 'no-lock', InsufficientMemory: 'insufficient-memory',
  InsufficientSpace: 'insufficient-space', NotDirectory: 'not-directory',
  NotEmpty: 'not-empty', NotRecoverable: 'not-recoverable',
  Unsupported: 'unsupported', NoTty: 'no-tty', NoSuchDevice: 'no-such-device',
  Overflow: 'overflow', NotPermitted: 'not-permitted', Pipe: 'pipe',
  ReadOnly: 'read-only', InvalidSeek: 'invalid-seek',
  TextFileBusy: 'text-file-busy', CrossDevice: 'cross-device',
} as const;

// Descriptor type enum
const DT = {
  Unknown: 'unknown', BlockDevice: 'block-device',
  CharacterDevice: 'character-device', Directory: 'directory',
  Fifo: 'fifo', SymbolicLink: 'symbolic-link',
  RegularFile: 'regular-file', Socket: 'socket',
} as const;

// Descriptor flags
const DF = { READ: 1, WRITE: 2, MUTATE_DIRECTORY: 32 } as const;

// Open flags
const OF = { CREATE: 1, DIRECTORY: 2, EXCLUSIVE: 4, TRUNCATE: 8 } as const;

const encoder = new TextEncoder();

// ---- In-memory FS node types ----
class FsFile {
  buf: Uint8Array;
  len: number;
  mtime: number;
  atime: number;
  ctime: number;
  _fetchUrl: string | null = null;

  constructor(data: Uint8Array | string = new Uint8Array(0)) {
    const src = data instanceof Uint8Array ? data : encoder.encode(data);
    this.buf = new Uint8Array(src.length);
    this.buf.set(src);
    this.len = src.length;
    this.mtime = Date.now();
    this.atime = Date.now();
    this.ctime = Date.now();
  }

  get data(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }

  set data(v: Uint8Array) {
    this.buf = v;
    this.len = v.length;
  }

  setLazyUrl(url: string, size: number): void {
    this._fetchUrl = url;
    this.len = size;
    this.buf = new Uint8Array(0);
  }

  async ensureLoaded(): Promise<void> {
    if (!this._fetchUrl) return;
    const url = this._fetchUrl;
    this._fetchUrl = null;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url}: ${resp.status}`);
    let data: Uint8Array;
    if (url.endsWith('.gz')) {
      const ds = new DecompressionStream('gzip');
      const decompressed = resp.body!.pipeThrough(ds);
      data = new Uint8Array(await new Response(decompressed).arrayBuffer());
    } else {
      data = new Uint8Array(await resp.arrayBuffer());
    }
    this.buf = data;
    this.len = data.length;
  }

  _grow(needed: number): void {
    if (needed <= this.buf.length) return;
    let cap = this.buf.length || 64;
    while (cap < needed) cap *= 2;
    const newBuf = new Uint8Array(cap);
    newBuf.set(this.buf.subarray(0, this.len));
    this.buf = newBuf;
  }

  writeAt(chunk: Uint8Array, pos: number): void {
    this._grow(pos + chunk.length);
    this.buf.set(chunk, pos);
    if (pos + chunk.length > this.len) this.len = pos + chunk.length;
    this.mtime = Date.now();
  }

  append(chunk: Uint8Array): void {
    this.writeAt(chunk, this.len);
  }
}

class FsDir {
  entries: Map<string, FsFile | FsDir | FsSymlink> = new Map();
  mtime: number = Date.now();
  atime: number = Date.now();
  ctime: number = Date.now();
}

class FsSymlink {
  target: string;
  mtime: number = Date.now();
  constructor(target: string) {
    this.target = target;
  }
}

type FsNode = FsFile | FsDir | FsSymlink;

// ---- MemFS: the in-memory filesystem tree ----
export class MemFS {
  root: FsDir = new FsDir();

  addFile(path: string, data: Uint8Array | string): void {
    const parts = splitPath(path);
    const name = parts.pop()!;
    const dir = this._mkdirp(parts);
    dir.entries.set(name, new FsFile(data));
  }

  addDir(path: string): void {
    this._mkdirp(splitPath(path));
  }

  addLazyFile(path: string, url: string, size: number): void {
    const parts = splitPath(path);
    const name = parts.pop()!;
    const dir = this._mkdirp(parts);
    const file = new FsFile();
    file.setLazyUrl(url, size);
    dir.entries.set(name, file);
  }

  addSymlink(path: string, target: string): void {
    const parts = splitPath(path);
    const name = parts.pop()!;
    const dir = this._mkdirp(parts);
    dir.entries.set(name, new FsSymlink(target));
  }

  async populateFromHost(guestPath: string, hostPath: string, opts: { maxDepth?: number; filter?: (gp: string, ent: any) => boolean } = {}): Promise<void> {
    const fs = await import('node:fs');
    const nodePath = await import('node:path');
    const maxDepth = opts.maxDepth ?? 20;
    const filter = opts.filter ?? (() => true);

    const walk = (guest: string, host: string, depth: number): void => {
      if (depth > maxDepth) return;
      let entries: any[];
      try { entries = fs.readdirSync(host, { withFileTypes: true }); }
      catch { return; }
      for (const ent of entries) {
        const gp = guest + '/' + ent.name;
        const hp = nodePath.join(host, ent.name);
        if (!filter(gp, ent)) continue;
        if (ent.isDirectory()) {
          this.addDir(gp);
          walk(gp, hp, depth + 1);
        } else if (ent.isFile()) {
          this.addFile(gp, new Uint8Array(fs.readFileSync(hp)));
        } else if (ent.isSymbolicLink()) {
          try {
            const target = fs.readlinkSync(hp);
            this.addSymlink(gp, target);
          } catch {}
        }
      }
    };
    walk(guestPath, hostPath, 0);
  }

  _resolve(parts: string[]): FsNode | null {
    let node: FsNode = this.root;
    for (let i = 0; i < parts.length; i++) {
      if (!(node instanceof FsDir)) return null;
      const child: FsNode | undefined = node.entries.get(parts[i]!);
      if (!child) return null;
      if (child instanceof FsSymlink) {
        const target = splitPath(
          child.target.startsWith('/') ? child.target : parts.slice(0, i).join('/') + '/' + child.target
        );
        return this._resolve([...target, ...parts.slice(i + 1)]);
      }
      node = child;
    }
    return node;
  }

  _resolveParent(parts: string[]): { parent: FsNode | null; name: string | null } {
    if (parts.length === 0) return { parent: null, name: null };
    const name = parts[parts.length - 1]!;
    const parent = this._resolve(parts.slice(0, -1));
    return { parent, name };
  }

  _mkdirp(parts: string[]): FsDir {
    let node: FsNode = this.root;
    for (const p of parts) {
      if (!(node instanceof FsDir)) throw new Error(`not a directory: ${p}`);
      if (!node.entries.has(p)) {
        node.entries.set(p, new FsDir());
      }
      const child: FsNode = node.entries.get(p)!;
      if (child instanceof FsSymlink) {
        const target = this._resolve(splitPath(child.target));
        if (target instanceof FsDir) { node = target; continue; }
        throw new Error(`symlink target is not a directory`);
      }
      node = child;
    }
    return node as FsDir;
  }
}

function splitPath(p: string): string[] {
  return p.split('/').filter(s => s.length > 0);
}

function nodeToStat(node: FsNode): Record<string, any> | null {
  const toTs = (ms: number) => ms ? { seconds: BigInt(Math.floor(ms / 1000)), nanoseconds: Math.round((ms % 1000) * 1e6) } : null;
  if (node instanceof FsFile) {
    return {
      'type': DT.RegularFile, 'link-count': 1n, 'size': BigInt(node.len),
      'data-access-timestamp': toTs(node.atime),
      'data-modification-timestamp': toTs(node.mtime),
      'status-change-timestamp': toTs(node.ctime),
    };
  }
  if (node instanceof FsDir) {
    return {
      'type': DT.Directory, 'link-count': 1n, 'size': 0n,
      'data-access-timestamp': toTs(node.atime),
      'data-modification-timestamp': toTs(node.mtime),
      'status-change-timestamp': toTs(node.ctime),
    };
  }
  if (node instanceof FsSymlink) {
    return {
      'type': DT.SymbolicLink, 'link-count': 1n, 'size': BigInt(node.target.length),
      'data-access-timestamp': toTs(node.mtime),
      'data-modification-timestamp': toTs(node.mtime),
      'status-change-timestamp': toTs(node.mtime),
    };
  }
  return null;
}

// ---- WASI Host Factory ----

export function createMemFSHost(ctx: HostContext, memfs: MemFS) {
  const descriptors = new Map<number, { path: string[]; node: FsNode; flags: number }>();
  let nextId = 1;

  const rootId = nextId++;
  descriptors.set(rootId, { path: [], node: memfs.root, flags: DF.READ | DF.WRITE | DF.MUTATE_DIRECTORY });
  const preopens: [number, string][] = [[rootId, '/']];

  function getDesc(handle: number) {
    let d = descriptors.get(handle);
    if (d) return d;
    const state = ctx.state;
    if (state) {
      try {
        const rh = (state as any).getResourceHandle(handle);
        d = descriptors.get(rh.rep);
        if (d) return d;
      } catch {}
    }
    throw new Error(`invalid descriptor handle: ${handle}`);
  }

  function resolvePath(baseParts: string[], subpath: string): string[] {
    const sub = splitPath(subpath);
    const full = [...baseParts, ...sub];
    const result: string[] = [];
    for (const p of full) {
      if (p === '..') { result.pop(); }
      else if (p !== '.') { result.push(p); }
    }
    return result;
  }

  let _hostReadChunk: ((streamEnd: any) => Promise<Uint8Array | null>) | null = null;
  function getHostReadChunk() {
    if (!_hostReadChunk) {
      throw new Error('hostReadChunk not set — call setHostReadChunk()');
    }
    return _hostReadChunk;
  }

  const types: Record<string, (...args: any[]) => any> = {
    '[resource-drop]descriptor': (handle: number) => {
      descriptors.delete(handle);
    },

    '[method]descriptor.stat': (handle: number) => {
      try {
        const d = getDesc(handle);
        const s = nodeToStat(d.node);
        return s ? { tag: 'ok', val: s } : { tag: 'err', val: E.BadDescriptor };
      } catch { return { tag: 'err', val: E.BadDescriptor }; }
    },

    '[method]descriptor.stat-at': (handle: number, _pathFlags: number, path: string) => {
      try {
        const d = getDesc(handle);
        const parts = resolvePath(d.path, path);
        const node = memfs._resolve(parts);
        return node ? { tag: 'ok', val: nodeToStat(node) } : { tag: 'err', val: E.NoEntry };
      } catch { return { tag: 'err', val: E.BadDescriptor }; }
    },

    '[method]descriptor.open-at': (handle: number, pathFlags: number, path: string, openFlags: number, descFlags: number) => {
      try {
        const d = getDesc(handle);
        const parts = resolvePath(d.path, path);
        let node = memfs._resolve(parts);

        if (!node && (openFlags & OF.CREATE)) {
          const { parent, name } = memfs._resolveParent(parts);
          if (!(parent instanceof FsDir)) return { tag: 'err', val: E.NoEntry };
          node = (openFlags & OF.DIRECTORY) ? new FsDir() : new FsFile();
          parent.entries.set(name!, node);
        }
        if (!node) return { tag: 'err', val: E.NoEntry };
        if ((openFlags & OF.EXCLUSIVE)) return { tag: 'err', val: E.Exist };
        if ((openFlags & OF.DIRECTORY) && !(node instanceof FsDir)) return { tag: 'err', val: E.NotDirectory };
        if ((openFlags & OF.TRUNCATE) && node instanceof FsFile) {
          node.data = new Uint8Array(0);
          node.mtime = Date.now();
        }

        const id = nextId++;
        descriptors.set(id, { path: parts, node, flags: descFlags });
        return { tag: 'ok', val: id };
      } catch { return { tag: 'err', val: E.Io }; }
    },

    '[method]descriptor.read-via-stream': (handle: number, offset: bigint) => {
      const state = ctx.state as any;
      const d = getDesc(handle);

      const sPacked = state.streamNew(0);
      const sRi = Number(sPacked & 0xffffffffn);
      const sWi = Number(sPacked >> 32n);
      const fPacked = state.futureNew(0);
      const fRi = Number(fPacked & 0xffffffffn);
      const fWi = Number(fPacked >> 32n);

      if (!(d.node instanceof FsFile)) {
        state.streamDropWritable(0, sWi);
        state.futureWriteHost(0, fWi, [{ tag: 'err', val: E.BadDescriptor }]);
        return [sRi, fRi];
      }

      const doRead = async () => {
        try {
          if (d.node instanceof FsFile) await d.node.ensureLoaded();
          const data = (d.node as FsFile).data;
          const pos = Number(offset);
          const bytes = data.subarray(pos);
          if (bytes.length > 0) {
            const buf = {
              data: bytes,
              pos: 0,
              remain() { return bytes.length - this.pos; },
              isZeroLength() { return this.remain() <= 0; },
              read(n: number) {
                const toRead = Math.min(n, this.remain());
                if (toRead <= 0) return [];
                const items = new Array(toRead);
                for (let i = 0; i < toRead; i++) items[i] = bytes[this.pos++];
                return items;
              },
            };
            state.streamWriteHostBuffer(0, sWi, buf);
          }
          state.streamDropWritable(0, sWi);
          state.futureWriteHost(0, fWi, [{ tag: 'ok' }]);
        } catch {
          try { state.streamDropWritable(0, sWi); } catch {}
          state.futureWriteHost(0, fWi, [{ tag: 'err', val: E.Io }]);
        }
      };
      state.trackHostAsync(doRead());
      return [sRi, fRi];
    },

    '[async method]descriptor.write-via-stream': (handle: number, streamEndIdx: number, offset: bigint) => {
      const state = ctx.state as any;
      const d = getDesc(handle);
      const streamEnd = state.liftStreamEnd(0, streamEndIdx);

      if (!(d.node instanceof FsFile)) {
        streamEnd.drop();
        return { tag: 'err', val: E.BadDescriptor };
      }

      return (async () => {
        try {
          const file = d.node as FsFile;
          let pos = Number(offset);
          while (true) {
            const chunk = await getHostReadChunk()(streamEnd);
            if (!chunk) break;
            if (chunk.length > 0) {
              file.writeAt(chunk, pos);
              pos += chunk.length;
            }
          }
          return { tag: 'ok' };
        } catch {
          return { tag: 'err', val: E.Io };
        }
      })();
    },

    '[async method]descriptor.append-via-stream': (handle: number, streamEndIdx: number) => {
      const state = ctx.state as any;
      const d = getDesc(handle);
      const streamEnd = state.liftStreamEnd(0, streamEndIdx);

      if (!(d.node instanceof FsFile)) {
        streamEnd.drop();
        return { tag: 'err', val: E.BadDescriptor };
      }

      return (async () => {
        try {
          const file = d.node as FsFile;
          while (true) {
            const chunk = await getHostReadChunk()(streamEnd);
            if (!chunk) break;
            if (chunk.length > 0) {
              file.append(chunk);
            }
          }
          return { tag: 'ok' };
        } catch {
          return { tag: 'err', val: E.Io };
        }
      })();
    },

    '[method]descriptor.get-type': (handle: number) => {
      try {
        const d = getDesc(handle);
        if (d.node instanceof FsDir) return { tag: 'ok', val: DT.Directory };
        if (d.node instanceof FsFile) return { tag: 'ok', val: DT.RegularFile };
        if (d.node instanceof FsSymlink) return { tag: 'ok', val: DT.SymbolicLink };
        return { tag: 'err', val: E.BadDescriptor };
      } catch { return { tag: 'err', val: E.BadDescriptor }; }
    },

    '[method]descriptor.get-flags': (handle: number) => {
      try {
        const d = getDesc(handle);
        return { tag: 'ok', val: d.flags };
      } catch { return { tag: 'err', val: E.BadDescriptor }; }
    },

    '[method]descriptor.read-directory': (handle: number) => {
      const state = ctx.state as any;
      const d = getDesc(handle);

      const sPacked = state.streamNew(0);
      const sRi = Number(sPacked & 0xffffffffn);
      const sWi = Number(sPacked >> 32n);
      const fPacked = state.futureNew(0);
      const fRi = Number(fPacked & 0xffffffffn);
      const fWi = Number(fPacked >> 32n);

      const doReadDir = async () => {
        try {
          if (!(d.node instanceof FsDir)) {
            state.streamDropWritable(0, sWi);
            state.futureWriteHost(0, fWi, [{ tag: 'err', val: E.NotDirectory }]);
            return;
          }
          await Promise.resolve();
          const items: any[] = [];
          for (const [name, child] of d.node.entries) {
            let type = DT.Unknown as string;
            if (child instanceof FsFile) type = DT.RegularFile;
            else if (child instanceof FsDir) type = DT.Directory;
            else if (child instanceof FsSymlink) type = DT.SymbolicLink;
            items.push({ 'type': type, 'name': name });
          }
          if (items.length > 0) {
            state.streamWriteHost(0, sWi, items);
          }
          state.streamDropWritable(0, sWi);
          state.futureWriteHost(0, fWi, [{ tag: 'ok' }]);
        } catch {
          try { state.streamDropWritable(0, sWi); } catch {}
          state.futureWriteHost(0, fWi, [{ tag: 'err', val: E.Io }]);
        }
      };
      state.trackHostAsync(doReadDir());
      return [sRi, fRi];
    },

    '[method]descriptor.create-directory-at': (handle: number, path: string) => {
      try {
        const d = getDesc(handle);
        const parts = resolvePath(d.path, path);
        memfs._mkdirp(parts);
        return { tag: 'ok' };
      } catch { return { tag: 'err', val: E.Io }; }
    },

    '[method]descriptor.unlink-file-at': (handle: number, path: string) => {
      try {
        const d = getDesc(handle);
        const parts = resolvePath(d.path, path);
        const { parent, name } = memfs._resolveParent(parts);
        if (!(parent instanceof FsDir)) return { tag: 'err', val: E.NoEntry };
        const child = parent.entries.get(name!);
        if (!child) return { tag: 'err', val: E.NoEntry };
        if (child instanceof FsDir) return { tag: 'err', val: E.IsDirectory };
        parent.entries.delete(name!);
        return { tag: 'ok' };
      } catch { return { tag: 'err', val: E.Io }; }
    },

    '[method]descriptor.remove-directory-at': (handle: number, path: string) => {
      try {
        const d = getDesc(handle);
        const parts = resolvePath(d.path, path);
        const { parent, name } = memfs._resolveParent(parts);
        if (!(parent instanceof FsDir)) return { tag: 'err', val: E.NoEntry };
        const child = parent.entries.get(name!);
        if (!(child instanceof FsDir)) return { tag: 'err', val: E.NotDirectory };
        if (child.entries.size > 0) return { tag: 'err', val: E.NotEmpty };
        parent.entries.delete(name!);
        return { tag: 'ok' };
      } catch { return { tag: 'err', val: E.Io }; }
    },

    '[method]descriptor.rename-at': (handle: number, oldPath: string, newHandle: number, newPath: string) => {
      try {
        const d = getDesc(handle);
        const d2 = getDesc(newHandle);
        const oldParts = resolvePath(d.path, oldPath);
        const newParts = resolvePath(d2.path, newPath);
        const { parent: op, name: on } = memfs._resolveParent(oldParts);
        const { parent: np, name: nn } = memfs._resolveParent(newParts);
        if (!(op instanceof FsDir) || !(np instanceof FsDir)) return { tag: 'err', val: E.NoEntry };
        const node = op.entries.get(on!);
        if (!node) return { tag: 'err', val: E.NoEntry };
        op.entries.delete(on!);
        np.entries.set(nn!, node);
        return { tag: 'ok' };
      } catch { return { tag: 'err', val: E.Io }; }
    },

    '[method]descriptor.symlink-at': (handle: number, oldPath: string, newPath: string) => {
      try {
        const d = getDesc(handle);
        const parts = resolvePath(d.path, newPath);
        const { parent, name } = memfs._resolveParent(parts);
        if (!(parent instanceof FsDir)) return { tag: 'err', val: E.NoEntry };
        parent.entries.set(name!, new FsSymlink(oldPath));
        return { tag: 'ok' };
      } catch { return { tag: 'err', val: E.Io }; }
    },

    '[method]descriptor.readlink-at': (handle: number, path: string) => {
      try {
        const d = getDesc(handle);
        const parts = resolvePath(d.path, path);
        const { parent, name } = memfs._resolveParent(parts);
        if (!(parent instanceof FsDir)) return { tag: 'err', val: E.NoEntry };
        const node = parent.entries.get(name!);
        if (!(node instanceof FsSymlink)) return { tag: 'err', val: E.Invalid };
        return { tag: 'ok', val: node.target };
      } catch { return { tag: 'err', val: E.Io }; }
    },

    '[method]descriptor.set-times': () => ({ tag: 'ok' }),
    '[method]descriptor.set-times-at': () => ({ tag: 'ok' }),
    '[method]descriptor.set-size': () => ({ tag: 'ok' }),
    '[method]descriptor.sync': () => ({ tag: 'ok' }),
    '[method]descriptor.sync-data': () => ({ tag: 'ok' }),
    '[method]descriptor.advise': () => ({ tag: 'ok' }),
    '[method]descriptor.link-at': () => ({ tag: 'err', val: E.Unsupported }),
    '[method]descriptor.is-same-object': (a: number, b: number) => a === b,
    '[method]descriptor.metadata-hash': (handle: number) => {
      try {
        const d = getDesc(handle);
        const h = hashPath(d.path);
        return { tag: 'ok', val: { lower: h, upper: 0n } };
      } catch { return { tag: 'err', val: E.BadDescriptor }; }
    },
    '[method]descriptor.metadata-hash-at': (handle: number, flags: number, path: string) => {
      try {
        const d = getDesc(handle);
        const parts = resolvePath(d.path, path);
        const h = hashPath(parts);
        return { tag: 'ok', val: { lower: h, upper: 0n } };
      } catch { return { tag: 'err', val: E.BadDescriptor }; }
    },
    'filesystem-error-code': () => null,
  };

  return {
    types,
    preopens: {
      'get-directories': () => preopens,
    },
    setHostReadChunk(fn: (streamEnd: any) => Promise<Uint8Array | null>) { _hostReadChunk = fn; },
  };
}

function hashPath(parts: string[]): bigint {
  let h = 0n;
  const s = '/' + parts.join('/');
  for (let i = 0; i < s.length; i++) {
    h = (h * 31n + BigInt(s.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  return h;
}
