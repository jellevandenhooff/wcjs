// Auto-generated WASI host import types.
// Do not edit manually — regenerate with: npm run gen-host-types

/** Handle to a stream carrying elements of type T. At the ABI level, this is a number (handle index). */
export type Stream<_T> = number;
/** Handle to a future resolving to a value of type T. At the ABI level, this is a number (handle index). */
export type Future<_T> = number;

export const CliErrorCode = {
  Io: 'io',
  IllegalByteSequence: 'illegal-byte-sequence',
  Pipe: 'pipe'
} as const;
export type CliErrorCode = typeof CliErrorCode[keyof typeof CliErrorCode];

export type Instant =
  { seconds: bigint; nanoseconds: number };

export const DescriptorType = {
  Unknown: 'unknown',
  BlockDevice: 'block-device',
  CharacterDevice: 'character-device',
  Directory: 'directory',
  Fifo: 'fifo',
  SymbolicLink: 'symbolic-link',
  RegularFile: 'regular-file',
  Socket: 'socket'
} as const;
export type DescriptorType = typeof DescriptorType[keyof typeof DescriptorType];

export type DescriptorStat =
  { type: DescriptorType; 'link-count': bigint; size: bigint; 'data-access-timestamp': Instant | null; 'data-modification-timestamp': Instant | null; 'status-change-timestamp': Instant | null };

export type NewTimestamp =
  { tag: 'no-change' }
  | { tag: 'now' }
  | { tag: 'timestamp'; val: Instant };

export type DirectoryEntry =
  { type: DescriptorType; name: string };

export const FilesystemErrorCode = {
  Access: 'access',
  Already: 'already',
  BadDescriptor: 'bad-descriptor',
  Busy: 'busy',
  Deadlock: 'deadlock',
  Quota: 'quota',
  Exist: 'exist',
  FileTooLarge: 'file-too-large',
  IllegalByteSequence: 'illegal-byte-sequence',
  InProgress: 'in-progress',
  Interrupted: 'interrupted',
  Invalid: 'invalid',
  Io: 'io',
  IsDirectory: 'is-directory',
  Loop: 'loop',
  TooManyLinks: 'too-many-links',
  MessageSize: 'message-size',
  NameTooLong: 'name-too-long',
  NoDevice: 'no-device',
  NoEntry: 'no-entry',
  NoLock: 'no-lock',
  InsufficientMemory: 'insufficient-memory',
  InsufficientSpace: 'insufficient-space',
  NotDirectory: 'not-directory',
  NotEmpty: 'not-empty',
  NotRecoverable: 'not-recoverable',
  Unsupported: 'unsupported',
  NoTty: 'no-tty',
  NoSuchDevice: 'no-such-device',
  Overflow: 'overflow',
  NotPermitted: 'not-permitted',
  Pipe: 'pipe',
  ReadOnly: 'read-only',
  InvalidSeek: 'invalid-seek',
  TextFileBusy: 'text-file-busy',
  CrossDevice: 'cross-device'
} as const;
export type FilesystemErrorCode = typeof FilesystemErrorCode[keyof typeof FilesystemErrorCode];

export const Advice = {
  Normal: 'normal',
  Sequential: 'sequential',
  Random: 'random',
  WillNeed: 'will-need',
  DontNeed: 'dont-need',
  NoReuse: 'no-reuse'
} as const;
export type Advice = typeof Advice[keyof typeof Advice];

export type MetadataHashValue =
  { lower: bigint; upper: bigint };

export const SocketsErrorCode = {
  Unknown: 'unknown',
  AccessDenied: 'access-denied',
  NotSupported: 'not-supported',
  InvalidArgument: 'invalid-argument',
  OutOfMemory: 'out-of-memory',
  Timeout: 'timeout',
  InvalidState: 'invalid-state',
  AddressNotBindable: 'address-not-bindable',
  AddressInUse: 'address-in-use',
  RemoteUnreachable: 'remote-unreachable',
  ConnectionRefused: 'connection-refused',
  ConnectionReset: 'connection-reset',
  ConnectionAborted: 'connection-aborted',
  DatagramTooLarge: 'datagram-too-large'
} as const;
export type SocketsErrorCode = typeof SocketsErrorCode[keyof typeof SocketsErrorCode];

export const IpAddressFamily = {
  Ipv4: 'ipv4',
  Ipv6: 'ipv6'
} as const;
export type IpAddressFamily = typeof IpAddressFamily[keyof typeof IpAddressFamily];

export type IpAddress =
  { tag: 'ipv4'; val: [number, number, number, number] }
  | { tag: 'ipv6'; val: [number, number, number, number, number, number, number, number] };

export type Ipv4SocketAddress =
  { port: number; address: [number, number, number, number] };

export type Ipv6SocketAddress =
  { port: number; 'flow-info': number; address: [number, number, number, number, number, number, number, number]; 'scope-id': number };

export type IpSocketAddress =
  { tag: 'ipv4'; val: Ipv4SocketAddress }
  | { tag: 'ipv6'; val: Ipv6SocketAddress };

