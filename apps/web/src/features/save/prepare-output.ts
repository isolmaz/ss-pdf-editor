/**
 * The bytes a Save or an Export writes, prepared and checked: the one place a version of the
 * document becomes a deliverable file.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { fieldValueText } from 'pdf-core/ops/form-value';
import type { ProtectionState } from 'pdf-core/ops/security';
import { type SessionStore, type SessionTab, sha256Hex, workingPageCount } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { inspectProtection, verifySignatures } from '../../lazy-ops';
import {
  hasEngineEdits,
  materializeBase,
  pendingOverlays,
  verifyForWrite,
  type WriteVerification,
} from '../../operations';
import {
  appliedVersionBytes,
  signatureWarning as decideSignatureWarning,
  planSaveExecution,
  type SaveExecutionPlan,
  type SaveStepDescription,
} from '../../save-plan';
import { showNotice } from '../core/core-store';
import { documentContext } from '../core/document';
import { handleFor } from '../core/handles';
import { currentFacts, currentFactsError } from '../facts/facts-store';
import { confirmSignature } from '../facts/signature-prompt';
import { trustStore } from '../facts/trust-store';
import { currentForms } from '../forms/forms-store';
import { editableOverlays } from '../marks/overlays';

/** What the shell still holds that preparing an output runs on. */
export interface PrepareHost {
  readonly session: SessionStore;
  readonly t: Translator;
}

/** The checked bytes of a version, with everything a save records about them. */
export interface PreparedOutput {
  readonly tab: SessionTab;
  readonly handle: PdfDocumentHandle;
  readonly bytes: Uint8Array;
  readonly outputProtection: ProtectionState;
  readonly execution: SaveExecutionPlan;
  readonly outputHash: string;
  readonly verification: WriteVerification;
}

/**
 * Materialize `tabId`'s current version into bytes and verify them, or say why not and return
 * `null`: while the document's facts or form inventory are unread, while redaction marks are
 * unapplied, when the user declines the signature warning, or when the document moved on while
 * they were asked. `executedSteps` collects the steps this run itself executed.
 */
export async function prepareOutput(
  host: PrepareHost,
  tabId: string,
  controller: AbortController,
  executedSteps: SaveStepDescription[] = [],
): Promise<PreparedOutput | null> {
  const { session, t } = host;
  const tab = session.getSnapshot().tabs.find((item) => item.id === tabId) ?? null;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  if (tab === null || handle === null) return null;

  const forms = currentForms(tab);
  const formFields = forms?.fields;
  if (currentFacts(tab) === null || formFields === undefined) {
    showNotice(
      t(currentFactsError(tab) !== null || forms?.error ? 'inspection.failed' : 'inspection.loading'),
    );
    return null;
  }

  /**
   * Redaction marks are **not** applied by materialization: they are intents the user
   * has staged, and the destructive step is theirs to run. Refusing here is the whole
   * point — the alternative is a Save that marks the tab clean while the delivered file
   * still contains the content the user asked to remove. This is deliberately
   * not automatic redaction; the user applies or clears the marks.
   */
  if (pendingOverlays(tab).redactions.length > 0) {
    showNotice(`${t('error.pending-redactions.message')} ${t('error.pending-redactions.hint')}`);
    return null;
  }

  const base = await materializeBase(
    documentContext(session, t, tab, handle),
    { signal: controller.signal },
    executedSteps,
    editableOverlays(tab),
  );
  const outputProtection = await inspectProtection(base);

  const execution = planSaveExecution({
    tab,
    engineDirty: hasEngineEdits(handle),
    annotations: editableOverlays(tab).annotations,
    baseBytes: base,
    encryptedOutput: outputProtection.encrypted,
    executedSteps,
  });

  // The opened file and the produced version are each judged against their own
  // bytes (`signatureWarning`): an edit that already broke the opened file's
  // signature is still announced, and a just-signed export is not.
  const warning = await decideSignatureWarning(
    base,
    tab.source.master,
    tab.working.produced?.bytes ?? null,
    (bytes) => verifySignatures(bytes, controller.signal, { roots: trustStore.get().rootBytes }),
    appliedVersionBytes(tab, session.snapshotsFor(tab.id)),
  );
  if (warning !== null && !(await confirmSignature(warning.signatures, warning.fate === 'appended', t))) {
    return null;
  }

  if (
    controller.signal.aborted ||
    session.getSnapshot().tabs.find((item) => item.id === tab.id)?.working.id !== tab.working.id
  ) {
    return null;
  }

  /**
   * The run's **own** steps identify the operation: the historical steps are
   * already inside the live handle these bytes are compared against, so declaring
   * them again would only weaken the promise the check makes. What the run itself
   * materialised — engine values, annotations, measurements — is exactly the delta
   * verification has to allow for.
   */
  const verification = await verifyForWrite(base, {
    expectedPageCount: workingPageCount(tab),
    sourceHandle: handle,
    steps: executedSteps.map((step) => step.id),
    expectedFormFields: formFields.map((field) => ({
      name: field.name,
      value: fieldValueText(field.value),
    })),
    signal: controller.signal,
  });

  const outputHash = await sha256Hex(base);
  return { tab, handle, bytes: base, outputProtection, execution, outputHash, verification };
}
