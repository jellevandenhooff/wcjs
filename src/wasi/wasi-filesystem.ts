// WASI P3 Filesystem Host Implementation
//
// Implements wasi:filesystem/types and wasi:filesystem/preopens
// using Node.js fs module. Supports preopened directories with
// path sandboxing.

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { ReadableStreamEnd } from '../runtime/stream.ts';
import type { ReadableStreamBuffer } from '../runtime/types.ts';
import { HostWritableBuffer, hostReadChunk, type HostContext } from './wasi-shared.ts';
import { FilesystemErrorCode, DescriptorType, type WasiFilesystemTypes, type WasiFilesystemPreopens } from './wasi-types.generated.ts';

// Lazy file-backed readable buffer: reads from the file on-demand
// when the guest consumes data from the stream (~8KB per chunk).
class FileReadableBuffer implements ReadableStreamBuffer {
  private fd: number;
  private pos: number | null; // null = sequential (for device files)
  private remaining: number;
  progress = 0;

  constructor(fd: number, offset: number, size: number, sequential = false) {
    this.fd = fd;
    this.pos = sequential ? null : offset;
    this.remaining = size;
  }

  remain(): number { return this.remaining; }
  isZeroLength(): boolean { return this.remaining <= 0; }

  read(n: number): unknown[] {
    const toRead = Math.min(n, this.remaining);
    if (toRead <= 0) return [];
    const buf = Buffer.alloc(toRead);
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(this.fd, buf, 0, toRead, this.pos);
    } catch (_) {
      // fd may have been closed — treat as EOF
      this.remaining = 0;
      return [];
    }
    if (bytesRead === 0) {
      // EOF before expected — adjust remaining
      this.remaining = 0;
      return [];
    }
    if (this.pos !== null) this.pos += bytesRead;
    this.remaining -= bytesRead;
    this.progress += bytesRead;
    const items: number[] = new Array(bytesRead);
    for (let i = 0; i < bytesRead; i++) items[i] = buf[i]!;
    return items;
  }
}

// ---- Error codes (from wasi:filesystem/types) ----
// Uses the generated FilesystemErrorCode const from wasi-types.generated.ts.

function mapNodeError(err: any): FilesystemErrorCode {
  const code = err?.code;
  switch (code) {
    case 'EACCES': case 'EPERM': return FilesystemErrorCode.Access;
    case 'EEXIST': return FilesystemErrorCode.Exist;
    case 'ENOENT': return FilesystemErrorCode.NoEntry;
    case 'EISDIR': return FilesystemErrorCode.IsDirectory;
    case 'ENOTDIR': return FilesystemErrorCode.NotDirectory;
    case 'ENOTEMPTY': return FilesystemErrorCode.NotEmpty;
    case 'ENOSPC': return FilesystemErrorCode.InsufficientSpace;
    case 'EBADF': return FilesystemErrorCode.BadDescriptor;
    case 'EINVAL': return FilesystemErrorCode.Invalid;
    case 'EMFILE': case 'ENFILE': return FilesystemErrorCode.Io;
    case 'ENAMETOOLONG': return FilesystemErrorCode.NameTooLong;
    case 'ELOOP': return FilesystemErrorCode.Loop;
    case 'EXDEV': return FilesystemErrorCode.CrossDevice;
    case 'EROFS': return FilesystemErrorCode.ReadOnly;
    case 'EBUSY': return FilesystemErrorCode.Busy;
    default: return FilesystemErrorCode.Io;
  }
}

// ---- Descriptor type enum (from wasi:filesystem/types) ----
// Uses the generated DescriptorType const from wasi-types.generated.ts.

