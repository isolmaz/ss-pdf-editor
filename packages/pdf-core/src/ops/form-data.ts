/**
 * Form data interchange: FDF and JSON.
 *
 * FDF is the format Acrobat has always used for "export form data" / "import form
 * data", and it is a PDF dialect: a header line, one indirect object holding
 * `/FDF << /Fields [ … ] >>`, a trailer and `%%EOF`. What it deliberately does not
 * need is an xref table — PDF 32000-2 makes it optional for a file that is read
 * sequentially, and every FDF consumer in practice reads it that way, which is why
 * this writer emits a minimal file instead of building an object graph.
 *
 * The parser is a real tokenizer rather than a regex sweep, because FDF string
 * escaping is where naive implementations lose data: a value containing `(` or `)`
 * is escaped with backslashes and non-ASCII is written as octal `\ddd` (or as
 * UTF-16BE with a `\376\377` BOM), and both forms appear in the wild. A string is also
 * written as hex (`<FEFF00C7>`, ISO 32000 §7.3.4.3), which is how Acrobat writes the
 * `/ID` of every file it produces.
 *
 * On top of the tokens, the fields are read as the **dictionaries** they are: `/T` and
 * `/V` in whatever order a producer wrote them (pdftk writes `/V` first), and a field
 * under `/Kids` takes its parent's name (`parent.child`, as the form's own field tree
 * does).
 *
 * The JSON form is our own and deliberately boring: `{ "fields": [ { "name",
 * "value" } ] }`, with a bare `{ "name": "value" }` map accepted on import because
 * that is what hand-written files look like.
 */

import { ToolError } from 'pdf-shared';

export interface FormDataRecord {
  readonly name: string;
  readonly value: string | readonly string[] | boolean;
  /**
   * The PDF **name** a button's value is, in FDF: a checkbox's own on-state (`On`, `1`,
   * `Evet` — whatever its appearance dictionary calls it) or the on-state of the radio widget
   * that is selected, which is not the option's text (`/Opt [(1)(2)]` with states `/0 /1`).
   * The writer puts it in `/V /<name>`, a checkbox without one as `/Yes`; the reader sets it
   * on every `/V` that is a name other than `/Off` and `/Yes`, so that a name is not taken
   * for text that happens to spell the same. JSON never carries it.
   */
  readonly stateName?: string;
}

const FDF_HEADER = '%FDF-1.2';

// ---------------------------------------------------------------------------
// FDF
// ---------------------------------------------------------------------------

/**
 * PDF string escaping. ASCII text is written as it is, with `\`, `(`, `)` and the
 * control characters escaped. A string with **any** character outside ASCII is written
 * whole as UTF-16BE behind the `\376\377` BOM, every byte an octal escape: a PDF string
 * has one encoding from its first byte to its last, and the BOM is what names it.
 * (Writing only the non-ASCII characters as UTF-16 units inside an otherwise
 * single-byte string reads `gö` back as `g\0ö` — in every reader, this one included.)
 */
export function escapeFdfString(value: string): string {
  if (/[^\x20-\x7e\t\n\r]/.test(value)) {
    const bytes = ['\\376', '\\377'];
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      bytes.push(octalByte(unit >> 8), octalByte(unit & 0xff));
    }
    return bytes.join('');
  }
  let out = '';
  for (const char of value) {
    switch (char) {
      case '\\':
        out += '\\\\';
        break;
      case '(':
        out += '\\(';
        break;
      case ')':
        out += '\\)';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        out += char;
    }
  }
  return out;
}

/** One byte as a PDF octal escape (`\376`). */
function octalByte(byte: number): string {
  return `\\${byte.toString(8).padStart(3, '0')}`;
}

/** UTF-16 surrogate pair for a code point above the BMP. */
function surrogatePair(code: number): readonly number[] {
  const offset = code - 0x10000;
  return [0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff)];
}

/**
 * A PDF name written so that any reader gets the same characters back: bytes outside
 * the printable ASCII range and the delimiters (and `#` itself) become `#xx` of their
 * UTF-8 bytes (ISO 32000 §7.3.5).
 */
