/**
 * What the user does with a stamp: arm a picture, click it onto a page, drag its corner,
 * open the signature dialog, pick an image file. Every handler reads the stores at the
 * moment it runs. The write itself (`writeFileAnnotation`, the shell's one boundary for a
 * file-annotation edit) and the shell's own gates are handed in, because other features share
 * them.
 */

import type { Translator } from 'pdf-shared';
import type { StampSource } from 'pdf-ui/dialog';
import type { MarkTarget, StampPlacement } from 'pdf-ui/tools';
import { addImageStamp, resizeImageStamp } from '../../lazy-ops';
import { armStampTool, coreStore, isBusy, selectTool, showNotice } from '../core/core-store';
import type { WriteFileAnnotation } from '../marks/host';
import { openSignatureDialog, signatureChosen } from './stamps-store';

/** The image picker the "add an image" command opens (`ImagePickerInput` is its element). */
export const imageInputRef: { current: HTMLInputElement | null } = { current: null };

/** What a picture is called in the notices and in the comment list readers show. */
export function stampKind(role: StampSource['role'], t: Translator): string {
  return t(
    role === 'signature' ? 'sig.role.signature' : role === 'initials' ? 'sig.role.initials' : 'img.add.label',
  );
}

/** Arm the `stamp` tool with a picture; the next click on a page places it. */
export function armStamp(source: StampSource, t: Translator): void {
  armStampTool(source);
  showNotice(t('sig.placing'));
}

/** The click that places the armed picture: one `/Stamp`, one journal step, then selected. */
export function placeStamp(
  placement: StampPlacement,
  deps: {
    readonly writeFileAnnotation: WriteFileAnnotation;
    readonly author: string;
    readonly t: Translator;
  },
): void {
  const source = coreStore.get().pendingStamp;
  if (source === null) return;
  const { t } = deps;
  const kind = stampKind(source.role, t);
  const started = deps.writeFileAnnotation(
    { key: 'sig.placed', params: { kind } },
    (base, signal) =>
      addImageStamp(
        base,
        {
          id: crypto.randomUUID(),
          pageIndex: placement.pageIndex,
          center: placement.center,
          width: placement.width,
          height: placement.height,
          image: source.bytes,
          role: source.role,
          label: kind,
          author: deps.author,
        },
        { signal },
      ),
    t('sig.placed', { kind }),
    placement.pageIndex,
  );
  if (started) selectTool('select');
}

/** A corner handle's drop: the stamp's `/Rect` becomes the new box, nothing else changes. */
export function resizeStamp(
  key: string,
  rect: readonly [number, number, number, number],
  deps: {
    readonly targets: readonly MarkTarget[];
    readonly writeFileAnnotation: WriteFileAnnotation;
    readonly t: Translator;
  },
): void {
  const { t } = deps;
  const target = deps.targets.find((candidate) => candidate.key === key);
  if (target === undefined || target.family !== 'existing' || target.resizable !== true) {
    showNotice(t('stamp.notResizable'));
    return;
  }
  deps.writeFileAnnotation(
    { key: 'stamp.resize' },
    (base, signal) =>
      resizeImageStamp(base, { pageIndex: target.pageIndex, id: target.id, rect }, { signal }),
    t('stamp.resized'),
  );
}

/** What the shell knows when a command wants to start adding a picture. */
export interface AddGate {
  /** A document is open. */
  readonly hasDocument: boolean;
  /** The open document accepts edits. */
  readonly canEdit: boolean;
  /** Say that the document is busy. */
  readonly refuseBusy: () => void;
}

/** Whether a picture may be added now; a busy or read-only document is refused out loud. */
function mayAdd(gate: AddGate): boolean {
  if (!gate.hasDocument) return false;
  if (isBusy() || !gate.canEdit) {
    gate.refuseBusy();
    return false;
  }
  return true;
}

/** Open the signature dialog, when a picture may be added. */
export function openSignature(gate: AddGate): void {
  if (mayAdd(gate)) openSignatureDialog();
}

/** Open the file picker for an image, when a picture may be added. */
export function pickImage(gate: AddGate): void {
  if (mayAdd(gate)) imageInputRef.current?.click();
}

/** The file the picker returned: armed as the next stamp, or the reason it could not be. */
export async function onImagePicked(file: File, t: Translator): Promise<void> {
  // A dynamic chunk: the first paint must not carry the dialogs' code (the entry budget is locked).
  const { imageFromFile } = await import('pdf-ui/dialog');
  const source = await imageFromFile(file);
  if (source === null) {
    showNotice(t('img.add.failed', { name: file.name }));
    return;
  }
  armStamp(source, t);
}

/** The dialog's "use": remember it when asked, close the dialog, arm the stamp tool with it. */
export function placeSignature(
  source: StampSource,
  remember: boolean,
  canRemember: boolean,
  t: Translator,
): void {
  signatureChosen(source, remember, canRemember);
  armStamp(source, t);
}
