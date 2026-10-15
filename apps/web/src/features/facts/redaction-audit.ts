/**
 * The object-level audit of a produced redaction. It runs on the
 * **working bytes**, and the needles it searches for are the words the user asked to erase — the
 * audit answers "did the file keep a trace of what was removed", which the redaction report alone
 * cannot.
 */

import type { RedactionAudit } from 'pdf-core';
import type { SessionStore } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { auditRedactedDocument } from '../../lazy-ops';
import { auditNotice, noticeLine } from '../../notices';
import { materializeBase, pendingOverlays, redactionNeedles } from '../../operations';
import { showNotice } from '../core/core-store';
import { runGatedOperation } from '../core/gated-operation';
import { handleFor } from '../core/handles';
import { createStore, useStore } from '../store';

/** An audit's findings, with the working version of the document they were read from. */
export interface AuditReport {
  /** `working.id` of the version the audit ran on: a report describes those bytes and no others. */
  readonly workingId: string;
  readonly audit: RedactionAudit;
}

export interface RedactionAuditState {
  /** The last audit's findings; `null` until one ran. */
  readonly report: AuditReport | null;
  /** An audit is running. */
  readonly loading: boolean;
}

export const redactionAuditStore = createStore<RedactionAuditState>({ report: null, loading: false });

export function useRedactionAudit<T>(selector: (state: RedactionAuditState) => T): T {
  return useStore(redactionAuditStore, selector);
}

export interface RedactionAuditRun {
  readonly store: SessionStore;
  readonly t: Translator;
  /** The words the applied redactions of `tabId` removed (read from the pre-redaction bytes). */
  readonly erasedTerms: (tabId: string) => readonly string[];
}

/**
 * Audit the active document. It holds the document like every other operation, so Cancel stops
 * it and a second press is refused; every failure is a notice, never a throw.
 */
export async function runRedactionAudit({ store, t, erasedTerms }: RedactionAuditRun): Promise<void> {
  const tab = store.active;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  if (tab === null || handle === null) return;
  await runGatedOperation(t, async (signal) => {
    redactionAuditStore.set({ loading: true });
    try {
      const bytes = await materializeBase({ store, t, tab, handle }, { signal });
      /**
       * The needles are the words the user erased: what the applied redactions removed plus
       * whatever the marks still pending cover. An empty list is not silently treated as
       * "nothing to find" — the notice below reports how many terms the scan actually had.
       */
      const pending = await redactionNeedles(
        bytes,
        pendingOverlays(tab).redactions.map((item) => item.mark),
        { signal },
      );
      const needles = [...new Set([...erasedTerms(tab.id), ...pending])];
      const audit = await auditRedactedDocument(bytes, needles, signal);
      redactionAuditStore.set({ report: { workingId: tab.working.id, audit } });
      showNotice(
        noticeLine(
          [
            auditNotice({
              terms: needles.length,
              contentFindings: audit.findings.filter((finding) => finding.severity === 'content').length,
            }),
          ],
          t,
        ),
      );
    } finally {
      redactionAuditStore.set({ loading: false });
    }
  });
}