function escapeFdfName(name: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(name)) {
    const char = String.fromCharCode(byte);
    out +=
      byte > 0x20 && byte < 0x7f && !'()<>[]{}/%#'.includes(char)
        ? char
        : `#${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/**
 * A minimal FDF 1.2 file.
 *
 * A button is written as the name its own appearance dictionary uses: a checkbox that is
 * on is `/V /<on-state>` (`/On`, `/1`, `/Evet` … — a reader that reads `/Yes` only ticks a
 * box whose on-state is `Yes`), a radio group is `/V /<selected widget's on-state>`, and
 * both are `/Off` when off. A checkbox record without a `stateName` is `/Yes`, the name
 * nearly every producer uses. A multi-select is an array of strings.
 */
export function serializeFdf(records: readonly FormDataRecord[]): Uint8Array {
  const fields = records.map((record) => {
    // `Array.isArray` does not narrow a `readonly T[]` union member, so the value
    // is branched on its own declared shape instead of on the array helper.
    const value: string | readonly string[] | boolean = record.value;
    const title = `/T (${escapeFdfString(record.name)})`;
    if (typeof value === 'boolean') {
      return `<< ${title} /V /${value ? escapeFdfName(record.stateName ?? 'Yes') : 'Off'} >>`;
    }
    if (typeof value !== 'string') {
      const items = value.map((item) => `(${escapeFdfString(item)})`).join(' ');
      return `<< ${title} /V [ ${items} ] >>`;
    }
    if (record.stateName !== undefined) return `<< ${title} /V /${escapeFdfName(record.stateName)} >>`;
    return `<< ${title} /V (${escapeFdfString(value)}) >>`;
  });

  const body = [
    FDF_HEADER,
    '1 0 obj',
    '<< /FDF << /Fields [',
    ...fields,
    '] >> >>',
    'endobj',
    'trailer',
    '<< /Root 1 0 R >>',
    '%%EOF',
    '',
  ].join('\n');
  return new TextEncoder().encode(body);
}

export interface FdfToken {
  readonly kind: 'string' | 'name' | 'punct' | 'array-open' | 'array-close' | 'dict-open' | 'dict-close';
  readonly text: string;
  /**
   * Present (and `true`) on a **bare word** — a number, `true`, `R`, `obj` — which
   * is a `name` token too, but not a `/Name`. A dictionary key is the second kind only.
   */
  readonly keyword?: true;
}

export interface TokenizeOptions {
  /**
   * `source` is the bytes of a file, one character per byte, so a character of a
   * literal string is a byte of a PDFDocEncoding string (ISO 32000 Annex D) — `\232` and a
   * raw 0x9A are both `ı`. The default is text that was already decoded (an annotation
   * dictionary carried inside a string): its characters up to U+00FF stand for themselves.
   */
  readonly bytes?: boolean;
}

/** An escape a literal string keeps: `\ddd`, or a backslash before `\ ( ) n r t b f`. */
const STRING_ESCAPE = /\\(?:[0-7]{1,3}|[\\()nrtbf])/y;
/** What ends a name or a bare word: white space and the PDF delimiters that start something else. */
const WORD_END = /[\s/<>[\]()%]/;

/**
 * The FDF tokenizer, exported for the **annotation** reader: an Acrobat comment file
 * carries a whole annotation as a PDF object inside a string, and reading that object
 * needs the same scanner — a second one would be a second set of escaping bugs.
 *
 * Every step consumes at least one character, so no input — a lone `<`, `>` or `)` —
 * can keep the scan in place. A delimiter that starts nothing (a `>` that closes no
 * hex string, a `)` that closes no literal) is a `punct` token; a hex string
 * (`<FEFF00C7>`) is a `string` token like a literal one.
 */
export function tokenizePdfSource(source: string, options: TokenizeOptions = {}): readonly FdfToken[] {
  const bytes = options.bytes === true;
  const tokens: FdfToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '(') {
      let depth = 1;
      index += 1;
      const raw: string[] = [];
      while (index < source.length && depth > 0) {
        const current = source[index] as string;
        if (current === '\\') {
          STRING_ESCAPE.lastIndex = index;
          const sequence = STRING_ESCAPE.exec(source);
          if (sequence !== null) {
            raw.push(sequence[0]);
            index += sequence[0].length;
            continue;
          }
          index += 1;
          continue;
        }
        if (current === '(') depth += 1;
        if (current === ')') {
          depth -= 1;
          index += 1;
          if (depth === 0) break;
          raw.push(')');
          continue;
        }
        raw.push(current);
        index += 1;
      }
      if (depth !== 0) {
        throw new ToolError('corrupt-document', {
          engine: 'model',
          engineMessage: 'FDF string literal is not terminated',
        });
      }
      tokens.push({ kind: 'string', text: decodeFdfString(raw.join(''), bytes) });
      continue;
    }
    if (char === '/') {
      let end = index + 1;
      while (end < source.length && !WORD_END.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', text: decodeNameEscapes(source.slice(index + 1, end), bytes) });
      index = end;
      continue;
    }
    if (char === '<') {
      if (source[index + 1] === '<') {
        tokens.push({ kind: 'dict-open', text: '<<' });
        index += 2;
        continue;
      }
      const close = source.indexOf('>', index + 1);
      if (close === -1) {
        throw new ToolError('corrupt-document', {
          engine: 'model',
          engineMessage: 'FDF hex string is not terminated',
        });
      }
      tokens.push({ kind: 'string', text: decodeHexString(source.slice(index + 1, close)) });
      index = close + 1;
      continue;
    }
    if (char === '>') {
      if (source[index + 1] === '>') {
        tokens.push({ kind: 'dict-close', text: '>>' });
        index += 2;
      } else {
        tokens.push({ kind: 'punct', text: '>' });
        index += 1;
      }
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'punct', text: ')' });
      index += 1;
      continue;
    }
    if (char === '[') {
      tokens.push({ kind: 'array-open', text: '[' });
      index += 1;
      continue;
    }
    if (char === ']') {
      tokens.push({ kind: 'array-close', text: ']' });
      index += 1;
      continue;
    }
    if (char === '%') {
      // A comment runs to the end of the line; `\r` ends it as well, for a file that has no `\n`.
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
      continue;
    }
    // Everything that starts a token has been handled above, so this character begins a
    // bare word and is part of it: the scan moves on by at least one.
    let end = index + 1;
    while (end < source.length && !WORD_END.test(source[end] as string)) end += 1;
    const word = source.slice(index, end);
    tokens.push({ kind: 'name', text: word, keyword: true });
    index = end;
    if (word === 'stream') {
      // The body of a stream (an appearance stream an Acrobat comment file carries) is binary
      // data: scanned as tokens it would end inside a `(` or `<` that is only a byte. Only a
      // bare word reaches here, so a string that says "stream" is never mistaken for one.
      const close = source.indexOf('endstream', index);
      index = close === -1 ? source.length : close;
    }
  }
  return tokens;
}

