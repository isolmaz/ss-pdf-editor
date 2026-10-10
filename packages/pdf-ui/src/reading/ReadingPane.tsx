/**
 * Reading mode: the current page as one readable column.
 *
 * This is a **viewer overlay**, not a second viewer: it renders no PDF, it re-reads
 * the text the engine already extracted (`useReadingText`), so opening and closing it
 * never touches the pdf.js viewer's page, zoom or scroll position. Page navigation goes
 * out through `onPageChange`, which is what keeps the overlay and the viewer in step.
 *
 * Accessibility: the pane is a named region that takes focus when it opens (so the
 * keyboard rule below applies at once), every action is a real button with a dictionary
 * label, and the speech controls exist only when a local voice does — no dead buttons.
 */

import { CaretLeft, CaretRight, Pause, Play, SpeakerHigh, Stop, X } from '@phosphor-icons/react';
import type { Translator } from 'pdf-shared';
import { useEffect, useMemo, useRef } from 'react';
import { Button } from '../components/Button';
import type { ReadingBlock } from './text';
import { MAX_SPEECH_RATE, MIN_SPEECH_RATE, useReadAloud } from './useReadAloud';
import { type ReadingViewer, useReadingText } from './useReadingText';
import './reading.css';

export interface ReadingPaneProps {
  /**
   * The viewer's imperative API. Navigation comes from `ViewerApi`; the text comes from
   * the pdf-core document handle the same object carries (see `ReadingViewer`).
   */
  readonly viewer: ReadingViewer | null;
  readonly open: boolean;
  readonly onClose: () => void;
  /** The interface language's translator: the pane's words follow the shell's locale. */
  readonly t: Translator;
  /**
   * The language read-aloud looks a local voice for: the document's own when it declares
   * one, else the interface's. A primary subtag ("de") matches every regional voice.
   */
  readonly lang: string;
  /** Current page, 0-based — the same number the shell tracks. */
  readonly pageNumber: number;
  readonly onPageChange: (page: number) => void;
  /** The shell's notice channel, for failures that belong in the status bar too. */
  readonly onNotice?: (message: string) => void;
}

/**
 * The language's name in the interface language ("German", "Almanca"), for the sentence that
 * says which voice is missing. A tag the platform cannot name is shown as it is.
 */
function languageName(lang: string, locale: string): string {
  try {
    // `fallback` defaults to "code", so a well-formed tag the platform cannot name comes back as itself.
    return new Intl.DisplayNames([locale], { type: 'language' }).of(lang) as string;
  } catch {
    return lang;
  }
}

/** Widths of the loading skeleton's lines: fixed, so the pane never jumps while it fills. */
const SKELETON_LINES = ['92%', '78%', '96%', '64%', '88%', '72%'];

/**
 * Which way a key pages through the document. Arrows are included on purpose: this is a
 * *paged* reader (one page per screen of text), so the column is scrolled with the wheel
 * and the paging keys stay unambiguous. Modifier combinations (browser tab switching)
 * are left alone, and so are form controls, whose own arrow behaviour must survive.
 */
function pagingStep(event: KeyboardEvent): number | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (target.isContentEditable || target.closest('input, textarea, select') !== null) return null;
  }
  switch (event.key) {
    case 'PageDown':
    case 'ArrowDown':
    case 'ArrowRight':
      return 1;
    case 'PageUp':
    case 'ArrowUp':
    case 'ArrowLeft':
      return -1;
    default:
      return null;
  }
}

export function ReadingPane({
  viewer,
  open,
  onClose,
  t,
  lang,
  pageNumber,
  onPageChange,
  onNotice,
}: ReadingPaneProps) {
  if (!open) return null;

  return (
    <section className="pdf-reading-pane" aria-label={t('reading.toggle')}>
      <ReadingBody
        viewer={viewer}
        pageNumber={pageNumber}
        onPageChange={onPageChange}
        onClose={onClose}
        t={t}
        lang={lang}
        {...(onNotice === undefined ? {} : { onNotice })}
      />
    </section>
  );
}

interface ReadingBodyProps {
  readonly viewer: ReadingViewer | null;
  readonly pageNumber: number;
  readonly onPageChange: (page: number) => void;
  readonly onClose: () => void;
  readonly t: Translator;
  readonly lang: string;
  readonly onNotice?: (message: string) => void;
}

/**
 * The mounted half: everything that costs something (the engine read, the speech queue)
 * lives here, so closing the pane unmounts it and both stop.
 */
