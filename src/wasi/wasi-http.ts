// WASI P3 HTTP Host Implementation
//
// Implements wasi:http/types resource management (fields, request, response,
// request-options) and wasi:http/client.send using Node.js http.request().

import type { ComponentState } from '../runtime/component-state.ts';
import { HostWritableBuffer, hostReadChunk } from './wasi-shared.ts';
import { ReadableStreamEnd } from '../runtime/stream.ts';
import { ReadableFutureEnd } from '../runtime/future.ts';
import { CopyResult } from '../runtime/types.ts';
import type { WritableStreamBuffer } from '../runtime/types.ts';
import type { Method, Scheme, HttpErrorCode, HeaderError, RequestOptionsError } from './wasi-types.generated.ts';
import * as nodeHttp from 'node:http';
import * as nodeHttps from 'node:https';
import type { IncomingMessage } from 'node:http';

// ---- Host context ----

export interface HttpHostContext {
  state: ComponentState | null;
  /** Set by response.new — the most recently created response rep. */
  lastResponseRep?: number;
  /** When true, response.new eagerly drains body stream and trailers future. */
  handlerMode?: boolean;
  /** Per-context HTTP resource storage (lazily initialized). */
  _http?: HttpResourceStore;
}

// ---- Resource storage ----

interface FieldsResource {
  entries: [string, Uint8Array][];
  immutable: boolean;
}

interface RequestResource {
  method: Method;
  pathWithQuery: string | null;
  scheme: Scheme | null;
  authority: string | null;
  headersRep: number;
  bodyStreamHandle: number | null;
  bodyStreamEnd?: ReadableStreamEnd;  // Lifted stream end (for transferred streams)
  trailersFutureHandle: number;
  optionsRep: number | null;
}

interface ResponseResource {
  statusCode: number;
  headersRep: number;
  body: Uint8Array;
  trailers: [string, Uint8Array][] | null;
  bodyStreamHandle: number | null;
  trailersFutureHandle: number | null;
  // For responses from http.request(): lazily consumed body stream
  nodeResponse?: IncomingMessage;
}

interface RequestOptionsResource {
  connectTimeout: bigint | null;
  firstByteTimeout: bigint | null;
  betweenBytesTimeout: bigint | null;
  immutable: boolean;
}

interface HttpResourceStore {
  nextRep: number;
  fieldsMap: Map<number, FieldsResource>;
  requestMap: Map<number, RequestResource>;
  responseMap: Map<number, ResponseResource>;
  optionsMap: Map<number, RequestOptionsResource>;
}

function getStore(ctx: HttpHostContext): HttpResourceStore {
  if (!ctx._http) {
    ctx._http = {
      nextRep: 1,
      fieldsMap: new Map(),
      requestMap: new Map(),
      responseMap: new Map(),
      optionsMap: new Map(),
    };
  }
  return ctx._http;
}

export function newRep(ctx: HttpHostContext): number { return getStore(ctx).nextRep++; }

// Convenience accessors for maps (used throughout)
export function fieldsOf(ctx: HttpHostContext) { return getStore(ctx).fieldsMap; }
export function requestsOf(ctx: HttpHostContext) { return getStore(ctx).requestMap; }
export function responsesOf(ctx: HttpHostContext) { return getStore(ctx).responseMap; }
function optionsOf(ctx: HttpHostContext) { return getStore(ctx).optionsMap; }

// ---- Fields helpers ----

function fieldGet(entries: [string, Uint8Array][], name: string): Uint8Array[] {
  const lc = name.toLowerCase();
  return entries.filter(([n]) => n.toLowerCase() === lc).map(([, v]) => v);
}

function fieldHas(entries: [string, Uint8Array][], name: string): boolean {
  const lc = name.toLowerCase();
  return entries.some(([n]) => n.toLowerCase() === lc);
}

// ---- Validation helpers ----

function isValidMethod(m: Method): boolean {
  if ('val' in m) {
    // method.other(string) — must be a valid HTTP token
    return /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(m.val);
  }
  return true;
}

function isValidAuthority(a: string): boolean {
  // Reject newlines
  if (/[\r\n]/.test(a)) return false;
  // IPv6 bracket notation: [::1]:port or [::1]
  if (a.startsWith('[')) {
    const closeBracket = a.indexOf(']');
    if (closeBracket < 0) return false;
    const after = a.substring(closeBracket + 1);
    if (after === '') return true; // [::1]
    if (after.startsWith(':')) {
      const port = parseInt(after.substring(1), 10);
      if (isNaN(port) || port < 0 || port > 65535) return false;
    } else {
      return false; // junk after ]
    }
    return true;
  }
  // IPv4/hostname: host:port
  const parts = a.split(':');
  if (parts.length > 2) return false;
  if (parts.length === 2) {
    const port = parseInt(parts[1]!, 10);
    if (isNaN(port) || port < 0 || port > 65535) return false;
  }
  return true;
}

