import { useEffect } from 'react';
import { declaredLanguage } from './language';
import { setDocumentLanguage } from './reading-store';

/** The part of the viewer's API the language is read from: the engine document's metadata. */
export interface LanguageSource {
  readonly document: {
    readonly raw: { getMetadata(): Promise<{ readonly info: unknown }> };
  };
}

/**
 * Keep `documentLanguage` in step with the document on screen. The viewer API is replaced
 * with every document, so the language is cleared when it changes and read again; a read that
 * lands after the viewer moved on is dropped, and a document whose metadata cannot be read
 * simply declares no language.
 */
export function useDocumentLanguage(viewer: LanguageSource | null): void {
  useEffect(() => {
    setDocumentLanguage(null);
    if (viewer === null) return undefined;
    let current = true;
    void viewer.document.raw.getMetadata().then(
      ({ info }) => {
        if (current) setDocumentLanguage(declaredLanguage(info));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [viewer]);
}
