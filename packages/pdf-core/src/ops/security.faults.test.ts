/**
 * The verification step of encrypt/decrypt exists for an engine that writes the wrong file.
 * The real engine does not, so these tests wrap it at its loading seam: the produced bytes
 * are real, but the document handle that re-reads them answers wrongly in one chosen way.
 * Each case proves that the wrong answer is refused (`verification-failed`, with the reason
 * named) instead of the file being handed back.
 */

import type { PDFDocument } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build, TWO_LINES } from './redact.fixtures';

type Method = (document: PDFDocument, ...args: unknown[]) => unknown;
type Fault = Partial<Record<string, Method>>;

/** Faults per `openDocument` call, in order; `undefined` leaves that open untouched. */
const state: { plan: (Fault | undefined)[]; opened: number } = { plan: [], opened: 0 };

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      const real = await import('mupdf');
      const wrapDocument = (document: PDFDocument, fault: Fault): PDFDocument => {
        const proxy: PDFDocument = new Proxy(document, {
          get(target, property) {
            if (property === 'asPDF') return () => proxy;
            const override = fault[String(property)];
            if (override !== undefined) return (...args: unknown[]) => override(target, ...args);
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return proxy;
      };
      const documents = new Proxy(real.PDFDocument, {
        get(target, property) {
          if (property === 'openDocument') {
            return (...args: Parameters<typeof real.PDFDocument.openDocument>) => {
              const opened = real.PDFDocument.openDocument(...args);
              const fault = state.plan[state.opened];
              state.opened += 1;
              return fault === undefined ? opened : wrapDocument(opened as PDFDocument, fault);
            };
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

const { protectDocument, unlockDocument, inspectProtection, ALL_PERMISSIONS } = await import('./security');
const { loadMupdf } = await import('../engines/mupdf');

const run = { signal: new AbortController().signal };
const OPTIONS = { userPassword: 'gizli', ownerPassword: 'sahip', permissions: ALL_PERMISSIONS };

afterEach(() => {
  state.plan = [];
  state.opened = 0;
});

const encryptionKey = async (): Promise<string> => (await loadMupdf()).Document.META_ENCRYPTION;

/** A text layer that reads differently from the one the input had. */
const differentText: Method = (document, ...args) => {
  const page = document.loadPage(...(args as [number]));
  return new Proxy(page, {
    get(target, property) {
      if (property === 'toStructuredText') {
        return () => ({
          walk: (walker: { onChar: (character: string) => void }) => walker.onChar('Z'),
          destroy: () => undefined,
        });
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

/** A locked copy of a two-line page: opens 0 = input, then the verification reads. */
async function locked(): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(await build([TWO_LINES]), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  const bytes = new Uint8Array(
    doc.saveToBuffer('encrypt=aes-256,user-password=gizli,owner-password=sahip').asUint8Array(),
  );
  doc.destroy();
  // Building the fixture opened a document too: the plan counts from the operation's own opens.
  state.opened = 0;
  return bytes;
}

const failure = (engineMessage: string | RegExp) => ({
  code: 'verification-failed',
  details: {
    engine: 'mupdf',
    engineMessage: typeof engineMessage === 'string' ? engineMessage : expect.stringMatching(engineMessage),
  },
});

describe('protectDocument verification', () => {
  it('refuses an output the engine reports with another cipher', async () => {
    const key = await encryptionKey();
    state.plan = [
      undefined,
      {
        getMetaData: (document, ...args) =>
          (args as [string])[0] === key
            ? 'Standard V2 R3 128-bit RC4'
            : document.getMetaData(...(args as [string])),
      },
    ];
    await expect(protectDocument(await build([TWO_LINES]), OPTIONS, run)).rejects.toMatchObject(
      failure('expected aes-256 output, engine reports "rc4-128"'),
    );
  });

  it('refuses an output that opens without the user password it was encrypted with', async () => {
    state.plan = [undefined, { needsPassword: () => false }];
    await expect(protectDocument(await build([TWO_LINES]), OPTIONS, run)).rejects.toMatchObject(
      failure('output opens without the user password it was encrypted with'),
    );
  });

  it('refuses owner-only protection that demands a password', async () => {
    state.plan = [undefined, { needsPassword: () => true }];
    await expect(
      protectDocument(await build([TWO_LINES]), { ...OPTIONS, userPassword: '' }, run),
    ).rejects.toMatchObject(failure('owner-only encryption produced a document that demands a password'));
  });

  it('refuses an output the user password does not fully open', async () => {
    state.plan = [undefined, { authenticatePassword: () => 1 }];
    await expect(protectDocument(await build([TWO_LINES]), OPTIONS, run)).rejects.toMatchObject(
      failure('authenticatePassword(user) returned 1, expected 2'),
    );
  });

  it('refuses an output an empty password opens', async () => {
    state.plan = [
      undefined,
      {
        authenticatePassword: (document, ...args) =>
          (args as [string])[0] === '' ? 1 : document.authenticatePassword(...(args as [string])),
      },
    ];
    await expect(protectDocument(await build([TWO_LINES]), OPTIONS, run)).rejects.toMatchObject(
      failure('an empty password authenticates the output'),
    );
  });

  it('refuses an output whose stored permissions are not the ones requested', async () => {
    state.plan = [undefined, { hasPermission: () => true }];
    await expect(
      protectDocument(
        await build([TWO_LINES]),
        { ...OPTIONS, permissions: { ...ALL_PERMISSIONS, print: false } },
        run,
      ),
    ).rejects.toMatchObject(failure('permission "print" is true, requested false (permissions=3896)'));
  });

  it('refuses an output with another page count than the input', async () => {
    state.plan = [undefined, undefined, { countPages: () => 5 }];
    await expect(protectDocument(await build([TWO_LINES]), OPTIONS, run)).rejects.toMatchObject(
      failure('protected output carries a different page count'),
    );
  });

  it('refuses an output whose text sample differs from the input', async () => {
    state.plan = [undefined, undefined, { loadPage: differentText }];
    await expect(protectDocument(await build([TWO_LINES]), OPTIONS, run)).rejects.toMatchObject(
      failure('page sample 0 text differs after re-protection'),
    );
  });

  it('maps an engine failure while writing and while verifying', async () => {
    state.plan = [
      {
        saveToBuffer: () => {
          throw new Error('out of memory');
        },
      },
    ];
    await expect(protectDocument(await build([TWO_LINES]), OPTIONS, run)).rejects.toMatchObject({
      code: 'out-of-memory',
      details: { engineMessage: 'protect: out of memory' },
    });

    state.opened = 0;
    state.plan = [
      undefined,
      {
        getMetaData: () => {
          throw new Error('broken xref');
        },
      },
    ];
    await expect(protectDocument(await build([TWO_LINES]), OPTIONS, run)).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { engineMessage: 'verify-protection: broken xref' },
    });
  });
});

describe('unlockDocument verification', () => {
  it('refuses an output that still needs a password', async () => {
    const source = await locked();
    state.plan = [undefined, { needsPassword: () => true }];
    await expect(unlockDocument(source, 'gizli', run)).rejects.toMatchObject(
      failure('unlocked output still needs a password'),
    );
  });

  it('refuses an output that still reports encryption', async () => {
    const source = await locked();
    const key = await encryptionKey();
    state.plan = [
      undefined,
      {
        getMetaData: (document, ...args) =>
          (args as [string])[0] === key
            ? 'Standard V5 R6 256-bit AES'
            : document.getMetaData(...(args as [string])),
      },
    ];
    await expect(unlockDocument(source, 'gizli', run)).rejects.toMatchObject(
      failure('unlocked output still reports encryption "aes-256"'),
    );
  });

  it('refuses an output with another page count than the input', async () => {
    const source = await locked();
    state.plan = [undefined, { countPages: () => 7 }];
    await expect(unlockDocument(source, 'gizli', run)).rejects.toMatchObject(
      failure('page count changed: 1 -> 7'),
    );
  });

  it('refuses an output whose text sample differs from the input', async () => {
    const source = await locked();
    state.plan = [undefined, { loadPage: differentText }];
    await expect(unlockDocument(source, 'gizli', run)).rejects.toMatchObject(
      failure('page sample 0 text differs after decryption'),
    );
  });

  it('maps an engine failure while verifying', async () => {
    const source = await locked();
    state.plan = [
      undefined,
      {
        getMetaData: () => {
          throw new Error('broken xref');
        },
      },
    ];
    await expect(unlockDocument(source, 'gizli', run)).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { engineMessage: 'verify-unlock: broken xref' },
    });
  });
});

describe('inspectProtection', () => {
  it('maps an engine failure while reading the protection state', async () => {
    state.plan = [
      {
        hasPermission: () => {
          throw new Error('broken xref');
        },
      },
    ];
    await expect(inspectProtection(await build([TWO_LINES]))).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { engineMessage: 'inspect-protection: broken xref' },
    });
  });
});
