/**
 * Which results are read before they reach the document: anything lost, warned about or
 * approximated, and a result with nothing to apply. Everything else is delivered at once.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationNote, OperationReport } from 'pdf-core/ops/types';
import type { MessageKey } from 'pdf-shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { en } from '../../../shared/src/i18n/en';
import { REVIEW_CHANGES, resultNeedsReview } from './review';
import type { OpRunResult } from './types';

const file = { name: 'out.pdf', bytes: new Uint8Array([1]), mime: 'application/pdf' };

function result(notes: readonly OperationNote[], files: OpRunResult['files'] = [file]): OpRunResult {
  const report: OperationReport = {
    engine: 'model',
    steps: [],
    notes,
    inputBytes: 10,
    outputBytes: 10,
    pageCount: 1,
    incremental: true,
  };
  return { files, report };
}

describe('resultNeedsReview', () => {
  it('delivers a result with no notes, or only what was done and what was kept, at once', () => {
    expect(resultNeedsReview(result([]))).toBe(false);
    expect(
      resultNeedsReview(
        result([
          { kind: 'changed', key: 'op.note.stamp.drawn', params: { count: 3 } },
          { kind: 'preserved', key: 'op.note.stamp.untouchedPages', params: { count: 2 } },
        ]),
      ),
    ).toBe(false);
  });

  it('reviews anything that was lost', () => {
    expect(resultNeedsReview(result([{ kind: 'lost', key: 'op.note.merge.outlineLost' }]))).toBe(true);
  });

  it('reviews any warning, among a run of harmless notes too', () => {
    expect(
      resultNeedsReview(
        result([
          { kind: 'changed', key: 'op.note.stamp.drawn', params: { count: 3 } },
          { kind: 'warning', key: 'op.note.stamp.noPrint' },
          { kind: 'preserved', key: 'op.note.stamp.untouchedPages', params: { count: 2 } },
        ]),
      ),
    ).toBe(true);
  });

  it('reviews a change that says the output is not what was asked for, and no other change', () => {
    expect(resultNeedsReview(result([{ kind: 'changed', key: 'op.note.findReplace.shrunk' }]))).toBe(true);
    expect(resultNeedsReview(result([{ kind: 'changed', key: 'op.note.findReplace.replaced' }]))).toBe(false);
    // The same sentence as a guarantee is not a caveat.
    expect(resultNeedsReview(result([{ kind: 'preserved', key: 'op.note.findReplace.shrunk' }]))).toBe(false);
  });

  it('reads the report of a result that has no file to apply', () => {
    expect(resultNeedsReview(result([], []))).toBe(true);
    expect(resultNeedsReview(result([{ kind: 'preserved', key: 'form.note.valid' }], []))).toBe(true);
  });
});

/**
 * The `changed` notes that are applied without a review. Every `changed` note the sources can
 * write is either in `REVIEW_CHANGES` (the output differs from what was asked, or was not fully
 * verified) or here (it says what was done, as asked), so a new note cannot slip into the
 * one-step apply unnoticed.
 */