function statToDescType(stat: fs.Stats): DescriptorType {
  if (stat.isDirectory()) return DescriptorType.Directory;
  if (stat.isFile()) return DescriptorType.RegularFile;
  if (stat.isSymbolicLink()) return DescriptorType.SymbolicLink;
  if (stat.isBlockDevice()) return DescriptorType.BlockDevice;
  if (stat.isCharacterDevice()) return DescriptorType.CharacterDevice;
  if (stat.isFIFO()) return DescriptorType.Fifo;
  if (stat.isSocket()) return DescriptorType.Socket;
  return DescriptorType.Unknown;
}

// ---- Descriptor flags (bit flags, matches WIT order) ----

const DESC_FLAGS = {
  READ: 1,
  WRITE: 2,
  FILE_INTEGRITY_SYNC: 4,
  DATA_INTEGRITY_SYNC: 8,
  REQUESTED_WRITE_SYNC: 16,
  MUTATE_DIRECTORY: 32,
} as const;

// ---- Open flags (bit flags) ----

const OPEN_FLAGS = {
  CREATE: 1,
  DIRECTORY: 2,
  EXCLUSIVE: 4,
  TRUNCATE: 8,
} as const;

// ---- Path flags ----

const PATH_FLAGS = {
  SYMLINK_FOLLOW: 1,
} as const;

// ---- Descriptor handle state ----

interface DescriptorHandle {
  fd: number | null;        // Node.js fd (null for directory preopens using path)
  hostPath: string;         // Actual host filesystem path
  isDir: boolean;
  flags: number;            // descriptor-flags bitmask
}

// ---- Stat conversion ----

// Returns stat as a record matching the descriptor-stat record fields.
// Timestamps are option<datetime>: null for none, {seconds, nanoseconds} for some.
function statToWasi(stat: fs.Stats): { type: DescriptorType; 'link-count': bigint; size: bigint; 'data-access-timestamp': { seconds: bigint; nanoseconds: number } | null; 'data-modification-timestamp': { seconds: bigint; nanoseconds: number } | null; 'status-change-timestamp': { seconds: bigint; nanoseconds: number } | null } {
  const toTimestamp = (ms: number | undefined) => {
    if (ms == null) return null;
    const sec = Math.floor(ms / 1000);
    const ns = Math.round((ms - sec * 1000) * 1_000_000);
    return { seconds: BigInt(sec), nanoseconds: ns };
  };
  return {
    'type': statToDescType(stat),
    'link-count': BigInt(stat.nlink),
    'size': BigInt(stat.size),
    'data-access-timestamp': toTimestamp(stat.atimeMs),
    'data-modification-timestamp': toTimestamp(stat.mtimeMs),
    'status-change-timestamp': toTimestamp(stat.ctimeMs),
  };
}

// ---- NewTimestamp → seconds conversion ----
// NewTimestamp is: {tag:'no-change'} | {tag:'now'} | {tag:'timestamp', val:{seconds:bigint, nanoseconds:number}}
// Returns seconds as a number (with fractional part for sub-second precision).
// Using seconds instead of Date objects preserves microsecond precision.
function timestampToSeconds(ts: any, nowSec: number): number {
  if (ts.tag === 'now') return nowSec;
  if (ts.tag === 'timestamp') {
    return Number(ts.val.seconds) + ts.val.nanoseconds / 1e9;
  }
  return nowSec; // fallback
}

// ---- Metadata hash ----
// Returns {lower: bigint, upper: bigint} from stat info.
// Hash from inode + size + mtime.
function metadataHash(stat: fs.Stats): { lower: bigint; upper: bigint } {
  // Use inode as lower, and combine size + mtime into upper
  const lower = BigInt(stat.ino);
  const mtimeNs = BigInt(Math.floor(stat.mtimeMs)) * 1_000_000n;
  const upper = BigInt(stat.size) ^ mtimeNs;
  return { lower, upper };
}

// ---- Path sandboxing ----

