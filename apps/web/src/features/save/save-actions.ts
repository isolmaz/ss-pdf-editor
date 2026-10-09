/**
 * Save and Export: the two ways a prepared version leaves the editor as a file.
 *
 * Save writes in place when the document has a file handle (and offers "Save as" through the
 * file picker when it has none); Export always downloads a new file. Both run on bytes the
 * shell prepared (`prepare-output.ts`) and take the busy flag and the operation controller for
 * the duration.
 */

import { type SessionStore, sha256Hex } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { noticeLine, verificationNotices } from '../../notices';
import { downloadFiles } from '../../operations';
import { ensureWriteAccess } from '../../recent-handles';
import type { SaveStepDescription } from '../../save-plan';
import {
  beginOperation,
  clearNotice,
  endOperation,
  isBusy,
  refuseBusy,
  setBusy,
  showNotice,
} from '../core/core-store';
import type { PreparedOutput } from './prepare-output';
import { isSaveLocked, saveLocked, saveReleased } from './save-store';

/** What the shell still holds that Save and Export run on. */
export interface SaveHost {
  readonly session: SessionStore;
  readonly t: Translator;
  /** The checked bytes of `tabId`'s current version (`prepareOutput`), or `null` when it said why not. */
  readonly prepareOutput: (
    tabId: string,
    controller: AbortController,
    executedSteps?: SaveStepDescription[],
  ) => Promise<PreparedOutput | null>;
}

