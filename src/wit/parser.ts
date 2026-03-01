/**
 * Minimal WIT text parser for extracting WASI interface type information.
 *
 * Parses `.wit` files to produce WitPackage structures with interfaces,
 * type definitions, and function signatures. Used by gen-host-types to
 * generate TypeScript type declarations from WIT source files directly,
 * instead of going through compiled component binaries.
 */

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface WitPackage {
  namespace: string;      // 'wasi'
  name: string;           // 'cli'
  version: string;        // '0.3.0-rc-2026-02-09'
  interfaces: WitInterface[];
}

export interface WitInterface {
  name: string;           // 'stdout'
  typeDefs: Map<string, WitTypeDef>;
  functions: WitFunc[];
  uses: WitUse[];
}

export interface WitUse {
  /** Interface path, e.g. 'types' or 'wasi:clocks/system-clock@0.3.0-rc-2026-02-09' */
  from: string;
  /** Mapping from local name → remote name */
  names: Map<string, string>;
}

export type WitTypeDef =
  | { tag: 'alias'; type: WitTypeRef }
  | { tag: 'record'; fields: { name: string; type: WitTypeRef }[] }
  | { tag: 'variant'; cases: { name: string; type: WitTypeRef | null }[] }
  | { tag: 'enum'; cases: string[] }
  | { tag: 'flags'; flags: string[] }
  | { tag: 'resource'; methods: WitFunc[] };

export interface WitFunc {
  name: string;
  kind: 'freestanding' | 'method' | 'static' | 'constructor';
  resourceName?: string;
  isAsync: boolean;
  params: { name: string; type: WitTypeRef }[];
  result: WitTypeRef | null;
}

export type WitTypeRef =
  | string                                        // primitive or named ref
  | { tag: 'list'; elem: WitTypeRef }
  | { tag: 'option'; inner: WitTypeRef }
  | { tag: 'result'; ok: WitTypeRef | null; err: WitTypeRef | null }
  | { tag: 'tuple'; elems: WitTypeRef[] }
  | { tag: 'stream'; elem: WitTypeRef | null }
  | { tag: 'future'; elem: WitTypeRef | null }
  | { tag: 'borrow'; resource: string }
  | { tag: 'own'; resource: string };

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind =
  | 'ident' | 'number' | 'string'
  | '{' | '}' | '<' | '>' | '(' | ')' | ',' | ';' | ':' | '.' | '=' | '@' | '*' | '/' | '->' | '-'
  | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

class Tokenizer {
  private pos = 0;
  private buffer: Token[] = [];

  constructor(private src: string) {}

  peek(): Token {
    if (this.buffer.length === 0) this.buffer.push(this.readToken());
    return this.buffer[0]!;
  }

  next(): Token {
    if (this.buffer.length > 0) return this.buffer.shift()!;
    return this.readToken();
  }

  /** Push a token back to be returned by the next next()/peek() call. */
  pushBack(t: Token): void {
    this.buffer.unshift(t);
  }

  expect(kind: TokenKind): Token {
    const t = this.next();
    if (t.kind !== kind)
      throw new Error(`Expected '${kind}', got '${t.kind}' (value: '${t.value}') at position ${this.pos}`);
    return t;
  }

