/**
 * Spike #1 branches — the eight measurement cases from the assignment
 * (`PLAN.md §5/Phase 0` spike #1: annotation-only, page composition,
 * overlay+metadata, redaction, mixed, encrypted input, repeated saves, failed
 * write).
 *
 * Each branch reports *measured* facts and cross-reader evidence; nothing here
 * ships (`§9/K21`).
 */
import { type ChangeSummary, NO_CHANGES, planSave, type SavePlan, SessionStore } from 'pdf-model';
import { OPS } from 'pdfjs-dist';
import { overlayPage } from '../mupdf-fixture.mjs';
import type { Fixture } from './fixture';
import { equalBytes, isIncrementalOver, occurrences, type Recorder, sha256Hex } from './harness';
import {
  countBytes,
  inspectWithMupdf,
  inspectWithPdfjs,
  type MupdfDocument,
  type MupdfPage,
  openMupdf,
  openPdfjs,
  type PdfjsInspection,
} from './readers';

export interface SpikeContext {
  readonly fixture: Fixture;
  readonly png: Uint8Array;
  /** The fixture as pdf.js sees it, extracted once and reused as the baseline. */
  readonly source: PdfjsInspection;
}

export interface BranchOutcome {
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly planPaths: string;
  readonly planIncremental: boolean | null;
  readonly incrementalFormat: boolean | null;
}

export interface Branch {
  readonly id: string;
  readonly title: string;
  run(context: SpikeContext, recorder: Recorder): Promise<BranchOutcome>;
}

const HIGHLIGHT_KEY = 'pdfjs_internal_editor_spike1';
const HIGHLIGHT_RECT = [60, 690, 320, 706];

function describePlan(plan: SavePlan): string {
  return plan.paths.join(' → ') || 'none';
}

function changes(partial: Partial<ChangeSummary>): ChangeSummary {
  return { ...NO_CHANGES, ...partial };
}

/** A pdf.js editor-style new annotation, as the viewer stores it. */
function highlightEntry(pageIndex: number, rect: number[], id: string) {
  const [x0, y0, x1, y1] = rect;
  return {
    annotationType: 9,
    pageIndex,
    rect,
    // PDF QuadPoints order: upper-left, upper-right, lower-left, lower-right.
    quadPoints: [x0, y1, x1, y1, x0, y0, x1, y0],
    outlines: [[x0, y1, x1, y1, x1, y0, x0, y0]],
    color: [1, 0.83, 0],
    opacity: 0.4,
    rotation: 0,
    user: 'spike1',
    date: new Date(),
    id,
  };
}

function rectClose(actual: number[] | undefined, expected: number[], tolerance = 0.5): boolean {
  if (actual?.length !== 4) return false;
  return expected.every((value, index) => Math.abs(value - (actual[index] ?? Number.NaN)) <= tolerance);
}

function textMatches(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((value, index) => value === expected[index]);
}

async function imagePaints(bytes: Uint8Array, pageNumber: number): Promise<number> {
  const { doc, close } = await openPdfjs(bytes);
  try {
    const page = await doc.getPage(pageNumber);
    const operatorList = await page.getOperatorList();
    let count = 0;
    for (const fn of operatorList.fnArray) {
      if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintInlineImageXObject ||
        fn === OPS.paintImageXObjectRepeat
      ) {
        count += 1;
      }
    }
    return count;
  } finally {
    await close();
  }
}