function ReadingBody({ viewer, pageNumber, onPageChange, onClose, t, lang, onNotice }: ReadingBodyProps) {
  const region = useRef<HTMLDivElement | null>(null);
  const controller = useMemo(() => new AbortController(), []);
  useEffect(() => () => controller.abort(), [controller]);

  const { blocks, loading, error } = useReadingText(viewer, pageNumber, controller.signal);
  const text = useMemo(() => blocks.map((block) => block.text).join(' '), [blocks]);
  const speech = useReadAloud(text, { lang });

  useEffect(() => {
    // The pane is where the user is looking, the notice is where the shell reports: a
    // page that cannot be read has to appear in both, or it looks like an empty page.
    if (error !== null) onNotice?.(t(error));
  }, [error, onNotice, t]);

  useEffect(() => {
    region.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      const step = pagingStep(event);
      if (step === null) return;
      event.preventDefault();
      // The upper end is the engine's own clamp (`ViewerApi.goToPage` bounds against the
      // page count); the first page is the only one this pane can bound itself, because
      // its props carry no page count.
      onPageChange(step < 0 ? Math.max(0, pageNumber - 1) : pageNumber + 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, onPageChange, pageNumber]);

  const previousPage = Math.max(1, pageNumber);
  const nextPage = pageNumber + 2;
  const speakingNow = speech.speaking && !speech.paused;

  return (
    <div className="pdf-reading-body" ref={region} tabIndex={-1}>
      <header className="pdf-reading-bar">
        <div className="pdf-reading-nav">
          <Button
            shape="square"
            variant="ghost"
            // Earlier pages lie to the reading start: the caret turns over in a right-to-left UI.
            icon={<CaretLeft className="rtl:-scale-x-100" />}
            disabled={pageNumber === 0}
            aria-label={t('panel.goToPage', { page: previousPage })}
            title={t('panel.goToPage', { page: previousPage })}
            onClick={() => onPageChange(Math.max(0, pageNumber - 1))}
          />
          <span className="pdf-reading-page">{t('reading.page', { page: pageNumber + 1 })}</span>
          <Button
            shape="square"
            variant="ghost"
            icon={<CaretRight className="rtl:-scale-x-100" />}
            aria-label={t('panel.goToPage', { page: nextPage })}
            title={t('panel.goToPage', { page: nextPage })}
            onClick={() => onPageChange(pageNumber + 1)}
          />
        </div>

        <div className="pdf-reading-speech">
          <span className="pdf-reading-label">
            <SpeakerHigh size={14} aria-hidden="true" />
            {t('reading.voice')}
          </span>
          {speech.available ? null : (
            <span className="pdf-reading-hint">
              {t('reading.noLocalVoice', { language: languageName(lang, t.locale) })}
            </span>
          )}
          <Button
            shape="square"
            variant="ghost"
            icon={speakingNow ? Pause : Play}
            disabled={!speech.available}
            aria-label={speakingNow ? t('reading.pause') : t('reading.play')}
            title={speakingNow ? t('reading.pause') : t('reading.play')}
            onClick={() => {
              if (speech.paused) speech.resume();
              else if (speech.speaking) speech.pause();
              else speech.play();
            }}
          />
          <Button
            shape="square"
            variant="ghost"
            icon={Stop}
            disabled={!speech.available || (!speech.speaking && !speech.paused)}
            aria-label={t('reading.stop')}
            title={t('reading.stop')}
            onClick={speech.stop}
          />
          <label className="pdf-reading-rate">
            <span className="pdf-reading-label">{t('reading.rate')}</span>
            <input
              type="range"
              min={MIN_SPEECH_RATE}
              max={MAX_SPEECH_RATE}
              step={0.25}
              value={speech.rate}
              disabled={!speech.available}
              aria-label={t('reading.rate')}
              onChange={(event) => speech.setRate(Number(event.target.value))}
            />
            <span className="pdf-reading-value">{speech.rate.toFixed(2)}×</span>
          </label>
        </div>

        <Button
          shape="square"
          variant="ghost"
          icon={X}
          aria-label={t('reading.toggle')}
          title={t('reading.toggle')}
          onClick={onClose}
        />
      </header>

      <div className="pdf-reading-scroll" aria-busy={loading}>
        {error !== null ? (
          <p className="pdf-reading-status">{t(error)}</p>
        ) : loading ? (
          <div className="pdf-reading-skeleton" aria-hidden="true">
            {SKELETON_LINES.map((width) => (
              <span key={width} className="pdf-reading-skeleton-line" style={{ width }} />
            ))}
          </div>
        ) : blocks.length === 0 ? (
          <p className="pdf-reading-status">{t('reading.empty')}</p>
        ) : (
          <article className="pdf-reading-column">
            {blocks.map((block: ReadingBlock, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the column is rebuilt as a whole per page and these blocks are stateless, so the position is the identity.
              <Block key={index} block={block} />
            ))}
          </article>
        )}
      </div>
    </div>
  );
}

/** One block of the column: headings are the only kind that carries markup worth marking up. */
function Block({ block }: { readonly block: ReadingBlock }) {
  if (block.kind === 'heading') {
    return <h2 className="pdf-reading-block pdf-reading-block-heading">{block.text}</h2>;
  }
  return <p className={`pdf-reading-block pdf-reading-block-${block.kind}`}>{block.text}</p>;
}
