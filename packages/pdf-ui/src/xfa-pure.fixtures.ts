/**
 * A pure dynamic XFA form that pdf.js can really lay out (`isPureXfa`): one A4 page with a text
 * label, a single-line field, a multi-line field, a checkbox, a drop-down and a drop-down with
 * no entries. The XFA packets are well-formed XDP, which `xfaFormPdf('dynamic')` is not.
 */

import { mupdfForTests } from './pdf-fixtures';

const TEMPLATE =
  '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="tb">' +
  '<pageSet><pageArea name="p1"><contentArea x="10mm" y="10mm" w="150mm" h="200mm"/>' +
  '<medium stock="a4" short="210mm" long="297mm"/></pageArea></pageSet>' +
  '<subform layout="tb">' +
  '<draw name="Label" w="100mm" h="8mm"><ui><textEdit/></ui><value><text>Hello wrapped ghost</text></value></draw>' +
  '<field name="Name" w="80mm" h="10mm"><ui><textEdit/></ui><value><text>Ada</text></value></field>' +
  '<field name="Notes" w="80mm" h="20mm"><ui><textEdit multiLine="1"/></ui><value><text>first line&#10;&#10;third</text></value></field>' +
  '<field name="Agree" w="10mm" h="10mm"><ui><checkButton/></ui><items><integer>1</integer><integer>0</integer></items><value><integer>1</integer></value></field>' +
  '<field name="Pick" w="80mm" h="10mm"><ui><choiceList/></ui><items><text>One</text><text>Two</text></items><value><text>Two</text></value></field>' +
  '<field name="Empty" w="80mm" h="10mm"><ui><choiceList/></ui></field>' +
  '</subform></subform></template>';

const DATASETS =
  '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1/></xfa:data></xfa:datasets>';

/** The page size the form lays out, in points (A4). */
export const PURE_XFA_PAGE = { width: 595, height: 841 } as const;

/**
 * `needsRendering: false` leaves out the catalog flag that asks a reader to lay the form out: the
 * file still has XFA and no fields, but pdf.js does not take it for a pure XFA document.
 */
export async function pureXfaPdf(options: { readonly needsRendering?: boolean } = {}): Promise<Uint8Array> {
  const mupdf = await mupdfForTests();
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 400, 300], 0, {}, ''));
  const form = doc.addObject({ Fields: [] });
  doc.getTrailer().get('Root').put('AcroForm', form);
  const array = doc.newArray();
  for (const [name, body] of [
    ['preamble', '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">'],
    ['template', TEMPLATE],
    ['datasets', DATASETS],
    ['postamble', '</xdp:xdp>'],
  ] as const) {
    array.push(doc.newString(name));
    array.push(doc.addStream(body, doc.newDictionary()));
  }
  form.put('XFA', array);
  if (options.needsRendering !== false) doc.getTrailer().get('Root').put('NeedsRendering', true);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}
