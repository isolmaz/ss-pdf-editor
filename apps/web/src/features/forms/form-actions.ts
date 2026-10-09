/**
 * What the user does with a form: open the dynamic XFA form, save it back, fill one field from
 * the panel, detect fields on a flat page and add the ones they kept. Every handler reads the
 * stores at the moment it runs. The shell's own gates and writers are handed in, because other
 * features share them.
 */

import type { OperationOutcome } from 'pdf-core';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { fieldValueText } from 'pdf-core/ops/form-value';
import { type SessionStore, type SessionTab, workingPageCount } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { fillFormFields, inspectXfa } from '../../lazy-ops';
import { applyProducedBytes, type DocumentContext, materializeBase } from '../../operations';
import { clearNotice, isBusy, openRightPanel, selectRightTab, setBusy, showNotice } from '../core/core-store';
import { handleFor } from '../core/handles';
import type { WriteFileAnnotation } from '../marks/host';
import {
  currentDetect,
  currentForms,
  detectCancelled,
  detectFinished,
  detectStarted,
  formsStore,
  xfaFormClosed,
  xfaFormOpened,
} from './forms-store';

/** What the handlers need from the shell. */
export interface FormsHost {
  readonly store: Pick<SessionStore, 'active'>;
  readonly t: Translator;
  readonly contextFor: (tab: SessionTab, handle: PdfDocumentHandle) => DocumentContext;
  /** Say that the document is busy. */
  readonly refuseBusy: () => void;
  /** Swap the tab's engine handle for the one an operation produced. */
  readonly setHandle: (tabId: string, handle: PdfDocumentHandle) => void;
  /** A cancellable operation (open, save, a tool run) is in flight. */
  readonly operationRunning: () => boolean;
}

/** An error as the status line words it: what happened, then what to do. */
function failureNotice(error: unknown, t: Translator): string {
  const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
  return `${t(toolError.messageKey)} ${t(toolError.hintKey)}`;
}

/**
 * Open the dynamic XFA form in its dialog, from the bytes of the version on screen. A static
 * XFA, or none, is refused with the reason; a version that landed while the bytes were being
 * read keeps the dialog shut.
 */
export async function openXfaForm(
  host: Pick<FormsHost, 'store' | 't' | 'contextFor' | 'refuseBusy' | 'operationRunning'>,
): Promise<void> {
  const { store, t } = host;
  const tab = store.active;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  if (tab === null || handle === null) return;
  if (isBusy() || host.operationRunning()) {
    host.refuseBusy();
    return;
  }
  clearNotice();
  setBusy(true);
  try {
    const bytes = await materializeBase(host.contextFor(tab, handle));
    const info = await inspectXfa(bytes);
    if (info === null) throw new ToolError('no-xfa', { engine: 'mupdf' });
    if (info.kind === 'static') throw new ToolError('xfa-static', { engine: 'mupdf' });
    if (store.active?.id === tab.id && store.active.working.id === tab.working.id) {
      xfaFormOpened({ tab, bytes });
    }
  } catch (error) {
    showNotice(failureNotice(error, t));
  } finally {
    setBusy(false);
  }
}

/** The XFA dialog's verified bytes become the tab's next working version. */
export async function saveXfaForm(
  outcome: OperationOutcome & { readonly changed: number },
  host: Pick<FormsHost, 't' | 'contextFor' | 'setHandle'>,
): Promise<void> {
  const form = formsStore.get().xfaForm;
  const handle = form === null ? null : (handleFor(form.tab.id) ?? null);
  if (form === null || handle === null) return;
  const next = await applyProducedBytes(
    host.contextFor(form.tab, handle),
    outcome.bytes,
    workingPageCount(form.tab),
    { key: 'xfa.note.dataSaved', params: { count: outcome.changed } },
    outcome.report.engine,
    outcome.report.steps,
  );
  host.setHandle(form.tab.id, next);
  xfaFormClosed();
  showNotice(host.t('xfa.fill.saved', { count: outcome.changed }));
}

