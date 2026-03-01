// WASI P3 Socket Host Implementation
//
// Implements wasi:sockets/types TCP and UDP socket resources
// using Node.js net/dgram modules. Supports cancellation of
// async operations via AbortController.

import * as net from 'node:net';
import * as dgram from 'node:dgram';
import * as dns from 'node:dns/promises';
import type { ReadableStreamEnd } from '../runtime/stream.ts';
import { SocketsErrorCode, IpNameLookupErrorCode, type IpAddressFamily, type IpSocketAddress, type IpAddress, type WasiSocketsTypes, type WasiSocketsIpNameLookup } from './wasi-types.generated.ts';
import { hostReadChunk, type HostContext } from './wasi-shared.ts';

// Portable libuv error constants (differ by platform: macOS vs Linux)
const UV = (process as any).binding('uv') as Record<string, number>;
const UV_EINVAL = UV.UV_EINVAL;       // -22 on macOS, -22 on Linux
const UV_EADDRINUSE = UV.UV_EADDRINUSE; // -48 on macOS, -98 on Linux
const UV_EACCES = UV.UV_EACCES;       // -13 on macOS, -13 on Linux


// Map Node.js error codes to WASI error codes
function mapError(err: any): SocketsErrorCode {
  const code = err?.code || err?.errno;
  switch (code) {
    case 'EACCES': case 'EPERM': return SocketsErrorCode.AccessDenied;
    case 'EADDRINUSE': return SocketsErrorCode.AddressInUse;
    case 'EADDRNOTAVAIL': return SocketsErrorCode.AddressNotBindable;
    case 'ECONNREFUSED': return SocketsErrorCode.ConnectionRefused;
    case 'ECONNRESET': return SocketsErrorCode.ConnectionReset;
    case 'ECONNABORTED': return SocketsErrorCode.ConnectionAborted;
    case 'EHOSTUNREACH': case 'ENETUNREACH': return SocketsErrorCode.RemoteUnreachable;
    case 'EINVAL': case 'EAFNOSUPPORT': return SocketsErrorCode.InvalidArgument;
    case 'ETIMEDOUT': return SocketsErrorCode.Timeout;
    case 'ENOTSUP': case 'EOPNOTSUPP': return SocketsErrorCode.NotSupported;
    case 'ERR_SOCKET_CLOSED': case 'ABORT_ERR': return SocketsErrorCode.ConnectionAborted;
    default: return SocketsErrorCode.Unknown;
  }
}

// ---- Address types ----

interface NodeAddress {
  host: string;
  port: number;
  family: number;
}

// ---- Address conversion ----

function socketAddressToNode(addr: IpSocketAddress): NodeAddress {
  if (addr.tag === 'ipv4') {
    const { port, address } = addr.val;
    return { host: `${address[0]}.${address[1]}.${address[2]}.${address[3]}`, port, family: 4 };
  } else {
    const { port, address } = addr.val;
    const segments = address.map((s: number) => s.toString(16));
    return { host: segments.join(':'), port, family: 6 };
  }
}

function nodeAddressToResult(address: string, port: number, family: string | number): { tag: 'ok'; val: IpSocketAddress } | { tag: 'err'; val: SocketsErrorCode } {
  if (family === 'IPv4' || family === 4 || !family) {
    const parts = address.split('.').map(Number);
    return {
      tag: 'ok',
      val: { tag: 'ipv4', val: { port, address: [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] || 0] as [number, number, number, number] } },
    };
  } else {
    const groups = parseIPv6Groups(address);
    return {
      tag: 'ok',
      val: { tag: 'ipv6', val: { port, 'flow-info': 0, address: groups as [number, number, number, number, number, number, number, number], 'scope-id': 0 } },
    };
  }
}

function parseIPv6Groups(address: string): number[] {
  const groups = new Array(8).fill(0);
  if (!address || address === '::') return groups;
  const sides = address.split('::');
  if (sides.length === 2) {
    const left = sides[0] ? sides[0].split(':').map(s => parseInt(s, 16)) : [];
    const right = sides[1] ? sides[1].split(':').map(s => parseInt(s, 16)) : [];
    for (let i = 0; i < left.length; i++) groups[i] = left[i]!;
    for (let i = 0; i < right.length; i++) groups[8 - right.length + i] = right[i]!;
  } else {
    const parts = address.split(':').map(s => parseInt(s, 16));
    for (let i = 0; i < Math.min(8, parts.length); i++) groups[i] = parts[i]!;
  }
  return groups;
}

// ---- TCP Socket State ----

const STATE = {
  UNBOUND: 'unbound',
  BOUND: 'bound',
  LISTENING: 'listening',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  CLOSED: 'closed',
} as const;

type SocketState = typeof STATE[keyof typeof STATE];

// Internal Node.js tcp_wrap binding for synchronous socket operations
const { TCP, constants: TCPConstants } = (process as any).binding('tcp_wrap');

// Internal Node.js udp_wrap binding for synchronous socket operations
const { UDP: UDPWrap } = (process as any).binding('udp_wrap');

class TcpSocketHandle {
  family: string; // 'ipv4' or 'ipv6'
  state: SocketState;
  socket: net.Socket | null;
  server: net.Server | null;
  nativeHandle: any; // tcp_wrap handle for synchronous bind
  localAddress: string | null;
  localPort: number | null;
  remoteAddress: string | undefined;
  remotePort: number | undefined;
  abortController: AbortController | null;
  backlogSize: number;
  // Socket options
  keepAliveEnabled: boolean = false;
  keepAliveIdleTime: bigint = 7200000000000n; // 2 hours in nanoseconds
  keepAliveInterval: bigint = 75000000000n; // 75 seconds in nanoseconds
  keepAliveCount: number = 9;
  hopLimit: number = 64;
  receiveBufferSize: bigint = 65536n;
  sendBufferSize: bigint = 65536n;

  // Track whether send/receive have been called (each may only be called once).
  sendStarted: boolean = false;
  sendDone: boolean = false;
  receiveStarted: boolean = false;

