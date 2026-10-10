/**
 * What an operation on the document on screen asks of the shell: the context it runs in, the
 * device tier's verdict on the document and whether the document may be edited now. Every
 * helper reads the stores **at the moment it is called**, so a handler never acts on the
 * render it was created in.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { type SessionStore, type SessionTab, workingPageCount } from 'pdf-model';
import {
  checkDocumentLimits,
  type DeviceTier,
  detectDeviceTier,
  type LimitVerdict,
  type Translator,
} from 'pdf-shared';
import type { DocumentContext } from '../../operations';
import { openStore } from '../open/open-store';
import { saveStore } from '../save/save-store';
import { isBusy } from './core-store';
import { handleFor } from './handles';

let tier: DeviceTier | null = null;

/** The device tier this browser is, read once: it does not change while the page is open. */
export function deviceTier(): DeviceTier {
  tier ??= detectDeviceTier();
  return tier;
}

/** The context an operation on `tab` (rendered by `handle`) runs in. */
export function documentContext(
  session: SessionStore,
  t: Translator,
  tab: SessionTab,
  handle: PdfDocumentHandle,
): DocumentContext {
  return { store: session, t, tab, handle };
}

/** The tier's verdict on `tab`'s current bytes and page count; `null` for no tab. */
export function documentVerdict(tab: SessionTab | null, forTier: DeviceTier): LimitVerdict {
  if (tab === null) return checkDocumentLimits(forTier, 0, 0);
  const currentBytes = tab.working.produced?.bytes.byteLength ?? tab.source.size;
  return checkDocumentLimits(forTier, workingPageCount(tab), currentBytes);
}

export interface EditInput {
  readonly tab: SessionTab | null;
  readonly handle: PdfDocumentHandle | null;
  /** The viewer's document is `handle`: what is on screen is the engine handle the tab owns. */
  readonly viewerShowsHandle: boolean;
  readonly verdict: LimitVerdict;
  /** The tab is a protected document nothing can be written to. */
  readonly locked: boolean;
  readonly busy: boolean;
}

/**
 * The rule for editing: a document the viewer shows (its engine handle is the one on screen),
 * that the tier allows editing, is not protected and is not held by an operation.
 */
export function isEditable({ tab, handle, viewerShowsHandle, verdict, locked, busy }: EditInput): boolean {
  return (
    tab !== null &&
    handle !== null &&
    viewerShowsHandle &&
    verdict.kind !== 'viewing-only' &&
    !locked &&
    !busy
  );
}

/** Whether the active document may be edited **now**. */
export function canEdit(session: SessionStore): boolean {
  const tab = session.active;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  return isEditable({
    tab,
    handle,
    viewerShowsHandle: handle !== null && saveStore.get().viewer?.document === handle,
    verdict: documentVerdict(tab, deviceTier()),
    locked: tab !== null && openStore.get().lockedTabs.has(tab.id),
    busy: isBusy(),
  });
}
