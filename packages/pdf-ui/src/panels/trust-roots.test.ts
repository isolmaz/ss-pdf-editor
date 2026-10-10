/**
 * `trust-roots.ts`: reading certificate files into trust roots.
 *
 * Real certificates (the pdf-core `.p12` fixture) go in as DER and as PEM, and the roots are
 * checked against what the certificate says. These tests protect that a file with no
 * certificate is refused by count (never stored as an empty entry), that a certificate with no
 * common name is labelled by its file name, and that nothing happens without a receiver.
 */

import type { TrustRoot } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { pkcs12Fixture } from '../../../pdf-core/src/signature-pkcs12.fixtures';
import { importTrustRoots } from './trust-roots';

const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`) as unknown as Translator;

const pem = (der: Uint8Array): string =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64')}\n-----END CERTIFICATE-----\n`;

async function run(files: File[]) {
  const imported: TrustRoot[][] = [];
  const messages: (string | null)[] = [];
  await importTrustRoots(
    files,
    t,
    (roots) => imported.push([...roots]),
    (message) => messages.push(message),
  );
  return { imported, messages };
}

describe('importTrustRoots', () => {
  it('imports a DER certificate and a PEM certificate, labelled by their common names', async () => {
    const first = await pkcs12Fixture({ subject: 'First Root' });
    const second = await pkcs12Fixture({ subject: 'Second Root' });
    const { imported, messages } = await run([
      new File([first.certificate as BlobPart], 'first.cer'),
      new File([`leading text\n${pem(second.certificate)}`], 'second.pem'),
    ]);
    expect(messages).toEqual([null]);
    expect(imported).toHaveLength(1);
    expect((imported[0] ?? []).map((root) => root.label)).toEqual(['First Root', 'Second Root']);
    expect((imported[0] ?? []).map((root) => root.derBase64)).toEqual([
      Buffer.from(first.certificate).toString('base64'),
      Buffer.from(second.certificate).toString('base64'),
    ]);
  });

  it('labels a certificate that has no common name by its file name', async () => {
    const { certificate } = await pkcs12Fixture({ subject: null });
    const { imported, messages } = await run([new File([certificate as BlobPart], 'org-only.cer')]);
    expect(messages).toEqual([null]);
    expect(imported[0]?.map((root) => root.label)).toEqual(['org-only.cer']);
  });

  it('refuses files that carry no certificate and says so', async () => {
    const { imported, messages } = await run([
      new File(['not a certificate'], 'notes.txt'),
      new File(['-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n'], 'empty.pem'),
      new File([new Uint8Array([0x30, 0x03, 0x01, 0x02, 0x03])], 'garbage.der'),
    ]);
    expect(imported).toEqual([]);
    expect(messages).toEqual(['props.sig.roots.none']);
  });

  it('reports how many files were refused beside the roots that were imported', async () => {
    const { certificate } = await pkcs12Fixture({ subject: 'Good Root' });
    const { imported, messages } = await run([
      new File([certificate as BlobPart], 'good.cer'),
      new File(['not a certificate'], 'notes.txt'),
    ]);
    expect(imported[0]?.map((root) => root.label)).toEqual(['Good Root']);
    expect(messages).toEqual(['props.sig.roots.addedRefused {"count":1,"refused":1}']);
  });

  it('does nothing, not even an error message, without a receiver', async () => {
    const messages: (string | null)[] = [];
    await importTrustRoots([new File(['x'], 'a.cer')], t, undefined, (message) => messages.push(message));
    expect(messages).toEqual([]);
  });
});
