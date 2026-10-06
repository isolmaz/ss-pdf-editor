/**
 * Save as PDF/A (`architecture.md` §5.9): prepare, convert with Ghostscript, then check what
 * came out before saying anything about it.
 *
 *  1. `prepareForPdfA` removes what the engine would drop or carry over wrongly (forms,
 *     scripts, annotations without the Print flag, unmapped fonts).
 *  2. `convertWithGhostscript` rewrites the file in `-dPDFA=1|2|3` mode with an sRGB output
 *     intent.
 *  3. `checkPdfA` runs the object-model rules on the output. **A file that fails a rule is
 *     never returned**: the operation throws `pdfa-not-compliant`, so the app never offers a
 *     "PDF/A" file that its own checker rejects.
 *  4. The output is read back against the input: same page count, the share of words still
 *     extractable, and a grey render of sampled pages. A difference is reported as a warning,
 *     not hidden.
 *
 * The rule set is a subset of veraPDF's and the report says so (`pdfa.limits`).
 */

import type { PDFDocument } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { convertWithGhostscript } from '../engines/ghostscript';
import { loadMupdf, mapMupdfError, openPdf } from '../engines/mupdf';
import { checkPdfA, type PdfACheckReport, type PdfAPart, summariseViolations } from './pdfa-check';
import { annotationCounts, comparePage, pageWords, samplePageIndices, wordRecall } from './pdfa-compare';
import { type PrepareCounters, prepareForPdfA } from './pdfa-prepare';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

export interface PdfAOptions {
  readonly part: PdfAPart;
}

/** What the read-back measured, as numbers (the notes are made from these). */
export interface PdfAMeasures {
  /** Zero-based pages that were compared (picture) and read (text). */
  readonly picturePages: readonly number[];
  readonly textPages: readonly number[];
  /** Words of the source found again in the output, 0 to 1; `null` when the sample has no text. */
  readonly wordRecall: number | null;
  /** Largest mean grey difference of a compared page, 0 to 1. */
  readonly pictureMean: number;
  /** Largest 16 × 16 block difference of a compared page, 0 to 1. */
  readonly pictureWorstBlock: number;
  /** Zero-based pages whose picture differs more than the tolerance. */
  readonly pictureDiffers: readonly number[];
  /** Zero-based pages whose text recall fell under the tolerance. */
  readonly textDiffers: readonly number[];
}

export interface PdfAConversion extends OperationOutcome {
  /** The checker's report on the produced file (it passed, or the call would have thrown). */
  readonly check: PdfACheckReport;
  /** The checker's report on the input. */
  readonly source: PdfACheckReport;
  readonly measures: PdfAMeasures;
  /** `false` when the input already met the part and was returned as it was. */
  readonly converted: boolean;
}

/** Pages read for text and rendered for the picture comparison (the largest files stay quick). */
const TEXT_SAMPLE = 12;
const PICTURE_SAMPLE = 6;
/** A page needs this many source words before its text recall means anything. */
const MIN_WORDS = 5;
/** Under this share of words found again, a page's text is reported as lost. */
const RECALL_TOLERANCE = 0.9;
/** A page whose grey picture differs more than this (mean) or in one block is reported. */
const MEAN_TOLERANCE = 0.05;
const BLOCK_TOLERANCE = 0.5;

export function pdfaLevel(part: PdfAPart): string {
  return `PDF/A-${part}b`;
}

type Feature = 'tags' | 'outlines' | 'labels' | 'layers';

/** Catalog features a rewrite can lose (`tags` is the one Ghostscript does). */
function catalogFeatures(doc: PDFDocument): ReadonlySet<Feature> {
  const root = doc.getTrailer().get('Root');
  const found = new Set<Feature>();
  if (!root.get('StructTreeRoot').isNull()) found.add('tags');
  if (!root.get('Outlines').isNull()) found.add('outlines');
  if (!root.get('PageLabels').isNull()) found.add('labels');
  if (!root.get('OCProperties').isNull()) found.add('layers');
  return found;
}