export const IpNameLookupErrorCode = {
  Unknown: 'unknown',
  AccessDenied: 'access-denied',
  InvalidArgument: 'invalid-argument',
  NameUnresolvable: 'name-unresolvable',
  TemporaryResolverFailure: 'temporary-resolver-failure',
  PermanentResolverFailure: 'permanent-resolver-failure'
} as const;
export type IpNameLookupErrorCode = typeof IpNameLookupErrorCode[keyof typeof IpNameLookupErrorCode];

export type Method =
  { tag: 'get' }
  | { tag: 'head' }
  | { tag: 'post' }
  | { tag: 'put' }
  | { tag: 'delete' }
  | { tag: 'connect' }
  | { tag: 'options' }
  | { tag: 'trace' }
  | { tag: 'patch' }
  | { tag: 'other'; val: string };

export type Scheme =
  { tag: 'HTTP' }
  | { tag: 'HTTPS' }
  | { tag: 'other'; val: string };

export type DNSErrorPayload =
  { rcode: string | null; 'info-code': number | null };

export type TLSAlertReceivedPayload =
  { 'alert-id': number | null; 'alert-message': string | null };

export type FieldSizePayload =
  { 'field-name': string | null; 'field-size': number | null };

export type HttpErrorCode =
  { tag: 'DNS-timeout' }
  | { tag: 'DNS-error'; val: DNSErrorPayload }
  | { tag: 'destination-not-found' }
  | { tag: 'destination-unavailable' }
  | { tag: 'destination-IP-prohibited' }
  | { tag: 'destination-IP-unroutable' }
  | { tag: 'connection-refused' }
  | { tag: 'connection-terminated' }
  | { tag: 'connection-timeout' }
  | { tag: 'connection-read-timeout' }
  | { tag: 'connection-write-timeout' }
  | { tag: 'connection-limit-reached' }
  | { tag: 'TLS-protocol-error' }
  | { tag: 'TLS-certificate-error' }
  | { tag: 'TLS-alert-received'; val: TLSAlertReceivedPayload }
  | { tag: 'HTTP-request-denied' }
  | { tag: 'HTTP-request-length-required' }
  | { tag: 'HTTP-request-body-size'; val: bigint | null }
  | { tag: 'HTTP-request-method-invalid' }
  | { tag: 'HTTP-request-URI-invalid' }
  | { tag: 'HTTP-request-URI-too-long' }
  | { tag: 'HTTP-request-header-section-size'; val: number | null }
  | { tag: 'HTTP-request-header-size'; val: FieldSizePayload | null }
  | { tag: 'HTTP-request-trailer-section-size'; val: number | null }
  | { tag: 'HTTP-request-trailer-size'; val: FieldSizePayload }
  | { tag: 'HTTP-response-incomplete' }
  | { tag: 'HTTP-response-header-section-size'; val: number | null }
  | { tag: 'HTTP-response-header-size'; val: FieldSizePayload }
  | { tag: 'HTTP-response-body-size'; val: bigint | null }
  | { tag: 'HTTP-response-trailer-section-size'; val: number | null }
  | { tag: 'HTTP-response-trailer-size'; val: FieldSizePayload }
  | { tag: 'HTTP-response-transfer-coding'; val: string | null }
  | { tag: 'HTTP-response-content-coding'; val: string | null }
  | { tag: 'HTTP-response-timeout' }
  | { tag: 'HTTP-upgrade-failed' }
  | { tag: 'HTTP-protocol-error' }
  | { tag: 'loop-detected' }
  | { tag: 'configuration-error' }
  | { tag: 'internal-error'; val: string | null };

export type HeaderError =
  { tag: 'invalid-syntax' }
  | { tag: 'forbidden' }
  | { tag: 'immutable' };

export type RequestOptionsError =
  { tag: 'not-supported' }
  | { tag: 'immutable' };

export interface WasiCliEnvironment {
  'get-environment'(): [string, string][];
  'get-arguments'(): string[];
  'get-initial-cwd'(): string | null;
}

export interface WasiCliEnvironmentP2 {
  'get-environment'(): [string, string][];
  'get-arguments'(): string[];
  'initial-cwd'(): string | null;
}

export interface WasiCliExit {
  exit(p0: { tag: 'ok' } | { tag: 'err' }): void;
  'exit-with-code'(p0: number): void;
}

export interface WasiCliExitP2 {
  exit(p0: { tag: 'ok' } | { tag: 'err' }): void;
  'exit-with-code'(p0: number): void;
}

export interface WasiCliRun {
  run(): ({ tag: 'ok' } | { tag: 'err' }) | Promise<({ tag: 'ok' } | { tag: 'err' })>;
}

export interface WasiCliRunP2 {
  run(): { tag: 'ok' } | { tag: 'err' };
}

export interface WasiCliStdin {
  'read-via-stream'(): [Stream<number>, Future<{ tag: 'ok' } | { tag: 'err'; val: CliErrorCode }>];
}

export interface WasiCliStdinP2 {
  'get-stdin'(): number;
}

export interface WasiCliStdout {
  '[async]write-via-stream'(p0: Stream<number>): ({ tag: 'ok' } | { tag: 'err'; val: CliErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: CliErrorCode })>;
}

export interface WasiCliStdoutP2 {
  'get-stdout'(): number;
}

export interface WasiCliStderr {
  '[async]write-via-stream'(p0: Stream<number>): ({ tag: 'ok' } | { tag: 'err'; val: CliErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: CliErrorCode })>;
}

