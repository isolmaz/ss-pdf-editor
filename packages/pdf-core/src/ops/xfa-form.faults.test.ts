/**
 * Removing the XFA re-opens what it wrote and refuses a file that still carries XFA or whose
 * fields changed; importing data refuses a file whose datasets do not hold what was imported. The real engine writes what it is told to, so these tests wrap it at its loading
 * seam (the same seam `structure.faults.test.ts` uses): the document being written is damaged in
 * one chosen way just before it is saved, and everything else — the bytes that come out, the
 * second reader — is real.
 */

import type { PDFDocument } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  /** Runs on the document being written, just before it is saved. */
  tamper?: (document: PDFDocument) => void;
}
const state: Plan = {};

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      const real = await import('mupdf');
      const wrapDocument = (document: PDFDocument): PDFDocument => {
        const proxy: PDFDocument = new Proxy(document, {
          get(target, property) {
            if (property === 'asPDF') return () => proxy;
            if (property === 'setMetaData') {
              return (...args: Parameters<PDFDocument['setMetaData']>) => {
                state.tamper?.(target);
                return target.setMetaData(...args);
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return proxy;
      };
      const documents = new Proxy(real.PDFDocument, {
        get(target, property) {
          if (property === 'openDocument') {
            return (...args: Parameters<typeof real.PDFDocument.openDocument>) =>
              wrapDocument(real.PDFDocument.openDocument(...args) as PDFDocument);
          }
          return Reflect.get(target, property, target);
        },
      });
      return new Proxy(real, {
        get(target, property) {
          return property === 'PDFDocument' ? documents : Reflect.get(target, property, target);
        },
      });
    },
  };
});

const { readFormFields } = await import('./forms');
const { importXfaData, removeXfa } = await import('./xfa-form');
const { xfaPdf } = await import('./xfa-form.fixtures');

afterEach(() => {
  state.tamper = undefined;
});

const run = { signal: new AbortController().signal };

describe('removing the XFA, read back', () => {
  it('returns the file, and says it was verified, when the engine wrote what was asked', async () => {
    const input = await xfaPdf({ kind: 'static' });
    const out = await removeXfa(input, run);
    expect(out.report.steps).toEqual(['load', 'xfa.remove', 'verify', 'save']);
    expect((await readFormFields(out.bytes, run.signal)).map((field) => field.name.split('.').pop())).toEqual(
      ['Name[0]', 'Agree[0]', 'Birth[0]'],
    );
  });

  it('refuses a file in which the XFA is still present after the write', async () => {
    const input = await xfaPdf({ kind: 'static' });
    state.tamper = (doc) => {
      const form = doc.getTrailer().get('Root').get('AcroForm').resolve();
      form.put('XFA', doc.newArray());
    };
    await expect(removeXfa(input, run)).rejects.toMatchObject({
      code: 'verification-failed',
      details: { engine: 'mupdf', engineMessage: 'XFA still present' },
    });
  });

  it('refuses a file in which a field value changed while the XFA was removed', async () => {
    const input = await xfaPdf({ kind: 'static' });
    state.tamper = (doc) => {
      const widget = doc.findPage(0).get('Annots').resolve().get(0).resolve();
      widget.put('V', doc.newString('tampered'));
    };
    await expect(removeXfa(input, run)).rejects.toMatchObject({
      code: 'verification-failed',
      details: { engine: 'mupdf', engineMessage: 'the form fields changed while the XFA was removed' },
    });
  });

  it('refuses a file that lost a field while the XFA was removed', async () => {
    const input = await xfaPdf({ kind: 'static' });
    state.tamper = (doc) => {
      const inner = doc.getTrailer().get('Root').get('AcroForm').resolve().get('Fields').get(0).resolve();
      inner.put('Kids', doc.newArray());
    };
    await expect(removeXfa(input, run)).rejects.toMatchObject({
      code: 'verification-failed',
      details: { engineMessage: 'the form fields changed while the XFA was removed' },
    });
  });
});

describe('importing data, read back', () => {
  it('refuses a file whose datasets hold other data than the data that was imported', async () => {
    const input = await xfaPdf({ kind: 'dynamic' });
    state.tamper = (doc) => {
      const xfa = doc.getTrailer().get('Root').get('AcroForm').resolve().get('XFA').resolve();
      // [preamble, template, datasets, postamble]: the datasets stream is the entry after its name.
      xfa
        .get(5)
        .writeStream(
          '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name>Other</Name></form1></xfa:data></xfa:datasets>',
        );
    };
    await expect(
      importXfaData(input, '<form1><Name>Zed</Name><City>Ankara</City></form1>', run),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      details: { engine: 'mupdf', engineMessage: 'the datasets hold 1 values, 2 were imported' },
    });
  });
});
