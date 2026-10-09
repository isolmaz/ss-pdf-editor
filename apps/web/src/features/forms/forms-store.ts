/**
 * What the shell knows about the forms of the document on screen: the file's own annotations
 * and form fields (each read from the bytes of **one version of one tab**), the field the user
 * picked, the review of detected fields, and the dynamic XFA form being filled.
 *
 * An inventory describes the bytes it was read from, so every one is tagged with the tab and
 * version it describes and a reader only sees the one that matches the tab it asks about: a
 * read that lands after an operation replaced that version is never mixed into the new one.
 */

import type { ExistingAnnotation, FormFieldInfo } from 'pdf-core';
import type { FormDetection } from 'pdf-core/ops/form-detect';
import type { XfaInfo } from 'pdf-core/ops/xfa';
import type { SessionTab } from 'pdf-model';
import type { ToolError } from 'pdf-shared';
import { createStore, type Equality, useStore } from '../store';

/**
 * The file's own annotations, **keyed to the bytes they were read from**.
 *
 * `readAnnotations` is async, so an inventory that has not arrived yet must not look like a
 * document with no annotations: the common layer's targets — and with them selection and
 * editing — stay unavailable until the inventory describing the version on screen has been
 * read, and a read that lands after a byte operation replaced that version is discarded
 * rather than mixed into the new one.
 *
 * The key is the produced version's own id
 * (or the source master), **not** `working.id`: drawing, erasing or undoing a mark journals an
 * overlay step and mints a new working id without touching a byte, and keying on that would
 * throw away a perfectly good inventory every time the user drew something.
 */
export interface ExistingInventory {
  readonly tabId: string;
  readonly bytesKey: string;
  readonly annotations: readonly ExistingAnnotation[];
}

/**
 * The form inventory of one tab's working version. Read from the **working bytes** rather than
 * from the viewer: a field list is a document fact, and re-reading it after every operation
 * keeps it true (a page delete can remove widgets).
 */
export interface FormInventory {
  readonly tabId: string;
  readonly version: string;
  readonly fields?: readonly FormFieldInfo[];
  /** What the version's XFA is (`null`: none); read with the fields, from the same bytes. */
  readonly xfa?: XfaInfo | null;
  readonly error?: ToolError;
}

/**
 * Prepare form: the detector's candidates for **one version of one document**, under review.
 * They describe the bytes they were read from, so a version change (the user's edit, or the
 * fields' own creation) ends the review: `currentDetect` reads `null` for any other version,
 * which is also how a landed write closes it.
 */
export interface FormDetect {
  readonly tabId: string;
  readonly version: string;
  readonly phase: 'scanning' | 'review';
  readonly detection: FormDetection | null;
  readonly removed: ReadonlySet<string>;
  readonly selectedId: string | null;
}

/**
 * The dynamic XFA form being filled: the tab it belongs to and the bytes frozen when the
 * dialog opened, so what is saved back is a change to exactly the version that was shown.
 */
export interface XfaFormOpen {
  readonly tab: SessionTab;
  readonly bytes: Uint8Array;
}

export interface FormsState {
  readonly existingInventory: ExistingInventory | null;
  readonly formInventory: FormInventory | null;
  /** Bumped by the "retry" buttons: the inventory and the document facts are read again. */
  readonly inspectionRevision: number;
  /** The field the user picked in the forms panel. */
  readonly selectedField: string | null;
  readonly formDetect: FormDetect | null;
  /** The XFA banner's "more" text is open. */
  readonly xfaDetailsOpen: boolean;
  readonly xfaForm: XfaFormOpen | null;
}

/** The state a fresh page starts in: nothing read, nothing under review. */
export function initialFormsState(): FormsState {
  return {
    existingInventory: null,
    formInventory: null,
    inspectionRevision: 0,
    selectedField: null,
    formDetect: null,
    xfaDetailsOpen: false,
    xfaForm: null,
  };
}

export const formsStore = createStore<FormsState>(initialFormsState());

/** The part of the forms state a component reads (see `useStore` for the selector rules). */
export function useForms<T>(selector: (state: FormsState) => T, equality?: Equality<T>): T {
  return useStore(formsStore, selector, equality);
}

// ── What the file carries ───────────────────────────────────────────────────────────────────

/** The annotations the file already carries were read for these bytes. */
export function existingInventoryRead(inventory: ExistingInventory): void {
  formsStore.set({ existingInventory: inventory });
}

/** The viewer went away or the read failed: unknown, not an empty document. */
export function existingInventoryUnknown(): void {
  formsStore.set({ existingInventory: null });
}

