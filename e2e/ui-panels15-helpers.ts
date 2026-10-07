/**
 * Fixtures and readbacks of the round-15 panel specs: a document with one field of every
 * kind the form panel lists, and the values of its fields as an independent parser
 * (MuPDF, through the `pdf-core` manifest the repository root does not declare) reads them.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** One field of the form fixture, as the panel lists it. */
export interface FixtureField {
  readonly name: string;
  readonly kind: string;
  readonly value: string;
}

export const FORM_FIELDS: readonly FixtureField[] = [
  { name: 'applicant', kind: 'Text', value: 'Ada' },
  { name: 'locked', kind: 'Text', value: 'Fixed text' },
  { name: 'agree', kind: 'Checkbox', value: '' },
  { name: 'country', kind: 'Dropdown', value: 'France' },
  { name: 'topics', kind: 'List box', value: 'Alpha' },
  { name: 'plan', kind: 'Radio group', value: '' },
  { name: 'submit', kind: 'Button', value: '' },
  { name: 'seal', kind: 'Signature', value: '' },
];

/** Assemble objects, their cross-reference table and a trailer; the content is ASCII. */
function assemble(bodies: readonly string[]): Uint8Array {
  const chunks: string[] = ['%PDF-1.7\n'];
  const offsets: number[] = [];
  let offset = (chunks[0] ?? '').length;
  for (const [index, body] of bodies.entries()) {
    offsets.push(offset);
    const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    offset += chunk.length;
  }
  const xref = [
    'xref\n',
    `0 ${bodies.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`),
  ].join('');
  const trailer = `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  const source = chunks.join('') + xref + trailer;
  return new Uint8Array([...source].map((character) => character.charCodeAt(0)));
}

/** The form fixture's field rows, top to bottom on the one page. */
const WIDGET_TOP = 700;

/**
 * One page carrying a text field with a value and a required mark, a locked text field, a
 * checkbox, a dropdown with three options, a list box, a radio group of two buttons, a push
 * button and a signature field. Object numbers: 1 catalog, 2 pages, 3 page, 4 contents,
 * 5 font, 6 AcroForm, widgets from 7.
 */
export function formFixturePdf(): Uint8Array {
  const rect = (row: number) => `[72 ${WIDGET_TOP - row * 40} 300 ${WIDGET_TOP - row * 40 + 24}]`;
  const widget = (row: number, extra: string) =>
    `<< /Type /Annot /Subtype /Widget ${extra} /Rect ${rect(row)} /DA (/F1 12 Tf 0 g) /F 4 /P 3 0 R >>`;
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R ' +
      '/Annots [7 0 R 8 0 R 9 0 R 10 0 R 11 0 R 13 0 R 14 0 R 15 0 R 16 0 R] >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Fields [7 0 R 8 0 R 9 0 R 10 0 R 11 0 R 12 0 R 15 0 R 16 0 R] /DA (/F1 12 Tf 0 g) ' +
      '/DR << /Font << /F1 5 0 R >> >> >>',
    widget(0, '/FT /Tx /T (applicant) /V (Ada) /Ff 2'),
    widget(1, '/FT /Tx /T (locked) /V (Fixed text) /Ff 1'),
    widget(2, '/FT /Btn /T (agree) /V /Off /AS /Off'),
    widget(3, '/FT /Ch /T (country) /Ff 131072 /Opt [(Turkey) (France) (Japan)] /V (France)'),
    widget(4, '/FT /Ch /T (topics) /Opt [(Alpha) (Beta)] /V (Alpha)'),
    '<< /FT /Btn /T (plan) /Ff 49152 /Kids [13 0 R 14 0 R] /V /Off >>',
    widget(5, '/Parent 12 0 R /AS /Off'),
    widget(6, '/Parent 12 0 R /AS /Off'),
    widget(7, '/FT /Btn /T (submit) /Ff 65536'),
    widget(8, '/FT /Sig /T (seal)'),
  ];
  return assemble(bodies);
}

interface FieldObject {
  isNull(): boolean;
  isString(): boolean;
  isName(): boolean;
  isArray(): boolean;
  asString(): string;
  asName(): string;
  resolve(): FieldObject;
  get(...path: (string | number)[]): FieldObject;
  readonly length: number;
}
interface FormDocument {
  getTrailer(): FieldObject;
  destroy(): void;
}
interface Mupdf {
  PDFDocument: { openDocument(bytes: Uint8Array, magic: string): { asPDF(): FormDocument | null } };
}

const coreRequire = createRequire(new URL('../packages/pdf-core/package.json', import.meta.url));

/**
 * `/V` of every AcroForm field by name (a name object without its slash, a string as text),
 * `''` for a field without a value. Loaded from the path only `pdf-core`'s manifest resolves,
 * so the specifier is not a literal a static import could use.
 */
export async function formValues(bytes: Uint8Array): Promise<Readonly<Record<string, string>>> {
  const mupdf = (await import(pathToFileURL(coreRequire.resolve('mupdf')).href)) as Mupdf;
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('the produced file is not a PDF');
  try {
    const values: Record<string, string> = {};
    const fields = doc.getTrailer().get('Root', 'AcroForm', 'Fields');
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields.get(index).resolve();
      const name = field.get('T').resolve().asString();
      const value = field.get('V');
      const resolved = value.isNull() ? null : value.resolve();
      values[name] = resolved === null ? '' : resolved.isName() ? resolved.asName() : resolved.asString();
    }
    return values;
  } finally {
    doc.destroy();
  }
}

/**
 * Two pages, each with one unsigned signature field (`Author` on the first, `Reviewer` on the
 * second).
 */
export function signatureFieldsPdf(): Uint8Array {
  const page = (contents: number, annots: string) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents ${contents} 0 R /Annots [${annots}] >>`;
  const sig = (name: string, owner: number) =>
    `<< /Type /Annot /Subtype /Widget /FT /Sig /T (${name}) /Rect [20 20 200 60] /F 4 /P ${owner} 0 R >>`;
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 9 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    page(5, '7 0 R'),
    page(6, '8 0 R'),
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Length 0 >>\nstream\n\nendstream',
    sig('Author', 3),
    sig('Reviewer', 4),
    '<< /Fields [7 0 R 8 0 R] >>',
  ]);
}
