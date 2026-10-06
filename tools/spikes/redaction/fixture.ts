/**
 * Fixture for spike #4 (throwaway — `PLAN.md §9/K21`, never shipped).
 *
 * Four things must exist in one file, because the redaction question is what
 * survives a redaction **export**:
 *   - the token in the page-1 text layer (the occurrence to remove),
 *   - the same token in page-2 text (an occurrence that must survive),
 *   - Info (`/Info` dictionary) *and* XMP (`/Metadata` stream) carrying it,
 *   - an embedded file (attachment) carrying it,
 *   - an **incremental second revision**, so the file carries a `/Prev` chain
 *     and an earlier revision keeps the old content (the K16 "old revision"
 *     trap: a redaction that is written incrementally leaves the old bytes).
 */
import { loadMupdf } from '../load-mupdf';
import { createFixture } from '../mupdf-fixture.mjs';
import { type Mupdf, openPdf, type PdfDoc, trySavePdf } from './engine';

export const TOKEN = 'GIZLI-TOKEN-4711';
export const REV1_TITLE = `Sozlesme ${TOKEN}`;
export const REV2_TITLE = 'Sozlesme (revizyon 2)';

export interface Fixture {
  /** Revision 1 as written from scratch (token in Info, XMP, attachment, both pages). */
  readonly rev1: Uint8Array;
  /** Revision 1 + one incremental update → the file the redaction opens. */
  readonly rev2: Uint8Array;
  readonly incremental: {
    readonly canBeSavedIncrementallyBefore: boolean;
    readonly canBeSavedIncrementallyAfter: boolean;
    readonly saveOptions: string;
    readonly bytes: number | null;
    readonly error: string | null;
  };
  readonly rev1Bytes: number;
  readonly rev2Bytes: number;
}

function xmpPacket(title: string, note: string): string {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${note}</rdf:li></rdf:Alt></dc:description>
      <xmp:CreatorTool>PDF Editor Phase 0 spike fixture</xmp:CreatorTool>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** Revision 1: both pages, Info, XMP and the attachment, written from scratch. */
async function buildRevision1(): Promise<Uint8Array> {
  const document = createFixture(await loadMupdf());
  document.info({
    Title: REV1_TITLE,
    Subject: `Gizli ek notu: ${TOKEN}`,
    Author: `GIZLI hususi ${TOKEN}`,
    Keywords: `${TOKEN} gizli sozlesme`,
    Creator: 'PDF Editor Phase 0 spike fixture',
    Producer: 'PDF Editor Phase 0 spike fixture (MuPDF 1.28)',
  });

  const page1 = document.addPage(595.28, 841.89);
  page1.text('Sayfa 1 - asagidaki satir redakte edilecek:', { x: 60, y: 780, size: 12 });
  page1.text(`Kimlik: ${TOKEN}`, { x: 60, y: 760, size: 14, color: [0.1, 0.1, 0.1] });
  page1.text('Bu satirda token yok, kalmalidir.', { x: 60, y: 735, size: 12 });

  const page2 = document.addPage(595.28, 841.89);
  page2.text('Sayfa 2 - bu satir KALMALIDIR:', { x: 60, y: 780, size: 12 });
  page2.text(`Kimlik: ${TOKEN}`, { x: 60, y: 760, size: 14, color: [0.1, 0.1, 0.1] });

  // XMP lives in its own `/Metadata` stream (the pattern Phase 2 needs anyway).
  document.xmp(xmpPacket(REV1_TITLE, `Gizli aciklama ${TOKEN}`));

  document.attach('gizli-ek.txt', new TextEncoder().encode(`Gizli ek icerigi: ${TOKEN}\n`), {
    mimeType: 'text/plain',
    description: `Gizli ek ${TOKEN}`,
    date: new Date('2026-09-15T00:00:00Z'),
  });

  // No object streams: the audit must be able to say whether the token is literally
  // present in the file's bytes, not only inside a compressed object. Streams are
  // compressed, as they were in the original fixture.
  return document.save('compress');
}

/** Revision 2: one MuPDF incremental update that rewrites only `/Info`. */
function buildRevision2(
  mupdf: Mupdf,
  rev1: Uint8Array,
): { incremental: Fixture['incremental']; rev2: Uint8Array | null } {
  const doc: PdfDoc = openPdf(mupdf, rev1);
  const before = doc.canBeSavedIncrementally();
  doc.setMetaData(mupdf.Document.META_INFO_TITLE, REV2_TITLE);
  const after = doc.canBeSavedIncrementally();
  const { bytes, error } = trySavePdf(doc, 'incremental');
  doc.destroy();
  return {
    incremental: {
      canBeSavedIncrementallyBefore: before,
      canBeSavedIncrementallyAfter: after,
      saveOptions: 'incremental',
      bytes: bytes ? bytes.byteLength : null,
      error,
    },
    rev2: bytes,
  };
}

export async function buildFixture(mupdf: Mupdf): Promise<Fixture> {
  const rev1 = await buildRevision1();
  const { incremental, rev2 } = buildRevision2(mupdf, rev1);
  if (!rev2) {
    throw new Error(`fixture revision 2 failed: ${incremental.error ?? 'no bytes'}`);
  }
  return {
    rev1,
    rev2,
    incremental,
    rev1Bytes: rev1.byteLength,
    rev2Bytes: rev2.byteLength,
  };
}
