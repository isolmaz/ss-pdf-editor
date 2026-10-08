import { Dialog } from '@cloudflare/kumo/components/dialog';
import { X } from '@phosphor-icons/react';
import { formatBytes } from 'pdf-core/ops/types';
import type { Translator } from 'pdf-shared';
import { useId, useState } from 'react';
import { Button } from '../components/Button';

type OfficeLayout = 'layout' | 'flow' | 'page-images';

export interface ExportOptions {
  readonly kind: 'pdf' | 'compressed' | 'images' | 'text' | 'office';
  readonly compressionLevel?: 'high' | 'medium' | 'low';
  readonly imageFormat?: 'png' | 'jpg';
  readonly officeFormat?: 'docx' | 'xlsx' | 'csv';
  /** Word only: the exact layout (text boxes), flowing text, or one picture per page. */
  readonly officeLayout?: OfficeLayout;
}

export interface ExportDialogProps {
  readonly open: boolean;
  readonly t: Translator;
  readonly fileName: string;
  /** Byte length of the document as it stands: the latest produced version, else the opened file. */
  readonly fileSize: number;
  readonly onClose: () => void;
  readonly onExport: (options: ExportOptions) => void;
}

export function ExportDialog({ open, t, fileName, fileSize, onClose, onExport }: ExportDialogProps) {
  const [selectedKind, setSelectedKind] = useState<ExportOptions['kind']>('pdf');
  const [compressionLevel, setCompressionLevel] = useState<'high' | 'medium' | 'low'>('medium');
  const [imageFormat, setImageFormat] = useState<'png' | 'jpg'>('png');
  const [officeFormat, setOfficeFormat] = useState<'docx' | 'xlsx' | 'csv'>('docx');
  const [officeLayout, setOfficeLayout] = useState<OfficeLayout>('layout');
  const formId = useId();

  const handleDownload = () => {
    onExport({
      kind: selectedKind,
      compressionLevel,
      imageFormat,
      officeFormat,
      officeLayout,
    });
    onClose();
  };

  return (
    <Dialog.Root
      open={open}
      // The shell opens the dialog (it has no trigger), so the popup only ever asks to close.
      onOpenChange={() => onClose()}
    >
      <Dialog
        size="base"
        className="flex max-w-md w-full flex-col gap-4 rounded-xl border border-kumo-line bg-kumo-base p-5 pdf-floating-shadow"
      >
        <div className="flex items-center justify-between">
          <Dialog.Title className="text-base font-bold text-kumo-strong">{t('export.title')}</Dialog.Title>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('op.close')}
            className="flex size-7 items-center justify-center rounded-md text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-strong transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-2.5 select-none">
          {/* Option 1: Current PDF */}
          <label
            className={`flex cursor-pointer items-center justify-between rounded-lg border p-3 transition-all ${
              selectedKind === 'pdf'
                ? 'border-pdf-accent bg-pdf-accent/10 shadow-xs'
                : 'border-kumo-line/80 bg-kumo-recessed/30 hover:bg-kumo-recessed/70'
            }`}
          >
            <div className="flex items-center gap-3">
              <input
                type="radio"
                name={`${formId}-export-kind`}
                checked={selectedKind === 'pdf'}
                onChange={() => setSelectedKind('pdf')}
                className="size-4 text-pdf-accent accent-pdf-accent"
              />
              <span className="text-xs font-semibold text-kumo-strong">
                {t('export.thisPdf', { size: formatBytes(fileSize) })}
              </span>
            </div>
            <span className="text-[11px] font-medium text-kumo-subtle truncate max-w-[140px]">
              {fileName}
            </span>
          </label>

          {/* Option 2: Compressed PDF */}
          <label
            className={`flex cursor-pointer items-center justify-between rounded-lg border p-3 transition-all ${
              selectedKind === 'compressed'
                ? 'border-pdf-accent bg-pdf-accent/10 shadow-xs'
                : 'border-kumo-line/80 bg-kumo-recessed/30 hover:bg-kumo-recessed/70'
            }`}
          >
            <div className="flex items-center gap-3">
              <input
                type="radio"
                name={`${formId}-export-kind`}
                checked={selectedKind === 'compressed'}
                onChange={() => setSelectedKind('compressed')}
                className="size-4 text-pdf-accent accent-pdf-accent"
              />
              <span className="text-xs font-semibold text-kumo-strong">{t('export.compressed')}</span>
            </div>
            <select
              value={compressionLevel}
              disabled={selectedKind !== 'compressed'}
              onChange={(e) => setCompressionLevel(e.target.value as 'high' | 'medium' | 'low')}
              className="rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-[11px] font-semibold uppercase text-kumo-strong outline-none focus:border-pdf-accent disabled:opacity-40"
              onClick={(e) => e.stopPropagation()}
            >
              <option value="high">{t('export.levelHigh')}</option>
              <option value="medium">{t('export.levelMedium')}</option>
              <option value="low">{t('export.levelLow')}</option>
            </select>
          </label>

          {/* Section: File Formats */}
          <div className="mt-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-kumo-subtle">
              {t('export.fileFormats')}
            </span>
          </div>

          {/* Option 3: Images */}
          <label
            className={`flex cursor-pointer items-center justify-between rounded-lg border p-3 transition-all ${
              selectedKind === 'images'
                ? 'border-pdf-accent bg-pdf-accent/10 shadow-xs'
                : 'border-kumo-line/80 bg-kumo-recessed/30 hover:bg-kumo-recessed/70'
            }`}
          >
            <div className="flex items-center gap-3">
              <input
                type="radio"
                name={`${formId}-export-kind`}
                checked={selectedKind === 'images'}
                onChange={() => setSelectedKind('images')}
                className="size-4 text-pdf-accent accent-pdf-accent"
              />
              <span className="text-xs font-semibold text-kumo-strong">{t('export.imageFormat')}</span>
            </div>
            <select
              value={imageFormat}
              disabled={selectedKind !== 'images'}
              onChange={(e) => setImageFormat(e.target.value as 'png' | 'jpg')}
              className="rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-[11px] font-semibold uppercase text-kumo-strong outline-none focus:border-pdf-accent disabled:opacity-40"
              onClick={(e) => e.stopPropagation()}
            >
              <option value="png">PNG</option>
              <option value="jpg">JPG</option>
            </select>
          </label>

          {/* Option 4: Text format */}
          <label
            className={`flex cursor-pointer items-center justify-between rounded-lg border p-3 transition-all ${
              selectedKind === 'text'
                ? 'border-pdf-accent bg-pdf-accent/10 shadow-xs'
                : 'border-kumo-line/80 bg-kumo-recessed/30 hover:bg-kumo-recessed/70'
            }`}
          >
            <div className="flex items-center gap-3">
              <input
                type="radio"
                name={`${formId}-export-kind`}
                checked={selectedKind === 'text'}
                onChange={() => setSelectedKind('text')}
                className="size-4 text-pdf-accent accent-pdf-accent"
              />
              <span className="text-xs font-semibold text-kumo-strong">{t('export.textFormat')}</span>
            </div>
            <span className="rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-[11px] font-semibold uppercase text-kumo-subtle">
              TXT
            </span>
          </label>

          {/* Option 5: Word, Excel or CSV */}
          <label
            className={`flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-all ${
              selectedKind === 'office'
                ? 'border-pdf-accent bg-pdf-accent/10 shadow-xs'
                : 'border-kumo-line/80 bg-kumo-recessed/30 hover:bg-kumo-recessed/70'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <input
                  type="radio"
                  name={`${formId}-export-kind`}
                  checked={selectedKind === 'office'}
                  onChange={() => setSelectedKind('office')}
                  className="size-4 text-pdf-accent accent-pdf-accent"
                />
                <span className="text-xs font-semibold text-kumo-strong">{t('export.office.option')}</span>
              </div>
              <select
                value={officeFormat}
                disabled={selectedKind !== 'office'}
                onChange={(e) => setOfficeFormat(e.target.value as 'docx' | 'xlsx' | 'csv')}
                aria-label={t('export.office.format')}
                className="rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-[11px] font-semibold uppercase text-kumo-strong outline-none focus:border-pdf-accent disabled:opacity-40"
                onClick={(e) => e.stopPropagation()}
              >
                <option value="docx">DOCX</option>
                <option value="xlsx">XLSX</option>
                <option value="csv">CSV</option>
              </select>
            </div>
            {selectedKind === 'office' && officeFormat === 'docx' && (
              <select
                value={officeLayout}
                onChange={(e) => setOfficeLayout(e.target.value as OfficeLayout)}
                aria-label={t('export.office.layout')}
                className="w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-[11px] font-semibold text-kumo-strong outline-none focus:border-pdf-accent"
                onClick={(e) => e.stopPropagation()}
              >
                <option value="layout">{t('export.office.layout.exact')}</option>
                <option value="flow">{t('export.office.layout.flow')}</option>
                <option value="page-images">{t('export.office.layout.pageImages')}</option>
              </select>
            )}
          </label>
        </div>

        <div className="mt-2">
          <Button
            variant="primary"
            size="lg"
            onClick={handleDownload}
            className="w-full justify-center bg-pdf-accent text-pdf-on-accent font-semibold py-2.5 rounded-lg shadow-xs hover:opacity-95 transition-opacity"
          >
            {selectedKind === 'pdf'
              ? t('export.downloadPdf')
              : selectedKind === 'compressed'
                ? t('export.downloadCompressed')
                : selectedKind === 'images'
                  ? t('export.downloadImages')
                  : selectedKind === 'office'
                    ? t('export.office.download')
                    : t('export.downloadText')}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
