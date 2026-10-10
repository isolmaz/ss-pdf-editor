/** What the annotation handlers need from the shell: the pieces it still owns. */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { SessionStore, SessionTab } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import type { DocumentContext } from '../../operations';

export interface AnnotationHost {
  readonly session: SessionStore;
  readonly t: Translator;
  /** The viewer's imperative API, set once per mounted document (`null` before it loads). */
  readonly viewer: { readonly current: ViewerApi | null };
  /** The running operation's abort controller; a sweep registers itself here while it holds the lock. */
  readonly cancel: { current: AbortController | null };
  /** The context an operation on `tab` runs in. */
  readonly contextFor: (tab: SessionTab, handle: PdfDocumentHandle) => DocumentContext;
  /** Swap `tabId`'s engine handle for the one an operation produced. */
  readonly setHandle: (tabId: string, handle: PdfDocumentHandle) => void;
}