function resolveSandboxed(base: string, relative: string, followSymlinks: boolean = false): string | null {
  const resolved = nodePath.resolve(base, relative);
  const norm = nodePath.normalize(resolved);
  // When base is the root (/), everything is allowed
  if (base === nodePath.sep) return norm;
  // Lexical check
  if (!norm.startsWith(base + nodePath.sep) && norm !== base) {
    return null; // escape attempt
  }
  if (!followSymlinks) return norm;
  // Symlink check: resolve real paths to prevent symlink escapes.
  // Try the full path first; if it doesn't exist, check the parent.
  try {
    const real = fs.realpathSync(norm);
    const baseReal = fs.realpathSync(base);
    if (baseReal !== nodePath.sep && !real.startsWith(baseReal + nodePath.sep) && real !== baseReal) {
      return null; // symlink escapes sandbox
    }
  } catch (_) {
    // Path doesn't exist — check parent directory (for create operations)
    try {
      const parent = nodePath.dirname(norm);
      const parentReal = fs.realpathSync(parent);
      const baseReal = fs.realpathSync(base);
      if (baseReal !== nodePath.sep && !parentReal.startsWith(baseReal + nodePath.sep) && parentReal !== baseReal) {
        return null;
      }
    } catch (_) {
      // Parent doesn't exist either; allow — open will fail naturally
    }
  }
  return norm;
}

// ---- Factory ----

export interface FilesystemOptions {
  preopens?: [string, string][];  // [guest-path, host-path] pairs
}