  // Ref counting: socket stays alive while active send/receive operations exist.
  // Per WASI spec, streams remain operational after the socket resource is dropped.
  activeStreams: number = 0;
  removedFromTable: boolean = false;

  constructor(family: string) {
    this.family = family;
    this.state = STATE.UNBOUND;
    this.socket = null;
    this.server = null;
    this.nativeHandle = null;
    this.localAddress = null;
    this.localPort = null;
    this.remoteAddress = undefined;
    this.remotePort = undefined;
    this.abortController = null;
    this.backlogSize = 128;
  }

  addStreamRef(): void {
    this.activeStreams++;
  }

  removeStreamRef(): void {
    this.activeStreams--;
    if (this.activeStreams <= 0 && this.removedFromTable) {
      this.destroy();
    }
  }

  destroy(): void {
    if (this.socket) {
      const sock = this.socket;
      // End the write side first (sends FIN), then destroy after draining.
      // This ensures in-flight data is delivered before the socket is torn down,
      // while still causing RST for any future writes from the remote.
      if (!this.sendStarted || this.sendDone) {
        sock.end();
      }
      sock.once('finish', () => sock.destroy());
      sock.unref();
      this.socket = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.nativeHandle) {
      this.nativeHandle.close();
      this.nativeHandle = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.state = STATE.CLOSED;
  }
}

class UdpSocketHandle {
  family: string; // 'ipv4' or 'ipv6'
  socket: dgram.Socket | null;
  nativeHandle: any; // udp_wrap handle for synchronous bind
  localAddress: string | null;
  localPort: number | null;
  bound: boolean;
  connected: boolean;
  remoteAddress: string | null;
  remotePort: number | null;
  abortController: AbortController | null;
  // Socket options
  unicastHopLimit: number = 64;
  receiveBufferSize: bigint = 65536n;
  sendBufferSize: bigint = 65536n;
  // Buffer for messages that arrived before receive() was called
  receivedMessages: Array<{ data: Uint8Array; rinfo: dgram.RemoteInfo }> = [];

  constructor(family: string) {
    this.family = family;
    this.socket = null;
    this.nativeHandle = null;
    this.localAddress = null;
    this.localPort = null;
    this.bound = false;
    this.connected = false;
    this.remoteAddress = null;
    this.remotePort = null;
    this.abortController = null;
  }

  // Get the native UDP handle, whether it's the pre-socket native handle or
  // extracted from the dgram socket's internal state.
  getNativeHandle(): any {
    if (this.nativeHandle) return this.nativeHandle;
    if (this.socket) {
      const stateKey = Object.getOwnPropertySymbols(this.socket)
        .find(s => s.toString().includes('state symbol'));
      if (stateKey) return (this.socket as any)[stateKey]?.handle ?? null;
    }
    return null;
  }

  // Ensure a dgram.Socket exists, creating one from the native handle if needed
  ensureSocket(): dgram.Socket {
    if (this.socket) return this.socket;
    const type = this.family === 'ipv4' ? 'udp4' : 'udp6';
    this.socket = dgram.createSocket({ type });
    if (this.nativeHandle) {
      // Attach the pre-bound native handle to the dgram socket.
      // Find the state symbol and replace the handle + mark as bound.
      const stateKey = Object.getOwnPropertySymbols(this.socket)
        .find(s => s.toString().includes('state symbol'));
      if (stateKey) {
        const state = (this.socket as any)[stateKey];
        const nh = this.nativeHandle;
        // Copy the lookup function from the default handle before closing it
        nh.lookup = state.handle.lookup;
        // Transfer owner_symbol so the handle references the dgram socket
        const ownerSym = Object.getOwnPropertySymbols(state.handle)
          .find(s => s.toString().includes('owner'));
        if (ownerSym) nh[ownerSym] = this.socket;
        state.handle.close();
        state.handle = nh;
        state.bindState = 2; // BIND_STATE_BOUND
        if (this.connected) state.connectState = 2; // CONNECT_STATE_CONNECTED
        // Start receiving. Since we bypassed dgram.bind(), onmessage was never
        // set up internally. Buffer incoming messages so they aren't lost if they
        // arrive before receive() sets up a listener.
        const self = this;
        const sock = this.socket;
        nh.onmessage = function(nread: number, _handle: unknown, buf: Buffer, rinfo: { address: string; family: string; port: number }) {
          if (nread < 0) {
            sock.emit('error', new Error('recv error: ' + nread));
            return;
          }
          const msg = { data: new Uint8Array(buf.buffer, buf.byteOffset, nread), rinfo: {
            address: rinfo.address, family: rinfo.family,
            port: rinfo.port, size: nread,
          } as dgram.RemoteInfo };
          if (sock.listenerCount('message') > 0) {
            sock.emit('message', msg.data, msg.rinfo);
          } else if (self.receivedMessages.length < 1024) {
            self.receivedMessages.push(msg);
          }
        };
        nh.recvStart();
        state.receiving = true;
      }
      this.nativeHandle = null;
    }
    return this.socket;
  }

