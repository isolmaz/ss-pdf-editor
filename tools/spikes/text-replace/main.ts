/**
 * Spike #3 — replacing existing paragraph text (throwaway, `PLAN.md §9/K21`).
 *
 * Question the spike must answer: *can we erase a paragraph and place new Turkish
 * text without damaging its neighbours, and does a second edit round still work?*
 *
 * Per case: build the fixture → locate the target region from the text model → erase
 * (MuPDF redaction, `black_boxes = false`) → save → **reopen** → write the
 * replacement (our own content stream, because MuPDF.js has no insert-text API) →
 * save → **reopen** → verify with MuPDF *and* pdf.js, plus pixel diffs of the target
 * region, every neighbouring block, the table rules and the image.
 */
import type { Mupdf, PdfFont } from './engine';
import { loadMupdf, openPdf, savePdf } from './engine';
import type { CaseSpec, Fixture } from './fixture';
import { buildFixture, inspectFonts } from './fixture';
import { spikeWindow } from './globals';
import { calibrateAdvance, eraseRegion, placementFromLines, writeTextBlock } from './replace';
import type { GLine, Rect4 } from './textmodel';
import { containsRect, findBlock, findLines, normalizeText, readBlocks, unionRect } from './textmodel';
import { renderResult } from './ui';
import type { DiffStat, ImageInfo } from './verify';
import {
  diffRegion,
  documentStats,
  imageObjects,
  muPdfModel,
  pageFontResources,
  pageFontsFromText,
  pdfJsModel,
  renderPage,
} from './verify';

export const RENDER_SCALE = 2;
const SAVE_OPTIONS = 'garbage=compact,compress';
const ROUND2_TEXT = 'İkinci tur: bildirim adresi güncellendi ve tebligat usulü yeniden düzenlendi.';
const UNUSED_SAMPLE = ['Ğ', 'Ş', 'İ', 'Q', 'X', 'W'];

export interface NeighbourDiff {
  readonly text: string;
  readonly bbox: Rect4;
  readonly diff: DiffStat;
}

export interface CaseResult {
  readonly id: string;
  readonly label: string;
  readonly page: number;
  readonly region: Rect4;
  readonly erase: {
    readonly blackBoxes: boolean;
    readonly imageMethod: number;
    readonly lineArtMethod: number;
    readonly textMethod: number;
    readonly annotRect: Rect4;
  };
  readonly before: {
    readonly blockBBox: Rect4 | null;
    readonly targetLines: string[];
    readonly pageBounds: Rect4;
    readonly rotate: number;
    readonly fontResources: string[];
    readonly objects: number;
  };
  readonly placement: {
    readonly origin: [number, number];
    readonly dir: [number, number];
    readonly down: [number, number];
    readonly size: number;
    readonly leading: number;
    readonly maxWidth: number;
    readonly advanceScale: number;
    readonly calibrationMeasured: number;
    readonly calibrationAdvanceSum: number;
  };
  readonly eraseOnly: {
    readonly bytes: number;
    readonly oldTextGoneMuPdf: boolean;
    readonly oldTextGonePdfJs: boolean;
    readonly neighbourLinesMissing: string[];
  };
  readonly write: {
    readonly lines: readonly string[];
    readonly overflowed: boolean;
    readonly missingChars: readonly string[];
    readonly fontResource: string;
    readonly embeddedNewFont: boolean;
  };
  readonly checks: {
    readonly oldTargetGoneMuPdf: boolean;
    readonly oldTargetGonePdfJs: boolean;
    readonly newTextSearchableMuPdf: boolean;
    readonly newTextSearchablePdfJs: boolean;
    readonly newNeedle: string;
    readonly duplicateElsewhereIntact: boolean;
    readonly controlPageIdenticalMuPdf: boolean;
    readonly controlPageIdenticalPdfJs: boolean;
    readonly pageCountBefore: number;
    readonly pageCountAfter: number;
    readonly otherPagesTextIdenticalMuPdf: boolean;
    readonly otherPagesTextIdenticalPdfJs: boolean;
    readonly neighbourLinesIdentical: boolean;
    readonly neighbourLinesMissing: string[];
    readonly newTextInsideOriginalBox: boolean;
    readonly newBlockBBox: Rect4 | null;
    readonly placementDelta: Rect4 | null;
  };
  readonly neighbours: NeighbourDiff[];
  readonly pixels: {
    readonly scale: number;
    readonly target: DiffStat;
    readonly neighbourTotal: DiffStat;
    readonly rules: DiffStat[];
    readonly imageBand: DiffStat | null;
  };
  readonly images: {
    readonly before: ImageInfo[];
    readonly after: ImageInfo[];
    readonly survived: boolean;
  };
  readonly sizes: {
    readonly fixtureBytes: number;
    readonly erasedBytes: number;
    readonly finalBytes: number;
    readonly objectsAfter: number;
    readonly fontResourcesAfter: string[];
    readonly embeddedFontsAfter: { resource: string; baseFont: string; bytes: number }[];
  };
  readonly contrast?: {
    readonly label: string;
    readonly region: Rect4;
    readonly lineArtMethod: number;
    readonly rules: DiffStat[];
    readonly destroyedRulePixels: number;
  };
  readonly pngBefore: string | null;
  readonly pngAfter: string | null;
}