function isValidScheme(s: Scheme): boolean {
  if ('val' in s) {
    return /^[A-Za-z][A-Za-z0-9+\-.]*$/.test(s.val);
  }
  return true;
}

function isValidPath(p: string): boolean {
  return !/[\r\n]/.test(p);
}

// HTTP header name: RFC 9110 token = 1*tchar
// tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." /
//         "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
const TCHAR_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function isValidHeaderName(name: string): boolean {
  return name.length > 0 && TCHAR_RE.test(name);
}

// HTTP header value: RFC 9110 field-value = *field-content
// No leading/trailing whitespace, no NUL or bare CR/LF
function isValidHeaderValue(value: Uint8Array): boolean {
  for (let i = 0; i < value.length; i++) {
    const b = value[i]!;
    if (b === 0 || b === 0x0a || b === 0x0d) return false;
  }
  return true;
}

// Forbidden HTTP headers (hop-by-hop / connection-specific)
const FORBIDDEN_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'host', 'te', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'custom-forbidden-header',
]);
function isForbiddenHeaderName(name: string): boolean {
  return FORBIDDEN_HEADERS.has(name.toLowerCase());
}

// ---- HTTP types implementation ----

export function createHttpTypesHost(ctx: HttpHostContext) {
  return {
    // ---- fields resource ----
    '[constructor]fields'(): number {
      const rep = newRep(ctx);
      fieldsOf(ctx).set(rep, { entries: [], immutable: false });
      return rep;
    },

    '[static]fields.from-list'(entries: [string, Uint8Array][]): { tag: 'ok'; val: number } | { tag: 'err'; val: HeaderError } {
      for (const [name, value] of entries) {
        if (!isValidHeaderName(name)) return { tag: 'err', val: { tag: 'invalid-syntax' } };
        if (!isValidHeaderValue(value)) return { tag: 'err', val: { tag: 'invalid-syntax' } };
        if (isForbiddenHeaderName(name)) return { tag: 'err', val: { tag: 'forbidden' } };
      }
      const rep = newRep(ctx);
      fieldsOf(ctx).set(rep, { entries: [...entries], immutable: false });
      return { tag: 'ok', val: rep };
    },

    '[method]fields.get'(self: number, name: string): Uint8Array[] {
      const f = fieldsOf(ctx).get(self);
      if (!f) return [];
      return fieldGet(f.entries, name);
    },

    '[method]fields.has'(self: number, name: string): boolean {
      const f = fieldsOf(ctx).get(self);
      if (!f) return false;
      return fieldHas(f.entries, name);
    },

    '[method]fields.set'(self: number, name: string, values: Uint8Array[]): { tag: 'ok' } | { tag: 'err'; val: HeaderError } {
      const f = fieldsOf(ctx).get(self);
      if (!f) return { tag: 'err', val: { tag: 'invalid-syntax' } };
      if (f.immutable) return { tag: 'err', val: { tag: 'immutable' } };
      if (!isValidHeaderName(name)) return { tag: 'err', val: { tag: 'invalid-syntax' } };
      if (isForbiddenHeaderName(name)) return { tag: 'err', val: { tag: 'forbidden' } };
      for (const v of values) {
        if (!isValidHeaderValue(v)) return { tag: 'err', val: { tag: 'invalid-syntax' } };
      }
      f.entries = f.entries.filter(([n]) => n.toLowerCase() !== name.toLowerCase());
      for (const v of values) f.entries.push([name, v]);
      return { tag: 'ok' };
    },

    '[method]fields.delete'(self: number, name: string): { tag: 'ok' } | { tag: 'err'; val: HeaderError } {
      const f = fieldsOf(ctx).get(self);
      if (!f) return { tag: 'err', val: { tag: 'invalid-syntax' } };
      if (f.immutable) return { tag: 'err', val: { tag: 'immutable' } };
      if (!isValidHeaderName(name)) return { tag: 'err', val: { tag: 'invalid-syntax' } };
      if (isForbiddenHeaderName(name)) return { tag: 'err', val: { tag: 'forbidden' } };
      f.entries = f.entries.filter(([n]) => n.toLowerCase() !== name.toLowerCase());
      return { tag: 'ok' };
    },

    '[method]fields.get-and-delete'(self: number, name: string): { tag: 'ok'; val: Uint8Array[] } | { tag: 'err'; val: HeaderError } {
      const f = fieldsOf(ctx).get(self);
      if (!f) return { tag: 'err', val: { tag: 'invalid-syntax' } };
      if (f.immutable) return { tag: 'err', val: { tag: 'immutable' } };
      const lc = name.toLowerCase();
      const vals = f.entries.filter(([n]) => n.toLowerCase() === lc).map(([, v]) => v);
      f.entries = f.entries.filter(([n]) => n.toLowerCase() !== lc);
      return { tag: 'ok', val: vals };
    },

    '[method]fields.append'(self: number, name: string, value: Uint8Array): { tag: 'ok' } | { tag: 'err'; val: HeaderError } {
      const f = fieldsOf(ctx).get(self);
      if (!f) return { tag: 'err', val: { tag: 'invalid-syntax' } };
      if (f.immutable) return { tag: 'err', val: { tag: 'immutable' } };
      if (!isValidHeaderName(name)) return { tag: 'err', val: { tag: 'invalid-syntax' } };
      if (!isValidHeaderValue(value)) return { tag: 'err', val: { tag: 'invalid-syntax' } };
      if (isForbiddenHeaderName(name)) return { tag: 'err', val: { tag: 'forbidden' } };
      f.entries.push([name, value]);
      return { tag: 'ok' };
    },

    '[method]fields.copy-all'(self: number): [string, Uint8Array][] {
      const f = fieldsOf(ctx).get(self);
      if (!f) return [];
      return f.entries.map(([n, v]) => [n, new Uint8Array(v)]);
    },

    '[method]fields.clone'(self: number): number {
      const f = fieldsOf(ctx).get(self);
      const rep = newRep(ctx);
      fieldsOf(ctx).set(rep, {
        entries: f ? f.entries.map(([n, v]) => [n, new Uint8Array(v)]) : [],
        immutable: false,
      });
      return rep;
    },

    '[resource-drop]fields'(rep: number): void {
      fieldsOf(ctx).delete(rep);
    },

    // ---- request resource ----
    '[static]request.new'(
      headersRep: number,
      contentsStream: number | null,
      trailersFuture: number,
      optionsRep: number | null,
    ): [number, number] {
      const state = ctx.state!;
      const rep = newRep(ctx);

      // Mark the headers as immutable once attached to a request
      const hdr = fieldsOf(ctx).get(headersRep);
      if (hdr) hdr.immutable = true;

      // Lift the body stream end from the component's handle table (transfer ownership).
      // This prevents the canonical ABI's subsequent stream.drop-readable from destroying
      // the stream data. The stream end object is stored directly on the request.
      let bodyStreamEnd: ReadableStreamEnd | undefined;
      if (contentsStream !== null) {
        const entry = state.handles.get(contentsStream);
        if (entry instanceof ReadableStreamEnd) {
          state.handles.remove(contentsStream);
          bodyStreamEnd = entry;
        }
      }

      // Mark the trailers future as host-owned. The canonical ABI adapter drops
      // the readable end after the trampoline returns; in our single-table
      // implementation this would signal DROPPED to the writer. Setting hostOwned
      // prevents that, and the host-side reader ensures the writer's write completes.
      {
        const entry = state.handles.get(trailersFuture);
        if (entry instanceof ReadableFutureEnd) {
          entry.shared.hostOwned = true;
          // Register a host-side reader so the component's future.write succeeds
          const hostBuf: WritableStreamBuffer = {
            progress: 0,
            remain() { return 1; },
            isZeroLength() { return false; },
            write(_items: unknown[]) { this.progress += _items.length; },
          };
          entry.shared.read(hostBuf, (_result) => {});
        }
      }

      requestsOf(ctx).set(rep, {
        method: { tag: 'get' },
        pathWithQuery: null,
        scheme: null,
        authority: null,
        headersRep,
        bodyStreamHandle: contentsStream,
        bodyStreamEnd,
        trailersFutureHandle: trailersFuture,
        optionsRep,
      });

      // Mark options as immutable
      if (optionsRep !== null) {
        const opts = optionsOf(ctx).get(optionsRep);
        if (opts) opts.immutable = true;
      }

      // Create the transmit result future
      const futPacked = state.futureNew(0);
      const futRi = Number(futPacked & 0xFFFFFFFFn);
      const futWi = Number(futPacked >> 32n);

      // Store the writable future handle on the request so we can resolve it after send
      (requestsOf(ctx).get(rep) as any)._transmitFutWi = futWi;

      return [rep, futRi];
    },

    '[method]request.get-method'(self: number): Method {
      return requestsOf(ctx).get(self)?.method ?? { tag: 'get' };
    },

    '[method]request.set-method'(self: number, method: Method): { tag: 'ok' } | { tag: 'err' } {
      const req = requestsOf(ctx).get(self);
      if (!req) return { tag: 'err' };
      if (!isValidMethod(method)) return { tag: 'err' };
      req.method = method;
      return { tag: 'ok' };
    },

    '[method]request.get-path-with-query'(self: number): string | null {
      return requestsOf(ctx).get(self)?.pathWithQuery ?? null;
    },

    '[method]request.set-path-with-query'(self: number, path: string | null): { tag: 'ok' } | { tag: 'err' } {
      const req = requestsOf(ctx).get(self);
      if (!req) return { tag: 'err' };
      if (path !== null && !isValidPath(path)) return { tag: 'err' };
      req.pathWithQuery = path;
      return { tag: 'ok' };
    },

    '[method]request.get-scheme'(self: number): Scheme | null {
      return requestsOf(ctx).get(self)?.scheme ?? null;
    },

    '[method]request.set-scheme'(self: number, scheme: Scheme | null): { tag: 'ok' } | { tag: 'err' } {
      const req = requestsOf(ctx).get(self);
      if (!req) return { tag: 'err' };
      if (scheme !== null && !isValidScheme(scheme)) return { tag: 'err' };
      req.scheme = scheme;
      return { tag: 'ok' };
    },

    '[method]request.get-authority'(self: number): string | null {
      return requestsOf(ctx).get(self)?.authority ?? null;
    },

    '[method]request.set-authority'(self: number, authority: string | null): { tag: 'ok' } | { tag: 'err' } {
      const req = requestsOf(ctx).get(self);
      if (!req) return { tag: 'err' };
      if (authority !== null && !isValidAuthority(authority)) return { tag: 'err' };
      req.authority = authority;
      return { tag: 'ok' };
    },

    '[method]request.get-options'(self: number): number | null {
      return requestsOf(ctx).get(self)?.optionsRep ?? null;
    },

    '[method]request.get-headers'(self: number): number {
      return requestsOf(ctx).get(self)?.headersRep ?? 0;
    },

    '[static]request.consume-body'(
      requestRep: number,
      resFuture: number,
    ): [number, number] {
      const state = ctx.state!;
      // Drop the res-future readable end (caller signals completion, we don't need to wait)
      state.futureDropReadable(0, resFuture);
      const req = requestsOf(ctx).get(requestRep);

      let bodyStreamRi: number;
      let trailersFutureRi: number;

      if (req && req.bodyStreamHandle !== null) {
        // Handler pattern: return existing body stream and trailers readable ends
        bodyStreamRi = req.bodyStreamHandle;
        trailersFutureRi = req.trailersFutureHandle;
      } else {
        // No body: create empty stream, resolve trailers as null
        const sPacked = state.streamNew(0);
        bodyStreamRi = Number(sPacked & 0xFFFFFFFFn);
        state.streamDropWritable(0, Number(sPacked >> 32n));

        const fPacked = state.futureNew(0);
        trailersFutureRi = Number(fPacked & 0xFFFFFFFFn);
        state.futureWriteHost(0, Number(fPacked >> 32n), [{ tag: 'ok', val: null }]);

        if (req) state.futureDropReadable(0, req.trailersFutureHandle);
      }

      // Remove the request resource (consume-body moves it)
      requestsOf(ctx).delete(requestRep);

      return [bodyStreamRi, trailersFutureRi];
    },

    '[resource-drop]request'(rep: number): void {
      const req = requestsOf(ctx).get(rep);
      if (req) {
        const state = ctx.state!;
        if (req.bodyStreamEnd) {
          req.bodyStreamEnd.drop();
        } else if (req.bodyStreamHandle !== null) {
          state.streamDropReadable(0, req.bodyStreamHandle);
        }
        state.futureDropReadable(0, req.trailersFutureHandle);
        requestsOf(ctx).delete(rep);
      }
    },

    // ---- request-options resource ----
    '[constructor]request-options'(): number {
      const rep = newRep(ctx);
      optionsOf(ctx).set(rep, {
        connectTimeout: null,
        firstByteTimeout: null,
        betweenBytesTimeout: null,
        immutable: false,
      });
      return rep;
    },

    '[method]request-options.get-connect-timeout'(self: number): bigint | null {
      return optionsOf(ctx).get(self)?.connectTimeout ?? null;
    },

    '[method]request-options.set-connect-timeout'(self: number, duration: bigint | null): { tag: 'ok' } | { tag: 'err'; val: RequestOptionsError } {
      const opts = optionsOf(ctx).get(self);
      if (!opts) return { tag: 'err', val: { tag: 'not-supported' } };
      if (opts.immutable) return { tag: 'err', val: { tag: 'immutable' } };
      opts.connectTimeout = duration;
      return { tag: 'ok' };
    },

    '[method]request-options.get-first-byte-timeout'(self: number): bigint | null {
      return optionsOf(ctx).get(self)?.firstByteTimeout ?? null;
    },

    '[method]request-options.set-first-byte-timeout'(self: number, duration: bigint | null): { tag: 'ok' } | { tag: 'err'; val: RequestOptionsError } {
      const opts = optionsOf(ctx).get(self);
      if (!opts) return { tag: 'err', val: { tag: 'not-supported' } };
      if (opts.immutable) return { tag: 'err', val: { tag: 'immutable' } };
      opts.firstByteTimeout = duration;
      return { tag: 'ok' };
    },

    '[method]request-options.get-between-bytes-timeout'(self: number): bigint | null {
      return optionsOf(ctx).get(self)?.betweenBytesTimeout ?? null;
    },

    '[method]request-options.set-between-bytes-timeout'(self: number, duration: bigint | null): { tag: 'ok' } | { tag: 'err'; val: RequestOptionsError } {
      const opts = optionsOf(ctx).get(self);
      if (!opts) return { tag: 'err', val: { tag: 'not-supported' } };
      if (opts.immutable) return { tag: 'err', val: { tag: 'immutable' } };
      opts.betweenBytesTimeout = duration;
      return { tag: 'ok' };
    },

    '[method]request-options.clone'(self: number): number {
      const opts = optionsOf(ctx).get(self);
      const rep = newRep(ctx);
      optionsOf(ctx).set(rep, {
        connectTimeout: opts?.connectTimeout ?? null,
        firstByteTimeout: opts?.firstByteTimeout ?? null,
        betweenBytesTimeout: opts?.betweenBytesTimeout ?? null,
        immutable: false,
      });
      return rep;
    },

    '[resource-drop]request-options'(rep: number): void {
      optionsOf(ctx).delete(rep);
    },

    // ---- response resource ----
    '[static]response.new'(
      headersRep: number,
      contentsStream: number | null,
      trailersFuture: number,
    ): [number, number] {
      const state = ctx.state!;
      const rep = newRep(ctx);

      // Mark headers as immutable
      const hdr = fieldsOf(ctx).get(headersRep);
      if (hdr) hdr.immutable = true;

      const resp: ResponseResource = {
        statusCode: 200,
        headersRep,
        body: new Uint8Array(0),
        trailers: null,
        bodyStreamHandle: contentsStream,
        trailersFutureHandle: trailersFuture,
      };
      responsesOf(ctx).set(rep, resp);

      // Track for handler test infrastructure
      ctx.lastResponseRep = rep;

      // In handler mode: eagerly drain the body stream and accept the trailers
      // future so the component's writes don't block.
      if (ctx.handlerMode) {
        if (contentsStream !== null) {
          const bodyEnd = state.liftStreamEnd(0, contentsStream) as ReadableStreamEnd;
          resp.bodyStreamHandle = null;
          const pipeBody = async () => {
            const chunks: Uint8Array[] = [];
            while (true) {
              const chunk = await hostReadChunk(bodyEnd);
              if (!chunk) break;
              if (chunk.length > 0) chunks.push(chunk);
            }
            if (chunks.length > 0) {
              const totalLen = chunks.reduce((s, c) => s + c.length, 0);
              const buf = new Uint8Array(totalLen);
              let off = 0;
              for (const c of chunks) { buf.set(c, off); off += c.length; }
              resp.body = buf;
            }
          };
          state.trackHostAsync(pipeBody());
        }

        // Lift the trailers future readable end and register a host-side reader
        // so the component's future.write completes with COMPLETED.
        const trailersEnd = state.liftFutureEnd(0, trailersFuture) as ReadableFutureEnd;
        resp.trailersFutureHandle = null;
        const hostBuf: WritableStreamBuffer = {
          progress: 0,
          remain() { return 1; },
          isZeroLength() { return false; },
          write(_items: unknown[]) { this.progress += _items.length; },
        };
        trailersEnd.shared.read(hostBuf, (_result) => {});
      }

      // Create transmit result future
      const futPacked = state.futureNew(0);
      const futRi = Number(futPacked & 0xFFFFFFFFn);
      const futWi = Number(futPacked >> 32n);

      // Resolve immediately for host-created responses: result<_, error-code> → ok
      state.futureWriteHost(0, futWi, [{ tag: 'ok' }]);

      return [rep, futRi];
    },

    '[method]response.get-status-code'(self: number): number {
      return responsesOf(ctx).get(self)?.statusCode ?? 0;
    },

    '[method]response.set-status-code'(self: number, code: number): { tag: 'ok' } | { tag: 'err' } {
      const resp = responsesOf(ctx).get(self);
      if (!resp) return { tag: 'err' };
      if (code < 100 || code > 999) return { tag: 'err' };
      resp.statusCode = code;
      return { tag: 'ok' };
    },

    '[method]response.get-headers'(self: number): number {
      return responsesOf(ctx).get(self)?.headersRep ?? 0;
    },

    '[static]response.consume-body'(
      responseRep: number,
      resFuture: number,
    ): [number, number] {
      const state = ctx.state!;
      // Drop the res-future readable end (caller signals completion, we don't need to wait)
      state.futureDropReadable(0, resFuture);
      const resp = responsesOf(ctx).get(responseRep);

      // Create body stream
      const sPacked = state.streamNew(0);
      const sRi = Number(sPacked & 0xFFFFFFFFn);
      const sWi = Number(sPacked >> 32n);

      // Create trailers future
      const fPacked = state.futureNew(0);
      const fRi = Number(fPacked & 0xFFFFFFFFn);
      const fWi = Number(fPacked >> 32n);

      if (resp) {
        if (resp.nodeResponse) {
          // Lazy body streaming from Node.js http response with flow control.
          // Each chunk waits for the previous one to be consumed before writing
          // the next, preventing data loss from overwriting pending buffers.
          const nodeRes = resp.nodeResponse;
          const pendingChunks: Buffer[] = [];
          let flushing = false;
          let done = false;

          const flushNext = () => {
            flushing = false;
            if (pendingChunks.length === 0) {
              if (done) {
                state.streamDropWritable(0, sWi);
                state.futureWriteHost(0, fWi, [{ tag: 'ok', val: null }]);
              }
              return;
            }
            const chunk = pendingChunks.shift()!;
            flushing = true;
            state.streamWriteHost(0, sWi, Array.from(chunk), flushNext);
          };

          const pipeBody = async () => {
            try {
              for await (const chunk of nodeRes) {
                if (chunk && chunk.length > 0) {
                  if (!flushing) {
                    flushing = true;
                    state.streamWriteHost(0, sWi, Array.from(chunk as Buffer), flushNext);
                  } else {
                    pendingChunks.push(chunk as Buffer);
                  }
                }
              }
            } catch (_) { /* response body read error */ }
            done = true;
            if (!flushing) {
              state.streamDropWritable(0, sWi);
              state.futureWriteHost(0, fWi, [{ tag: 'ok', val: null }]);
            }
          };
          state.trackHostAsync(pipeBody());
        } else {
          // Pre-buffered body data
          if (resp.body.length > 0) {
            state.streamWriteHost(0, sWi, Array.from(resp.body));
          }
          state.streamDropWritable(0, sWi);

          // Write trailers to the future as structured value
          if (resp.trailers) {
            const tRep = newRep(ctx);
            fieldsOf(ctx).set(tRep, { entries: resp.trailers, immutable: true });
            state.futureWriteHost(0, fWi, [{ tag: 'ok', val: tRep }]);
          } else {
            state.futureWriteHost(0, fWi, [{ tag: 'ok', val: null }]);
          }
        }
      } else {
        state.streamDropWritable(0, sWi);
        state.futureWriteHost(0, fWi, [{ tag: 'ok', val: null }]);
      }

      // Clean up original body stream / trailers future handles
      if (resp) {
        if (resp.bodyStreamHandle !== null) {
          state.streamDropReadable(0, resp.bodyStreamHandle);
        }
        if (resp.trailersFutureHandle !== null) {
          state.futureDropReadable(0, resp.trailersFutureHandle);
        }
      }

      // Consume the response
      responsesOf(ctx).delete(responseRep);

      return [sRi, fRi];
    },

    '[resource-drop]response'(rep: number): void {
      const resp = responsesOf(ctx).get(rep);
      if (resp) {
        const state = ctx.state!;
        if (resp.bodyStreamHandle !== null) {
          state.streamDropReadable(0, resp.bodyStreamHandle);
        }
        if (resp.trailersFutureHandle !== null) {
          state.futureDropReadable(0, resp.trailersFutureHandle);
        }
        responsesOf(ctx).delete(rep);
      }
    },
  };
}

