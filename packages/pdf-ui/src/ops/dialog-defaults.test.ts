import { createTranslator } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import type { OperationRunContext } from '../dialogs/types';
import { watermarkDialog } from './stamp';

const contextIn = (locale: 'en' | 'tr'): OperationRunContext => ({
  bytes: new Uint8Array(),
  pageCount: 1,
  name: 'a.pdf',
  currentPage: 0,
  selectedPages: [],
  t: createTranslator(locale),
});

describe('dialog defaults follow the interface language', () => {
  it('the watermark text starts as DRAFT in English and TASLAK in Turkish', () => {
    // It was the fixed Turkish "TASLAK" in every language.
    expect(watermarkDialog.initialValues?.(contextIn('en'))).toEqual({ text: 'DRAFT' });
    expect(watermarkDialog.initialValues?.(contextIn('tr'))).toEqual({ text: 'TASLAK' });
  });
});
