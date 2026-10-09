/**
 * Embedded files: listing the ones a document carries, reading one out, and the writes that
 * add or remove them.
 *
 * The feature owns no state of its own — the busy gate and the status line are the core's, the
 * tabs are the session's, the engine handle is `core/handles.ts`'s — so this module is the
 * handlers alone. They take what the shell still holds (the translator, the way a tab is
 * turned into an operation context, the handle swap and the shared writer pipeline) as
 * `AttachmentDeps`, and read the active tab, its handle and the busy gate **at call time**.
 */

import type { OperationOutcome } from 'pdf-core';
import { listPdfAttachments, readPdfAttachment } from 'pdf-core/attachments';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { type SessionStore, type SessionTab, workingPageCount } from 'pdf-model';
import { type MessageKey, ToolError, type Translator } from 'pdf-shared';
import type { AttachmentRow } from 'pdf-ui';
import { addAttachments, removeAttachments } from '../../lazy-ops';
import { applyProducedBytes, type DocumentContext, downloadFiles, materializeBase } from '../../operations';
import { isBusy, setBusy, showNotice } from '../core/core-store';
import { handleFor } from '../core/handles';

/** What the shell still holds that the attachment handlers run on. */
export interface AttachmentDeps {
  readonly session: SessionStore;
  readonly t: Translator;
  /** The context an operation on `tab` runs in. */
  readonly contextFor: (tab: SessionTab, handle: PdfDocumentHandle) => DocumentContext;
  /** Swap `tabId`'s engine handle for the one an operation produced. */
  readonly setHandle: (tabId: string, handle: PdfDocumentHandle) => void;
  /** The shared writer pipeline: journal the outcome, swap the handle, say what it did. */
  readonly applyWriterOutcome: (
    tab: SessionTab,
    handle: PdfDocumentHandle,
    outcome: OperationOutcome,
    labelKey: MessageKey,
  ) => Promise<void>;
}

/** The two writes the left dock's attachments panel asks for: files to embed, or names to drop. */
export interface AttachmentWrite {
  readonly add?: readonly File[];
  readonly remove?: readonly string[];
}

/**
 * The embedded files the properties panel lists, each with its measured size. The engine's
 * attachment list carries names and descriptions but not payloads, so a size is the byte
 * length of the payload read one file at a time; an unreadable payload is `null`.
 */
export async function measuredAttachments(
  handle: PdfDocumentHandle,
  signal: AbortSignal,
): Promise<readonly AttachmentRow[]> {
  const measured: AttachmentRow[] = [];
  for (const attachment of await listPdfAttachments(handle)) {
    if (signal.aborted) break;
    const size = await readPdfAttachment(handle, attachment).then(
      (bytes) => bytes.byteLength,
      () => null,
    );
    measured.push({ name: attachment.filename, description: attachment.description, size });
  }
  return measured;
}

/** The active tab and the handle it renders, or `null` when either is missing. */
function activeDocument(session: SessionStore): { tab: SessionTab; handle: PdfDocumentHandle } | null {
  const tab = session.active;
  const handle = tab === null ? undefined : handleFor(tab.id);
  return tab === null || handle === undefined ? null : { tab, handle };
}

/** A failed operation says why, in the interface language; anything unexpected is `internal`. */
function reportFailure(t: Translator, error: unknown): void {
  const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
  showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
}

/**
 * Hold the busy gate while `work` runs on the active document. Nothing runs without a tab and
 * a handle; an operation already holding the document is refused with the busy notice.
 */
async function withDocument(
  deps: AttachmentDeps,
  ready: () => boolean,
  work: (tab: SessionTab, handle: PdfDocumentHandle) => Promise<void>,
): Promise<void> {
  const document = activeDocument(deps.session);
  if (document === null || !ready()) return;
  if (isBusy()) {
    showNotice(deps.t('op.busy'));
    return;
  }
  setBusy(true);
  try {
    await work(document.tab, document.handle);
  } catch (error) {
    reportFailure(deps.t, error);
  } finally {
    setBusy(false);
  }
}

