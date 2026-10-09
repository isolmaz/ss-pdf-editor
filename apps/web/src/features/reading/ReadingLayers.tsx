import type { Translator } from 'pdf-shared';
import { Magnifier, ReadingPane, SnapshotMenu } from 'pdf-ui/tools';
import type { ViewerApi } from 'pdf-ui/viewer';
import type { RefObject } from 'react';
import { showNotice } from '../core/core-store';
import { closeReading, closeSnapshot, setLensZoom, useReading } from './reading-store';

export interface ReadingLayersProps {
  readonly t: Translator;
  /** The interface language: the voice the reading pane asks for when the document declares none. */
  readonly locale: string;
  /** The viewer API of the document on screen (state: the layers that need it render when it arrives). */
  readonly viewer: ViewerApi | null;
  /** The same API as the shell's ref, which the reading pane takes. */
  readonly viewerRef: RefObject<ViewerApi | null>;
  /** The page being read, 0-based. */
  readonly pageNumber: number;
}

/**
 * The reader's overlays — reading pane, snapshot menu, magnifier lens — wired to the reading
 * store. They read what is open from it and write their own close and zoom back, so the shell
 * re-renders for none of it: opening the pane re-renders these three and nothing else.
 */
export function ReadingLayers({ t, locale, viewer, viewerRef, pageNumber }: ReadingLayersProps) {
  const reading = useReading((state) => state.reading);
  const snapshotOpen = useReading((state) => state.snapshotOpen);
  const magnifierOn = useReading((state) => state.magnifierOn);
  const lensZoom = useReading((state) => state.lensZoom);
  const documentLanguage = useReading((state) => state.documentLanguage);
  return (
    <>
      <ReadingPane
        t={t}
        lang={documentLanguage ?? locale}
        open={reading}
        onClose={closeReading}
        viewer={viewerRef.current}
        pageNumber={pageNumber}
        onPageChange={(page) => viewerRef.current?.goToPage(page)}
        onNotice={showNotice}
      />
      <SnapshotMenu t={t} viewer={viewer} open={snapshotOpen} onClose={closeSnapshot} onNotice={showNotice} />
      <Magnifier t={t} viewer={viewer} active={magnifierOn} zoom={lensZoom} onZoomChange={setLensZoom} />
    </>
  );
}
