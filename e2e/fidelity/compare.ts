/**
 * The measuring instruments of the export-fidelity harness: image similarity and word
 * accuracy. Pure functions, no I/O, so `compare.test.ts` can pin them to known answers.
 */

/** 8-bit grayscale, row-major, one byte per pixel. */
export interface Gray {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const WINDOW = 11;
const SIGMA = 1.5;
const L = 255;
const C1 = (0.01 * L) ** 2;
const C2 = (0.03 * L) ** 2;

/** The normalised 1-D Gaussian whose outer product is the 11×11 window of Wang et al. */
const KERNEL: Float64Array = (() => {
  const kernel = new Float64Array(WINDOW);
  let sum = 0;
  for (let i = 0; i < WINDOW; i++) {
    const x = i - (WINDOW - 1) / 2;
    kernel[i] = Math.exp(-(x * x) / (2 * SIGMA * SIGMA));
    sum += kernel[i] ?? 0;
  }
  for (let i = 0; i < WINDOW; i++) kernel[i] = (kernel[i] ?? 0) / sum;
  return kernel;
})();

/** Separable "valid" Gaussian filtering: the output is (w − 10) × (h − 10). */
function blur(source: Float64Array, width: number, height: number): Float64Array {
  const outW = width - WINDOW + 1;
  const outH = height - WINDOW + 1;
  const horizontal = new Float64Array(outW * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < outW; x++) {
      let acc = 0;
      for (let k = 0; k < WINDOW; k++) acc += (KERNEL[k] as number) * (source[row + x + k] as number);
      horizontal[y * outW + x] = acc;
    }
  }
  const out = new Float64Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let acc = 0;
      for (let k = 0; k < WINDOW; k++)
        acc += (KERNEL[k] as number) * (horizontal[(y + k) * outW + x] as number);
      out[y * outW + x] = acc;
    }
  }
  return out;
}

/**
 * Mean structural similarity (Wang, Bovik, Sheikh, Simoncelli 2004): a Gaussian 11×11
 * window with σ = 1.5, K1 = 0.01, K2 = 0.03, L = 255, averaged over every position where the
 * window fits entirely inside the image. 1 means identical; unrelated content approaches 0.
 * Both images must have the same size — the caller resizes.
 */
export function ssim(a: Gray, b: Gray): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new RangeError(`ssim needs equal sizes, got ${a.width}x${a.height} and ${b.width}x${b.height}`);
  }
  const { width, height } = a;
  if (a.data.length !== width * height || b.data.length !== width * height) {
    throw new RangeError('ssim: pixel buffer length does not match width × height');
  }
  if (width < WINDOW || height < WINDOW) {
    throw new RangeError(`ssim needs at least ${WINDOW}x${WINDOW} pixels, got ${width}x${height}`);
  }
  const n = width * height;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const xx = new Float64Array(n);
  const yy = new Float64Array(n);
  const xy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = a.data[i] as number;
    const q = b.data[i] as number;
    x[i] = p;
    y[i] = q;
    xx[i] = p * p;
    yy[i] = q * q;
    xy[i] = p * q;
  }
  const muX = blur(x, width, height);
  const muY = blur(y, width, height);
  const sXX = blur(xx, width, height);
  const sYY = blur(yy, width, height);
  const sXY = blur(xy, width, height);
  let total = 0;
  for (let i = 0; i < muX.length; i++) {
    const mx = muX[i] as number;
    const my = muY[i] as number;
    const varX = (sXX[i] as number) - mx * mx;
    const varY = (sYY[i] as number) - my * my;
    const cov = (sXY[i] as number) - mx * my;
    total += ((2 * mx * my + C1) * (2 * cov + C2)) / ((mx * mx + my * my + C1) * (varX + varY + C2));
  }
  return total / muX.length;
}

/** Bilinear resampling (pixel-centre aligned, edges clamped) of `image` to `width × height`. */
export function resizeBilinear(image: Gray, width: number, height: number): Gray {
  if (image.width === width && image.height === height) return image;
  const data = new Uint8Array(width * height);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), image.height - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, image.height - 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), image.width - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, image.width - 1);
      const wx = fx - x0;
      const top =
        (image.data[y0 * image.width + x0] as number) * (1 - wx) +
        (image.data[y0 * image.width + x1] as number) * wx;
      const bottom =
        (image.data[y1 * image.width + x0] as number) * (1 - wx) +
        (image.data[y1 * image.width + x1] as number) * wx;
      data[y * width + x] = Math.round(top * (1 - wy) + bottom * wy);
    }
  }
  return { width, height, data };
}

/**
 * Undo line-end hyphenation in extracted text: a line that ends with a hyphen (`-`, U+00AD,
 * U+2010) directly after a letter is joined to the next line when that line starts with a
 * lowercase letter (`\p{Ll}`, so Turkish `ı`/`ş`/`ğ` count and a capitalised word after a dash does
 * not), and the hyphen is dropped: "infor-\nmation" → "information". A blank line (block
 * break) stops the join. The export joins such words, the original's extraction does not, so
 * both sides go through this before they are compared.
 */
