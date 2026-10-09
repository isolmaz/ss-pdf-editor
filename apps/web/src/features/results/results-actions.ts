/**
 * What becomes of a produced result: the accessibility writers' bytes land in the working
 * document, the scanner's pages and the print dialog's imposed file open as new tabs.
 *
 * The feature's own state is `results-store.ts`. What the shell still holds — the translator,
 * the way a tab becomes an operation context, the handle swap, the busy gate's abort
 * controller and the tab opener — arrives as `ResultsDeps`; the active tab, its handle and the
 * busy gate are read **at call time**.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { OperationNote } from 'pdf-core/ops/types';
import { type SessionStore, type SessionTab, workingPageCount } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import type { ScannedDocument } from 'pdf-ui/scan';
import { appendWarning, failureNotices, noticeLine } from '../../notices';
import { applyProducedBytes, type DocumentContext } from '../../operations';
import { isBusy, setBusy, showNotice } from '../core/core-store';
import { handleFor } from '../core/handles';
import { closePrintDialog, closeScanDialog } from './results-store';

/** What the shell still holds that the results handlers run on. */
export interface ResultsDeps {
  readonly session: SessionStore;
  readonly t: Translator;
  /** The context an operation on `tab` runs in. */
  readonly contextFor: (tab: SessionTab, handle: PdfDocumentHandle) => DocumentContext;
  /** Swap `tabId`'s engine handle for the one an operation produced. */
  readonly setHandle: (tabId: string, handle: PdfDocumentHandle) => void;
  /** Holds the abort controller of the run that owns the busy gate (the progress overlay's Cancel). */
  readonly cancelRef: { current: AbortController | null };
  /** Open produced bytes as a new tab; resolves with the stored-copy warning, if any. */
  readonly openProducedTab: (name: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<string | null>;
  /** Open the operation dialog `id` (the scanner's OCR offer). */
  readonly openDialog: (id: string) => void;
  /** Say the busy notice: a gesture the gate refused. */
  readonly refuseBusy: () => void;
  /** Say why a mark still staged blocks this, and report that it does. */
  readonly refuseUnappliedRedactions: () => boolean;
}

/** Bytes produced by an accessibility writer, with what it did. */
export interface AccessibilityOutcome {
  readonly bytes: Uint8Array;
  readonly notes: readonly OperationNote[];
  readonly steps: readonly string[];
}

/** The file the print dialog imposed. */
export interface PrintedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** What the results hosts hand to the dock and dialogs that produce a result. */
export interface ResultsActions {
  readonly applyAccessibility: (outcome: AccessibilityOutcome) => Promise<void>;
  readonly scanDocument: (result: ScannedDocument) => Promise<string | undefined>;
  readonly printProduced: (file: PrintedFile) => Promise<void>;
}

export function createResultsActions(deps: ResultsDeps): ResultsActions {
  const { t } = deps;

  /**
   * The accessibility writers' results arrive as bytes plus notes; they land in the session
   * exactly like every other produced file (journal entry → save router), so the panel never
   * writes a file of its own.
   */
  async function applyAccessibility(outcome: AccessibilityOutcome): Promise<void> {
    const tab = deps.session.active;
    const handle = tab === null ? null : (handleFor(tab.id) ?? null);
    if (tab === null || handle === null) return;
    const next = await applyProducedBytes(
      deps.contextFor(tab, handle),
      outcome.bytes,
      workingPageCount(tab),
      { key: 'a11y.applied', params: { count: outcome.notes.length } },
      'mupdf',
      outcome.steps,
    );
    deps.setHandle(tab.id, next);
    showNotice(t('a11y.applied', { count: outcome.notes.length }));
  }

  /**
   * The scanner's document: the pages the camera produced, opened as a new tab. With the
   * "offer OCR" box ticked the OCR dialog opens on the new tab once it exists — the existing
   * operation, with its own language choice and report, not a second recogniser.
   */
  async function scanDocument(result: ScannedDocument): Promise<string | undefined> {
    // The scanner is a modal: a notice set here would sit behind it, so a refusal or a
    // failure is returned to the dialog, which shows it where the user is looking.
    if (isBusy() || deps.cancelRef.current !== null) return t('op.busy');
    const controller = new AbortController();
    deps.cancelRef.current = controller;
    setBusy(true);
    let opened = false;
    try {
      const warning = await deps.openProducedTab(result.name, result.bytes, controller.signal);
      opened = true;
      closeScanDialog();
      showNotice(appendWarning(t('scan.opened', { count: result.pageCount, name: result.name }), warning));
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      return noticeLine(failureNotices(error, 'error.internal.message'), t);
    } finally {
      if (deps.cancelRef.current === controller) {
        deps.cancelRef.current = null;
        setBusy(false);
      }
    }
    // After the gate is released: `openDialog` refuses while an operation is running.
    if (opened && result.offerOcr) window.setTimeout(() => deps.openDialog('ocr'), 0);
    return undefined;
  }

  /**
   * The print dialog's imposed file (N-up, booklet, duplex sides): opened as a new tab, the
   * place a user can read, save or print it from.
   */
  async function printProduced(file: PrintedFile): Promise<void> {
    if (isBusy() || deps.cancelRef.current !== null) {
      deps.refuseBusy();
      return;
    }
    if (deps.refuseUnappliedRedactions()) return;
    const controller = new AbortController();
    deps.cancelRef.current = controller;
    setBusy(true);
    try {
      const warning = await deps.openProducedTab(file.name, file.bytes, controller.signal);
      closePrintDialog();
      // The print dialog has no success line of its own: the warning is the only notice.
      if (warning !== null) showNotice(warning);
    } catch (error) {
      if (controller.signal.aborted) return;
      showNotice(noticeLine(failureNotices(error, 'error.internal.message'), t));
    } finally {
      if (deps.cancelRef.current === controller) {
        deps.cancelRef.current = null;
        setBusy(false);
      }
    }
  }

  return { applyAccessibility, scanDocument, printProduced };
}
