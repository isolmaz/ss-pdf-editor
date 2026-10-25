/**
 * Save and Export: the two ways a prepared version leaves the editor as a file.
 *
 * Save writes in place when the document has a file handle (and offers "Save as" through the
 * file picker when it has none); Export always downloads a new file — which is also the save
 * where a download is the only way to save at all (see `exportDocument`). Both run on bytes the
 * shell prepared (`prepare-output.ts`) and take the busy flag and the operation controller for
 * the duration.
 */

import { type SessionStore, type SessionTab, sha256Hex } from 'pdf-model';
import { ToolError, type Translator, toToolError } from 'pdf-shared';
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
import { conflictFound, isSaveLocked, saveLocked, saveReleased } from './save-store';

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

/** What the user decided about a file that changed under the document (`conflict-actions.ts`). */
export interface SaveOptions {
  /**
   * The file the user confirmed overwriting although it differs from what this editor last saw
   * there: the save writes to it, unchecked. Only the answer to the file-changed question sets
   * it, and it carries the file that question was about (`SaveConflict.target`), so the write
   * can only go where the question pointed.
   */
  readonly overwrite?: FileSystemFileHandle;
  /**
   * Choose a destination even though the document has a file of its own, and make the chosen one
   * the document's file: the way out of a conflict that keeps both versions.
   */
  readonly saveAs?: boolean;
}