const PLAIN_CHANGES: ReadonlySet<string> = new Set([
  // What was asked for, counted: pages, marks, fields, links, sheets or parts written, removed or labelled.
  'ann.removed',
  'ann.transformed',
  'export.text.covered',
  'export.text.done',
  'form.note.calculated',
  'form.note.created',
  'form.note.filled',
  'form.note.flagged',
  'form.note.flattened',
  'formDetect.note.created',
  'insert.note.inserted',
  'labels.note.count',
  'labels.note.plan',
  'op.note.annotate.freetext',
  'op.note.annotate.highlights',
  'op.note.annotate.incremental',
  'op.note.annotate.notes',
  'op.note.annotate.replies',
  'op.note.annotate.retagged',
  'op.note.annotate.shapes',
  'op.note.annotate.states',
  'op.note.attach.added',
  'op.note.attach.removed',
  'op.note.convert.done',
  'op.note.exportOffice.csvRows',
  'op.note.exportOffice.done',
  'op.note.exportOffice.numbers',
  'op.note.exportOffice.sheets',
  'op.note.impose.cropMarks',
  'op.note.impose.padded',
  'op.note.impose.rotated',
  'op.note.impose.sheets',
  'op.note.layer.order',
  'op.note.layer.renamed',
  'op.note.layer.states',
  'op.note.layer.viewOverrides',
  'op.note.link.added',
  'op.note.link.removed',
  'op.note.link.uriEncoded',
  'op.note.measure.written',
  'op.note.outline.childAdded',
  'op.note.outline.cleared',
  'op.note.outline.nodes',
  'op.note.outline.removed',
  'op.note.outline.renamed',
  'op.note.outline.replaced',
  'op.note.scan.pages',
  'op.note.sign.fieldCreated',
  'op.note.sign.fieldFilled',
  'op.note.sign.signed',
  'op.note.stamp.added',
  'op.note.stamp.drawn',
  'op.note.stamp.fontEmbedded',
  'op.note.stamp.imageEmbedded',
  'op.note.stamp.overContent',
  'op.note.stamp.resized',
  'print.note.booklet',
  'print.note.cropMarks',
  'print.note.duplexLong',
  'print.note.duplexShort',
  'print.note.padded',
  'print.note.sheets',
  'print.note.simplex',
  'redact.markCount',
  'replace.note.replaced',
  'split.done',
  'tidy.split.done',
  'xfa.note.dataSaved',
  'xfa.note.flattened',
  'xfa.note.imported',
  'xfa.note.removed',
  'xfa.note.synced',
  'xfa.note.widgetsFilled',
  // Page box edits: what the tool was asked to do, with the rule it follows.
  'boxes.note.annotationsScaled',
  'boxes.note.autoCrop',
  'boxes.note.boxesScaled',
  'boxes.note.resize',
  'boxes.note.rotateMovesAnnots',
  'boxes.note.rotated',
  'boxes.note.scaleOrigin',
  'boxes.note.scaled',
  'boxes.note.set',
  'boxes.note.shift',
  'boxes.note.trimWritten',
  // Tagging and accessibility repairs: each is one requested fix, applied as described.
  'op.note.a11y.altSet',
  'op.note.a11y.contentRewritten',
  'op.note.a11y.langSet',
  'op.note.a11y.markInfoSet',
  'op.note.a11y.tagged',
  'op.note.a11y.tooltipSet',
  'op.note.tags.altCleared',
  'op.note.tags.altSet',
  'op.note.tags.artifact',
  'op.note.tags.contentRewritten',
  'op.note.tags.grouped',
  'op.note.tags.parentTreeCleared',
  'op.note.tags.reordered',
  'op.note.tags.retagged',
  'op.note.tags.scopeSet',
  'op.note.tags.unwrapped',
  'op.note.ua.annotsTagged',
  'op.note.ua.contentsSet',
  'op.note.ua.displayTitleSet',
  'op.note.ua.langSet',
  'op.note.ua.markedSet',
  'op.note.ua.pathsMarked',
  'op.note.ua.tabsSet',
  'op.note.ua.titleSet',
  'op.note.ua.tooltipSet',
  'op.note.ua.uaMarked',
  'op.note.ua.xmpCreated',
  // Text edits and OCR: what was asked is in the file; the note says how (font, model, pages read).
  'op.note.exportOffice.ocrMixedPages',
  'op.note.exportOffice.ocrPages',
  'op.note.ocr.bestModel',
  'op.note.ocr.layerAdded',
  'op.note.textEdit.fontEmbedded',
  'op.note.textEdit.rendered',
  'op.note.textEdit.verifiedInserted',
  // Conversions and clean-ups the operation is built on (PDF/A, sanitising what was selected, encryption applied or removed as asked, page labels).
  'insert.note.labels',
  'op.note.compose.rotation',
  'op.note.compress.greyscale',
  'op.note.findReplace.replaced',
  'op.note.image.opacitySet',
  'op.note.image.opacityWrapped',
  'op.note.image.replaced',
  'op.note.images.exif',
  'op.note.merge.labels',
  'op.note.metadata.xmpCreated',
  'op.note.pdfa.appearancesDrawn',
  'op.note.pdfa.colour',
  'op.note.pdfa.converted',
  'op.note.pdfa.printFlagged',
  'op.note.pdfa.producer',
  'op.note.sanitize.removed.comments',
  'op.note.sanitize.removed.files',
  'op.note.sanitize.removed.forms',
  'op.note.sanitize.removed.javascript',
  'op.note.sanitize.removed.layers',
  'op.note.sanitize.removed.links',
  'op.note.sanitize.removed.metadata',
  'op.note.sanitize.removed.private',
  'op.note.sanitize.removed.thumbnails',
  'op.note.sanitize.removed.unused',
  'op.note.sanitize.revisionsDropped',
  'op.note.security.encryptionApplied',
  'op.note.security.protectionRemoved',
  'optimize.saved',
]);

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoots = [join(here, '..', '..', '..', 'pdf-core', 'src'), join(here, '..')];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}

