/**
 * How a document comes in: a picked, dropped or reopened file, bytes another operation
 * produced, and a file in another format converted first.
 *
 * The feature's own state is `open-store.ts`. What the shell still holds — the session, the
 * translator, the device tier, the busy gate's abort controller and the two viewer resets an
 * open performs — arrives as `OpenDeps`; the busy gate is read **at call time**.
 */

import { openWithPdfjs, type PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import {
  CONVERT_PICKER_ACCEPT,
  convertFormatOf,
  formatLabel,
  isImageName,
  pdfNameFor,
  unsupportedDocumentKind,
} from 'pdf-core/ops/convert-formats';
import { type SessionStore, sha256Hex, sourceKeyFor } from 'pdf-model';
import { checkDocumentLimits, type DeviceTier, ToolError, type Translator } from 'pdf-shared';
import type { MarkedRedaction } from '../../annotation-interaction';
import { convertToPdf, imagesToPdf } from '../../lazy-ops';
import { appendWarning, failureNotices, noticeLine, storedCopyWarning } from '../../notices';
import { addRecentDocument, type RecentDocumentItem } from '../../recent';
import { getRecentHandle, putRecentHandle, reopenFromHandle } from '../../recent-handles';
import {
  beginOperation,
  clearNotice,
  endOperation,
  isBusy,
  operationRunning,
  refuseBusy,
  setBusy,
  showNotice,
} from '../core/core-store';
import { adoptHandle } from '../core/handles';
import { draftStorage } from '../persistence/persistence-store';
import {
  askPassword,
  beginOpening,
  clearPageSelection,
  dropHomeCommand,
  endOpening,
  hideStartScreen,
  lockTab,
} from './open-store';

/** What the shell still holds that the open handlers run on. */
export interface OpenDeps {
  readonly session: SessionStore;
  readonly t: Translator;
  readonly tier: DeviceTier;
  /** The viewer goes back to the first page of the document that just opened. */
  readonly setCurrentPage: (pageIndex: number) => void;
  /** The redaction marks drawn on the previous document do not carry over. */
  readonly setRedactionMarks: (marks: readonly MarkedRedaction[]) => void;
}

/**
 * The hidden `<input type="file">` the plain-input path clicks when the browser has no File
 * System Access picker. `OpenFileInput` attaches it.
 */
export const fileInput: { current: HTMLInputElement | null } = { current: null };

/**
 * Open a document with the engine and fingerprint its bytes, side by side — the two only
 * read the bytes, so neither waits for the other. `Promise.all` would reject on the first
 * failure and abandon the other half: a fingerprint that fails after the engine opened the
 * document left that handle (a pdf.js worker and its parsed document) alive with no owner.
 * Both halves are awaited here, a handle the other half's failure made useless is destroyed,
 * and the error thrown is the engine's when it failed (a password request is its answer), else
 * the fingerprint's.
 */
export async function openAndFingerprint(
  opening: Promise<PdfDocumentHandle>,
  fingerprinting: Promise<string>,
): Promise<readonly [PdfDocumentHandle, string]> {
  const [opened, fingerprint] = await Promise.allSettled([opening, fingerprinting]);
  if (opened.status === 'fulfilled' && fingerprint.status === 'fulfilled') {
    return [opened.value, fingerprint.value];
  }
  if (opened.status === 'fulfilled') await opened.value.destroy().catch(() => undefined);
  throw opened.status === 'rejected' ? opened.reason : (fingerprint as PromiseRejectedResult).reason;
}

/** The open handlers, bound to the shell's deps. */
export interface OpenActions {
  /** Open `file` (with its handle for in-place save, and its password when it is protected). */
  readonly openFile: (file: File, fileHandle?: FileSystemFileHandle, password?: string) => Promise<void>;
  /** Open produced bytes as a new tab; resolves with the stored-copy warning, if any. */
  readonly openProducedTab: (name: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<string | null>;
  /** Convert a Word, Excel, HTML, text or image file and open the PDF. */
  readonly convertAndOpen: (file: File) => Promise<void>;
  /** The fire-and-forget way in: every failure becomes a notice. */
  readonly openFromSurface: (file: File, handle?: FileSystemFileHandle) => Promise<void>;
  /** Several files at once, one tab each. */
  readonly openFilesFromSurface: (
    files: readonly File[],
    fileHandles?: readonly (FileSystemFileHandle | null)[],
  ) => Promise<void>;
  /** Ask for a file with the File System Access picker, or the plain input without it. */
  readonly openViaPicker: () => Promise<void>;
  /** A recent-documents entry picked on the start screen. */
  readonly selectRecent: (item: RecentDocumentItem) => Promise<void>;
}

export function createOpenActions(deps: OpenDeps): OpenActions {
  const { session, t, tier, setCurrentPage, setRedactionMarks } = deps;

  async function openFile(file: File, fileHandle?: FileSystemFileHandle, password?: string): Promise<void> {
    clearNotice();
    if (isBusy()) {
      // A tool picked on the home screen waits for this document; an open refused never
      // brings it, so the tool must not run on whatever is opened next.
      dropHomeCommand();
      refuseBusy(t);
      return;
    }
    const earlyVerdict = checkDocumentLimits(tier, 0, file.size);
    setBusy(true);
    beginOpening();
    try {
      /**
       * The size gate runs **inside** the guarded block. Thrown before it, the
       * error escaped the function itself: the drop zone, the home screen and the file
       * input all call this fire-and-forget, so an oversized file produced no notice at
       * all — the one failure the limit exists to explain.
       */
      if (earlyVerdict.kind === 'blocked') {
        throw new ToolError('file-too-large', { engine: 'model' });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      // The fingerprint is independent of the open and only reads the bytes, so it
      // runs alongside the engine instead of after it: on a 130 MB document that is
      // a few hundred milliseconds off the path the user waits on.
      const [handle, sha256] = await openAndFingerprint(
        openWithPdfjs(bytes, password === undefined ? {} : { password }),
        sha256Hex(bytes),
      );
      const fileVerdict = checkDocumentLimits(tier, handle.pageCount, bytes.byteLength);
      if (fileVerdict.kind === 'blocked') {
        await handle.destroy();
        throw new ToolError(fileVerdict.reason === 'pages' ? 'page-limit' : 'file-too-large', {
          engine: 'model',
          ...(fileVerdict.reason === 'pages' ? { path: file.name } : {}),
        });
      }
      // Read before the tab exists: it only needs the engine handle, and a rejection here
      // is an open failure with nothing registered — the handle is released like the
      // limit-blocked one above, and the original error is the one reported.
      let encrypted: boolean;
      try {
        encrypted = (await handle.raw.getPermissions()) !== null;
      } catch (error) {
        await handle.destroy().catch(() => undefined);
        throw error;
      }
      const tab = session.openDocument({
        name: file.name,
        bytes,
        sha256,
        pageCount: handle.pageCount,
        ...(fileHandle === undefined ? {} : { handle: fileHandle }),
      });
      adoptHandle(tab.id, handle);
      if (password !== undefined) {
        lockTab(tab.id, password);
        showNotice(t('locked.banner'));
      }
      addRecentDocument({
        id: tab.id,
        name: file.name,
        sizeBytes: file.size,
        pageCount: handle.pageCount,
      });
      hideStartScreen();
      let storageWarning: string | null = null;
      if (encrypted) session.setSensitive(tab.id, true);
      else {
        // The tab is registered: keeping a recovery copy is not part of opening. A write
        // that fails (storage full, OPFS unavailable) costs the copy, never the
        // document, and is reported as exactly that — not as an open failure below.
        try {
          await draftStorage().putSource(sourceKeyFor(tab.id, sha256), bytes);
          // A reference to the file, never its bytes; a sensitive session keeps none.
          if (fileHandle !== undefined) await putRecentHandle(tab.id, fileHandle);
        } catch (error) {
          storageWarning = storedCopyWarning(error, t);
        }
      }
      setCurrentPage(0);
      // No zoom reset here: the viewer reports the scale it draws the new document at
      // (fit width), and a reset after the awaits above would overwrite that report.
      clearPageSelection();
      setRedactionMarks([]);
      const limitNotice =
        fileVerdict.kind === 'warn'
          ? t('limit.warn.pages')
          : fileVerdict.kind === 'viewing-only'
            ? t(fileVerdict.reason === 'pages' ? 'limit.viewingOnly.pages' : 'limit.viewingOnly.bytes')
            : null;
      // One notice line: the limit and the storage warning say different things and both stay.
      if (limitNotice !== null) showNotice(appendWarning(limitNotice, storageWarning));
      else if (storageWarning !== null) showNotice(storageWarning);
    } catch (error) {
      const toolError =
        error instanceof ToolError ? error : new ToolError('corrupt-document', { engine: 'model' });
      // A protected file is a question, not a failure: ask for the password and open
      // the same file again with it.
      if (toolError.code === 'password-required' || toolError.code === 'wrong-password') {
        askPassword({
          file,
          ...(fileHandle === undefined ? {} : { handle: fileHandle }),
          incorrect: toolError.code === 'wrong-password',
        });
        return;
      }
      dropHomeCommand();
      showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
    } finally {
      endOpening();
      setBusy(false);
    }
  }

  /**
   * Open produced bytes as a new tab (extract, split, unlock, image→PDF results).
   *
   * It settles once the tab is registered, and a rejection means *no* tab was opened. Storing
   * the recovery copy comes after that and is not part of opening: when it fails the tab
   * stays and the resolved value is the warning sentence for the caller to put on its notice
   * line (`null` when the copy is stored). The caller owns the notice because it sets its own
   * success line right after, and the shell has one line: a warning set here would be
   * replaced by that line.
   */
  async function openProducedTab(
    name: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const earlyVerdict = checkDocumentLimits(tier, 0, bytes.byteLength);
    if (earlyVerdict.kind === 'blocked') {
      throw new ToolError('file-too-large', { engine: 'model' });
    }
    const [handle, sha256] = await openAndFingerprint(openWithPdfjs(bytes), sha256Hex(bytes));
    /**
     * Opening is the transition, so a cancelled caller — the tab it came from
     * was closed while the dialog's result was opening — must not leave an
     * orphan tab behind: the handle is destroyed and nothing is registered.
     */
    if (signal?.aborted === true) {
      await handle.destroy();
      throw new ToolError('aborted', { engine: 'model' });
    }
    // The bytes passed the size gate above, so only the page count can block here.
    if (checkDocumentLimits(tier, handle.pageCount, bytes.byteLength).kind === 'blocked') {
      await handle.destroy();
      throw new ToolError('page-limit', { engine: 'model', path: name });
    }
    const tab = session.openDocument({ name, bytes, sha256, pageCount: handle.pageCount });
    adoptHandle(tab.id, handle);
    addRecentDocument({
      id: tab.id,
      name,
      sizeBytes: bytes.byteLength,
      pageCount: handle.pageCount,
    });
    hideStartScreen();
    let warning: string | null = null;
    try {
      await draftStorage().putSource(sourceKeyFor(tab.id, sha256), bytes);
    } catch (error) {
      warning = storedCopyWarning(error, t);
    }
    setCurrentPage(0);
    return warning;
  }

  /**
   * A document in another format, opened: converted in this tab with the defaults (the
   * locale's paper, portrait — a spreadsheet landscape — and a 15 mm margin), then opened
   * as a new PDF tab. A picture is placed on a page of the same paper, as "Images to PDF"
   * would. The conversion's own notes say what it approximated; the File menu's
   * "Convert to PDF" offers the same conversion with every option.
   */
  async function convertAndOpen(file: File): Promise<void> {
    const format = convertFormatOf(file.name);
    if (format === null && !isImageName(file.name)) return;
    clearNotice();
    if (isBusy() || operationRunning()) {
      dropHomeCommand();
      refuseBusy(t);
      return;
    }
    const controller = beginOperation();
    setBusy(true);
    beginOpening();
    try {
      const letter = /^en-(?:US|CA)\b/i.test(navigator.language);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (format === null) {
        // A picture becomes a page the way "Images to PDF" makes one: on the paper,
        // contained, its EXIF turn applied.
        const pictures = await imagesToPdf(
          {
            images: [{ name: file.name, bytes }],
            pageSize: letter ? 'letter' : 'a4',
            fit: 'contain',
            marginMm: 0,
            applyExif: true,
          },
          { signal: controller.signal },
        );
        const warning = await openProducedTab(pdfNameFor(file.name), pictures.bytes, controller.signal);
        showNotice(appendWarning(t('convert.imageOpened'), warning));
        return;
      }
      const outcome = await convertToPdf(
        {
          name: file.name,
          bytes,
          pageSize: letter ? 'letter' : 'a4',
          orientation: format === 'xlsx' || format === 'csv' || format === 'tsv' ? 'landscape' : 'portrait',
          marginMm: 15,
        },
        { signal: controller.signal },
      );
      const warning = await openProducedTab(pdfNameFor(file.name), outcome.bytes, controller.signal);
      const caveats = outcome.report.notes
        .filter((item) => item.key !== 'op.note.convert.done')
        .map((item) => t(item.key, item.params));
      showNotice(
        appendWarning([t('convert.opened', { format: formatLabel(format) }), ...caveats].join(' '), warning),
      );
    } catch (error) {
      dropHomeCommand();
      if (controller.signal.aborted) return;
      showNotice(noticeLine(failureNotices(error, 'error.unsupported-format.message'), t));
    } finally {
      endOpening();
      if (endOperation(controller)) setBusy(false);
    }
  }

  /**
   * The fire-and-forget way in.
   *
   * Four surfaces open a file — the picker, the drop zone, the home screen and the
   * hidden input — and three of them have no promise to await, so `void openFile(...)`
   * there left a rejection with nowhere to go: the browser's unhandled-rejection report
   * is not a notice, and the user saw a document that simply did not open. One wrapper
   * for the four, so the handling cannot be forgotten at one of them.
   */
  async function openFromSurface(file: File, handle?: FileSystemFileHandle): Promise<void> {
    try {
      // A Word, Excel, HTML or text file is not refused: it is converted, and the PDF
      // opens in its own tab (`pdf-core/ops/convert.ts`). A `.pdf` always opens as one.
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        if (convertFormatOf(file.name) !== null || isImageName(file.name)) {
          await convertAndOpen(file);
          return;
        }
        const kind = unsupportedDocumentKind(file.name);
        if (kind !== null) {
          // No document comes of this file, so a tool picked for it is dropped.
          dropHomeCommand();
          showNotice(t('convert.unsupported', { kind }));
          return;
        }
      }
      await openFile(file, handle);
    } catch (error) {
      dropHomeCommand();
      showNotice(noticeLine(failureNotices(error, 'error.corrupt-document.message'), t));
    }
  }

  /**
   * Several files at once (a drop, a multi-file pick on the home screen): each opens in its
   * own tab, one after the other, because an open holds the busy gate until it settles.
   */
  async function openFilesFromSurface(
    files: readonly File[],
    fileHandles: readonly (FileSystemFileHandle | null)[] = [],
  ): Promise<void> {
    for (const file of files) {
      // Paired by name, not position: the drop's item list and file list are separate.
      const handle = fileHandles.find((item) => item?.name === file.name) ?? undefined;
      await openFromSurface(file, handle);
    }
  }

  /**
   * Open with the File System Access picker when it exists: the returned
   * handle is what makes in-place **Save** possible later. Without it the shell
   * keeps its file-input path and Save stays disabled in favour of Export — the
   * browser-matrix contract, not a defect.
   */
  async function openViaPicker(): Promise<void> {
    if (typeof showOpenFilePicker !== 'function') {
      fileInput.current?.click();
      return;
    }
    let picked: FileSystemFileHandle | undefined;
    try {
      [picked] = await showOpenFilePicker({
        multiple: false,
        excludeAcceptAllOption: false,
        types: [
          { description: t('open.pdfFilter'), accept: { 'application/pdf': ['.pdf'] } },
          {
            description: t('open.anyFilter'),
            accept: { 'application/pdf': ['.pdf'], ...CONVERT_PICKER_ACCEPT },
          },
        ],
      });
    } catch (error) {
      // A cancelled picker is a user decision, not an error worth a banner — and only a
      // *picker* failure gets the picker's sentence: an open that failed has its own
      // message and hint, which `openFromSurface` reports.
      if (error instanceof DOMException && error.name === 'AbortError') {
        // A tool picked first must not run on whatever document is opened later.
        dropHomeCommand();
        return;
      }
      dropHomeCommand();
      showNotice(t('open.pickerFailed'));
      return;
    }
    if (picked === undefined) return;
    const file = await picked.getFile();
    await openFromSurface(file, picked);
  }

  /**
   * A recent-documents entry picked on the start screen: its open tab, else the file it was
   * opened from, else its stored recovery copy, else the picker.
   */
  async function selectRecent(item: RecentDocumentItem): Promise<void> {
    const matched = session
      .getSnapshot()
      // By identity only: two different files may share a name, and matching on
      // it opened whichever tab happened to carry that name.
      .tabs.find((tab) => tab.id === item.id);
    if (matched) {
      session.setActive(matched.id);
      hideStartScreen();
      return;
    }
    // The file the entry was opened from, reopened directly (Chromium keeps the
    // handle; the browser asks for permission again on this click).
    const stored = await getRecentHandle(item.id);
    if (stored !== null) {
      const reopened = await reopenFromHandle(stored);
      if (reopened.kind === 'file') {
        await openFromSurface(reopened.file, reopened.handle);
        return;
      }
      showNotice(
        t(reopened.kind === 'denied' ? 'home.reopen.denied' : 'home.reopen.missing', {
          name: item.name,
        }),
      );
      // A refused permission is the user's answer; the picker would ask again.
      if (reopened.kind === 'denied') return;
    }
    try {
      const drafts = await draftStorage().readDrafts();
      const matchedDraft = drafts.find((d) => d.id === item.id);
      if (matchedDraft) {
        const bytes = await draftStorage().getSource(matchedDraft.sourceKey);
        if (bytes) {
          const [handle, sha256] = await openAndFingerprint(openWithPdfjs(bytes), sha256Hex(bytes));
          const tab = session.openDocument({
            id: matchedDraft.id,
            name: matchedDraft.name,
            bytes,
            sha256,
            pageCount: matchedDraft.pageCount,
          });
          adoptHandle(tab.id, handle);
          session.setActive(tab.id);
          hideStartScreen();
          return;
        }
      }
    } catch (error) {
      // The draft could not be read back: say so, then offer the picker so the
      // user can open the file itself.
      showNotice(noticeLine(failureNotices(error, 'error.corrupt-document.message'), t));
    }
    void openViaPicker();
  }

  return {
    openFile,
    openProducedTab,
    convertAndOpen,
    openFromSurface,
    openFilesFromSurface,
    openViaPicker,
    selectRecent,
  };
}