export interface Round2Variant {
  readonly label: string;
  readonly locatedRound1Text: boolean;
  readonly fontResource: string;
  readonly embeddedNewFont: boolean;
  readonly coverageRound2Text: { char: string; gid: number }[];
  readonly coverageUnusedSample: { char: string; gid: number }[];
  readonly missingChars: readonly string[];
  readonly round1GoneMuPdf: boolean;
  readonly round2SearchableMuPdf: boolean;
  readonly round2SearchablePdfJs: boolean;
  readonly neighbourLinesIdentical: boolean;
  readonly pageCount: number;
  readonly fontResourcesBefore: string[];
  readonly fontResourcesAfter: string[];
  readonly objectsBefore: number;
  readonly objectsAfter: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly subsetFontsCalled: boolean;
  readonly writeLines: readonly string[];
}

export interface SpikeResult {
  readonly meta: {
    readonly ranAt: string;
    readonly userAgent: string;
    readonly crossOriginIsolated: boolean;
    readonly mupdf: { url: string; version: string | null };
    readonly font: { name: string; bytes: number; source: string };
    readonly fixture: {
      readonly bytes: number;
      readonly pageCount: number;
      readonly fontsBeforeSubset: Fixture['fontsBeforeSubset'];
      readonly fontsAfterSubset: Fixture['fontsAfterSubset'];
      readonly coverage: Fixture['coverage'];
    };
  };
  readonly cases: CaseResult[];
  readonly round2: Round2Variant[] | null;
  readonly summary: {
    readonly cases: number;
    readonly oldTargetGone: number;
    readonly newTextSearchable: number;
    readonly neighboursIntact: number;
    readonly pageCountIntact: number;
    readonly ruleBandsUntouched: number;
    readonly ruleBandsTotal: number;
    readonly imagesSurvived: number;
  };
  readonly timings: { phase: string; ms: number }[];
}

