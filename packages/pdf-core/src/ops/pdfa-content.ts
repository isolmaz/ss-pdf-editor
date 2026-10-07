/**
 * A content-stream reader for the PDF/A checker: operators and their operands, nothing more.
 *
 * Which colour spaces a page paints with cannot be read from its resource dictionary: a
 * space that is declared and never used is not a violation, and `0.5 g` uses DeviceGray with
 * no resource at all. So the checker follows the operators (`ops/pdfa-check.ts`), and this
 * module is the lexer under it. It is deliberately small and engine-free — bytes in,
 * `(operator, operands)` callbacks out — so it can be tested without a PDF.
 *
 * It understands the whole token grammar of ISO 32000-1 §7.2–7.3 that content streams use:
 * names with `#xx` escapes, numbers, literal strings with nesting and escapes, hex strings,
 * arrays, dictionaries, comments, and inline images (`BI … ID <data> EI`), whose binary data
 * is skipped rather than read as operators.
 */

export type Operand =
  | { readonly t: 'name'; readonly v: string }
  | { readonly t: 'num'; readonly v: number }
  | { readonly t: 'str' }
  | { readonly t: 'bool'; readonly v: boolean }
  | { readonly t: 'null' }
  | { readonly t: 'arr'; readonly items: readonly Operand[] }
  | { readonly t: 'dict'; readonly entries: ReadonlyMap<string, Operand> };

const NUL = 0;
const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const MAX_DEPTH = 32;

function isRegular(byte: number): boolean {
  return !WHITESPACE.has(byte) && !DELIMITERS.has(byte);
}

class Reader {
  position = 0;
  constructor(readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.position >= this.bytes.length;
  }

  skipSpace(): void {
    const { bytes } = this;
    while (this.position < bytes.length) {
      const byte = bytes[this.position] as number;
      if (WHITESPACE.has(byte)) this.position += 1;
      else if (byte === 0x25) {
        while (this.position < bytes.length && bytes[this.position] !== 10 && bytes[this.position] !== 13) {
          this.position += 1;
        }
      } else break;
    }
  }

  /** The run of regular characters starting here. */
  word(): string {
    const start = this.position;
    while (this.position < this.bytes.length && isRegular(this.bytes[this.position] as number))
      this.position += 1;
    let text = '';
    for (let index = start; index < this.position; index += 1)
      text += String.fromCharCode(this.bytes[index] as number);
    return text;
  }

  name(): string {
    this.position += 1; // the slash
    const raw = this.word();
    return raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }

  /** A literal string: balanced parentheses, backslash escapes. */
  string(): void {
    this.position += 1;
    let depth = 1;
    const { bytes } = this;
    while (this.position < bytes.length && depth > 0) {
      const byte = bytes[this.position] as number;
      if (byte === 0x5c) this.position += 2;
      else {
        if (byte === 0x28) depth += 1;
        else if (byte === 0x29) depth -= 1;
        this.position += 1;
      }
    }
  }

  hexString(): void {
    this.position += 1;
    while (this.position < this.bytes.length && this.bytes[this.position] !== 0x3e) this.position += 1;
    this.position += 1;
  }

