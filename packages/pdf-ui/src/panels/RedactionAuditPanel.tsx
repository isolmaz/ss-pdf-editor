/**
 * The redaction audit report: what a produced
 * document still carries after the erasure, in the user's language.
 *
 * The panel renders a report; it never produces one. `pdf-core`'s
 * `auditRedactedDocument` does the scanning and hands back findings whose sentences
 * are dictionary keys, so this file owns only order, tone and the two body states.
 *
 * Three rendering rules carry the contract:
 *
 *  - **Content first, and never quieter than the rest.** The groups are read
 *    `content` → `warning` → `info` (`ReportPanel` uses the same idea for operation
 *    notes): a row that says the erased text may still be in the file cannot sit
 *    below rows that say something reassuring.
 *  - **No colour alone.** Each group has its own heading word — "İçerik", "Uyarı",
 *    "Bilgi" — so the tone is a second channel, never the only one (`DESIGN.md`).
 *  - **The summary is a live region, and it exists before it has anything to say.**
 *    A polite region created together with its first sentence is not announced, so
 *    the element is always in the tree and only its text arrives with the report.
 *
 * The panel's own copy keys (title, summary, headings, button, the two states) are
 * literals of `packages/shared/src/i18n/parts/audit.ts`, which the integration owner
 * folds into `tr.ts`; until that merge `MessageKey` cannot name them, which is what
 * the `as MessageKey` below is — a seam, not a second dictionary. Finding sentences
 * need no such thing: their key arrives already typed as `MessageKey`.
 */

import type { AuditFinding, RedactionAudit } from 'pdf-core/ops/redact-audit';
import { formatBytes } from 'pdf-core/ops/types';
import type { MessageKey, Translator } from 'pdf-shared';
import { useId } from 'react';
import { Button } from '../components/Button';
import { PanelLoading, PanelMessage } from './PanelParts';

export interface RedactionAuditPanelProps {
  readonly t: Translator;
  readonly audit: RedactionAudit | null;
  readonly loading?: boolean;
  readonly onRerun?: () => void;
}

type Severity = AuditFinding['severity'];

/** Reading order of the groups: content that may still be there, then everything else. */
const SEVERITY_ORDER: readonly Severity[] = ['content', 'warning', 'info'];

const SEVERITY_HEADING: Record<Severity, MessageKey> = {
  content: 'audit.group.content' as MessageKey,
  warning: 'audit.group.warning' as MessageKey,
  info: 'audit.group.info' as MessageKey,
};

/**
 * Tone per group. The heading takes the severity's own colour and the rows follow:
 * `content` is the danger role and carries a tint so the rows that matter are found
 * at a glance, `warning` is the amber the rest of the product uses for advisories,
 * and `info` — the clean rows and the file's shape — recedes to the subtle role.
 */
const SEVERITY_TONE: Record<Severity, { readonly heading: string; readonly row: string }> = {
  content: { heading: 'text-kumo-danger', row: 'bg-kumo-tint text-kumo-default' },
  warning: { heading: 'text-kumo-warning', row: 'text-kumo-default' },
  info: { heading: 'text-kumo-subtle', row: 'text-kumo-subtle' },
};

export function RedactionAuditPanel({ t, audit, loading = false, onRerun }: RedactionAuditPanelProps) {
  const baseId = useId();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-kumo-line px-2 py-1.5">
        <div className="flex items-center gap-1">
          <h3 className="min-w-0 flex-1 text-xs font-semibold text-kumo-default">
            {t('audit.title' as MessageKey)}
          </h3>
          <Button variant="outline" disabled={loading || onRerun === undefined} onClick={onRerun}>
            {t('audit.rerun' as MessageKey)}
          </Button>
        </div>
        {/* Always in the tree: see the live-region rule in this file's header. */}
        <p aria-live="polite" className="min-h-[1.1rem] text-[11px] tabular-nums text-kumo-subtle">
          {audit === null
            ? ''
            : t('audit.summary' as MessageKey, {
                objects: audit.objectCount,
                revisions: audit.revisionCount,
                bytes: formatBytes(audit.bytes),
              })}
        </p>
      </div>

      {loading ? (
        <div role="status" aria-label={t('audit.loading' as MessageKey)}>
          <PanelLoading />
        </div>
      ) : audit === null ? (
        <PanelMessage text={t('audit.empty' as MessageKey)} />
      ) : (
        <section
          aria-label={t('audit.findings' as MessageKey)}
          className="min-h-0 flex-1 overflow-y-auto p-1"
        >
          {SEVERITY_ORDER.map((severity) => {
            const group = audit.findings.filter((finding) => finding.severity === severity);
            if (group.length === 0) return null;
            const headingId = `${baseId}-${severity}`;
            const tone = SEVERITY_TONE[severity];
            return (
              <div key={severity} className="pb-1">
                <h4 id={headingId} className={`px-1.5 pb-0.5 text-[11px] font-semibold ${tone.heading}`}>
                  {t(SEVERITY_HEADING[severity])}
                </h4>
                <ul aria-labelledby={headingId} className="flex flex-col">
                  {group.map((finding, index) => (
                    // Findings are positional data, not entities: the key is their
                    // place in a report that never reorders.
                    <li
                      key={`${severity}-${String(index)}`}
                      className={`flex items-baseline gap-1.5 rounded-sm px-1.5 py-1 ${tone.row}`}
                    >
                      <span className="min-w-0 flex-1 break-words text-xs">
                        {t(finding.key, finding.params)}
                      </span>
                      {/* PDF notation (`object 12 0 R`, `byte 1042`), not copy: it is
                          shown as the engine wrote it, in either language. */}
                      {finding.where === undefined ? null : (
                        <span className="shrink-0 text-[11px] tabular-nums text-kumo-subtle">
                          {finding.where}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
