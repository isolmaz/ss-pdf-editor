/**
 * Scan with the camera: the dialog.
 *
 * Three screens over one list of pages: the **camera** (live preview, or photos picked from
 * files), the **crop** (the photograph with the four corners the detector found, to be
 * dragged onto the page's real corners, and the straightened result beside it), and the
 * **pages** (thumbnails to reorder, retake and delete, the filter, the output settings).
 *
 * The same dialog serves two doors:
 *  - `document` (home screen, File menu): the pages become a new PDF
 *    (`scanPagesToPdf`), handed to the shell to open in a new tab, with the choice of being
 *    offered OCR on it;
 *  - `pages` (the insert-pages flow): the straightened pages come back as JPEG files, which
 *    the insert dialog places like any other picked images.
 *
 * Everything runs here: the photographs never leave the page (`img-src` and `connect-src`
 * of the CSP would refuse it anyway), and the camera stream is stopped the moment the camera
 * screen is left.
 */

import { Checkbox } from '@cloudflare/kumo/components/checkbox';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Select } from '@cloudflare/kumo/components/select';
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowRight,
  Camera,
  Crop,
  Plus,
  Trash,
} from '@phosphor-icons/react';
import { type ScanPageSize, scanPagesToPdf } from 'pdf-core/ops/scan';
import { paintRaster } from 'pdf-core/ops/scan-browser';
import { isConvexQuad, type Quad, type QuarterTurns, type RasterImage } from 'pdf-core/ops/scan-geometry';
import { PREVIEW_LONG_SIDE, type ScanFilter } from 'pdf-core/ops/scan-image';
import type { OperationReport } from 'pdf-core/ops/types';
import { type MessageKey, type Translator, toToolError } from 'pdf-shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { CameraView } from './CameraView';
import { CornerEditor } from './CornerEditor';
import { FittedStage } from './FittedStage';
import {
  type Draft,
  exportPage,
  MAX_SCAN_PAGES,
  makeDraft,
  QUALITY_PRESETS,
  type QualityPreset,
  redetect,
  renderPreview,
  type ScanPageState,
} from './scan-pages';

export interface ScannedDocument {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly report: OperationReport;
  /** The user asked to be offered OCR once the document is open. */
  readonly offerOcr: boolean;
}

export interface ScanDialogProps {
  readonly t: Translator;
  /** `document`: make a PDF. `pages`: hand back the straightened pages as JPEG files. */
  readonly mode: 'document' | 'pages';
  readonly onClose: () => void;
  /**
   * Hand the PDF to the shell. Resolving with a sentence means the shell did not open it:
   * the dialog shows that sentence and stays open, because the shell's own notice sits
   * behind this modal and the user would otherwise see "Create PDF" do nothing.
   */
  readonly onDocument?: (result: ScannedDocument) => Promise<string | undefined> | undefined;
  readonly onPages?: (files: readonly File[]) => void;
}

type View = 'camera' | 'crop' | 'pages';

/** What the crop screen is doing for the draft: a new page, replacing one, or fixing one. */
type Target =
  | { readonly kind: 'new' }
  | { readonly kind: 'retake'; readonly id: number }
  | { readonly kind: 'edit'; readonly id: number };

const FILTERS: readonly { readonly id: ScanFilter; readonly key: MessageKey }[] = [
  { id: 'original', key: 'scan.filter.original' },
  { id: 'grayscale', key: 'scan.filter.grayscale' },
  { id: 'bw', key: 'scan.filter.bw' },
  { id: 'enhanced', key: 'scan.filter.enhanced' },
];

const SIZE_OPTIONS: readonly { readonly id: ScanPageSize; readonly key: MessageKey }[] = [
  { id: 'a4', key: 'scan.output.size.a4' },
  { id: 'letter', key: 'scan.output.size.letter' },
  { id: 'fit', key: 'scan.output.size.fit' },
];

const QUALITY_OPTIONS: readonly { readonly id: QualityPreset; readonly key: MessageKey }[] = [
  { id: 'low', key: 'scan.output.quality.low' },
  { id: 'medium', key: 'scan.output.quality.medium' },
  { id: 'high', key: 'scan.output.quality.high' },
];

