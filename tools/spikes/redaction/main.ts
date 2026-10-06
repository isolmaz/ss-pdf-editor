/**
 * Spike #4 — redaction safety at object level (throwaway — `PLAN.md §9/K21`).
 *
 * Every number rendered here comes from this browser run: the fixture is built in
 * memory, MuPDF redacts one occurrence on page 1, and three artifacts are audited
 * — the input (2 revisions), the redacted export, and what a *second* save
 * (`saveToBuffer("incremental")`) produces from the redacted document.
 */
import {
  auditWithPdfjs,
  inspectObjects,
  metadataView,
  type ObjectInventory,
  objectStatus,
  objectTexts,
  type PdfjsAudit,
  type RawScan,
  scanRaw,
  type TokenObject,
  tokenEncodings,
} from './audit';
import { loadMupdf, type Mupdf, openPdf } from './engine';
import { buildFixture, TOKEN } from './fixture';
import { incrementalResave, type RedactAttempt, redactToken, saveWithoutRedaction } from './redact';

const CANONICAL_SAVE_OPTIONS = 'garbage=compact,compress,clean';
const VARIANT_SAVE_OPTIONS = ['compress,garbage=deduplicate,clean', 'compress'] as const;

interface DocAudit {
  readonly bytes: number;
  readonly sha256: string;
  readonly raw: RawScan;
  readonly objects: ObjectInventory;
  readonly metadata: Record<string, string | null>;
  readonly pdfjs: PdfjsAudit;
  readonly pageTextOccurrences: number;
  readonly infoTokenHits: number;
  readonly xmpTokenHits: number;
  readonly attachmentTokenHits: number;
  /** Page 1 (index 0) decoded content stream, for before/after reading. */
  readonly page1StreamText: string;
}

interface VariantResult {
  readonly saveOptions: string;
  readonly bytes: number | null;
  readonly error: string | null;
  readonly rawTokenHits: number | null;
  readonly decodedTokenObjects: string;
}

type RedactAttemptSummary = Omit<RedactAttempt, 'bytes' | 'incrementalProbeOutput'> & {
  readonly outputBytes: number | null;
};

interface ApiCalls {
  readonly search: string;
  readonly annotation: string;
  readonly applyRedactions: string;
  readonly exportSave: string;
  readonly canBeSavedIncrementally: string;
  readonly secondSave: string;
  readonly readerAudit: string;
}

interface RedactionSpikeResult {
  readonly token: string;
  readonly apiCalls: ApiCalls;
  readonly fixture: {
    readonly rev1Bytes: number;
    readonly rev2Bytes: number;
    readonly incrementalSecondSave: {
      readonly canBeSavedIncrementallyBefore: boolean;
      readonly canBeSavedIncrementallyAfter: boolean;
      readonly saveOptions: string;
      readonly bytes: number | null;
      readonly error: string | null;
    };
  };
  readonly redaction: RedactAttemptSummary;
  readonly variants: VariantResult[];
  readonly controlWithoutRedaction: VariantResult;
  readonly input: DocAudit;
  readonly output: DocAudit;
  /** What `saveToBuffer("incremental")` produced *after* redaction. */
  readonly secondSave: DocAudit | { readonly error: string };
  /** The same "save again" path, but starting from the written output. */
  readonly resave: {
    readonly canBeSavedIncrementally: boolean;
    readonly bytes: number | null;
    readonly error: string | null;
    readonly page1Occurrences: number | null;
    readonly tokenObjects: string;
    readonly rawTokenHits: number | null;
    readonly revisionMarkers: string | null;
  };
  readonly page1ContentStreams: {
    readonly inputRefs: number[];
    readonly outputRefs: number[];
    readonly inputText: string;
    readonly outputText: string;
    readonly inputRefsInOutput: Array<{ number: number; status: string }>;
  };
  readonly objectDelta: {
    readonly input: number;
    readonly output: number;
    readonly secondSave: number | null;
  };
  readonly checks: Record<string, boolean>;
  readonly survivingTraces: { readonly output: string[]; readonly secondSave: string[] };
  readonly provesNothingAbout: string[];
  readonly verdict: string;
  readonly elapsedMs: number;
}

