/** Freezing the working bytes the text tool reads its page model from. */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { SessionTab } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { useEffect } from 'react';
import { type DocumentContext, materializeBase } from '../../operations';
import { selectTool, showNotice, useCore } from '../core/core-store';
import { textToolBytesFrozen } from './text-tool-store';

/**
 * Freeze the working bytes for the text tool the moment it is armed. Arming is a user gesture,
 * so this is one engine pass per tool activation — not a per-render cost — and the model cannot
 * describe a document the user has already changed. A document that cannot be read says why on
 * the status line and returns the user to the select tool.
 */
export function useTextToolBytes(
  tab: SessionTab | null,
  handle: PdfDocumentHandle | null,
  contextFor: (tab: SessionTab, handle: PdfDocumentHandle) => DocumentContext,
  t: Translator,
): void {
  const armed = useCore((state) => state.canvasTool === 'text');
  useEffect(() => {
    if (!armed || tab === null || handle === null) {
      textToolBytesFrozen(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const bytes = await materializeBase(contextFor(tab, handle), {
          signal: new AbortController().signal,
        });
        if (!cancelled) textToolBytesFrozen(bytes);
      } catch (error) {
        if (cancelled) return;
        textToolBytesFrozen(null);
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
        selectTool('select');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, handle, contextFor, t, armed]);
}
