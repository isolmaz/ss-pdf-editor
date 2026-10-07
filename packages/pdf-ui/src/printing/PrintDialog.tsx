import { Checkbox } from '@cloudflare/kumo/components/checkbox';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input } from '@cloudflare/kumo/components/input';
import { Radio } from '@cloudflare/kumo/components/radio';
import { Select } from '@cloudflare/kumo/components/select';
import { Printer } from '@phosphor-icons/react';
import type { PrintDuplex, PrintImpositionOptions } from 'pdf-core';
import { type Translator, toToolError } from 'pdf-shared';
import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { parsePageRange } from './pageRange';
import { currentViewPages, resolvePrintSource } from './printSource';
import { type PrintProducedFile, type PrintScale, usePrinting } from './usePrinting';

/**
 * The print dialog ("printing with page range and scale";
 * The print dialog: "range, scale, N-up, booklet, duplex, margins and produce the PDF to
 * print").
 *
 * Two actions, one set of choices:
 *
 *  - **Yazdır** prepares the selected pages and hands them to the browser's own
 *    print dialog. It prints what the viewer shows, one page per sheet — the
 *    verified path, and the reason the
 *    imposition choices below are marked as belonging to the produced file
 *    (`print.imposeHint`) instead of pretending to change it.
 *  - **Yazdırılacak PDF'i üret** runs `buildPrintDocument` over the same pages and
 *    hands the imposed bytes to `onProduced`, which the shell opens in a new tab:
 *    that is where N-up, a saddle-stitch signature, duplex sides, margins and
 *    crop marks actually happen, because none of them is expressible in a browser
 *    print dialog.
 *
 * The shell mounts it with the viewer API and its own notice setter, so the
 * dialog never reaches into the shell's state (`PrintDialogProps`). Everything
 * the user reads comes from the dictionary; everything visual comes from the
 * Kumo wrappers in `components/**` or from Kumo primitives imported here.
 */

export interface PrintDialogProps {
  /** The interface language's translator: the dialog's words follow the shell's locale. */
  readonly t: Translator;
  readonly viewer: ViewerApi | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onNotice?: (message: string) => void;
  /**
   * The produced imposition, for the caller to open or keep. Absent means the
   * shell offers no place to put it, and the action is then not shown at all
   * rather than producing bytes nobody can reach.
   */
  readonly onProduced?: (file: PrintProducedFile) => void;
}

type RangeChoice = 'all' | 'current' | 'custom';

/** Cells per side, as the operation's own union. */
const PER_SHEET_CHOICES: readonly PrintImpositionOptions['perSheet'][] = [1, 2, 4, 6, 8, 9, 16];