/**
 * One field filled from the panel: the value goes through the same operation the dialog uses,
 * then the produced bytes become the tab's working version — so the change is journaled,
 * undoable and visible in the viewer like every other edit.
 *
 * A write that would repeat the value the document already holds is dropped here, at the
 * single point every fill goes through. The inline control commits on blur as well as on
 * submit, so one edit arrived as **six identical writes** — six working versions, six journal
 * entries and six inventory reloads — and that churn is what a real press cannot survive:
 * measured, the same click that deletes two pages on a quiet panel does nothing after a fill.
 * The operation is the same one the dialog uses; only a no-op is skipped.
 */
export async function fillField(
  name: string,
  value: string | boolean,
  host: Pick<FormsHost, 'store' | 't' | 'contextFor' | 'refuseBusy' | 'setHandle'>,
): Promise<void> {
  const { store, t } = host;
  const tab = store.active;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  if (tab === null || handle === null) return;
  const current = currentForms(tab)?.fields?.find((field) => field.name === name);
  if (current !== undefined && fieldValueText(current.value) === String(value)) return;
  if (isBusy()) {
    host.refuseBusy();
    return;
  }
  setBusy(true);
  try {
    const base = await materializeBase(host.contextFor(tab, handle));
    const outcome = await fillFormFields(base, [{ name, value }], {
      signal: new AbortController().signal,
    });
    const next = await applyProducedBytes(
      host.contextFor(tab, handle),
      outcome.bytes,
      workingPageCount(tab),
      { key: 'form.note.filled', params: { count: 1 } },
      outcome.report.engine,
      outcome.report.steps,
    );
    host.setHandle(tab.id, next);
    showNotice(t('op.result.applied', { label: t('panel.forms') }));
  } catch (error) {
    showNotice(failureNotice(error, t));
  } finally {
    setBusy(false);
  }
}

/**
 * Detect fields: a read of the working bytes (`pdf-core/ops/form-detect.ts`), so nothing is
 * journaled and nothing can be lost. The result is only kept while it still describes the
 * version it was read from; a version that landed in the meantime drops it.
 */
export async function startFormDetect(
  host: Pick<FormsHost, 'store' | 't' | 'contextFor' | 'refuseBusy'>,
): Promise<void> {
  const { store, t } = host;
  const tab = store.active;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  if (tab === null || handle === null) return;
  if (isBusy()) {
    host.refuseBusy();
    return;
  }
  const version = tab.working.id;
  openRightPanel('forms');
  detectStarted(tab.id, version);
  try {
    const base = await materializeBase(host.contextFor(tab, handle));
    // A dynamic chunk: the detector stays out of the shell's first paint.
    const { detectFormFields } = await import('pdf-core/ops/form-detect');
    const detection = await detectFormFields(base, { signal: new AbortController().signal });
    detectFinished(tab.id, version, detection);
    if (detection.candidates.length === 0) showNotice(t('formDetect.panel.none'));
  } catch (error) {
    detectCancelled();
    showNotice(failureNotice(error, t));
  }
}

/**
 * Add the candidates the user kept as real form fields: one journal step that undo takes back
 * whole, written through the same boundary as a placed stamp. The operation reads the result
 * back (name, type, page, rectangle) before it returns.
 */
export function applyFormDetect(
  host: Pick<FormsHost, 'store' | 't'> & { readonly writeFileAnnotation: WriteFileAnnotation },
): void {
  const review = currentDetect(host.store.active);
  if (review?.detection == null || review.phase !== 'review') return;
  const kept = review.detection.candidates.filter((candidate) => !review.removed.has(candidate.id));
  if (kept.length === 0) return;
  selectRightTab('forms');
  host.writeFileAnnotation(
    { key: 'formDetect.note.created', params: { count: kept.length } },
    async (base, signal) => {
      // A dynamic chunk: the detector stays out of the shell's first paint.
      const { createDetectedFields } = await import('pdf-core/ops/form-detect');
      return await createDetectedFields(base, kept, { signal });
    },
    host.t('formDetect.done', { count: kept.length }),
  );
}
