/**
 * `revocation-lists.ts`: reading CRL files into imported revocation lists.
 *
 * Real CRLs (generated with the pdf-core signature fixtures) go in as binary DER and as PEM,
 * and the result is checked against what the CRL says. These tests protect that a `.pem` with
 * several blocks yields several lists, that a file carrying no CRL is refused (counted, never
 * stored as an empty entry), and that nothing happens without a receiver.
 */

import { Utf8String } from 'asn1js';
import type { Translator } from 'pdf-shared';
import { AttributeTypeAndValue, RelativeDistinguishedNames } from 'pkijs';
import { describe, expect, it } from 'vitest';
import { issueCrl } from '../../../pdf-core/src/signature-revocation.fixtures';
import { generateKey, issueCertificate } from '../../../pdf-core/src/signature-trust.fixtures';
import { importRevocationLists } from './revocation-lists';

const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`) as unknown as Translator;

const thisUpdate = new Date(Date.UTC(2026, 4, 1));
const nextUpdate = new Date(Date.UTC(2026, 6, 1));

async function crlFor(subject: string): Promise<Uint8Array> {
  const ca = await issueCertificate({
    subject,
    keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
    notBefore: new Date(Date.UTC(2026, 0, 1)),
    notAfter: new Date(Date.UTC(2027, 0, 1)),
    basicConstraints: { cA: true },
    keyUsage: ['keyCertSign', 'cRLSign'],
  });
  return await issueCrl({ issuer: ca, thisUpdate, nextUpdate });
}

const pem = (der: Uint8Array): string =>
  `-----BEGIN X509 CRL-----\n${Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')}\n-----END X509 CRL-----\n`;

async function run(files: File[]) {
  const imported: import('pdf-model').RevocationList[][] = [];
  const messages: (string | null)[] = [];
  await importRevocationLists(
    files,
    t,
    (lists) => imported.push([...lists]),
    (message) => messages.push(message),
  );
  return { imported, messages };
}

describe('importRevocationLists', () => {
  it('imports a binary DER CRL with the facts the CRL states, labelled by its issuer', async () => {
    const der = await crlFor('Binary CA');
    const { imported, messages } = await run([new File([der as BlobPart], 'list.crl')]);
    expect(messages).toEqual([null]);
    expect(imported).toHaveLength(1);
    const [list] = imported[0] ?? [];
    expect(list).toMatchObject({
      label: 'Binary CA',
      thisUpdate: thisUpdate.toISOString(),
      nextUpdate: nextUpdate.toISOString(),
      revokedCount: 0,
      delta: false,
      derBase64: Buffer.from(der).toString('base64'),
    });
  });

  it('labels a CRL whose issuer has no common name by its file name', async () => {
    const ca = await issueCertificate({
      subject: 'Nameless CA',
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      notBefore: new Date(Date.UTC(2026, 0, 1)),
      notAfter: new Date(Date.UTC(2027, 0, 1)),
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign', 'cRLSign'],
    });
    const der = await issueCrl({
      issuer: ca,
      thisUpdate,
      nextUpdate,
      issuerName: new RelativeDistinguishedNames({
        typesAndValues: [
          new AttributeTypeAndValue({ type: '2.5.4.10', value: new Utf8String({ value: 'Org only' }) }),
        ],
      }),
    });
    const { imported, messages } = await run([new File([der as BlobPart], 'org-only.crl')]);
    expect(messages).toEqual([null]);
    expect(imported[0]?.map((list) => list.label)).toEqual(['org-only.crl']);
  });

  it('imports every block of a PEM file', async () => {
    const first = await crlFor('First CA');
    const second = await crlFor('Second CA');
    const text = `leading text\n${pem(first)}\n${pem(second)}`;
    const { imported, messages } = await run([new File([text], 'bundle.pem')]);
    expect(messages).toEqual([null]);
    expect((imported[0] ?? []).map((list) => list.label)).toEqual(['First CA', 'Second CA']);
  });

  it('refuses a file that carries no CRL and reports how many were refused beside the imported ones', async () => {
    const only = await run([new File(['not a crl at all'], 'notes.txt')]);
    expect(only.imported).toEqual([]);
    expect(only.messages).toEqual(['props.sig.crls.none']);

    const der = await crlFor('Mixed CA');
    const mixed = await run([
      new File([der as BlobPart], 'good.crl'),
      new File([pem(new Uint8Array([1, 2, 3]))], 'bad.pem'),
    ]);
    expect(mixed.imported[0]?.map((list) => list.label)).toEqual(['Mixed CA']);
    expect(mixed.messages).toEqual(['props.sig.crls.addedRefused {"count":1,"refused":1}']);
  });

  it('does nothing, not even an error message, without a receiver', async () => {
    const messages: (string | null)[] = [];
    await importRevocationLists([new File(['x'], 'a.crl')], t, undefined, (message) =>
      messages.push(message),
    );
    expect(messages).toEqual([]);
  });
});
