/**
 * Fill a dynamic XFA form (`pdf-core/ops/xfa-form.ts`).
 *
 * A dynamic XFA form has no PDF pages of its own, so the editor's viewer shows only the
 * "Please wait…" placeholder. This dialog opens the same bytes in **its own pdf.js document
 * with the XFA renderer on** (`openWithPdfjs(..., { enableXfa: true })`) and hosts a
 * `PDFViewer` over it: the template is laid out as HTML (`XfaLayer`), the fields are real
 * inputs, and whatever is typed goes into the document's annotation storage. Saving asks
 * pdf.js to serialise that storage into the `datasets` packet (an incremental update);
 * `finishXfaFill` then checks the result before the host makes it the working version.
 *
 * Why a dialog and not the main viewer: with the renderer on, pdf.js reports the XFA
 * template's page list, which is not the PDF's — every other part of the editor (page
 * model, MuPDF writers, verification) would disagree about how many pages there are. The
 * editor's documents never open with it; only this dialog and the XFA flatten do.
 *
 * Not run: XFA scripts (FormCalc, JavaScript), validations, calculations and dynamic
 * show/hide. A field that depends on one shows its stored value and does not react.
 */

import { Dialog } from '@cloudflare/kumo/components/dialog';
import { openWithPdfjs, type PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { OperationOutcome } from 'pdf-core/ops/types';
import { exportXfaData, finishXfaFill } from 'pdf-core/ops/xfa-form';
import { ToolError, type Translator, toToolError } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';

export interface XfaFormDialogProps {
  readonly t: Translator;
  /** The document's working bytes: engine edits applied, as every operation sees them. */
  readonly bytes: Uint8Array;
  readonly onClose: () => void;
  /** Make the verified bytes the working version; rejects with the reason it could not. */
  readonly onSave: (outcome: OperationOutcome & { readonly changed: number }) => Promise<void>;
  /** Hand a data file to the user (a download). */
  readonly onExport: (file: { name: string; bytes: Uint8Array; mime: string; values: number }) => void;
}

type Phase = 'loading' | 'ready' | 'failed';

/** pdf.js `AnnotationMode.ENABLE_FORMS`; the editors stay off (see `viewer/PdfViewerPane.tsx`). */
const ANNOTATION_MODE_ENABLE_FORMS = 2;
const ANNOTATION_EDITOR_DISABLE = -1;

export function XfaFormDialog({ t, bytes, onClose, onSave, onExport }: XfaFormDialogProps) {
  // State, not refs: the dialog's content mounts in a portal after this component, so the
  // elements arrive later than the first effect run.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [viewerElement, setViewerElement] = useState<HTMLDivElement | null>(null);
  const handleRef = useRef<PdfDocumentHandle | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [failure, setFailure] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /** Closing with typed values asks once: the values are not saved anywhere yet. */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Read when a failure is worded; a language change must not reload the form (and lose
  // what was typed), so the translator is not an effect dependency.
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (container === null || viewerElement === null) return undefined;
    let disposed = false;
    let teardown: (() => void) | null = null;

    void (async () => {
      try {
        const [{ EventBus, PDFLinkService, PDFViewer }] = await Promise.all([
          import('pdfjs-dist/web/pdf_viewer.mjs'),
          import('pdfjs-dist/web/pdf_viewer.css'),
        ]);
        const handle = await openWithPdfjs(bytes, { enableXfa: true });
        if (disposed) {
          await handle.destroy();
          return;
        }
        handleRef.current = handle;
        if (!handle.raw.isPureXfa) throw new ToolError('xfa-static', { engine: 'pdfjs' });

        const eventBus = new EventBus();
        const linkService = new PDFLinkService({ eventBus });
        const viewer = new PDFViewer({
          container,
          viewer: viewerElement,
          eventBus,
          linkService,
          annotationMode: ANNOTATION_MODE_ENABLE_FORMS,
          annotationEditorMode: ANNOTATION_EDITOR_DISABLE,
        });
        linkService.setViewer(viewer);
        eventBus.on('pagesinit', () => {
          viewer.currentScaleValue = 'page-width';
        });
        viewer.setDocument(handle.raw);
        linkService.setDocument(handle.raw);

        // The engine's own signal that a value was typed.
        const storage = handle.raw.annotationStorage as unknown as { onSetModified?: () => void };
        storage.onSetModified = () => setDirty(true);
        teardown = () => {
          storage.onSetModified = undefined;
          viewer.setDocument(null);
        };
        setPhase('ready');
      } catch (error) {
        if (disposed) return;
        const toolError = toToolError(error, 'pdfjs');
        setFailure(`${tRef.current(toolError.messageKey)} ${tRef.current(toolError.hintKey)}`);
        setPhase('failed');
      }
    })();

    return () => {
      disposed = true;
      teardown?.();
      const handle = handleRef.current;
      handleRef.current = null;
      if (handle !== null) void handle.destroy().catch(() => undefined);
    };
  }, [bytes, container, viewerElement]);

  /** The document with the typed values written into its datasets. */
  const savedBytes = useCallback(async (): Promise<Uint8Array> => {
    const handle = handleRef.current;
    if (handle === null) throw new ToolError('internal', { engine: 'ui', engineMessage: 'no XFA document' });
    return await handle.saveDocument();
  }, []);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const saved = await savedBytes();
      const outcome = await finishXfaFill(bytes, saved, { signal: new AbortController().signal });
      if (outcome.changed === 0) {
        setStatus(t('xfa.fill.nothing'));
        return;
      }
      await onSave(outcome);
    } catch (error) {
      const toolError = toToolError(error, 'pdfjs');
      setStatus(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
    } finally {
      setBusy(false);
    }
  };

  const requestClose = () => {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      setStatus(t('xfa.fill.unsaved'));
      return;
    }
    onClose();
  };

  const exportData = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      // What the form shows now, typed values included.
      const exported = await exportXfaData(await savedBytes());
      onExport(exported);
      setStatus(t('xfa.note.exported', { count: exported.values }));
    } catch (error) {
      const toolError = toToolError(error, 'pdfjs');
      setStatus(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open, details) => {
        if (open) return;
        details.cancel();
        requestClose();
      }}
    >
      <Dialog
        size="xl"
        className="pdf-floating-shadow flex max-h-[92vh] w-full flex-col gap-3 p-5 sm:w-[62rem]"
      >
        <Dialog.Title className="text-sm font-semibold text-kumo-strong">{t('xfa.fill.title')}</Dialog.Title>
        <Dialog.Description className="text-xs text-kumo-subtle">{t('xfa.fill.intro')}</Dialog.Description>

        <div className="relative h-[62vh] min-h-64 overflow-hidden rounded-md border border-kumo-line bg-kumo-canvas">
          <div ref={setContainer} className="absolute inset-0 overflow-auto" data-testid="xfa-viewer">
            <div ref={setViewerElement} className="pdfViewer" />
          </div>
          {phase === 'loading' ? (
            <p
              role="status"
              className="absolute inset-0 flex items-center justify-center text-xs text-kumo-subtle"
            >
              {t('xfa.fill.loading')}
            </p>
          ) : null}
          {phase === 'failed' ? (
            <p
              role="alert"
              className="absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-kumo-danger"
            >
              {failure}
            </p>
          ) : null}
        </div>

        <p className="text-[11px] text-kumo-subtle">{t('xfa.fill.limits')}</p>
        {status === null ? null : (
          <p role="status" className="text-xs text-kumo-default">
            {status}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" disabled={phase !== 'ready' || busy} onClick={() => void exportData()}>
            {t('xfa.fill.export')}
          </Button>
          <Button variant={confirmDiscard ? 'secondary-destructive' : 'outline'} onClick={requestClose}>
            {t(confirmDiscard ? 'xfa.fill.discard' : 'xfa.fill.close')}
          </Button>
          <Button
            variant="primary"
            disabled={phase !== 'ready' || busy || !dirty}
            onClick={() => void save()}
          >
            {t('xfa.fill.save')}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