  destroy(): void {
    if (this.socket) {
      try { this.socket.close(); } catch (_e) { /* ignore */ }
      this.socket = null;
    }
    if (this.nativeHandle) {
      this.nativeHandle.close();
      this.nativeHandle = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}

// ---- Socket Host Factory ----

export function createSocketHost(ctx: HostContext, _opts: Record<string, unknown> = {}): WasiSocketsTypes & Record<string, (...args: any[]) => any> {
  // Resource tables for sockets (host-side, NOT in ComponentState)
  const tcpSockets = new Map<number, TcpSocketHandle>();
  const udpSockets = new Map<number, UdpSocketHandle>();
  let nextTcpId = 1;
  let nextUdpId = 1;

  function getTcp(handle: number): TcpSocketHandle {
    let s = tcpSockets.get(handle);
    if (s) return s;
    // Translate via handle table for resource-transferred handles (e.g., from accept stream)
    const state = ctx.state;
    if (state) {
      try {
        const rh = state.getResourceHandle(handle);
        s = tcpSockets.get(rh.rep);
        if (s) return s;
      } catch (_) { /* ignore */ }
    }
    throw new Error(`invalid tcp-socket handle: ${handle}`);
  }

  function getUdp(handle: number): UdpSocketHandle {
    let s = udpSockets.get(handle);
    if (s) return s;
    const state = ctx.state;
    if (state) {
      try {
        const rh = state.getResourceHandle(handle);
        s = udpSockets.get(rh.rep);
        if (s) return s;
      } catch (_) { /* ignore */ }
    }
    throw new Error(`invalid udp-socket handle: ${handle}`);
  }

  return {
    // ---- TCP Socket ----

    '[static]tcp-socket.create': (addressFamily: string) => {
      const id = nextTcpId++;
      tcpSockets.set(id, new TcpSocketHandle(addressFamily));
      return { tag: 'ok', val: id };
    },

    '[method]tcp-socket.bind': (handle: number, addrParams: IpSocketAddress) => {
      const s = getTcp(handle);
      if (s.state !== STATE.UNBOUND) return { tag: 'err', val: SocketsErrorCode.InvalidState };

      // Check address family matches socket family
      const addrFamily = addrParams.tag === 'ipv4' ? 'ipv4' : 'ipv6';
      if (addrFamily !== s.family) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };

      // Reject IPv4-mapped IPv6 addresses (no dual-stack in WASI)
      if (addrParams.tag === 'ipv6') {
        const a = addrParams.val.address;
        if (a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0 && a[4] === 0 && a[5] === 0xffff) {
          return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        }
      }

      const addr = socketAddressToNode(addrParams);

      // Use tcp_wrap for synchronous bind to get ephemeral port assignment.
      // Probe-listen to detect address-in-use (SO_REUSEADDR hides conflicts at bind time).
      const probe = new TCP(TCPConstants.SERVER);
      const bindFn = addr.family === 6 ? 'bind6' : 'bind';
      const bindErr = probe[bindFn](addr.host, addr.port);
      if (bindErr) {
        probe.close();
        if (bindErr === UV_EINVAL) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        if (bindErr === UV_EADDRINUSE) return { tag: 'err', val: SocketsErrorCode.AddressInUse };
        if (bindErr === UV_EACCES) return { tag: 'err', val: SocketsErrorCode.AccessDenied };
        return { tag: 'err', val: SocketsErrorCode.AddressNotBindable };
      }

      const out: { address?: string; port?: number } = {};
      probe.getsockname(out);
      const listenErr = probe.listen(1);
      probe.close();

      if (listenErr) {
        return { tag: 'err', val: SocketsErrorCode.AddressInUse };
      }

      // Rebind on the actual handle now that we know the port is available
      const tcp = new TCP(TCPConstants.SERVER);
      tcp[bindFn](out.address, out.port);
      s.nativeHandle = tcp;
      s.localAddress = out.address ?? addr.host;
      s.localPort = out.port ?? addr.port;
      s.state = STATE.BOUND;
      return { tag: 'ok' };
    },

    '[method]tcp-socket.connect': (handle: number, addrParams: IpSocketAddress) => {
      const s = getTcp(handle);
      if (s.state === STATE.CONNECTED || s.state === STATE.LISTENING || s.state === STATE.CONNECTING) {
        return { tag: 'err', val: SocketsErrorCode.InvalidState };
      }

      // Check address family matches socket family
      const addrFamily = addrParams.tag === 'ipv4' ? 'ipv4' : 'ipv6';
      if (addrFamily !== s.family) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };

      // Reject unspecified address (0.0.0.0 / ::)
      if (addrParams.tag === 'ipv4') {
        const a = addrParams.val.address;
        if (a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0) {
          return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        }
        // Reject broadcast (255.255.255.255)
        if (a[0] === 255 && a[1] === 255 && a[2] === 255 && a[3] === 255) {
          return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        }
        // Reject multicast (224.0.0.0 – 239.255.255.255)
        if (a[0]! >= 224 && a[0]! <= 239) {
          return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        }
      } else {
        const a = addrParams.val.address;
        if (a.every((x: number) => x === 0)) {
          return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        }
        // Reject IPv4-mapped IPv6 addresses
        if (a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0 && a[4] === 0 && a[5] === 0xffff) {
          return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        }
        // Reject IPv6 multicast (ff00::/8)
        if ((a[0]! & 0xff00) === 0xff00) {
          return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        }
      }

      // Reject port 0
      if (addrParams.val.port === 0) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };

      const addr = socketAddressToNode(addrParams);
      s.state = STATE.CONNECTING;

      // Close native bind handle before connecting — net.connect() will rebind
      if (s.nativeHandle) {
        s.nativeHandle.close();
        s.nativeHandle = null;
      }

      const connectOpts: net.TcpNetConnectOpts = {
        host: addr.host,
        port: addr.port,
        family: addr.family as 4 | 6,
        allowHalfOpen: true,
      };

      if (s.localAddress) {
        connectOpts.localAddress = s.localAddress;
        connectOpts.localPort = s.localPort ?? undefined;
      }

      return new Promise<{ tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode }>((resolve, reject) => {
        const socket = net.connect(connectOpts, () => {
          s.localAddress = socket.localAddress ?? null;
          s.localPort = socket.localPort ?? null;
          s.remoteAddress = socket.remoteAddress;
          s.remotePort = socket.remotePort;
          s.state = STATE.CONNECTED;
          resolve({ tag: 'ok' });
        });

        s.socket = socket;

        socket.on('error', (err) => {
          s.state = STATE.CLOSED;
          resolve({ tag: 'err', val: mapError(err) });
          // Keep a no-op error handler to prevent unhandled 'error' events
          // (EPIPE, ECONNRESET) from crashing the process after connect.
          socket.on('error', () => {});
        });
      });
    },