  /**
   * One object, or `null` when the next token is an operator keyword (returned through
   * `keyword`). Depth-limited so a hostile stream cannot recurse without bound.
   */
  object(depth: number): { operand: Operand } | { keyword: string } | null {
    this.skipSpace();
    if (this.done) return null;
    const byte = this.bytes[this.position] as number;
    if (depth > MAX_DEPTH) {
      this.position += 1;
      return { operand: { t: 'null' } };
    }
    if (byte === 0x2f) return { operand: { t: 'name', v: this.name() } };
    if (byte === 0x28) {
      this.string();
      return { operand: { t: 'str' } };
    }
    if (byte === 0x3c) {
      if (this.bytes[this.position + 1] === 0x3c) {
        this.position += 2;
        const entries = new Map<string, Operand>();
        for (;;) {
          this.skipSpace();
          if (this.done) break;
          if (this.bytes[this.position] === 0x3e && this.bytes[this.position + 1] === 0x3e) {
            this.position += 2;
            break;
          }
          if (this.bytes[this.position] !== 0x2f) {
            // Not a key: skip one token so a damaged dictionary cannot stall the reader.
            this.position += 1;
            continue;
          }
          const key = this.name();
          const value = this.object(depth + 1);
          if (value !== null && 'operand' in value) entries.set(key, value.operand);
        }
        return { operand: { t: 'dict', entries } };
      }
      this.hexString();
      return { operand: { t: 'str' } };
    }
    if (byte === 0x5b) {
      this.position += 1;
      const items: Operand[] = [];
      for (;;) {
        this.skipSpace();
        if (this.bytes[this.position] === 0x5d) {
          this.position += 1;
          break;
        }
        const entry = this.object(depth + 1);
        if (entry === null) break;
        if ('operand' in entry) items.push(entry.operand);
      }
      return { operand: { t: 'arr', items } };
    }
    if (byte === 0x5d || byte === 0x3e || byte === 0x29 || byte === 0x7b || byte === 0x7d) {
      // A stray delimiter: step over it.
      this.position += 1;
      return { operand: { t: 'null' } };
    }
    const word = this.word();
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { operand: { t: 'num', v: Number.parseFloat(word) } };
    if (word === 'true') return { operand: { t: 'bool', v: true } };
    if (word === 'false') return { operand: { t: 'bool', v: false } };
    if (word === 'null') return { operand: { t: 'null' } };
    return { keyword: word };
  }

  /** Skip the binary data of an inline image: from after `ID` to the `EI` that ends it. */
  skipInlineData(): void {
    const { bytes } = this;
    // Exactly one whitespace byte follows `ID`.
    if (WHITESPACE.has(bytes[this.position] ?? NUL)) this.position += 1;
    for (let index = this.position; index + 1 < bytes.length; index += 1) {
      if (bytes[index] !== 0x45 || bytes[index + 1] !== 0x49) continue;
      const before = bytes[index - 1];
      const after = bytes[index + 2];
      if (before !== undefined && !WHITESPACE.has(before)) continue;
      if (after !== undefined && !WHITESPACE.has(after)) continue;
      this.position = index + 2;
      return;
    }
    this.position = bytes.length;
  }
}

/**
 * Walk a content stream, calling `visit(operator, operands)` for every operator in order.
 * For `BI` the single operand is the inline image's dictionary (keys as written, so both the
 * abbreviated and the full spellings can occur); its data is skipped.
 */
export function scanContent(
  bytes: Uint8Array,
  visit: (operator: string, operands: readonly Operand[]) => void,
): void {
  const reader = new Reader(bytes);
  let operands: Operand[] = [];
  for (;;) {
    const next = reader.object(0);
    if (next === null) return;
    if ('operand' in next) {
      operands.push(next.operand);
      // An operand list longer than any operator takes is damage; do not grow without bound.
      if (operands.length > 64) operands = operands.slice(-32);
      continue;
    }
    if (next.keyword === 'BI') {
      const entries = new Map<string, Operand>();
      for (;;) {
        reader.skipSpace();
        if (reader.done) break;
        if (reader.bytes[reader.position] !== 0x2f) {
          const word = reader.word();
          if (word === 'ID' || word === '') {
            if (word === '') reader.position += 1;
            else break;
          }
          continue;
        }
        const key = reader.name();
        const value = reader.object(1);
        if (value !== null && 'operand' in value) entries.set(key, value.operand);
      }
      reader.skipInlineData();
      visit('BI', [{ t: 'dict', entries }]);
      operands = [];
      continue;
    }
    visit(next.keyword, operands);
    operands = [];
  }
}

/** The number a `Tr` or similar operand carries, or `null`. */
export function numberOf(operand: Operand | undefined): number | null {
  return operand?.t === 'num' ? operand.v : null;
}

/** The name an operand carries, or `null`. */
export function nameOf(operand: Operand | undefined): string | null {
  return operand?.t === 'name' ? operand.v : null;
}
