/**
 * Signatures the user chose to remember on this device.
 *
 * Opt-in only: the signature dialog's "remember on this device" box is off by default, and
 * nothing is kept unless it is ticked. A signature picture is personal data, so it stays in
 * this browser's `localStorage` and is never sent anywhere; every saved entry can be deleted
 * from the dialog. Each entry is the trimmed PNG as a data URL plus its pixel size — enough
 * to place it again without the original strokes.
 */

import type { SavedSignature } from 'pdf-ui/dialog';

const STORAGE_KEY = 'pdf-editor.signatures.v1';
/** A few signatures and initials, not an archive: older entries fall off the end. */
const MAX_SAVED = 6;
/** A remembered picture larger than this is refused rather than filling the quota. */
const MAX_DATA_URL = 512 * 1024;

function isSaved(value: unknown): value is SavedSignature {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    (item.role === 'signature' || item.role === 'initials') &&
    typeof item.dataUrl === 'string' &&
    item.dataUrl.startsWith('data:image/png;base64,') &&
    typeof item.width === 'number' &&
    typeof item.height === 'number'
  );
}

export function loadSavedSignatures(): SavedSignature[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSaved) : [];
  } catch {
    return [];
  }
}

function store(items: readonly SavedSignature[]): SavedSignature[] {
  const kept = items.slice(0, MAX_SAVED);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Quota or a disabled storage: the signature is still placed, only not remembered.
  }
  return kept;
}

export function rememberSignature(signature: SavedSignature): SavedSignature[] {
  if (signature.dataUrl.length > MAX_DATA_URL) return loadSavedSignatures();
  const others = loadSavedSignatures().filter((item) => item.dataUrl !== signature.dataUrl);
  return store([signature, ...others]);
}

export function forgetSignature(id: string): SavedSignature[] {
  return store(loadSavedSignatures().filter((item) => item.id !== id));
}