/**
 * PDFDocEncoding where it is not Latin-1 (ISO 32000 Annex D.2): U+0018–U+001F and
 * U+0080–U+00A0. `ı` is 0x9A and `€` is 0xA0 — both are in Turkish forms.
 */
const PDFDOC_LOW = [0x2d8, 0x2c7, 0x2c6, 0x2d9, 0x2dd, 0x2db, 0x2da, 0x2dc] as const;
const PDFDOC_HIGH = [
  0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x192, 0x2044, 0x2039, 0x203a, 0x2212, 0x2030, 0x201e,
  0x201c, 0x201d, 0x2018, 0x2019, 0x201a, 0x2122, 0xfb01, 0xfb02, 0x141, 0x152, 0x160, 0x178, 0x17d, 0x131,
  0x142, 0x153, 0x161, 0x17e, 0x9f, 0x20ac,
] as const;

/** The character PDFDocEncoding gives a byte; a code point above 0xFF (already text) stays itself. */
function pdfDocCharacter(byte: number): number {
  if (byte >= 0x18 && byte <= 0x1f) return PDFDOC_LOW[byte - 0x18] as number;
  if (byte >= 0x80 && byte <= 0xa0) return PDFDOC_HIGH[byte - 0x80] as number;
  return byte;
}

/**
 * The text of a string's code units: bytes (and, above 0xFF, code points that were already
 * text). A `FE FF` prefix is the UTF-16BE BOM and switches to two-byte units; anything
 * else is PDFDocEncoding when `pdfDoc` and Latin-1 (as Windows-1252, what the decoder of that
 * name is) when not.
 */