/** Paint `raster` into a canvas that scales to its box (`object-contain`). */
function RasterCanvas({
  raster,
  className,
  label,
}: {
  readonly raster: RasterImage | null;
  readonly className: string;
  readonly label: string;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const element = canvas.current;
    if (element !== null && raster !== null) paintRaster(element, raster);
  }, [raster]);
  return <canvas ref={canvas} role="img" aria-label={label} className={className} />;
}

/** A page rendered (straightened, filtered) off the main paint, kept while its inputs hold. */
function useRendered(page: ScanPageState | null, longSide: number): RasterImage | null {
  const [raster, setRaster] = useState<RasterImage | null>(null);
  useEffect(() => {
    if (page === null) {
      setRaster(null);
      return;
    }
    // A tick of delay: dragging a corner or flipping filters should not queue a render for
    // every intermediate state.
    const timer = window.setTimeout(() => setRaster(renderPreview(page, longSide)), 16);
    return () => window.clearTimeout(timer);
  }, [page, longSide]);
  return raster;
}

function PageThumb({
  page,
  t,
  index,
}: {
  readonly page: ScanPageState;
  readonly t: Translator;
  readonly index: number;
}) {
  const raster = useRendered(page, 220);
  return (
    <RasterCanvas
      raster={raster}
      label={t('scan.page.label', { n: index + 1 })}
      className="h-24 w-[4.5rem] rounded-sm bg-white object-contain"
    />
  );
}

