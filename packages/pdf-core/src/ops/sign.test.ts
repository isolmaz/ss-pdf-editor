/**
 * Signing and verifying against real bytes and real cryptography: a certificate made
 * with WebCrypto (`signature-trust.fixtures.ts`), the writer's fixed-width placeholders,
 * and the product's own verifier reading the result. The wrong answers that matter: a
 * signature that does not verify, a tampered byte that still verifies, a placeholder that
 * moved when it was filled, and an encrypted file whose placeholders would be encrypted.
 */

import { describe, expect, it } from 'vitest';
import { generateKey, issueCertificate } from '../signature-trust.fixtures';
import { signPdf } from './sign';
import { verifySignatures } from './signature-status';

const run = { signal: new AbortController().signal };

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

async function blank(options = ''): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 300, 400], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer(options).asUint8Array());
  doc.destroy();
  return bytes;
}

describe('signPdf', () => {
  it('writes a visible signature that the product’s verifier reads as intact', async () => {
    const out = await signPdf(
      await blank(),
      {
        identity: await identity(),
        field: { name: 'Onay', rect: { x: 20, y: 20, width: 160, height: 50 }, pageIndex: 0 },
        reason: 'Onaylandı',
        signerName: 'İmza Deneme',
        date: new Date(Date.UTC(2026, 5, 1, 12)),
      },
      run,
    );
    expect(out.report.steps).toEqual(['load', 'field.create', 'producer', 'save', 'cms', 'verify']);
    const verdicts = await verifySignatures(out.bytes, run.signal, { now: new Date(Date.UTC(2026, 5, 2)) });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      fieldName: 'Onay',
      integrity: 'valid',
      subFilter: 'ETSI.CAdES.detached',
    });
    expect(verdicts[0]?.signer).toBe('İmza Deneme');

    // One byte inside the signed range changed: the verdict has to change with it.
    const tampered = out.bytes.slice();
    tampered[20] = (tampered[20] ?? 0) ^ 0x01;
    const broken = await verifySignatures(tampered, run.signal);
    expect(broken[0]?.integrity).toBe('invalid');
  });

  it('answers an unsigned file without a verdict and refuses to sign an encrypted one', async () => {
    expect(await verifySignatures(await blank(), run.signal)).toEqual([]);
    await expect(
      signPdf(await blank('encrypt=aes-256,owner-password=x'), { identity: await identity() }, run),
    ).rejects.toMatchObject({ code: 'encrypted-unsupported' });
  });
});
