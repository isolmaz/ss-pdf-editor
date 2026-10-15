/**
 * The result surface every operation ends in.
 *
 * The report is the product's honesty contract made visible: what the operation
 * removed, warned about, changed and preserved — grouped and translated — and the
 * page count and size delta. It is a panel and not a modal ("a report is produced
 * in the background ... a blocking confirmation appears only for destructive
 * steps"), so the same component can be rendered inside the operation dialog or
 * under a save.
 *
 * Three rendering rules carry the contract:
 *
 *  - **`lost` is read first and is never quieter than `preserved`.** The groups
 *    are ordered removed → warnings → (page count and size) → changes → preserved,
 *    and the loss group takes the strong text role while the preserved group
 *    recedes to the subtle one. A user who skims must not be able to come away
 *    believing a loss was a preservation.
 *  - **What only a developer reads is folded away.** Whether the file was
 *    rewritten, the engine step ids and the producer lines sit in one closed
 *    "Technical details" section. Only `changed` and `preserved` notes can go
 *    there: a loss or a warning is never hidden, whatever its key.
 *  - **Every sentence comes from the dictionary.** `OperationNote` carries an
 *    i18n key, never English text (`pdf-core/ops/types.ts`), so this file cannot
 *    invent product copy even by accident.
 */

import type { OperationNote, OperationNoteKind, OperationReport } from 'pdf-core/ops/types';
import type { MessageKey, Translator } from 'pdf-shared';
import { useId } from 'react';

/** What the reader must see before the numbers: what was removed and what to watch. */
const ALERT_KINDS: readonly OperationNoteKind[] = ['lost', 'warning'];
/** What the operation did and what it kept, read after the numbers. */
const CALM_KINDS: readonly OperationNoteKind[] = ['changed', 'preserved'];

/**
 * The notes about how the file was written rather than what is in it — the producer
 * line the editor keeps, the engine's own writer. They are true and stay in the
 * report, but they say nothing to someone who is not debugging the file.
 */
const TECHNICAL_NOTES: ReadonlySet<MessageKey> = new Set<MessageKey>([
  'op.note.metadata.producerKept',
  'op.note.redact.producerKept',
  'optimize.producerKept',
  'boxes.note.producer',
  'labels.note.info',
  'op.note.annotate.engine',
  'op.note.annotate.incremental',
]);

/** Group headings `op.result.losses`/`op.result.preserved` did not already name. */
const NOTE_HEADINGS: Record<OperationNoteKind, MessageKey> = {
  lost: 'op.result.losses',
  warning: 'dialog.result.warnings',
  changed: 'dialog.result.changed',
  preserved: 'op.result.preserved',
};

/**
 * The honesty contract as colour role: the loss group is the strong one, an
 * advisory takes the amber the rest of the product uses for warnings, and the
 * groups that describe survival recede. Status is never colour alone — each
 * group's own heading is the word.
 */
const NOTE_TONE: Record<OperationNoteKind, { readonly heading: string; readonly text: string }> = {
  lost: { heading: 'text-kumo-strong', text: 'text-kumo-default' },
  warning: { heading: 'text-kumo-warning', text: 'text-kumo-default' },
  changed: { heading: 'text-kumo-subtle', text: 'text-kumo-subtle' },
  preserved: { heading: 'text-kumo-subtle', text: 'text-kumo-subtle' },
};

export interface OperationReportPanelProps {
  readonly t: Translator;
  readonly report: OperationReport;
  /**
   * Extra notes to group with the engine's own — a capability's after-the-fact
   * observation, or the run's notice. Omitted, the report speaks for itself.
   */
  readonly notes?: readonly OperationNote[];
  /**
   * The heading. A result still waiting to be applied calls itself a review; omitted,
   * it is the report of an operation that is already done.
   */
  readonly title?: string;
}

export function OperationReportPanel({ t, report, notes, title }: OperationReportPanelProps) {
  const headingId = useId();
  const all = notes === undefined ? report.notes : [...report.notes, ...notes];
  const isTechnical = (note: OperationNote) =>
    (note.kind === 'changed' || note.kind === 'preserved') && TECHNICAL_NOTES.has(note.key);
  const technical = all.filter(isTechnical);
  const plain = all.filter((note) => !isTechnical(note));
  const sizeKey: MessageKey =
    report.outputBytes > report.inputBytes ? 'op.result.size.grew' : 'op.result.size';

  const groups = (kinds: readonly OperationNoteKind[]) =>
    kinds.map((kind) => {
      const group = plain.filter((note) => note.kind === kind);
      if (group.length === 0) return null;
      const tone = NOTE_TONE[kind];
      return (
        <div key={kind} className="flex flex-col gap-0.5">
          <h4 className={`text-xs font-semibold ${tone.heading}`}>{t(NOTE_HEADINGS[kind])}</h4>
          <ul className={`flex flex-col gap-0.5 text-xs ${tone.text}`}>
            {group.map((note, index) => (
              // Notes are positional data, not entities: the key is their place in
              // the group, and the group never reorders within a report.
              <li key={`${kind}-${String(index)}`}>{t(note.key, note.params)}</li>
            ))}
          </ul>
        </div>
      );
    });

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      {/* h3 under Kumo's Dialog.Title (the dialog's h2); the groups below are h4. */}
      <h3 id={headingId} className="text-sm font-semibold text-kumo-strong">
        {title ?? t('op.result.title')}
      </h3>

      {groups(ALERT_KINDS)}

      <ul className="flex flex-col gap-0.5 text-xs text-kumo-default">
        <li>{t('op.result.pages', { count: report.pageCount })}</li>
        <li className="tabular-nums">
          {t(sizeKey, {
            before: report.inputBytes,
            after: report.outputBytes,
          })}
        </li>
      </ul>

      {groups(CALM_KINDS)}

      <details className="text-xs text-kumo-subtle">
        <summary className="cursor-pointer select-none">{t('op.result.technical')}</summary>
        <ul className="mt-1 flex flex-col gap-0.5">
          <li>{t(report.incremental ? 'op.result.incremental' : 'op.result.fullRewrite')}</li>
          {report.steps.length === 0 ? null : (
            // Engine step ids (`pages`, `verify`) are identifiers, not copy: they are
            // joined into the dictionary's sentence rather than translated one by one.
            <li>{t('op.result.steps', { steps: report.steps.join(', ') })}</li>
          )}
          {technical.map((note, index) => (
            <li key={`technical-${String(index)}`}>{t(note.key, note.params)}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