/** The name a download of `name` is saved under. */
const pdfName = (name: string): string => (name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`);

/** Whether the browser can ask the user where to write a file (File System Access). */
const hasSavePicker = (): boolean => typeof window !== 'undefined' && 'showSaveFilePicker' in window;

/**
 * The notice a failed write leaves: the failure's message and what to do about it. The browser's
 * file errors are told apart by what the user can do: a refused permission is asked for again,
 * a file that is gone, locked or has no room is written elsewhere (Save as, or Export).
 */
function failureLine(error: unknown, t: Translator): string {
  const toolError = error instanceof DOMException ? fileFailure(error) : toToolError(error);
  return `${t(toolError.messageKey)} ${t(toolError.hintKey)}`;
}

function fileFailure(error: DOMException): ToolError {
  const details = { engine: 'fs', engineMessage: error.message };
  switch (error.name) {
    case 'NotAllowedError':
      return new ToolError('permission-denied', details, { cause: error });
    case 'NotFoundError':
    case 'NoModificationAllowedError':
    case 'QuotaExceededError':
      return new ToolError('write-failed', details, { cause: error });
    default:
      return toToolError(error);
  }
}

/** The sha-256 of what a file holds. */
async function contentHash(file: File): Promise<string> {
  return sha256Hex(new Uint8Array(await file.arrayBuffer()));
}

/**
 * Takes the baseline of the file a Save is about to write and returns the check that it still
 * holds it, made when the bytes are ready. Writing in place measures against what the editor
 * last wrote there (`lastWrittenSha256`, which a restored draft remembers; the source hash for
 * a file it never wrote); a file the user confirmed overwriting (`confirmed`) is not measured at
 * all; any other destination against
 * what it holds right now. The destination is read once for its baseline; at the end its size
 * and modified time say whether anything touched it, and only a touched file is read and
 * hashed again — a touch that left the bytes alone is no conflict, a changed byte is.
 */
async function destinationGuard(
  tab: SessionTab,
  file: FileSystemFileHandle,
  confirmed: FileSystemFileHandle | undefined,
): Promise<() => Promise<boolean>> {
  // The user has been asked about this very file and said to overwrite whatever it holds.
  if (file === confirmed) return async () => true;
  if (file === tab.source.handle) {
    const recorded = tab.lastWrittenSha256 ?? tab.source.sha256;
    return async () => (await contentHash(await file.getFile())) === recorded;
  }
  const baseline = await file.getFile();
  const sha256 = await contentHash(baseline);
  return async () => {
    const current = await file.getFile();
    if (current.size === baseline.size && current.lastModified === baseline.lastModified) return true;
    return (await contentHash(current)) === sha256;
  };
}

/**
 * Record that a prepared version left the editor as a file: the version the *preparation*
 * produced, not the one captured before a picker — an edit made while the picker was open must
 * not be recorded as saved. The fact table itself is kept, not a summary of it: the notice says
 * what the write established, and the output keeps the record a later surface can read back.
 */
function recordOutput(session: SessionStore, prepared: PreparedOutput): void {
  const { tab, outputProtection, execution, outputHash, verification } = prepared;
  session.addOutput(tab.id, {
    id: crypto.randomUUID(),
    fromWorkingVersion: tab.working.id,
    fromState: tab.working.stateId,
    encrypted: outputProtection.encrypted,
    steps: execution.steps.map((step) => `${step.engine}:${step.id}`),
    appliedSteps: execution.appliedSteps.map((step) => `${step.engine}:${step.id}`),
    incremental: execution.plan.incremental,
    verification,
    writtenTo: { fileName: tab.name, savedAt: Date.now(), sha256: outputHash },
  });
}

/**
 * Save `tabId` (default: the active tab): in place when the document has a file, through the
 * file picker when the browser offers one, as a download otherwise. Resolves whether the
 * version was written.
 *
 * An in-place save writes only over the file it last saw. When the file on disk is something
 * else — changed by another program, or by this editor in an earlier session whose write the
 * restored draft remembers — nothing is written and the file-changed question is asked
 * (`conflictFound`); the answers come back here as `options`.
 */
export async function saveDocument(
  host: SaveHost,
  tabId: string | undefined,
  options: SaveOptions = {},
): Promise<boolean> {
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
    let target = options.saveAs === true ? undefined : (options.overwrite ?? tab.source.handle);
    // A handle read back from IndexedDB (a restored draft, a reopened recent entry) has
    // no write access until the user grants it: asked here, the first await of the click.
    if (target !== undefined && !(await ensureWriteAccess(target))) {
      throw new ToolError('permission-denied', { engine: 'model' });
    }
    if (target === undefined && hasSavePicker()) {
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
    const destination =
      target === undefined
        ? undefined
        : { file: target, unchanged: await destinationGuard(tab, target, options.overwrite) };

    const executedSteps: SaveStepDescription[] = [];
    const prepared = await prepareOutput(tab.id, controller, executedSteps);
    if (prepared === null) return false;

    const { tab: preparedTab, bytes, verification } = prepared;

    if (destination !== undefined) {
      // A changed file is a question, not a failure: the dialog offers overwriting *this* file
      // (confirmed), saving as a new file, or leaving it alone.
      if (!(await destination.unchanged())) {
        conflictFound(tab.id, destination.file);
        return false;
      }

      if (controller.signal.aborted) return false;
      const writable = await destination.file.createWritable();
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
      session.setHandle(preparedTab.id, destination.file);
    } else {
      // Direct download fallback when File System Access is not available
      downloadFiles([{ name: pdfName(tab.name), bytes, mime: 'application/pdf' }]);
    }

    recordOutput(session, prepared);
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
 * *this* file, not the bytes the user opened — named as a PDF, as Save names its download.
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
    anchor.download = pdfName(tab.name);
    anchor.click();
    // Blob URLs are cleaned up right after the operation.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    // Where a download is the only way to keep work — no file to write over, no picker to ask
    // for one — Export is the user's Save, and Save's download is recorded as saved: left
    // unrecorded, a document that was exported stays "unsaved" and closing it warns of a loss.
    // A document no file holds yet (`savedState` is `null`) has nothing but this download to
    // keep, so its first Export is its save as well. Anywhere else Export is a copy, and the
    // document stays as dirty as it was.
    if (tab.source.handle === undefined && (!hasSavePicker() || tab.savedState === null)) {
      recordOutput(session, prepared);
    }
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