export function joinHyphenation(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      /[\p{L}][-\u00AD\u2010]$/u.test(previous.trimEnd()) &&
      /^\s*\p{Ll}/u.test(line)
    ) {
      out[out.length - 1] = previous.trimEnd().slice(0, -1) + line.trimStart();
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

const QUOTES: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B\u2032\u00B4`]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-'],
];

/**
 * Text → comparable words. NFKC folds ligatures (ﬁ → fi), full-width forms and no-break
 * spaces; soft hyphens and zero-width characters are dropped; typographic quotes and dashes
 * become their ASCII forms; the split is on whitespace and punctuation stays attached to its
 * word. Case is never touched — `toLowerCase()` with the default locale would turn `I` into
 * `ı` on a Turkish machine, and a fold of `İ`/`ı` would hide exactly the bug being measured.
 */
export function normalizeWords(text: string): string[] {
  let t = text.normalize('NFKC').replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '');
  for (const [pattern, replacement] of QUOTES) t = t.replace(pattern, replacement);
  return t.split(/\s+/u).filter((word) => word.length > 0);
}

export interface WordComparison {
  /** 1 − (word edit distance ÷ expected word count), floored at 0. */
  accuracy: number;
  /** Word-level Levenshtein distance behind `accuracy`. */
  distance: number;
  /** Expected words the actual text lacks. */
  missing: string[];
  /** Words in the actual text that were not expected. */
  extra: string[];
  /** `[expected, actual]` pairs the alignment paired up as one substitution. */
  substituted: Array<[string, string]>;
}

/** The alignment matrix is one byte per cell; refuse what cannot be allocated. */
const MAX_CELLS = 1_000_000_000;

const MATCH = 0;
const SUBSTITUTE = 1;
const DELETE = 2; // expected word absent from actual
const INSERT = 3; // actual word not expected

/**
 * Word-level Levenshtein alignment of the actual text against the expected one. A shared
 * prefix and suffix are peeled off first, so two nearly equal pages cost almost nothing;
 * the middle is aligned with rolling Int32 rows plus a one-byte-per-cell direction matrix
 * for the backtrace. Reordered text is counted as missing + extra, which is what it is.
 */
export function compareWords(expected: readonly string[], actual: readonly string[]): WordComparison {
  let start = 0;
  const limit = Math.min(expected.length, actual.length);
  while (start < limit && expected[start] === actual[start]) start++;
  let endE = expected.length;
  let endA = actual.length;
  while (endE > start && endA > start && expected[endE - 1] === actual[endA - 1]) {
    endE--;
    endA--;
  }
  const rows = endE - start;
  const cols = endA - start;
  const missing: string[] = [];
  const extra: string[] = [];
  const substituted: Array<[string, string]> = [];
  let distance = 0;

  if (rows === 0) {
    for (let j = 0; j < cols; j++) extra.push(actual[start + j] as string);
    distance = cols;
  } else if (cols === 0) {
    for (let i = 0; i < rows; i++) missing.push(expected[start + i] as string);
    distance = rows;
  } else {
    if ((rows + 1) * (cols + 1) > MAX_CELLS) {
      throw new RangeError(`compareWords: ${rows}×${cols} words is too large to align`);
    }
    const stride = cols + 1;
    const direction = new Uint8Array((rows + 1) * stride);
    let previous = new Int32Array(stride);
    let current = new Int32Array(stride);
    for (let j = 1; j <= cols; j++) {
      previous[j] = j;
      direction[j] = INSERT;
    }
    for (let i = 1; i <= rows; i++) {
      current[0] = i;
      direction[i * stride] = DELETE;
      const e = expected[start + i - 1];
      for (let j = 1; j <= cols; j++) {
        const same = e === actual[start + j - 1];
        const diagonal = (previous[j - 1] as number) + (same ? 0 : 1);
        const up = (previous[j] as number) + 1;
        const left = (current[j - 1] as number) + 1;
        let best = diagonal;
        let step = same ? MATCH : SUBSTITUTE;
        if (up < best) {
          best = up;
          step = DELETE;
        }
        if (left < best) {
          best = left;
          step = INSERT;
        }
        current[j] = best;
        direction[i * stride + j] = step;
      }
      [previous, current] = [current, previous];
    }
    distance = previous[cols] as number;
    let i = rows;
    let j = cols;
    while (i > 0 || j > 0) {
      const step = direction[i * stride + j];
      if (step === MATCH) {
        i--;
        j--;
      } else if (step === SUBSTITUTE) {
        substituted.push([expected[start + i - 1] as string, actual[start + j - 1] as string]);
        i--;
        j--;
      } else if (step === DELETE) {
        missing.push(expected[start + i - 1] as string);
        i--;
      } else {
        extra.push(actual[start + j - 1] as string);
        j--;
      }
    }
    missing.reverse();
    extra.reverse();
    substituted.reverse();
  }

  const accuracy =
    expected.length === 0 ? (actual.length === 0 ? 1 : 0) : Math.max(0, 1 - distance / expected.length);
  return { accuracy, distance, missing, extra, substituted };
}