  private readToken(): Token {
    this.skipWhitespaceAndComments();
    if (this.pos >= this.src.length) return { kind: 'eof', value: '' };

    const ch = this.src[this.pos]!;

    // Two-char tokens
    if (ch === '-' && this.src[this.pos + 1] === '>') {
      this.pos += 2;
      return { kind: '->', value: '->' };
    }

    // Single-char punctuation (includes '-' for version strings)
    const punct = '{}<>(),;:.=@*/-';
    if (punct.includes(ch)) {
      this.pos++;
      return { kind: ch as TokenKind, value: ch };
    }

    // String literal
    if (ch === '"') return this.readString();

    // Number
    if (ch >= '0' && ch <= '9') return this.readNumber();

    // %-escaped identifier
    if (ch === '%') {
      this.pos++;
      return this.readIdent();
    }

    // Identifier (a-z, A-Z, _)
    if (this.isIdentStart(ch)) return this.readIdent();

    throw new Error(`Unexpected character '${ch}' at position ${this.pos}`);
  }

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos++;
        continue;
      }
      if (ch === '/' && this.src[this.pos + 1] === '/') {
        // Line comment (including /// doc comments)
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
        continue;
      }
      if (ch === '/' && this.src[this.pos + 1] === '*') {
        // Block comment
        this.pos += 2;
        let depth = 1;
        while (this.pos < this.src.length && depth > 0) {
          if (this.src[this.pos] === '/' && this.src[this.pos + 1] === '*') {
            depth++;
            this.pos += 2;
          } else if (this.src[this.pos] === '*' && this.src[this.pos + 1] === '/') {
            depth--;
            this.pos += 2;
          } else {
            this.pos++;
          }
        }
        continue;
      }
      break;
    }
  }

  private isIdentStart(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
  }

  private isIdentContinue(ch: string): boolean {
    return this.isIdentStart(ch) || (ch >= '0' && ch <= '9') || ch === '-';
  }

  private readIdent(): Token {
    const start = this.pos;
    while (this.pos < this.src.length && this.isIdentContinue(this.src[this.pos]!)) this.pos++;
    return { kind: 'ident', value: this.src.slice(start, this.pos) };
  }

  private readNumber(): Token {
    const start = this.pos;
    while (this.pos < this.src.length && this.src[this.pos]! >= '0' && this.src[this.pos]! <= '9') this.pos++;
    return { kind: 'number', value: this.src.slice(start, this.pos) };
  }

  private readString(): Token {
    this.pos++; // skip opening quote
    const start = this.pos;
    while (this.pos < this.src.length && this.src[this.pos] !== '"') {
      if (this.src[this.pos] === '\\') this.pos++; // skip escape
      this.pos++;
    }
    const value = this.src.slice(start, this.pos);
    this.pos++; // skip closing quote
    return { kind: 'string', value };
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseWitSource(source: string): WitPackage {
  const tok = new Tokenizer(source);
  return parseFile(tok);
}

function parseFile(tok: Tokenizer): WitPackage {
  tok.expect('ident'); // 'package'
  const pkgName = parsePackageName(tok);
  tok.expect(';');

  const interfaces: WitInterface[] = [];

  while (tok.peek().kind !== 'eof') {
    const t = tok.peek();
    if (t.kind === '@') {
      skipAnnotation(tok);
      continue;
    }
    if (t.kind === 'ident') {
      if (t.value === 'interface') {
        interfaces.push(parseInterface(tok));
      } else if (t.value === 'world') {
        skipWorld(tok);
      } else {
        throw new Error(`Unexpected top-level keyword: ${t.value}`);
      }
    } else {
      throw new Error(`Unexpected token at top level: ${t.kind}`);
    }
  }

  return { ...pkgName, interfaces };
}

function parsePackageName(tok: Tokenizer): { namespace: string; name: string; version: string } {
  // wasi:cli@0.3.0-rc-2026-02-09
  const namespace = tok.expect('ident').value;
  tok.expect(':');
  const name = tok.expect('ident').value;
  tok.expect('@');
  const version = parseVersionString(tok);
  return { namespace, name, version };
}

/** Parse a version string like 0.3.0-rc-2026-02-09 (sequence of numbers, dots, and hyphenated segments). */
function parseVersionString(tok: Tokenizer): string {
  let version = '';
  // Version starts with a number
  version += tok.expect('number').value;
  // Then alternating dots and number/ident segments.
  // Only consume '.' if followed by a number or ident (not '{', etc.)
  while (tok.peek().kind === '.') {
    const dot = tok.next();
    const next = tok.peek();
    if (next.kind === 'number' || next.kind === 'ident') {
      version += '.';
      version += tok.next().value;
    } else {
      // The dot was not part of the version — push it back
      tok.pushBack(dot);
      break;
    }
  }
  // Handle hyphenated suffix: -rc-2026-02-09
  while (tok.peek().kind === '-') {
    tok.next();
    version += '-';
    const next = tok.next(); // number or ident
    version += next.value;
  }
  return version;
}

function parseInterface(tok: Tokenizer): WitInterface {
  tok.expect('ident'); // 'interface'
  const name = tok.expect('ident').value;
  tok.expect('{');

  const iface: WitInterface = { name, typeDefs: new Map(), functions: [], uses: [] };

  while (tok.peek().kind !== '}') {
    if (tok.peek().kind === '@') {
      skipAnnotation(tok);
      continue;
    }
    const kw = tok.peek();
    if (kw.kind !== 'ident') throw new Error(`Unexpected token in interface: ${kw.kind} ${kw.value}`);

    switch (kw.value) {
      case 'use':
        iface.uses.push(parseUse(tok));
        break;
      case 'type':
        parseTypeAlias(tok, iface);
        break;
      case 'record':
        parseRecord(tok, iface);
        break;
      case 'variant':
        parseVariant(tok, iface);
        break;
      case 'enum':
        parseEnum(tok, iface);
        break;
      case 'flags':
        parseFlags(tok, iface);
        break;
      case 'resource':
        parseResource(tok, iface);
        break;
      default:
        // Must be a function definition: name ':' ['async'] 'func' ...
        parseFunction(tok, iface);
        break;
    }
  }
  tok.expect('}');
  return iface;
}

function parseUse(tok: Tokenizer): WitUse {
  tok.expect('ident'); // 'use'

  // Parse use path: either 'local-iface' or 'wasi:pkg/iface@version'
  let from = '';
  // Read the path up to '.'
  from += tok.expect('ident').value;
  // Check for ':' (qualified path like wasi:pkg/iface@version)
  if (tok.peek().kind === ':') {
    tok.next();
    from += ':';
    from += tok.expect('ident').value;
    // Check for '/' (interface within package)
    if (tok.peek().kind === '/') {
      tok.next();
      from += '/';
      from += tok.expect('ident').value;
    }
    // Check for '@version'
    if (tok.peek().kind === '@') {
      tok.next();
      from += '@';
      from += parseVersionString(tok);
    }
  }

  tok.expect('.');
  tok.expect('{');

  const names = new Map<string, string>();
  while (tok.peek().kind !== '}') {
    const remoteName = tok.expect('ident').value;
    let localName = remoteName;
    // Check for 'as' rename
    if (tok.peek().kind === 'ident' && tok.peek().value === 'as') {
      tok.next(); // skip 'as'
      localName = tok.expect('ident').value;
    }
    names.set(localName, remoteName);
    if (tok.peek().kind === ',') tok.next();
  }
  tok.expect('}');
  tok.expect(';');

  return { from, names };
}

function parseTypeAlias(tok: Tokenizer, iface: WitInterface): void {
  tok.expect('ident'); // 'type'
  const name = tok.expect('ident').value;
  tok.expect('=');
  const type = parseTypeRef(tok);
  tok.expect(';');
  iface.typeDefs.set(name, { tag: 'alias', type });
}

function parseRecord(tok: Tokenizer, iface: WitInterface): void {
  tok.expect('ident'); // 'record'
  const name = tok.expect('ident').value;
  tok.expect('{');
  const fields: { name: string; type: WitTypeRef }[] = [];
  while (tok.peek().kind !== '}') {
    if (tok.peek().kind === '@') { skipAnnotation(tok); continue; }
    let fieldName = tok.next().value;
    // Handle %-escaped field names (e.g. %type)
    if (fieldName === '%') fieldName = tok.expect('ident').value;
    tok.expect(':');
    const type = parseTypeRef(tok);
    fields.push({ name: fieldName, type });
    if (tok.peek().kind === ',') tok.next();
  }
  tok.expect('}');
  iface.typeDefs.set(name, { tag: 'record', fields });
}

function parseVariant(tok: Tokenizer, iface: WitInterface): void {
  tok.expect('ident'); // 'variant'
  const name = tok.expect('ident').value;
  tok.expect('{');
  const cases: { name: string; type: WitTypeRef | null }[] = [];
  while (tok.peek().kind !== '}') {
    if (tok.peek().kind === '@') { skipAnnotation(tok); continue; }
    const caseName = tok.expect('ident').value;
    let type: WitTypeRef | null = null;
    if (tok.peek().kind === '(') {
      tok.next();
      type = parseTypeRef(tok);
      tok.expect(')');
    }
    cases.push({ name: caseName, type });
    if (tok.peek().kind === ',') tok.next();
  }
  tok.expect('}');
  iface.typeDefs.set(name, { tag: 'variant', cases });
}

function parseEnum(tok: Tokenizer, iface: WitInterface): void {
  tok.expect('ident'); // 'enum'
  const name = tok.expect('ident').value;
  tok.expect('{');
  const cases: string[] = [];
  while (tok.peek().kind !== '}') {
    if (tok.peek().kind === '@') { skipAnnotation(tok); continue; }
    cases.push(tok.expect('ident').value);
    if (tok.peek().kind === ',') tok.next();
  }
  tok.expect('}');
  iface.typeDefs.set(name, { tag: 'enum', cases });
}

function parseFlags(tok: Tokenizer, iface: WitInterface): void {
  tok.expect('ident'); // 'flags'
  const name = tok.expect('ident').value;
  tok.expect('{');
  const flags: string[] = [];
  while (tok.peek().kind !== '}') {
    if (tok.peek().kind === '@') { skipAnnotation(tok); continue; }
    flags.push(tok.expect('ident').value);
    if (tok.peek().kind === ',') tok.next();
  }
  tok.expect('}');
  iface.typeDefs.set(name, { tag: 'flags', flags });
}

function parseResource(tok: Tokenizer, iface: WitInterface): void {
  tok.expect('ident'); // 'resource'
  const name = tok.expect('ident').value;

  // Resources can be just a declaration: `resource foo;`
  if (tok.peek().kind === ';') {
    tok.next();
    iface.typeDefs.set(name, { tag: 'resource', methods: [] });
    return;
  }

  tok.expect('{');
  const methods: WitFunc[] = [];

  while (tok.peek().kind !== '}') {
    if (tok.peek().kind === '@') { skipAnnotation(tok); continue; }

    const funcName = tok.expect('ident').value;

    // constructor() has no colon or 'func' keyword
    if (funcName === 'constructor' && tok.peek().kind === '(') {
      const { params, result } = parseFuncSig(tok);
      tok.expect(';');
      methods.push({ name: funcName, kind: 'constructor', resourceName: name, isAsync: false, params, result });
      continue;
    }

    tok.expect(':');

    let isAsync = false;
    let kind: WitFunc['kind'];

    if (tok.peek().kind === 'ident' && tok.peek().value === 'async') {
      isAsync = true;
      tok.next();
    }

    if (tok.peek().kind === 'ident' && tok.peek().value === 'static') {
      tok.next();
      kind = 'static';
    } else if (funcName === 'constructor') {
      kind = 'constructor';
    } else {
      kind = 'method';
    }

    tok.expect('ident'); // 'func'
    const { params, result } = parseFuncSig(tok);
    tok.expect(';');

    methods.push({ name: funcName, kind, resourceName: name, isAsync, params, result });
  }
  tok.expect('}');
  iface.typeDefs.set(name, { tag: 'resource', methods });
}

function parseFunction(tok: Tokenizer, iface: WitInterface): void {
  const name = tok.expect('ident').value;
  tok.expect(':');

  let isAsync = false;
  if (tok.peek().kind === 'ident' && tok.peek().value === 'async') {
    isAsync = true;
    tok.next();
  }

  tok.expect('ident'); // 'func'
  const { params, result } = parseFuncSig(tok);
  tok.expect(';');

  iface.functions.push({ name, kind: 'freestanding', isAsync, params, result });
}

function parseFuncSig(tok: Tokenizer): { params: { name: string; type: WitTypeRef }[]; result: WitTypeRef | null } {
  tok.expect('(');
  const params: { name: string; type: WitTypeRef }[] = [];
  while (tok.peek().kind !== ')') {
    let paramName = tok.next().value;
    if (paramName === '%') paramName = tok.expect('ident').value;
    tok.expect(':');
    const type = parseTypeRef(tok);
    params.push({ name: paramName, type });
    if (tok.peek().kind === ',') tok.next();
  }
  tok.expect(')');

  let result: WitTypeRef | null = null;
  if (tok.peek().kind === '->') {
    tok.next();
    result = parseTypeRef(tok);
  }

  return { params, result };
}

function parseTypeRef(tok: Tokenizer): WitTypeRef {
  const t = tok.peek();

  if (t.kind === 'ident') {
    const name = t.value;
    switch (name) {
      case 'list': {
        tok.next();
        tok.expect('<');
        const elem = parseTypeRef(tok);
        tok.expect('>');
        return { tag: 'list', elem };
      }
      case 'option': {
        tok.next();
        tok.expect('<');
        const inner = parseTypeRef(tok);
        tok.expect('>');
        return { tag: 'option', inner };
      }
      case 'result': {
        tok.next();
        // result can be bare (no type args), result<ok>, or result<ok, err>
        if (tok.peek().kind !== '<') {
          // Bare 'result' = result<_, _>
          return { tag: 'result', ok: null, err: null };
        }
        tok.expect('<');
        let ok: WitTypeRef | null = null;
        let err: WitTypeRef | null = null;
        // Check for underscore (void arm)
        if (tok.peek().kind === 'ident' && tok.peek().value === '_') {
          tok.next();
        } else {
          ok = parseTypeRef(tok);
        }
        if (tok.peek().kind === ',') {
          tok.next();
          if (tok.peek().kind === 'ident' && tok.peek().value === '_') {
            tok.next();
          } else {
            err = parseTypeRef(tok);
          }
        }
        tok.expect('>');
        return { tag: 'result', ok, err };
      }
      case 'tuple': {
        tok.next();
        tok.expect('<');
        const elems: WitTypeRef[] = [];
        while (tok.peek().kind !== '>') {
          elems.push(parseTypeRef(tok));
          if (tok.peek().kind === ',') tok.next();
        }
        tok.expect('>');
        return { tag: 'tuple', elems };
      }
      case 'stream': {
        tok.next();
        if (tok.peek().kind !== '<') return { tag: 'stream', elem: null };
        tok.expect('<');
        const elem = parseTypeRef(tok);
        tok.expect('>');
        return { tag: 'stream', elem };
      }
      case 'future': {
        tok.next();
        if (tok.peek().kind !== '<') return { tag: 'future', elem: null };
        tok.expect('<');
        const elem = parseTypeRef(tok);
        tok.expect('>');
        return { tag: 'future', elem };
      }
      case 'borrow': {
        tok.next();
        tok.expect('<');
        const resource = tok.expect('ident').value;
        tok.expect('>');
        return { tag: 'borrow', resource };
      }
      case 'own': {
        tok.next();
        tok.expect('<');
        const resource = tok.expect('ident').value;
        tok.expect('>');
        return { tag: 'own', resource };
      }
      default: {
        // Named type reference or primitive
        tok.next();
        return name;
      }
    }
  }

  throw new Error(`Expected type reference, got ${t.kind} '${t.value}'`);
}

function skipAnnotation(tok: Tokenizer): void {
  tok.expect('@');
  tok.expect('ident'); // annotation name (since, unstable, etc.)
  if (tok.peek().kind === '(') {
    tok.next();
    let depth = 1;
    while (depth > 0) {
      const t = tok.next();
      if (t.kind === '(') depth++;
      else if (t.kind === ')') depth--;
      else if (t.kind === 'eof') break;
    }
  }
}

function skipWorld(tok: Tokenizer): void {
  tok.expect('ident'); // 'world'
  tok.expect('ident'); // world name
  tok.expect('{');
  let depth = 1;
  while (depth > 0) {
    const t = tok.next();
    if (t.kind === '{') depth++;
    else if (t.kind === '}') depth--;
    else if (t.kind === 'eof') break;
  }
}

// ---------------------------------------------------------------------------
// Directory parser
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Parse all .wit files in a directory, returning one WitPackage per file. */
export function parseWitDirectory(dir: string): WitPackage[] {
  const packages: WitPackage[] = [];
  const files = readdirSync(dir).filter(f => f.endsWith('.wit')).sort();
  for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf-8');
    packages.push(parseWitSource(source));
  }
  return packages;
}