const FEATURE_NOTES = {
  tags: 'op.note.pdfa.lost.tags',
  outlines: 'op.note.pdfa.lost.outlines',
  labels: 'op.note.pdfa.lost.labels',
  layers: 'op.note.pdfa.lost.layers',
} as const;

function pageList(indices: readonly number[]): string {
  return indices.map((index) => index + 1).join(', ');
}

function percent(value: number): string {
  return `${Math.round(value * 100)} %`;
}

/** The read-back: page text and a grey render of sampled pages, source against output. */
async function measure(
  mupdf: Awaited<ReturnType<typeof loadMupdf>>,
  source: PDFDocument,
  pictureBase: PDFDocument,
  output: PDFDocument,
  context: OperationContext,
): Promise<PdfAMeasures> {
  const count = source.countPages();
  const textPages = samplePageIndices(count, TEXT_SAMPLE);
  let wordsTotal = 0;
  let wordsFound = 0;
  const textDiffers: number[] = [];
  for (const index of textPages) {
    throwIfAborted(context.signal);
    const before = pageWords(source, index);
    if (before.length < MIN_WORDS) continue;
    const recall = wordRecall(before, pageWords(output, index));
    if (recall === null) continue;
    wordsTotal += before.length;
    wordsFound += recall * before.length;
    if (recall < RECALL_TOLERANCE) textDiffers.push(index);
  }
  const picturePages = samplePageIndices(count, PICTURE_SAMPLE);
  let pictureMean = 0;
  let pictureWorstBlock = 0;
  const pictureDiffers: number[] = [];
  for (const index of picturePages) {
    throwIfAborted(context.signal);
    const result = comparePage(mupdf, pictureBase, output, index);
    pictureMean = Math.max(pictureMean, result.mean);
    pictureWorstBlock = Math.max(pictureWorstBlock, result.worstBlock);
    if (result.shapeDiffers || result.mean > MEAN_TOLERANCE || result.worstBlock > BLOCK_TOLERANCE) {
      pictureDiffers.push(index);
    }
  }
  return {
    picturePages,
    textPages,
    wordRecall: wordsTotal === 0 ? null : wordsFound / wordsTotal,
    pictureMean,
    pictureWorstBlock,
    pictureDiffers,
    textDiffers,
  };
}

function preparationNotes(counters: PrepareCounters, part: PdfAPart): OperationNote[] {
  const notes: OperationNote[] = [];
  if (counters.formFieldsFlattened > 0) {
    notes.push(note('lost', 'op.note.pdfa.formsFlattened', { count: counters.formFieldsFlattened }));
  }
  if (counters.widgetsRemoved > 0) {
    notes.push(note('lost', 'op.note.pdfa.widgetsRemoved', { count: counters.widgetsRemoved }));
  }
  if (counters.signaturesInvalidated > 0) {
    notes.push(note('lost', 'op.note.pdfa.signatures', { count: counters.signaturesInvalidated }));
  }
  if (counters.actionsRemoved > 0) {
    notes.push(note('lost', 'op.note.pdfa.actionsRemoved', { count: counters.actionsRemoved }));
  }
  if (counters.attachmentsRemoved.length > 0) {
    notes.push(
      note('lost', 'op.note.pdfa.attachmentsRemoved', {
        count: counters.attachmentsRemoved.length,
        names: counters.attachmentsRemoved.slice(0, 5).join(', '),
        level: pdfaLevel(part),
      }),
    );
  }
  if (counters.attachmentsKept > 0) {
    notes.push(note('preserved', 'op.note.pdfa.attachmentsKept', { count: counters.attachmentsKept }));
  }
  let removed = 0;
  const kinds: string[] = [];
  for (const [subtype, count] of counters.annotationsRemoved) {
    removed += count;
    kinds.push(`${subtype} ×${count}`);
  }
  if (removed > 0) {
    notes.push(note('lost', 'op.note.pdfa.annotationsRemoved', { count: removed, types: kinds.join(', ') }));
  }
  if (counters.printFlagged > 0) {
    notes.push(note('changed', 'op.note.pdfa.printFlagged', { count: counters.printFlagged }));
  }
  if (counters.appearancesDrawn > 0) {
    notes.push(note('changed', 'op.note.pdfa.appearancesDrawn', { count: counters.appearancesDrawn }));
  }
  if (counters.encryptionRemoved) notes.push(note('changed', 'op.note.pdfa.encryptionRemoved'));
  return notes;
}