/**
 * The spike payload is prompt-local: every spike page declares `__spikeResult`
 * with its own shape, so a global `Window` augmentation would both merge and
 * conflict across siblings. Only these two fields are ever touched.
 */
interface SpikeWindow {
  __spikeResult?: RedactionSpikeResult | { error: string };
  /** Kept for follow-up probing: the exact bytes of all three artifacts. */
  __spikeBytes?: { input: Uint8Array; output: Uint8Array; secondSave: Uint8Array | null };
}

const spikeWindow = window as unknown as SpikeWindow;

function occurrenceCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function auditDocument(mupdf: Mupdf, bytes: Uint8Array): Promise<DocAudit> {
  const doc = openPdf(mupdf, bytes);
  let raw: RawScan;
  let objects: ObjectInventory;
  let metadata: Record<string, string | null>;
  let page1StreamText: string;
  try {
    raw = scanRaw(bytes, documentEncodings());
    objects = inspectObjects(doc, TOKEN);
    metadata = metadataView(doc, mupdf);
    page1StreamText = objectTexts(doc, objects.pageContentRefs[0] ?? [], 240)[0]?.text ?? '<none>';
  } finally {
    doc.destroy();
  }
  const pdfjs = await auditWithPdfjs(bytes, TOKEN);
  return {
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    raw,
    objects,
    metadata,
    pdfjs,
    pageTextOccurrences: pdfjs.totalTextOccurrences,
    infoTokenHits: occurrenceCount(pdfjs.infoJson, TOKEN),
    xmpTokenHits: occurrenceCount(pdfjs.xmpRaw ?? pdfjs.xmpJson, TOKEN),
    attachmentTokenHits: pdfjs.attachments.reduce((total, item) => total + item.occurrences, 0),
    page1StreamText,
  };
}

/** Token byte patterns — one place, so raw and decoded scans agree. */
function documentEncodings() {
  return tokenEncodings(TOKEN);
}

/** Are there page-content objects still carrying the token on this page? */
function pageHasTokenObject(audit: DocAudit, page: number): boolean {
  return audit.objects.tokenObjects.some((object) => object.kind === 'page-content' && object.page === page);
}

/**
 * Objects that carry the token but are **not** reachable as page content, XMP or
 * an attachment: remnants of content the redaction was supposed to remove.
 */
function orphanTokenObjects(audit: DocAudit): TokenObject[] {
  return audit.objects.tokenObjects.filter((object) => object.kind === 'other');
}

function describeTokenObjects(objects: TokenObject[]): string {
  if (objects.length === 0) return '—';
  return objects
    .map(
      (object) => `${object.number}:${object.kind}${object.page ? `(p${object.page})` : ''}×${object.hits}`,
    )
    .join(', ');
}

/** Re-save from the same input with a different cleanup option string. */
function inspectSavedBytes(
  mupdf: Mupdf,
  bytes: Uint8Array | null,
  saveOptions: string,
  error: string | null,
): VariantResult {
  if (!bytes || error) {
    return {
      saveOptions,
      bytes: null,
      error: error ?? 'no bytes produced',
      rawTokenHits: null,
      decodedTokenObjects: '—',
    };
  }
  const doc = openPdf(mupdf, bytes);
  let summary: string;
  try {
    const objects = inspectObjects(doc, TOKEN);
    summary = describeTokenObjects(objects.tokenObjects);
  } finally {
    doc.destroy();
  }
  const hits = scanRaw(bytes, documentEncodings()).hits.total;
  return {
    saveOptions,
    bytes: bytes.byteLength,
    error: null,
    rawTokenHits: hits,
    decodedTokenObjects: summary,
  };
}

