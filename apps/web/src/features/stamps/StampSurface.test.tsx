// @vitest-environment happy-dom
/**
 * The stamp feature's markup as the user meets it: the placement layer only while the stamp
 * tool holds a picture on an editable document, the signature dialog with its kept signatures,
 * and the hidden input behind "add an image".
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import type { StampSource } from 'pdf-ui/dialog';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { armStampTool, coreStore, initialCoreState } from '../core/core-store';
import { ImagePickerInput, SignatureDialogHost, StampPlacementHost } from './StampSurface';
import { initialStampsState, openSignatureDialog, stampsStore } from './stamps-store';

const t = createTranslator('en');
const viewer = {} as unknown as ViewerApi;
const picture: StampSource = {
  role: 'signature',
  bytes: new Uint8Array([1]),
  dataUrl: 'data:image/png;base64,AAAA',
  pixelWidth: 100,
  pixelHeight: 40,
};
const kept = {
  id: 'kept',
  role: 'signature' as const,
  dataUrl: 'data:image/png;base64,AAAA',
  width: 100,
  height: 40,
};

// The dialog is a dynamic chunk: load it once up front so no test races the first import.
beforeAll(async () => {
  await import('pdf-ui/dialog');
}, 120_000);
beforeEach(() => {
  localStorage.clear();
  coreStore.set(initialCoreState());
  stampsStore.set(initialStampsState());
});
afterEach(cleanup);

describe('StampPlacementHost', () => {
  function host(over: { viewer?: ViewerApi | null; canEdit?: boolean } = {}) {
    return render(
      <StampPlacementHost
        viewer={over.viewer === undefined ? viewer : over.viewer}
        canEdit={over.canEdit ?? true}
        t={t}
        onPlace={vi.fn()}
      />,
    );
  }

  it('shows nothing until the stamp tool is armed with a picture', () => {
    const { container } = host();
    expect(container.querySelector('[data-stamp-placement]')).toBeNull();
    coreStore.set({ canvasTool: 'stamp' });
    expect(container.querySelector('[data-stamp-placement]')).toBeNull();
    act(() => armStampTool(picture));
    expect(container.querySelector('[data-stamp-placement]')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe(t('sig.placing'));
  });

  it('shows nothing without a viewer or on a read-only document', () => {
    armStampTool(picture);
    expect(host({ viewer: null }).container.querySelector('[data-stamp-placement]')).toBeNull();
    cleanup();
    expect(host({ canEdit: false }).container.querySelector('[data-stamp-placement]')).toBeNull();
  });

  it('puts the pointer back in the select tool on Escape', () => {
    armStampTool(picture);
    host();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(coreStore.get().canvasTool).toBe('select');
  });
});

describe('SignatureDialogHost', () => {
  it('renders nothing while the dialog is shut', () => {
    const { container } = render(<SignatureDialogHost t={t} canRemember />);
    expect(container.textContent).toBe('');
  });

  it('opens the dialog, and Cancel closes it', async () => {
    const user = userEvent.setup();
    render(<SignatureDialogHost t={t} canRemember />);
    act(() => openSignatureDialog());
    await screen.findByText(t('sig.dialog.title'));
    expect(screen.getByText(t('sig.remember'))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('sig.cancel') }));
    expect(stampsStore.get().signatureOpen).toBe(false);
    await waitFor(() => expect(screen.queryByText(t('sig.dialog.title'))).toBeNull());
  });

  it('offers no "remember" box in a sensitive session', async () => {
    render(<SignatureDialogHost t={t} canRemember={false} />);
    act(() => openSignatureDialog());
    await screen.findByText(t('sig.dialog.title'));
    expect(screen.queryByText(t('sig.remember'))).toBeNull();
  });

  it('uses a kept signature: the dialog closes and the stamp tool holds it', async () => {
    const user = userEvent.setup();
    stampsStore.set({ savedSignatures: [kept] });
    render(<SignatureDialogHost t={t} canRemember />);
    act(() => openSignatureDialog());
    await user.click(
      await screen.findByRole('button', { name: t('sig.saved.use', { label: t('sig.role.signature') }) }),
    );
    expect(stampsStore.get().signatureOpen).toBe(false);
    expect(coreStore.get()).toMatchObject({ canvasTool: 'stamp', notice: t('sig.placing') });
    expect(coreStore.get().pendingStamp).toMatchObject({ role: 'signature', dataUrl: kept.dataUrl });
  });

  it('forgets a kept signature from the list', async () => {
    const user = userEvent.setup();
    localStorage.setItem('pdf-editor.signatures.v1', JSON.stringify([kept]));
    stampsStore.set(initialStampsState());
    render(<SignatureDialogHost t={t} canRemember />);
    act(() => openSignatureDialog());
    await user.click(
      await screen.findByRole('button', { name: t('sig.saved.delete', { label: t('sig.role.signature') }) }),
    );
    expect(stampsStore.get().savedSignatures).toEqual([]);
    expect(localStorage.getItem('pdf-editor.signatures.v1')).toBe('[]');
  });
});

describe('ImagePickerInput', () => {
  it('is hidden from the user and the tab order', () => {
    const { container } = render(<ImagePickerInput t={t} />);
    const input = container.querySelector('input[type="file"]');
    expect(input?.getAttribute('aria-hidden')).toBe('true');
    expect(input?.getAttribute('tabindex')).toBe('-1');
  });

  it('names a chosen file the browser cannot read as a picture, and resets the input', async () => {
    const user = userEvent.setup();
    const { container } = render(<ImagePickerInput t={t} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' });
    await user.upload(input, file);
    await waitFor(() => expect(coreStore.get().notice).toBe(t('img.add.failed', { name: 'x.png' })), {
      timeout: 30_000,
    });
    expect(input.value).toBe('');
  }, 40_000);

  it('does nothing when the picker is dismissed without a file', () => {
    const { container } = render(<ImagePickerInput t={t} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input);
    expect(coreStore.get().notice).toBeNull();
  });
});