/** The form inventory is being read for a version (or, with `null`, there is nothing to read). */
export function formInventoryReading(tab: SessionTab | null): void {
  formsStore.set({
    formInventory: tab === null ? null : { tabId: tab.id, version: tab.working.id },
  });
}

export function formInventoryRead(inventory: FormInventory): void {
  formsStore.set({ formInventory: inventory });
}

/** "Retry": the inventory and the document facts are read again. */
export function retryInspection(): void {
  formsStore.set((state) => ({ inspectionRevision: state.inspectionRevision + 1 }));
}

// ── The forms panel ─────────────────────────────────────────────────────────────────────────

export function fieldSelected(name: string): void {
  formsStore.set({ selectedField: name });
}

export function toggleXfaDetails(): void {
  formsStore.set((state) => ({ xfaDetailsOpen: !state.xfaDetailsOpen }));
}

// ── Detecting fields ────────────────────────────────────────────────────────────────────────

/** The detector started on one version of one tab. */
export function detectStarted(tabId: string, version: string): void {
  formsStore.set({
    formDetect: {
      tabId,
      version,
      phase: 'scanning',
      detection: null,
      removed: new Set(),
      selectedId: null,
    },
  });
}

/** The detector finished; a review that was cancelled or replaced in the meantime stays so. */
export function detectFinished(tabId: string, version: string, detection: FormDetection): void {
  formsStore.set((state) => {
    const current = state.formDetect;
    return current?.tabId === tabId && current.version === version && current.phase === 'scanning'
      ? { formDetect: { ...current, phase: 'review', detection } }
      : {};
  });
}

/** The review ends (cancelled, or the detector failed). */
export function detectCancelled(): void {
  formsStore.set({ formDetect: null });
}

export function candidateSelected(id: string): void {
  formsStore.set((state) =>
    state.formDetect === null ? {} : { formDetect: { ...state.formDetect, selectedId: id } },
  );
}

export function candidateRemoved(id: string): void {
  formsStore.set((state) =>
    state.formDetect === null
      ? {}
      : { formDetect: { ...state.formDetect, removed: new Set(state.formDetect.removed).add(id) } },
  );
}

export function candidatesRestored(): void {
  formsStore.set((state) =>
    state.formDetect === null ? {} : { formDetect: { ...state.formDetect, removed: new Set() } },
  );
}

// ── The XFA form dialog ─────────────────────────────────────────────────────────────────────

export function xfaFormOpened(form: XfaFormOpen): void {
  formsStore.set({ xfaForm: form });
}

export function xfaFormClosed(): void {
  formsStore.set({ xfaForm: null });
}

// ── What is true of the tab on screen ───────────────────────────────────────────────────────

/** The annotations the file carries for the bytes `tab` shows, or `null` while unread or stale. */
export function existingAnnotationsOf(
  inventory: ExistingInventory | null,
  tab: SessionTab | null,
): readonly ExistingAnnotation[] | null {
  return inventory !== null &&
    tab !== null &&
    inventory.tabId === tab.id &&
    inventory.bytesKey === (tab.working.produced?.id ?? 'source')
    ? inventory.annotations
    : null;
}

/** The form inventory of `tab`'s current working version, or `null` when it is not read yet. */
export function formsOf(inventory: FormInventory | null, tab: SessionTab | null): FormInventory | null {
  return tab !== null && inventory?.tabId === tab.id && inventory.version === tab.working.id
    ? inventory
    : null;
}

/** The detector's review for `tab`'s current working version, or `null`. */
export function detectOf(detect: FormDetect | null, tab: SessionTab | null): FormDetect | null {
  return tab !== null && detect?.tabId === tab.id && detect.version === tab.working.id ? detect : null;
}

/** `tab`'s form inventory now, for a handler. */
export function currentForms(tab: SessionTab | null): FormInventory | null {
  return formsOf(formsStore.get().formInventory, tab);
}

/** `tab`'s detection review now, for a handler. */
export function currentDetect(tab: SessionTab | null): FormDetect | null {
  return detectOf(formsStore.get().formDetect, tab);
}

/** `currentForms`, read by a component: it renders again when the inventory or `tab` change. */
export function useCurrentForms(tab: SessionTab | null): FormInventory | null {
  return formsOf(
    useForms((state) => state.formInventory),
    tab,
  );
}

/** `currentDetect`, read by a component. */
export function useCurrentDetect(tab: SessionTab | null): FormDetect | null {
  return detectOf(
    useForms((state) => state.formDetect),
    tab,
  );
}

/** The file's annotations for `tab`'s bytes, read by a component. */
export function useExistingAnnotations(tab: SessionTab | null): readonly ExistingAnnotation[] | null {
  return existingAnnotationsOf(
    useForms((state) => state.existingInventory),
    tab,
  );
}