// ---- Shared HTTP fetch helpers ----

function methodToString(m: Method): string {
  if ('val' in m) return m.val;
  return m.tag.toUpperCase();
}

function schemeToString(s: Scheme | null): string {
  if (!s) return 'http';
  if ('val' in s) return s.val;
  return s.tag.toLowerCase();
}

/**
 * Shared implementation: execute an HTTP request and return a response resource rep.
 *
 * Uses Node.js http.request() with flushHeaders() so the server receives
 * request headers immediately (before the body is sent). This avoids a
 * deadlock: the guest writes body data via callback turns AFTER the subtask
 * returns, so the response headers must arrive before the body is fully sent.
 *
 * Body stream piping runs concurrently via trackHostAsync so the event loop
 * can interleave guest callback turns (writing body data) with the HTTP
 * connection (reading body data).
 */
function executeHttpRequest(
  ctx: HttpHostContext,
  req: RequestResource,
  transmitFutWi?: number,
): Promise<{ tag: 'ok'; val: number } | { tag: 'err'; val: HttpErrorCode }> {
  const state = ctx.state!;

  // Read headers
  const headers = fieldsOf(ctx).get(req.headersRep);
  const headerObj: Record<string, string[]> = {};
  for (const [n, v] of headers?.entries ?? []) {
    const name = n.toLowerCase();
    if (!headerObj[name]) headerObj[name] = [];
    headerObj[name].push(new TextDecoder().decode(v));
  }

  // Helper: resolve the transmit future with an error and return an error result
  const earlyError = (errorCode: HttpErrorCode): Promise<{ tag: 'err'; val: HttpErrorCode }> => {
    if (transmitFutWi !== undefined) {
      try {
        state.futureWriteHost(0, transmitFutWi, [{ tag: 'err' as const, val: errorCode }]);
      } catch { /* future may already be resolved */ }
    }
    return Promise.resolve({ tag: 'err' as const, val: errorCode });
  };

  // Parse authority into hostname + port
  const schemePart = schemeToString(req.scheme);
  const authority = req.authority || 'localhost';
  if (req.pathWithQuery === null) {
    return earlyError({ tag: 'HTTP-request-URI-too-long' as const });
  }
  const path = req.pathWithQuery;
  const method = methodToString(req.method);

  // Only HTTP and HTTPS schemes are supported
  if (schemePart !== 'http' && schemePart !== 'https') {
    return earlyError({ tag: 'HTTP-protocol-error' as const });
  }

  const isHttps = schemePart === 'https';
  let hostname: string;
  let port: number = isHttps ? 443 : 80;
  if (authority.startsWith('[')) {
    // IPv6: [::1]:port or [::1]
    const closeBracket = authority.indexOf(']');
    hostname = authority.substring(1, closeBracket);
    const after = authority.substring(closeBracket + 1);
    if (after.startsWith(':')) {
      port = parseInt(after.substring(1), 10);
    }
  } else {
    hostname = authority;
    const colonIdx = authority.lastIndexOf(':');
    if (colonIdx > 0) {
      hostname = authority.substring(0, colonIdx);
      port = parseInt(authority.substring(colonIdx + 1), 10);
    }
  }

  // Build the flat headers for http.request (merge multi-value headers)
  const reqHeaders: Record<string, string | string[]> = {};
  for (const [name, values] of Object.entries(headerObj)) {
    reqHeaders[name] = values.length === 1 ? values[0]! : values;
  }

  // Pipe body when a body stream is provided
  const hasBody = req.bodyStreamEnd != null || req.bodyStreamHandle !== null;
  if (hasBody) {
    reqHeaders['transfer-encoding'] = 'chunked';
  }

  return new Promise((resolve) => {
    const reqFn = isHttps ? nodeHttps.request : nodeHttp.request;
    const nodeReq = reqFn({
      hostname,
      port,
      path,
      method,
      headers: reqHeaders,
    });

    // Send request headers immediately (before body data is available).
    // This allows the server to respond before the body is fully sent.
    nodeReq.flushHeaders();

    // Check Content-Length for body validation
    const contentLengthStr = headerObj['content-length']?.[0];
    const expectedBytes = contentLengthStr ? parseInt(contentLengthStr, 10) : null;

    const resolveTransmit = (bytesSent: number | null): void => {
      if (transmitFutWi === undefined) return;
      try {
        const val = bytesSent === null
          ? [{ tag: 'ok' as const }]
          : [{ tag: 'err' as const, val: { tag: 'HTTP-request-body-size' as const, val: BigInt(bytesSent) } }];
        state.futureWriteHost(0, transmitFutWi, val);
      } catch { /* future may already be resolved */ }
    };

    // Pipe body data in the background
    if (hasBody) {
      const streamEnd = req.bodyStreamEnd ?? state.liftStreamEnd(0, req.bodyStreamHandle!) as ReadableStreamEnd;
      const pipeBody = async () => {
        let bytesSent = 0;
        let clViolation = false;
        try {
          while (true) {
            if (expectedBytes !== null) {
              // Content-Length enforcement: wait for the component to write,
              // then check the pending write size BEFORE doing the rendezvous.
              // A zero-length read waits for the writer to become pending.
              const writerReady = await new Promise<boolean>((resolve) => {
                const zeroBuf: WritableStreamBuffer = {
                  progress: 0,
                  remain() { return 0; },
                  isZeroLength() { return true; },
                  write() {},
                };
                streamEnd.copy(zeroBuf, () => resolve(true), (result) => {
                  resolve(result !== CopyResult.DROPPED);
                });
              });
              if (!writerReady) break; // Stream dropped/closed

              // Check pending write size against remaining Content-Length allowance
              const pendingSize = streamEnd.shared.pendingWriteSize();
              if (pendingSize !== null && bytesSent + pendingSize > expectedBytes) {
                // Write would exceed Content-Length — drop the stream
                streamEnd.drop();
                resolveTransmit(bytesSent + pendingSize);
                clViolation = true;
                break;
              }
            }

            const chunk = await hostReadChunk(streamEnd);
            if (!chunk) break;
            if (chunk.length > 0) {
              bytesSent += chunk.length;
              nodeReq.write(chunk);
            }
          }
        } catch {
          // Stream read error — end the request
        }
        nodeReq.end();
        if (!clViolation) {
          if (expectedBytes !== null && bytesSent !== expectedBytes) {
            resolveTransmit(bytesSent);
          } else {
            resolveTransmit(null);
          }
        }
      };
      state.trackHostAsync(pipeBody());
    } else {
      nodeReq.end();
      resolveTransmit(null);
    }

    nodeReq.on('response', (nodeRes: IncomingMessage) => {
      // Build response headers
      const respHeaders: [string, Uint8Array][] = [];
      const raw = nodeRes.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) {
        respHeaders.push([raw[i]!.toLowerCase(), new TextEncoder().encode(raw[i + 1]!)]);
      }

      const respHeadersRep = newRep(ctx);
      fieldsOf(ctx).set(respHeadersRep, { entries: respHeaders, immutable: true });

      const respRep = newRep(ctx);
      responsesOf(ctx).set(respRep, {
        statusCode: nodeRes.statusCode ?? 200,
        headersRep: respHeadersRep,
        body: new Uint8Array(0),
        trailers: null,
        bodyStreamHandle: null,
        trailersFutureHandle: null,
        nodeResponse: nodeRes,
      });
      ctx.lastResponseRep = respRep;

      resolve({ tag: 'ok' as const, val: respRep });
    });

    nodeReq.on('error', (err: NodeJS.ErrnoException) => {
      resolveTransmit(null); // Resolve transmit as OK — the error is in the handler result
      const code = err.code || '';
      const msg = err.message || '';
      if (code === 'ENOTFOUND' || msg.includes('getaddrinfo')) {
        resolve({ tag: 'err' as const, val: { tag: 'DNS-error' as const, val: { rcode: null, 'info-code': null } } });
      } else if (code === 'ECONNREFUSED') {
        resolve({ tag: 'err' as const, val: { tag: 'connection-refused' as const } });
      } else if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || msg.includes('timeout')) {
        resolve({ tag: 'err' as const, val: { tag: 'connection-timeout' as const } });
      } else {
        resolve({ tag: 'err' as const, val: { tag: 'internal-error' as const, val: msg } });
      }
    });
  });
}