/** The bytes of picked files, ready for the writer to embed. */
function payloadsOf(files: readonly File[], mimeOf: (file: File) => string) {
  return Promise.all(
    files.map(async (file) => ({
      name: file.name,
      // `File.arrayBuffer` is the only read that does not need a URL or a reader.
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: mimeOf(file),
    })),
  );
}

/** The handlers behind the properties panel (add, remove, read out) and the attachments panel (write). */
export function createAttachmentActions(deps: AttachmentDeps) {
  const { t } = deps;

  /** Embed the picked files in the document. */
  async function addToDocument(files: readonly File[]): Promise<void> {
    await withDocument(
      deps,
      () => files.length > 0,
      async (tab, handle) => {
        const base = await materializeBase(deps.contextFor(tab, handle));
        const payloads = await payloadsOf(files, (file) =>
          file.type.length === 0 ? 'application/octet-stream' : file.type,
        );
        const outcome = await addAttachments(base, payloads, { signal: new AbortController().signal });
        const next = await applyProducedBytes(
          deps.contextFor(tab, handle),
          outcome.bytes,
          workingPageCount(tab),
          { key: 'props.attach.added', params: { count: outcome.added.length } },
          outcome.report.engine,
          outcome.report.steps,
        );
        deps.setHandle(tab.id, next);
        showNotice(t('props.attach.added', { count: outcome.added.length }));
      },
    );
  }

  /** Drop the embedded file called `name` from the document. */
  async function removeFromDocument(name: string): Promise<void> {
    await withDocument(
      deps,
      () => true,
      async (tab, handle) => {
        const base = await materializeBase(deps.contextFor(tab, handle));
        const outcome = await removeAttachments(base, [name], { signal: new AbortController().signal });
        const next = await applyProducedBytes(
          deps.contextFor(tab, handle),
          outcome.bytes,
          workingPageCount(tab),
          { key: 'props.attach.removed', params: { count: outcome.removed.length } },
          outcome.report.engine,
          outcome.report.steps,
        );
        deps.setHandle(tab.id, next);
        showNotice(
          outcome.missing.length > 0
            ? t('props.attach.missing', { count: outcome.missing.length })
            : t('props.attach.removed', { count: outcome.removed.length }),
        );
      },
    );
  }

  /** Write one embedded file out — the only operation that never touches the document. */
  async function readOut(name: string): Promise<void> {
    const document = activeDocument(deps.session);
    if (document === null) return;
    try {
      const attachments = await listPdfAttachments(document.handle);
      const attachment = attachments.find((entry) => entry.filename === name);
      if (attachment === undefined) return;
      const bytes = await readPdfAttachment(document.handle, attachment);
      downloadFiles([{ name: attachment.filename, bytes, mime: 'application/octet-stream' }]);
      showNotice(t('props.attach.readNamed', { name: attachment.filename }));
    } catch (error) {
      reportFailure(t, error);
    }
  }

  /**
   * The attachments panel's two writes (“attachments add/remove”), run on the working
   * document through the shared writer pipeline: the panel hands over the picked files (or the
   * names to drop) and the shell journals what the writer produced.
   */
  async function write(request: AttachmentWrite): Promise<void> {
    await withDocument(
      deps,
      () => true,
      async (tab, handle) => {
        const bytes = await materializeBase(deps.contextFor(tab, handle), {
          signal: new AbortController().signal,
        });
        const operation = { signal: new AbortController().signal };
        let outcome: OperationOutcome;
        if (request.add !== undefined && request.add.length > 0) {
          // A browser that knows nothing about the type says `''`, and the writer stores
          // that as no `/Subtype`.
          outcome = await addAttachments(
            bytes,
            await payloadsOf(request.add, (file) => file.type),
            operation,
          );
        } else if (request.remove !== undefined && request.remove.length > 0) {
          outcome = await removeAttachments(bytes, request.remove, operation);
        } else {
          return;
        }
        await deps.applyWriterOutcome(tab, handle, outcome, 'panel.attachments');
      },
    );
  }

  return { addToDocument, removeFromDocument, readOut, write };
}