export interface WasiCliStderrP2 {
  'get-stderr'(): number;
}

export interface WasiCliTerminalInput {
  '[resource-drop]terminal-input'(rep: number): void;
}

export interface WasiCliTerminalInputP2 {
  '[resource-drop]terminal-input'(rep: number): void;
}

export interface WasiCliTerminalOutput {
  '[resource-drop]terminal-output'(rep: number): void;
}

export interface WasiCliTerminalOutputP2 {
  '[resource-drop]terminal-output'(rep: number): void;
}

export interface WasiCliTerminalStdin {
  'get-terminal-stdin'(): number | null;
}

export interface WasiCliTerminalStdinP2 {
  'get-terminal-stdin'(): number | null;
}

export interface WasiCliTerminalStdout {
  'get-terminal-stdout'(): number | null;
}

export interface WasiCliTerminalStdoutP2 {
  'get-terminal-stdout'(): number | null;
}

export interface WasiCliTerminalStderr {
  'get-terminal-stderr'(): number | null;
}

export interface WasiCliTerminalStderrP2 {
  'get-terminal-stderr'(): number | null;
}

export interface WasiClocksMonotonicClock {
  now(): bigint;
  'get-resolution'(): bigint;
  'wait-until'(p0: bigint): void;
  'wait-for'(p0: bigint): void;
}

export interface WasiClocksMonotonicClockP2 {
  now(): bigint;
  resolution(): bigint;
  'subscribe-instant'(p0: bigint): number;
  'subscribe-duration'(p0: bigint): number;
}

export interface WasiClocksSystemClock {
  now(): Instant;
  'get-resolution'(): bigint;
}

export interface WasiClocksTimezone {
  'iana-id'(): string | null;
  'utc-offset'(p0: Instant): bigint | null;
  'to-debug-string'(): string;
}

export interface WasiClocksTimezoneP2 {
  display(p0: { seconds: bigint; nanoseconds: number }): { 'utc-offset': number; name: string; 'in-daylight-saving-time': boolean };
  'utc-offset'(p0: { seconds: bigint; nanoseconds: number }): number;
}

