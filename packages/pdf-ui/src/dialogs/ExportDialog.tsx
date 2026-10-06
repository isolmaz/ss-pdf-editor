import { Dialog } from '@cloudflare/kumo/components/dialog';
import { X } from '@phosphor-icons/react';
import type { Translator } from 'pdf-shared';
import { useId, useState } from 'react';
import { Button } from '../components/Button';

export interface ExportOptions {
  readonly kind: 'pdf' | 'compressed' | 'images' | 'text';
  readonly compressionLevel?: 'high' | 'medium' | 'low';
  readonly imageFormat?: 'png' | 'jpg';
}

export interface ExportDialogProps {
  readonly open: boolean;
  readonly t?: Translator;
  readonly fileName: string;
  readonly fileSizeFormatted?: string;
  readonly onClose: () => void;
  readonly onExport: (options: ExportOptions) => void;
}

export function ExportDialog({
  open,
  t,
  fileName,
  fileSizeFormatted = '2.4 KB',
  onClose,
  onExport,
}: ExportDialogProps) {
  const [selectedKind, setSelectedKind] = useState<'pdf' | 'compressed' | 'images' | 'text'>('pdf');
  const [compressionLevel, setCompressionLevel] = useState<'high' | 'medium' | 'low'>('medium');
  const [imageFormat, setImageFormat] = useState<'png' | 'jpg'>('png');
  const formId = useId();

  const handleDownload = () => {
    onExport({
      kind: selectedKind,
      compressionLevel,
      imageFormat,
    });
    onClose();
  };

  const text_ = (key: string, params?: Record<string, string | number>) => {
    if (!t) return key;
    return t(key as never, params as never);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog
        size="base"
        className="flex max-w-md w-full flex-col gap-4 rounded-xl border border-kumo-line bg-kumo-base p-5 pdf-floating-shadow"
      >
        {/* Header matching Image #3 */}
        <div className="flex items-center justify-between">
          <Dialog.Title className="text-base font-bold text-kumo-strong">
            {text_('export.title')}
          </Dialog.Title>
          <button
            type="button"
            onClick={onClose}
            aria-label={text_('op.close')}
            className="flex size-7 items-center justify-center rounded-md text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-strong transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Options list matching Image #3 */}
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
                {text_('export.thisPdf', { size: fileSizeFormatted })}
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
              <span className="text-xs font-semibold text-kumo-strong">{text_('export.compressed')}</span>
            </div>
            <select
              value={compressionLevel}
              disabled={selectedKind !== 'compressed'}
              onChange={(e) => setCompressionLevel(e.target.value as 'high' | 'medium' | 'low')}
              className="rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-[11px] font-semibold uppercase text-kumo-strong outline-none focus:border-pdf-accent disabled:opacity-40"
              onClick={(e) => e.stopPropagation()}
            >
              <option value="high">{text_('export.levelHigh')}</option>
              <option value="medium">{text_('export.levelMedium')}</option>
              <option value="low">{text_('export.levelLow')}</option>
            </select>
          </label>

          {/* Section: File Formats */}
          <div className="mt-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-kumo-subtle">
              {text_('export.fileFormats')}
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
              <span className="text-xs font-semibold text-kumo-strong">{text_('export.imageFormat')}</span>
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
              <span className="text-xs font-semibold text-kumo-strong">{text_('export.textFormat')}</span>
            </div>
            <span className="rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-[11px] font-semibold uppercase text-kumo-subtle">
              TXT
            </span>
          </label>
        </div>

        {/* Primary Download Button matching Image #3 */}
        <div className="mt-2">
          <Button
            variant="primary"
            size="lg"
            onClick={handleDownload}
            className="w-full justify-center bg-pdf-accent text-pdf-on-accent font-semibold py-2.5 rounded-lg shadow-xs hover:opacity-95 transition-opacity"
          >
            {selectedKind === 'pdf'
              ? text_('export.downloadPdf')
              : selectedKind === 'compressed'
                ? text_('export.downloadCompressed')
                : selectedKind === 'images'
                  ? text_('export.downloadImages')
                  : text_('export.downloadText')}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