interface CaseRun {
  readonly result: CaseResult;
  readonly erasedBytes: Uint8Array;
  readonly finalBytes: Uint8Array;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function firstWords(text: string, count: number): string {
  return text
    .split(' ')
    .slice(0, count)
    .join(' ')
    .replace(/[.,;:!?]+$/, '');
}

function pad(rect: Rect4, amount: number): Rect4 {
  return [rect[0] - amount, rect[1] - amount, rect[2] + amount, rect[3] + amount];
}

/** A band covering one rule, so a pixel diff shows whether the rule was destroyed. */
function ruleBand(rule: { x1: number; y1: number; x2: number; y2: number }): Rect4 {
  const half = 1.5;
  const x0 = Math.min(rule.x1, rule.x2);
  const x1 = Math.max(rule.x1, rule.x2);
  const y0 = Math.min(rule.y1, rule.y2);
  const y1 = Math.max(rule.y1, rule.y2);
  return x0 === x1 ? [x0 - half, y0, x1 + half, y1] : [x0, y0 - half, x1, y1 + half];
}

function intersects(a: Rect4, b: Rect4): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

function sumDiffs(diffs: readonly DiffStat[], fallback: Rect4): DiffStat {
  if (diffs.length === 0)
    return { region: fallback, totalPixels: 0, changedPixels: 0, ratio: 0, maxChannelDelta: 0 };
  const changedPixels = diffs.reduce((total, diff) => total + diff.changedPixels, 0);
  const totalPixels = diffs.reduce((total, diff) => total + diff.totalPixels, 0);
  return {
    region: fallback,
    totalPixels,
    changedPixels,
    ratio: totalPixels === 0 ? 0 : changedPixels / totalPixels,
    maxChannelDelta: diffs.reduce((maximum, diff) => Math.max(maximum, diff.maxChannelDelta), 0),
  };
}

function longestLine(lines: readonly GLine[]): GLine | null {
  let best: GLine | null = null;
  for (const line of lines) if (line.chars.length > (best?.chars.length ?? 0)) best = line;
  return best;
}

function progress(message: string): void {
  spikeWindow.__spikeProgress.push(message);
  console.log(`[spike3] ${message}`);
}

async function timed<T>(
  timings: { phase: string; ms: number }[],
  phase: string,
  run: () => Promise<T> | T,
): Promise<T> {
  const started = performance.now();
  const value = await run();
  timings.push({ phase, ms: Math.round(performance.now() - started) });
  progress(phase);
  return value;
}

function lineStrings(lines: readonly GLine[]): string[] {
  return lines.map((line) => normalizeText(line.chars.map((char) => char.c).join('')));
}

async function runCase(
  mupdf: Mupdf,
  fixture: Fixture,
  spec: CaseSpec,
  fontBytes: Uint8Array,
  fontName: string,
  timings: { phase: string; ms: number }[],
): Promise<CaseRun> {
  // ------------------------------------------------------------------ before state
  const beforeDoc = openPdf(mupdf, fixture.bytes);
  const beforePages = await timed(timings, `${spec.id}: read fixture text`, () =>
    muPdfModel(mupdf, fixture.bytes),
  );
  const beforePdf = await pdfJsModel(fixture.bytes);
  const beforePage = beforeDoc.loadPage(spec.page);
  const beforeBlocks = readBlocks(beforePage);
  const targetLines = spec.erasePhrases.flatMap((phrase) => findLines(beforeBlocks, phrase));
  const targetBox = unionRect(targetLines.map((line) => line.bbox));
  if (!targetBox)
    throw new Error(`case ${spec.id}: target text not found (${spec.erasePhrases.join(' | ')})`);
  const eraseRect = pad(targetBox, 1.5);
  const placement = placementFromLines(targetLines, fixture.leading);
  if (!placement) throw new Error(`case ${spec.id}: cannot derive placement`);
  // Calibrate against the font we actually embed: a font read back from a
  // subsetted file reports glyph id 0 for every character (see NOTES.md), so it
  // cannot measure advances.
  const embedFont = new mupdf.Font(fontName, fontBytes);
  const longest = longestLine(targetLines);
  const calibration = longest
    ? calibrateAdvance(embedFont, longest)
    : { advanceScale: 1, measured: 0, advanceSum: 0 };
  const targetLineTexts = lineStrings(targetLines);
  const pageLinesBefore = beforePages[spec.page]?.lines ?? [];
  const neighbourLinesBefore = pageLinesBefore.filter((line) => !targetLineTexts.includes(line));
  const targetBlock = findBlock(beforeBlocks, spec.erasePhrases);
  const neighbourBlocks = targetBlock
    ? beforeBlocks.filter((block) => block !== targetBlock)
    : beforeBlocks.filter((block) => !block.lines.some((line) => targetLines.includes(line)));
  const beforeRender = renderPage(mupdf, beforeDoc, spec.page, RENDER_SCALE, true);
  const beforeImages = spec.imageRect ? imageObjects(beforeDoc, spec.page) : [];
  const beforeFontResources = pageFontResources(beforeDoc, spec.page);
  const beforeStats = documentStats(beforeDoc);
  const beforeBounds = beforePage.getBounds() as Rect4;
  const rotateObject = beforePage.getObject().get('Rotate');
  const rotate = rotateObject.isNull() ? 0 : rotateObject.asNumber();

  // ------------------------------------------------------------------ erase
  const eraseDoc = openPdf(mupdf, fixture.bytes);
  const eraseInfo = await timed(timings, `${spec.id}: erase (redact)`, () =>
    eraseRegion(eraseDoc, spec.page, eraseRect, {
      imageMethod: spec.imageMethod,
      lineArtMethod: spec.lineArtMethod,
      textMethod: spec.textMethod,
      blackBoxes: false,
    }),
  );
  const erasedBytes = savePdf(eraseDoc, SAVE_OPTIONS);
  eraseDoc.destroy();
  const erasedPages = await timed(timings, `${spec.id}: erase-only extract`, () =>
    muPdfModel(mupdf, erasedBytes),
  );
  const erasedPdf = await pdfJsModel(erasedBytes);
  const erasedRender = renderPage(mupdf, openPdf(mupdf, erasedBytes), spec.page, RENDER_SCALE, false);

  // ------------------------------------------------------------------ write
  const writeDoc = openPdf(mupdf, erasedBytes);
  const writeFont = embedFont;
  const boxHeight = targetBox[3] - targetBox[1];
  const write = await timed(timings, `${spec.id}: write text`, () =>
    writeTextBlock(
      mupdf,
      writeDoc,
      spec.page,
      placement,
      spec.newText,
      { font: writeFont },
      {
        maxWidth: placement.maxWidth * 1.02,
        maxLines: Math.max(1, Math.round(boxHeight / placement.leading)),
        advanceScale: calibration.advanceScale,
      },
    ),
  );
  const finalBytes = savePdf(writeDoc, SAVE_OPTIONS);
  writeDoc.destroy();

  // ------------------------------------------------------------------ after state
  const afterPages = await timed(timings, `${spec.id}: verify (mupdf)`, () => muPdfModel(mupdf, finalBytes));
  const afterPdf = await pdfJsModel(finalBytes);
  const afterDoc = openPdf(mupdf, finalBytes);
  const afterRender = renderPage(mupdf, afterDoc, spec.page, RENDER_SCALE, true);
  const afterBlocks = readBlocks(afterDoc.loadPage(spec.page));
  const afterImages = spec.imageRect ? imageObjects(afterDoc, spec.page) : [];
  const afterFontResources = pageFontResources(afterDoc, spec.page);
  const afterStats = documentStats(afterDoc);
  const embeddedFontsAfter = inspectFonts(afterDoc, spec.page).map((font) => ({
    resource: font.resource,
    baseFont: font.baseFont,
    bytes: font.embeddedBytes,
  }));
  const afterPageLines = afterPages[spec.page]?.lines ?? [];
  const afterPageTextPdfJs = afterPdf.pages[spec.page] ?? '';

  // ------------------------------------------------------------------ checks
  const oldTargetGoneMuPdf = spec.erasePhrases.every(
    (phrase) => !afterPageLines.some((line) => line.includes(phrase)),
  );
  const oldTargetGonePdfJs = spec.erasePhrases.every((phrase) => !afterPageTextPdfJs.includes(phrase));
  const newNeedle = firstWords(spec.newText, 4);
  const duplicateElsewhereIntact =
    (afterPages[fixture.duplicate.page]?.text ?? '').includes(fixture.duplicate.phrase) &&
    (afterPdf.pages[fixture.duplicate.page] ?? '').includes(fixture.duplicate.phrase);
  const controlPageIdenticalMuPdf =
    (afterPages[fixture.controlPage]?.text ?? '') === (beforePages[fixture.controlPage]?.text ?? '');
  const controlPageIdenticalPdfJs =
    (afterPdf.pages[fixture.controlPage] ?? '') === (beforePdf.pages[fixture.controlPage] ?? '');
  const otherPagesTextIdenticalMuPdf = beforePages.every(
    (page, index) => index === spec.page || page.text === (afterPages[index]?.text ?? ''),
  );
  const otherPagesTextIdenticalPdfJs = beforePdf.pages.every(
    (page, index) => index === spec.page || page === (afterPdf.pages[index] ?? ''),
  );
  const neighbourLinesMissing = neighbourLinesBefore.filter((line) => !afterPageLines.includes(line));
  const newBlock = findBlock(afterBlocks, [newNeedle]);
  const newBlockBBox = newBlock?.bbox ?? null;
  const newTextInsideOriginalBox = newBlockBBox ? containsRect(pad(targetBox, 2), newBlockBBox, 0.01) : false;
  const placementDelta: Rect4 | null = newBlockBBox
    ? [
        newBlockBBox[0] - targetBox[0],
        newBlockBBox[1] - targetBox[1],
        newBlockBBox[2] - targetBox[2],
        newBlockBBox[3] - targetBox[3],
      ]
    : null;

  // ------------------------------------------------------------------ pixels
  const neighbours: NeighbourDiff[] = neighbourBlocks.map((block) => ({
    text: normalizeText(block.lines.flatMap((line) => line.chars.map((char) => char.c)).join('')),
    bbox: block.bbox,
    diff: diffRegion(beforeRender.pixmap, afterRender.pixmap, block.bbox, RENDER_SCALE),
  }));
  const ruleDiffs = (spec.rules ?? [])
    .map((rule) => ruleBand(rule))
    .filter((band) => intersects(band, eraseRect))
    .map((band) => diffRegion(beforeRender.pixmap, erasedRender.pixmap, band, RENDER_SCALE));
  const imageBand = spec.imageRect
    ? diffRegion(
        beforeRender.pixmap,
        erasedRender.pixmap,
        [spec.imageRect[0], spec.imageRect[1] + 120, spec.imageRect[2], spec.imageRect[3]],
        RENDER_SCALE,
      )
    : null;
  const imagesSurvived =
    beforeImages.length > 0 &&
    beforeImages.every((before) => afterImages.some((after) => after.pixelHash === before.pixelHash));

  // ------------------------------------------------------------------ contrast run
  let contrast: CaseResult['contrast'];
  const contrastSpec = spec.contrast;
  if (contrastSpec) {
    const contrastDoc = openPdf(mupdf, fixture.bytes);
    eraseRegion(contrastDoc, spec.page, contrastSpec.region, {
      imageMethod: spec.imageMethod,
      lineArtMethod: contrastSpec.lineArtMethod,
      textMethod: spec.textMethod,
      blackBoxes: false,
    });
    const contrastBytes = savePdf(contrastDoc, SAVE_OPTIONS);
    contrastDoc.destroy();
    const contrastRender = renderPage(mupdf, openPdf(mupdf, contrastBytes), spec.page, RENDER_SCALE, false);
    const contrastRules = (spec.rules ?? [])
      .map((rule) => ruleBand(rule))
      .filter((band) => intersects(band, contrastSpec.region))
      .map((band) => diffRegion(beforeRender.pixmap, contrastRender.pixmap, band, RENDER_SCALE));
    contrast = {
      label: contrastSpec.label,
      region: contrastSpec.region,
      lineArtMethod: contrastSpec.lineArtMethod,
      rules: contrastRules,
      destroyedRulePixels: contrastRules.reduce((total, diff) => total + diff.changedPixels, 0),
    };
    contrastRender.pixmap.destroy();
  }

  const result: CaseResult = {
    id: spec.id,
    label: spec.label,
    page: spec.page,
    region: eraseRect,
    erase: {
      blackBoxes: false,
      imageMethod: spec.imageMethod,
      lineArtMethod: spec.lineArtMethod,
      textMethod: spec.textMethod,
      annotRect: eraseInfo.annotRect,
    },
    before: {
      blockBBox: targetBlock?.bbox ?? targetBox,
      targetLines: targetLineTexts,
      pageBounds: beforeBounds,
      rotate,
      fontResources: beforeFontResources,
      objects: beforeStats.objects,
    },
    placement: {
      origin: placement.origin,
      dir: placement.dir,
      down: placement.down,
      size: placement.size,
      leading: placement.leading,
      maxWidth: placement.maxWidth,
      advanceScale: calibration.advanceScale,
      calibrationMeasured: calibration.measured,
      calibrationAdvanceSum: calibration.advanceSum,
    },
    eraseOnly: {
      bytes: erasedBytes.byteLength,
      oldTextGoneMuPdf: spec.erasePhrases.every(
        (phrase) => !(erasedPages[spec.page]?.lines ?? []).some((line) => line.includes(phrase)),
      ),
      oldTextGonePdfJs: spec.erasePhrases.every(
        (phrase) => !(erasedPdf.pages[spec.page] ?? '').includes(phrase),
      ),
      neighbourLinesMissing: neighbourLinesBefore.filter(
        (line) => !(erasedPages[spec.page]?.lines ?? []).includes(line),
      ),
    },
    write: {
      lines: write.lines,
      overflowed: write.overflowed,
      missingChars: write.missingChars,
      fontResource: write.fontResource,
      embeddedNewFont: write.embeddedNewFont,
    },
    checks: {
      oldTargetGoneMuPdf,
      oldTargetGonePdfJs,
      newTextSearchableMuPdf: afterPageLines.join(' ').includes(newNeedle),
      newTextSearchablePdfJs: afterPageTextPdfJs.includes(newNeedle),
      newNeedle,
      duplicateElsewhereIntact,
      controlPageIdenticalMuPdf,
      controlPageIdenticalPdfJs,
      pageCountBefore: beforePages.length,
      pageCountAfter: afterPages.length,
      otherPagesTextIdenticalMuPdf,
      otherPagesTextIdenticalPdfJs,
      neighbourLinesIdentical: neighbourLinesMissing.length === 0 && neighbourLinesBefore.length > 0,
      neighbourLinesMissing,
      newTextInsideOriginalBox,
      newBlockBBox,
      placementDelta,
    },
    neighbours,
    pixels: {
      scale: RENDER_SCALE,
      target: diffRegion(beforeRender.pixmap, afterRender.pixmap, eraseRect, RENDER_SCALE),
      neighbourTotal: sumDiffs(
        neighbours.map((entry) => entry.diff),
        eraseRect,
      ),
      rules: ruleDiffs,
      imageBand,
    },
    images: { before: beforeImages, after: afterImages, survived: imagesSurvived },
    sizes: {
      fixtureBytes: fixture.bytes.byteLength,
      erasedBytes: erasedBytes.byteLength,
      finalBytes: finalBytes.byteLength,
      objectsAfter: afterStats.objects,
      fontResourcesAfter: afterFontResources,
      embeddedFontsAfter,
    },
    contrast,
    pngBefore: beforeRender.pngBase64,
    pngAfter: afterRender.pngBase64,
  };

  beforeRender.pixmap.destroy();
  afterRender.pixmap.destroy();
  erasedRender.pixmap.destroy();
  beforeDoc.destroy();
  afterDoc.destroy();
  embedFont.destroy();
  return { result, erasedBytes, finalBytes };
}

/** The "edit again" requirement: reopen the saved output and replace the text a second time. */
async function runRound2(
  mupdf: Mupdf,
  fixture: Fixture,
  round1: CaseRun,
  fontBytes: Uint8Array,
  fontName: string,
  timings: { phase: string; ms: number }[],
): Promise<Round2Variant[]> {
  const spec = fixture.cases.find((entry) => entry.id === 'a');
  if (!spec) return [];
  const beforePages = await timed(timings, 'round 2: read round-1 output', () =>
    muPdfModel(mupdf, round1.finalBytes),
  );
  const doc = openPdf(mupdf, round1.finalBytes);
  const blocks = readBlocks(doc.loadPage(spec.page));
  const round1Needle = firstWords(spec.newText, 4);
  const round1Lines = findLines(blocks, round1Needle);
  const locatedRound1Text = round1Lines.length > 0;
  const round1Box = unionRect(round1Lines.map((line) => line.bbox));
  const region = round1Box ? pad(round1Box, 1.5) : pad([0, 0, 0, 0], 0);
  const placement = placementFromLines(round1Lines, fixture.leading);
  const round1LineTexts = lineStrings(round1Lines);
  const neighbourLinesBefore = (beforePages[spec.page]?.lines ?? []).filter(
    (line) => !round1LineTexts.includes(line),
  );
  const fontResourcesBefore = pageFontResources(doc, spec.page);
  const objectsBefore = documentStats(doc).objects;
  const reused = pageFontsFromText(doc, spec.page)[0];
  const existingResource = fontResourcesBefore.find((name) => name.startsWith('SpikeText'));
  const maxLines = Math.max(
    1,
    Math.round(((round1Box?.[3] ?? 0) - (round1Box?.[1] ?? 0)) / (placement?.leading ?? fixture.leading)),
  );

  const coverage = (font: PdfFont | undefined, text: string): { char: string; gid: number }[] =>
    [...text].map((char) => ({ char, gid: font ? font.encodeCharacter(char) : -1 }));

  const variants: Round2Variant[] = [];

  // Variant A — keep the existing embedded (subset) font resource and its glyph ids.
  if (reused && existingResource && placement) {
    const workDoc = openPdf(mupdf, round1.finalBytes);
    eraseRegion(workDoc, spec.page, region, {
      imageMethod: spec.imageMethod,
      lineArtMethod: spec.lineArtMethod,
      textMethod: spec.textMethod,
      blackBoxes: false,
    });
    const write = writeTextBlock(
      mupdf,
      workDoc,
      spec.page,
      placement,
      ROUND2_TEXT,
      { font: reused.font, existingResource },
      { maxWidth: placement.maxWidth * 1.02, maxLines, advanceScale: 1 },
    );
    const bytes = savePdf(workDoc, SAVE_OPTIONS);
    workDoc.destroy();
    const pages = await timed(timings, 'round 2 (reuse): verify', () => muPdfModel(mupdf, bytes));
    const pdf = await pdfJsModel(bytes);
    const afterDoc = openPdf(mupdf, bytes);
    const afterLines = pages[spec.page]?.lines ?? [];
    const afterText = pdf.pages[spec.page] ?? '';
    variants.push({
      label: 'A · reuse the existing embedded subset font resource',
      locatedRound1Text,
      fontResource: existingResource,
      embeddedNewFont: write.embeddedNewFont,
      coverageRound2Text: coverage(reused.font, ROUND2_TEXT),
      coverageUnusedSample: coverage(reused.font, UNUSED_SAMPLE.join('')),
      missingChars: write.missingChars,
      round1GoneMuPdf: !afterLines.some((line) => line.includes(round1Needle)),
      round2SearchableMuPdf: afterLines.join(' ').includes(firstWords(ROUND2_TEXT, 4)),
      round2SearchablePdfJs: afterText.includes(firstWords(ROUND2_TEXT, 4)),
      neighbourLinesIdentical: neighbourLinesBefore.every((line) => afterLines.includes(line)),
      pageCount: pages.length,
      fontResourcesBefore,
      fontResourcesAfter: pageFontResources(afterDoc, spec.page),
      objectsBefore,
      objectsAfter: documentStats(afterDoc).objects,
      bytesBefore: round1.finalBytes.byteLength,
      bytesAfter: bytes.byteLength,
      subsetFontsCalled: false,
      writeLines: write.lines,
    });
    afterDoc.destroy();
  }

  // Variant B — embed the full font again, then subset before saving.
  if (placement) {
    const workDoc = openPdf(mupdf, round1.finalBytes);
    eraseRegion(workDoc, spec.page, region, {
      imageMethod: spec.imageMethod,
      lineArtMethod: spec.lineArtMethod,
      textMethod: spec.textMethod,
      blackBoxes: false,
    });
    const font = new mupdf.Font(fontName, fontBytes);
    const write = writeTextBlock(
      mupdf,
      workDoc,
      spec.page,
      placement,
      ROUND2_TEXT,
      { font },
      { maxWidth: placement.maxWidth * 1.02, maxLines, advanceScale: 1 },
    );
    workDoc.subsetFonts();
    const bytes = savePdf(workDoc, SAVE_OPTIONS);
    workDoc.destroy();
    const pages = await timed(timings, 'round 2 (re-embed + subset): verify', () => muPdfModel(mupdf, bytes));
    const pdf = await pdfJsModel(bytes);
    const afterDoc = openPdf(mupdf, bytes);
    const afterLines = pages[spec.page]?.lines ?? [];
    const afterText = pdf.pages[spec.page] ?? '';
    variants.push({
      label: 'B · embed the font again, then subsetFonts() before saving',
      locatedRound1Text,
      fontResource: write.fontResource,
      embeddedNewFont: write.embeddedNewFont,
      coverageRound2Text: coverage(font, ROUND2_TEXT),
      coverageUnusedSample: coverage(font, UNUSED_SAMPLE.join('')),
      missingChars: write.missingChars,
      round1GoneMuPdf: !afterLines.some((line) => line.includes(round1Needle)),
      round2SearchableMuPdf: afterLines.join(' ').includes(firstWords(ROUND2_TEXT, 4)),
      round2SearchablePdfJs: afterText.includes(firstWords(ROUND2_TEXT, 4)),
      neighbourLinesIdentical: neighbourLinesBefore.every((line) => afterLines.includes(line)),
      pageCount: pages.length,
      fontResourcesBefore,
      fontResourcesAfter: pageFontResources(afterDoc, spec.page),
      objectsBefore,
      objectsAfter: documentStats(afterDoc).objects,
      bytesBefore: round1.finalBytes.byteLength,
      bytesAfter: bytes.byteLength,
      subsetFontsCalled: true,
      writeLines: write.lines,
    });
    afterDoc.destroy();
    font.destroy();
  }

  doc.destroy();
  return variants;
}

export async function runSpike(options: {
  fontBase64: string;
  fontName?: string;
  fontSource?: string;
}): Promise<SpikeResult> {
  const timings: { phase: string; ms: number }[] = [];
  const mupdf = await loadMupdf();
  progress('mupdf loaded');
  const fontName = options.fontName ?? 'Arial';
  const fontBytes = base64ToBytes(options.fontBase64);
  const fixture = await timed(timings, 'fixture build', () => buildFixture(mupdf, fontBytes, fontName));
  const cases: CaseResult[] = [];
  const runs: CaseRun[] = [];
  for (const spec of fixture.cases) {
    const run = await runCase(mupdf, fixture, spec, fontBytes, fontName, timings);
    cases.push(run.result);
    runs.push(run);
  }
  const round1 = runs.find((run) => run.result.id === 'a');
  const round2 = round1 ? await runRound2(mupdf, fixture, round1, fontBytes, fontName, timings) : null;
  const ruleBands = cases.flatMap((entry) => entry.pixels.rules);
  const result: SpikeResult = {
    meta: {
      ranAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      crossOriginIsolated: window.crossOriginIsolated === true,
      mupdf: { url: '/engines/mupdf/mupdf.js', version: null },
      font: { name: fontName, bytes: fontBytes.byteLength, source: options.fontSource ?? 'harness' },
      fixture: {
        bytes: fixture.bytes.byteLength,
        pageCount: fixture.pageCount,
        fontsBeforeSubset: fixture.fontsBeforeSubset,
        fontsAfterSubset: fixture.fontsAfterSubset,
        coverage: fixture.coverage,
      },
    },
    cases,
    round2,
    summary: {
      cases: cases.length,
      oldTargetGone: cases.filter(
        (entry) => entry.checks.oldTargetGoneMuPdf && entry.checks.oldTargetGonePdfJs,
      ).length,
      newTextSearchable: cases.filter(
        (entry) => entry.checks.newTextSearchableMuPdf && entry.checks.newTextSearchablePdfJs,
      ).length,
      neighboursIntact: cases.filter((entry) => entry.checks.neighbourLinesIdentical).length,
      pageCountIntact: cases.filter((entry) => entry.checks.pageCountBefore === entry.checks.pageCountAfter)
        .length,
      ruleBandsUntouched: ruleBands.filter((diff) => diff.changedPixels === 0).length,
      ruleBandsTotal: ruleBands.length,
      imagesSurvived: cases.filter((entry) => entry.images.before.length === 0 || entry.images.survived)
        .length,
    },
    timings,
  };
  return result;
}

/**
 * Spike #2 (`tools/spikes/journal-undo`) declares `window.__spikeResult` with its own
 * result type in the same TypeScript program, so this spike reaches the globals
 * through an explicit cast (see `globals.ts`) instead of a conflicting declaration.
 */
spikeWindow.__spikeResult = null;
spikeWindow.__spikeError = null;
spikeWindow.__spikeProgress = [];
spikeWindow.__runSpike = async (options) => {
  try {
    const result = await runSpike(options);
    spikeWindow.__spikeResult = result;
    renderResult(result);
    return result;
  } catch (error) {
    spikeWindow.__spikeError =
      error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    renderResult(null);
    throw error;
  }
};
