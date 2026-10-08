/**
 * A one-page file for the PDF/A conversion that carries what each step of it has to deal with: an
 * unembedded font, constant alpha, a filled text field, a signature, scripts, an attachment (as a
 * name-tree entry and as an annotation), annotations of every fate, and the catalog features
 * Ghostscript may or may not keep (tags, outlines, page labels, layers).
 */

import { loadMupdf, openPdf } from '../engines/mupdf';
import { blankForm, handPdf } from './forms.fixtures';

const stream = (body: string, dict = '') => `<</Length ${body.length}${dict}>>\nstream\n${body}\nendstream`;
export function rich(): Uint8Array {
  return handPdf({
    1: '<</Type/Catalog/Pages 2 0 R/Lang(en)/MarkInfo<</Marked true>>/StructTreeRoot 30 0 R/Outlines 31 0 R/PageLabels<</Nums[0<</S/D>>]>>/OCProperties<</OCGs[32 0 R]/D<</Name(Default)/Order[32 0 R]>>>>/OpenAction 21 0 R/Names<</JavaScript<</Names[(a) 21 0 R]>>/EmbeddedFiles<</Names[(f.txt) 22 0 R]>>>>/AcroForm<</Fields[40 0 R 41 0 R]>>>>',
    2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Resources<</Font<</F 10 0 R>>/ExtGState<</G<</ca 0.5>>>>>>/Contents 11 0 R/Annots[40 0 R 41 0 R 50 0 R 51 0 R 52 0 R 53 0 R]>>',
    10: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    11: stream(
      '/G gs 1 0 0 rg 20 20 80 40 re f 0 g BT /F 14 Tf 20 150 Td (Quarterly results were published today) Tj ET',
    ),
    21: '<</S/JavaScript/JS(1)>>',
    22: '<</Type/Filespec/F(f.txt)/EF<</F 23 0 R>>>>',
    23: stream('hello'),
    30: '<</Type/StructTreeRoot>>',
    31: '<</Type/Outlines/First 33 0 R/Last 33 0 R/Count 1>>',
    33: '<</Title(One)/Parent 31 0 R/Dest[3 0 R/Fit]>>',
    32: '<</Type/OCG/Name(L)>>',
    40: '<</Type/Annot/Subtype/Widget/FT/Tx/T(t)/V(x)/Rect[150 20 250 40]/F 4/P 3 0 R/AP<</N 60 0 R>>>>',
    41: '<</Type/Annot/Subtype/Widget/FT/Sig/T(s)/V<</Type/Sig/Filter/Adobe.PPKLite>>/Rect[0 0 0 0]/F 4/P 3 0 R>>',
    50: '<</Type/Annot/Subtype/Sound/Rect[1 1 9 9]/F 4>>',
    51: '<</Type/Annot/Subtype/FileAttachment/Rect[1 1 9 9]/F 4/FS 22 0 R/Name/Paperclip>>',
    52: '<</Type/Annot/Subtype/Square/Rect[120 90 180 130]/C[0 0 1]/F 4>>',
    53: '<</Type/Annot/Subtype/Link/Rect[10 10 90 30]/F 0/A<</S/URI/URI(http://x)>>>>',
    60: blankForm(100, 20),
  });
}

/** A page of `text` (one line, unembedded Helvetica) of the given size; `pages` of them. */
export function plain(options: {
  readonly text: string;
  readonly pages?: number;
  readonly size?: readonly [number, number];
}): Uint8Array {
  const [width, height] = options.size ?? [300, 200];
  const pages = options.pages ?? 1;
  const objects: Record<number, string> = {
    1: '<</Type/Catalog/Pages 2 0 R>>',
    2: `<</Type/Pages/Kids[${Array.from({ length: pages }, (_page, at) => `${3 + at} 0 R`).join(' ')}]/Count ${pages}>>`,
    10: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    11: stream(`0 g BT /F 14 Tf 20 ${height - 50} Td (${options.text}) Tj ET`),
  };
  for (let at = 0; at < pages; at += 1) {
    objects[3 + at] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${width} ${height}]/Resources<</Font<</F 10 0 R>>>>/Contents 11 0 R>>`;
  }
  return handPdf(objects);
}

/**
 * `bytes` with a second content stream MuPDF cannot decode (a predictor row width that
 * overflows), appended incrementally so a PDF/A claim and its metadata stay as they were.
 */
export async function withUnreadableContent(bytes: Uint8Array): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  try {
    const page = doc.findPage(0);
    const unreadable = doc.addRawStream(new Uint8Array([0x78, 0x9c, 3, 0, 0, 0, 0, 1]), {});
    unreadable.put('Filter', doc.newName('FlateDecode'));
    const parms = doc.newDictionary();
    parms.put('Predictor', 12);
    parms.put('Columns', 2147483647);
    parms.put('Colors', 32);
    parms.put('BitsPerComponent', 16);
    unreadable.put('DecodeParms', parms);
    const contents = doc.newArray();
    contents.push(page.get('Contents'));
    contents.push(unreadable);
    page.put('Contents', contents);
    return new Uint8Array(doc.saveToBuffer('incremental').asUint8Array());
  } finally {
    doc.destroy();
  }
}