function failedCount(report: PdfACheckReport, rule: string): number {
  return report.rules.find((entry) => entry.id === rule)?.count ?? 0;
}

/**
 * Convert `bytes` to PDF/A-`part`b. Throws `pdfa-not-compliant` when the output fails the
 * checker, `pdfa-failed` when the engine produced nothing usable, `encrypted-unsupported` for
 * a file that needs a password.
 */
export async function convertToPdfA(
  bytes: Uint8Array,
  options: PdfAOptions,
  context: OperationContext,
): Promise<PdfAConversion> {
  const { part } = options;
  throwIfAborted(context.signal);
  context.onProgress?.({ phase: 'prepare', labelKey: 'op.progress.pdfa.prepare' });
  const source = await checkPdfA(bytes, {}, context.signal);

  // A file that already meets the part is returned as it is: Ghostscript rewrites everything,
  // and a rewrite of a compliant file can only lose things (signatures, tags). "Meets" is the
  // same test the converted output must pass: no violation and no rule left unchecked (a content
  // stream that cannot be read, a file past the content budget).
  if (
    source.verdict === 'claims-and-meets' &&
    source.targetFromClaim &&
    source.target.part === part &&
    source.violations === 0 &&
    source.unchecked.length === 0
  ) {
    return {
      bytes,
      report: {
        engine: 'mupdf',
        steps: ['pdfa.check'],
        notes: [
          note('preserved', 'op.note.pdfa.alreadyCompliant', { level: pdfaLevel(part) }),
          note('warning', 'op.note.pdfa.limits'),
        ],
        inputBytes: bytes.length,
        outputBytes: bytes.length,
        pageCount: source.pageCount,
        incremental: true,
      },
      check: source,
      source,
      measures: {
        picturePages: [],
        textPages: [],
        wordRecall: null,
        pictureMean: 0,
        pictureWorstBlock: 0,
        pictureDiffers: [],
        textDiffers: [],
      },
      converted: false,
    };
  }

  const prepared = await prepareForPdfA(bytes, part, context);
  throwIfAborted(context.signal);

  context.onProgress?.({ phase: 'convert', labelKey: 'op.progress.pdfa.convert' });
  const run = await convertWithGhostscript(
    // A copy: in a browser the buffer is transferred to the worker and the prepared file is still
    // needed as the baseline of the read-back.
    { input: prepared.bytes.slice(), part, info: prepared.info },
    {
      signal: context.signal,
      onPage: (page, total) =>
        context.onProgress?.({ phase: 'convert', labelKey: 'op.progress.pdfa.convert', done: page, total }),
    },
  );
  if (run.output.length === 0) {
    throw new ToolError('pdfa-failed', {
      engine: 'ghostscript',
      engineMessage: `no output (exit ${run.exitCode}); ${run.warnings.map((warning) => warning.text).join(' | ')}`,
    });
  }
  throwIfAborted(context.signal);

  context.onProgress?.({ phase: 'verify', labelKey: 'op.progress.pdfa.verify' });
  const check = await checkPdfA(run.output, { part }, context.signal);
  if (check.verdict !== 'claims-and-meets' || check.violations > 0 || check.unchecked.length > 0) {
    throw new ToolError('pdfa-not-compliant', {
      engine: 'ghostscript',
      engineMessage: `${check.verdict}: ${summariseViolations(check)}${
        check.unchecked.length > 0 ? ` (not run: ${check.unchecked.join(', ')})` : ''
      }`,
    });
  }

  const mupdf = await loadMupdf();
  let before: PDFDocument | null = null;
  let preparedDoc: PDFDocument | null = null;
  let after: PDFDocument | null = null;
  let measures: PdfAMeasures;
  const notes: OperationNote[] = [];
  let producer: string | null = null;
  try {
    before = openPdf(mupdf, bytes);
    preparedDoc = openPdf(mupdf, prepared.bytes);
    after = openPdf(mupdf, run.output);
    if (after.countPages() !== before.countPages()) {
      throw new ToolError('verification-failed', {
        engine: 'ghostscript',
        engineMessage: `page count ${before.countPages()} became ${after.countPages()}`,
      });
    }
    // The picture baseline is the input itself, so damage done while preparing would show. The
    // exception is a form that was flattened: its fields are drawn into the page now and the
    // input's page content does not have them.
    const flattened = prepared.counters.formFieldsFlattened > 0;
    measures = await measure(mupdf, before, flattened ? preparedDoc : before, after, context);
    const outputAnnotations = annotationCounts(after);
    let dropped = 0;
    const droppedTypes: string[] = [];
    for (const [subtype, count] of annotationCounts(preparedDoc)) {
      const missing = count - (outputAnnotations.get(subtype) ?? 0);
      if (missing <= 0) continue;
      dropped += missing;
      droppedTypes.push(`${subtype} ×${missing}`);
    }
    if (dropped > 0) {
      notes.push(
        note('lost', 'op.note.pdfa.annotationsDropped', { count: dropped, types: droppedTypes.join(', ') }),
      );
    }
    const kept = catalogFeatures(after);
    for (const feature of catalogFeatures(before)) {
      if (!kept.has(feature)) notes.push(note('lost', FEATURE_NOTES[feature]));
    }
    producer = after.getMetaData('info:Producer') ?? null;
  } catch (error) {
    if (error instanceof ToolError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw mapMupdfError(error, 'pdfa verify');
  } finally {
    before?.destroy();
    preparedDoc?.destroy();
    after?.destroy();
  }

  const level = pdfaLevel(part);
  const result: OperationNote[] = [
    note('changed', 'op.note.pdfa.converted', { level }),
    note('changed', 'op.note.pdfa.colour'),
  ];
  const fontFailures = failedCount(source, 'fonts');
  if (fontFailures > 0)
    result.push(note('warning', 'op.note.pdfa.fontsSubstituted', { count: fontFailures }));
  if (part === 1 && failedCount(source, 'transparency') > 0) {
    result.push(note('warning', 'op.note.pdfa.transparencyFlattened'));
  }
  result.push(...preparationNotes(prepared.counters, part), ...notes);
  if (producer !== null && producer.trim() !== '') {
    result.push(note('changed', 'op.note.pdfa.producer', { producer }));
  }
  if (measures.wordRecall !== null) {
    if (measures.textDiffers.length > 0) {
      result.push(
        note('warning', 'op.note.pdfa.textLoss', {
          percent: percent(measures.wordRecall),
          pages: pageList(measures.textDiffers),
        }),
      );
    } else {
      result.push(
        note('preserved', 'op.note.pdfa.textKept', {
          percent: percent(measures.wordRecall),
          pages: measures.textPages.length,
        }),
      );
    }
  }
  if (measures.pictureDiffers.length > 0) {
    result.push(note('warning', 'op.note.pdfa.pictureDiffers', { pages: pageList(measures.pictureDiffers) }));
  } else {
    result.push(
      note('preserved', 'op.note.pdfa.pictureKept', {
        pages: measures.picturePages.length,
        difference: percent(measures.pictureMean),
      }),
    );
  }
  result.push(
    note('preserved', 'op.note.pdfa.verified', { level, rules: check.checked.length }),
    note('warning', 'op.note.pdfa.limits'),
  );

  return {
    bytes: run.output,
    report: {
      engine: 'ghostscript',
      steps: ['pdfa.prepare', 'pdfa.convert', 'pdfa.verify'],
      notes: result,
      inputBytes: bytes.length,
      outputBytes: run.output.length,
      pageCount: check.pageCount,
      incremental: false,
    },
    check,
    source,
    measures,
    converted: true,
  };
}