export function ScanDialog({ t, mode, onClose, onDocument, onPages }: ScanDialogProps) {
  const [view, setView] = useState<View>('camera');
  const [pages, setPages] = useState<readonly ScanPageState[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [queue, setQueue] = useState<readonly { readonly blob: Blob; readonly name: string }[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftQuad, setDraftQuad] = useState<Quad | null>(null);
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>({ kind: 'new' });
  const [decoding, setDecoding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [applyAll, setApplyAll] = useState(true);
  const [filter, setFilter] = useState<ScanFilter>('enhanced');
  const [size, setSize] = useState<ScanPageSize>('a4');
  const [quality, setQuality] = useState<QualityPreset>('medium');
  const [offerOcr, setOfferOcr] = useState(true);
  const [building, setBuilding] = useState<{ readonly done: number; readonly total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const nextId = useRef(1);
  const abort = useRef<AbortController | null>(null);

  const selected = useMemo(
    () => pages.find((page) => page.id === selectedId) ?? pages[0] ?? null,
    [pages, selectedId],
  );

  // The draft's photograph as an object URL for the corner editor, revoked when it changes.
  useEffect(() => {
    if (draft === null) {
      setDraftUrl(null);
      return;
    }
    const url = URL.createObjectURL(draft.blob);
    setDraftUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [draft]);

  // Whatever is running stops with the dialog.
  useEffect(() => () => abort.current?.abort(), []);

  /** Take the next photograph from the queue to the crop screen. */
  const openNext = useCallback(
    async (
      waiting: readonly { readonly blob: Blob; readonly name: string }[],
      into: Target,
      /** A photograph before these could not be opened: its notice stays on screen. */
      carryNotice = false,
    ) => {
      const [next, ...rest] = waiting;
      if (next === undefined) {
        setDraft(null);
        setDraftQuad(null);
        setView('pages');
        return;
      }
      setDecoding(true);
      if (!carryNotice) setNotice(null);
      try {
        const made = await makeDraft(next.blob, next.name);
        setQueue(rest);
        setTarget(into);
        setDraft(made);
        setDraftQuad(made.quad);
        setView('crop');
      } catch {
        setNotice(t('scan.page.decodeFailed', { name: next.name }));
        setQueue(rest);
        // Carry on with the rest of the photographs; a damaged one must not stop the batch.
        if (rest.length > 0) await openNext(rest, into, true);
        else setView(pages.length > 0 ? 'pages' : 'camera');
      } finally {
        setDecoding(false);
      }
    },
    [pages.length, t],
  );

  const onPhotos = useCallback(
    (photos: readonly { readonly blob: Blob; readonly name: string }[]) => {
      const room = MAX_SCAN_PAGES - pages.length + (target.kind === 'retake' ? 1 : 0);
      const accepted = photos.slice(0, Math.max(0, room));
      if (accepted.length < photos.length) setNotice(t('scan.page.limit', { max: MAX_SCAN_PAGES }));
      if (accepted.length === 0) return;
      void openNext(accepted, target.kind === 'retake' ? target : { kind: 'new' });
    },
    [openNext, pages.length, t, target],
  );

  const acceptDraft = () => {
    if (draft === null || draftQuad === null || !isConvexQuad(draftQuad)) return;
    if (target.kind === 'edit') {
      const id = target.id;
      setPages((all) => all.map((page) => (page.id === id ? { ...page, quad: draftQuad } : page)));
      setSelectedId(id);
    } else {
      const page: ScanPageState = {
        id: target.kind === 'retake' ? target.id : nextId.current++,
        name: draft.name,
        blob: draft.blob,
        preview: draft.preview,
        quad: draftQuad,
        turns: 0,
        filter,
      };
      setPages((all) => {
        if (target.kind === 'retake')
          return all.map((item) => (item.id === page.id ? { ...page, filter: item.filter } : item));
        return [...all, page];
      });
      setSelectedId(page.id);
    }
    // Photographs still waiting come next; otherwise the pages.
    if (queue.length > 0) void openNext(queue, { kind: 'new' });
    else {
      setDraft(null);
      setDraftQuad(null);
      setTarget({ kind: 'new' });
      setView('pages');
    }
  };

  const skipDraft = () => {
    if (queue.length > 0) void openNext(queue, target.kind === 'retake' ? { kind: 'new' } : target);
    else {
      setDraft(null);
      setDraftQuad(null);
      setTarget({ kind: 'new' });
      setView(pages.length > 0 ? 'pages' : 'camera');
    }
  };

  const update = (id: number, change: Partial<Pick<ScanPageState, 'turns' | 'filter'>>) =>
    setPages((all) => all.map((page) => (page.id === id ? { ...page, ...change } : page)));

  const chooseFilter = (next: ScanFilter) => {
    setFilter(next);
    if (applyAll) setPages((all) => all.map((page) => ({ ...page, filter: next })));
    else if (selected !== null) update(selected.id, { filter: next });
  };

  const move = (id: number, by: -1 | 1) =>
    setPages((all) => {
      const from = all.findIndex((page) => page.id === id);
      const to = from + by;
      if (from < 0 || to < 0 || to >= all.length) return all;
      const next = [...all];
      const [item] = next.splice(from, 1);
      if (item !== undefined) next.splice(to, 0, item);
      return next;
    });

  const remove = (id: number) => {
    const at = pages.findIndex((page) => page.id === id);
    const rest = pages.filter((page) => page.id !== id);
    setPages(rest);
    setSelectedId(rest[Math.min(at, rest.length - 1)]?.id ?? null);
    if (rest.length === 0) setView('camera');
  };

  const editCorners = (page: ScanPageState) => {
    setTarget({ kind: 'edit', id: page.id });
    setDraft({ name: page.name, blob: page.blob, preview: page.preview, quad: page.quad, detected: true });
    setDraftQuad(page.quad);
    setQueue([]);
    setView('crop');
  };

  const build = async () => {
    if (pages.length === 0 || building !== null) return;
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setBuilding({ done: 0, total: pages.length });
    try {
      const exported = [];
      for (const [index, page] of pages.entries()) {
        setBuilding({ done: index + 1, total: pages.length });
        // Let the progress line paint before the page's heavy, synchronous work starts.
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        exported.push(await exportPage(page, QUALITY_PRESETS[quality], index));
        if (controller.signal.aborted) return;
      }
      if (mode === 'pages') {
        onPages?.(
          exported.map((page) => new File([page.bytes as BlobPart], page.name, { type: 'image/jpeg' })),
        );
        return;
      }
      const outcome = await scanPagesToPdf(
        { pages: exported, pageSize: size },
        { signal: controller.signal },
      );
      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
      const refusal = await onDocument?.({
        name: t('scan.fileName', { stamp }),
        bytes: outcome.bytes,
        pageCount: outcome.report.pageCount,
        report: outcome.report,
        offerOcr,
      });
      if (refusal !== undefined) setError(refusal);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const failure = toToolError(cause, 'ui');
      setError(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    } finally {
      setBuilding(null);
    }
  };

  const requestClose = () => {
    if (building !== null) return;
    if (pages.length > 0 && !confirmClose) setConfirmClose(true);
    else onClose();
  };

  const selectedIndex = selected === null ? -1 : pages.findIndex((page) => page.id === selected.id);
  const rotate = (page: ScanPageState, by: 1 | 3) =>
    update(page.id, { turns: ((page.turns + by) % 4) as QuarterTurns });
  // The straightened result beside the corners. Memoised: a new object every render would
  // make `useRendered` start over every time it painted.
  const draftPage = useMemo<ScanPageState | null>(
    () =>
      draft !== null && draftQuad !== null && isConvexQuad(draftQuad)
        ? {
            id: -1,
            name: draft.name,
            blob: draft.blob,
            preview: draft.preview,
            quad: draftQuad,
            turns: 0,
            filter,
          }
        : null,
    [draft, draftQuad, filter],
  );
  const croppedPreview = useRendered(draftPage, 420);
  const sizeLabel = (id: ScanPageSize) =>
    t(SIZE_OPTIONS.find((option) => option.id === id)?.key ?? 'scan.output.size.a4');
  const qualityLabel = (id: QualityPreset) =>
    t(QUALITY_OPTIONS.find((option) => option.id === id)?.key ?? 'scan.output.quality.medium');

  return (
    <Dialog.Root
      open
      // The shell opens the dialog (it has no trigger), so the popup only ever asks to close.
      onOpenChange={(_open, details) => {
        details.cancel();
        requestClose();
      }}
    >
      <Dialog
        size="xl"
        className="pdf-floating-shadow flex h-[calc(100dvh-3rem)] w-full max-w-[calc(100vw-1rem)] flex-col gap-2 overflow-hidden p-3 sm:h-[min(calc(100dvh-5rem),820px)] sm:w-[min(96vw,1000px)] sm:p-5"
      >
        <Dialog.Title className="text-sm font-semibold text-kumo-strong">{t('scan.title')}</Dialog.Title>
        <Dialog.Description className="hidden text-xs text-kumo-subtle sm:block">
          {t('scan.intro')}
        </Dialog.Description>

        {notice === null ? null : (
          <p
            role="status"
            className="rounded-sm border border-kumo-line bg-kumo-tint px-2 py-1 text-xs text-kumo-default"
          >
            {notice}
          </p>
        )}
        {decoding ? (
          <p role="status" className="text-xs text-kumo-subtle">
            {t('op.running')}
          </p>
        ) : null}

        {confirmClose ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-sm border border-kumo-line bg-kumo-tint px-3 py-2"
          >
            <p className="flex-1 text-xs text-kumo-strong">{t('scan.discard')}</p>
            <Button variant="outline" onClick={() => setConfirmClose(false)}>
              {t('scan.discard.no')}
            </Button>
            <Button variant="destructive" onClick={onClose}>
              {t('scan.discard.yes')}
            </Button>
          </div>
        ) : null}

        {view === 'camera' ? (
          <CameraView
            t={t}
            onPhotos={onPhotos}
            pageCount={pages.length}
            onShowPages={() => setView('pages')}
            disabled={decoding}
          />
        ) : null}

        {view === 'crop' && draft !== null && draftQuad !== null && draftUrl !== null ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <h3 className="text-xs font-semibold text-kumo-strong">{t('scan.crop.title')}</h3>
              {queue.length > 0 ? (
                <span className="text-[11px] text-kumo-subtle">
                  {t('scan.crop.next', { current: 1, total: queue.length + 1 })}
                </span>
              ) : null}
            </div>
            <p className="text-[11px] text-kumo-subtle">
              {draft.detected ? t('scan.crop.found') : t('scan.crop.notFound')} {t('scan.crop.hint')}
            </p>
            <div className="flex min-h-0 flex-1 flex-col gap-2 sm:flex-row">
              <div className="min-h-[200px] flex-1 rounded-md bg-kumo-recessed">
                <CornerEditor
                  t={t}
                  imageUrl={draftUrl}
                  aspect={draft.preview.width / draft.preview.height}
                  quad={draftQuad}
                  onChange={setDraftQuad}
                />
              </div>
              <div className="hidden w-44 shrink-0 flex-col gap-1 sm:flex">
                <span className="text-[11px] text-kumo-subtle">{t('scan.crop.preview')}</span>
                <RasterCanvas
                  raster={croppedPreview}
                  label={t('scan.crop.preview')}
                  className="min-h-0 w-full flex-1 rounded-sm border border-kumo-line bg-white object-contain object-top"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    const found = redetect(draft.preview);
                    setDraft({ ...draft, quad: found.quad, detected: found.detected });
                    setDraftQuad(found.quad);
                  }}
                >
                  {t('scan.crop.auto')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    setDraftQuad([
                      { x: 0, y: 0 },
                      { x: 1, y: 0 },
                      { x: 1, y: 1 },
                      { x: 0, y: 1 },
                    ])
                  }
                >
                  {t('scan.crop.whole')}
                </Button>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={skipDraft}>
                  {target.kind === 'edit' || queue.length === 0 ? t('op.cancel') : t('scan.crop.skip')}
                </Button>
                <Button variant="primary" disabled={!isConvexQuad(draftQuad)} onClick={acceptDraft}>
                  {target.kind === 'edit' ? t('scan.crop.apply') : t('scan.crop.done')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {view === 'pages' ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto sm:overflow-hidden">
            <div className="flex min-h-[260px] flex-1 flex-col gap-2 sm:min-h-0 sm:flex-row">
              <div className="min-h-[240px] flex-1 rounded-md bg-kumo-recessed p-2">
                {selected === null ? (
                  <p className="p-4 text-center text-xs text-kumo-subtle">{t('scan.page.empty')}</p>
                ) : (
                  <PagePreview page={selected} t={t} index={selectedIndex} />
                )}
              </div>

              <div className="flex shrink-0 flex-col gap-2 sm:w-60 sm:overflow-y-auto">
                <fieldset className="flex flex-col gap-1">
                  <legend className="mb-1 text-[11px] font-medium text-kumo-default">
                    {t('scan.filter')}
                  </legend>
                  <div className="grid grid-cols-2 gap-1">
                    {FILTERS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={(selected?.filter ?? filter) === item.id}
                        onClick={() => chooseFilter(item.id)}
                        className={`rounded-md border px-2 py-1.5 text-xs ${
                          (selected?.filter ?? filter) === item.id
                            ? 'border-pdf-accent bg-kumo-tint font-semibold text-kumo-strong'
                            : 'border-kumo-line text-kumo-default hover:bg-kumo-tint'
                        }`}
                      >
                        {t(item.key)}
                      </button>
                    ))}
                  </div>
                  <Checkbox label={t('scan.filter.all')} checked={applyAll} onCheckedChange={setApplyAll} />
                </fieldset>

                {mode === 'document' ? (
                  <Select<ScanPageSize>
                    size="sm"
                    label={t('scan.output.size')}
                    value={size}
                    renderValue={(value) => sizeLabel(value)}
                    onValueChange={(next) => setSize(next ?? 'a4')}
                  >
                    {SIZE_OPTIONS.map((option) => (
                      <Select.Option key={option.id} value={option.id}>
                        {t(option.key)}
                      </Select.Option>
                    ))}
                  </Select>
                ) : null}
                <Select<QualityPreset>
                  size="sm"
                  label={t('scan.output.quality')}
                  value={quality}
                  renderValue={(value) => qualityLabel(value)}
                  onValueChange={(next) => setQuality(next ?? 'medium')}
                >
                  {QUALITY_OPTIONS.map((option) => (
                    <Select.Option key={option.id} value={option.id}>
                      {t(option.key)}
                    </Select.Option>
                  ))}
                </Select>
                {mode === 'document' ? (
                  <Checkbox label={t('scan.output.ocr')} checked={offerOcr} onCheckedChange={setOfferOcr} />
                ) : null}
              </div>
            </div>

            {selected === null ? null : (
              <div
                className="flex flex-wrap items-center gap-1"
                role="toolbar"
                aria-label={t('scan.page.label', { n: selectedIndex + 1 })}
              >
                <Button
                  variant="outline"
                  aria-label={t('scan.page.moveEarlier', { n: selectedIndex + 1 })}
                  disabled={selectedIndex <= 0}
                  onClick={() => move(selected.id, -1)}
                >
                  <ArrowLeft size={15} className="rtl:-scale-x-100" aria-hidden="true" />
                </Button>
                <Button
                  variant="outline"
                  aria-label={t('scan.page.moveLater', { n: selectedIndex + 1 })}
                  disabled={selectedIndex >= pages.length - 1}
                  onClick={() => move(selected.id, 1)}
                >
                  <ArrowRight size={15} className="rtl:-scale-x-100" aria-hidden="true" />
                </Button>
                <Button
                  variant="outline"
                  aria-label={t('scan.page.rotateLeft')}
                  onClick={() => rotate(selected, 3)}
                >
                  <ArrowCounterClockwise size={15} aria-hidden="true" />
                </Button>
                <Button
                  variant="outline"
                  aria-label={t('scan.page.rotateRight')}
                  onClick={() => rotate(selected, 1)}
                >
                  <ArrowClockwise size={15} aria-hidden="true" />
                </Button>
                <Button variant="outline" onClick={() => editCorners(selected)}>
                  <Crop size={15} aria-hidden="true" />
                  {t('scan.page.corners')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setTarget({ kind: 'retake', id: selected.id });
                    setView('camera');
                  }}
                >
                  <Camera size={15} aria-hidden="true" />
                  {t('scan.page.retake')}
                </Button>
                <Button variant="secondary-destructive" onClick={() => remove(selected.id)}>
                  <Trash size={15} aria-hidden="true" />
                  {t('scan.page.delete')}
                </Button>
              </div>
            )}

            <ul aria-label={t('scan.page.list')} className="flex shrink-0 gap-2 overflow-x-auto pb-1">
              {pages.map((page, index) => (
                <li key={page.id} className="shrink-0">
                  <button
                    type="button"
                    aria-label={t('scan.page.select', { n: index + 1 })}
                    aria-current={page.id === selected?.id}
                    onClick={() => setSelectedId(page.id)}
                    className={`relative rounded-md border-2 p-0.5 ${page.id === selected?.id ? 'border-pdf-accent' : 'border-kumo-line'}`}
                  >
                    <PageThumb page={page} t={t} index={index} />
                    <span className="absolute bottom-1 start-1 rounded bg-black/65 px-1 text-[10px] text-white">
                      {index + 1}
                    </span>
                  </button>
                </li>
              ))}
              <li className="shrink-0">
                <button
                  type="button"
                  disabled={pages.length >= MAX_SCAN_PAGES}
                  onClick={() => {
                    setTarget({ kind: 'new' });
                    setView('camera');
                  }}
                  className="flex h-[6.75rem] w-20 flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-kumo-line text-[11px] text-kumo-default hover:bg-kumo-tint disabled:opacity-40"
                >
                  <Plus size={18} aria-hidden="true" />
                  {t('scan.page.add')}
                </button>
              </li>
            </ul>

            {building === null ? null : (
              <p role="status" className="text-xs text-kumo-subtle">
                {t('scan.building', building)}
              </p>
            )}
            {error === null ? null : (
              <p
                role="alert"
                className="rounded-sm border border-kumo-line bg-kumo-tint px-2 py-1.5 text-xs text-kumo-danger"
              >
                {error}
              </p>
            )}

            <div className="flex shrink-0 justify-end gap-2 border-t border-kumo-line/40 pt-2">
              <Button variant="outline" onClick={requestClose} disabled={building !== null}>
                {t('scan.close')}
              </Button>
              <Button
                variant="primary"
                disabled={pages.length === 0 || building !== null}
                onClick={() => void build()}
                data-testid="scan-create"
              >
                {mode === 'document' ? t('scan.create') : t('scan.use', { count: pages.length })}
              </Button>
            </div>
          </div>
        ) : null}

        {view === 'camera' ? (
          <div className="flex shrink-0 justify-end">
            <Button variant="ghost" onClick={requestClose}>
              {t('scan.close')}
            </Button>
          </div>
        ) : null}
      </Dialog>
    </Dialog.Root>
  );
}

/** The selected page, large. */
function PagePreview({
  page,
  t,
  index,
}: {
  readonly page: ScanPageState;
  readonly t: Translator;
  readonly index: number;
}) {
  const raster = useRendered(page, PREVIEW_LONG_SIDE);
  return (
    <FittedStage aspect={raster === null ? Math.SQRT1_2 : raster.width / raster.height} className="size-full">
      <RasterCanvas
        raster={raster}
        label={t('scan.page.label', { n: index + 1 })}
        className="size-full rounded-sm bg-white shadow"
      />
    </FittedStage>
  );
}