function summarize(attempt: RedactAttempt): RedactAttemptSummary {
  const { bytes, incrementalProbeOutput, ...rest } = attempt;
  return { ...rest, outputBytes: bytes ? bytes.byteLength : null };
}

async function run(): Promise<void> {
  const started = performance.now();
  const mupdf = await loadMupdf();
  const fixture = await buildFixture(mupdf);

  const input = await auditDocument(mupdf, fixture.rev2);

  const canonical = await redactToken(mupdf, fixture.rev2, TOKEN, 0, CANONICAL_SAVE_OPTIONS, true, false);
  const variants: VariantResult[] = [];
  for (const options of VARIANT_SAVE_OPTIONS) {
    const attempt = await redactToken(mupdf, fixture.rev2, TOKEN, 0, options, false, false);
    variants.push(inspectSavedBytes(mupdf, attempt.bytes, options, attempt.error));
  }
  const controlSave = saveWithoutRedaction(mupdf, fixture.rev2, CANONICAL_SAVE_OPTIONS);
  const control = inspectSavedBytes(mupdf, controlSave.bytes, CANONICAL_SAVE_OPTIONS, controlSave.error);

  if (!canonical.bytes) throw new Error(`canonical redaction save failed: ${canonical.error}`);
  const outputBytes = canonical.bytes;
  const output = await auditDocument(mupdf, outputBytes);

  // The second save — the one the save router must never use after a redaction.
  const secondSaveBytes = canonical.incrementalProbeOutput;
  const secondSave = secondSaveBytes
    ? await auditDocument(mupdf, secondSaveBytes)
    : { error: canonical.incrementalProbe };

  // The ordinary "save again" path, starting from the *written* output instead.
  const resave = incrementalResave(mupdf, outputBytes, 'PDF Editor Phase 0 spike (MuPDF redaction)');
  const resaveAudit = resave.bytes ? await auditDocument(mupdf, resave.bytes) : null;

  // Fate of the page-1 content stream objects the input used.
  const inputDoc = openPdf(mupdf, fixture.rev2);
  const inputRefs = input.objects.pageContentRefs[0] ?? [];
  inputDoc.destroy();
  const outputDoc = openPdf(mupdf, outputBytes);
  const inputRefsInOutput = objectStatus(outputDoc, inputRefs);
  outputDoc.destroy();

  const tracesFor = (audit: DocAudit): string[] => {
    const traces: string[] = [];
    if (audit.raw.hits.total > 0) traces.push(`raw bytes (${audit.raw.hits.total} hits)`);
    for (const object of audit.objects.tokenObjects) {
      traces.push(
        `${object.kind} object ${object.number}${object.page ? ` (page ${object.page})` : ''} ×${object.hits}`,
      );
    }
    if (audit.objects.infoTokenHits > 0)
      traces.push(`Info dictionary (${audit.objects.infoTokenHits} fields)`);
    if (audit.pageTextOccurrences > 0) {
      traces.push(
        `page text (${audit.pdfjs.pages
          .filter((page) => page.occurrences > 0)
          .map((page) => `p${page.page}×${page.occurrences}`)
          .join(', ')})`,
      );
    }
    if (audit.raw.markers.prev > 0) traces.push(`/Prev chain (${audit.raw.markers.prev})`);
    return traces;
  };

  const survivingTraces = {
    output: tracesFor(output),
    secondSave: 'error' in secondSave ? [`second save failed: ${secondSave.error}`] : tracesFor(secondSave),
  };

  const page1Occurrences = output.pdfjs.pages[0]?.occurrences ?? -1;
  const page2Occurrences = output.pdfjs.pages[1]?.occurrences ?? -1;
  const targetGone = page1Occurrences === 0 && !pageHasTokenObject(output, 1);
  const page2Intact = page2Occurrences === 1 && pageHasTokenObject(output, 2);
  const singleRevision = output.raw.markers.prev === 0 && output.raw.markers.startxref === 1;
  const secondSaveLeaks =
    'error' in secondSave
      ? false
      : (secondSave.pdfjs.pages[0]?.occurrences ?? 0) > 0 ||
        pageHasTokenObject(secondSave, 1) ||
        orphanTokenObjects(secondSave).length > 0;
  const metadataLeak =
    output.objects.infoTokenHits > 0 || output.objects.tokenObjects.some((object) => object.kind === 'xmp');
  const attachmentLeak = output.objects.tokenObjects.some((object) => object.kind === 'attachment');

  const checks = {
    /** The page-1 occurrence is gone from page 1's text *and* its content stream. */
    targetGone,
    /** The page-2 occurrence survived — the redaction did not over-delete. */
    page2Intact,
    /** The export is a single-revision file (no `/Prev`, one `startxref`). */
    singleRevision,
    /** No unreachable ("other") object in the export still holds the token. */
    noOrphanInOutput: orphanTokenObjects(output).length === 0,
    /** A second save *before* the redacted file was written re-publishes the old revision. */
    secondSaveLeaks,
    /** A second save *from the written output* is clean (the eventual product path). */
    resaveFromOutputClean:
      resaveAudit !== null &&
      (resaveAudit.pdfjs.pages[0]?.occurrences ?? 1) === 0 &&
      orphanTokenObjects(resaveAudit).length === 0,
    /** Info dictionary or XMP stream still carries the token. */
    metadataLeak,
    /** The embedded file still carries the token. */
    attachmentLeak,
  };

  const verdict = !targetGone
    ? `FAIL — the page-1 occurrence survived the redaction export (page-1 text hits ${page1Occurrences}, page-1 token object present: ${pageHasTokenObject(output, 1)})`
    : secondSaveLeaks
      ? `DECISION REVISION REQUIRED — the redaction is correct in the written export, but the second save it must never take stays available: saveToBuffer("incremental") succeeds even though canBeSavedIncrementally() already returned false, and the resulting file keeps the pre-redaction revision on a /Prev chain, so the removed page-1 stream is still in the file: ${survivingTraces.secondSave.join(' · ')}. Redaction must force a full rewrite and the incremental path must be closed in the save router.`
      : `PASS for the targeted occurrence (page 1 clean, page 2 preserved=${page2Intact}, single revision=${singleRevision}) — but the exported file still carries the token in ${
          [metadataLeak ? 'Info/XMP metadata' : null, attachmentLeak ? 'the attachment' : null]
            .filter(Boolean)
            .join(' and ') || 'no other place'
        }, so redaction alone is not a complete privacy operation.`;

  const result: RedactionSpikeResult = {
    token: TOKEN,
    apiCalls: {
      search: `page.search(${JSON.stringify(TOKEN)}, {})`,
      annotation: 'page.createAnnotation("Redact") → setRect(quad bbox) → update()',
      applyRedactions: canonical.applyRedactionsArgs,
      exportSave: `doc.saveToBuffer(${JSON.stringify(CANONICAL_SAVE_OPTIONS)})`,
      canBeSavedIncrementally: `before redaction=${canonical.beforeCanBeSavedIncrementally}, after redaction=${canonical.afterCanBeSavedIncrementally}`,
      secondSave: `doc.saveToBuffer("incremental") after redaction → ${canonical.incrementalProbe}`,
      readerAudit: 'pdf.js getDocument + getTextContent + getMetadata + getAttachments',
    },
    fixture: {
      rev1Bytes: fixture.rev1Bytes,
      rev2Bytes: fixture.rev2Bytes,
      incrementalSecondSave: fixture.incremental,
    },
    redaction: summarize(canonical),
    variants,
    controlWithoutRedaction: control,
    input,
    output,
    secondSave,
    resave: {
      canBeSavedIncrementally: resave.canBeSavedIncrementally,
      bytes: resave.bytes ? resave.bytes.byteLength : null,
      error: resave.error,
      page1Occurrences: resaveAudit ? (resaveAudit.pdfjs.pages[0]?.occurrences ?? null) : null,
      tokenObjects: resaveAudit ? describeTokenObjects(resaveAudit.objects.tokenObjects) : '—',
      rawTokenHits: resaveAudit ? resaveAudit.raw.hits.total : null,
      revisionMarkers: resaveAudit
        ? `startxref=${resaveAudit.raw.markers.startxref} /Prev=${resaveAudit.raw.markers.prev}`
        : null,
    },
    page1ContentStreams: {
      inputRefs,
      outputRefs: output.objects.pageContentRefs[0] ?? [],
      inputText: input.page1StreamText,
      outputText: output.page1StreamText,
      inputRefsInOutput,
    },
    objectDelta: {
      input: input.objects.countObjects,
      output: output.objects.countObjects,
      secondSave: 'error' in secondSave ? null : secondSave.objects.countObjects,
    },
    checks,
    survivingTraces,
    provesNothingAbout: [
      'the source file the user opened (the source vault keeps the original bytes)',
      'the operation journal / undo entries and their payloads',
      'rendered thumbnails, page caches, raster/OCR intermediates and worker heaps',
      'search indexes, drafts and autosave blobs written before the export',
      'browser caches (Cache Storage, IndexedDB, HTTP cache) and any downloaded copy of the input',
    ],
    verdict,
    elapsedMs: Math.round(performance.now() - started),
  };

  setText('#phase', `done in ${result.elapsedMs} ms`);
  document.querySelector('#phase')?.setAttribute('data-phase', 'done');
  setText(
    '#summary-text',
    `VERDICT: ${verdict} — page-1 occurrences: input ${input.pdfjs.pages[0]?.occurrences ?? '?'} → output ${page1Occurrences} → second save ${
      'error' in secondSave ? 'n/a' : (secondSave.pdfjs.pages[0]?.occurrences ?? '?')
    }; page-2 kept: ${page2Occurrences}; raw token hits: input ${input.raw.hits.total} → output ${output.raw.hits.total}.`,
  );

  const artifacts: Array<[string, Uint8Array]> = [
    ['input (2 revisions)', fixture.rev2],
    ['output (redacted, full save)', outputBytes],
  ];
  if (secondSaveBytes) artifacts.push(['output (2nd save: incremental)', secondSaveBytes]);
  spikeWindow.__spikeResult = result;
  spikeWindow.__spikeBytes = { input: fixture.rev2, output: outputBytes, secondSave: secondSaveBytes };
  render(result, artifacts);
  document.body.setAttribute('data-spike', 'done');
}