function textOfUnits(units: readonly number[], pdfDoc: boolean): string {
  if (units[0] === 0xfe && units[1] === 0xff) {
    const bytes: number[] = [];
    for (const unit of units) {
      if (unit <= 0xff) bytes.push(unit);
      else {
        const halves = unit > 0xffff ? surrogatePair(unit) : [unit];
        for (const half of halves) bytes.push((half >> 8) & 0xff, half & 0xff);
      }
    }
    let out = '';
    for (let position = 2; position + 1 < bytes.length; position += 2) {
      out += String.fromCharCode((bytes[position] as number) * 256 + (bytes[position + 1] as number));
    }
    return out;
  }
  if (pdfDoc) {
    return units.map((unit) => String.fromCodePoint(pdfDocCharacter(unit))).join('');
  }
  const latin1 = new TextDecoder('latin1');
  let out = '';
  let run: number[] = [];
  const flush = (): void => {
    out += latin1.decode(new Uint8Array(run));
    run = [];
  };
  for (const unit of units) {
    if (unit <= 0xff) run.push(unit);
    else {
      flush();
      out += String.fromCodePoint(unit);
    }
  }
  flush();
  return out;
}

/**
 * A hex string's digits (ISO 32000 §7.3.4.3): white space between them is ignored, so is
 * anything that is not a digit, and a last digit without a partner is followed by a 0
 * (`<4>` is `@`). The bytes are PDFDocEncoding or UTF-16BE like a literal string's.
 */
function decodeHexString(body: string): string {
  const digits = body.replace(/[^0-9a-fA-F]/g, '');
  const units: number[] = [];
  for (let position = 0; position < digits.length; position += 2) {
    units.push(Number.parseInt(digits.slice(position, position + 2).padEnd(2, '0'), 16));
  }
  return textOfUnits(units, true);
}

/**
 * A name's `#xx` escapes (ISO 32000 §7.3.5), which is how `/Not#20Sure` holds a space. The bytes
 * are UTF-8 where they are valid UTF-8 and Latin-1 where not; a name with nothing to decode is
 * returned as it is.
 */
function decodeNameEscapes(raw: string, bytes: boolean): string {
  if (!raw.includes('#') && !(bytes && /[\u0080-\uffff]/.test(raw))) return raw;
  const octets: number[] = [];
  let index = 0;
  while (index < raw.length) {
    const hex = raw.slice(index + 1, index + 3);
    if (raw[index] === '#' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      octets.push(Number.parseInt(hex, 16));
      index += 3;
      continue;
    }
    // `index` is inside the name, so there is a code point to read.
    const code = raw.codePointAt(index) as number;
    if (code <= 0xff) octets.push(code);
    else octets.push(...new TextEncoder().encode(String.fromCodePoint(code)));
    index += code > 0xffff ? 2 : 1;
  }
  const array = new Uint8Array(octets);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(array);
  } catch {
    return String.fromCharCode(...array);
  }
}