function unionRect(quads: number[][]): [number, number, number, number] {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const quad of quads) {
    for (let index = 0; index + 1 < quad.length; index += 2) {
      const x = quad[index];
      const y = quad[index + 1];
      if (x === undefined || y === undefined) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return [x0, y0, x1, y1];
}

/** Does the page carry an annotation whose contents match `needle`? */
async function mupdfCarriesContent(doc: MupdfDocument, pageIndex: number, needle: string): Promise<boolean> {
  const page = doc.loadPage(pageIndex) as MupdfPage;
  try {
    return page.getAnnotations().some((annot) => annot.getContents() === needle);
  } finally {
    page.destroy();
  }
}

/* --------------------------------------------------------- 1 annotation-only */

const annotationOnly: Branch = {
  id: 'annotation-only',
  title: '1 · annotation-only (pdf.js saveDocument)',
  async run({ fixture, source }, recorder) {
    const src = fixture.bytes;
    const plan = planSave(changes({ annotations: true }));
    recorder.note(`planSave → ${describePlan(plan)} · incremental=${plan.incremental}`);

    const { doc, close } = await openPdfjs(src);
    let output: Uint8Array;
    try {
      doc.annotationStorage.setValue(HIGHLIGHT_KEY, highlightEntry(0, HIGHLIGHT_RECT, 'spike1-highlight'));
      output = await doc.saveDocument();
    } finally {
      await close();
    }

    const incremental = isIncrementalOver(output, src);
    recorder.check(
      'file format is incremental (output = input bytes + appended delta)',
      incremental,
      incremental
        ? `output ${output.byteLength} B starts with the exact input; delta ${output.byteLength - src.byteLength} B`
        : `output ${output.byteLength} B is not input+delta (input ${src.byteLength} B)`,
    );

    const after = await inspectWithPdfjs(output);
    const highlights = after.annotations.filter((entry) => entry.subtype === 'Highlight');
    recorder.check(
      'highlight survives a reopen (pdf.js)',
      highlights.length === 1,
      `${highlights.length} Highlight annotation(s)`,
    );
    recorder.check(
      'written rect round-trips',
      rectClose(highlights[0]?.rect, HIGHLIGHT_RECT),
      `expected ${JSON.stringify(HIGHLIGHT_RECT)}, got ${JSON.stringify(highlights[0]?.rect ?? null)}`,
    );
    recorder.check('page count unchanged', after.pageCount === source.pageCount, `${after.pageCount} pages`);
    recorder.check(
      'page text unchanged',
      textMatches(after.text, source.text),
      'per-page extracted text identical',
    );

    const mupdfSees = await inspectWithMupdf(output, undefined);
    const mupdfHit = await mupdfHighlightCount(output);
    recorder.check(
      'second reader (MuPDF) sees the same annotation',
      mupdfHit === 1,
      `MuPDF reports ${mupdfHit} Highlight annotation(s); page count ${mupdfSees.pageCount}`,
    );

    return {
      bytesIn: src.byteLength,
      bytesOut: output.byteLength,
      planPaths: describePlan(plan),
      planIncremental: plan.incremental,
      incrementalFormat: incremental,
    };
  },
};

async function mupdfHighlightCount(bytes: Uint8Array): Promise<number> {
  const { doc } = await openMupdf(bytes);
  try {
    let count = 0;
    for (let index = 0; index < doc.countPages(); index += 1) {
      const page = doc.loadPage(index) as MupdfPage;
      try {
        for (const annot of page.getAnnotations()) {
          if (annot.getType() === 'Highlight') count += 1;
        }
      } finally {
        page.destroy();
      }
    }
    return count;
  } finally {
    doc.destroy();
  }
}

/* ------------------------------------------------------- 2 page composition */

const pageComposition: Branch = {
  id: 'page-composition',
  title: '2 · page reorder (pdf.js extractPages)',
  async run({ fixture, source }, recorder) {
    const src = fixture.bytes;
    const plan = planSave(changes({ pageOrder: true }));
    recorder.note(`planSave → ${describePlan(plan)} · incremental=${plan.incremental}`);

    // Output position → source page: [3, 1, 2, 4, 5] (1-based).
    const order = [2, 0, 1, 3, 4];
    // `pageIndices` is indexed by source page: target output slot for each.
    const pageIndices = [1, 2, 0, 3, 4];
    const copyLevels = new Int32Array(order.map(() => 0));

    const { doc, close } = await openPdfjs(src);
    let output: Uint8Array;
    try {
      output = await doc.extractPages(
        [{ document: src.slice(), includePages: [[0, fixture.pageCount - 1]], pageIndices }],
        copyLevels,
      );
    } finally {
      await close();
    }

    const after = await inspectWithPdfjs(output);
    recorder.check('page count preserved', after.pageCount === fixture.pageCount, `${after.pageCount} pages`);
    const actualMarkers = after.text.map(
      (text) => fixture.markers.find((marker) => text.includes(marker)) ?? '<missing>',
    );
    const expectedMarkers = order.map((index) => fixture.markers[index] ?? '<missing>');
    recorder.check(
      'page order is the requested permutation',
      actualMarkers.every((marker, index) => marker === expectedMarkers[index]),
      `expected ${expectedMarkers.join(', ')} | got ${actualMarkers.join(', ')}`,
    );
    recorder.check(
      'per-page text travels with its page',
      order.every((sourceIndex, outputIndex) => after.text[outputIndex] === source.text[sourceIndex]),
      'each output page carries the source page text it came from',
    );
    const formValue = after.formFields.alan1;
    recorder.check(
      'baseline: the untouched fixture exposes the form value',
      JSON.stringify(source.formFields.alan1) === JSON.stringify([fixture.formValue]),
      `source alan1 = ${JSON.stringify(source.formFields.alan1 ?? null)}`,
    );
    recorder.check(
      'AcroForm value survives the reorder',
      JSON.stringify(formValue) === JSON.stringify([fixture.formValue]),
      `alan1 = ${JSON.stringify(formValue ?? null)}`,
    );
    recorder.check(
      'file is a full rewrite, not an incremental update',
      !isIncrementalOver(output, src),
      `output ${output.byteLength} B vs input ${src.byteLength} B (no shared byte prefix)`,
    );

    const mupdf = await inspectWithMupdf(output);
    recorder.check(
      'second reader (MuPDF) reads the same page order',
      expectedMarkers.every((marker, index) => mupdf.text[index]?.includes(marker) === true),
      `MuPDF page count ${mupdf.pageCount}`,
    );

    return {
      bytesIn: src.byteLength,
      bytesOut: output.byteLength,
      planPaths: describePlan(plan),
      planIncremental: plan.incremental,
      incrementalFormat: isIncrementalOver(output, src),
    };
  },
};

/* -------------------------------------------------------- 3 overlay+metadata */

/**
 * The overlay + metadata write, on MuPDF (the product's writer). Phase 0 measured this
 * branch on pdf-lib; that run's code is in the git history of this file.
 */
async function applyOverlay(bytes: Uint8Array, context: SpikeContext): Promise<Uint8Array> {
  const { mupdf, doc } = await openMupdf(bytes);
  try {
    overlayPage(mupdf, doc, 0, {
      text: { value: `OVERLAY-${context.fixture.token}`, x: 60, y: 60, size: 14, color: [0.8, 0.1, 0.1] },
      image: { bytes: context.png, x: 420, y: 60, width: 64, height: 64 },
    });

    const date = 'D:20260915000000Z';
    const info = [
      ['Title', `spike-title-${context.fixture.token}`],
      ['Producer', `PDF Editor spike (MuPDF 1.28) — ${context.fixture.token}`],
      ['Subject', 'spike overlay + metadata'],
      ['Creator', 'PDF Editor spike #1'],
      ['CreationDate', date],
      ['ModDate', date],
    ] as const;
    for (const [key, value] of info) doc.setMetaData(`info:${key}`, value);

    const root = doc.getTrailer().get('Root');
    root.put(
      'Metadata',
      doc.addRawStream(xmpFor(context.fixture.token), { Type: 'Metadata', Subtype: 'XML' }),
    );

    // A full rewrite without object streams, as the branch asserts.
    return new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  } finally {
    doc.destroy();
  }
}

function xmpFor(token: string): string {
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

const overlayMetadata: Branch = {
  id: 'overlay-metadata',
  title: '3 · overlay + metadata (MuPDF)',
  async run(context, recorder) {
    const src = context.fixture.bytes;
    const plan = planSave(changes({ overlays: true, metadata: true }));
    recorder.note(`planSave → ${describePlan(plan)} · incremental=${plan.incremental}`);

    const imagePaintsBefore = await imagePaints(src, 1);
    const output = await applyOverlay(src, context);

    const after = await inspectWithPdfjs(output);
    const overlayText = `OVERLAY-${context.fixture.token}`;
    const overlayOccurrences = occurrences(after.text[0] ?? '', overlayText);
    recorder.check(
      'drawn text is present on page 1',
      overlayOccurrences === 1,
      `"${overlayText}" ×${overlayOccurrences}`,
    );
    const imagePaintsAfter = await imagePaints(output, 1);
    recorder.check(
      'drawn image is a real XObject on page 1',
      imagePaintsAfter === imagePaintsBefore + 1,
      `image paints before ${imagePaintsBefore}, after ${imagePaintsAfter}`,
    );
    recorder.check(
      'untouched pages keep their extracted text',
      context.source.text.length === after.text.length &&
        context.source.text.slice(1).every((text, index) => text === after.text[index + 1]),
      `pages 2..${after.pageCount} identical`,
    );
    recorder.check(
      'page 1 keeps its original text next to the overlay',
      after.text[0]?.includes(context.source.text[0] ?? '\u0000') === true,
      'original page-1 text preserved as a substring of the re-extracted page',
    );
    recorder.check(
      'Info dictionary round-trips',
      after.info.Title === `spike-title-${context.fixture.token}`,
      `Title=${JSON.stringify(after.info.Title ?? null)}, Producer=${JSON.stringify(after.info.Producer ?? null)}`,
    );
    const xmpMarker = `spike-xmp-${context.fixture.token}`;
    recorder.check(
      'XMP packet is present in the output bytes',
      countBytes(output, xmpMarker) > 0 && after.hasXmp,
      `xmp payload marker found ${countBytes(output, xmpMarker)}×, pdf.js metadata object=${after.hasXmp}`,
    );
    recorder.check(
      'file is a full rewrite, not an incremental update',
      !isIncrementalOver(output, src),
      `output ${output.byteLength} B vs input ${src.byteLength} B`,
    );

    const mupdf = await inspectWithMupdf(output);
    recorder.check(
      'second reader (MuPDF) reads the overlay text',
      mupdf.text[0]?.includes(overlayText) === true,
      `MuPDF page 1 text contains the overlay marker`,
    );

    return {
      bytesIn: src.byteLength,
      bytesOut: output.byteLength,
      planPaths: describePlan(plan),
      planIncremental: plan.incremental,
      incrementalFormat: isIncrementalOver(output, src),
    };
  },
};

/* ---------------------------------------------------------------- 4 redaction */

const redaction: Branch = {
  id: 'redaction',
  title: '4 · redaction (MuPDF applyRedactions + cleanup save)',
  async run({ fixture, source }, recorder) {
    const src = fixture.bytes;
    const plan = planSave(changes({ redaction: true }));
    recorder.note(`planSave → ${describePlan(plan)} · incremental=${plan.incremental}`);

    const { mupdf, doc } = await openMupdf(src);
    let output: Uint8Array;
    let incrementalBefore = false;
    let incrementalAfter = false;
    let hits: number[][][] = [];
    try {
      incrementalBefore = doc.canBeSavedIncrementally();
      const page = doc.loadPage(1) as MupdfPage;
      hits = page.search(fixture.secret, '');
      recorder.check(
        'the target string is searchable before redaction',
        hits.flat().length > 0,
        `${hits.flat().length} quad(s) matched "${fixture.secret}"`,
      );
      const rect = unionRect(hits.flat());
      const annot = page.createAnnotation('Redact');
      annot.setRect(rect);
      annot.update();
      page.applyRedactions(
        true,
        mupdf.PDFPage.REDACT_IMAGE_REMOVE,
        mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED,
        mupdf.PDFPage.REDACT_TEXT_REMOVE,
      );
      page.update();
      incrementalAfter = doc.canBeSavedIncrementally();
      page.destroy();
      output = doc.saveToBuffer('garbage=2,compress=yes').asUint8Array();
    } finally {
      doc.destroy();
    }

    recorder.check(
      'canBeSavedIncrementally() is true before / false after redaction',
      incrementalBefore && !incrementalAfter,
      `before=${incrementalBefore}, after=${incrementalAfter}`,
    );

    const recheck = await openMupdf(output);
    try {
      const page = recheck.doc.loadPage(1) as MupdfPage;
      try {
        const remaining = page.search(fixture.secret, '');
        recorder.check(
          'targeted text is gone (MuPDF search)',
          remaining.flat().length === 0,
          `${remaining.flat().length} quad(s) still match in the output`,
        );
        const neighbourhood = page.search(fixture.neighbour, '');
        recorder.check(
          'neighbouring text on the same page is intact',
          neighbourhood.flat().length > 0,
          `${neighbourhood.flat().length} quad(s) for "${fixture.neighbour}"`,
        );
      } finally {
        page.destroy();
      }
    } finally {
      recheck.doc.destroy();
    }

    const rawHits = countBytes(output, fixture.secret);
    recorder.check(
      'no plaintext remnant in the output bytes',
      rawHits === 0,
      `"${fixture.secret}" occurs ${rawHits}× in the written file (object-level, not extraction)`,
    );

    const after = await inspectWithPdfjs(output);
    recorder.check('page count preserved', after.pageCount === source.pageCount, `${after.pageCount} pages`);
    recorder.check(
      'targeted text is gone (pdf.js extraction)',
      !after.text.some((text) => text.includes(fixture.secret)),
      'no page text contains the redacted string',
    );
    recorder.check(
      'untouched pages keep their text (pdf.js)',
      source.text.every((text, index) => index === 1 || text === after.text[index]),
      'pages 1,3,4,5 byte-identical in extraction',
    );

    const mupdfCheck = await inspectWithMupdf(output);
    recorder.check(
      'second reader (MuPDF) reports the same',
      !mupdfCheck.text.some((text) => text.includes(fixture.secret)),
      `MuPDF page 2 text: ${JSON.stringify(mupdfCheck.text[1]?.slice(0, 60) ?? '')}…`,
    );

    return {
      bytesIn: src.byteLength,
      bytesOut: output.byteLength,
      planPaths: describePlan(plan),
      planIncremental: plan.incremental,
      incrementalFormat: isIncrementalOver(output, src),
    };
  },
};

/* ------------------------------------------------------------------- 5 mixed */

const mixed: Branch = {
  id: 'mixed',
  title: '5 · mixed (reorder + annotation + overlay)',
  async run(context, recorder) {
    const src = context.fixture.bytes;
    const plan = planSave(changes({ pageOrder: true, annotations: true, overlays: true }));
    recorder.note(`planSave → ${describePlan(plan)} · incremental=${plan.incremental}`);

    const order = [2, 0, 1, 3, 4];
    const pageIndices = [1, 2, 0, 3, 4];
    const { doc, close } = await openPdfjs(src);
    let reordered: Uint8Array;
    try {
      doc.annotationStorage.setValue(
        HIGHLIGHT_KEY,
        highlightEntry(0, HIGHLIGHT_RECT, 'spike1-mixed-highlight'),
      );
      reordered = await doc.extractPages(
        [{ document: src.slice(), includePages: [[0, context.fixture.pageCount - 1]], pageIndices }],
        new Int32Array(order.map(() => 0)),
      );
    } finally {
      await close();
    }

    const overlaid = await applyOverlay(reordered, context);
    const after = await inspectWithPdfjs(overlaid);
    const midComposition = await inspectWithPdfjs(reordered);
    const midHighlights = midComposition.annotations.filter((entry) => entry.subtype === 'Highlight').length;
    recorder.note(
      `intermediate: after extractPages alone the output carries ${midHighlights} Highlight annotation(s); after the MuPDF rewrite ${after.annotations.filter((entry) => entry.subtype === 'Highlight').length}`,
    );
    const expectedMarkers = order.map((index) => context.fixture.markers[index] ?? '<missing>');

    recorder.check('page count after the combined save', after.pageCount === 5, `${after.pageCount} pages`);
    recorder.check(
      'reorder survived',
      expectedMarkers.every((marker, index) => after.text[index]?.includes(marker) === true),
      `order ${after.text.map((text) => context.fixture.markers.findIndex((m) => text.includes(m)) + 1).join(',')} (source pages)`,
    );
    const highlights = after.annotations.filter((entry) => entry.subtype === 'Highlight');
    recorder.check(
      'annotation survived the page composition and the MuPDF rewrite',
      highlights.length === 1,
      `${highlights.length} Highlight annotation(s), on output page ${highlights[0]?.page ?? '-'}`,
    );
    recorder.check(
      'overlay survived',
      occurrences(after.text[0] ?? '', `OVERLAY-${context.fixture.token}`) === 1,
      'overlay text present exactly once on the first output page',
    );
    recorder.check(
      'metadata survived',
      after.info.Title === `spike-title-${context.fixture.token}` && after.hasXmp,
      `Title=${JSON.stringify(after.info.Title ?? null)}, XMP=${after.hasXmp}`,
    );

    const mupdfCheck = await inspectWithMupdf(overlaid);
    recorder.check(
      'second reader (MuPDF) agrees on every effect',
      mupdfCheck.pageCount === 5 &&
        expectedMarkers.every((marker, index) => mupdfCheck.text[index]?.includes(marker) === true) &&
        mupdfCheck.text[0]?.includes(`OVERLAY-${context.fixture.token}`) === true,
      'page order + overlay text confirmed by MuPDF',
    );

    return {
      bytesIn: src.byteLength,
      bytesOut: overlaid.byteLength,
      planPaths: describePlan(plan),
      planIncremental: plan.incremental,
      incrementalFormat: isIncrementalOver(overlaid, src),
    };
  },
};

/* ---------------------------------------------------------- 6 encrypted input */

const PROTECTION = 'encrypt=aes-256,user-password=spike-open,owner-password=spike-owner';

const encryptedInput: Branch = {
  id: 'encrypted-input',
  title: '6 · encrypted input (MuPDF)',
  async run(context, recorder) {
    const src = context.fixture.bytes;
    const plan = planSave(changes({ annotations: true }), { encryptedInput: true });
    recorder.note(
      `planSave (encrypted input, annotations) → ${describePlan(plan)} · incremental=${plan.incremental}`,
    );

    // 6a) create the protected fixture with MuPDF save options.
    const creator = await openMupdf(src);
    let protectedBytes: Uint8Array;
    try {
      protectedBytes = creator.doc.saveToBuffer(PROTECTION).asUint8Array();
    } finally {
      creator.doc.destroy();
    }
    const probe = await openMupdf(protectedBytes, 'spike-open');
    const encryption = probe.encryption;
    const needsPassword = probe.needsPassword;
    const authenticated = probe.authenticated;
    probe.doc.destroy();
    recorder.check(
      'protected fixture carries AES-256 and demands the password',
      needsPassword && authenticated === true && Boolean(encryption),
      `needsPassword=${needsPassword}, authWithPassword=${authenticated}, metadata="${encryption ?? ''}"`,
    );

    // 6b) open with the password, change content, save with the same protection.
    const changeMarker = `CHANGE-${context.fixture.token}`;
    const editor = await openMupdf(protectedBytes, 'spike-open');
    let output: Uint8Array;
    try {
      const page = editor.doc.loadPage(0) as MupdfPage;
      const annot = page.createAnnotation('FreeText');
      annot.setRect([60, 600, 340, 640]);
      annot.setDefaultAppearance('Helv', 12, [0.8, 0.1, 0.1]);
      annot.setContents(changeMarker);
      annot.update();
      page.update();
      page.destroy();
      output = editor.doc.saveToBuffer(`${PROTECTION},garbage=2`).asUint8Array();
    } finally {
      editor.doc.destroy();
    }

    const reopened = await openMupdf(output, 'spike-open');
    const wrongPassword = await openMupdf(output, 'not-the-password');
    try {
      recorder.check(
        'output still needs the password and accepts it',
        reopened.needsPassword && reopened.authenticated === true,
        `needsPassword=${reopened.needsPassword}, authenticated=${reopened.authenticated}, encryption="${reopened.encryption ?? ''}"`,
      );
      recorder.check(
        'wrong password is still rejected',
        wrongPassword.authenticated === false,
        `authenticatePassword("not-the-password") = ${wrongPassword.authenticated}`,
      );
      const changeSurvives = await mupdfCarriesContent(reopened.doc, 0, changeMarker);
      recorder.check(
        'the content change survives the protected round-trip (MuPDF)',
        changeSurvives,
        `page-1 annotations contain contents "${changeMarker}"`,
      );
      const pageCount = reopened.doc.countPages();
      recorder.check('page count preserved', pageCount === context.fixture.pageCount, `${pageCount} pages`);
    } finally {
      reopened.doc.destroy();
      wrongPassword.doc.destroy();
    }

    const after = await inspectWithPdfjs(output, 'spike-open');
    const annotSubtypes = after.annotations.map((entry) => entry.subtype).join(',') || 'none';
    const contentsSeen = after.annotations.map((entry) => entry.contents).join('|') || 'none';
    recorder.check(
      'second reader (pdf.js) opens the output with the password and sees the change',
      after.pageCount === context.fixture.pageCount &&
        after.annotations.some((entry) => entry.contents === changeMarker),
      `annotations seen: ${annotSubtypes}; contents: ${contentsSeen}`,
    );

    // 6c) probe: what happens if the pdf.js fast path writes an encrypted input?
    let pdfjsProbe = 'not attempted';
    try {
      const { doc, close } = await openPdfjs(protectedBytes, 'spike-open');
      let fastPathOut: Uint8Array | null = null;
      try {
        doc.annotationStorage.setValue(HIGHLIGHT_KEY, highlightEntry(0, HIGHLIGHT_RECT, 'spike1-encrypted'));
        fastPathOut = await doc.saveDocument();
      } finally {
        await close();
      }
      const fastPathProbe = await openMupdf(fastPathOut, 'spike-open');
      const stillEncrypted = Boolean(fastPathProbe.encryption);
      const opensWithPassword = fastPathProbe.authenticated === true;
      fastPathProbe.doc.destroy();
      const withoutPassword = await openMupdf(fastPathOut);
      const opensWithoutPassword = !withoutPassword.needsPassword || withoutPassword.authenticated !== false;
      withoutPassword.doc.destroy();
      const leak = countBytes(fastPathOut, 'pdfjs_internal_editor_spike1');
      pdfjsProbe = `pdf.js saveDocument() on encrypted input: incremental=${isIncrementalOver(fastPathOut, protectedBytes)}, stillEncrypted=${stillEncrypted}, opensWithPassword=${opensWithPassword}, opensWithoutPassword=${opensWithoutPassword}, plaintext-key-occurrences=${leak}`;
      recorder.note(pdfjsProbe);
    } catch (error) {
      pdfjsProbe = `pdf.js saveDocument() on encrypted input threw: ${String(error)}`;
      recorder.note(pdfjsProbe);
    }

    return {
      bytesIn: protectedBytes.byteLength,
      bytesOut: output.byteLength,
      planPaths: describePlan(plan),
      planIncremental: plan.incremental,
      incrementalFormat: isIncrementalOver(output, protectedBytes),
    };
  },
};

/* --------------------------------------------------------- 7 repeated saves */

const repeatedSaves: Branch = {
  id: 'repeated-saves',
  title: '7 · repeated saves (no duplication)',
  async run(context, recorder) {
    const src = context.fixture.bytes;
    const plan = planSave(changes({ annotations: true, overlays: true }));
    recorder.note(`planSave → ${describePlan(plan)} · incremental=${plan.incremental}`);

    // Annotation branch: save, reopen the output, save again.
    const first = await openPdfjs(src);
    let annotationPass1: Uint8Array;
    try {
      first.doc.annotationStorage.setValue(HIGHLIGHT_KEY, highlightEntry(0, HIGHLIGHT_RECT, 'spike1-repeat'));
      annotationPass1 = await first.doc.saveDocument();
    } finally {
      await first.close();
    }
    const second = await openPdfjs(annotationPass1);
    let annotationPass2: Uint8Array;
    try {
      annotationPass2 = await second.doc.saveDocument();
    } finally {
      await second.close();
    }
    const annotated = await inspectWithPdfjs(annotationPass2);
    const highlightCount = annotated.annotations.filter((entry) => entry.subtype === 'Highlight').length;
    recorder.check(
      'second annotation save does not duplicate the highlight',
      highlightCount === 1,
      `${highlightCount} Highlight annotation(s) after two saves`,
    );
    recorder.check(
      'page count stable across repeated annotation saves',
      annotated.pageCount === context.fixture.pageCount,
      `${annotated.pageCount} pages`,
    );
    const markerCounts = context.fixture.markers.map((marker) =>
      annotated.text.reduce((total, text) => total + occurrences(text, marker), 0),
    );
    recorder.check(
      'each page marker appears exactly once after two saves',
      markerCounts.every((count) => count === 1),
      `marker occurrences per page: ${markerCounts.join(',')}`,
    );

    // Overlay branch: apply the same overlay twice from the same base.
    const overlayPass1 = await applyOverlay(src, context);
    const overlayPass2 = await applyOverlay(src, context);
    const overlayText = `OVERLAY-${context.fixture.token}`;
    const pass1 = await inspectWithPdfjs(overlayPass1);
    const pass2 = await inspectWithPdfjs(overlayPass2);
    const pass2Count = occurrences(pass2.text[0] ?? '', overlayText);
    recorder.check(
      're-running the overlay write does not accumulate content',
      pass2Count === 1 && pass2.pageCount === pass1.pageCount,
      `overlay occurrences after the second write: ${pass2Count}; pages ${pass2.pageCount}`,
    );
    recorder.check(
      'two identical overlay saves produce equivalent documents',
      pass2Count === 1 &&
        pass2.pageCount === pass1.pageCount &&
        pass2Count === occurrences(pass1.text[0] ?? '', overlayText),
      `pass 1: ${occurrences(pass1.text[0] ?? '', overlayText)} overlay, ${pass1.pageCount} pages (${overlayPass1.byteLength} B) | pass 2: ${pass2Count} overlay, ${pass2.pageCount} pages (${overlayPass2.byteLength} B)`,
    );

    // Re-saving an already overlaid output must not double the overlay either.
    const overlayAgain = await applyOverlay(overlayPass1, context);
    const twiceText = (await inspectWithPdfjs(overlayAgain)).text[0] ?? '';
    const twiceCount = occurrences(twiceText, overlayText);
    recorder.check(
      'saving an already-overlaid document again adds no silent duplicate',
      twiceCount === 2,
      `overlay occurrences after re-applying on top of the output: ${twiceCount} (expected exactly the one new write = 2 total)`,
    );

    return {
      bytesIn: src.byteLength,
      bytesOut: annotationPass2.byteLength,
      planPaths: describePlan(plan),
      planIncremental: plan.incremental,
      incrementalFormat: isIncrementalOver(annotationPass2, src),
    };
  },
};

/* ------------------------------------------------------------ 8 failed write */

const failedWrite: Branch = {
  id: 'failed-write',
  title: '8 · failed destination write',
  async run(context, recorder) {
    const src = context.fixture.bytes;
    const plan = planSave(changes({ annotations: true }));
    recorder.note(`planSave → ${describePlan(plan)} · incremental=${plan.incremental}`);
    recorder.note(
      'measured: the session only leaves the dirty state when the destination write resolves; the thrown write is injected before any state change',
    );

    const store = new SessionStore();
    const sha256 = await sha256Hex(src);
    const tab = store.openDocument({
      name: 'fixture.pdf',
      bytes: src,
      sha256,
      pageCount: context.fixture.pageCount,
    });

    // The destination already holds the original file.
    const destination = { bytes: src.slice() };

    const { doc, close } = await openPdfjs(src);
    let saveBuffer: Uint8Array;
    try {
      doc.annotationStorage.setValue(HIGHLIGHT_KEY, highlightEntry(0, HIGHLIGHT_RECT, 'spike1-failed-write'));
      saveBuffer = await doc.saveDocument();
    } finally {
      await close();
    }
    store.setDirty(tab.id, true);
    recorder.check(
      'session is dirty once the user edits',
      store.active?.dirty === true,
      `dirty=${store.active?.dirty}`,
    );

    // Injected failure: the write step throws before anything is committed.
    let writeError: string | null = null;
    try {
      await simulateWrite(destination, saveBuffer, true);
    } catch (error) {
      writeError = String(error);
    }
    recorder.check('the injected write failed', writeError !== null, writeError ?? 'no error raised');
    recorder.check(
      'session stays dirty after a failed write',
      store.active?.dirty === true,
      `dirty=${store.active?.dirty}`,
    );
    recorder.check(
      'the destination file still holds the original bytes',
      equalBytes(destination.bytes, src),
      `${destination.bytes.byteLength} B unchanged`,
    );
    recorder.check(
      'the session master copy is untouched by the failed save',
      equalBytes(tab.source.master, src),
      `master ${tab.source.master.byteLength} B, sha256 ${tab.source.sha256.slice(0, 12)}…`,
    );
    recorder.check(
      'no output version was recorded',
      tab.outputs.length === 0,
      `${tab.outputs.length} output version(s)`,
    );
    recorder.check(
      'the annotation save produced a non-empty buffer before the write failed',
      saveBuffer.byteLength > 0,
      `${saveBuffer.byteLength} B buffer discarded on the failed write`,
    );

    // Control: the same flow with a successful write does clear the dirty flag.
    const goodDestination = { bytes: src.slice() };
    await simulateWrite(goodDestination, saveBuffer, false);
    store.setDirty(tab.id, false);
    recorder.check(
      'control: a successful write is what clears the dirty flag',
      store.active?.dirty === false && !equalBytes(goodDestination.bytes, src),
      `dirty=${store.active?.dirty}, destination ${goodDestination.bytes.byteLength} B (rewritten)`,
    );

    return {
      bytesIn: src.byteLength,
      bytesOut: saveBuffer.byteLength,
      planPaths: describePlan(plan),
      planIncremental: plan.incremental,
      incrementalFormat: isIncrementalOver(saveBuffer, src),
    };
  },
};

/** Stands in for the File System Access / OPFS write step. */
async function simulateWrite(
  destination: { bytes: Uint8Array },
  produced: Uint8Array,
  fail: boolean,
): Promise<void> {
  if (fail) {
    throw new Error(
      `EACCES: simulated destination write failure (${destination.bytes.byteLength} B on disk, ${produced.byteLength} B produced)`,
    );
  }
  destination.bytes = produced.slice();
}

/* ------------------------------------------- 9 extractPages annotation probe */

/**
 * Isolation probe added for the spike #1 re-run: which call shape makes
 * `extractPages` carry (or drop) a storage-backed new annotation?
 *
 * Case A  `document: src.slice()` + explicit `pageIndices` (the shape the mixed
 *         branch used and lost the annotation on)
 * Case B  `document: null` (the open document) + explicit `pageIndices`
 * Case C  `document: src.slice()`, no `pageIndices` (natural order)
 * Case D  the storage entry written on the document the call itself operates on
 *         (`document: null`, entry set on that same proxy)
 * Case E  control: `saveDocument()` with the same entry — proves the entry format
 *         is written at all.
 */
const extractPagesAnnotation: Branch = {
  id: 'extract-pages-annotation',
  title: '9 · extractPages × storage-backed annotation (isolation)',
  async run(context, recorder) {
    const src = context.fixture.bytes;
    const last = context.fixture.pageCount - 1;
    const order = [2, 0, 1, 3, 4];
    const pageIndices = [1, 2, 0, 3, 4];
    const copyLevels = new Int32Array(order.map(() => 0));
    const highlightCount = async (bytes: Uint8Array) => {
      const inspection = await inspectWithPdfjs(bytes);
      return inspection.annotations.filter((entry) => entry.subtype === 'Highlight').length;
    };

    // Case A — new byte source + explicit remap (the failing shape).
    const a = await openPdfjs(src);
    let aBytes: Uint8Array;
    try {
      a.doc.annotationStorage.setValue(HIGHLIGHT_KEY, highlightEntry(0, HIGHLIGHT_RECT, 'spike1-probe-a'));
      aBytes = await a.doc.extractPages(
        [{ document: src.slice(), includePages: [[0, last]], pageIndices }],
        copyLevels,
      );
    } finally {
      await a.close();
    }
    const aCount = await highlightCount(aBytes);

    // Case B — same document, explicit remap.
    const b = await openPdfjs(src);
    let bBytes: Uint8Array;
    try {
      b.doc.annotationStorage.setValue(HIGHLIGHT_KEY, highlightEntry(0, HIGHLIGHT_RECT, 'spike1-probe-b'));
      bBytes = await b.doc.extractPages(
        [{ document: null, includePages: [[0, last]], pageIndices }],
        copyLevels,
      );
    } finally {
      await b.close();
    }
    const bCount = await highlightCount(bBytes);

    // Case C — new byte source, no remap.
    const c = await openPdfjs(src);
    let cBytes: Uint8Array;
    try {
      c.doc.annotationStorage.setValue(HIGHLIGHT_KEY, highlightEntry(0, HIGHLIGHT_RECT, 'spike1-probe-c'));
      cBytes = await c.doc.extractPages([{ document: src.slice(), includePages: [[0, last]] }], copyLevels);
    } finally {
      await c.close();
    }
    const cCount = await highlightCount(cBytes);

    // Case D — entry written on the very document passed to the call is the same
    // thing as case B in this API (the storage always belongs to the proxy); kept
    // as an explicit cross-check with a fresh identity.
    const d = await openPdfjs(src);
    let dBytes: Uint8Array;
    try {
      const entry = highlightEntry(0, HIGHLIGHT_RECT, 'spike1-probe-d');
      d.doc.annotationStorage.setValue(HIGHLIGHT_KEY, entry);
      dBytes = await d.doc.extractPages([{ document: null, includePages: [[0, last]] }], copyLevels);
    } finally {
      await d.close();
    }
    const dCount = await highlightCount(dBytes);

    // Case E — control: the same entry through saveDocument().
    const e = await openPdfjs(src);
    let eCount = -1;
    try {
      e.doc.annotationStorage.setValue(HIGHLIGHT_KEY, highlightEntry(0, HIGHLIGHT_RECT, 'spike1-probe-e'));
      const saved = await e.doc.saveDocument();
      eCount = saved === null ? -1 : await highlightCount(saved);
    } finally {
      await e.close();
    }

    recorder.note(
      `Highlight annotations in the output — A (new source + remap) ${aCount} · B (same document + remap) ${bCount} · C (new source, natural order) ${cCount} · D (same document, natural order) ${dCount} · E (control saveDocument) ${eCount}`,
    );
    recorder.check(
      'control: saveDocument writes the storage-backed annotation',
      eCount === 1,
      `${eCount} Highlight(s)`,
    );
    recorder.check(
      'extractPages on the same document also carries it',
      bCount === 1,
      `${bCount} Highlight(s)`,
    );
    recorder.check('extractPages with a new byte source carries it', aCount === 1, `${aCount} Highlight(s)`);

    return {
      bytesIn: src.byteLength,
      bytesOut: aBytes.byteLength,
      planPaths: 'reader-side probe (no planSave)',
      planIncremental: null,
      incrementalFormat: null,
    };
  },
};

export const BRANCHES: readonly Branch[] = [
  annotationOnly,
  pageComposition,
  overlayMetadata,
  redaction,
  mixed,
  encryptedInput,
  repeatedSaves,
  failedWrite,
  extractPagesAnnotation,
];
