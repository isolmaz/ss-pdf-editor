/**
 * The writer pipeline: what happens after a MuPDF writer ran on the working document.
 *
 * Three panels reach a MuPDF writer this way (layer state, attachments add and remove), and the
 * rules they share are the ones that are easy to get subtly wrong: a report that changed nothing
 * must not be journaled (`incremental: true` is the op's own "same bytes back"), the notice
 * carries every note the report is not merely preserving — warnings and losses included, because
 * a panel has no report surface — and the handle swap is what makes the produced bytes the
 * working version.
 */

import type { OperationOutcome } from 'pdf-core';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { LayerWriteRequest } from 'pdf-core/ops/layer-write';
import type { SessionTab } from 'pdf-model';
import type { MessageKey } from 'pdf-shared';
import { applyLayerWrite } from '../../lazy-ops';
import { applyProducedBytes, materializeBase } from '../../operations';
import { showNotice } from '../core/core-store';
import { documentContext } from '../core/document';
import { runGatedOperation } from '../core/gated-operation';
import { handleFor, swapHandle } from '../core/handles';
import type { WriterHost } from './host';

/**
 * A writer ran on the working document: journal it, swap the handle, and say what the
 * report said. `signal` is the running operation's: a Cancel pressed before the bytes land
 * keeps them out of the session.
 */
export async function applyWriterOutcome(
  host: WriterHost,
  tab: SessionTab,
  handle: PdfDocumentHandle,
  outcome: OperationOutcome,
  labelKey: MessageKey,
  signal: AbortSignal,
): Promise<void> {
  const { t } = host;
  if (outcome.report.incremental) {
    const unchanged = outcome.report.notes.find((entry) => entry.kind !== 'preserved');
    showNotice(unchanged === undefined ? t(labelKey) : t(unchanged.key, unchanged.params ?? {}));
    return;
  }
  const next = await applyProducedBytes(
    documentContext(host.session, t, tab, handle),
    outcome.bytes,
    outcome.report.pageCount,
    { key: labelKey },
    outcome.report.engine,
    outcome.report.steps,
    { signal },
  );
  swapHandle(t, tab.id, next);
  const spoken = outcome.report.notes
    .filter((entry) => entry.kind !== 'preserved')
    .map((entry) => t(entry.key, entry.params ?? {}));
  showNotice(spoken.length === 0 ? t(labelKey) : spoken.join(' '));
}

/**
 * The layers panel writes the view state it shows into the file
 * (“layers (OCG) view/edit”).
 *
 * The panel holds the engine's view state and no bytes; this file holds the bytes and
 * no view, so the request travels from there to here — the same ownership rule every
 * other write follows. The bytes are the *working* document, session marks included,
 * so a layer write cannot drop an annotation the user has drawn but not yet saved.
 */
export async function writeLayers(host: WriterHost, request: LayerWriteRequest): Promise<void> {
  const tab = host.session.active;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  if (tab === null || handle === null) return;
  // Read at call time, like every other control that replaces the handle: a panel
  // rendered one commit earlier holds that commit's closure.
  await runGatedOperation(host.t, async (signal) => {
    const bytes = await materializeBase(documentContext(host.session, host.t, tab, handle), { signal });
    const outcome = await applyLayerWrite(bytes, request, { signal });
    await applyWriterOutcome(host, tab, handle, outcome, 'panel.layers', signal);
  });
}