    '[method]tcp-socket.listen': (handle: number) => {
      const s = getTcp(handle);
      if (s.state === STATE.LISTENING || s.state === STATE.CONNECTED || s.state === STATE.CONNECTING || s.state === STATE.CLOSED) {
        return { tag: 'err', val: SocketsErrorCode.InvalidState };
      }
      // Per spec: implicit bind if not already bound
      if (s.state === STATE.UNBOUND) {
        const TCP = (process as any).binding('tcp_wrap').TCP;
        const TCPConstants = (process as any).binding('tcp_wrap').constants;
        const tcp = new TCP(TCPConstants.SERVER);
        const bindFn = s.family === 'ipv4' ? 'bind' : 'bind6';
        const host = s.family === 'ipv4' ? '0.0.0.0' : '::';
        const bindErr = tcp[bindFn](host, 0);
        if (bindErr) { tcp.close(); return { tag: 'err', val: SocketsErrorCode.AddressNotBindable }; }
        const out: { address?: string; port?: number } = {};
        tcp.getsockname(out);
        s.nativeHandle = tcp;
        s.localAddress = out.address ?? host;
        s.localPort = out.port ?? 0;
        s.state = STATE.BOUND;
      }

      const state = ctx.state!;
      // Create a stream of tcp-socket resources (stream type 2 = stream<tcp-socket>)
      const sPacked = state.streamNew(2);
      const sRi = Number(sPacked & 0xFFFFFFFFn);
      const sWi = Number(sPacked >> 32n);

      const server = net.createServer({ allowHalfOpen: true });
      s.server = server;

      server.on('connection', (clientSocket: net.Socket) => {
        const clientId = nextTcpId++;
        const clientHandle = new TcpSocketHandle(s.family);
        clientHandle.socket = clientSocket;
        clientHandle.state = STATE.CONNECTED;
        clientHandle.localAddress = clientSocket.localAddress ?? null;
        clientHandle.localPort = clientSocket.localPort ?? null;
        clientHandle.remoteAddress = clientSocket.remoteAddress;
        clientHandle.remotePort = clientSocket.remotePort;
        // Inherit socket options from the listener
        clientHandle.keepAliveEnabled = s.keepAliveEnabled;
        clientHandle.keepAliveIdleTime = s.keepAliveIdleTime;
        clientHandle.keepAliveInterval = s.keepAliveInterval;
        clientHandle.keepAliveCount = s.keepAliveCount;
        clientHandle.hopLimit = s.hopLimit;
        clientHandle.receiveBufferSize = s.receiveBufferSize;
        clientHandle.sendBufferSize = s.sendBufferSize;
        tcpSockets.set(clientId, clientHandle);

        // Write the resource rep to the stream — ResourceWritableBuffer will wrap it
        // in a ResourceHandle with the correct typeIdx when the guest reads.
        state.streamWriteHost(0, sWi, [clientId]);
      });

      server.on('error', (_err: Error) => {
        state.streamDropWritable(0, sWi);
      });

      // Reuse the native handle from bind (already bound to the port)
      const tcp = s.nativeHandle!;
      s.nativeHandle = null; // server takes ownership
      const listenErr = tcp.listen(s.backlogSize);
      if (listenErr) {
        tcp.close();
        return { tag: 'err', val: SocketsErrorCode.Unknown };
      }

      // Attach the handle to the net.Server and set up connection handling
      (server as any)._handle = tcp;
      tcp.onconnection = (err: number, clientHandle: unknown) => {
        if (err) return;
        const clientSocket = new net.Socket({ handle: clientHandle, allowHalfOpen: true } as any);
        (clientSocket as any).readable = (clientSocket as any).writable = true;
        // Attach a default error handler to prevent unhandled 'error' events
        // (EPIPE, ECONNRESET) from crashing the process. Errors are handled
        // at the WASI method level (send/receive).
        clientSocket.on('error', () => {});
        server.emit('connection', clientSocket);
      };
      s.state = STATE.LISTENING;

      // Track the server as pending async so the event loop doesn't
      // falsely detect deadlock while waiting for incoming connections.
      const serverDone = new Promise<void>((resolve) => {
        server.on('close', resolve);
        server.on('error', resolve);
      });
      state.trackHostAsync(serverDone);

      return { tag: 'ok', val: sRi };
    },

    // Async-lowered version: runtime handles stream/future infrastructure.
    // Receives a lifted stream handle, returns result or Promise<result>.
    '[async method]tcp-socket.send': (handle: number, streamEndIdx: number): Promise<{ tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode }> => {
      const s = getTcp(handle);
      const state = ctx.state!;

      if (s.state !== STATE.CONNECTED || s.sendStarted) {
        return Promise.resolve({ tag: 'err', val: SocketsErrorCode.InvalidState });
      }

      s.sendStarted = true;

      const streamEnd = state.liftStreamEnd(0, streamEndIdx) as ReadableStreamEnd;
      s.addStreamRef();

      return (async () => {
        try {
          while (true) {
            const chunk = await hostReadChunk(streamEnd);
            if (!chunk) break;
            if (chunk.length > 0 && s.socket) {
              await new Promise<void>((resolve, reject) => {
                s.socket!.write(chunk, (err?: Error | null) => {
                  if (err) reject(err);
                  else resolve();
                });
              });
            }
          }
          return { tag: 'ok' as const };
        } catch (err) {
          return { tag: 'err' as const, val: mapError(err) };
        } finally {
          streamEnd.shared.dropReader();
          s.sendDone = true;
          if (s.socket) s.socket.end();
          s.removeStreamRef();
        }
      })();
    },

