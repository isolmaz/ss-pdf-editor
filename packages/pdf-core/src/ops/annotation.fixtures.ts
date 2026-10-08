/** A hand-written one-page file whose only annotation is object 17 at generation 5, its /Contents being `extra`. */
export function generationFivePdf(extra: string): Uint8Array {
  const objects: readonly (readonly [number, number, string])[] = [
    [1, 0, '<</Type/Catalog/Pages 2 0 R>>'],
    [2, 0, '<</Type/Pages/Kids[3 0 R]/Count 1>>'],
    [3, 0, '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Annots[17 5 R]>>'],
    [17, 5, `<</Type/Annot/Subtype/Square/Rect[10 10 50 50]/Contents(${extra})>>`],
  ];
  let text = '%PDF-1.4\n';
  const offsets = new Map<number, number>();
  for (const [number, generation, body] of objects) {
    offsets.set(number, text.length);
    text += `${number} ${generation} obj\n${body}\nendobj\n`;
  }
  const entry = (offset: number, generation: number, kind: 'n' | 'f') =>
    `${String(offset).padStart(10, '0')} ${String(generation).padStart(5, '0')} ${kind} \n`;
  const xref = text.length;
  text += `xref\n0 4\n${entry(0, 65535, 'f')}`;
  for (const number of [1, 2, 3]) text += entry(offsets.get(number) ?? 0, 0, 'n');
  text += `17 1\n${entry(offsets.get(17) ?? 0, 5, 'n')}`;
  text += `trailer\n<</Size 18/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}