/**
 * An FDF string body (escapes intact) to text.
 *
 * Escaped text is assembled as **bytes**, not as characters: an octal escape is a
 * raw byte, and a value that mixes escaped and unescaped characters has to be
 * rebuilt in one pass before it can be decoded — which is exactly the pass a regex
 * over the source cannot do. A `\376\377` prefix is a UTF-16BE BOM and switches the
 * assembly to two-byte code units; anything else is PDFDocEncoding for a file's bytes
 * (`bytes`) and Latin-1 for text that was already decoded. A character that is not a byte at all
 * (the source was text, or Latin-1 bytes read as Windows-1252, which has `€` where Latin-1 has a
 * control character) is already text: it stays itself, and only in a UTF-16 string is it widened to
 * the two-byte form the BOM announces.
 */
function decodeFdfString(raw: string, bytes: boolean): string {
  /** Bytes (escapes and characters up to U+00FF) and, above that, code points. */
  const units: number[] = [];
  let index = 0;
  while (index < raw.length) {
    if (raw[index] === '\\') {
      const octal = /^\\([0-7]{1,3})/.exec(raw.slice(index, index + 4));
      if (octal !== null) {
        units.push(Number.parseInt(octal[1] as string, 8));
        index += octal[0].length;
        continue;
      }
      // The tokenizer keeps only the escapes it understands, so a backslash is followed by one of them.
      units.push(escapeCharacter(raw[index + 1] as string));
      index += 2;
      continue;
    }
    // `index` is inside the string, so there is a code point to read.
    const code = raw.codePointAt(index) as number;
    units.push(code);
    index += code > 0xffff ? 2 : 1;
  }
  return textOfUnits(units, bytes);
}

/** The character an FDF escape stands for (`\n`, `\(`, …). */
function escapeCharacter(escaped: string): number {
  switch (escaped) {
    case 'n':
      return 0x0a;
    case 'r':
      return 0x0d;
    case 't':
      return 0x09;
    case 'b':
      return 0x08;
    case 'f':
      return 0x0c;
    default:
      return escaped.codePointAt(0) as number;
  }
}

// ---------------------------------------------------------------------------
// FDF objects
// ---------------------------------------------------------------------------

/**
 * A PDF object as an FDF file spells it. A dictionary is a `Map`, so a key such as `__proto__`
 * or `constructor` is an entry like any other and never reaches an object's prototype. The
 * annotation reader (`annotation-data.ts`) reads comment files through these.
 */
export type FdfObject =
  | { readonly type: 'string'; readonly text: string }
  | { readonly type: 'name'; readonly text: string }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'array'; readonly items: readonly FdfObject[] }
  | { readonly type: 'dict'; readonly entries: ReadonlyMap<string, FdfObject> }
  | { readonly type: 'ref'; readonly number: number }
  | { readonly type: 'other' };

export type FdfDictionary = Extract<FdfObject, { readonly type: 'dict' }>;

/** Nesting a real file never reaches; a deeper one is refused instead of overflowing the stack. */
const MAX_FDF_DEPTH = 64;

/** A PDF number: an optional sign, digits and at most one point (ISO 32000 §7.3.3). */
const PDF_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;

export interface FdfFile {
  /** The top-level dictionaries (the catalog, the trailer), in file order. */
  readonly roots: readonly FdfDictionary[];
  /** Indirect objects by number: `/Fields` and a field may be written as `N 0 R`. */
  readonly objects: ReadonlyMap<number, FdfObject>;
}

/**
 * The tokens as PDF objects. Nothing here is strict: an array or dictionary that the file
 * ends inside is what has been read of it, a dictionary entry that is not a key is skipped, and
 * a key without a value has none. (A field with half a `/V` is no field, not a failed file.)
 */
