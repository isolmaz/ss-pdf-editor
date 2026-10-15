import { lazy, Suspense } from 'react';
import { type RedactionAuditRun, runRedactionAudit, useRedactionAudit } from './redaction-audit';

// A dynamic chunk: the shell's first paint must not carry the panels (the entry budget is locked).
const RedactionAuditPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.RedactionAuditPanel };
});

export interface RedactionAuditViewProps extends RedactionAuditRun {
  /** `working.id` of the version on screen: only a report read from it is shown. */
  readonly workingId: string;
}

/** The right dock's redaction-audit tab: the last audit of this version, and the button that runs it again. */
export function RedactionAuditView({ store, t, erasedTerms, workingId }: RedactionAuditViewProps) {
  // A report read from another version of the document, or from another tab, is not shown.
  const report = useRedactionAudit((state) =>
    state.report?.workingId === workingId ? state.report.audit : null,
  );
  const loading = useRedactionAudit((state) => state.loading);
  return (
    <Suspense
      fallback={
        <p aria-busy="true" className="p-2 text-xs text-kumo-subtle">
          {t('audit.title')}
        </p>
      }
    >
      <RedactionAuditPanel
        t={t}
        audit={report}
        loading={loading}
        onRerun={() => void runRedactionAudit({ store, t, erasedTerms })}
      />
    </Suspense>
  );
}
