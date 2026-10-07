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
 * UTF-16BE with a `\376\377` BOM), and both forms appear in the wild.
 *
 * The JSON form is our own and deliberately boring: `{ "fields": [ { "name",
 * "value" } ] }`, with a bare `{ "name": "value" }` map accepted on import because
 * that is what hand-written files look like.
 */

import { ToolError } from 'pdf-shared';

export interface FormDataRecord {
  readonly name: string;
  readonly value: string | readonly string[] | boolean;
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
 * single-byte string, as this writer used to, read `gö` back as `g\0ö` — in every
 * reader, this one included.)
 */
function escapeFdfString(value: string): string {
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
 * A minimal FDF 1.2 file.
 *
 * A checkbox is `/V /Yes` or `/V /Off` — the two names every reader agrees on —
 * and a multi-select is an array of strings.
 */
export function serializeFdf(records: readonly FormDataRecord[]): Uint8Array {
  const fields = records.map((record) => {
    // `Array.isArray` does not narrow a `readonly T[]` union member, so the value
    // is branched on its own declared shape instead of on the array helper.
    const value: string | readonly string[] | boolean = record.value;
    if (typeof value === 'boolean') {
      return `<< /T (${escapeFdfString(record.name)}) /V /${value ? 'Yes' : 'Off'} >>`;
    }
    if (typeof value !== 'string') {
      const items = value.map((item) => `(${escapeFdfString(item)})`).join(' ');
      return `<< /T (${escapeFdfString(record.name)}) /V [ ${items} ] >>`;
    }
    return `<< /T (${escapeFdfString(record.name)}) /V (${escapeFdfString(value)}) >>`;
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
}

/**
 * The FDF tokenizer, exported for the **annotation** reader: an Acrobat comment file
 * carries a whole annotation as a PDF object inside a string, and reading that object
 * needs the same scanner — a second one would be a second set of escaping bugs.
 */
export function tokenizePdfSource(source: string): readonly FdfToken[] {
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
          const sequence = /^\\[0-7]{1,3}|^\\[\\()nrtbf]/.exec(source.slice(index));
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
      tokens.push({ kind: 'string', text: decodeFdfString(raw.join('')) });
      continue;
    }
    if (char === '/') {
      let end = index + 1;
      while (end < source.length && !/[\s/<>[\]()]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', text: source.slice(index + 1, end) });
      index = end;
      continue;
    }
    if (char === '<' && source[index + 1] === '<') {
      tokens.push({ kind: 'dict-open', text: '<<' });
      index += 2;
      continue;
    }
    if (char === '>' && source[index + 1] === '>') {
      tokens.push({ kind: 'dict-close', text: '>>' });
      index += 2;
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
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    let end = index;
    while (end < source.length && !/[\s/<>[\]()%]/.test(source[end] as string)) end += 1;
    tokens.push({ kind: 'name', text: source.slice(index, end) });
    index = end;
  }
  return tokens;
}

/**
 * An FDF string body (escapes intact) to text.
 *
 * Escaped text is assembled as **bytes**, not as characters: an octal escape is a
 * raw byte, and a value that mixes escaped and unescaped characters has to be
 * rebuilt in one pass before it can be decoded — which is exactly the pass a regex
 * over the source cannot do. A `\376\377` prefix is a UTF-16BE BOM and switches the
 * assembly to two-byte code units; anything else is Latin-1, the encoding a PDF
 * string without a BOM is read in. A character that is not a byte at all (the source was
 * text, or Latin-1 bytes read as Windows-1252, which has `€` where Latin-1 has a control
 * character) is already text: it stays itself, and only in a UTF-16 string is it widened to
 * the two-byte form the BOM announces.
 */
function decodeFdfString(raw: string): string {
  /** Bytes (escapes and characters up to U+00FF) and, above that, code points. */
  const units: number[] = [];
  let index = 0;
  while (index < raw.length) {
    if (raw[index] === '\\') {
      const octal = /^\\([0-7]{1,3})/.exec(raw.slice(index));
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

/**
 * Field records out of an FDF file. A file without the header is refused with
 * `unsupported-format` rather than parsed into empty results: "no fields found"
 * and "this is not a form-data file" are different answers and only one of them
 * is safe to act on.
 */
export function parseFdf(bytes: Uint8Array): readonly FormDataRecord[] {
  const source = new TextDecoder('latin1').decode(bytes);
  if (!source.startsWith(FDF_HEADER)) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      engineMessage: 'not an FDF file',
    });
  }
  const tokens = tokenizePdfSource(source);
  const records: FormDataRecord[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'name' || token.text !== 'T') continue;
    const nameToken = tokens[index + 1];
    if (nameToken?.kind !== 'string') continue;
    const valueToken = tokens[index + 2];
    if (valueToken?.kind !== 'name' || valueToken.text !== 'V') continue;
    const value = tokens[index + 3];
    if (value === undefined) continue;
    if (value.kind === 'string') {
      records.push({ name: nameToken.text, value: value.text });
    } else if (value.kind === 'name') {
      if (value.text === 'Yes') records.push({ name: nameToken.text, value: true });
      else if (value.text === 'Off') records.push({ name: nameToken.text, value: false });
      else records.push({ name: nameToken.text, value: value.text });
    } else if (value.kind === 'array-open') {
      const items: string[] = [];
      let cursor = index + 4;
      while (cursor < tokens.length && tokens[cursor]?.kind !== 'array-close') {
        const item = tokens[cursor];
        if (item?.kind === 'string' || item?.kind === 'name') items.push(item.text);
        cursor += 1;
      }
      records.push({ name: nameToken.text, value: items });
    }
  }
  if (records.length === 0 && !source.includes('/Fields')) {
    throw new ToolError('corrupt-document', {
      engine: 'model',
      engineMessage: 'FDF file carries no /Fields array',
    });
  }
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