export function PrintDialog({ t, viewer, open, onClose, onNotice, onProduced }: PrintDialogProps) {
  const [range, setRange] = useState<RangeChoice>('all');
  const [scale, setScale] = useState<PrintScale>('fit');
  const [rangeText, setRangeText] = useState('');
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [perSheet, setPerSheet] = useState<PrintImpositionOptions['perSheet']>(1);
  const [booklet, setBooklet] = useState(false);
  const [duplex, setDuplex] = useState<PrintDuplex>('simplex');
  const [marginMm, setMarginMm] = useState(0);
  const [produceError, setProduceError] = useState<string | null>(null);
  const printing = usePrinting(viewer, { onFinished: onClose });

  const source = resolvePrintSource(viewer);
  const busy = printing.phase === 'preparing' || printing.phase === 'producing';
  const failureText =
    printing.failure === null ? null : t('print.invalidRange', { value: printing.failure.page });
  const message = rangeError ?? failureText;
  // A refused imposition (an impossible combination, an over-limit count) is the
  // one failure the produced file can report: the dialog shows its own sentence
  // and hint instead of a generic line.
  const errorText = message ?? produceError;

  // A failed rasterisation is the one error that arrives after the click: the
  // shell's status line carries it past closing the dialog.
  useEffect(() => {
    if (failureText !== null) onNotice?.(failureText);
  }, [failureText, onNotice]);

  /** The pages the choices select, 1-based ascending, or `null` with the reason shown. */
  const selectedPages = (): readonly number[] | null => {
    if (source === null) return null;
    const pageCount = source.pageCount;

    let pages: readonly number[];
    if (range === 'all') {
      pages = Array.from({ length: pageCount }, (_unused, index) => index + 1);
    } else if (range === 'current') {
      pages = currentViewPages();
    } else {
      const parsed = parsePageRange(rangeText, pageCount);
      if (!parsed.ok) {
        const text =
          parsed.reason === 'invalid'
            ? t('print.invalidRange', { value: parsed.value })
            : t('print.emptyRange');
        setRangeError(text);
        onNotice?.(text);
        return null;
      }
      pages = parsed.pages;
    }

    if (pages.length === 0) {
      const text = t('print.emptyRange');
      setRangeError(text);
      onNotice?.(text);
      return null;
    }
    setRangeError(null);
    return pages;
  };

  /** The choices as one request — what both actions read. */
  const request = (pages: readonly number[]) => ({
    pages,
    scale,
    // A signature is four pages per sheet by definition, so the choice above it
    // cannot contradict it (the core refuses anything else).
    perSheet: booklet ? (4 as const) : perSheet,
    booklet,
    duplex,
    marginMm,
  });

  const startPrint = () => {
    const pages = selectedPages();
    if (pages === null) return;
    printing.start(request(pages));
  };

  const startProduce = async () => {
    const pages = selectedPages();
    if (pages === null || onProduced === undefined) return;
    setProduceError(null);
    try {
      const bytes = await printing.produce(request(pages));
      if (bytes === null) return;
      onProduced({ name: t('print.fileName'), bytes });
      onNotice?.(t('print.produced', { name: t('print.fileName') }));
    } catch (error) {
      // The engine's own sentence and hint (`pdf-shared/errors.ts`): a refused
      // combination states exactly which value is wrong.
      const failure = toToolError(error, 'ui');
      const text = `${t(failure.messageKey)} ${t(failure.hintKey)}`;
      setProduceError(text);
      onNotice?.(text);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next, details) => {
        // Escape and the backdrop are dropped while pages are being rendered: a
        // half-prepared job has nothing to print.
        if (busy) {
          details.cancel();
          return;
        }
        if (!next) onClose();
      }}
    >
      <Dialog className="flex max-h-[calc(100dvh-2rem)] flex-col gap-3 p-4">
        <Dialog.Title className="text-sm font-semibold text-kumo-strong">{t('print.title')}</Dialog.Title>
        {/* The choices scroll, the buttons do not: on a window shorter than the form the
            Print button used to sit below the viewport with no way to reach it. */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pe-1">
          <Radio.Group<RangeChoice>
            legend={t('print.range')}
            value={range}
            onValueChange={(value) => {
              setRange(value);
              setRangeError(null);
            }}
          >
            <Radio.Item label={t('print.rangeAll')} value="all" />
            <Radio.Item label={t('print.rangeCurrent')} value="current" />
            <Radio.Item label={t('print.rangeCustom')} value="custom" />
          </Radio.Group>

          {range === 'custom' ? (
            <Input
              size="sm"
              value={rangeText}
              autoFocus
              aria-label={t('print.range')}
              placeholder={t('print.rangePlaceholder')}
              onChange={(event) => {
                setRangeText(event.target.value);
                setRangeError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') startPrint();
              }}
            />
          ) : null}

          <Radio.Group<PrintScale> legend={t('print.scale')} value={scale} onValueChange={setScale}>
            <Radio.Item label={t('print.scaleFit')} value="fit" />
            <Radio.Item label={t('print.scaleShrink')} value="shrink-to-fit" />
            <Radio.Item label={t('print.scaleActual')} value="actual" />
          </Radio.Group>

          {/* The imposition controls belong to the produced file, and the sentence
            says so: a control that looked live while the browser path ignored it
            would be the dishonest version of this dialog. */}
          <p className="text-xs text-kumo-subtle">{t('print.imposeHint')}</p>

          {booklet ? null : (
            <Radio.Group<string>
              legend={t('print.perSheet')}
              value={String(perSheet)}
              onValueChange={(value) => setPerSheet(Number(value) as PrintImpositionOptions['perSheet'])}
            >
              {PER_SHEET_CHOICES.map((choice) => (
                <Radio.Item key={choice} label={String(choice)} value={String(choice)} />
              ))}
            </Radio.Group>
          )}

          <Checkbox
            checked={booklet}
            label={t('print.booklet')}
            labelTooltip={t('print.bookletHint')}
            // A signature is two panels on each of two sides: choosing it replaces
            // the grid above, and `4` is what the core then requires.
            onCheckedChange={(checked) => setBooklet(checked)}
          />

          <Select<string>
            size="sm"
            label={t('print.duplex')}
            description={booklet ? t('print.bookletHint') : t('print.duplexHint')}
            value={duplex}
            // Kumo's trigger prints the raw value unless it is told the label.
            renderValue={(value) =>
              t(
                value === 'long-edge'
                  ? 'print.duplex.longEdge'
                  : value === 'short-edge'
                    ? 'print.duplex.shortEdge'
                    : 'print.duplex.simplex',
              )
            }
            onValueChange={(next) => setDuplex((next ?? 'simplex') as PrintDuplex)}
          >
            <Select.Option value="simplex">{t('print.duplex.simplex')}</Select.Option>
            <Select.Option value="long-edge">{t('print.duplex.longEdge')}</Select.Option>
            <Select.Option value="short-edge">{t('print.duplex.shortEdge')}</Select.Option>
          </Select>

          <Input
            type="number"
            size="sm"
            label={t('print.margin')}
            description={t('print.marginHint')}
            min={0}
            max={50}
            step={1}
            value={String(marginMm)}
            onChange={(event) => setMarginMm(event.target.value === '' ? 0 : Number(event.target.value))}
          />

          {printing.phase === 'producing' ? (
            <p role="status" className="text-xs tabular-nums text-kumo-subtle">
              {t('print.producing', { done: printing.done, total: printing.total })}
            </p>
          ) : null}

          {printing.phase === 'preparing' ? (
            <p role="status" className="text-xs tabular-nums text-kumo-subtle">
              {t('print.preparing', { done: printing.done, total: printing.total })}
            </p>
          ) : null}

          {errorText === null ? null : (
            <p role="alert" className="text-xs text-kumo-danger">
              {errorText}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              printing.cancel();
              onClose();
            }}
          >
            {t('print.cancel')}
          </Button>
          {onProduced === undefined ? null : (
            <Button
              variant="outline"
              // Without the engine document there are no bytes to impose, and a
              // job already in flight must not be started twice.
              disabled={busy || source === null}
              onClick={() => void startProduce()}
            >
              {t('print.produce')}
            </Button>
          )}
          <Button
            icon={Printer}
            variant="primary"
            // Without the engine document there is nothing to rasterise — the same
            // reason a job in flight cannot be started twice.
            disabled={busy || source === null}
            onClick={startPrint}
          >
            {t('print.start')}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
