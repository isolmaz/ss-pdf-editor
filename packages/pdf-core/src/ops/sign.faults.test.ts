/**
 * The serialisation and verification guards of signing exist for a writer or a verifier that
 * answers wrongly. The real ones do not, so these tests wrap the two collaborators at their
 * module seams: the writer hands back the real bytes with one chosen placeholder damaged,
 * and the verifier (in the last case) finds no signature. Each case proves that the wrong
 * answer is refused with the exact reason instead of a file being handed back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKey, issueCertificate } from '../signature-trust.fixtures';

const state: {
  damage: ((bytes: Uint8Array) => Uint8Array) | undefined;
  verdicts: 'real' | 'none';
} = { damage: undefined, verdicts: 'real' };

vi.mock('../engines/mupdf-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf-write')>();
  return {
    ...actual,
    saveRewrite: (...args: Parameters<typeof actual.saveRewrite>) => {
      const bytes = actual.saveRewrite(...args);
      return state.damage === undefined ? bytes : state.damage(bytes);
    },
  };
});

vi.mock('./signature-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./signature-status')>();
  return {
    ...actual,
    verifySignatures: (...args: Parameters<typeof actual.verifySignatures>) =>
      state.verdicts === 'none' ? Promise.resolve([]) : actual.verifySignatures(...args),
  };
});

const { signPdf } = await import('./sign');

const run = { signal: new AbortController().signal };

afterEach(() => {
  state.damage = undefined;
  state.verdicts = 'real';
});

async function identity() {
  const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
  const certificate = await issueCertificate({
    subject: 'İmza Deneme',
    keyPair,
    notBefore: new Date(Date.UTC(2026, 0, 1)),
    notAfter: new Date(Date.UTC(2027, 0, 1)),
    keyUsage: ['digitalSignature'],
  });
  return { certificate: certificate.der, privateKey: keyPair.privateKey };
}

async function blank(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 300, 400], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Overwrite every occurrence of an ASCII run with a same-width run of `fill`. */
function overwrite(bytes: Uint8Array, pattern: RegExp, fill: string): Uint8Array {
  const text = Buffer.from(bytes).toString('latin1');
  const damaged = text.replace(pattern, (found) => fill.repeat(found.length));
  return new Uint8Array(Buffer.from(damaged, 'latin1'));
}

describe('signPdf guards against a damaged serialisation', () => {
  it('refuses a rewrite that lost the /Contents placeholder', async () => {
    state.damage = (bytes) => overwrite(bytes, /<0{1000,}>/, '1');
    await expect(signPdf(await blank(), { identity: await identity() }, run)).rejects.toMatchObject({
      code: 'internal',
      details: { engineMessage: 'the /Contents placeholder did not survive serialisation' },
    });
  });

  it('refuses a rewrite that lost the /ByteRange placeholder', async () => {
    state.damage = (bytes) => overwrite(bytes, /\[2000000000 2000000000 2000000000 2000000000\]/, ' ');
    await expect(signPdf(await blank(), { identity: await identity() }, run)).rejects.toMatchObject({
      code: 'internal',
      details: { engineMessage: 'the /ByteRange placeholder did not survive serialisation' },
    });
  });

  it('refuses a produced file in which the verifier finds no signature', async () => {
    state.verdicts = 'none';
    await expect(signPdf(await blank(), { identity: await identity() }, run)).rejects.toMatchObject({
      code: 'verification-failed',
      details: { engineMessage: 'the produced file carries no signature field to verify' },
    });
  });

  it('signs normally when nothing is damaged', async () => {
    const out = await signPdf(await blank(), { identity: await identity() }, run);
    expect(out.report.steps.at(-1)).toBe('verify');
  });
});
