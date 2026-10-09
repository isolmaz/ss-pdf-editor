/**
 * The review of detected form fields, drawn on the pages.
 *
 * Each candidate (`pdf-core/ops/form-detect.ts`) is a frame over the place the page asks to
 * be written in, in the colour of its confidence: solid for a field with a label and a drawn
 * place, dashed for one the detector inferred. The user removes the ones they do not want
 * with the ✕ at a frame's corner (or Delete on a focused frame); what is left is created.
 *
 * Frames are placed at render from the page's own geometry (`pageFramesAt`, the same
 * frame every mark layer uses, read again at each layout), so zoom, a turned page and the spread layout are the
 * viewer's problem and not arithmetic here. The layer never touches the document.
 */

import type { FieldCandidate } from 'pdf-core/ops/form-detect';
import type { MessageKey, Translator } from 'pdf-shared';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { pageFramesAt } from './mark-interaction';

export interface FieldCandidateLayerProps {
  readonly t: Translator;
  readonly viewer: ViewerApi;
  /**
   * The shell's layout revision: it moves each time the pages are laid out again. The frames are placed while the layer renders,
   * and the viewer answers where a page is through one long-lived object, so nothing else in
   * the props says it has to be placed again.
   */
  readonly layout: number;
  /** The candidates still in the review. */
  readonly candidates: readonly FieldCandidate[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onRemove: (id: string) => void;
}

const KIND_KEYS: Record<FieldCandidate['kind'], MessageKey> = {
  text: 'form.kind.text',
  checkbox: 'form.kind.checkbox',
  radio: 'form.kind.radio',
  signature: 'form.kind.signature',
};

export function FieldCandidateLayer({
  t,
  viewer,
  layout,
  candidates,
  selectedId,
  onSelect,
  onRemove,
}: FieldCandidateLayerProps) {
  const frames = pageFramesAt(viewer, layout);
  return (
    <div className="pointer-events-none absolute inset-0 z-20" data-field-candidates="">
      {candidates.map((candidate) => {
        const frame = frames.of(candidate.pageIndex);
        if (frame === null) return null;
        const box = frame.toScreenBox(candidate.rect);
        if (box.width <= 0 || box.height <= 0) return null;
        const selected = candidate.id === selectedId;
        const label = t('formDetect.candidate', {
          name: candidate.name,
          kind: t(KIND_KEYS[candidate.kind]),
          page: candidate.pageIndex + 1,
        });
        return (
          <div
            key={candidate.id}
            className="absolute"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          >
            {/* The frame and its ✕ are siblings: a button cannot hold a button. */}
            <button
              type="button"
              aria-label={label}
              aria-pressed={selected}
              title={label}
              data-field-candidate={candidate.id}
              data-kind={candidate.kind}
              data-confidence={candidate.confidence}
              data-name={candidate.name}
              onClick={() => onSelect(candidate.id)}
              onFocus={() => onSelect(candidate.id)}
              onKeyDown={(event) => {
                if (event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault();
                  onRemove(candidate.id);
                }
              }}
              className={`pointer-events-auto absolute inset-0 border-2 outline-none ${
                candidate.confidence === 'high'
                  ? 'border-pdf-accent bg-pdf-accent/10'
                  : 'border-dashed border-kumo-warning bg-kumo-warning/10'
              } ${candidate.kind === 'radio' ? 'rounded-full' : 'rounded-[2px]'} ${
                selected ? 'ring-2 ring-pdf-accent' : 'focus-visible:ring-2 focus-visible:ring-pdf-accent'
              }`}
            />
            <button
              type="button"
              aria-label={t('formDetect.remove', { name: candidate.name })}
              data-field-candidate-remove={candidate.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onRemove(candidate.id)}
              className="pointer-events-auto absolute -top-2.5 -right-2.5 flex size-4 items-center justify-center rounded-full bg-kumo-danger text-[10px] leading-none text-white shadow-sm hover:brightness-110"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
