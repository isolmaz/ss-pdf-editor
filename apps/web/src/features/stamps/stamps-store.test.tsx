// @vitest-environment happy-dom
/**
 * The stamps store: the signature dialog's open state and the signatures the user chose to keep
 * on this device. What each action writes, and what reaches the browser's storage — a picture
 * is never kept, nor anything in a sensitive session, nor anything the user did not tick.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import type { SavedSignature, StampSource } from 'pdf-ui/dialog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSavedSignatures } from '../../signature-store';
import {
  closeSignatureDialog,
  forgetSavedSignature,
  initialStampsState,
  openSignatureDialog,
  signatureChosen,
  stampsStore,
  useStamps,
} from './stamps-store';

const saved: SavedSignature = {
  id: 'kept',
  role: 'signature',
  dataUrl: 'data:image/png;base64,AAAA',
  width: 200,
  height: 80,
};

function source(role: StampSource['role']): StampSource {
  return {
    role,
    bytes: new Uint8Array([1]),
    dataUrl: 'data:image/png;base64,BBBB',
    pixelWidth: 120,
    pixelHeight: 40,
  };
}

beforeEach(() => {
  localStorage.clear();
  stampsStore.set(initialStampsState());
});
afterEach(cleanup);

describe('the stamps store', () => {
  it('starts shut, with the signatures this browser kept', () => {
    expect(initialStampsState()).toEqual({ signatureOpen: false, savedSignatures: [] });
    localStorage.setItem('pdf-editor.signatures.v1', JSON.stringify([saved]));
    expect(initialStampsState()).toEqual({ signatureOpen: false, savedSignatures: [saved] });
  });

  it('opens and closes the signature dialog', () => {
    openSignatureDialog();
    expect(stampsStore.get().signatureOpen).toBe(true);
    closeSignatureDialog();
    expect(stampsStore.get().signatureOpen).toBe(false);
  });

  it('forgets a kept signature from the list and from the browser', () => {
    localStorage.setItem('pdf-editor.signatures.v1', JSON.stringify([saved]));
    stampsStore.set(initialStampsState());
    forgetSavedSignature('kept');
    expect(stampsStore.get().savedSignatures).toEqual([]);
    expect(loadSavedSignatures()).toEqual([]);
  });

  it('keeps a signature the user asked to remember, and closes the dialog either way', () => {
    openSignatureDialog();
    signatureChosen(source('initials'), true, true);
    const [kept] = stampsStore.get().savedSignatures;
    expect(stampsStore.get().signatureOpen).toBe(false);
    expect(kept).toMatchObject({
      role: 'initials',
      dataUrl: 'data:image/png;base64,BBBB',
      width: 120,
      height: 40,
    });
    expect(loadSavedSignatures()).toEqual([kept]);
  });

  it.each([
    ['not asked to', 'signature' as const, false, true],
    ['a picture', 'image' as const, true, true],
    ['a sensitive session', 'signature' as const, true, false],
  ])('keeps nothing when %s, but still closes the dialog', (_name, role, remember, canRemember) => {
    openSignatureDialog();
    signatureChosen(source(role), remember, canRemember);
    expect(stampsStore.get()).toEqual({ signatureOpen: false, savedSignatures: [] });
    expect(loadSavedSignatures()).toEqual([]);
  });

  it('re-renders only the component whose selected field changed', () => {
    let renders = 0;
    function Open() {
      renders += 1;
      return <p>{useStamps((state) => state.signatureOpen) ? 'open' : 'shut'}</p>;
    }
    render(<Open />);
    expect(screen.getByText('shut')).toBeTruthy();
    const before = renders;
    act(() => forgetSavedSignature('nothing'));
    expect(renders).toBe(before);
    act(() => openSignatureDialog());
    expect(screen.getByText('open')).toBeTruthy();
  });
});