export function createFilesystemHost(ctx: HostContext, opts: FilesystemOptions = {}): { types: Record<string, (...args: any[]) => any>; preopens: WasiFilesystemPreopens } {
  const descriptors = new Map<number, DescriptorHandle>();
  let nextId = 1;

  // Set up preopens
  const preopens: [number, string][] = [];
  for (const [guestPath, hostPath] of (opts.preopens || [])) {
    const id = nextId++;
    const absHost = nodePath.resolve(hostPath);
    descriptors.set(id, { fd: null, hostPath: absHost, isDir: true, flags: DESC_FLAGS.READ | DESC_FLAGS.WRITE | DESC_FLAGS.MUTATE_DIRECTORY });
    preopens.push([id, guestPath]);
  }

  function getDesc(handle: number): DescriptorHandle {
    let d = descriptors.get(handle);
    if (d) return d;
    const state = ctx.state;
    if (state) {
      try {
        const rh = state.getResourceHandle(handle);
        d = descriptors.get(rh.rep);
        if (d) return d;
      } catch (_) { /* ignore */ }
    }
    throw new Error(`invalid descriptor handle: ${handle}`);
  }

  return {
    types: {
      '[resource-drop]descriptor': (handle: number) => {
        const d = descriptors.get(handle);
        if (d) {
          if (d.fd !== null) {
            try { fs.closeSync(d.fd); } catch (_) { /* ignore */ }
          }
          descriptors.delete(handle);
        }
      },

      '[method]descriptor.get-type': (handle: number) => {
        try {
          const d = getDesc(handle);
          if (d.isDir) return { tag: 'ok', val: DescriptorType.Directory };
          const stat = d.fd !== null ? fs.fstatSync(d.fd) : fs.statSync(d.hostPath);
          return { tag: 'ok', val: statToDescType(stat) };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.get-flags': (handle: number) => {
        try {
          const d = getDesc(handle);
          return { tag: 'ok', val: d.flags };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.stat': (handle: number) => {
        try {
          const d = getDesc(handle);
          const stat = d.fd !== null ? fs.fstatSync(d.fd) : fs.statSync(d.hostPath);
          return { tag: 'ok', val: statToWasi(stat) };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.stat-at': (handle: number, _pathFlags: number, path: string) => {
        try {
          const d = getDesc(handle);
          // A trailing slash forces symlink following (POSIX semantics)
          const trailingSlash = path.endsWith('/') && path !== '/';
          const followSymlinks = !!(_pathFlags & PATH_FLAGS.SYMLINK_FOLLOW) || trailingSlash;
          const resolved = resolveSandboxed(d.hostPath, path, followSymlinks);
          if (!resolved) return { tag: 'err', val: FilesystemErrorCode.Access };
          const stat = followSymlinks
            ? fs.statSync(resolved)
            : fs.lstatSync(resolved);
          return { tag: 'ok', val: statToWasi(stat) };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.open-at': (handle: number, pathFlags: number, path: string, openFlags: number, descFlags: number) => {
        try {
          const d = getDesc(handle);
          // Check mutate-directory propagation: a child descriptor can only have
          // mutate-directory if the parent also has it.
          if (!!(descFlags & DESC_FLAGS.MUTATE_DIRECTORY) && !(d.flags & DESC_FLAGS.MUTATE_DIRECTORY)) {
            return { tag: 'err', val: FilesystemErrorCode.ReadOnly };
          }
          const followSymlinks = !!(pathFlags & PATH_FLAGS.SYMLINK_FOLLOW);
          const resolved = resolveSandboxed(d.hostPath, path, followSymlinks);
          if (!resolved) return { tag: 'err', val: FilesystemErrorCode.Access };

          let nodeFlags = 0;
          const wantRead = !!(descFlags & DESC_FLAGS.READ);
          const wantWrite = !!(descFlags & DESC_FLAGS.WRITE);
          if (wantRead && wantWrite) nodeFlags = fs.constants.O_RDWR;
          else if (wantWrite) nodeFlags = fs.constants.O_WRONLY;
          else nodeFlags = fs.constants.O_RDONLY;
          if (openFlags & OPEN_FLAGS.CREATE) nodeFlags |= fs.constants.O_CREAT;
          if (openFlags & OPEN_FLAGS.EXCLUSIVE) nodeFlags |= fs.constants.O_EXCL;
          if (openFlags & OPEN_FLAGS.TRUNCATE) nodeFlags |= fs.constants.O_TRUNC;
          if (!(pathFlags & PATH_FLAGS.SYMLINK_FOLLOW)) nodeFlags |= fs.constants.O_NOFOLLOW;

          const statFn = followSymlinks ? fs.statSync : fs.lstatSync;

          // Check if it's a directory open
          if (openFlags & OPEN_FLAGS.DIRECTORY) {
            // Verify it's a directory
            const stat = statFn(resolved);
            if (!stat.isDirectory()) return { tag: 'err', val: FilesystemErrorCode.NotDirectory };
            const id = nextId++;
            descriptors.set(id, { fd: null, hostPath: resolved, isDir: true, flags: descFlags });
            return { tag: 'ok', val: id };
          }

          // Check if path is a directory (for reads without DIRECTORY flag)
          try {
            const stat = statFn(resolved);
            if (stat.isDirectory()) {
              // Opening a directory with write intent is EISDIR
              if (wantWrite) return { tag: 'err', val: FilesystemErrorCode.IsDirectory };
              const id = nextId++;
              descriptors.set(id, { fd: null, hostPath: resolved, isDir: true, flags: descFlags });
              return { tag: 'ok', val: id };
            }
          } catch (_) {
            // File doesn't exist yet, proceed with open
          }

          const fd = fs.openSync(resolved, nodeFlags, 0o644);
          const id = nextId++;
          descriptors.set(id, { fd, hostPath: resolved, isDir: false, flags: descFlags });
          return { tag: 'ok', val: id };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.read-via-stream': (handle: number, offset: bigint) => {
        const state = ctx.state!;
        const d = getDesc(handle);

        // Create stream + future for the result
        const sPacked = state.streamNew(0);
        const sRi = Number(sPacked & 0xFFFFFFFFn);
        const sWi = Number(sPacked >> 32n);
        const fPacked = state.futureNew(0);
        const fRi = Number(fPacked & 0xFFFFFFFFn);
        const fWi = Number(fPacked >> 32n);

        if (!(d.flags & DESC_FLAGS.READ)) {
          state.streamDropWritable(0, sWi);
          state.futureWriteHost(0, fWi, [{tag: 'err', val: FilesystemErrorCode.BadDescriptor}]);
          return [sRi, fRi];
        }

        // Set up lazy file reading — FileReadableBuffer reads on-demand
        // when the guest consumes data from the stream.
        const hostPath = d.hostPath;
        const fd = d.fd;
        const doRead = async () => {
          try {
            // Yield so the guest can set up the stream reader
            await Promise.resolve();

            if (fd !== null) {
              try {
                const stat = fs.fstatSync(fd);
                const pos = Number(offset);
                if (stat.isFile()) {
                  const size = Math.max(0, stat.size - pos);
                  if (size > 0) {
                    const fileBuffer = new FileReadableBuffer(fd, pos, size);
                    state.streamWriteHostBuffer(0, sWi, fileBuffer);
                  }
                } else {
                  // Device/special file (e.g. /dev/zero) — use sequential
                  // reads with a large cap. Guest drops the stream when done.
                  const MAX_DEVICE_READ = 16 * 1024 * 1024;
                  const fileBuffer = new FileReadableBuffer(fd, 0, MAX_DEVICE_READ, true);
                  state.streamWriteHostBuffer(0, sWi, fileBuffer);
                }
              } catch (_) {
                // fstat/read error — treat as empty file
              }
            } else {
              // No fd (directory descriptor) — read via path
              try {
                const content = fs.readFileSync(hostPath);
                const pos = Number(offset);
                const bytes = content.subarray(pos);
                if (bytes.length > 0) {
                  const items: number[] = new Array(bytes.length);
                  for (let i = 0; i < bytes.length; i++) items[i] = bytes[i]!;
                  state.streamWriteHost(0, sWi, items);
                }
              } catch (_) {
                // read error — treat as empty
              }
            }
            state.streamDropWritable(0, sWi);
            state.futureWriteHost(0, fWi, [{tag: 'ok'}]);
          } catch (e: any) {
            try { state.streamDropWritable(0, sWi); } catch (_) {}
            state.futureWriteHost(0, fWi, [{tag: 'err', val: mapNodeError(e)}]);
          }
        };
        state.trackHostAsync(doRead());
        return [sRi, fRi];
      },

      // Async-lowered versions: return Promise<result> instead of future handles.
      '[async method]descriptor.write-via-stream': (handle: number, streamEndIdx: number, offset: bigint) => {
        const state = ctx.state!;
        const d = getDesc(handle);
        const streamEnd = state.liftStreamEnd(0, streamEndIdx) as ReadableStreamEnd;
        if (!(d.flags & DESC_FLAGS.WRITE)) {
          streamEnd.drop();
          return { tag: 'err' as const, val: FilesystemErrorCode.Access };
        }
        return (async () => {
          try {
            let pos = Number(offset);
            let tempFd: number | null = null;
            const writeFd = d.fd !== null ? d.fd : (tempFd = fs.openSync(d.hostPath, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o644));
            try {
              while (true) {
                const chunk = await hostReadChunk(streamEnd);
                if (!chunk) break;
                if (chunk.length > 0) {
                  fs.writeSync(writeFd, chunk, 0, chunk.length, pos);
                  pos += chunk.length;
                }
              }
            } finally {
              if (tempFd !== null) fs.closeSync(tempFd);
            }
            return { tag: 'ok' as const };
          } catch (e: any) {
            return { tag: 'err' as const, val: mapNodeError(e) };
          }
        })();
      },

      '[async method]descriptor.append-via-stream': (handle: number, streamEndIdx: number) => {
        const state = ctx.state!;
        const d = getDesc(handle);
        const streamEnd = state.liftStreamEnd(0, streamEndIdx) as ReadableStreamEnd;
        if (!(d.flags & DESC_FLAGS.WRITE)) {
          streamEnd.drop();
          return { tag: 'err' as const, val: FilesystemErrorCode.Access };
        }
        return (async () => {
          try {
            let tempFd: number | null = null;
            const writeFd = d.fd !== null ? d.fd : (tempFd = fs.openSync(d.hostPath, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o644));
            try {
              let pos = fs.fstatSync(writeFd).size;
              while (true) {
                const chunk = await hostReadChunk(streamEnd);
                if (!chunk) break;
                if (chunk.length > 0) {
                  fs.writeSync(writeFd, chunk, 0, chunk.length, pos);
                  pos += chunk.length;
                }
              }
            } finally {
              if (tempFd !== null) fs.closeSync(tempFd);
            }
            return { tag: 'ok' as const };
          } catch (e: any) {
            return { tag: 'err' as const, val: mapNodeError(e) };
          }
        })();
      },

      '[method]descriptor.read-directory': (handle: number) => {
        const state = ctx.state!;
        const d = getDesc(handle);

        // Create stream<directory-entry> + future for result
        const sPacked = state.streamNew(0);
        const sRi = Number(sPacked & 0xFFFFFFFFn);
        const sWi = Number(sPacked >> 32n);
        const fPacked = state.futureNew(0);
        const fRi = Number(fPacked & 0xFFFFFFFFn);
        const fWi = Number(fPacked >> 32n);

        const doReadDir = async () => {
          try {
            const entries = fs.readdirSync(d.hostPath, { withFileTypes: true });
            // Yield so the guest can set up the stream reader
            await Promise.resolve();
            // Batch all entries into a single write
            const items: unknown[] = [];
            for (const entry of entries) {
              let dtype: string = DescriptorType.Unknown;
              if (entry.isDirectory()) dtype = DescriptorType.Directory;
              else if (entry.isFile()) dtype = DescriptorType.RegularFile;
              else if (entry.isSymbolicLink()) dtype = DescriptorType.SymbolicLink;
              items.push({ 'type': dtype, 'name': entry.name });
            }
            if (items.length > 0) {
              state.streamWriteHost(0, sWi, items);
            }
            state.streamDropWritable(0, sWi);
            state.futureWriteHost(0, fWi, [{tag: 'ok'}]);
          } catch (e: any) {
            try { state.streamDropWritable(0, sWi); } catch (_) {}
            state.futureWriteHost(0, fWi, [{tag: 'err', val: mapNodeError(e)}]);
          }
        };
        state.trackHostAsync(doReadDir());
        return [sRi, fRi];
      },

      '[method]descriptor.create-directory-at': (handle: number, path: string) => {
        try {
          const d = getDesc(handle);
          const resolved = resolveSandboxed(d.hostPath, path);
          if (!resolved) return { tag: 'err', val: FilesystemErrorCode.Access };
          fs.mkdirSync(resolved, { recursive: false });
          return { tag: 'ok' };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.remove-directory-at': (handle: number, path: string) => {
        try {
          const d = getDesc(handle);
          // Reject "." and ".." — matches POSIX unlinkat(AT_REMOVEDIR) behavior
          const base = nodePath.basename(path);
          if (base === '.' || base === '..') return { tag: 'err', val: FilesystemErrorCode.Invalid };
          const resolved = resolveSandboxed(d.hostPath, path);
          if (!resolved) return { tag: 'err', val: FilesystemErrorCode.Access };
          fs.rmdirSync(resolved);
          return { tag: 'ok' };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.unlink-file-at': (handle: number, path: string) => {
        try {
          const d = getDesc(handle);
          const resolved = resolveSandboxed(d.hostPath, path);
          if (!resolved) return { tag: 'err', val: FilesystemErrorCode.Access };
          fs.unlinkSync(resolved);
          return { tag: 'ok' };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.symlink-at': (handle: number, oldPath: string, newPath: string) => {
        try {
          // Per spec: if old-path starts with /, fail with not-permitted
          if (oldPath.startsWith('/')) return { tag: 'err', val: FilesystemErrorCode.NotPermitted };
          const d = getDesc(handle);
          const resolved = resolveSandboxed(d.hostPath, newPath);
          if (!resolved) return { tag: 'err', val: FilesystemErrorCode.Access };
          fs.symlinkSync(oldPath, resolved);
          return { tag: 'ok' };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.readlink-at': (handle: number, path: string) => {
        try {
          const d = getDesc(handle);
          const resolved = resolveSandboxed(d.hostPath, path);
          if (!resolved) return { tag: 'err', val: FilesystemErrorCode.Access };
          const target = fs.readlinkSync(resolved, 'utf-8');
          // Per spec: if contents contain an absolute path, fail with not-permitted
          if (target.startsWith('/')) return { tag: 'err', val: FilesystemErrorCode.NotPermitted };
          return { tag: 'ok', val: target };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.rename-at': (handle: number, oldPath: string, newHandle: number, newPath: string) => {
        try {
          const d = getDesc(handle);
          const nd = getDesc(newHandle);
          const resolvedOld = resolveSandboxed(d.hostPath, oldPath);
          const resolvedNew = resolveSandboxed(nd.hostPath, newPath);
          if (!resolvedOld || !resolvedNew) return { tag: 'err', val: FilesystemErrorCode.Access };
          fs.renameSync(resolvedOld, resolvedNew);
          // Update hostPath for any open descriptors that pointed inside the
          // renamed path. Node.js doesn't have openat(), so we track paths
          // manually to survive renames.
          const oldPrefix = resolvedOld + nodePath.sep;
          for (const [, desc] of descriptors) {
            if (desc.hostPath === resolvedOld) {
              desc.hostPath = resolvedNew;
            } else if (desc.hostPath.startsWith(oldPrefix)) {
              desc.hostPath = resolvedNew + desc.hostPath.slice(resolvedOld.length);
            }
          }
          return { tag: 'ok' };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.link-at': (handle: number, oldPathFlags: number, oldPath: string, newHandle: number, newPath: string) => {
        try {
          const d = getDesc(handle);
          const nd = getDesc(newHandle);
          // SYMLINK_FOLLOW is invalid for link-at
          if (oldPathFlags & PATH_FLAGS.SYMLINK_FOLLOW) {
            return { tag: 'err', val: FilesystemErrorCode.Invalid };
          }
          const resolvedOld = resolveSandboxed(d.hostPath, oldPath);
          const resolvedNew = resolveSandboxed(nd.hostPath, newPath);
          if (!resolvedOld || !resolvedNew) return { tag: 'err', val: FilesystemErrorCode.Access };
          // Node's fs.linkSync follows symlinks on macOS (POSIX link() behavior).
          // WASI link-at with flags=0 should NOT follow — it creates a hard link
          // to the symlink entry itself. Since Node doesn't expose linkat(),
          // emulate by creating a new symlink with the same target.
          const oldStat = fs.lstatSync(resolvedOld);
          if (oldStat.isSymbolicLink()) {
            const target = fs.readlinkSync(resolvedOld, 'utf-8');
            fs.symlinkSync(target, resolvedNew);
          } else {
            fs.linkSync(resolvedOld, resolvedNew);
          }
          return { tag: 'ok' };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.set-times-at': (handle: number, _pathFlags: number, path: string, dataAccessTimestamp: any, dataModificationTimestamp: any) => {
        try {
          const d = getDesc(handle);
          const followSymlinks = !!(_pathFlags & PATH_FLAGS.SYMLINK_FOLLOW);
          const resolved = resolveSandboxed(d.hostPath, path, followSymlinks);
          if (!resolved) return { tag: 'err', val: FilesystemErrorCode.Access };
          const nowSec = Date.now() / 1000;
          const statFn = followSymlinks ? fs.statSync : fs.lstatSync;
          const stat = statFn(resolved);
          const atime = dataAccessTimestamp.tag === 'no-change' ? stat.atimeMs / 1000 : timestampToSeconds(dataAccessTimestamp, nowSec);
          const mtime = dataModificationTimestamp.tag === 'no-change' ? stat.mtimeMs / 1000 : timestampToSeconds(dataModificationTimestamp, nowSec);
          if (followSymlinks) {
            fs.utimesSync(resolved, atime, mtime);
          } else {
            fs.lutimesSync(resolved, atime, mtime);
          }
          return { tag: 'ok' };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.set-times': (handle: number, dataAccessTimestamp: any, dataModificationTimestamp: any) => {
        try {
          const d = getDesc(handle);
          const nowSec = Date.now() / 1000;
          const stat = d.fd !== null ? fs.fstatSync(d.fd) : fs.statSync(d.hostPath);
          const atime = dataAccessTimestamp.tag === 'no-change' ? stat.atimeMs / 1000 : timestampToSeconds(dataAccessTimestamp, nowSec);
          const mtime = dataModificationTimestamp.tag === 'no-change' ? stat.mtimeMs / 1000 : timestampToSeconds(dataModificationTimestamp, nowSec);
          if (d.fd !== null) {
            fs.futimesSync(d.fd, atime, mtime);
          } else {
            fs.utimesSync(d.hostPath, atime, mtime);
          }
          return { tag: 'ok' };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.set-size': (handle: number, size: bigint) => {
        try {
          const d = getDesc(handle);
          if (d.fd !== null) {
            fs.ftruncateSync(d.fd, Number(size));
          } else {
            fs.truncateSync(d.hostPath, Number(size));
          }
          return { tag: 'ok' };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.sync': (handle: number) => {
        try {
          const d = getDesc(handle);
          if (d.fd !== null) fs.fsyncSync(d.fd);
          return { tag: 'ok' };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.advise': (_handle: number, _offset: bigint, _length: bigint, _advice: number) => {
        // Advisory hint — no-op is valid per spec
        return { tag: 'ok' };
      },

      '[method]descriptor.sync-data': (handle: number) => {
        try {
          const d = getDesc(handle);
          if (d.fd !== null) fs.fdatasyncSync(d.fd);
          return { tag: 'ok' };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.is-same-object': (handleA: number, handleB: number) => {
        try {
          const a = getDesc(handleA);
          const b = getDesc(handleB);
          if (a === b) return true;
          const statA = a.fd !== null ? fs.fstatSync(a.fd) : fs.statSync(a.hostPath);
          const statB = b.fd !== null ? fs.fstatSync(b.fd) : fs.statSync(b.hostPath);
          return statA.dev === statB.dev && statA.ino === statB.ino;
        } catch (_) {
          return false;
        }
      },

      'filesystem-error-code': () => null,

      '[method]descriptor.metadata-hash': (handle: number) => {
        try {
          const d = getDesc(handle);
          const stat = d.fd !== null ? fs.fstatSync(d.fd) : fs.statSync(d.hostPath);
          return { tag: 'ok', val: metadataHash(stat) };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },

      '[method]descriptor.metadata-hash-at': (handle: number, _pathFlags: number, path: string) => {
        try {
          const d = getDesc(handle);
          const resolved = resolveSandboxed(d.hostPath, path, !!(_pathFlags & PATH_FLAGS.SYMLINK_FOLLOW));
          if (!resolved) return { tag: 'err', val: FilesystemErrorCode.Access };
          const stat = (_pathFlags & PATH_FLAGS.SYMLINK_FOLLOW)
            ? fs.statSync(resolved)
            : fs.lstatSync(resolved);
          return { tag: 'ok', val: metadataHash(stat) };
        } catch (e) {
          return { tag: 'err', val: mapNodeError(e) };
        }
      },
    },

    preopens: {
      'get-directories': () => preopens,
    },
  };
}

