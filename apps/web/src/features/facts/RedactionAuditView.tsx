import { lazy, Suspense } from 'react';
import { type RedactionAuditRun, runRedactionAudit, useRedactionAudit } from './redaction-audit';

// A dynamic chunk: the shell's first paint must not carry the panels (the entry budget is locked).
const RedactionAuditPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.RedactionAuditPanel };
});

/** The right dock's redaction-audit tab: the last audit, and the button that runs it again. */
export function RedactionAuditView({ store, t, erasedTerms }: RedactionAuditRun) {
  const report = useRedactionAudit((state) => state.report);
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