export function readFdfFile(tokens: readonly FdfToken[]): FdfFile {
  let position = 0;
  const isInteger = (token: FdfToken | undefined): token is FdfToken =>
    token?.keyword === true && /^\d+$/.test(token.text);

  const read = (depth: number): FdfObject => {
    if (depth > MAX_FDF_DEPTH) {
      throw new ToolError('corrupt-document', {
        engine: 'model',
        engineMessage: 'FDF objects are nested too deeply',
      });
    }
    // Callers read only while there is a token left.
    const token = tokens[position] as FdfToken;
    position += 1;
    switch (token.kind) {
      case 'string':
        return { type: 'string', text: token.text };
      case 'array-open': {
        const items: FdfObject[] = [];
        while (position < tokens.length && tokens[position]?.kind !== 'array-close') {
          items.push(read(depth + 1));
        }
        position += 1;
        return { type: 'array', items };
      }
      case 'dict-open': {
        const entries = new Map<string, FdfObject>();
        while (position < tokens.length && tokens[position]?.kind !== 'dict-close') {
          const key = tokens[position] as FdfToken;
          position += 1;
          if (key.kind !== 'name' || key.keyword === true) continue;
          const next = tokens[position];
          if (next === undefined || next.kind === 'dict-close') continue;
          entries.set(key.text, read(depth + 1));
        }
        position += 1;
        return { type: 'dict', entries };
      }
      case 'name': {
        if (token.keyword !== true) return { type: 'name', text: token.text };
        // `12 0 R`: a reference is three bare words.
        const generation = tokens[position];
        const marker = tokens[position + 1];
        if (isInteger(token) && isInteger(generation) && marker?.keyword === true && marker.text === 'R') {
          position += 2;
          return { type: 'ref', number: Number.parseInt(token.text, 10) };
        }
        if (PDF_NUMBER.test(token.text)) return { type: 'number', value: Number(token.text) };
        return { type: 'other' };
      }
      default:
        return { type: 'other' };
    }
  };

  const roots: FdfDictionary[] = [];
  const objects = new Map<number, FdfObject>();
  while (position < tokens.length) {
    const token = tokens[position] as FdfToken;
    const number = tokens[position - 2];
    const generation = tokens[position - 1];
    const isObj = token.keyword === true && token.text === 'obj';
    if (isObj && isInteger(number) && isInteger(generation)) {
      // `N G obj`: the object that follows is object N.
      position += 1;
      if (position >= tokens.length) break;
      const value = read(0);
      objects.set(Number.parseInt(number.text, 10), value);
      if (value.type === 'dict') roots.push(value);
      continue;
    }
    const value = read(0);
    if (value.type === 'dict') roots.push(value);
  }
  return { roots, objects };
}

/** An object, with `N 0 R` followed to what it names (a chain, not a cycle). */
export function resolveFdf(file: FdfFile, value: FdfObject | undefined): FdfObject | undefined {
  let current = value;
  for (let hops = 0; current?.type === 'ref' && hops < 16; hops += 1) {
    current = file.objects.get(current.number);
  }
  return current?.type === 'ref' ? undefined : current;
}

/** `/Fields` of the FDF dictionary: `/FDF` of a top-level dictionary, or the dictionary itself. */
function fdfFieldsOf(file: FdfFile): readonly FdfObject[] | null {
  for (const root of file.roots) {
    const fdf = resolveFdf(file, root.entries.get('FDF'));
    const container = fdf?.type === 'dict' ? fdf : root;
    const fields = resolveFdf(file, container.entries.get('Fields'));
    if (fields?.type === 'array') return fields.items;
  }
  return null;
}

/** A field's `/V` as a record value; `null` for what a form value cannot be (a number, a dictionary). */
function fdfValueOf(file: FdfFile, value: FdfObject | undefined): FormDataRecord['value'] | null {
  switch (value?.type) {
    case 'string':
      return value.text;
    case 'name':
      // `/Yes` has always meant "on" here, whatever the field's own on-state is called;
      // any other name is kept, for the field it lands on to match against its states.
      if (value.text === 'Yes') return true;
      if (value.text === 'Off') return false;
      return value.text;
    case 'array': {
      const items: string[] = [];
      for (const item of value.items) {
        const resolved = resolveFdf(file, item);
        if (resolved?.type === 'string' || resolved?.type === 'name') items.push(resolved.text);
      }
      return items;
    }
    default:
      return null;
  }
}