/** The name a download of `name` is saved under. */
const pdfName = (name: string): string => (name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`);

/** The notice a failed write leaves: the failure's message and what to do about it. */
function failureLine(error: unknown, t: Translator): string {
  const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
  return `${t(toolError.messageKey)} ${t(toolError.hintKey)}`;
}

/**
 * Save `tabId` (default: the active tab): in place when the document has a file, through the
 * file picker when the browser offers one, as a download otherwise. Resolves whether the
 * version was written.
 */
export async function saveDocument(host: SaveHost, tabId: string | undefined): Promise<boolean> {
  const { session, t, prepareOutput } = host;
  const tab = session.getSnapshot().tabs.find((item) => item.id === tabId) ?? null;
  if (tab === null) return false;
  if (isSaveLocked() || isBusy()) {
    refuseBusy(t);
    return false;
  }

  /**
   * Ownership is taken **before** anything can await. `showSaveFilePicker` is a
   * promise the user can leave open for minutes, and a second Save (a shortcut, a
   * second click) that starts while it is open would run a second preparation and a
   * second write against the same document — two commits, one of them for bytes the
   * other already replaced. The `finally` below releases it on every path,
   * including cancellation.
   */
  const controller = beginOperation();
  saveLocked();
  clearNotice();
  setBusy(true);
  try {
    let target = tab.source.handle;
    // A handle read back from IndexedDB (a restored draft, a reopened recent entry) has
    // no write access until the user grants it: asked here, the first await of the click.
    if (target !== undefined && !(await ensureWriteAccess(target))) {
      throw new ToolError('permission-denied', { engine: 'model' });
    }
    if (target === undefined && typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
      try {
        target = await (
          window as unknown as {
            showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
          }
        ).showSaveFilePicker({
          suggestedName: pdfName(tab.name),
          types: [{ description: t('open.pdfFilter'), accept: { 'application/pdf': ['.pdf'] } }],
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError') return false;
        // continue with target = undefined for direct download fallback
      }
    }

    /**
     * The conflict baseline belongs to the file that is about to be written, not to
     * the document that was opened. A newly picked destination is normally empty, and
     * another file the user chose explicitly is theirs to overwrite — comparing either
     * against the *source* hash rejected every Save As that was not a re-save of the
     * original. The in-place path keeps the original/last-written protection.
     */
    const targetIsSource = target !== undefined && target === tab.source.handle;
    const expected = targetIsSource
      ? (tab.outputs.at(-1)?.writtenTo?.sha256 ?? tab.source.sha256)
      : target === undefined
        ? null
        : await sha256Hex(new Uint8Array(await (await target.getFile()).arrayBuffer()));

    const executedSteps: SaveStepDescription[] = [];
    const prepared = await prepareOutput(tab.id, controller, executedSteps);
    if (prepared === null) return false;

    const { tab: preparedTab, bytes, outputProtection, execution, outputHash, verification } = prepared;

    if (target !== undefined) {
      // A destination was chosen, so a baseline was taken for it above.
      const actual = new Uint8Array(await (await target.getFile()).arrayBuffer());
      if ((await sha256Hex(actual)) !== expected) throw new ToolError('conflict', { engine: 'model' });

      if (controller.signal.aborted) return false;
      const writable = await target.createWritable();
      try {
        if (controller.signal.aborted) throw new ToolError('aborted', { engine: 'model' });
        await writable.write(bytes as unknown as FileSystemWriteChunkType);
        if (controller.signal.aborted) throw new ToolError('aborted', { engine: 'model' });
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      // Only now is this handle the document's own file: attaching it before the write
      // succeeded would make the next Save write in place over a file this one never
      // managed to commit.
      session.setHandle(preparedTab.id, target);
    } else {
      // Direct download fallback when File System Access is not available
      downloadFiles([{ name: pdfName(tab.name), bytes, mime: 'application/pdf' }]);
    }

    session.addOutput(preparedTab.id, {
      id: crypto.randomUUID(),
      // The version the *preparation* produced, not the one captured before the
      // picker: an edit made while the picker was open must not be recorded as saved.
      fromWorkingVersion: preparedTab.working.id,
      fromState: preparedTab.working.stateId,
      encrypted: outputProtection.encrypted,
      steps: execution.steps.map((step) => `${step.engine}:${step.id}`),
      appliedSteps: execution.appliedSteps.map((step) => `${step.engine}:${step.id}`),
      incremental: execution.plan.incremental,
      // The fact table itself, not a summary of it: the notice below says
      // what the save established, and the output keeps the record a later surface
      // can read back.
      verification,
      writtenTo: { fileName: preparedTab.name, savedAt: Date.now(), sha256: outputHash },
    });
    showNotice(
      noticeLine(
        [{ key: 'save.done', params: { name: preparedTab.name } }, ...verificationNotices(verification)],
        t,
      ),
    );
    return true;
  } catch (error) {
    showNotice(failureLine(error, t));
    return false;
  } finally {
    endOperation(controller);
    saveReleased();
    setBusy(false);
  }
}

/**
 * Export: writes the **current version** of `tabId` (default: the active tab) as a new file.
 * Without a File System Access handle this is the only way to keep work — and it must be
 * *this* file, not the bytes the user opened.
 */
export async function exportDocument(host: SaveHost, tabId: string | undefined): Promise<void> {
  const { session, t, prepareOutput } = host;
  // Read the tab at call time like every other entry point: the export must write
  // the version the user is looking at, not the one the rendering control saw.
  const tab = session.getSnapshot().tabs.find((item) => item.id === tabId) ?? null;
  if (tab === null) return;
  if (isBusy()) {
    refuseBusy(t);
    return;
  }
  const controller = beginOperation();
  setBusy(true);
  try {
    const prepared = await prepareOutput(tab.id, controller);
    if (prepared === null) return;

    const { bytes } = prepared;
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = tab.name;
    anchor.click();
    // Blob URLs are cleaned up right after the operation.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    // The browser-matrix contract: without an in-place handle the user
    // must know why this writes a *new* file instead of saving the one they opened.
    // The verification table travels with it either way: an export is a
    // write, and what the checks established belongs on the same line as the news
    // that it happened.
    showNotice(
      noticeLine(
        [
          {
            key: tab.source.handle === undefined ? 'export.explained' : 'save.done',
            params: { name: tab.name },
          },
          ...verificationNotices(prepared.verification),
        ],
        t,
      ),
    );
  } catch (error) {
    showNotice(failureLine(error, t));
  } finally {
    endOperation(controller);
    setBusy(false);
  }
}
