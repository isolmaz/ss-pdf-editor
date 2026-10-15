/**
 * A narrow reader of page content streams for one job: the property dictionaries of marked
 * content (`/Tag <<…>> BDC`, `/Tag <<…>> DP`) and the entries in them that carry text.
 *
 * Redaction needs this because MuPDF's `applyRedactions` erases glyphs, images and line art and
 * leaves the marked-content operators alone — and a tagger writes the words it wraps into
 * `/ActualText` or `/Alt` of exactly those dictionaries, where a reader that follows them (a
 * screen reader, a copy that honours `/ActualText`) still finds the erased text.
 *
 * It is not the content tokenizer the accessibility writers share (`readInstructions`): that one
 * does not step over a string inside a `<<…>>` dictionary, so `<</ActualText<FEFF0041>>>` — the
 * form Word writes — makes it give up on the whole stream. This reader parses a dictionary as
 * dictionary: strings (with escapes and nested parentheses), hex strings, names, arrays and nested
 * dictionaries are each consumed whole, and a comment or an inline image's data is skipped.
 *
 * It cuts entries out of the property dictionary by byte range and leaves every other byte of
 * the stream exactly as it was. A stream it cannot finish reading (a string that never closes)
 * is cut where the reading stopped: what follows stays untouched.
 */

/** The deepest dictionary or array nesting followed; a content stream is a handful of levels. */
const MAX_DEPTH = 64;

export interface MarkedContentScan {
  /** The stream with the entries removed — the input itself when there was nothing to remove. */
  readonly bytes: Uint8Array;
  /** How many dictionary entries were removed. */
  readonly removed: number;
}

type Value =
  | { readonly kind: 'name' | 'string' | 'array' | 'word'; readonly start: number; readonly end: number }
  | {
      readonly kind: 'dict';
      readonly start: number;
      readonly end: number;
      readonly entries: readonly { readonly key: string; readonly start: number; readonly end: number }[];
    };

const isSpace = (code: number | undefined): boolean =>
  code === 0 || code === 9 || code === 10 || code === 12 || code === 13 || code === 32;

/** `( ) < > [ ] { } / %`: bytes that end a name or a bare word. */
const isDelimiter = (code: number | undefined): boolean =>
  code === 0x28 ||
  code === 0x29 ||
  code === 0x3c ||
  code === 0x3e ||
  code === 0x5b ||
  code === 0x5d ||
  code === 0x7b ||
  code === 0x7d ||
  code === 0x2f ||
  code === 0x25;

/** A name's text with its `#xx` escapes resolved. */
function decodeName(raw: string): string {
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Remove the top-level entries named in `strip` from every marked-content property dictionary. */
export function scanMarkedContent(bytes: Uint8Array, strip: ReadonlySet<string>): MarkedContentScan {
  const length = bytes.length;
  const cuts: { readonly start: number; readonly end: number }[] = [];
  let at = 0;

  const text = (start: number, end: number): string => {
    let out = '';
    for (let index = start; index < end; index += 1) out += String.fromCharCode(bytes[index] as number);
    return out;
  };

  const skipBlank = (): void => {
    while (at < length) {
      const code = bytes[at];
      if (isSpace(code)) at += 1;
      else if (code === 0x25) {
        while (at < length && bytes[at] !== 10 && bytes[at] !== 13) at += 1;
      } else return;
    }
  };

  /** One complete value, or `null` at the end of the stream. */
  const readValue = (depth: number): Value | null => {
    skipBlank();
    if (at >= length) return null;
    const start = at;
    const code = bytes[at];
    if (depth > MAX_DEPTH) {
      at = length;
      return null;
    }
    if (code === 0x28) {
      // A literal string: backslash escapes the next byte, parentheses nest.
      let open = 1;
      at += 1;
      while (at < length && open > 0) {
        const byte = bytes[at];
        at += 1;
        if (byte === 0x5c) at += 1;
        else if (byte === 0x28) open += 1;
        else if (byte === 0x29) open -= 1;
      }
      at = Math.min(at, length);
      return { kind: 'string', start, end: at };
    }
    if (code === 0x3c && bytes[at + 1] === 0x3c) {
      at += 2;
      const entries: { key: string; start: number; end: number }[] = [];
      for (;;) {
        skipBlank();
        if (at >= length) break;
        if (bytes[at] === 0x3e && bytes[at + 1] === 0x3e) {
          at += 2;
          break;
        }
        const keyStart = at;
        const key = readValue(depth + 1);
        if (key === null) break;
        // A key that is not a name is junk: it is skipped, and the next value is tried as the key.
        if (key.kind !== 'name') continue;
        const value = readValue(depth + 1);
        if (value === null) break;
        entries.push({ key: decodeName(text(key.start + 1, key.end)), start: keyStart, end: value.end });
      }
      return { kind: 'dict', start, end: at, entries };
    }
    if (code === 0x3c) {
      // A hex string.
      at += 1;
      while (at < length && bytes[at] !== 0x3e) at += 1;
      at = Math.min(at + 1, length);
      return { kind: 'string', start, end: at };
    }
    if (code === 0x5b) {
      at += 1;
      for (;;) {
        skipBlank();
        if (at >= length) break;
        if (bytes[at] === 0x5d) {
          at += 1;
          break;
        }
        if (readValue(depth + 1) === null) break;
      }
      return { kind: 'array', start, end: at };
    }
    if (code === 0x2f) {
      at += 1;
      while (at < length && !isSpace(bytes[at]) && !isDelimiter(bytes[at])) at += 1;
      return { kind: 'name', start, end: at };
    }
    if (isDelimiter(code)) {
      // A stray `)`, `>`, `]`, `{` or `}`: consumed on its own, so the reading always advances.
      at += code === 0x3e && bytes[at + 1] === 0x3e ? 2 : 1;
      return { kind: 'word', start, end: at };
    }
    while (at < length && !isSpace(bytes[at]) && !isDelimiter(bytes[at])) at += 1;
    return { kind: 'word', start, end: at };
  };

  /** Past the data of an inline image: the first `EI` that stands alone. */
  const skipInlineImage = (): void => {
    for (let index = at + 1; index + 1 < length; index += 1) {
      if (
        bytes[index] === 0x45 &&
        bytes[index + 1] === 0x49 &&
        isSpace(bytes[index - 1]) &&
        (index + 2 >= length || isSpace(bytes[index + 2]) || isDelimiter(bytes[index + 2]))
      ) {
        at = index + 2;
        return;
      }
    }
    at = length;
  };

  let removed = 0;
  let last: Value | null = null;
  for (let value = readValue(0); value !== null; value = readValue(0)) {
    if (value.kind !== 'word') {
      last = value;
      continue;
    }
    // A bare word is an operator or an operand; the operands of `BDC` and `DP` are a name and a dictionary.
    const operator = text(value.start, value.end);
    if ((operator === 'BDC' || operator === 'DP') && last?.kind === 'dict') {
      for (const entry of last.entries) {
        if (!strip.has(entry.key)) continue;
        cuts.push({ start: entry.start, end: entry.end });
        removed += 1;
      }
    } else if (operator === 'ID') skipInlineImage();
    last = null;
  }

  if (cuts.length === 0) return { bytes, removed: 0 };
  const total = cuts.reduce((sum, cut) => sum + (cut.end - cut.start), 0);
  const out = new Uint8Array(length - total);
  let written = 0;
  let from = 0;
  for (const cut of cuts) {
    out.set(bytes.subarray(from, cut.start), written);
    written += cut.start - from;
    from = cut.end;
  }
  out.set(bytes.subarray(from), written);
  return { bytes: out, removed };
}
