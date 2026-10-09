import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { listPdfSignatureFields, type PdfSignatureField } from 'pdf-core/signature-fields';
import { type ToolError, type Translator, toToolError } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PanelLoading, PanelMessage } from './PanelParts';

/**
 * The signature fields of the document ("İmzalar"). A reader
 * panel and nothing more: it lists the fields the AcroForm declares, says whether the
 * document carries a signature for each one, and jumps to the page the field is on.
 * Signing is `ops/sign.ts`; verification status is shown in the properties panel.
 */

export interface SignaturesPanelProps {
  readonly document: PdfDocumentHandle;
  readonly t: Translator;
  /** 0-based page navigation, shared with the panel's other views. */
  readonly onGoToPage: (pageIndex: number) => void;
  /** The shell's notice line (`features/core/core-store.ts`) — receives already-translated text. */
  readonly onNotice?: (message: string) => void;
}

interface SignaturesState {
  /** `null` while the engine has not answered yet. */
  readonly fields: readonly PdfSignatureField[] | null;
  readonly failure: ToolError | null;
}

const INITIAL: SignaturesState = { fields: null, failure: null };

export function SignaturesPanel({ document, t, onGoToPage, onNotice }: SignaturesPanelProps) {
  const [state, setState] = useState<SignaturesState>(INITIAL);
  const handlers = useRef({ onNotice, t });
  useEffect(() => {
    handlers.current = { onNotice, t };
  });

  const report = useCallback((error: ToolError) => {
    const { onNotice: notify, t: translate } = handlers.current;
    notify?.(`${translate(error.messageKey)} ${translate(error.hintKey)}`);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState(INITIAL);

    void (async () => {
      try {
        const fields = await listPdfSignatureFields(document);
        if (controller.signal.aborted) return;
        setState({ fields, failure: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        const failure = toToolError(error, 'ui');
        setState({ fields: [], failure });
        report(failure);
      }
    })();

    return () => controller.abort();
  }, [document, report]);

  if (state.failure !== null)
    return <PanelMessage text={`${t(state.failure.messageKey)} ${t(state.failure.hintKey)}`} />;
  if (state.fields === null) return <PanelLoading />;
  if (state.fields.length === 0) return <PanelMessage text={t('panel.signatures.empty')} />;

  return (
    <ul className="min-h-0 flex-1 overflow-y-auto p-1" aria-label={t('panel.signatures')}>
      {state.fields.map((field) => {
        const { pageIndex } = field;
        return (
          <li key={`${field.id}-${field.name}`}>
            <button
              type="button"
              // A field the engine gave no page for stays listable, it just cannot be
              // walked to — the same rule the outline's unresolvable entries follow.
              disabled={pageIndex === null}
              title={pageIndex === null ? field.name : t('panel.goToPage', { page: pageIndex + 1 })}
              onClick={pageIndex === null ? undefined : () => onGoToPage(pageIndex)}
              className="w-full rounded-sm px-1.5 py-1 text-start hover:bg-kumo-tint disabled:hover:bg-transparent"
            >
              <span className="block truncate text-xs text-kumo-default">{field.name}</span>
              <span className="block text-[11px] text-kumo-subtle">
                {t(field.signed ? 'panel.signatures.signed' : 'panel.signatures.unsigned')}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
