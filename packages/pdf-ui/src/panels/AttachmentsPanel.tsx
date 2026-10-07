import { DownloadSimple, Plus, Trash } from '@phosphor-icons/react';
import { listPdfAttachments, type PdfAttachment, type PdfDocumentHandle, readPdfAttachment } from 'pdf-core';
import { type ToolError, type Translator, toToolError } from 'pdf-shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { PanelLoading, PanelMessage } from './PanelParts';

/**
 * The embedded files of the document ("Ekler"): what the file
 * carries with it, and the one action a reader has on them — write one out.
 *
 * Sizes are not part of the engine's attachment metadata (v6 hands out `filename`
 * and `description` only), so the payload is read once per attachment and released
 * again: the row can show how large the file is, and the save action reads it when
 * the user asks for it. Attachments are read one at a time, which keeps the peak at a
 * single file whichever document is open.
 *
 * Adding and removing are the writer half (`ops/attachments-write.ts`), reached the way
 * every other writer is: the panel holds no bytes, so it hands the picked files (or the
 * names to drop) to the shell, which runs the operation on the working document and
 * journals one step.
 */

export interface AttachmentsPanelProps {
  readonly document: PdfDocumentHandle;
  readonly t: Translator;
  /** The shell's notice line (`App.tsx` state) — receives already-translated text. */
  readonly onNotice?: (message: string) => void;
  /** Files to embed (`ops/attachments-write.ts`). The shell does the write; the panel has no bytes. */
  readonly onAdd: (files: readonly File[]) => void;
  /** Attachment names to remove, by the engine's own filename. */
  readonly onRemove: (names: readonly string[]) => void;
  /** The host is not taking writes right now (no document, viewing tier, busy). */
  readonly disabled?: boolean;
}

/** Blob URLs live until the browser has picked the file up, then are revoked. */
const REVOKE_DELAY_MS = 10_000;

/** File sizes as the locale writes them — no unit string of ours to translate. */
const SIZE_FORMATTERS = new Map<string, Intl.NumberFormat>();

function formatSize(bytes: number, locale: string): string {
  let formatter = SIZE_FORMATTERS.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte', unitDisplay: 'short' });
    SIZE_FORMATTERS.set(locale, formatter);
  }
  return formatter.format(bytes);
}

interface Downloads {
  save(blob: Blob, filename: string): void;
  release(): void;
}

/**
 * Object URLs, downloaded through an anchor and revoked once the browser has started
 * the file — the pattern the shell's Export and `SnapshotMenu` use.
 * URLs and timers are tracked so unmounting the panel leaves neither behind.
 */
function createDownloads(): Downloads {
  const urls = new Set<string>();
  const timers = new Set<number>();
  return {
    save: (blob, filename) => {
      const url = URL.createObjectURL(blob);
      urls.add(url);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.delete(url);
        timers.delete(timer);
      }, REVOKE_DELAY_MS);
      timers.add(timer);
    },
    release: () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    },
  };
}

/** Bytes of one attachment, or `null` for a payload the engine cannot read. */
async function sizeOf(document: PdfDocumentHandle, attachment: PdfAttachment): Promise<number | null> {
  try {
    return (await readPdfAttachment(document, attachment)).byteLength;
  } catch {
    // An unreadable payload costs its row its size and nothing else: the list stays
    // complete, and asking for the file reports the failure as a ToolError.
    return null;
  }
}

interface AttachmentsState {
  /** `null` while the engine has not answered yet. */
  readonly attachments: readonly PdfAttachment[] | null;
  /** Bytes per attachment id: `null` for a payload the engine could not read. */
  readonly sizes: ReadonlyMap<string, number | null>;
  readonly failure: ToolError | null;
}

const INITIAL: AttachmentsState = { attachments: null, sizes: new Map(), failure: null };