    '[method]tcp-socket.receive': (handle: number) => {
      const s = getTcp(handle);
      const state = ctx.state!;

      if (s.state !== STATE.CONNECTED || s.receiveStarted) {
        // receive may only be called once on a connected socket
        const sPacked = state.streamNew(0);
        const sRi = Number(sPacked & 0xFFFFFFFFn);
        const sWi = Number(sPacked >> 32n);
        state.streamDropWritable(0, sWi);
        const fPacked = state.futureNew(0);
        const fRi = Number(fPacked & 0xFFFFFFFFn);
        const fWi = Number(fPacked >> 32n);
        state.futureWriteHost(0, fWi, [{tag: 'err', val: SocketsErrorCode.InvalidState}]);
        return [sRi, fRi];
      }

      s.receiveStarted = true;

      const sPacked = state.streamNew(0);
      const sRi = Number(sPacked & 0xFFFFFFFFn);
      const sWi = Number(sPacked >> 32n);

      const fPacked = state.futureNew(0);
      const fRi = Number(fPacked & 0xFFFFFFFFn);
      const fWi = Number(fPacked >> 32n);

      s.addStreamRef();

      const socket = s.socket!;
      let done = false;
      let socketEnded = false;
      let flushing = false;
      const pendingChunks: Buffer[] = [];

      const finish = (futurePayload: unknown[]) => {
        if (done) return;
        done = true;
        cleanup();
        state.streamDropWritable(0, sWi);
        state.futureWriteHost(0, fWi, futurePayload);
        s.removeStreamRef();
      };

      // Flush queued chunks into the stream one at a time.
      // writeHost can only hold one pending buffer, so we pass an
      // onConsumed callback that triggers the next flush.
      const flushNext = () => {
        flushing = false;
        if (done) return;
        if (pendingChunks.length === 0) {
          if (socketEnded) {
            // All data flushed, socket ended. If a zero-length reader is
            // pending (cancel-recovery read), wake it with COMPLETED(0)
            // before dropping the writable end. This prevents the reader
            // from receiving DROPPED prematurely — the NEXT non-zero read
            // will see the drop and return DROPPED.
            if (writable.shared.hasPendingZeroLengthReader()) {
              state.streamWriteHost(0, sWi, [], () => finish([{tag: 'ok'}]));
            } else {
              finish([{tag: 'ok'}]);
            }
          } else {
            socket.resume();
          }
          return;
        }
        const chunk = pendingChunks.shift()!;
        flushing = true;
        state.streamWriteHost(0, sWi, Array.from(chunk), flushNext);
      };

      // Detect when the guest drops the readable end of the receive stream.
      const writable = state.getStreamEnd(0, sWi);
      writable.shared.onDropped = () => finish([{tag: 'ok'}]);

      const onData = (data: Buffer) => {
        if (done) return;
        pendingChunks.push(data);
        socket.pause();
        flushNext();
      };

      const onEnd = () => {
        socketEnded = true;
        // If no writeHost is in flight, trigger flushNext to handle
        // end-of-stream. Otherwise the in-flight onConsumed chain
        // will call flushNext which will detect socketEnded.
        if (!flushing) flushNext();
      };
      const onError = (err: Error) => finish([{tag: 'err', val: mapError(err)}]);
      const onClose = () => finish([{tag: 'ok'}]);

      function cleanup() {
        socket.removeListener('data', onData);
        socket.removeListener('end', onEnd);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      }

      socket.on('data', onData);
      socket.on('end', onEnd);
      socket.on('error', onError);
      socket.on('close', onClose);

      return [sRi, fRi];
    },

    '[method]tcp-socket.get-local-address': (handle: number) => {
      const s = getTcp(handle);
      if (s.state === STATE.UNBOUND) return { tag: 'err', val: SocketsErrorCode.InvalidState };

      if (s.server) {
        const addr = s.server.address();
        if (addr && typeof addr === 'object') {
          return nodeAddressToResult(addr.address, addr.port, addr.family);
        }
      }
      if (s.socket && s.socket.localAddress) {
        return nodeAddressToResult(s.socket.localAddress, s.socket.localPort!,
          s.family === 'ipv4' ? 'IPv4' : 'IPv6');
      }
      return nodeAddressToResult(s.localAddress || '0.0.0.0', s.localPort || 0,
        s.family === 'ipv4' ? 'IPv4' : 'IPv6');
    },

    '[method]tcp-socket.get-remote-address': (handle: number) => {
      const s = getTcp(handle);
      if (s.state !== STATE.CONNECTED) return { tag: 'err', val: SocketsErrorCode.InvalidState };
      if (!s.remoteAddress) {
        // Socket is connected but address not yet resolved (connection still establishing)
        const defaultAddr = s.family === 'ipv4' ? '0.0.0.0' : '::';
        return nodeAddressToResult(defaultAddr, 0, s.family === 'ipv4' ? 'IPv4' : 'IPv6');
      }
      return nodeAddressToResult(s.remoteAddress, s.remotePort!,
        s.family === 'ipv4' ? 'IPv4' : 'IPv6');
    },

    '[method]tcp-socket.set-listen-backlog-size': (handle: number, value: bigint) => {
      const s = getTcp(handle);
      if (value === 0n) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
      // Clamp to reasonable range (value may be u64::MAX as -1n signed)
      const uval = BigInt.asUintN(64, value);
      s.backlogSize = uval > 4096n ? 4096 : Number(uval);
      return { tag: 'ok' };
    },

    '[method]tcp-socket.get-is-listening': (handle: number) => {
      const s = getTcp(handle);
      return s.state === STATE.LISTENING;
    },

    '[method]tcp-socket.get-address-family': (handle: number): IpAddressFamily => {
      const s = getTcp(handle);
      return s.family as IpAddressFamily;
    },

    '[method]tcp-socket.get-keep-alive-enabled': (handle: number) => {
      return { tag: 'ok', val: getTcp(handle).keepAliveEnabled };
    },

    '[method]tcp-socket.set-keep-alive-enabled': (handle: number, value: boolean) => {
      const s = getTcp(handle);
      s.keepAliveEnabled = value;
      // Apply via native handle or socket when available
      const h = s.nativeHandle ?? (s.socket as any)?._handle;
      if (h?.setKeepAlive) {
        h.setKeepAlive(value, Math.floor(Number(s.keepAliveIdleTime) / 1_000_000_000));
      }
      return { tag: 'ok' };
    },

