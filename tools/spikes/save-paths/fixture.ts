/**
 * Spike #1 fixture — built in code, never committed (`PLAN.md §9/K21`).
 *
 * Deliberately ASCII-only: the standard-14 fonts encode WinAnsi, so Turkish
 * glyphs need an embedded OFL font (out of scope here). The fixture
 * carries unique per-page tokens so a marker can be (a) extracted as text,
 * (b) searched for in the raw output bytes — object-level evidence, not just
 * extraction.
 */
import { createFixture } from '../mupdf-fixture.mjs';
import { loadMupdf } from './readers';

export interface Fixture {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  /** `MARKER-<token>-<page>` — one per page, page index is 1-based. */
  readonly markers: string[];
  /** Text that must disappear after redaction. */
  readonly secret: string;
  /** Text on the same page that must survive redaction. */
  readonly neighbour: string;
  /** AcroForm text field value. */
  readonly formValue: string;
  readonly token: string;
}

export function makeToken(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const random = crypto.getRandomValues(new Uint8Array(8));
  for (const byte of random) out += alphabet[byte % alphabet.length];
  return out;
}

export function xmpDocument(token: string): string {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">spike-xmp-${token}</rdf:li></rdf:Alt></dc:description>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** A 64×64 PNG drawn on a canvas — the overlay image for branch 3. */
export async function makeOverlayPng(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d context unavailable');
  context.fillStyle = '#0f766e';
  context.fillRect(0, 0, 64, 64);
  context.fillStyle = '#ffffff';
  context.fillRect(8, 8, 48, 48);
  context.fillStyle = '#0f766e';
  context.fillRect(20, 20, 24, 24);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas.toBlob returned null');
  return new Uint8Array(await blob.arrayBuffer());
}

export async function buildFixture(pageCount = 5): Promise<Fixture> {
  const token = makeToken();
  const document = createFixture(await loadMupdf());
  const bold = document.standardFont('Helvetica-Bold');
  const pages = [];

  const markers: string[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const pageNumber = index + 1;
    const page = document.addPage(595.28, 841.89);
    pages.push(page);
    const marker = `MARKER-${token}-${pageNumber}`;
    markers.push(marker);
    page.text(`Sayfa ${pageNumber} / ${pageCount}`, {
      x: 60,
      y: 780,
      size: 18,
      font: bold,
      color: [0.1, 0.15, 0.3],
    });
    page.text(marker, { x: 60, y: 750, size: 11, color: [0.2, 0.2, 0.2] });
    for (let line = 0; line < 10; line += 1) {
      page.text(
        `Body line ${pageNumber}.${line + 1} of the save-path fixture document for phase zero measurements.`,
        { x: 60, y: 720 - line * 22, size: 10, color: [0.2, 0.2, 0.2] },
      );
    }
  }

  // Branch 4 targets this line on page 2 only.
  const secret = `SECRET-${token}-REDACT`;
  const neighbour = `NEIGHBOUR-${token}-KEEP`;
  const secretPage = pages[1];
  if (secretPage === undefined) throw new Error('the fixture needs at least two pages');
  secretPage.text(secret, { x: 60, y: 300, size: 12, color: [0.6, 0.1, 0.1] });
  secretPage.text(neighbour, { x: 60, y: 280, size: 12, color: [0.1, 0.4, 0.1] });

  // Form field: does `extractPages` keep AcroForm values? (branch 2 question)
  const formValue = `spike-form-${token}`;
  pages[0]?.textField('alan1', [60, 380, 280, 404], formValue);

  document.info({
    Title: `spike-fixture-${token}`,
    Author: 'PDF Editor spike #1',
    Producer: 'MuPDF 1.28 (spike fixture)',
    Subject: 'Phase 0 save-path measurement fixture',
  });
  document.xmp(xmpDocument(token));

  // No object streams: the raw-byte marker checks read the objects as written.
  const bytes = document.save();
  return { bytes, pageCount, markers, secret, neighbour, formValue, token };
}
