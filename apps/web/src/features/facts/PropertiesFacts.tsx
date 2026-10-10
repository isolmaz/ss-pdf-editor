import type { SessionTab } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { Button } from 'pdf-ui/ui';
import { lazy, Suspense } from 'react';
import { useCurrentFacts, useCurrentFactsError } from './facts-store';
import {
  importRevocationLists,
  importTrustRoots,
  removeRevocationListById,
  removeTrustRootById,
  useTrust,
} from './trust-store';

/**
 * The properties panel is the only consumer of the font reader, the signature verifier and the
 * embedded-file writer; loading them with the shell would put a capability nobody has asked for
 * into the first paint. The budget is a locked decision, so the split is where it belongs: in
 * the module graph.
 */
const PropertiesPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.PropertiesPanel };
});

export interface PropertiesFactsProps {
  readonly t: Translator;
  /** The active tab: the facts shown are the ones read from its current working version. */
  readonly tab: SessionTab | null;
  /** Editing is off: the attachment writes are disabled. */
  readonly disabled: boolean;
  /** The user asked to read the facts again after a failure. */
  readonly onRetry: () => void;
  readonly onAddAttachments: (files: readonly File[]) => void;
  readonly onRemoveAttachment: (name: string) => void;
  readonly onReadAttachment: (name: string) => void;
}

/** The right dock's properties tab: the document's facts and the trust the verdicts are judged by. */
export function PropertiesFacts({
  t,
  tab,
  disabled,
  onRetry,
  onAddAttachments,
  onRemoveAttachment,
  onReadAttachment,
}: PropertiesFactsProps) {
  const facts = useCurrentFacts(tab);
  const error = useCurrentFactsError(tab);
  const trustRoots = useTrust((state) => state.roots);
  const revocationLists = useTrust((state) => state.lists);
  return (
    <Suspense
      fallback={
        <p aria-busy="true" className="p-2 text-xs text-kumo-subtle">
          {t('props.title')}
        </p>
      }
    >
      {error !== null ? (
        <div role="alert" className="flex flex-col gap-2 p-2 text-xs text-kumo-danger">
          <p>
            {t(error.messageKey)} {t(error.hintKey)}
          </p>
          <Button variant="outline" onClick={onRetry}>
            {t('inspection.retry')}
          </Button>
        </div>
      ) : (
        <PropertiesPanel
          t={t}
          fonts={facts?.fonts ?? null}
          attachments={facts?.attachments ?? []}
          signatures={facts?.signatures ?? []}
          trustRoots={trustRoots}
          onRemoveTrustRoot={removeTrustRootById}
          onImportTrustRoots={(imported) => importTrustRoots(imported, t)}
          revocationLists={revocationLists}
          onRemoveRevocationList={removeRevocationListById}
          onImportRevocationLists={(imported) => importRevocationLists(imported, t)}
          security={facts?.security ?? null}
          loading={facts === null}
          disabled={disabled}
          onAddAttachments={onAddAttachments}
          onRemoveAttachment={onRemoveAttachment}
          onReadAttachment={onReadAttachment}
        />
      )}
    </Suspense>
  );
}
