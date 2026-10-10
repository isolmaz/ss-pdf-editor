/**
 * What the signature dialog shows: whether it is open, and the signatures the user chose to
 * remember on this device. Remembered signatures are opt-in and stay in this browser
 * (`signature-store.ts`). The picture the `stamp` tool places next is **not** here — it is the
 * core store's `pendingStamp`, because any other tool dropping it is a tool-change rule.
 */

import type { SavedSignature, StampSource } from 'pdf-ui/dialog';
import { forgetSignature, loadSavedSignatures, rememberSignature } from '../../signature-store';
import { createStore, type Equality, useStore } from '../store';

export interface StampsState {
  /** The simple-signature dialog is open. */
  readonly signatureOpen: boolean;
  /** The signatures the user kept (newest first). */
  readonly savedSignatures: readonly SavedSignature[];
}

/** The state a fresh page starts in: the dialog shut, the kept signatures read from this browser. */
export function initialStampsState(): StampsState {
  return { signatureOpen: false, savedSignatures: loadSavedSignatures() };
}

export const stampsStore = createStore<StampsState>(initialStampsState());

/** The part of the stamps state a component reads (see `useStore` for the selector rules). */
export function useStamps<T>(selector: (state: StampsState) => T, equality?: Equality<T>): T {
  return useStore(stampsStore, selector, equality);
}

export function openSignatureDialog(): void {
  stampsStore.set({ signatureOpen: true });
}

export function closeSignatureDialog(): void {
  stampsStore.set({ signatureOpen: false });
}

/** The dialog's "forget" button: the entry leaves the browser's storage and the list. */
export function forgetSavedSignature(id: string): void {
  stampsStore.set({ savedSignatures: forgetSignature(id) });
}

/**
 * The dialog's "use": the dialog closes, and the signature joins the kept list when the user
 * asked for it. Nothing is kept for a picture (only a signature or initials are) or when the
 * session is sensitive (`canRemember` is `false`).
 */
export function signatureChosen(source: StampSource, remember: boolean, canRemember: boolean): void {
  stampsStore.set(
    remember && source.role !== 'image' && canRemember
      ? {
          signatureOpen: false,
          savedSignatures: rememberSignature({
            id: crypto.randomUUID(),
            role: source.role,
            dataUrl: source.dataUrl,
            width: source.pixelWidth,
            height: source.pixelHeight,
          }),
        }
      : { signatureOpen: false },
  );
}
