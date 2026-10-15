/**
 * The report of a result that was delivered without being read first — the "Details" action of
 * the notice that says it was applied (`review.ts` decides which results skip the review).
 *
 * It only shows: the result is already in the document (or a new tab, or downloaded), so the
 * one button closes. Escape and the backdrop are the same answer.
 */

import { Dialog } from '@cloudflare/kumo/components/dialog';
import type { OperationReport } from 'pdf-core/ops/types';
import type { Translator } from 'pdf-shared';
import { Button } from '../components/Button';
import { OperationReportPanel } from './ReportPanel';

export function ReportDialog({
  t,
  title,
  report,
  onClose,
}: {
  readonly t: Translator;
  /** The operation's title, as the delivered notice names it. */
  readonly title: string;
  readonly report: OperationReport;
  readonly onClose: () => void;
}) {
  return (
    <Dialog.Root
      open
      // The shell opens the dialog (it has no trigger), so the popup only ever asks to close.
      onOpenChange={(_open, details) => {
        details.cancel();
        onClose();
      }}
    >
      <Dialog size="lg" className="pdf-floating-shadow flex max-h-[85vh] w-full flex-col gap-3 p-5">
        <Dialog.Title className="text-sm font-semibold text-kumo-strong">{title}</Dialog.Title>
        <div className="min-h-0 flex-1 overflow-y-auto pe-1">
          <OperationReportPanel t={t} report={report} />
        </div>
        <div className="flex shrink-0 justify-end">
          <Button variant="outline" onClick={onClose}>
            {t('op.close')}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