/** `const NAME = { prop: dictKey('key') }` and `{ prop: 'key' }`: `NAME.prop` resolves to `key`. */
function keyConstants(files: readonly ts.SourceFile[]): Map<string, string> {
  const constants = new Map<string, string>();
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isObjectLiteralExpression(init)) {
        for (const property of init.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const value = ts.isCallExpression(property.initializer)
            ? property.initializer.arguments[0]
            : property.initializer;
          if (value !== undefined && ts.isStringLiteralLike(value)) {
            constants.set(`${node.name.text}.${property.name.getText()}`, value.text);
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  for (const file of files) walk(file);
  return constants;
}

/**
 * The keys of every `note('changed', <key>, …)` call. A key written as a literal, either branch
 * of a conditional, a property of a constant table, or a template cast to one of its keys
 * (every dictionary key that starts like the template) is resolved; any other form is returned
 * in `unresolved`, so a note this scan cannot read fails the test instead of passing unseen.
 */
function changedNoteKeys(
  files: readonly ts.SourceFile[],
  constants: ReadonlyMap<string, string>,
  dictionary: readonly string[],
): { keys: Set<string>; unresolved: string[] } {
  const keys = new Set<string>();
  const unresolved: string[] = [];
  const resolve = (expression: ts.Expression): void => {
    if (ts.isStringLiteralLike(expression)) keys.add(expression.text);
    else if (ts.isConditionalExpression(expression)) {
      resolve(expression.whenTrue);
      resolve(expression.whenFalse);
    } else if (ts.isAsExpression(expression)) resolve(expression.expression);
    else if (ts.isTemplateExpression(expression)) {
      for (const key of dictionary) if (key.startsWith(expression.head.text)) keys.add(key);
    } else if (ts.isPropertyAccessExpression(expression) && constants.has(expression.getText())) {
      keys.add(constants.get(expression.getText()) as string);
    } else unresolved.push(expression.getText());
  };
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'note') {
      const [kind, key] = node.arguments;
      if (
        kind !== undefined &&
        ts.isStringLiteralLike(kind) &&
        kind.text === 'changed' &&
        key !== undefined
      ) {
        resolve(key);
      }
    }
    ts.forEachChild(node, walk);
  };
  for (const file of files) walk(file);
  return { keys, unresolved };
}

describe('every changed note has a review decision', () => {
  it('resolves a literal, a conditional, a constant table and a cast template, and reports the rest', () => {
    const fixture = parse(
      'fixture.ts',
      [
        "const TABLE = { one: dictKey('a.one') };",
        "note('changed', 'a.literal');",
        "note('changed', flag ? 'a.yes' : 'a.no', { n: 1 });",
        "note('changed', TABLE.one);",
        `note('changed', \`a.cut.\${part}\` as 'a.cut.x');`,
        "note('warning', 'a.warning');",
        "note('changed', somethingElse());",
      ].join('\n'),
    );
    const { keys, unresolved } = changedNoteKeys([fixture], keyConstants([fixture]), [
      'a.cut.x',
      'a.cut.y',
      'b.other',
    ]);
    expect([...keys].sort()).toEqual(['a.cut.x', 'a.cut.y', 'a.literal', 'a.no', 'a.one', 'a.yes']);
    expect(unresolved).toEqual(['somethingElse()']);
  });

  const files = sourceRoots.flatMap(sourceFiles).map((path) => parse(path, readFileSync(path, 'utf8')));
  const { keys, unresolved } = changedNoteKeys(files, keyConstants(files), Object.keys(en));

  it('reads every note key in the sources', () => {
    expect(unresolved).toEqual([]);
    expect(keys.size).toBeGreaterThan(100);
  });

  it('puts each key on exactly one of the review list and the plain list', () => {
    const undecided = [...keys]
      .filter((key) => !REVIEW_CHANGES.has(key as MessageKey) && !PLAIN_CHANGES.has(key))
      .sort();
    expect(undecided, 'add each to REVIEW_CHANGES (review.ts) or PLAIN_CHANGES (here)').toEqual([]);
    const both = [...keys].filter((key) => REVIEW_CHANGES.has(key as MessageKey) && PLAIN_CHANGES.has(key));
    expect(both).toEqual([]);
  });

  it('lists no key that no source writes', () => {
    const stale = [...REVIEW_CHANGES, ...PLAIN_CHANGES].filter((key) => !keys.has(key));
    expect(stale).toEqual([]);
  });

  it('reviews the outputs that differ from what was asked', () => {
    for (const key of [
      'op.note.exportOffice.pageScaled',
      'op.note.exportOffice.layoutRasters',
      'op.note.exportOffice.ocrLayerRejected',
      'op.note.compress.rotationBaked',
      'op.note.pdfa.encryptionRemoved',
    ] as const) {
      expect(resultNeedsReview(result([{ kind: 'changed', key }])), key).toBe(true);
    }
  });
});