function setText(selector: string, text: string): void {
  const element = document.querySelector(selector);
  if (element) element.textContent = text;
}

function fillTable(selector: string, rows: Array<[string, ...string[]]>, numeric = true): void {
  const body = document.querySelector(`${selector} tbody`);
  if (!body) return;
  body.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr');
    const first = document.createElement('th');
    first.scope = 'row';
    first.textContent = row[0];
    tr.append(first);
    for (const value of row.slice(1)) {
      const td = document.createElement('td');
      td.textContent = value ?? '';
      if (numeric) td.className = 'num';
      tr.append(td);
    }
    body.append(tr);
  }
}

function render(result: RedactionSpikeResult, artifacts: Array<[string, Uint8Array]>): void {
  const { input, output } = result;
  const second = 'error' in result.secondSave ? null : result.secondSave;
  const cell = (audit: DocAudit | null, pick: (audit: DocAudit) => string | number): string =>
    audit ? String(pick(audit)) : 'n/a';
  const occurrences = (audit: DocAudit | null) =>
    audit ? audit.pdfjs.pages.map((page) => `p${page.page}×${page.occurrences}`).join(' ') : 'n/a';

  const auditRows: Array<[string, string, string, string]> = [
    ['bytes', String(input.bytes), String(output.bytes), cell(second, (a) => a.bytes)],
    [
      'sha256 (first 16)',
      input.sha256.slice(0, 16),
      output.sha256.slice(0, 16),
      cell(second, (a) => a.sha256.slice(0, 16)),
    ],
    [
      'pages',
      String(input.objects.pageCount),
      String(output.objects.pageCount),
      cell(second, (a) => a.objects.pageCount),
    ],
    [
      'raw token hits: ASCII/UTF-8',
      String(input.raw.hits.ascii),
      String(output.raw.hits.ascii),
      cell(second, (a) => a.raw.hits.ascii),
    ],
    [
      'raw token hits: PDF hex string',
      String(input.raw.hits.asciiHexUpper + input.raw.hits.asciiHexLower),
      String(output.raw.hits.asciiHexUpper + output.raw.hits.asciiHexLower),
      cell(second, (a) => a.raw.hits.asciiHexUpper + a.raw.hits.asciiHexLower),
    ],
    [
      'raw token hits: UTF-16 raw / hex',
      `${input.raw.hits.utf16be + input.raw.hits.utf16le} / ${input.raw.hits.utf16beHex + input.raw.hits.utf16leHex}`,
      `${output.raw.hits.utf16be + output.raw.hits.utf16le} / ${output.raw.hits.utf16beHex + output.raw.hits.utf16leHex}`,
      cell(
        second,
        (a) =>
          `${a.raw.hits.utf16be + a.raw.hits.utf16le} / ${a.raw.hits.utf16beHex + a.raw.hits.utf16leHex}`,
      ),
    ],
    [
      'raw token hits: TOTAL',
      String(input.raw.hits.total),
      String(output.raw.hits.total),
      cell(second, (a) => a.raw.hits.total),
    ],
    [
      '/Prev',
      String(input.raw.markers.prev),
      String(output.raw.markers.prev),
      cell(second, (a) => a.raw.markers.prev),
    ],
    [
      'startxref / %%EOF / trailer',
      `${input.raw.markers.startxref} / ${input.raw.markers.eof} / ${input.raw.markers.trailer}`,
      `${output.raw.markers.startxref} / ${output.raw.markers.eof} / ${output.raw.markers.trailer}`,
      cell(second, (a) => `${a.raw.markers.startxref} / ${a.raw.markers.eof} / ${a.raw.markers.trailer}`),
    ],
    [
      'countObjects()',
      String(input.objects.countObjects),
      String(output.objects.countObjects),
      cell(second, (a) => a.objects.countObjects),
    ],
    [
      'dicts / streams / freed',
      `${input.objects.dictionaries} / ${input.objects.streams} / ${input.objects.nullObjects}`,
      `${output.objects.dictionaries} / ${output.objects.streams} / ${output.objects.nullObjects}`,
      cell(second, (a) => `${a.objects.dictionaries} / ${a.objects.streams} / ${a.objects.nullObjects}`),
    ],
    [
      'trailer keys',
      input.objects.trailerKeys.join(' '),
      output.objects.trailerKeys.join(' '),
      cell(second, (a) => a.objects.trailerKeys.join(' ')),
    ],
    [
      'page-1 /Contents refs',
      (input.objects.pageContentRefs[0] ?? []).join(', ') || '—',
      (output.objects.pageContentRefs[0] ?? []).join(', ') || '—',
      cell(second, (a) => (a.objects.pageContentRefs[0] ?? []).join(', ') || '—'),
    ],
    [
      'decoded stream bytes searched',
      String(input.objects.decodedStreamBytes),
      String(output.objects.decodedStreamBytes),
      cell(second, (a) => a.objects.decodedStreamBytes),
    ],
    [
      'undecodable streams skipped',
      String(input.objects.undecodableStreams),
      String(output.objects.undecodableStreams),
      cell(second, (a) => a.objects.undecodableStreams),
    ],
    [
      'token-bearing objects (decoded)',
      describeTokenObjects(input.objects.tokenObjects),
      describeTokenObjects(output.objects.tokenObjects),
      cell(second, (a) => describeTokenObjects(a.objects.tokenObjects)),
    ],
    [
      'Info object ref / token fields',
      `${input.objects.infoRef ?? '—'} / ${input.objects.infoTokenHits}`,
      `${output.objects.infoRef ?? '—'} / ${output.objects.infoTokenHits}`,
      cell(second, (a) => `${a.objects.infoRef ?? '—'} / ${a.objects.infoTokenHits}`),
    ],
    [
      'XMP object ref',
      String(input.objects.xmpRef ?? '—'),
      String(output.objects.xmpRef ?? '—'),
      cell(second, (a) => String(a.objects.xmpRef ?? '—')),
    ],
    [
      'pdf.js text token occurrences',
      String(input.pageTextOccurrences),
      String(output.pageTextOccurrences),
      cell(second, (a) => a.pageTextOccurrences),
    ],
    ['pdf.js per page', occurrences(input), occurrences(output), occurrences(second)],
    [
      'pdf.js Info token hits',
      String(input.infoTokenHits),
      String(output.infoTokenHits),
      cell(second, (a) => a.infoTokenHits),
    ],
    [
      'pdf.js XMP token hits',
      String(input.xmpTokenHits),
      String(output.xmpTokenHits),
      cell(second, (a) => a.xmpTokenHits),
    ],
    [
      'attachment token hits',
      String(input.attachmentTokenHits),
      String(output.attachmentTokenHits),
      cell(second, (a) => a.attachmentTokenHits),
    ],
    [
      'MuPDF Info /Title',
      input.metadata.META_INFO_TITLE ?? '—',
      output.metadata.META_INFO_TITLE ?? '—',
      cell(second, (a) => a.metadata.META_INFO_TITLE ?? '—'),
    ],
  ];
  fillTable('#audit', auditRows);

  const callRows: Array<[string, string]> = [
    [
      'fixture: incremental second revision',
      `saveToBuffer("incremental") → ${result.fixture.incrementalSecondSave.bytes ?? 'failed'} bytes (input ${result.fixture.rev1Bytes} → ${result.fixture.rev2Bytes}); canBeSavedIncrementally before/after: ${result.fixture.incrementalSecondSave.canBeSavedIncrementallyBefore}/${result.fixture.incrementalSecondSave.canBeSavedIncrementallyAfter}; error: ${result.fixture.incrementalSecondSave.error ?? 'none'}`,
    ],
    [
      'page.search',
      `${result.apiCalls.search} → ${result.redaction.hitsFound} hit(s) in ${result.redaction.searchCalls} call(s); boxes ${JSON.stringify(result.redaction.boxes)}`,
    ],
    [
      'page.createAnnotation + setRect + update',
      `${result.redaction.annotationsCreated} Redact annotation(s)`,
    ],
    ['applyRedactions', result.redaction.applyRedactionsArgs],
    ['canBeSavedIncrementally', result.apiCalls.canBeSavedIncrementally],
    ['second save', result.apiCalls.secondSave],
    [
      'resave from the written output',
      `reopen output → canBeSavedIncrementally=${result.resave.canBeSavedIncrementally} → set producer line → saveToBuffer("incremental") → ${result.resave.bytes ?? 'failed'} bytes (${result.resave.error ?? 'ok'}); page-1 occurrences ${result.resave.page1Occurrences}; token objects ${result.resave.tokenObjects}; raw hits ${result.resave.rawTokenHits}; ${result.resave.revisionMarkers}`,
    ],
    [
      'export save',
      `saveToBuffer(${JSON.stringify(result.redaction.saveOptions)}) → ${result.redaction.outputBytes} bytes in ${result.redaction.elapsedMs} ms; hasUnsavedChanges after redaction: ${result.redaction.hasUnsavedChanges}`,
    ],
    ['control: save without redaction', controlRow(result.controlWithoutRedaction)],
  ];
  for (const item of result.variants) {
    callRows.push([
      `variant: saveToBuffer(${JSON.stringify(item.saveOptions)}) after redaction`,
      controlRow(item),
    ]);
  }
  fillTable('#calls', callRows);

  const valueRows: Array<[string, string]> = [
    ['verdict', result.verdict],
    [
      'checks',
      Object.entries(result.checks)
        .map(([name, value]) => `${name}=${value}`)
        .join(' · '),
    ],
    [
      'surviving traces — output (full save)',
      result.survivingTraces.output.length === 0 ? 'none' : result.survivingTraces.output.join(' · '),
    ],
    [
      'surviving traces — second save (incremental)',
      result.survivingTraces.secondSave.length === 0 ? 'none' : result.survivingTraces.secondSave.join(' · '),
    ],
    ['page-1 content stream — input', result.page1ContentStreams.inputText],
    ['page-1 content stream — output', result.page1ContentStreams.outputText],
    [
      'page-1 stream refs: input → fate in output',
      `${result.page1ContentStreams.inputRefs.join(', ')} → ${JSON.stringify(result.page1ContentStreams.inputRefsInOutput)} (output page-1 refs: ${result.page1ContentStreams.outputRefs.join(', ') || '—'})`,
    ],
    ['Info (pdf.js, output)', output.pdfjs.infoJson],
    [
      'XMP via pdf.js (output)',
      `raw=${output.pdfjs.xmpRaw === null ? 'null (parser refused the packet)' : `${output.pdfjs.xmpRaw.length} chars`}; parsed=${output.pdfjs.xmpJson}`,
    ],
    [
      'XMP via MuPDF object scan (output)',
      describeTokenObjects(output.objects.tokenObjects.filter((object) => object.kind === 'xmp')) +
        ' — ' +
        (output.objects.tokenObjects.find((object) => object.kind === 'xmp')?.context ?? ''),
    ],
    ['MuPDF metadata view (output)', JSON.stringify(output.metadata)],
    [
      'attachment(s) (output)',
      output.pdfjs.attachments.length === 0 ? 'none' : JSON.stringify(output.pdfjs.attachments),
    ],
    [
      'attachment(s) (input)',
      input.pdfjs.attachments.length === 0 ? 'none' : JSON.stringify(input.pdfjs.attachments),
    ],
    [
      'page-1 stream refs in second save',
      second ? (second.objects.pageContentRefs[0] ?? []).join(', ') || '—' : 'n/a',
    ],
    ['audit proves nothing about', result.provesNothingAbout.join(' · ')],
  ];
  fillTable('#values', valueRows, false);

  const pagesBody = document.querySelector('#pages tbody');
  if (pagesBody) {
    pagesBody.replaceChildren();
    for (const page of output.pdfjs.pages) {
      const row = document.createElement('tr');
      const values = [`p${page.page}`, String(page.occurrences), page.text.slice(0, 200)];
      for (const [index, value] of values.entries()) {
        const cellElement = document.createElement('td');
        cellElement.textContent = value;
        if (index === 1) cellElement.className = page.page === 1 ? 'ok' : '';
        row.append(cellElement);
      }
      pagesBody.append(row);
    }
  }

  const downloads = document.querySelector('#downloads');
  if (downloads) {
    downloads.replaceChildren();
    for (const [label, content] of artifacts) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([content.slice()], { type: 'application/pdf' }));
      link.download = `spike4-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`;
      link.textContent = `${label} — ${content.byteLength} bytes`;
      downloads.append(link);
    }
  }

  setText('#raw', JSON.stringify(result, null, 2));
}

function controlRow(item: VariantResult): string {
  if (item.error) return `error: ${item.error}`;
  return `${item.bytes} bytes; raw token hits ${item.rawTokenHits}; decoded token objects ${item.decodedTokenObjects}`;
}

run().catch((error: unknown) => {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
  setText('#phase', `FAILED: ${message}`);
  document.querySelector('#phase')?.setAttribute('data-phase', 'error');
  spikeWindow.__spikeResult = { error: message };
  document.body.setAttribute('data-spike', 'done');
});
