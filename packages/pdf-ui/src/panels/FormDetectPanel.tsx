/**
 * "Detect fields" in the forms tab: start the detection, review what it found, add it.
 *
 * Three states, kept by the shell (the panel holds none): idle (one button and a sentence
 * that says what it does), scanning, and review. In review the page carries a frame per
 * candidate (`FieldCandidateLayer`); this list is the same set as text, so a candidate can
 * be found and removed without hunting for its frame, and the notes say what the detector
 * could not read (a scan with no text, pages read from pixels).
 *
 * The panel never writes to the document; "add" hands the kept candidates to the shell,
 * which runs the operation and journals it like every other edit.
 */

import { X } from '@phosphor-icons/react';
import type { FieldCandidate, FormDetection } from 'pdf-core/ops/form-detect';
import type { MessageKey, Translator } from 'pdf-shared';
import { Button } from '../components/Button';

export type FormDetectPhase = 'idle' | 'scanning' | 'review';

export interface FormDetectPanelProps {
  readonly t: Translator;
  readonly phase: FormDetectPhase;
  readonly detection: FormDetection | null;
  /** Ids the user took out of the review. */
  readonly removed: ReadonlySet<string>;
  readonly selectedId: string | null;
  /** Editing is allowed (a document, no tier limit, no operation running). */
  readonly disabled: boolean;
  readonly onDetect: () => void;
  readonly onCancel: () => void;
  readonly onApply: () => void;
  readonly onRemove: (id: string) => void;
  readonly onRestore: () => void;
  readonly onSelect: (id: string) => void;
}

const KIND_KEYS: Record<FieldCandidate['kind'], MessageKey> = {
  text: 'form.kind.text',
  checkbox: 'form.kind.checkbox',
  radio: 'form.kind.radio',
  signature: 'form.kind.signature',
};

const SOURCE_KEYS: Record<FieldCandidate['source'], MessageKey> = {
  line: 'formDetect.source.line',
  blank: 'formDetect.source.blank',
  box: 'formDetect.source.box',
  comb: 'formDetect.source.comb',
  cell: 'formDetect.source.cell',
  glyph: 'formDetect.source.glyph',
  square: 'formDetect.source.square',
  circle: 'formDetect.source.circle',
  colon: 'formDetect.source.colon',
};

/** `1, 2, 5` for the notes that name pages. */
function pageList(pages: readonly number[]): string {
  return pages.map((page) => page + 1).join(', ');
}

export function FormDetectPanel({
  t,
  phase,
  detection,
  removed,
  selectedId,
  disabled,
  onDetect,
  onCancel,
  onApply,
  onRemove,
  onRestore,
  onSelect,
}: FormDetectPanelProps) {
  if (phase !== 'review' || detection === null) {
    return (
      <div className="shrink-0 border-b border-kumo-line px-2 py-2" data-form-detect={phase}>
        <p className="mb-2 text-xs text-kumo-subtle">
          {phase === 'scanning' ? t('formDetect.panel.scanning') : t('formDetect.panel.intro')}
        </p>
        <Button
          variant="outline"
          disabled={disabled || phase === 'scanning'}
          aria-busy={phase === 'scanning'}
          onClick={onDetect}
        >
          {t('formDetect.panel.start')}
        </Button>
      </div>
    );
  }

  const kept = detection.candidates.filter((candidate) => !removed.has(candidate.id));
  const high = kept.filter((candidate) => candidate.confidence === 'high').length;
  const notes: string[] = [];
  if (detection.needsOcr.length > 0) {
    notes.push(t('formDetect.needsOcr', { pages: pageList(detection.needsOcr) }));
  }
  if (detection.rasterPages.length > 0) {
    notes.push(t('formDetect.raster', { pages: pageList(detection.rasterPages) }));
  }
  if (detection.alreadyFields > 0) notes.push(t('formDetect.already', { count: detection.alreadyFields }));
  if (detection.truncated) notes.push(t('formDetect.truncated', { count: detection.candidates.length }));

  return (
    <div
      className="flex max-h-[60%] min-h-0 shrink-0 flex-col border-b border-kumo-line"
      data-form-detect="review"
    >
      <div className="shrink-0 px-2 pt-2">
        <p aria-live="polite" className="text-xs text-kumo-default" data-form-detect-summary="">
          {detection.candidates.length === 0
            ? t('formDetect.panel.none')
            : t('formDetect.panel.found', {
                count: kept.length,
                high,
                medium: kept.length - high,
              })}
        </p>
        {detection.candidates.length > 0 ? (
          <p className="mt-1 text-[11px] text-kumo-subtle">{t('formDetect.panel.hint')}</p>
        ) : null}
        {notes.map((note) => (
          <p key={note} className="mt-1 text-[11px] text-kumo-warning" role="note">
            {note}
          </p>
        ))}
        <div className="my-2 flex flex-wrap gap-1">
          <Button
            variant="primary"
            disabled={disabled || kept.length === 0}
            data-form-detect-apply=""
            onClick={onApply}
          >
            {kept.length === 0 && detection.candidates.length > 0
              ? t('formDetect.panel.nothingLeft')
              : t('formDetect.panel.create', { count: kept.length })}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            {t('formDetect.panel.cancel')}
          </Button>
          {removed.size > 0 ? (
            <Button variant="outline" onClick={onRestore}>
              {t('formDetect.panel.restore')}
            </Button>
          ) : null}
          <Button variant="outline" disabled={disabled} onClick={onDetect}>
            {t('formDetect.panel.again')}
          </Button>
        </div>
      </div>
      {detection.candidates.length > 0 ? (
        <ul
          aria-label={t('formDetect.panel.list')}
          className="min-h-0 flex-1 overflow-y-auto border-t border-kumo-line p-1"
        >
          {kept.map((candidate) => (
            <li key={candidate.id} data-field-candidate-row={candidate.id} className="mb-0.5">
              <div
                className={`flex items-center gap-1 rounded-sm px-1.5 py-1 ${
                  candidate.id === selectedId
                    ? 'bg-kumo-tint outline outline-1 outline-kumo-focus'
                    : 'hover:bg-kumo-tint'
                }`}
              >
                <button
                  type="button"
                  aria-current={candidate.id === selectedId ? 'true' : undefined}
                  onClick={() => onSelect(candidate.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-start"
                  title={t(SOURCE_KEYS[candidate.source])}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-kumo-default">
                    {candidate.name}
                    {candidate.option === undefined ? '' : ` · ${candidate.option}`}
                  </span>
                  <span
                    className={`shrink-0 text-[10px] ${
                      candidate.confidence === 'high' ? 'text-kumo-subtle' : 'text-kumo-warning'
                    }`}
                    title={t(
                      candidate.confidence === 'high'
                        ? 'formDetect.confidence.high.hint'
                        : 'formDetect.confidence.medium.hint',
                    )}
                  >
                    {t(
                      candidate.confidence === 'high'
                        ? 'formDetect.confidence.high'
                        : 'formDetect.confidence.medium',
                    )}
                  </span>
                  <span className="shrink-0 text-[10px] text-kumo-subtle">
                    {t(KIND_KEYS[candidate.kind])} · {candidate.pageIndex + 1}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={t('formDetect.remove', { name: candidate.name })}
                  onClick={() => onRemove(candidate.id)}
                  className="shrink-0 rounded-sm p-0.5 text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-danger"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