// ---- HTTP handler implementation ----

export function createHttpHandlerHost(ctx: HttpHostContext) {
  return {
    async '[async]handle'(requestRep: number): Promise<{ tag: 'ok'; val: number } | { tag: 'err'; val: HttpErrorCode }> {
      const state = ctx.state!;
      const req = requestsOf(ctx).get(requestRep);
      if (!req) {
        return { tag: 'err', val: { tag: 'internal-error', val: 'request not found' } };
      }

      const transmitFutWi = (req as any)._transmitFutWi as number | undefined;

      // Remove request resource (handle consumes it)
      requestsOf(ctx).delete(requestRep);

      return executeHttpRequest(ctx, req, transmitFutWi);
    },
  };
}

// ---- HTTP client implementation ----

export function createHttpClientHost(ctx: HttpHostContext) {
  return {
    async send(requestRep: number): Promise<{ tag: 'ok'; val: number } | { tag: 'err'; val: HttpErrorCode }> {
      const state = ctx.state!;
      const req = requestsOf(ctx).get(requestRep);
      if (!req) {
        return { tag: 'err', val: { tag: 'internal-error', val: 'request not found' } };
      }

      const transmitFutWi = (req as any)._transmitFutWi as number | undefined;

      // Remove request resource (send consumes it)
      requestsOf(ctx).delete(requestRep);

      return executeHttpRequest(ctx, req, transmitFutWi);
    },
  };
}