export interface WasiFilesystemTypes {
  '[method]descriptor.read-via-stream'(p0: number, p1: bigint): [Stream<number>, Future<{ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }>];
  '[method]descriptor.advise'(p0: number, p1: bigint, p2: bigint, p3: Advice): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.sync-data'(p0: number): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.get-flags'(p0: number): ({ tag: 'ok'; val: number } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok'; val: number } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.get-type'(p0: number): ({ tag: 'ok'; val: DescriptorType } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok'; val: DescriptorType } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.set-size'(p0: number, p1: bigint): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.set-times'(p0: number, p1: NewTimestamp, p2: NewTimestamp): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.read-directory'(p0: number): [Stream<DirectoryEntry>, Future<{ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }>];
  '[method]descriptor.sync'(p0: number): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.create-directory-at'(p0: number, p1: string): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.stat'(p0: number): ({ tag: 'ok'; val: DescriptorStat } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok'; val: DescriptorStat } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.stat-at'(p0: number, p1: number, p2: string): ({ tag: 'ok'; val: DescriptorStat } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok'; val: DescriptorStat } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.set-times-at'(p0: number, p1: number, p2: string, p3: NewTimestamp, p4: NewTimestamp): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.link-at'(p0: number, p1: number, p2: string, p3: number, p4: string): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.open-at'(p0: number, p1: number, p2: string, p3: number, p4: number): ({ tag: 'ok'; val: number } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok'; val: number } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.readlink-at'(p0: number, p1: string): ({ tag: 'ok'; val: string } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok'; val: string } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.remove-directory-at'(p0: number, p1: string): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.rename-at'(p0: number, p1: string, p2: number, p3: string): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.symlink-at'(p0: number, p1: string, p2: string): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.unlink-file-at'(p0: number, p1: string): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.is-same-object'(p0: number, p1: number): boolean | Promise<boolean>;
  '[method]descriptor.metadata-hash'(p0: number): ({ tag: 'ok'; val: MetadataHashValue } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok'; val: MetadataHashValue } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[method]descriptor.metadata-hash-at'(p0: number, p1: number, p2: string): ({ tag: 'ok'; val: MetadataHashValue } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok'; val: MetadataHashValue } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[resource-drop]descriptor'(rep: number): void;
  '[async method]descriptor.write-via-stream'(p0: number, p1: Stream<number>, p2: bigint): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
  '[async method]descriptor.append-via-stream'(p0: number, p1: Stream<number>): ({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: FilesystemErrorCode })>;
}

export interface WasiFilesystemTypesP2 {
  'filesystem-error-code'(p0: number): ('access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device') | null;
  '[method]descriptor.read-via-stream'(p0: number, p1: bigint): { tag: 'ok'; val: number } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.write-via-stream'(p0: number, p1: bigint): { tag: 'ok'; val: number } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.append-via-stream'(p0: number): { tag: 'ok'; val: number } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.advise'(p0: number, p1: bigint, p2: bigint, p3: Advice): { tag: 'ok' } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.sync-data'(p0: number): { tag: 'ok' } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.get-flags'(p0: number): { tag: 'ok'; val: number } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.get-type'(p0: number): { tag: 'ok'; val: DescriptorType } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.set-size'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.set-times'(p0: number, p1: { tag: 'no-change' }
  | { tag: 'now' }
  | { tag: 'timestamp'; val: { seconds: bigint; nanoseconds: number } }, p2: { tag: 'no-change' }
  | { tag: 'now' }
  | { tag: 'timestamp'; val: { seconds: bigint; nanoseconds: number } }): { tag: 'ok' } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.read'(p0: number, p1: bigint, p2: bigint): { tag: 'ok'; val: [Uint8Array, boolean] } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.write'(p0: number, p1: Uint8Array, p2: bigint): { tag: 'ok'; val: bigint } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.read-directory'(p0: number): { tag: 'ok'; val: number } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.sync'(p0: number): { tag: 'ok' } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.create-directory-at'(p0: number, p1: string): { tag: 'ok' } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.stat'(p0: number): { tag: 'ok'; val: { type: DescriptorType; 'link-count': bigint; size: bigint; 'data-access-timestamp': { seconds: bigint; nanoseconds: number } | null; 'data-modification-timestamp': { seconds: bigint; nanoseconds: number } | null; 'status-change-timestamp': { seconds: bigint; nanoseconds: number } | null } } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.stat-at'(p0: number, p1: number, p2: string): { tag: 'ok'; val: { type: DescriptorType; 'link-count': bigint; size: bigint; 'data-access-timestamp': { seconds: bigint; nanoseconds: number } | null; 'data-modification-timestamp': { seconds: bigint; nanoseconds: number } | null; 'status-change-timestamp': { seconds: bigint; nanoseconds: number } | null } } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.set-times-at'(p0: number, p1: number, p2: string, p3: { tag: 'no-change' }
  | { tag: 'now' }
  | { tag: 'timestamp'; val: { seconds: bigint; nanoseconds: number } }, p4: { tag: 'no-change' }
  | { tag: 'now' }
  | { tag: 'timestamp'; val: { seconds: bigint; nanoseconds: number } }): { tag: 'ok' } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.link-at'(p0: number, p1: number, p2: string, p3: number, p4: string): { tag: 'ok' } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.open-at'(p0: number, p1: number, p2: string, p3: number, p4: number): { tag: 'ok'; val: number } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.readlink-at'(p0: number, p1: string): { tag: 'ok'; val: string } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.remove-directory-at'(p0: number, p1: string): { tag: 'ok' } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.rename-at'(p0: number, p1: string, p2: number, p3: string): { tag: 'ok' } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.symlink-at'(p0: number, p1: string, p2: string): { tag: 'ok' } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.unlink-file-at'(p0: number, p1: string): { tag: 'ok' } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.is-same-object'(p0: number, p1: number): boolean;
  '[method]descriptor.metadata-hash'(p0: number): { tag: 'ok'; val: MetadataHashValue } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[method]descriptor.metadata-hash-at'(p0: number, p1: number, p2: string): { tag: 'ok'; val: MetadataHashValue } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[resource-drop]descriptor'(rep: number): void;
  '[method]directory-entry-stream.read-directory-entry'(p0: number): { tag: 'ok'; val: DirectoryEntry | null } | { tag: 'err'; val: 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device' };
  '[resource-drop]directory-entry-stream'(rep: number): void;
}

export interface WasiFilesystemPreopens {
  'get-directories'(): [number, string][];
}

export interface WasiFilesystemPreopensP2 {
  'get-directories'(): [number, string][];
}

export interface WasiRandomInsecureSeed {
  'get-insecure-seed'(): [bigint, bigint];
}

export interface WasiRandomInsecureSeedP2 {
  'insecure-seed'(): [bigint, bigint];
}

export interface WasiRandomInsecure {
  'get-insecure-random-bytes'(p0: bigint): Uint8Array;
  'get-insecure-random-u64'(): bigint;
}

export interface WasiRandomInsecureP2 {
  'get-insecure-random-bytes'(p0: bigint): Uint8Array;
  'get-insecure-random-u64'(): bigint;
}

export interface WasiRandomRandom {
  'get-random-bytes'(p0: bigint): Uint8Array;
  'get-random-u64'(): bigint;
}

export interface WasiRandomRandomP2 {
  'get-random-bytes'(p0: bigint): Uint8Array;
  'get-random-u64'(): bigint;
}

export interface WasiSocketsTypes {
  '[static]tcp-socket.create'(p0: IpAddressFamily): { tag: 'ok'; val: number } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.bind'(p0: number, p1: IpSocketAddress): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.connect'(p0: number, p1: IpSocketAddress): ({ tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode })>;
  '[method]tcp-socket.listen'(p0: number): { tag: 'ok'; val: Stream<number> } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.receive'(p0: number): [Stream<number>, Future<{ tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode }>];
  '[method]tcp-socket.get-local-address'(p0: number): { tag: 'ok'; val: IpSocketAddress } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.get-remote-address'(p0: number): { tag: 'ok'; val: IpSocketAddress } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.get-is-listening'(p0: number): boolean;
  '[method]tcp-socket.get-address-family'(p0: number): IpAddressFamily;
  '[method]tcp-socket.set-listen-backlog-size'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.get-keep-alive-enabled'(p0: number): { tag: 'ok'; val: boolean } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.set-keep-alive-enabled'(p0: number, p1: boolean): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.get-keep-alive-idle-time'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.set-keep-alive-idle-time'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.get-keep-alive-interval'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.set-keep-alive-interval'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.get-keep-alive-count'(p0: number): { tag: 'ok'; val: number } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.set-keep-alive-count'(p0: number, p1: number): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.get-hop-limit'(p0: number): { tag: 'ok'; val: number } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.set-hop-limit'(p0: number, p1: number): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.get-receive-buffer-size'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.set-receive-buffer-size'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.get-send-buffer-size'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: SocketsErrorCode };
  '[method]tcp-socket.set-send-buffer-size'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[resource-drop]tcp-socket'(rep: number): void;
  '[static]udp-socket.create'(p0: IpAddressFamily): { tag: 'ok'; val: number } | { tag: 'err'; val: SocketsErrorCode };
  '[method]udp-socket.bind'(p0: number, p1: IpSocketAddress): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]udp-socket.connect'(p0: number, p1: IpSocketAddress): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]udp-socket.disconnect'(p0: number): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]udp-socket.send'(p0: number, p1: Uint8Array, p2: IpSocketAddress | null): ({ tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode })>;
  '[method]udp-socket.receive'(p0: number): ({ tag: 'ok'; val: [Uint8Array, IpSocketAddress] } | { tag: 'err'; val: SocketsErrorCode }) | Promise<({ tag: 'ok'; val: [Uint8Array, IpSocketAddress] } | { tag: 'err'; val: SocketsErrorCode })>;
  '[method]udp-socket.get-local-address'(p0: number): { tag: 'ok'; val: IpSocketAddress } | { tag: 'err'; val: SocketsErrorCode };
  '[method]udp-socket.get-remote-address'(p0: number): { tag: 'ok'; val: IpSocketAddress } | { tag: 'err'; val: SocketsErrorCode };
  '[method]udp-socket.get-address-family'(p0: number): IpAddressFamily;
  '[method]udp-socket.get-unicast-hop-limit'(p0: number): { tag: 'ok'; val: number } | { tag: 'err'; val: SocketsErrorCode };
  '[method]udp-socket.set-unicast-hop-limit'(p0: number, p1: number): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]udp-socket.get-receive-buffer-size'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: SocketsErrorCode };
  '[method]udp-socket.set-receive-buffer-size'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[method]udp-socket.get-send-buffer-size'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: SocketsErrorCode };
  '[method]udp-socket.set-send-buffer-size'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode };
  '[resource-drop]udp-socket'(rep: number): void;
  '[async method]tcp-socket.send'(p0: number, p1: Stream<number>): ({ tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode }) | Promise<({ tag: 'ok' } | { tag: 'err'; val: SocketsErrorCode })>;
}

export interface WasiSocketsIpNameLookup {
  'resolve-addresses'(p0: string): ({ tag: 'ok'; val: IpAddress[] } | { tag: 'err'; val: IpNameLookupErrorCode }) | Promise<({ tag: 'ok'; val: IpAddress[] } | { tag: 'err'; val: IpNameLookupErrorCode })>;
}

export interface WasiSocketsIpNameLookupP2 {
  'resolve-addresses'(p0: number, p1: string): { tag: 'ok'; val: number } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]resolve-address-stream.resolve-next-address'(p0: number): { tag: 'ok'; val: IpAddress | null } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]resolve-address-stream.subscribe'(p0: number): number;
  '[resource-drop]resolve-address-stream'(rep: number): void;
}

export interface WasiHttpTypes {
  '[constructor]fields'(): number;
  '[static]fields.from-list'(p0: [string, Uint8Array][]): { tag: 'ok'; val: number } | { tag: 'err'; val: HeaderError };
  '[method]fields.get'(p0: number, p1: string): Uint8Array[];
  '[method]fields.has'(p0: number, p1: string): boolean;
  '[method]fields.set'(p0: number, p1: string, p2: Uint8Array[]): { tag: 'ok' } | { tag: 'err'; val: HeaderError };
  '[method]fields.delete'(p0: number, p1: string): { tag: 'ok' } | { tag: 'err'; val: HeaderError };
  '[method]fields.get-and-delete'(p0: number, p1: string): { tag: 'ok'; val: Uint8Array[] } | { tag: 'err'; val: HeaderError };
  '[method]fields.append'(p0: number, p1: string, p2: Uint8Array): { tag: 'ok' } | { tag: 'err'; val: HeaderError };
  '[method]fields.copy-all'(p0: number): [string, Uint8Array][];
  '[method]fields.clone'(p0: number): number;
  '[resource-drop]fields'(rep: number): void;
  '[static]request.new'(p0: number, p1: Stream<number> | null, p2: Future<{ tag: 'ok'; val: number | null } | { tag: 'err'; val: HttpErrorCode }>, p3: number | null): [number, Future<{ tag: 'ok' } | { tag: 'err'; val: HttpErrorCode }>];
  '[method]request.get-method'(p0: number): Method;
  '[method]request.set-method'(p0: number, p1: Method): { tag: 'ok' } | { tag: 'err' };
  '[method]request.get-path-with-query'(p0: number): string | null;
  '[method]request.set-path-with-query'(p0: number, p1: string | null): { tag: 'ok' } | { tag: 'err' };
  '[method]request.get-scheme'(p0: number): Scheme | null;
  '[method]request.set-scheme'(p0: number, p1: Scheme | null): { tag: 'ok' } | { tag: 'err' };
  '[method]request.get-authority'(p0: number): string | null;
  '[method]request.set-authority'(p0: number, p1: string | null): { tag: 'ok' } | { tag: 'err' };
  '[method]request.get-options'(p0: number): number | null;
  '[method]request.get-headers'(p0: number): number;
  '[static]request.consume-body'(p0: number, p1: Future<{ tag: 'ok' } | { tag: 'err'; val: HttpErrorCode }>): [Stream<number>, Future<{ tag: 'ok'; val: number | null } | { tag: 'err'; val: HttpErrorCode }>];
  '[resource-drop]request'(rep: number): void;
  '[constructor]request-options'(): number;
  '[method]request-options.get-connect-timeout'(p0: number): bigint | null;
  '[method]request-options.set-connect-timeout'(p0: number, p1: bigint | null): { tag: 'ok' } | { tag: 'err'; val: RequestOptionsError };
  '[method]request-options.get-first-byte-timeout'(p0: number): bigint | null;
  '[method]request-options.set-first-byte-timeout'(p0: number, p1: bigint | null): { tag: 'ok' } | { tag: 'err'; val: RequestOptionsError };
  '[method]request-options.get-between-bytes-timeout'(p0: number): bigint | null;
  '[method]request-options.set-between-bytes-timeout'(p0: number, p1: bigint | null): { tag: 'ok' } | { tag: 'err'; val: RequestOptionsError };
  '[method]request-options.clone'(p0: number): number;
  '[resource-drop]request-options'(rep: number): void;
  '[static]response.new'(p0: number, p1: Stream<number> | null, p2: Future<{ tag: 'ok'; val: number | null } | { tag: 'err'; val: HttpErrorCode }>): [number, Future<{ tag: 'ok' } | { tag: 'err'; val: HttpErrorCode }>];
  '[method]response.get-status-code'(p0: number): number;
  '[method]response.set-status-code'(p0: number, p1: number): { tag: 'ok' } | { tag: 'err' };
  '[method]response.get-headers'(p0: number): number;
  '[static]response.consume-body'(p0: number, p1: Future<{ tag: 'ok' } | { tag: 'err'; val: HttpErrorCode }>): [Stream<number>, Future<{ tag: 'ok'; val: number | null } | { tag: 'err'; val: HttpErrorCode }>];
  '[resource-drop]response'(rep: number): void;
}

export interface WasiHttpHandler {
  handle(p0: number): ({ tag: 'ok'; val: number } | { tag: 'err'; val: HttpErrorCode }) | Promise<({ tag: 'ok'; val: number } | { tag: 'err'; val: HttpErrorCode })>;
}

export interface WasiHttpClient {
  send(p0: number): ({ tag: 'ok'; val: number } | { tag: 'err'; val: HttpErrorCode }) | Promise<({ tag: 'ok'; val: number } | { tag: 'err'; val: HttpErrorCode })>;
}

export interface WasiClocksWallClock {
  now(): { seconds: bigint; nanoseconds: number };
  resolution(): { seconds: bigint; nanoseconds: number };
}

export interface WasiIoError {
  '[method]error.to-debug-string'(p0: number): string;
  '[resource-drop]error'(rep: number): void;
}

export interface WasiIoPoll {
  poll(p0: number[]): number[];
  '[method]pollable.ready'(p0: number): boolean;
  '[method]pollable.block'(p0: number): void;
  '[resource-drop]pollable'(rep: number): void;
}

export interface WasiIoStreams {
  '[method]input-stream.read'(p0: number, p1: bigint): { tag: 'ok'; val: Uint8Array } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[method]input-stream.blocking-read'(p0: number, p1: bigint): { tag: 'ok'; val: Uint8Array } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[method]input-stream.skip'(p0: number, p1: bigint): { tag: 'ok'; val: bigint } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[method]input-stream.blocking-skip'(p0: number, p1: bigint): { tag: 'ok'; val: bigint } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[method]input-stream.subscribe'(p0: number): number;
  '[resource-drop]input-stream'(rep: number): void;
  '[method]output-stream.check-write'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[method]output-stream.write'(p0: number, p1: Uint8Array): { tag: 'ok' } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[method]output-stream.blocking-write-and-flush'(p0: number, p1: Uint8Array): { tag: 'ok' } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[method]output-stream.flush'(p0: number): { tag: 'ok' } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[method]output-stream.blocking-flush'(p0: number): { tag: 'ok' } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[method]output-stream.subscribe'(p0: number): number;
  '[method]output-stream.write-zeroes'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[method]output-stream.blocking-write-zeroes-and-flush'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[method]output-stream.splice'(p0: number, p1: number, p2: bigint): { tag: 'ok'; val: bigint } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[method]output-stream.blocking-splice'(p0: number, p1: number, p2: bigint): { tag: 'ok'; val: bigint } | { tag: 'err'; val: { tag: 'last-operation-failed'; val: number }
  | { tag: 'closed' } };
  '[resource-drop]output-stream'(rep: number): void;
}

export interface WasiSocketsNetwork {
  'network-error-code'(p0: number): ('unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure') | null;
  '[resource-drop]network'(rep: number): void;
}

export interface WasiSocketsInstanceNetwork {
  'instance-network'(): number;
}

export interface WasiSocketsTcp {
  '[method]tcp-socket.start-bind'(p0: number, p1: number, p2: IpSocketAddress): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.finish-bind'(p0: number): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.start-connect'(p0: number, p1: number, p2: IpSocketAddress): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.finish-connect'(p0: number): { tag: 'ok'; val: [number, number] } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.start-listen'(p0: number): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.finish-listen'(p0: number): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.accept'(p0: number): { tag: 'ok'; val: [number, number, number] } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.local-address'(p0: number): { tag: 'ok'; val: IpSocketAddress } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.remote-address'(p0: number): { tag: 'ok'; val: IpSocketAddress } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.is-listening'(p0: number): boolean;
  '[method]tcp-socket.address-family'(p0: number): IpAddressFamily;
  '[method]tcp-socket.set-listen-backlog-size'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.keep-alive-enabled'(p0: number): { tag: 'ok'; val: boolean } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.set-keep-alive-enabled'(p0: number, p1: boolean): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.keep-alive-idle-time'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.set-keep-alive-idle-time'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.keep-alive-interval'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.set-keep-alive-interval'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.keep-alive-count'(p0: number): { tag: 'ok'; val: number } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.set-keep-alive-count'(p0: number, p1: number): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.hop-limit'(p0: number): { tag: 'ok'; val: number } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.set-hop-limit'(p0: number, p1: number): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.receive-buffer-size'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.set-receive-buffer-size'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.send-buffer-size'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.set-send-buffer-size'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]tcp-socket.subscribe'(p0: number): number;
  '[method]tcp-socket.shutdown'(p0: number, p1: 'receive' | 'send' | 'both'): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[resource-drop]tcp-socket'(rep: number): void;
}

export interface WasiSocketsTcpCreateSocket {
  'create-tcp-socket'(p0: IpAddressFamily): { tag: 'ok'; val: number } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
}

export interface WasiSocketsUdp {
  '[method]udp-socket.start-bind'(p0: number, p1: number, p2: IpSocketAddress): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]udp-socket.finish-bind'(p0: number): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]udp-socket.stream'(p0: number, p1: IpSocketAddress | null): { tag: 'ok'; val: [number, number] } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]udp-socket.local-address'(p0: number): { tag: 'ok'; val: IpSocketAddress } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]udp-socket.remote-address'(p0: number): { tag: 'ok'; val: IpSocketAddress } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]udp-socket.address-family'(p0: number): IpAddressFamily;
  '[method]udp-socket.unicast-hop-limit'(p0: number): { tag: 'ok'; val: number } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]udp-socket.set-unicast-hop-limit'(p0: number, p1: number): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]udp-socket.receive-buffer-size'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]udp-socket.set-receive-buffer-size'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]udp-socket.send-buffer-size'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]udp-socket.set-send-buffer-size'(p0: number, p1: bigint): { tag: 'ok' } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]udp-socket.subscribe'(p0: number): number;
  '[resource-drop]udp-socket'(rep: number): void;
  '[method]incoming-datagram-stream.receive'(p0: number, p1: bigint): { tag: 'ok'; val: { data: Uint8Array; 'remote-address': IpSocketAddress }[] } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]incoming-datagram-stream.subscribe'(p0: number): number;
  '[resource-drop]incoming-datagram-stream'(rep: number): void;
  '[method]outgoing-datagram-stream.check-send'(p0: number): { tag: 'ok'; val: bigint } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]outgoing-datagram-stream.send'(p0: number, p1: ({ data: Uint8Array; 'remote-address': IpSocketAddress | null })[]): { tag: 'ok'; val: bigint } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
  '[method]outgoing-datagram-stream.subscribe'(p0: number): number;
  '[resource-drop]outgoing-datagram-stream'(rep: number): void;
}