/** The records of `fields` and, under `/Kids`, of the fields below them: a child is `parent.child`. */
function collectFdfRecords(
  file: FdfFile,
  fields: readonly FdfObject[],
  prefix: string,
  depth: number,
  seen: Set<FdfObject>,
  out: FormDataRecord[],
): void {
  for (const item of fields) {
    const dict = resolveFdf(file, item);
    if (dict?.type !== 'dict' || seen.has(dict)) continue;
    seen.add(dict);
    const title = resolveFdf(file, dict.entries.get('T'));
    const partial = title?.type === 'string' ? title.text : null;
    const name = partial === null ? prefix : prefix === '' ? partial : `${prefix}.${partial}`;
    if (partial !== null) {
      const object = resolveFdf(file, dict.entries.get('V'));
      const value = fdfValueOf(file, object);
      // A name that is not `/Off` or `/Yes` stays text and says it was a name: the field it lands
      // on matches it against its states, not against option texts that spell the same.
      if (typeof value === 'string' && object?.type === 'name') out.push({ name, value, stateName: value });
      else if (value !== null) out.push({ name, value });
    }
    const kids = resolveFdf(file, dict.entries.get('Kids'));
    if (kids?.type === 'array' && depth < MAX_FDF_DEPTH) {
      collectFdfRecords(file, kids.items, name, depth + 1, seen, out);
    }
  }
}

/**
 * Byte for byte as characters: `TextDecoder('latin1')` is Windows-1252, which would turn the byte 0x9A of a
 * PDFDocEncoding string into `š` before the tokenizer could read it as `ı`.
 */
export function bytesAsCharacters(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return chunks.join('');
}

/**
 * Field records out of an FDF file. A file without the header is refused with
 * `unsupported-format` rather than parsed into empty results: "no fields found"
 * and "this is not a form-data file" are different answers and only one of them
 * is safe to act on. A file whose `/Fields` array carries no value at all reads as
 * no records — the caller decides what that means for an import.
 *
 * A name value is kept as text, with `stateName` set to it, except `/Off` (off) and `/Yes`
 * (on): the form a record is written to knows what its own on-states are called.
 */
export function parseFdf(bytes: Uint8Array): readonly FormDataRecord[] {
  const source = bytesAsCharacters(bytes);
  if (!source.startsWith(FDF_HEADER)) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      engineMessage: 'not an FDF file',
    });
  }
  const file = readFdfFile(tokenizePdfSource(source, { bytes: true }));
  const fields = fdfFieldsOf(file);
  if (fields === null) {
    throw new ToolError('corrupt-document', {
      engine: 'model',
      engineMessage: 'FDF file carries no /Fields array',
    });
  }
  const records: FormDataRecord[] = [];
  collectFdfRecords(file, fields, '', 0, new Set(), records);
  return records;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** `{ "fields": [{ name, value }] }`, or a bare `{ name: value }` map. */
export function parseFormJson(text: string): readonly FormDataRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ToolError(
      'unsupported-format',
      { engine: 'model', engineMessage: `form JSON is not parseable: ${String(error)}` },
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      engineMessage: 'form JSON must be an object',
    });
  }
  const container = parsed as Record<string, unknown>;
  const fields = container.fields;
  const records: FormDataRecord[] = [];
  if (Array.isArray(fields)) {
    for (const entry of fields) {
      if (entry === null || typeof entry !== 'object') continue;
      const { name, value } = entry as { readonly name?: unknown; readonly value?: unknown };
      if (typeof name !== 'string') continue;
      const normalised = normaliseJsonValue(value);
      if (normalised === null) continue;
      records.push({ name, value: normalised });
    }
    return records;
  }
  for (const [name, value] of Object.entries(container)) {
    const normalised = normaliseJsonValue(value);
    if (normalised === null) continue;
    records.push({ name, value: normalised });
  }
  return records;
}

function normaliseJsonValue(value: unknown): string | readonly string[] | boolean | null {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return null;
}

export function serializeFormJson(records: readonly FormDataRecord[], pretty = false): Uint8Array {
  const payload = {
    fields: records.map((record) => ({
      name: record.name,
      value: Array.isArray(record.value) ? [...record.value] : record.value,
    })),
  };
  return new TextEncoder().encode(pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload));
}
