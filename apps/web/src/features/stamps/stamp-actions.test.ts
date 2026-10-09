// @vitest-environment happy-dom
/**
 * What the user does with a stamp: the exact write each gesture makes into pdf-core, what the
 * status line says, which tool is armed afterwards, and which gate refuses a busy or read-only
 * document before anything opens.
 */

import { createTranslator } from 'pdf-shared';
import type { StampSource } from 'pdf-ui/dialog';
import type { MarkTarget, StampPlacement } from 'pdf-ui/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState, setBusy } from '../core/core-store';
import type { WriteFileAnnotation } from '../marks/host';
import {
  type AddGate,
  armStamp,
  imageInputRef,
  onImagePicked,
  openSignature,
  pickImage,
  placeSignature,
  placeStamp,
  resizeStamp,
  stampKind,
} from './stamp-actions';
import { initialStampsState, stampsStore } from './stamps-store';

const pdfCore = vi.hoisted(() => ({
  addImageStamp: vi.fn(),
  resizeImageStamp: vi.fn(),
  imageFromFile: vi.fn(),
}));
vi.mock('../../lazy-ops', () => ({
  addImageStamp: pdfCore.addImageStamp,
  resizeImageStamp: pdfCore.resizeImageStamp,
}));
vi.mock('pdf-ui/dialog', () => ({ imageFromFile: pdfCore.imageFromFile }));

const t = createTranslator('en');

function source(role: StampSource['role'] = 'signature'): StampSource {
  return {
    role,
    bytes: new Uint8Array([9, 9]),
    dataUrl: 'data:image/png;base64,CCCC',
    pixelWidth: 100,
    pixelHeight: 50,
  };
}

const placement: StampPlacement = { pageIndex: 2, center: { x: 100, y: 200 }, width: 160, height: 64 };

beforeEach(() => {
  coreStore.set(initialCoreState());
  stampsStore.set(initialStampsState());
  imageInputRef.current = null;
  vi.clearAllMocks();
});

describe('stampKind', () => {
  it('names a signature, initials and any other picture', () => {
    expect(stampKind('signature', t)).toBe(t('sig.role.signature'));
    expect(stampKind('initials', t)).toBe(t('sig.role.initials'));
    expect(stampKind('image', t)).toBe(t('img.add.label'));
  });
});

describe('armStamp', () => {
  it('arms the stamp tool with the picture and says where to click', () => {
    const picture = source();
    armStamp(picture, t);
    expect(coreStore.get()).toMatchObject({
      canvasTool: 'stamp',
      pendingStamp: picture,
      notice: t('sig.placing'),
    });
  });
});

describe('placeStamp', () => {
  function write(started: boolean) {
    return vi.fn<WriteFileAnnotation>(() => started);
  }

  it('does nothing when no picture is armed', () => {
    const writeFileAnnotation = write(true);
    placeStamp(placement, { writeFileAnnotation, author: 'Ada', t });
    expect(writeFileAnnotation).not.toHaveBeenCalled();
  });

  it('writes one stamp from the armed picture and returns to the select tool once it started', async () => {
    const picture = source('initials');
    armStamp(picture, t);
    const writeFileAnnotation = write(true);
    placeStamp(placement, { writeFileAnnotation, author: 'Ada', t });

    const kind = t('sig.role.initials');
    expect(writeFileAnnotation).toHaveBeenCalledTimes(1);
    const [label, run, done, page] = writeFileAnnotation.mock.calls[0] ?? [];
    expect(label).toEqual({ key: 'sig.placed', params: { kind } });
    expect(done).toBe(t('sig.placed', { kind }));
    expect(page).toBe(2);
    expect(coreStore.get().canvasTool).toBe('select');

    const outcome = { bytes: new Uint8Array([1]) };
    pdfCore.addImageStamp.mockResolvedValue(outcome);
    const base = new Uint8Array([7]);
    const signal = new AbortController().signal;
    await expect(run?.(base, signal)).resolves.toBe(outcome);
    expect(pdfCore.addImageStamp).toHaveBeenCalledWith(
      base,
      {
        id: expect.any(String),
        pageIndex: 2,
        center: { x: 100, y: 200 },
        width: 160,
        height: 64,
        image: picture.bytes,
        role: 'initials',
        label: kind,
        author: 'Ada',
      },
      { signal },
    );
  });

  it('keeps the stamp tool armed when the write did not start', () => {
    armStamp(source(), t);
    placeStamp(placement, { writeFileAnnotation: write(false), author: '', t });
    expect(coreStore.get().canvasTool).toBe('stamp');
  });
});