export interface WasiSocketsUdpCreateSocket {
  'create-udp-socket'(p0: IpAddressFamily): { tag: 'ok'; val: number } | { tag: 'err'; val: 'unknown' | 'access-denied' | 'not-supported' | 'invalid-argument' | 'out-of-memory' | 'timeout' | 'concurrency-conflict' | 'not-in-progress' | 'would-block' | 'invalid-state' | 'new-socket-limit' | 'address-not-bindable' | 'address-in-use' | 'remote-unreachable' | 'connection-refused' | 'connection-reset' | 'connection-aborted' | 'datagram-too-large' | 'name-unresolvable' | 'temporary-resolver-failure' | 'permanent-resolver-failure' };
}

type P3Version = '0.3.0-rc-2026-02-09';
type P2Version = '0.2.0' | '0.2.1' | '0.2.2' | '0.2.3' | '0.2.4' | '0.2.5' | '0.2.6';

export type WasiHostInterfaces =
  { [K in `wasi:cli/environment@${P3Version}`]: WasiCliEnvironment }
  &   { [K in `wasi:cli/environment@${P2Version}`]: WasiCliEnvironmentP2 }
  &   { [K in `wasi:cli/exit@${P3Version}`]: WasiCliExit }
  &   { [K in `wasi:cli/exit@${P2Version}`]: WasiCliExitP2 }
  &   { [K in `wasi:cli/run@${P3Version}`]: WasiCliRun }
  &   { [K in `wasi:cli/run@${P2Version}`]: WasiCliRunP2 }
  &   { [K in `wasi:cli/stdin@${P3Version}`]: WasiCliStdin }
  &   { [K in `wasi:cli/stdin@${P2Version}`]: WasiCliStdinP2 }
  &   { [K in `wasi:cli/stdout@${P3Version}`]: WasiCliStdout }
  &   { [K in `wasi:cli/stdout@${P2Version}`]: WasiCliStdoutP2 }
  &   { [K in `wasi:cli/stderr@${P3Version}`]: WasiCliStderr }
  &   { [K in `wasi:cli/stderr@${P2Version}`]: WasiCliStderrP2 }
  &   { [K in `wasi:cli/terminal-input@${P3Version}`]: WasiCliTerminalInput }
  &   { [K in `wasi:cli/terminal-input@${P2Version}`]: WasiCliTerminalInputP2 }
  &   { [K in `wasi:cli/terminal-output@${P3Version}`]: WasiCliTerminalOutput }
  &   { [K in `wasi:cli/terminal-output@${P2Version}`]: WasiCliTerminalOutputP2 }
  &   { [K in `wasi:cli/terminal-stdin@${P3Version}`]: WasiCliTerminalStdin }
  &   { [K in `wasi:cli/terminal-stdin@${P2Version}`]: WasiCliTerminalStdinP2 }
  &   { [K in `wasi:cli/terminal-stdout@${P3Version}`]: WasiCliTerminalStdout }
  &   { [K in `wasi:cli/terminal-stdout@${P2Version}`]: WasiCliTerminalStdoutP2 }
  &   { [K in `wasi:cli/terminal-stderr@${P3Version}`]: WasiCliTerminalStderr }
  &   { [K in `wasi:cli/terminal-stderr@${P2Version}`]: WasiCliTerminalStderrP2 }
  &   { [K in `wasi:clocks/monotonic-clock@${P3Version}`]: WasiClocksMonotonicClock }
  &   { [K in `wasi:clocks/monotonic-clock@${P2Version}`]: WasiClocksMonotonicClockP2 }
  &   { [K in `wasi:clocks/system-clock@${P3Version}`]: WasiClocksSystemClock }
  &   { [K in `wasi:clocks/timezone@${P3Version}`]: WasiClocksTimezone }
  &   { [K in `wasi:clocks/timezone@${P2Version}`]: WasiClocksTimezoneP2 }
  &   { [K in `wasi:filesystem/types@${P3Version}`]: WasiFilesystemTypes }
  &   { [K in `wasi:filesystem/types@${P2Version}`]: WasiFilesystemTypesP2 }
  &   { [K in `wasi:filesystem/preopens@${P3Version}`]: WasiFilesystemPreopens }
  &   { [K in `wasi:filesystem/preopens@${P2Version}`]: WasiFilesystemPreopensP2 }
  &   { [K in `wasi:random/insecure-seed@${P3Version}`]: WasiRandomInsecureSeed }
  &   { [K in `wasi:random/insecure-seed@${P2Version}`]: WasiRandomInsecureSeedP2 }
  &   { [K in `wasi:random/insecure@${P3Version}`]: WasiRandomInsecure }
  &   { [K in `wasi:random/insecure@${P2Version}`]: WasiRandomInsecureP2 }
  &   { [K in `wasi:random/random@${P3Version}`]: WasiRandomRandom }
  &   { [K in `wasi:random/random@${P2Version}`]: WasiRandomRandomP2 }
  &   { [K in `wasi:sockets/types@${P3Version}`]: WasiSocketsTypes }
  &   { [K in `wasi:sockets/ip-name-lookup@${P3Version}`]: WasiSocketsIpNameLookup }
  &   { [K in `wasi:sockets/ip-name-lookup@${P2Version}`]: WasiSocketsIpNameLookupP2 }
  &   { [K in `wasi:http/types@${P3Version}`]: WasiHttpTypes }
  &   { [K in `wasi:http/handler@${P3Version}`]: WasiHttpHandler }
  &   { [K in `wasi:http/client@${P3Version}`]: WasiHttpClient }
  &   { [K in `wasi:clocks/wall-clock@${P2Version}`]: WasiClocksWallClock }
  &   { [K in `wasi:io/error@${P2Version}`]: WasiIoError }
  &   { [K in `wasi:io/poll@${P2Version}`]: WasiIoPoll }
  &   { [K in `wasi:io/streams@${P2Version}`]: WasiIoStreams }
  &   { [K in `wasi:sockets/network@${P2Version}`]: WasiSocketsNetwork }
  &   { [K in `wasi:sockets/instance-network@${P2Version}`]: WasiSocketsInstanceNetwork }
  &   { [K in `wasi:sockets/tcp@${P2Version}`]: WasiSocketsTcp }
  &   { [K in `wasi:sockets/tcp-create-socket@${P2Version}`]: WasiSocketsTcpCreateSocket }
  &   { [K in `wasi:sockets/udp@${P2Version}`]: WasiSocketsUdp }
  &   { [K in `wasi:sockets/udp-create-socket@${P2Version}`]: WasiSocketsUdpCreateSocket };
