/**
 * The 150-operation plan (spike #2, `PLAN.md §5/Phase 0` item 2).
 *
 * Interleaving is structural, not decorative: the groups are emitted round-robin,
 * so pdf.js editor commits and model page operations alternate inside one journal
 * instead of forming two blocks. That is the arrangement the chronological undo
 * test is meant to be hard for.
 *
 * Composition (150 total):
 *   59 highlight creates · 30 free-text creates · 24 ink creates · 14 annotation
 *   updates · 1 image stamp (data-URL payload) · 1 annotation delete (plus the
 *   create it removes) · 12 page rotations · 8 page reorders.
 */
import type { JournalEngine, JsonValue } from 'pdf-model';
import { annotationKey, basePages, type OpKind, type Rotation } from './ops';

export type PlanGroup =
  | 'highlight'
  | 'freetext'
  | 'ink'
  | 'update'
  | 'stamp'
  | 'deleteCreate'
  | 'delete'
  | 'rotate'
  | 'reorder';

export interface PlannedOperation {
  readonly engine: JournalEngine;
  readonly labelKey: string;
  readonly kind: OpKind;
  readonly payload: Record<string, JsonValue>;
}

export interface AnnotationTypeMap {
  readonly HIGHLIGHT: number;
  readonly FREETEXT: number;
  readonly INK: number;
  readonly STAMP: number;
  readonly COMMENT: number;
}

export interface StampPayload {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly dataUrlBytes: number;
  readonly sha256: string;
}

export interface PlanInput {
  readonly pageCount: number;
  readonly annotationTypes: AnnotationTypeMap;
  readonly stamp: StampPayload;
}

export interface Plan {
  readonly operations: readonly PlannedOperation[];
  readonly counts: Record<string, number>;
  readonly stats: {
    readonly total: number;
    readonly distinct: number;
    readonly pdfjsEditorOps: number;
    readonly modelOps: number;
    readonly engineTransitions: number;
    readonly firstPageOpIndex: number;
    readonly lastPageOpIndex: number;
    readonly stampIndex: number;
    readonly highlightKeys: readonly string[];
    readonly reservedDeleteKey: string;
  };
}

const GROUPS: readonly { group: PlanGroup; count: number; order: number }[] = [
  { group: 'highlight', count: 59, order: 0 },
  { group: 'rotate', count: 12, order: 1 },
  { group: 'update', count: 14, order: 2 },
  { group: 'freetext', count: 30, order: 3 },
  { group: 'ink', count: 24, order: 4 },
  { group: 'reorder', count: 8, order: 5 },
  { group: 'deleteCreate', count: 1, order: 6 },
  { group: 'delete', count: 1, order: 7 },
  { group: 'stamp', count: 1, order: 8 },
];

export const PLAN_TOTAL = GROUPS.reduce((sum, entry) => sum + entry.count, 0);

const HIGHLIGHT_COLORS: readonly number[][] = [
  [255, 226, 102],
  [167, 232, 189],
  [255, 180, 180],
  [170, 200, 255],
];

const ROTATION_CYCLE: readonly Rotation[] = [90, 180, 270, 0];

function highlightValue(annotationType: number, pageIndex: number, index: number): Record<string, JsonValue> {
  const top = 700 - (index % 10) * 18;
  const bottom = top - 12;
  const left = 72;
  const right = 520;
  return {
    annotationType,
    pageIndex,
    rect: [left, bottom, right, top],
    rotation: 0,
    structTreeParentId: null,
    popupRef: '',
    color: [...(HIGHLIGHT_COLORS[index % HIGHLIGHT_COLORS.length] ?? [255, 226, 102])],
    opacity: 0.4 + (index % 5) * 0.1,
    thickness: 2,
    quadPoints: [left, top, right, top, left, bottom, right, bottom],
  };
}

