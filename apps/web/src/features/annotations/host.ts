/** What the annotation handlers need from the shell: the pieces it still owns. */

import type { SessionStore } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';

export interface AnnotationHost {
  readonly session: SessionStore;
  readonly t: Translator;
  /** The viewer's imperative API, set once per mounted document (`null` before it loads). */
  readonly viewer: { readonly current: ViewerApi | null };
}