describe('resizeStamp', () => {
  const rect = [10, 20, 110, 70] as const;
  const stamp = { key: 'k1', family: 'existing', id: 'a1', pageIndex: 3, resizable: true } as MarkTarget;

  it.each([
    ['an unknown key', [stamp], 'missing'],
    ['a mark of another family', [{ ...stamp, family: 'pending' } as unknown as MarkTarget], 'k1'],
    ['a mark that cannot be resized', [{ ...stamp, resizable: false } as MarkTarget], 'k1'],
  ])('says it is not resizable for %s and writes nothing', (_name, targets, key) => {
    const writeFileAnnotation = vi.fn<WriteFileAnnotation>(() => true);
    resizeStamp(key, rect, { targets, writeFileAnnotation, t });
    expect(coreStore.get().notice).toBe(t('stamp.notResizable'));
    expect(writeFileAnnotation).not.toHaveBeenCalled();
  });

  it('writes the new box as one step', async () => {
    const writeFileAnnotation = vi.fn<WriteFileAnnotation>(() => true);
    resizeStamp('k1', rect, { targets: [stamp], writeFileAnnotation, t });
    const [label, run, done] = writeFileAnnotation.mock.calls[0] ?? [];
    expect(label).toEqual({ key: 'stamp.resize' });
    expect(done).toBe(t('stamp.resized'));

    const outcome = { bytes: new Uint8Array([1]) };
    pdfCore.resizeImageStamp.mockResolvedValue(outcome);
    const base = new Uint8Array([7]);
    const signal = new AbortController().signal;
    await expect(run?.(base, signal)).resolves.toBe(outcome);
    expect(pdfCore.resizeImageStamp).toHaveBeenCalledWith(base, { pageIndex: 3, id: 'a1', rect }, { signal });
  });
});

describe('the gate in front of the signature dialog and the image picker', () => {
  function gate(over: Partial<AddGate> = {}): AddGate {
    return { hasDocument: true, canEdit: true, refuseBusy: vi.fn(), ...over };
  }

  it('opens the dialog and clicks the picker for an editable, idle document', () => {
    const click = vi.fn();
    imageInputRef.current = { click } as unknown as HTMLInputElement;
    openSignature(gate());
    expect(stampsStore.get().signatureOpen).toBe(true);
    pickImage(gate());
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('does nothing, and says nothing, with no document open', () => {
    const refuseBusy = vi.fn();
    openSignature(gate({ hasDocument: false, refuseBusy }));
    pickImage(gate({ hasDocument: false, refuseBusy }));
    expect(stampsStore.get().signatureOpen).toBe(false);
    expect(refuseBusy).not.toHaveBeenCalled();
  });

  it('refuses while an operation holds the document', () => {
    const click = vi.fn();
    imageInputRef.current = { click } as unknown as HTMLInputElement;
    setBusy(true);
    const refuseBusy = vi.fn();
    openSignature(gate({ refuseBusy }));
    pickImage(gate({ refuseBusy }));
    expect(refuseBusy).toHaveBeenCalledTimes(2);
    expect(stampsStore.get().signatureOpen).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });

  it('refuses a read-only document', () => {
    const refuseBusy = vi.fn();
    openSignature(gate({ canEdit: false, refuseBusy }));
    expect(refuseBusy).toHaveBeenCalledTimes(1);
    expect(stampsStore.get().signatureOpen).toBe(false);
  });

  it('survives an image picker that is not mounted', () => {
    expect(() => pickImage(gate())).not.toThrow();
  });
});

describe('onImagePicked', () => {
  const file = new File([new Uint8Array([1])], 'logo.png', { type: 'image/png' });

  it('arms the stamp tool with the decoded picture', async () => {
    const picture = source('image');
    pdfCore.imageFromFile.mockResolvedValue(picture);
    await onImagePicked(file, t);
    expect(pdfCore.imageFromFile).toHaveBeenCalledWith(file);
    expect(coreStore.get()).toMatchObject({ canvasTool: 'stamp', pendingStamp: picture });
  });

  it('names the file when it cannot be read as a picture', async () => {
    pdfCore.imageFromFile.mockResolvedValue(null);
    await onImagePicked(file, t);
    expect(coreStore.get().notice).toBe(t('img.add.failed', { name: 'logo.png' }));
    expect(coreStore.get().pendingStamp).toBeNull();
  });
});

describe('placeSignature', () => {
  it('closes the dialog and arms the stamp tool with the chosen signature', () => {
    stampsStore.set({ signatureOpen: true });
    const picture = source();
    placeSignature(picture, false, true, t);
    expect(stampsStore.get().signatureOpen).toBe(false);
    expect(coreStore.get()).toMatchObject({ canvasTool: 'stamp', pendingStamp: picture });
  });
});