export function buildPlan(input: PlanInput): Plan {
  const { pageCount, annotationTypes: types, stamp } = input;
  if (pageCount < 4) throw new Error('plan needs at least 4 pages');
  const pages = basePages(pageCount);
  const remaining = new Map<PlanGroup, number>(GROUPS.map((entry) => [entry.group, entry.count]));
  const ordered = [...GROUPS].sort((left, right) => left.order - right.order);

  const highlightKeys = Array.from({ length: 59 }, () => annotationKey());
  const reservedDeleteKey = annotationKey();
  const createdHighlights: { key: string; index: number }[] = [];
  // Dry run of the highlight colour/opacity so an `update` payload carries the
  // value that is really current at that point — a revert is then the exact
  // inverse of its own apply, not just of the whole sequence.
  const highlightAttributes = new Map<string, { color: JsonValue; opacity: JsonValue }>();
  const pageIndexFor = (index: number) => index % pageCount;

  const operations: PlannedOperation[] = [];
  const counts: Record<string, number> = {};
  const cursors: Record<PlanGroup, number> = {
    highlight: 0,
    freetext: 0,
    ink: 0,
    update: 0,
    stamp: 0,
    deleteCreate: 0,
    delete: 0,
    rotate: 0,
    reorder: 0,
  };

  const emit = (
    group: PlanGroup,
    engine: JournalEngine,
    kind: OpKind,
    payload: Record<string, JsonValue>,
  ) => {
    operations.push({ engine, kind, labelKey: `journal.op.${kind}.${group}`, payload });
    counts[group] = (counts[group] ?? 0) + 1;
    cursors[group] += 1;
    remaining.set(group, (remaining.get(group) ?? 0) - 1);
  };

  let stampIndex = -1;
  for (let round = 0; operations.length < PLAN_TOTAL && round < 400; round += 1) {
    for (const { group } of ordered) {
      if ((remaining.get(group) ?? 0) <= 0) continue;
      const cursor = cursors[group];
      switch (group) {
        case 'highlight': {
          const key = highlightKeys[cursor] ?? annotationKey();
          const pageIndex = pageIndexFor(cursor * 3);
          const value = highlightValue(types.HIGHLIGHT, pageIndex, cursor);
          emit(group, 'pdfjs-editor', 'annotation.create', {
            key,
            pageIndex,
            editorType: 'highlight',
            value,
          });
          createdHighlights.push({ key, index: cursor });
          highlightAttributes.set(key, {
            color: value.color as JsonValue,
            opacity: value.opacity as JsonValue,
          });
          break;
        }
        case 'freetext': {
          const pageIndex = pageIndexFor(cursor * 5);
          const rect: JsonValue[] = [72, 520 - (cursor % 6) * 30, 400, 540 - (cursor % 6) * 30];
          emit(group, 'pdfjs-editor', 'annotation.create', {
            key: annotationKey(),
            pageIndex,
            editorType: 'freetext',
            value: {
              annotationType: types.FREETEXT,
              pageIndex,
              rect,
              rotation: 0,
              structTreeParentId: null,
              popupRef: '',
              color: [17, 17, 17],
              fontSize: 12 + (cursor % 3),
              value: `Review note ${cursor + 1}: check the clause numbering.`,
            },
          });
          break;
        }
        case 'ink': {
          const pageIndex = pageIndexFor(cursor * 7);
          const rect: JsonValue[] = [100, 300, 320, 380];
          emit(group, 'pdfjs-editor', 'annotation.create', {
            key: annotationKey(),
            pageIndex,
            editorType: 'ink',
            value: {
              annotationType: types.INK,
              pageIndex,
              rect,
              rotation: 0,
              structTreeParentId: null,
              popupRef: '',
              color: [20, 60, 160],
              thickness: 2 + (cursor % 3),
              opacity: 0.9,
              paths: { points: [[100, 300, 180, 350, 260, 320, 320, 380]] },
            },
          });
          break;
        }
        case 'update': {
          // Only targets a highlight created earlier in the sequence, so the op is
          // always reversible against a value that exists.
          const target = createdHighlights[(cursor * 7) % createdHighlights.length];
          if (!target) break;
          const current = highlightAttributes.get(target.key) ?? { color: null, opacity: null };
          const color: JsonValue = [
            ...(HIGHLIGHT_COLORS[(cursor + 2) % HIGHLIGHT_COLORS.length] ?? [255, 226, 102]),
          ];
          const opacity: JsonValue = 0.3 + (cursor % 4) * 0.15;
          emit(group, 'pdfjs-editor', 'annotation.update', {
            key: target.key,
            pageIndex: pageIndexFor(target.index * 3),
            before: { color: current.color, opacity: current.opacity },
            after: { color, opacity },
          });
          highlightAttributes.set(target.key, { color, opacity });
          break;
        }
        case 'deleteCreate': {
          const pageIndex = pageIndexFor(cursor + 6);
          emit(group, 'pdfjs-editor', 'annotation.create', {
            key: reservedDeleteKey,
            pageIndex,
            editorType: 'highlight',
            value: highlightValue(types.HIGHLIGHT, pageIndex, 42),
          });
          break;
        }
        case 'delete': {
          const pageIndex = pageIndexFor(6);
          emit(group, 'pdfjs-editor', 'annotation.delete', {
            key: reservedDeleteKey,
            pageIndex,
            value: highlightValue(types.HIGHLIGHT, pageIndex, 42),
          });
          break;
        }
        case 'stamp': {
          const pageIndex = pageIndexFor(cursor + 2);
          const rect: JsonValue[] = [340, 430, 340 + stamp.width / 2, 430 + stamp.height / 2];
          stampIndex = operations.length;
          emit(group, 'pdfjs-editor', 'annotation.create', {
            key: annotationKey(),
            pageIndex,
            editorType: 'stamp',
            value: {
              annotationType: types.STAMP,
              pageIndex,
              rect,
              rotation: 0,
              structTreeParentId: null,
              popupRef: '',
              bitmapId: `image_spike_${crypto.randomUUID()}`,
              fileName: 'approved.png',
              isSvg: false,
              raster: {
                mime: 'image/png',
                width: stamp.width,
                height: stamp.height,
                bytes: stamp.dataUrlBytes,
                sha256: stamp.sha256,
                dataUrl: stamp.dataUrl,
              },
            },
          });
          break;
        }
        case 'rotate': {
          const target = pages[(cursor * 5) % pageCount];
          if (!target) break;
          const to = ROTATION_CYCLE[cursor % ROTATION_CYCLE.length] ?? 90;
          emit(group, 'model', 'page.rotate', { pageId: target.id, from: target.rotation, to });
          target.rotation = to;
          break;
        }
        case 'reorder': {
          const from = (cursor * 7) % pageCount;
          const to = (from + 3) % pageCount;
          const moved = pages[from];
          if (!moved) break;
          emit(group, 'model', 'page.reorder', { pageId: moved.id, from, to });
          pages.splice(from, 1);
          pages.splice(to, 0, moved);
          break;
        }
        default:
          throw new Error(`unhandled plan group ${String(group)}`);
      }
    }
  }

  if (operations.length !== PLAN_TOTAL) {
    throw new Error(`plan produced ${operations.length} operations, expected ${PLAN_TOTAL}`);
  }

  const distinctPayloads = new Set(
    operations.map((operation) => `${operation.kind}:${JSON.stringify(operation.payload)}`),
  );
  let engineTransitions = 0;
  const pageOpIndices: number[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (!operation) continue;
    if (operation.engine === 'model') pageOpIndices.push(index);
    const previous = operations[index - 1];
    if (previous && previous.engine !== operation.engine) engineTransitions += 1;
  }

  return {
    operations,
    counts,
    stats: {
      total: operations.length,
      distinct: distinctPayloads.size,
      pdfjsEditorOps: operations.filter((operation) => operation.engine === 'pdfjs-editor').length,
      modelOps: pageOpIndices.length,
      engineTransitions,
      firstPageOpIndex: pageOpIndices[0] ?? -1,
      lastPageOpIndex: pageOpIndices[pageOpIndices.length - 1] ?? -1,
      stampIndex,
      highlightKeys,
      reservedDeleteKey,
    },
  };
}