    '[method]tcp-socket.get-keep-alive-idle-time': (handle: number) => {
      return { tag: 'ok', val: getTcp(handle).keepAliveIdleTime };
    },

    '[method]tcp-socket.set-keep-alive-idle-time': (handle: number, value: bigint) => {
      if (value === 0n) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
      const s = getTcp(handle);
      s.keepAliveIdleTime = value;
      // Apply via native handle if keepalive is enabled
      if (s.keepAliveEnabled) {
        const h = s.nativeHandle ?? (s.socket as any)?._handle;
        if (h?.setKeepAlive) {
          h.setKeepAlive(true, Math.floor(Number(value) / 1_000_000_000));
        }
      }
      return { tag: 'ok' };
    },

    '[method]tcp-socket.get-keep-alive-interval': (handle: number) => {
      return { tag: 'ok', val: getTcp(handle).keepAliveInterval };
    },

    '[method]tcp-socket.set-keep-alive-interval': (handle: number, value: bigint) => {
      if (value === 0n) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
      getTcp(handle).keepAliveInterval = value;
      return { tag: 'ok' };
    },

    '[method]tcp-socket.get-keep-alive-count': (handle: number) => {
      return { tag: 'ok', val: getTcp(handle).keepAliveCount };
    },

    '[method]tcp-socket.set-keep-alive-count': (handle: number, value: number) => {
      if (value === 0) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
      getTcp(handle).keepAliveCount = value;
      return { tag: 'ok' };
    },

    '[method]tcp-socket.get-hop-limit': (handle: number) => {
      return { tag: 'ok', val: getTcp(handle).hopLimit };
    },

    '[method]tcp-socket.set-hop-limit': (handle: number, value: number) => {
      if (value === 0) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
      getTcp(handle).hopLimit = value;
      return { tag: 'ok' };
    },

    '[method]tcp-socket.get-receive-buffer-size': (handle: number) => {
      return { tag: 'ok', val: getTcp(handle).receiveBufferSize };
    },

    '[method]tcp-socket.set-receive-buffer-size': (handle: number, value: bigint) => {
      if (value === 0n) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
      getTcp(handle).receiveBufferSize = value;
      return { tag: 'ok' };
    },

    '[method]tcp-socket.get-send-buffer-size': (handle: number) => {
      return { tag: 'ok', val: getTcp(handle).sendBufferSize };
    },

    '[method]tcp-socket.set-send-buffer-size': (handle: number, value: bigint) => {
      if (value === 0n) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
      getTcp(handle).sendBufferSize = value;
      return { tag: 'ok' };
    },

    '[resource-drop]tcp-socket': (handle: number) => {
      const s = tcpSockets.get(handle);
      if (s) {
        tcpSockets.delete(handle);
        s.removedFromTable = true;
        if (s.activeStreams <= 0) {
          // No active streams — destroy immediately
          s.destroy();
        }
        // Otherwise: socket stays alive until all streams finish (removeStreamRef)
      }
    },

    // ---- UDP Socket ----

    '[static]udp-socket.create': (addressFamily: string) => {
      const id = nextUdpId++;
      udpSockets.set(id, new UdpSocketHandle(addressFamily));
      return { tag: 'ok', val: id };
    },

    '[method]udp-socket.bind': (handle: number, addrParams: IpSocketAddress) => {
      const s = getUdp(handle);
      if (s.bound) return { tag: 'err', val: SocketsErrorCode.InvalidState };

      // Check address family matches socket family
      const addrFamily = addrParams.tag === 'ipv4' ? 'ipv4' : 'ipv6';
      if (addrFamily !== s.family) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };

      // Reject IPv4-mapped IPv6 addresses (no dual-stack in WASI)
      if (addrParams.tag === 'ipv6') {
        const a = addrParams.val.address;
        if (a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0 && a[4] === 0 && a[5] === 0xffff) {
          return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        }
      }

      const addr = socketAddressToNode(addrParams);

      // Use udp_wrap for synchronous bind to get ephemeral port assignment
      const udp = new UDPWrap();
      const bindErr = addr.family === 6
        ? udp.bind6(addr.host, addr.port, 0)
        : udp.bind(addr.host, addr.port, 0);
      if (bindErr) {
        udp.close();
        if (bindErr === UV_EINVAL) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        if (bindErr === UV_EADDRINUSE) return { tag: 'err', val: SocketsErrorCode.AddressInUse };
        if (bindErr === UV_EACCES) return { tag: 'err', val: SocketsErrorCode.AccessDenied };
        return { tag: 'err', val: SocketsErrorCode.AddressNotBindable };
      }

      const out: { address?: string; port?: number } = {};
      udp.getsockname(out);
      s.nativeHandle = udp;
      s.localAddress = out.address ?? addr.host;
      s.localPort = out.port ?? addr.port;
      s.bound = true;
      return { tag: 'ok' };
    },

    '[method]udp-socket.connect': (handle: number, addrParams: IpSocketAddress) => {
      const s = getUdp(handle);

      // Check address family matches socket family
      const addrFamily = addrParams.tag === 'ipv4' ? 'ipv4' : 'ipv6';
      if (addrFamily !== s.family) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };

      // Reject unspecified address
      if (addrParams.tag === 'ipv4') {
        const a = addrParams.val.address;
        if (a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0) {
          return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        }
      } else {
        const a = addrParams.val.address;
        if (a.every((x: number) => x === 0)) {
          return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        }
        if (a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0 && a[4] === 0 && a[5] === 0xffff) {
          return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        }
      }