export function AttachmentsPanel({
  document,
  t,
  onNotice,
  onAdd,
  onRemove,
  disabled,
}: AttachmentsPanelProps) {
  const [state, setState] = useState<AttachmentsState>(INITIAL);
  const [saving, setSaving] = useState<string | null>(null);
  const downloads = useMemo(() => createDownloads(), []);
  /** The hidden file input the "Ekle" button opens. */
  const pickerRef = useRef<HTMLInputElement | null>(null);

  // The shell re-renders this panel with fresh props and a fresh translator on every
  // notice, so the readers below go through a ref: a document's attachment list must
  // not be read again just because a notice appeared.
  const handlers = useRef({ onNotice, t });
  useEffect(() => {
    handlers.current = { onNotice, t };
  });

  useEffect(() => () => downloads.release(), [downloads]);

  const report = useCallback((error: ToolError) => {
    const { onNotice: notify, t: translate } = handlers.current;
    notify?.(translate(error.messageKey));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState(INITIAL);

    void (async () => {
      try {
        const attachments = await listPdfAttachments(document);
        if (controller.signal.aborted) return;
        setState((previous) => ({ ...previous, attachments }));

        for (const attachment of attachments) {
          const size = await sizeOf(document, attachment);
          if (controller.signal.aborted) return;
          setState((previous) => ({
            ...previous,
            sizes: new Map(previous.sizes).set(attachment.id, size),
          }));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const failure = toToolError(error, 'ui');
        setState((previous) => ({ ...previous, failure }));
        report(failure);
      }
    })();

    return () => controller.abort();
  }, [document, report]);

  const save = useCallback(
    async (attachment: PdfAttachment) => {
      setSaving(attachment.id);
      try {
        const bytes = await readPdfAttachment(document, attachment);
        downloads.save(new Blob([bytes]), attachment.filename);
      } catch (error) {
        report(toToolError(error, 'ui'));
      } finally {
        setSaving(null);
      }
    },
    [document, downloads, report],
  );

  if (state.failure !== null) return <PanelMessage text={t(state.failure.messageKey)} />;
  if (state.attachments === null) return <PanelLoading />;

  const picker = (
    <div className="flex shrink-0 items-center gap-2 border-b border-kumo-line px-2 py-1.5">
      <input
        ref={pickerRef}
        type="file"
        multiple
        className="hidden"
        data-attachment-picker=""
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // The same file picked twice in a row has to fire again, so the input is
          // cleared the moment its value has been read.
          event.target.value = '';
          if (files.length > 0) onAdd(files);
        }}
      />
      <Button
        size="sm"
        variant="outline"
        icon={Plus}
        disabled={disabled === true}
        onClick={() => pickerRef.current?.click()}
      >
        {t('panel.attachments.add')}
      </Button>
    </div>
  );

  if (state.attachments.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {picker}
        <PanelMessage text={t('panel.attachments.empty')} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {picker}
      <ul className="min-h-0 flex-1 overflow-y-auto p-1" aria-label={t('panel.attachments')}>
        {state.attachments.map((attachment) => {
          // Until the payload is measured the row shows a dash, not a wrong number.
          const size = state.sizes.get(attachment.id);
          return (
            <li
              key={attachment.id}
              className="flex items-start gap-2 rounded-sm px-1.5 py-1 hover:bg-kumo-tint"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-kumo-default" title={attachment.filename}>
                  {attachment.filename}
                </span>
                {attachment.description.length === 0 ? null : (
                  <span
                    className="block truncate text-[11px] text-kumo-subtle"
                    title={attachment.description}
                  >
                    {attachment.description}
                  </span>
                )}
                <span className="block text-[11px] tabular-nums text-kumo-subtle">
                  {size === undefined || size === null ? '—' : formatSize(size, t.locale)}
                </span>
              </span>
              <Button
                size="sm"
                shape="base"
                icon={DownloadSimple}
                title={t('panel.attachments.save')}
                aria-label={t('panel.attachments.save')}
                disabled={saving === attachment.id}
                onClick={() => void save(attachment)}
              />
              <Button
                size="sm"
                shape="base"
                variant="outline"
                icon={Trash}
                title={t('panel.attachments.remove')}
                aria-label={`${t('panel.attachments.remove')}: ${attachment.filename}`}
                disabled={disabled === true}
                onClick={() => onRemove([attachment.filename])}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
