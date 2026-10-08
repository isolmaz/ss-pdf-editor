/**
 * Hand-written form files: every object is written out, so a structure no producer-friendly
 * builder would emit (a null in `/Fields`, a field chain 40 deep, a widget that no page lists,
 * a direct dictionary where a reference is expected) is exactly what the reader gets.
 */

/** A file made of `objects` (object number → body; `1` is the catalog), with a correct xref. */
export function handPdf(objects: Readonly<Record<number, string>>): Uint8Array {
  const numbers = Object.keys(objects)
    .map(Number)
    .sort((a, b) => a - b);
  let text = '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  for (const number of numbers) {
    offsets.set(number, text.length);
    text += `${number} 0 obj\n${objects[number]}\nendobj\n`;
  }
  const size = (numbers[numbers.length - 1] ?? 0) + 1;
  const entry = (offset: number, generation: number, kind: 'n' | 'f') =>
    `${String(offset).padStart(10, '0')} ${String(generation).padStart(5, '0')} ${kind} \n`;
  const xref = text.length;
  text += `xref\n0 ${size}\n${entry(0, 65535, 'f')}`;
  for (let number = 1; number < size; number += 1) {
    const offset = offsets.get(number);
    text += offset === undefined ? entry(0, 0, 'f') : entry(offset, 0, 'n');
  }
  text += `trailer\n<</Size ${size}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

/** An empty form XObject `width` x `height` points: a drawn appearance that shows nothing. */
export function blankForm(width: number, height: number): string {
  return `<</Type/XObject/Subtype/Form/BBox[0 0 ${width} ${height}]/Length 0>>\nstream\n\nendstream`;
}

/**
 * A two-page file with an `/AcroForm` (object 5) listing `fields`. Page 1 is object 3 with
 * `/Annots` `annots`; page 2 is object 4 with `/Annots` `secondAnnots` (none when `null`).
 * Objects of the fields themselves are passed in `extra`.
 */
export function formPdf(options: {
  readonly fields: string;
  readonly annots: string;
  readonly secondAnnots?: string | null;
  readonly extra: Readonly<Record<number, string>>;
  readonly acroForm?: string;
  readonly pageExtra?: string;
}): Uint8Array {
  const second =
    options.secondAnnots === undefined || options.secondAnnots === null
      ? ''
      : `/Annots ${options.secondAnnots}`;
  return handPdf({
    1: '<</Type/Catalog/Pages 2 0 R/AcroForm 5 0 R>>',
    2: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>',
    3: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 600]/Annots ${options.annots}${options.pageExtra ?? ''}>>`,
    4: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 600]${second}>>`,
    5: `<</Fields ${options.fields}/DA(/Helv 12 Tf 0 g)${options.acroForm ?? ''}>>`,
    ...options.extra,
  });
}

/** A widget body at `rect` on page 1 (object 3). */
export function widgetBody(rect: string, more: string): string {
  return `<</Type/Annot/Subtype/Widget/Rect[${rect}]/P 3 0 R/F 4${more}>>`;
}