      // Reject port 0
      if (addrParams.val.port === 0) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };

      const addr = socketAddressToNode(addrParams);

      // If not yet bound, do an implicit bind first
      if (!s.bound) {
        const udp = new UDPWrap();
        const bindHost = s.family === 'ipv4' ? '0.0.0.0' : '::';
        const bindErr = s.family === 'ipv4'
          ? udp.bind(bindHost, 0, 0)
          : udp.bind6(bindHost, 0, 0);
        if (bindErr) {
          udp.close();
          return { tag: 'err', val: SocketsErrorCode.AddressNotBindable };
        }
        const out: { address?: string; port?: number } = {};
        udp.getsockname(out);
        s.nativeHandle = udp;
        s.localAddress = out.address ?? null;
        s.localPort = out.port ?? 0;
        s.bound = true;
      }

      // Use native handle for synchronous connect (works both before and after ensureSocket)
      const nh = s.getNativeHandle();
      if (!nh) return { tag: 'err', val: SocketsErrorCode.InvalidState };

      // Disconnect first if already connected (native handle requires this)
      if (s.connected) {
        nh.disconnect();
      }

      const connectFn = addr.family === 6 ? 'connect6' : 'connect';
      const err = nh[connectFn](addr.host, addr.port);
      if (err) {
        if (err === UV_EINVAL) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
        return { tag: 'err', val: SocketsErrorCode.Unknown };
      }
      s.connected = true;
      s.remoteAddress = addr.host;
      s.remotePort = addr.port;
      // After connect, the OS resolves 0.0.0.0 to the actual interface address
      const localOut: { address?: string; port?: number } = {};
      nh.getsockname(localOut);
      if (localOut.address) s.localAddress = localOut.address;
      if (localOut.port) s.localPort = localOut.port;
      return { tag: 'ok' };
    },

    '[method]udp-socket.send': (handle: number, data: Buffer, optionalAddr?: IpSocketAddress | null) => {
      const s = getUdp(handle);
      if (!s.bound) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };

      const sock = s.ensureSocket();
      return new Promise<{ tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode }>((resolve) => {
        try {
          const buf = Buffer.from(data);
          if (optionalAddr && !s.connected) {
            // Unconnected socket with explicit address — use native handle
            // directly to avoid dgram's internal lookup which can fail with
            // EINVAL on IPv6 when using native handle transfer.
            const addr = socketAddressToNode(optionalAddr);
            const stateKey = Object.getOwnPropertySymbols(sock)
              .find(sym => sym.toString().includes('state symbol'));
            const state = stateKey ? (sock as any)[stateKey] : null;
            const nativeHandle = state?.handle;
            if (nativeHandle) {
              const sendReq = { oncomplete: (status: number) => {
                resolve(status < 0 ? { tag: 'err' as const, val: SocketsErrorCode.Unknown } : { tag: 'ok' as const });
              }};
              const result = addr.family === 6
                ? nativeHandle.send6(sendReq, [buf], 1, addr.port, addr.host, false)
                : nativeHandle.send(sendReq, [buf], 1, addr.port, addr.host, false);
              if (result < 0) {
                // Negative = libuv error code
                resolve({ tag: 'err', val: SocketsErrorCode.Unknown });
              } else if (result >= 1) {
                // Positive = completed synchronously (bytes sent)
                resolve({ tag: 'ok' });
              }
              // result === 0: async, oncomplete will fire
            } else {
              // Fallback to dgram send
              sock.send(buf, addr.port, addr.host, (err: Error | null) => {
                resolve(err ? { tag: 'err' as const, val: mapError(err) } : { tag: 'ok' as const });
              });
            }
          } else if (s.connected) {
            // Connected socket: ignore explicit address (matches POSIX sendto on connected UDP)
            sock.send(buf, (err: Error | null) => {
              resolve(err ? { tag: 'err' as const, val: mapError(err) } : { tag: 'ok' as const });
            });
          } else {
            // Unconnected socket without address: EDESTADDRREQ
            resolve({ tag: 'err', val: SocketsErrorCode.InvalidArgument });
          }
        } catch (err) {
          resolve({ tag: 'err', val: mapError(err as Error) });
        }
      });
    },

    '[method]udp-socket.receive': (handle: number) => {
      const s = getUdp(handle);
      if (!s.bound) return Promise.resolve({ tag: 'err' as const, val: SocketsErrorCode.InvalidState });

      // Check buffered messages first (arrived before receive() was called)
      if (s.receivedMessages.length > 0) {
        const msg = s.receivedMessages.shift()!;
        const addrResult = nodeAddressToResult(msg.rinfo.address, msg.rinfo.port, msg.rinfo.family);
        return { tag: 'ok' as const, val: [msg.data, (addrResult as { tag: 'ok'; val: IpSocketAddress }).val] as [Uint8Array, IpSocketAddress] };
      }

      const sock = s.ensureSocket();
      return new Promise<{ tag: 'ok'; val: [Uint8Array, IpSocketAddress] } | { tag: 'err'; val: SocketsErrorCode }>((resolve) => {
        const onMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
          sock.removeListener('message', onMessage);
          sock.removeListener('error', onError);
          const addrResult = nodeAddressToResult(rinfo.address, rinfo.port, rinfo.family);
          resolve({
            tag: 'ok',
            val: [new Uint8Array(msg), (addrResult as { tag: 'ok'; val: IpSocketAddress }).val]
          });
        };
        const onError = (err: Error) => {
          sock.removeListener('message', onMessage);
          sock.removeListener('error', onError);
          resolve({ tag: 'err', val: mapError(err) });
        };
        sock.once('message', onMessage);
        sock.once('error', onError);
      });
    },

    '[method]udp-socket.get-local-address': (handle: number) => {
      const s = getUdp(handle);
      if (!s.bound) return { tag: 'err', val: SocketsErrorCode.InvalidState };
      return nodeAddressToResult(
        s.localAddress || '0.0.0.0',
        s.localPort || 0,
        s.family === 'ipv4' ? 'IPv4' : 'IPv6',
      );
    },

    '[method]udp-socket.get-remote-address': (handle: number) => {
      const s = getUdp(handle);
      if (!s.connected) return { tag: 'err', val: SocketsErrorCode.InvalidState };
      // Use native handle getpeername for accurate remote address
      const nh = s.getNativeHandle();
      if (nh) {
        const out: { address?: string; port?: number; family?: string } = {};
        nh.getpeername(out);
        if (out.address) {
          return nodeAddressToResult(out.address, out.port!, out.family === 'IPv6' ? 'IPv6' : 'IPv4');
        }
      }
      return nodeAddressToResult(s.remoteAddress!, s.remotePort!,
        s.family === 'ipv4' ? 'IPv4' : 'IPv6');
    },

    '[method]udp-socket.disconnect': (handle: number) => {
      const s = getUdp(handle);
      if (!s.connected) return { tag: 'err', val: SocketsErrorCode.InvalidState };
      // Use native handle for synchronous disconnect (works both pre- and post-ensureSocket)
      const nh = s.getNativeHandle();
      if (nh) nh.disconnect();
      s.connected = false;
      s.remoteAddress = null;
      s.remotePort = null;
      return { tag: 'ok' };
    },

    '[method]udp-socket.get-address-family': (handle: number): IpAddressFamily => {
      const s = getUdp(handle);
      return s.family as IpAddressFamily;
    },

    '[method]udp-socket.get-unicast-hop-limit': (handle: number) => {
      return { tag: 'ok', val: getUdp(handle).unicastHopLimit };
    },

    '[method]udp-socket.set-unicast-hop-limit': (handle: number, value: number) => {
      if (value === 0) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
      getUdp(handle).unicastHopLimit = value;
      return { tag: 'ok' };
    },

    '[method]udp-socket.get-receive-buffer-size': (handle: number) => {
      return { tag: 'ok', val: getUdp(handle).receiveBufferSize };
    },

    '[method]udp-socket.set-receive-buffer-size': (handle: number, value: bigint) => {
      if (value === 0n) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
      getUdp(handle).receiveBufferSize = value;
      return { tag: 'ok' };
    },

    '[method]udp-socket.get-send-buffer-size': (handle: number) => {
      return { tag: 'ok', val: getUdp(handle).sendBufferSize };
    },

    '[method]udp-socket.set-send-buffer-size': (handle: number, value: bigint) => {
      if (value === 0n) return { tag: 'err', val: SocketsErrorCode.InvalidArgument };
      getUdp(handle).sendBufferSize = value;
      return { tag: 'ok' };
    },

    '[resource-drop]udp-socket': (handle: number) => {
      const s = udpSockets.get(handle);
      if (s) {
        s.destroy();
        udpSockets.delete(handle);
      }
    },

    // ---- Cancellation support ----

    cancelOperation(handle: number, type: 'tcp' | 'udp') {
      let s: TcpSocketHandle | UdpSocketHandle | undefined;
      if (type === 'tcp') {
        s = tcpSockets.get(handle);
      } else {
        s = udpSockets.get(handle);
      }
      if (s?.abortController) {
        s.abortController.abort();
        s.abortController = null;
      }
    },

    destroyAll() {
      for (const [, s] of tcpSockets) s.destroy();
      for (const [, s] of udpSockets) s.destroy();
      tcpSockets.clear();
      udpSockets.clear();
    },
  };
}

