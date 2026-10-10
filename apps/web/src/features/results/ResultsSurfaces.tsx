/**
 * The surfaces that carry a produced result — the print dialog, the camera scanner and the
 * accessibility and PDF/A dock panels — wired to the results store and the notice line. Each
 * loads on demand: they are reached by a gesture, so none belongs in the first paint.
 */

import type { OperationContext } from 'pdf-core/ops/types';
import type { Translator } from 'pdf-shared';
import type { ScannedDocument } from 'pdf-ui/scan';
import type { ViewerApi } from 'pdf-ui/viewer';
import { lazy, Suspense } from 'react';
import { showNotice } from '../core/core-store';
import type { AccessibilityOutcome, PrintedFile } from './results-actions';
import { closePrintDialog, closeScanDialog, useResults } from './results-store';

/**
 * Printing is the one surface that puts Kumo's dialog/select/checkbox/input/radio primitives
 * on the first-paint graph, so it loads on demand — and `main.tsx` prefetches it while the
 * browser is idle, so the first `Ctrl+P` is not a visible wait.
 */
const PrintDialog = lazy(async () => {
  const module = await import('pdf-ui/printing');
  return { default: module.PrintDialog };
});
/**
 * The camera scanner: live preview, edge detection, perspective correction and filters
 * (`pdf-ui/src/scan`). Its own chunk: the detector and the warp are needed only here.
 */
const ScanDialog = lazy(async () => {
  const module = await import('pdf-ui/scan');
  return { default: module.ScanDialog };
});
/** The accessibility and PDF/A panels read the working bytes, so they ride the dock panels' own boundary. */
const AccessibilityPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.AccessibilityPanel };
});
const PdfAPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.PdfAPanel };
});

/** The text a dock panel shows while its chunk loads. */
function PanelFallback({ label }: { readonly label: string }) {
  return (
    <p aria-busy="true" className="p-2 text-xs text-kumo-subtle">
      {label}
    </p>
  );
}

export interface PrintDialogHostProps {
  readonly t: Translator;
  readonly viewer: ViewerApi | null;
  /** The file the dialog imposed, to open as a new tab. */
  readonly onProduced: (file: PrintedFile) => Promise<void>;
}

/** Mounted only while the store says the print dialog is open. */
export function PrintDialogHost({ t, viewer, onProduced }: PrintDialogHostProps) {
  const printOpen = useResults((state) => state.printOpen);
  if (!printOpen) return null;
  return (
    <Suspense fallback={null}>
      <PrintDialog
        t={t}
        viewer={viewer}
        open={printOpen}
        onClose={closePrintDialog}
        onNotice={showNotice}
        onProduced={(file) => void onProduced(file)}
      />
    </Suspense>
  );
}

export interface ScanDialogHostProps {
  readonly t: Translator;
  /** Open the scanned pages as a document; resolves with a sentence when it could not. */
  readonly onDocument: (result: ScannedDocument) => Promise<string | undefined>;
}

/** Mounted only while the store says the scanner is open. */
export function ScanDialogHost({ t, onDocument }: ScanDialogHostProps) {
  const scanOpen = useResults((state) => state.scanOpen);
  if (!scanOpen) return null;
  return (
    <Suspense fallback={null}>
      <ScanDialog t={t} mode="document" onClose={closeScanDialog} onDocument={onDocument} />
    </Suspense>
  );
}

export interface AccessibilityDockProps {
  readonly t: Translator;
  /** The working bytes, read when a button is pressed. */
  readonly read: (context: OperationContext) => Promise<Uint8Array>;
  /**
   * The document's own language cannot be guessed; the interface's is what the shell knows,
   * and the report says which one it wrote.
   */
  readonly language: string;
  readonly currentPage: number;
  readonly canEdit: boolean;
  readonly onGoToPage: (pageIndex: number) => void;
  /** Bytes a PDF/UA fix, the tags editor or the alt-text writer produced. */
  readonly onWritten: (outcome: AccessibilityOutcome) => Promise<void>;
}

/** The right dock's accessibility tab. */
export function AccessibilityDock({
  t,
  read,
  language,
  currentPage,
  canEdit,
  onGoToPage,
  onWritten,
}: AccessibilityDockProps) {
  const apply = (outcome: AccessibilityOutcome) => void onWritten(outcome);
  return (
    <Suspense fallback={<PanelFallback label={t('panel.accessibility')} />}>
      <AccessibilityPanel
        t={t}
        read={read}
        language={language}
        currentPage={currentPage}
        canEdit={canEdit}
        onGoToPage={onGoToPage}
        onWritten={apply}
        onTagged={apply}
        onAltWritten={apply}
        onNotice={showNotice}
      />
    </Suspense>
  );
}

export interface PdfADockProps {
  readonly t: Translator;
  /** The working bytes, read when a button is pressed. */
  readonly read: (context: OperationContext) => Promise<Uint8Array>;
  /** Open the "Save as PDF/A" dialog. */
  readonly onConvert: () => void;
}

/** The right dock's PDF/A tab. */
export function PdfADock({ t, read, onConvert }: PdfADockProps) {
  return (
    <Suspense fallback={<PanelFallback label={t('panel.pdfa')} />}>
      <PdfAPanel t={t} read={read} onConvert={onConvert} onNotice={showNotice} />
    </Suspense>
  );
}
