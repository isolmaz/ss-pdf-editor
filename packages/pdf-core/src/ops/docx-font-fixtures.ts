/**
 * A tiny but valid bare CFF program, built byte by byte, for the font tests
 * (`docx-font-sfnt.test.ts`, `docx-fonts.test.ts`).
 */

const encodeInt = (value: number): number[] => {
  if (value >= -107 && value <= 107) return [value + 139];
  if (value >= 108 && value <= 1131) return [247 + ((value - 108) >> 8), (value - 108) & 255];
  if (value <= -108 && value >= -1131) return [251 + ((-value - 108) >> 8), (-value - 108) & 255];
  if (value >= -32768 && value <= 32767) return [28, (value >> 8) & 255, value & 255];
  return [29, (value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
};

/** The always-five-byte form: operands that point inside the file must not change its layout. */
export const encodeOffset = (value: number): number[] => [
  29,
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];

function encodeReal(text: string): number[] {
  const nibbles: number[] = [];
  for (const token of text.match(/E-|[0-9.E-]/g) ?? []) {
    if (token === '.') nibbles.push(10);
    else if (token === '-') nibbles.push(14);
    else if (token === 'E') nibbles.push(11);
    else if (token === 'E-') nibbles.push(12);
    else nibbles.push(Number(token));
  }
  nibbles.push(15);
  if (nibbles.length % 2 === 1) nibbles.push(15);
  const out = [30];
  for (let at = 0; at < nibbles.length; at += 2) out.push(((nibbles[at] ?? 0) << 4) | (nibbles[at + 1] ?? 0));
  return out;
}

export function index(objects: readonly number[][], offSize = 1): number[] {
  if (objects.length === 0) return [0, 0];
  const out = [(objects.length >> 8) & 255, objects.length & 255, offSize];
  let offset = 1;
  const put = (value: number) => {
    for (let byte = offSize - 1; byte >= 0; byte -= 1) out.push((value >>> (8 * byte)) & 255);
  };
  put(offset);
  for (const object of objects) {
    offset += object.length;
    put(offset);
  }
  for (const object of objects) out.push(...object);
  return out;
}

export interface CffOptions {
  readonly glyphs?: number;
  /** FontMatrix operands, as real numbers; `null` omits the operator. */
  readonly matrix?: readonly string[] | null;
  readonly bbox?: readonly number[] | null;
  readonly defaultWidth?: number | null;
  readonly cid?: 'with-fd' | 'bad-fd' | 'no-fd';
  readonly nameCount?: number;
  /** INDEX offset size for the Name, Top DICT and CharStrings INDEXes. */
  readonly offSize?: number;
  /** Point the Private DICT beyond the file. */
  readonly badPrivate?: boolean;
}

/** A tiny but valid CFF: `.notdef` and `glyphs - 1` glyphs of just `endchar`. */
export function buildCff(options: CffOptions = {}): Uint8Array {
  const glyphs = options.glyphs ?? 3;
  const matrix = options.matrix === undefined ? ['0.001', '0', '0', '0.001', '0', '0'] : options.matrix;
  const bbox = options.bbox === undefined ? [-200, -1500, 2000, 900] : options.bbox;
  const defaultWidth = options.defaultWidth === undefined ? 500 : options.defaultWidth;
  const header = [1, 0, 4, 1];
  const offSize = options.offSize ?? 1;
  const names = index(
    Array.from({ length: options.nameCount ?? 1 }, () => [...'Test'].map((c) => c.charCodeAt(0))),
    offSize,
  );
  const strings = index([]);
  const subrs = index([]);
  const charStrings = index(
    Array.from({ length: glyphs }, () => [0x0e]),
    glyphs > 200 ? 2 : offSize,
  );
  const charset = [0, ...Array.from({ length: glyphs - 1 }, (_, i) => [0, 34 + i]).flat()];
  const priv = defaultWidth === null ? [] : [...encodeInt(defaultWidth), 20, ...encodeInt(0), 21];
  const fdDict = (privateAt: number): number[] => [
    ...(matrix === null ? [] : [...matrix.flatMap((value) => encodeReal(value)), 12, 7]),
    ...encodeOffset(priv.length),
    ...encodeOffset(options.badPrivate ? 9_999_999 : privateAt),
    18,
  ];
  const topDict = (offsets: {
    charStrings: number;
    charset: number;
    privateAt: number;
    fdArray: number;
  }): number[] => {
    const cid = options.cid !== undefined;
    return [
      ...encodeOffset(100000),
      0, // version, with a five-byte operand
      ...(cid ? [...encodeInt(391), ...encodeInt(392), ...encodeInt(0), 12, 30] : []),
      ...(bbox === null ? [] : [...bbox.flatMap((value) => encodeInt(value)), 5]),
      ...(matrix === null || cid ? [] : [...matrix.flatMap((value) => encodeReal(value)), 12, 7]),
      ...encodeOffset(offsets.charset),
      15,
      ...encodeOffset(offsets.charStrings),
      17,
      ...(cid
        ? options.cid === 'no-fd'
          ? []
          : [...encodeOffset(offsets.fdArray), 12, 36]
        : [
            ...encodeOffset(priv.length),
            ...encodeOffset(options.badPrivate ? 9_999_999 : offsets.privateAt),
            18,
          ]),
    ];
  };
  const sizeOfTop = index(
    [topDict({ charStrings: 0, charset: 0, privateAt: 0, fdArray: 0 })],
    offSize,
  ).length;
  const afterTop = header.length + names.length + sizeOfTop + strings.length + subrs.length;
  const charsetAt = afterTop;
  const charStringsAt = charsetAt + charset.length;
  const privateAt = charStringsAt + charStrings.length;
  const fdArrayAt = privateAt + priv.length;
  const fdArray = index([fdDict(privateAt)]);
  const top = topDict({
    charStrings: charStringsAt,
    charset: charsetAt,
    privateAt,
    fdArray: options.cid === 'bad-fd' ? 9_999_999 : fdArrayAt,
  });
  const body = options.cid === 'with-fd' || options.cid === 'bad-fd' ? fdArray : [];
  return new Uint8Array([
    ...header,
    ...names,
    ...index([top], offSize),
    ...strings,
    ...subrs,
    ...charset,
    ...charStrings,
    ...priv,
    ...body,
  ]);
}