// ---- IP Name Lookup ----

function parseIpLiteral(name: string): IpAddress | null {
  // Strip brackets from IPv6 bracket notation like [::]
  let addr = name;
  if (addr.startsWith('[') && addr.endsWith(']')) {
    addr = addr.slice(1, -1);
  }

  if (net.isIPv4(addr)) {
    const parts = addr.split('.').map(Number);
    return { tag: 'ipv4', val: [parts[0]!, parts[1]!, parts[2]!, parts[3]!] };
  }

  if (net.isIPv6(addr)) {
    const groups = parseIPv6Groups(addr);
    return { tag: 'ipv6', val: groups as [number, number, number, number, number, number, number, number] };
  }

  return null;
}

function ipAddressFromString(addr: string): IpAddress {
  if (net.isIPv4(addr)) {
    const parts = addr.split('.').map(Number);
    return { tag: 'ipv4', val: [parts[0]!, parts[1]!, parts[2]!, parts[3]!] };
  }
  const groups = parseIPv6Groups(addr);
  return { tag: 'ipv6', val: groups as [number, number, number, number, number, number, number, number] };
}

export function createNameLookupHost(): WasiSocketsIpNameLookup {
  return {
    'resolve-addresses': async (name: string) => {
      // Reject empty, whitespace-only, URLs, and names with ports
      if (!name || /^\s*$/.test(name) || /[<>&\/]/.test(name)) {
        return { tag: 'err', val: IpNameLookupErrorCode.InvalidArgument };
      }

      // Reject port suffixes like "127.0.0.1:80" or "[::]:80"
      if (/:\d+$/.test(name) && !net.isIPv6(name)) {
        return { tag: 'err', val: IpNameLookupErrorCode.InvalidArgument };
      }

      // Check if it's an IP address literal
      const ip = parseIpLiteral(name);
      if (ip) {
        return { tag: 'ok', val: [ip] };
      }

      // Reject names that look invalid (brackets with ports, etc.)
      if (name.includes('[') || name.includes(']')) {
        return { tag: 'err', val: IpNameLookupErrorCode.InvalidArgument };
      }

      try {
        // Resolve both A (IPv4) and AAAA (IPv6) records
        const [v4Result, v6Result] = await Promise.allSettled([
          dns.resolve4(name),
          dns.resolve6(name),
        ]);
        const addrs: IpAddress[] = [];
        if (v4Result.status === 'fulfilled') {
          for (const addr of v4Result.value) addrs.push(ipAddressFromString(addr));
        }
        if (v6Result.status === 'fulfilled') {
          for (const addr of v6Result.value) addrs.push(ipAddressFromString(addr));
        }
        if (addrs.length === 0) {
          return { tag: 'err', val: IpNameLookupErrorCode.NameUnresolvable };
        }
        return { tag: 'ok', val: addrs };
      } catch (_err) {
        return { tag: 'err', val: IpNameLookupErrorCode.NameUnresolvable };
      }
    },
  };
}
