/**
 * The verdict of existing signatures, read from files whose every byte this suite laid down:
 * fixed-width `/ByteRange` and `/Contents` placeholders sealed after the file was written
 * (hex or literal), real cross-reference sections and incremental revisions, and CMS built
 * either by the product's signer or field by field by hand. The wrong answers that matter:
 * a hostile structure that reads as valid, a tampered byte that still verifies, a revision
 * count that is too low, and a throw where a verdict was owed.
 */

import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detachedCmsSignature } from '../signature-cms';
import {
  extKeyUsageExtension,
  issueCrl,
  issueTimestampToken,
  KP_TIME_STAMPING,
} from '../signature-revocation.fixtures';
import {
  type CertificateFixture,
  type CurveName,
  ecdsaRawToDer,
  fakeSpki,
  generateKey,
  type IssueOptions,
  issueCertificate,
} from '../signature-trust.fixtures';
import { countSignedFields, verifySignatures } from './signature-status';
import {
  algorithmIdentifier,
  appendRevision,
  attribute,
  BYTE_RANGE_PLACEHOLDER,
  type CertificateParts,
  type ContentsEncoding,
  certificateShape,
  commonNameOf,
  concat,
  contentInfo,
  contentsPlaceholder,
  contextual,
  type DocumentOptions,
  digest,
  documentObjects,
  fromLatin1,
  handSignedCms,
  integerBytes,
  latin1,
  name,
  nullValue,
  OID,
  octetString,
  oid,
  type PdfObjectSource,
  type Revision,
  type SealOptions,
  seal,
  sequence,
  set,
  signatureDictionary,
  signedAttributesBlock,
  signedData,
  signerInfo,
  smallInteger,
  spkiWith,
  subjectFromDer,
  swapAscii,
  textString,
  tlv,
} from './signature-status.fixtures';

const CAPACITY = 4096;
const NOW = new Date(Date.UTC(2026, 5, 2));

type Produce = (covered: Uint8Array) => Promise<Uint8Array> | Uint8Array;

async function identity(curve: CurveName = 'P-256', subject = 'Ayşe Signer'): Promise<CertificateFixture> {
  const keyPair = await generateKey({ kind: 'EC', curve });
  return await issueCertificate({
    subject,
    keyPair,
    notBefore: new Date(Date.UTC(2026, 0, 1)),
    notAfter: new Date(Date.UTC(2027, 0, 1)),
    keyUsage: ['digitalSignature'],
  });
}

/** The product's own detached CMS over whatever bytes the range covers. */
function cmsBy(
  signer: CertificateFixture,
  options: { readonly digest?: 'SHA-256' | 'SHA-384' | 'SHA-512' } = {},
): Produce {
  return async (covered) =>
    (
      await detachedCmsSignature(
        covered,
        { certificate: signer.der, privateKey: signer.keyPair.privateKey },
        { signedAt: new Date(Date.UTC(2026, 5, 1, 12)), ...options },
      )
    ).der;
}

interface SignedFile {
  readonly encoding?: ContentsEncoding;
  readonly dictionary?: string;
  readonly document?: DocumentOptions;
  readonly revision?: Partial<Revision>;
  readonly seal?: Partial<SealOptions>;
  readonly extraObjects?: readonly PdfObjectSource[];
}

/** A one-signature file, sealed over its whole first revision. */
async function signedPdf(produce: Produce, options: SignedFile = {}): Promise<Uint8Array> {
  const encoding = options.encoding ?? 'hex';
  const capacity = options.seal?.capacity ?? CAPACITY;
  const dictionary = options.dictionary ?? signatureDictionary({ capacity, encoding });
  const written = appendRevision(new Uint8Array(), {
    objects: [...documentObjects(dictionary, options.document), ...(options.extraObjects ?? [])],
    size: 6 + (options.extraObjects?.length ?? 0),
    ...options.revision,
  });
  return await seal(
    written.bytes,
    { capacity: CAPACITY, encoding, from: written.offsets.get(5) ?? 0, ...options.seal },
    produce,
  );
}

async function verdictsOf(bytes: Uint8Array, roots: readonly Uint8Array[] = []) {
  return await verifySignatures(bytes, undefined, { now: NOW, roots });
}

async function onlyVerdict(bytes: Uint8Array, roots: readonly Uint8Array[] = []) {
  const verdicts = await verdictsOf(bytes, roots);
  expect(verdicts).toHaveLength(1);
  const [verdict] = verdicts;
  if (verdict === undefined) throw new Error('no verdict');
  return verdict;
}

describe('verifySignatures on a signature sealed over a whole file', () => {
  it('reads a hex /Contents signature as intact and describes it fully', async () => {
    const signer = await identity();
    const verdict = await onlyVerdict(await signedPdf(cmsBy(signer)));
    expect(verdict).toMatchObject({
      fieldName: 'Sig1',
      subFilter: 'adbe.pkcs7.detached',
      signer: 'Ayşe Signer',
      signedAt: '2026-06-01T12:00:00Z',
      integrity: 'valid',
      trust: 'self-signed',
      coverage: 'covers-whole-document',
      changesAfterSigning: 0,
      reasonKey: 'props.sig.reason.valid',
    });
  });

  it('reads a literal-string /Contents signature, escapes and all, as intact', async () => {
    const signer = await identity();
    const bytes = await signedPdf(cmsBy(signer), { encoding: 'literal' });
    expect(latin1(bytes)).toContain('/Contents (');
    expect((await onlyVerdict(bytes)).integrity).toBe('valid');
  });

  it('reports a flipped byte inside the signed range as invalid', async () => {
    const signer = await identity();
    const bytes = await signedPdf(cmsBy(signer));
    const tampered = bytes.slice();
    tampered[bytes.length - 3] = (tampered[bytes.length - 3] ?? 0) ^ 0x01;
    expect(await onlyVerdict(tampered)).toMatchObject({
      integrity: 'invalid',
      reasonKey: 'props.sig.reason.invalid',
      coverage: 'covers-whole-document',
    });
  });
});

/** The first revision's cross-reference offset: the last `startxref` a file names. */
function startxrefOf(bytes: Uint8Array): number {
  const found = [...latin1(bytes).matchAll(/startxref\n(\d+)\n/g)].at(-1);
  if (found?.[1] === undefined) throw new Error('no startxref');
  return Number(found[1]);
}

interface Later {
  readonly body?: string;
  /** `'unsigned'` writes the link as `/Prev +N`: a number MuPDF follows and this verifier's scan does not read. */
  readonly prev?: number | 'unsigned';
  readonly trailerExtra?: string;
  readonly xref?: 'table' | 'stream';
  /** The text after `trailer`, from the previous section's offset; `null` writes none. */
  readonly trailer?: (previous: number) => string | null;
}

/** A signed file with incremental revisions appended after the signature's own. */
async function signedThenRevised(
  produce: Produce,
  later: readonly Later[],
  first: SignedFile = {},
): Promise<Uint8Array> {
  let bytes = await signedPdf(produce, first);
  let previous = startxrefOf(bytes);
  for (const [index, revision] of later.entries()) {
    const number = 100 + index * 2;
    const written = appendRevision(bytes, {
      objects: [{ number, body: revision.body ?? `<< /Note (revision ${index + 1}) >>` }],
      size: number + 2,
      ...(revision.prev === 'unsigned' ? {} : { prev: revision.prev ?? previous }),
      trailerExtra: `${revision.prev === 'unsigned' ? ` /Prev +${previous}` : ''}${revision.trailerExtra ?? ''}`,
      xref: revision.xref === 'stream' ? { stream: number + 1 } : 'table',
      ...(revision.trailer === undefined ? {} : { trailer: revision.trailer(previous) }),
    });
    bytes = written.bytes;
    previous = written.xrefAt;
  }
  return bytes;
}

describe('how a signature is paired with its bytes', () => {
  it('finds a /Contents written before its /ByteRange and passes over a later /Contents key that holds no string', async () => {
    const signer = await identity();
    const bytes = await signedPdf(cmsBy(signer), {
      dictionary: signatureDictionary({ capacity: CAPACITY, encoding: 'hex', order: 'contents-first' }),
      extraObjects: [{ number: 6, body: '<< /Contents 7 0 R >>' }],
    });
    expect(await onlyVerdict(bytes)).toMatchObject({ integrity: 'valid', coverage: 'covers-whole-document' });
  });

  it('does not pair a /Contents more than 64 KiB away from the /ByteRange', async () => {
    const signer = await identity();
    const near = signatureDictionary({ capacity: CAPACITY, encoding: 'hex' });
    const far = near.replace(' /Contents', ` /Filler (${'x'.repeat(70_000)}) /Contents`);
    const verdict = await onlyVerdict(await signedPdf(cmsBy(signer), { dictionary: far }));
    expect(verdict).toMatchObject({
      integrity: 'unchecked',
      reasonKey: 'props.sig.reason.unchecked.layout',
      coverage: 'unknown',
      changesAfterSigning: 0,
    });
  });

  it.each([
    ['three numbers', '[0 10 20]'],
    ['no array', '(0 10 20 30)'],
    ['a name among the numbers', '[0 10 /twenty 30]'],
    ['a sixteen-digit number', '[0 10 20 1234567890123456]'],
  ])('reads a /ByteRange with %s as no signed range', async (_title, range) => {
    const dictionary = `<< /Type /Sig /SubFilter /adbe.pkcs7.detached /ByteRange ${range} /Contents <00> >>`;
    const bytes = appendRevision(new Uint8Array(), { objects: documentObjects(dictionary), size: 6 }).bytes;
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'unchecked',
      reasonKey: 'props.sig.reason.unchecked.layout',
      coverage: 'unknown',
    });
  });

  it('does not take a /ByteRange whose gap does not hold the /Contents value', async () => {
    const dictionary = signatureDictionary({ capacity: 16, encoding: 'hex' });
    const bytes = appendRevision(new Uint8Array(), { objects: documentObjects(dictionary), size: 6 }).bytes;
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'unchecked',
      reasonKey: 'props.sig.reason.unchecked.layout',
      coverage: 'unknown',
    });
  });

  it.each([
    ['hex string without its closing bracket', '% /ByteRange [0 1 2 3] /Contents <abcd'],
    ['literal string without its closing parenthesis', '% /ByteRange [0 1 2 3] /Contents (abcd'],
    ['/Contents with a number for a value', '% /ByteRange [0 1 2 3] /Contents 12'],
  ])(
    'ignores a trailing %s and reports the real signature as covering only part of the file',
    async (_title, tail) => {
      const signer = await identity();
      const bytes = concat(await signedPdf(cmsBy(signer)), fromLatin1(`\n${tail}`));
      expect(await onlyVerdict(bytes)).toMatchObject({
        integrity: 'valid',
        coverage: 'covers-partial',
        changesAfterSigning: 0,
      });
    },
  );

  it.each([
    ['balanced', 'Ana (Test) \\ Co'],
    ['all', 'Ana (Test) \\ Co'],
  ] as const)(
    'reads a literal /Contents with %s parentheses and a backslash in it',
    async (parentheses, subject) => {
      const signer = await identity('P-256', subject);
      const bytes = await signedPdf(cmsBy(signer), { encoding: 'literal', seal: { parentheses } });
      expect(await onlyVerdict(bytes)).toMatchObject({ integrity: 'valid', signer: subject });
    },
  );

  it('answers a range that runs past the end of the file as unchecked, with coverage unknown', async () => {
    const signer = await identity();
    const bytes = await signedPdf(cmsBy(signer), { seal: { end: 100_000 } });
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'unchecked',
      reasonKey: 'props.sig.reason.unchecked.layout',
      coverage: 'unknown',
    });
  });
});

describe('a signed file larger than 16 MiB', () => {
  /** The four numbers the file itself spells out in the signature's /ByteRange. */
  const writtenRange = (bytes: Uint8Array): number[] => {
    const found = /\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\]/.exec(latin1(bytes.subarray(0, 4096)));
    if (found === null) throw new Error('no /ByteRange written');
    return found.slice(1).map(Number);
  };

  it('is verified against the exact signed bytes although the engine reads its /ByteRange as 32-bit floats', async () => {
    const signer = await identity();
    // 17 MiB of filler after the signature dictionary: the last range number is far past 2^24.
    // That size makes the number odd, so a 32-bit float cannot hold it (the engine rounds it).
    const filler = new Uint8Array(17 * 1024 * 1024);
    const bytes = await signedPdf(cmsBy(signer), {
      extraObjects: [
        { number: 6, body: `<< /Length ${filler.length} >>\nstream\n${latin1(filler)}\nendstream` },
      ],
    });
    const [, , , length2] = writtenRange(bytes);
    expect(bytes.length).toBeGreaterThan(2 ** 24);
    expect(Math.fround(length2 ?? 0)).not.toBe(length2);
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'valid',
      coverage: 'covers-whole-document',
      changesAfterSigning: 0,
    });
  }, 30_000);

  it('reads a byte flipped in the far part of such a file as invalid', async () => {
    const signer = await identity();
    const filler = new Uint8Array(17 * 1024 * 1024);
    const bytes = await signedPdf(cmsBy(signer), {
      extraObjects: [
        { number: 6, body: `<< /Length ${filler.length} >>\nstream\n${latin1(filler)}\nendstream` },
      ],
    });
    const tampered = bytes.slice();
    tampered[tampered.length - 1000] = 0x01;
    expect(await onlyVerdict(tampered)).toMatchObject({
      integrity: 'invalid',
      coverage: 'covers-whole-document',
    });
  }, 30_000);
});

describe('signatures whose /ByteRange the engine cannot tell apart', () => {
  // 17000000 and 17000001 are the same 32-bit float: the object graph reads both as 17000000.
  const dictionary = (last: number): string =>
    `<< /Type /Sig /SubFilter /adbe.pkcs7.detached /ByteRange [0 10 20000000 ${last}] /Contents <00> >>`;

  it('pairs neither of two signatures whose ranges round to the same float, and leaves both unchecked', async () => {
    const bytes = formFile({
      fields: '[10 0 R 11 0 R]',
      objects: [
        { number: 10, body: '<< /T (first) /FT /Sig /V 20 0 R >>' },
        { number: 11, body: '<< /T (second) /FT /Sig /V 21 0 R >>' },
        { number: 20, body: dictionary(17_000_000) },
        { number: 21, body: dictionary(17_000_001) },
      ],
    });
    expect(await verdictsOf(bytes)).toMatchObject([
      { fieldName: 'first', integrity: 'unchecked', reasonKey: REASON.layout, coverage: 'unknown' },
      { fieldName: 'second', integrity: 'unchecked', reasonKey: REASON.layout, coverage: 'unknown' },
    ]);
  });

  it('pairs a signature whose range is repeated exactly in another dictionary of the file', async () => {
    const bytes = formFile({
      fields: '[10 0 R]',
      objects: [
        { number: 10, body: '<< /T (first) /FT /Sig /V 20 0 R >>' },
        { number: 20, body: dictionary(17_000_000) },
        { number: 21, body: dictionary(17_000_000) },
      ],
    });
    expect(await verdictsOf(bytes)).toMatchObject([
      { fieldName: 'first', integrity: 'unchecked', reasonKey: REASON.der, coverage: 'unknown' },
    ]);
  });
});

describe('revisions after the signature', () => {
  it('counts the revisions appended after a signature and reports the range as covering part of the file', async () => {
    const signer = await identity();
    const bytes = await signedThenRevised(cmsBy(signer), [{}, {}]);
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'valid',
      coverage: 'covers-partial',
      changesAfterSigning: 2,
    });
  });

  it('counts a cross-reference stream revision and ignores %%EOF text inside an object while the chain is readable', async () => {
    const signer = await identity();
    const bytes = await signedThenRevised(cmsBy(signer), [
      { body: '<< /Note (%%EOF) >>', xref: 'stream' },
      {},
    ]);
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(2);
  });

  it('reads a trailer whose strings, hex strings and nested dictionaries hold the characters of dictionary syntax', async () => {
    const signer = await identity();
    const trailerExtra = ' /Info (a >> b) /ID [<aa3e> <cc3e>] /Deep << /Inner << /Prev (x) >> >>';
    const bytes = await signedThenRevised(cmsBy(signer), [{ body: '<< /Note (%%EOF) >>' }, { trailerExtra }]);
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(2);
  });

  it.each([
    ['no startxref at all', (bytes: Uint8Array) => swapAscii(bytes, 'startxref', 'startxreg')],
    [
      'a startxref that is not a number',
      (bytes: Uint8Array) =>
        fromLatin1(
          latin1(bytes).replace(
            /startxref\n(\d+)\n/g,
            (_all, digits: string) => `startxref\n${'x'.repeat(digits.length)}\n`,
          ),
        ),
    ],
    [
      'a startxref beyond the end of the file',
      (bytes: Uint8Array) =>
        fromLatin1(
          latin1(bytes).replace(
            /startxref\n(\d+)\n/g,
            (_all, digits: string) => `startxref\n${'9'.repeat(digits.length)}\n`,
          ),
        ),
    ],
  ])('counts the %%EOF markers after the signed range when the file has %s', async (_title, damage) => {
    const signer = await identity();
    // The %%EOF text in the first later revision is a marker the count cannot tell from a real one.
    const bytes = damage(await signedThenRevised(cmsBy(signer), [{ body: '<< /Note (%%EOF) >>' }, {}]));
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(3);
  });

  it.each([
    ['a newest /Prev that is not a plain number', [{}, { prev: 'unsigned' }] satisfies Later[]],
    ['a /Prev beyond the end of the file', [{}, { prev: 987_654_321 }] satisfies Later[]],
    [
      'an unreadable /Prev on the revision right after the signature',
      [{ prev: 'unsigned' }, {}, {}] satisfies Later[],
    ],
    [
      'an unreadable /Prev in the middle of a chain of three',
      [{}, { prev: 'unsigned' }, {}] satisfies Later[],
    ],
  ])(
    'never counts fewer revisions than the file holds when the chain is broken by %s',
    async (_title, later) => {
      const signer = await identity();
      const bytes = await signedThenRevised(cmsBy(signer), later);
      expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(later.length);
    },
  );
});

describe('the signature dictionary a field carries', () => {
  it.each([
    ['adbe.pkcs7.sha1', 'props.sig.reason.unchecked.subFilter'],
    ['adbe.x509.rsa_sha1', 'props.sig.reason.unchecked.subFilter'],
    ['x.unknown', 'props.sig.reason.unchecked.subFilter'],
  ])('leaves the %s sub-filter unchecked instead of guessing at its digest', async (subFilter, reasonKey) => {
    const signer = await identity();
    const bytes = await signedPdf(cmsBy(signer), {
      dictionary: signatureDictionary({ capacity: CAPACITY, encoding: 'hex', subFilter }),
    });
    expect(await onlyVerdict(bytes)).toMatchObject({
      subFilter,
      integrity: 'unchecked',
      reasonKey,
      coverage: 'covers-whole-document',
      revocation: 'indeterminate',
      validationTime: null,
      timestamp: null,
    });
  });

  it('reports a dictionary with no /SubFilter as an empty sub-filter, unchecked', async () => {
    const signer = await identity();
    const bytes = await signedPdf(cmsBy(signer), {
      dictionary: signatureDictionary({ capacity: CAPACITY, encoding: 'hex', subFilter: null }),
    });
    expect(await onlyVerdict(bytes)).toMatchObject({
      subFilter: '',
      integrity: 'unchecked',
      reasonKey: 'props.sig.reason.unchecked.subFilter',
    });
  });

  it('verifies ETSI.CAdES.detached, and a /SubFilter written as a text string', async () => {
    const signer = await identity();
    const cades = await signedPdf(cmsBy(signer), {
      dictionary: signatureDictionary({
        capacity: CAPACITY,
        encoding: 'hex',
        subFilter: 'ETSI.CAdES.detached',
      }),
    });
    expect(await onlyVerdict(cades)).toMatchObject({ subFilter: 'ETSI.CAdES.detached', integrity: 'valid' });
    const text = await signedPdf(cmsBy(signer), {
      dictionary: signatureDictionary({
        capacity: CAPACITY,
        encoding: 'hex',
        subFilterEntry: ' /SubFilter (adbe.pkcs7.detached)',
      }),
    });
    expect(await onlyVerdict(text)).toMatchObject({ subFilter: 'adbe.pkcs7.detached', integrity: 'valid' });
  });

  it('names the field by its /T, and by an empty name when it has none', async () => {
    const signer = await identity();
    expect(
      (await onlyVerdict(await signedPdf(cmsBy(signer), { document: { fieldName: 'Ünal Imza' } }))).fieldName,
    ).toBe('Ünal Imza');
    expect(
      (await onlyVerdict(await signedPdf(cmsBy(signer), { document: { fieldName: null } }))).fieldName,
    ).toBe('');
  });

  it.each([
    ['D:20260601120000Z', '2026-06-01T12:00:00Z'],
    ["D:20260601120000+02'00'", '2026-06-01T12:00:00+02:00'],
    ['D:20260601120000-0530', '2026-06-01T12:00:00-05:30'],
    ['D:20260601120000+02', '2026-06-01T12:00:00+02:00'],
    ['D:20260601120000+', '2026-06-01T12:00:00+00:00'],
    ['D:20260601120000', '2026-06-01T12:00:00Z'],
    ['D:202606', '2026-06-01T00:00:00Z'],
    ['D:2026', '2026-01-01T00:00:00Z'],
    ['yesterday afternoon', null],
    ['', null],
    [null, null],
  ])('reads /M %j as %j', async (date, expected) => {
    const signer = await identity();
    const bytes = await signedPdf(cmsBy(signer), {
      dictionary: signatureDictionary({ capacity: CAPACITY, encoding: 'hex', date }),
    });
    expect((await onlyVerdict(bytes)).signedAt).toBe(expected);
  });
});

const SIGNATURE = '<< /Type /Sig /SubFilter /adbe.pkcs7.detached /ByteRange [0 0 0 0] /Contents <00> >>';

interface FormLayout {
  /** The `/Fields` array text; `null` leaves the `/AcroForm` out. */
  readonly fields: string | null;
  /** One entry per page: that page's `/Annots` value text, or `null` for none. */
  readonly pageAnnots?: readonly (string | null)[];
  readonly objects?: readonly PdfObjectSource[];
}

/** A document whose structure, not its cryptography, is what matters: every signature is a stub. */
function formFile(layout: FormLayout): Uint8Array {
  const pages = layout.pageAnnots ?? [null];
  const pageNumbers = pages.map((_annots, index) => 3 + index);
  const objects: PdfObjectSource[] = [
    {
      number: 1,
      body: `<< /Type /Catalog /Pages 2 0 R${layout.fields === null ? '' : ` /AcroForm << /Fields ${layout.fields} >>`} >>`,
    },
    {
      number: 2,
      body: `<< /Type /Pages /Kids [${pageNumbers.map((number) => `${number} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    },
    ...pages.map((annots, index) => ({
      number: 3 + index,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200]${annots === null ? '' : ` /Annots ${annots}`} >>`,
    })),
    ...(layout.objects ?? []),
  ];
  const size = Math.max(...objects.map((object) => object.number)) + 1;
  return appendRevision(new Uint8Array(), { objects, size }).bytes;
}

const namesOf = async (bytes: Uint8Array): Promise<string[]> =>
  (await verdictsOf(bytes)).map((verdict) => verdict.fieldName);

describe('which signature fields a document has', () => {
  it('names a field by its qualified name through /Kids, and skips kids that are no dictionary or no signature', async () => {
    const bytes = formFile({
      fields: '[10 0 R]',
      objects: [
        { number: 10, body: '<< /T (form) /Kids [11 0 R 12 0 R 13 0 R null 99 0 R 15 0 R 16 0 R] >>' },
        { number: 11, body: '<< /T (a) /FT /Sig /V 20 0 R >>' },
        { number: 12, body: '<< /T (b) /Kids [14 0 R] >>' },
        { number: 13, body: '<< /FT /Sig /V 22 0 R >>' },
        { number: 14, body: '<< /T (c) /FT /Sig /V 21 0 R >>' },
        { number: 15, body: '<< /T (text) /V (hello) >>' },
        { number: 16, body: '<< /T (plain) /V << /Foo 1 >> >>' },
        { number: 20, body: SIGNATURE },
        { number: 21, body: SIGNATURE },
        { number: 22, body: SIGNATURE },
      ],
    });
    expect(await namesOf(bytes)).toEqual(['form.a', 'form.b.c', 'form']);
  });

  it('reports a signature dictionary shared by several widgets once', async () => {
    const bytes = formFile({
      fields: '[10 0 R 11 0 R]',
      pageAnnots: ['[10 0 R 11 0 R 12 0 R]'],
      objects: [
        { number: 10, body: '<< /Type /Annot /Subtype /Widget /T (first) /FT /Sig /V 20 0 R >>' },
        { number: 11, body: '<< /Type /Annot /Subtype /Widget /T (second) /FT /Sig /V 20 0 R >>' },
        { number: 12, body: '<< /Type /Annot /Subtype /Widget /T (third) /FT /Sig /V 20 0 R >>' },
        { number: 20, body: SIGNATURE },
      ],
    });
    expect(await namesOf(bytes)).toEqual(['first']);
  });

  it('finds a signature widget that sits in a page /Annots outside the /Fields tree, and passes over what is no signature', async () => {
    const bytes = formFile({
      fields: '[10 0 R]',
      pageAnnots: ['5', '[10 0 R 11 0 R 12 0 R 13 0 R null 7 99 0 R 14 0 R]'],
      objects: [
        { number: 10, body: '<< /Type /Annot /Subtype /Widget /T (listed) /FT /Sig /V 20 0 R >>' },
        { number: 11, body: '<< /Type /Annot /Subtype /Widget /T (loose) /FT /Sig /V 21 0 R >>' },
        { number: 12, body: '<< /Type /Annot /Subtype /Widget /V 22 0 R >>' },
        { number: 13, body: '<< /Type /Annot /Subtype /Link /Border [0 0 0] >>' },
        { number: 14, body: '<< /Type /Annot /Subtype /Widget /T (shared) /FT /Sig /V 20 0 R >>' },
        { number: 20, body: SIGNATURE },
        { number: 21, body: SIGNATURE },
        { number: 22, body: SIGNATURE },
      ],
    });
    expect(await namesOf(bytes)).toEqual(['listed', 'loose', '']);
  });

  it('reports a merged field and widget with an inline signature dictionary once', async () => {
    const bytes = formFile({
      fields: '[10 0 R]',
      pageAnnots: ['[10 0 R]'],
      objects: [
        {
          number: 10,
          body: `<< /Type /Annot /Subtype /Widget /T (merged) /FT /Sig /V ${SIGNATURE} >>`,
        },
      ],
    });
    expect(await namesOf(bytes)).toEqual(['merged']);
  });

  it('reads a signature field and its value written inline, with no object of their own', async () => {
    const bytes = formFile({ fields: `[<< /T (inline) /FT /Sig /V ${SIGNATURE} >>]` });
    expect(await namesOf(bytes)).toEqual(['inline']);
  });

  it('answers a document with a /ByteRange key but no signature field with an empty list', async () => {
    const bytes = formFile({
      fields: null,
      objects: [{ number: 10, body: '<< /ByteRange [0 0 0 0] >>' }],
    });
    expect(await verdictsOf(bytes)).toEqual([]);
  });

  it('follows /Kids to a depth of 32 and no further', async () => {
    const chain = (depth: number): PdfObjectSource[] =>
      Array.from({ length: depth + 1 }, (_unused, index) => ({
        number: 10 + index,
        body: index === depth ? '<< /FT /Sig /V 9 0 R >>' : `<< /T (n${index}) /Kids [${11 + index} 0 R] >>`,
      }));
    const at = async (depth: number): Promise<string[]> =>
      await namesOf(
        formFile({ fields: '[10 0 R]', objects: [{ number: 9, body: SIGNATURE }, ...chain(depth)] }),
      );
    expect(await at(32)).toHaveLength(1);
    expect(await at(33)).toEqual([]);
  });

  it('stops at 64 signature fields, in the /Fields tree and in the page annotations', async () => {
    const fields = Array.from({ length: 70 }, (_unused, index) => ({
      number: 10 + index,
      body: `<< /T (f${index}) /FT /Sig /V ${100 + index} 0 R >>`,
    }));
    const values = Array.from({ length: 70 }, (_unused, index) => ({ number: 100 + index, body: SIGNATURE }));
    const listed = fields.map((field) => `${field.number} 0 R`).join(' ');
    const names = await namesOf(formFile({ fields: `[${listed}]`, objects: [...fields, ...values] }));
    expect(names).toHaveLength(64);
    expect(names.at(-1)).toBe('f63');

    const wholeTree = fields.slice(0, 64).map((field) => `${field.number} 0 R`);
    const withWidget = formFile({
      fields: `[${wholeTree.join(' ')}]`,
      pageAnnots: ['[300 0 R]'],
      objects: [
        ...fields.slice(0, 64),
        ...values.slice(0, 64),
        { number: 300, body: '<< /Type /Annot /Subtype /Widget /T (late) /FT /Sig /V 301 0 R >>' },
        { number: 301, body: SIGNATURE },
      ],
    });
    expect(await namesOf(withWidget)).toHaveLength(64);
    expect(await namesOf(withWidget)).not.toContain('late');
  });

  it('stops at 64 signatures inside one /Kids array', async () => {
    const kids = Array.from({ length: 70 }, (_unused, index) => ({
      number: 200 + index,
      body: `<< /T (k${index}) /FT /Sig /V ${300 + index} 0 R >>`,
    }));
    const values = Array.from({ length: 70 }, (_unused, index) => ({ number: 300 + index, body: SIGNATURE }));
    const parent = {
      number: 10,
      body: `<< /T (p) /Kids [${kids.map((kid) => `${kid.number} 0 R`).join(' ')}] >>`,
    };
    const names = await namesOf(formFile({ fields: '[10 0 R]', objects: [parent, ...kids, ...values] }));
    expect(names).toHaveLength(64);
    expect(names.at(-1)).toBe('p.k63');
  });
});

const REASON = {
  der: 'props.sig.reason.unchecked.der',
  digest: 'props.sig.reason.unchecked.digest',
  webcrypto: 'props.sig.reason.unchecked.webCrypto',
  layout: 'props.sig.reason.unchecked.layout',
} as const;

interface CmsOverrides {
  readonly digestOids?: readonly string[] | null;
  readonly certificates?: readonly Uint8Array[] | null;
  readonly signerInfos?: readonly Uint8Array[] | null;
  readonly attributes?: Uint8Array | null;
  readonly signatureAlgorithm?: Uint8Array | null;
  readonly signature?: Uint8Array | null;
  readonly messageDigest?: Uint8Array | null;
}

/** A well-formed ECDSA-Sig-Value that is not the signature of anything. */
const JUNK_SIGNATURE = ecdsaRawToDer(new Uint8Array(64).fill(0x42));

/**
 * A detached CMS written field by field around the real digest of `covered`, so that exactly
 * one thing about it is wrong. The signature value is junk: every case here must be refused
 * before — or by — the signature check, and none may read as valid.
 */
async function cmsWith(
  covered: Uint8Array,
  signer: CertificateFixture,
  over: CmsOverrides = {},
): Promise<Uint8Array> {
  const messageDigest =
    over.messageDigest === undefined ? await digest('SHA-256', covered) : over.messageDigest;
  const attributes = over.attributes === undefined ? signedAttributesBlock(messageDigest) : over.attributes;
  const signerInfos =
    over.signerInfos === undefined
      ? [
          signerInfo({
            attributes,
            signatureAlgorithm:
              over.signatureAlgorithm === undefined
                ? algorithmIdentifier(OID.ecdsaSha256, 'none')
                : over.signatureAlgorithm,
            signature: over.signature === undefined ? JUNK_SIGNATURE : over.signature,
          }),
        ]
      : over.signerInfos;
  return contentInfo(
    signedData({
      digestOids: over.digestOids === undefined ? [OID.sha256] : over.digestOids,
      certificates: over.certificates === undefined ? [signer.der] : over.certificates,
      signerInfos,
    }),
  );
}

describe('a CMS that is not what it should be never reads as valid', () => {
  it.each<readonly [string, Uint8Array, Partial<SealOptions>]>([
    ['three bytes that run past their own length', Uint8Array.of(1, 2, 3), {}],
    ['a first element that is not a SEQUENCE', tlv(0x04, Uint8Array.of(1, 2)), {}],
    ['a high-tag-number first element', Uint8Array.of(0x1f, 0x81, 0x00), {}],
    ['an indefinite length', Uint8Array.of(0x30, 0x80, 0x00, 0x00), {}],
    ['a length of more than four length octets', Uint8Array.of(0x30, 0x85, 0, 0, 0, 0, 1), {}],
    ['a length that is longer than the whole /Contents', Uint8Array.of(0x30, 0x82, 0x7f, 0xff), {}],
    ['a length whose octets are cut off', Uint8Array.of(0x30, 0x82, 0x01), { capacity: 3 }],
    ['a tag with nothing after it', Uint8Array.of(0x30), { capacity: 1 }],
    ['an empty /Contents', new Uint8Array(), { capacity: 0 }],
    [
      'a ContentInfo whose second element is cut off',
      Uint8Array.of(0x30, 0x05, 0x06, 0x01, 0x2a, 0x04, 0x10),
      {},
    ],
  ])('answers %s as unchecked', async (_title, contents, options) => {
    const bytes = await signedPdf(() => contents, { seal: options });
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'unchecked',
      reasonKey: REASON.der,
      signer: null,
    });
  });

  it.each([
    [
      'a content type that is not signedData',
      (signedDataDer: Uint8Array) => contentInfo(signedDataDer, { type: OID.data }),
    ],
    [
      'a first element that is not an OID',
      (signedDataDer: Uint8Array) => sequence(smallInteger(1), tlv(0xa0, signedDataDer)),
    ],
    ['a ContentInfo with no content', () => sequence(oid(OID.signedData))],
    [
      'a content that is not tagged [0]',
      (signedDataDer: Uint8Array) => contentInfo(signedDataDer, { wrapperTag: 0xa1 }),
    ],
    ['an empty [0] content', () => sequence(oid(OID.signedData), tlv(0xa0))],
    ['a SignedData that is not a SEQUENCE', () => contentInfo(octetString(Uint8Array.of(1)))],
  ])('answers %s as unchecked', async (_title, wrap) => {
    const signer = await identity();
    const bytes = await signedPdf(async (covered) => {
      const inner = signedData({
        digestOids: [OID.sha256],
        certificates: [signer.der],
        signerInfos: [
          signerInfo({
            attributes: signedAttributesBlock(await digest('SHA-256', covered)),
            signatureAlgorithm: algorithmIdentifier(OID.ecdsaSha256, 'none'),
            signature: JUNK_SIGNATURE,
          }),
        ],
      });
      return wrap(inner);
    });
    expect(await onlyVerdict(bytes)).toMatchObject({ integrity: 'unchecked', reasonKey: REASON.der });
  });

  it.each([
    ['a digest algorithm this build does not know', { digestOids: [OID.md5] }, REASON.digest],
    ['an empty digestAlgorithms set', { digestOids: [] }, REASON.digest],
    ['neither a digestAlgorithms set nor signerInfos', { digestOids: null, signerInfos: null }, REASON.der],
    ['no SignerInfo', { signerInfos: [] }, REASON.der],
    ['a SignerInfo that is not a SEQUENCE', { signerInfos: [smallInteger(1)] }, REASON.der],
    [
      'a signerInfos set whose only element claims more bytes than the file holds',
      { signerInfos: [Uint8Array.of(0x30, 0x84, 0xff, 0xff, 0xff, 0xff)] },
      REASON.der,
    ],
    [
      'an attribute whose type is an empty OID',
      { attributes: contextual(0, sequence(tlv(0x06), set(octetString(Uint8Array.of(1))))) },
      REASON.der,
    ],
    [
      'a signature algorithm that is an empty OID',
      { signatureAlgorithm: sequence(tlv(0x06)) },
      REASON.webcrypto,
    ],
    ['a SignerInfo without signed attributes', { attributes: null }, REASON.der],
    [
      'signed attributes without a messageDigest',
      { attributes: contextual(0, attribute(OID.contentType, oid(OID.data))) },
      REASON.der,
    ],
    [
      'an attribute that is only a type',
      { attributes: contextual(0, sequence(oid(OID.messageDigest))) },
      REASON.der,
    ],
    [
      'an attribute whose type is not an OID',
      { attributes: contextual(0, sequence(smallInteger(1), set(octetString(Uint8Array.of(1))))) },
      REASON.der,
    ],
    [
      'a messageDigest that is not an OCTET STRING',
      { attributes: contextual(0, attribute(OID.messageDigest, smallInteger(1))) },
      REASON.der,
    ],
    ['no signature algorithm', { signatureAlgorithm: null }, REASON.webcrypto],
    [
      'a signature algorithm that does not start with an OID',
      { signatureAlgorithm: sequence(smallInteger(1)) },
      REASON.webcrypto,
    ],
    [
      'a signature algorithm this build cannot verify (Ed25519)',
      { signatureAlgorithm: algorithmIdentifier(OID.ed25519, 'none') },
      REASON.webcrypto,
    ],
    ['no signature value', { signature: null }, REASON.webcrypto],
    ['no certificates', { certificates: null }, REASON.webcrypto],
    ['an empty certificates block', { certificates: [] }, REASON.webcrypto],
    ['a certificate that is an empty SEQUENCE', { certificates: [sequence()] }, REASON.webcrypto],
  ] satisfies readonly (readonly [string, CmsOverrides, string])[])(
    'answers a well-formed CMS with %s as unchecked, never as valid',
    async (_title, over, reasonKey) => {
      const signer = await identity();
      const bytes = await signedPdf(async (covered) => await cmsWith(covered, signer, over));
      expect(await onlyVerdict(bytes)).toMatchObject({ integrity: 'unchecked', reasonKey });
    },
  );

  it('reads a messageDigest that is not the digest of the covered bytes as invalid', async () => {
    const signer = await identity();
    const bytes = await signedPdf(
      async (covered) => await cmsWith(covered, signer, { messageDigest: new Uint8Array(32).fill(7) }),
    );
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'invalid',
      reasonKey: 'props.sig.reason.invalid',
    });
  });

  it('keeps a CMS that carries a SignerInfo after an unusable one readable', async () => {
    const signer = await identity();
    const bytes = await signedPdf(async (covered) => {
      const good = signerInfo({
        attributes: signedAttributesBlock(await digest('SHA-256', covered)),
        signatureAlgorithm: algorithmIdentifier(OID.ecdsaSha256, 'none'),
        signature: JUNK_SIGNATURE,
      });
      return await cmsWith(covered, signer, { signerInfos: [smallInteger(1), good] });
    });
    // The junk signature passes the structure checks and fails the real one.
    expect((await onlyVerdict(bytes)).integrity).toBe('invalid');
  });
});

const bmp = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf16le').swap16());

describe('the signer name read from the certificate subject', () => {
  const TAG = { utf8: 0x0c, printable: 0x13, t61: 0x14, ia5: 0x16, bmp: 0x1e, numeric: 0x12 } as const;

  it.each([
    ['a UTF8String', [[OID.commonName, TAG.utf8, 'Çağrı Öztürk']], 'Çağrı Öztürk'],
    ['a BMPString', [[OID.commonName, TAG.bmp, bmp('Işık Ünal')]], 'Işık Ünal'],
    ['a PrintableString', [[OID.commonName, TAG.printable, 'Plain Name']], 'Plain Name'],
    ['an IA5String', [[OID.commonName, TAG.ia5, 'signer@example.org']], 'signer@example.org'],
    ['a TeletexString', [[OID.commonName, TAG.t61, 'Teletex Name']], 'Teletex Name'],
    ['a string type the reader does not decode', [[OID.commonName, TAG.numeric, '12345']], null],
    ['no common name at all', [[OID.organizationalUnit, TAG.utf8, 'Unit Only']], null],
    [
      'a common name after another name part',
      [
        [OID.organizationalUnit, TAG.utf8, 'Unit'],
        [OID.commonName, TAG.utf8, 'After The Unit'],
      ],
      'After The Unit',
    ],
  ] satisfies readonly (readonly [
    string,
    readonly (readonly [string, number, string | Uint8Array])[],
    string | null,
  ])[])('reads a common name written as %s', async (_title, entries, expected) => {
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const signer = await issueCertificate({
      subject: 'Issuer Ltd',
      subjectName: subjectFromDer(name(...entries)),
      keyPair,
    });
    const verdict = await onlyVerdict(await signedPdf(cmsBy(signer)));
    expect(verdict).toMatchObject({ integrity: 'valid', signer: expected });
  });
});

const FAKE_EC_SPKI = fakeSpki(OID.ecPublicKey, OID.p256, new Uint8Array(65).fill(4));

describe('a certificate that is only the shape of one', () => {
  const issuer = commonNameOf('Some Issuer');
  it.each([
    [
      'a version-1 TBSCertificate, with no [0] version',
      { versioned: false, issuer, subject: commonNameOf('V1 Subject'), spki: FAKE_EC_SPKI },
      'V1 Subject',
    ],
    [
      'a subject that holds a non-SET element first',
      {
        issuer,
        subject: sequence(smallInteger(1), set(sequence(oid(OID.commonName), textString(0x0c, 'Found')))),
        spki: FAKE_EC_SPKI,
      },
      'Found',
    ],
    [
      'a name part with odd attributes before the common name',
      {
        issuer,
        subject: sequence(
          set(
            sequence(oid(OID.commonName)),
            sequence(smallInteger(1), textString(0x0c, 'not a type')),
            sequence(oid(OID.organizationalUnit), textString(0x0c, 'Unit')),
            sequence(oid(OID.commonName), textString(0x0c, 'Found Late')),
          ),
        ),
        spki: FAKE_EC_SPKI,
      },
      'Found Late',
    ],
    ['no subjectPublicKeyInfo', { issuer, subject: commonNameOf('No Key'), spki: null }, 'No Key'],
    [
      'an empty subjectPublicKeyInfo',
      { issuer, subject: commonNameOf('Empty Key'), spki: sequence() },
      'Empty Key',
    ],
    [
      'a key algorithm with no children',
      { issuer, subject: commonNameOf('No Algorithm'), spki: spkiWith() },
      'No Algorithm',
    ],
    [
      'a key algorithm that does not start with an OID',
      { issuer, subject: commonNameOf('Odd Algorithm'), spki: spkiWith(smallInteger(1)) },
      'Odd Algorithm',
    ],
    [
      'an EC key whose parameters are not a curve OID',
      { issuer, subject: commonNameOf('Odd Curve'), spki: spkiWith(oid(OID.ecPublicKey), nullValue()) },
      'Odd Curve',
    ],
    [
      'an EC key on a curve this build has no name for',
      {
        issuer,
        subject: commonNameOf('P-192 Key'),
        spki: fakeSpki(OID.ecPublicKey, OID.p192, new Uint8Array(49).fill(4)),
      },
      'P-192 Key',
    ],
    [
      'an EC key whose point is not on the curve',
      { issuer, subject: commonNameOf('Junk Point'), spki: FAKE_EC_SPKI },
      'Junk Point',
    ],
  ] satisfies readonly (readonly [string, CertificateParts, string])[])(
    'answers a CMS signed by %s as unchecked and reads the name %j',
    async (_title, parts, signerName) => {
      const signer = await identity();
      const bytes = await signedPdf(
        async (covered) => await cmsWith(covered, signer, { certificates: [certificateShape(parts)] }),
      );
      expect(await onlyVerdict(bytes)).toMatchObject({
        integrity: 'unchecked',
        reasonKey: REASON.webcrypto,
        signer: signerName,
      });
    },
  );

  it.each([
    ['a TBSCertificate with no subject', { issuer, subject: null, spki: null }],
    ['a TBSCertificate with no issuer', { issuer: null, subject: null, spki: null }],
  ] satisfies readonly (readonly [string, CertificateParts])[])(
    'finds no certificate in %s',
    async (_title, parts) => {
      const signer = await identity();
      const bytes = await signedPdf(
        async (covered) => await cmsWith(covered, signer, { certificates: [certificateShape(parts)] }),
      );
      expect(await onlyVerdict(bytes)).toMatchObject({
        integrity: 'unchecked',
        reasonKey: REASON.webcrypto,
        signer: null,
        trust: 'not-checked',
      });
    },
  );

  it('does not treat a certificate that is a bare empty SEQUENCE as one', async () => {
    const signer = await identity();
    const bytes = await signedPdf(
      async (covered) => await cmsWith(covered, signer, { certificates: [sequence(tlv(0x30))] }),
    );
    expect(await onlyVerdict(bytes)).toMatchObject({ integrity: 'unchecked', signer: null });
  });

  it('keeps the signature valid when the CMS also carries an attribute-certificate entry and a copy of the signer certificate', async () => {
    const signer = await identity();
    const bytes = await signedPdf(
      async (covered) =>
        await handSignedCms({ signer, covered, chain: [tlv(0xa1, Uint8Array.of(1)), signer.der] }),
    );
    expect((await onlyVerdict(bytes)).integrity).toBe('valid');
  });
});

describe('the signature value itself', () => {
  it.each<readonly [string, 'SHA-256' | 'SHA-384' | 'SHA-512', CurveName]>([
    ['P-256 with SHA-256', 'SHA-256', 'P-256'],
    ['P-384 with SHA-384', 'SHA-384', 'P-384'],
    ['P-521 with SHA-512', 'SHA-512', 'P-521'],
  ])(
    'verifies an ECDSA signature on %s and refuses it once a byte of the signature changes',
    async (_title, digestName, curve) => {
      const signer = await identity(curve);
      const verdict = await onlyVerdict(await signedPdf(cmsBy(signer, { digest: digestName })));
      expect(verdict).toMatchObject({ integrity: 'valid', signer: 'Ayşe Signer' });

      const forged = await signedPdf(async (covered) => {
        const der = await cmsBy(signer, { digest: digestName })(covered);
        der[der.length - 1] = (der[der.length - 1] ?? 0) ^ 0x01;
        return der;
      });
      expect(await onlyVerdict(forged)).toMatchObject({
        integrity: 'invalid',
        reasonKey: 'props.sig.reason.invalid',
      });
    },
  );

  it('verifies an RSA signature, and refuses it once a byte of the signature changes', async () => {
    const keyPair = await generateKey({ kind: 'RSA' });
    const signer = await issueCertificate({
      subject: 'RSA Signer',
      keyPair,
      notBefore: new Date(Date.UTC(2026, 0, 1)),
      notAfter: new Date(Date.UTC(2027, 0, 1)),
    });
    expect(await onlyVerdict(await signedPdf(cmsBy(signer)))).toMatchObject({
      integrity: 'valid',
      signer: 'RSA Signer',
    });
    const forged = await signedPdf(async (covered) => {
      const der = await cmsBy(signer)(covered);
      der[der.length - 1] = (der[der.length - 1] ?? 0) ^ 0x01;
      return der;
    });
    expect((await onlyVerdict(forged)).integrity).toBe('invalid');
  });

  it('hashes with SHA-1 when the CMS says the digest is SHA-1', async () => {
    const signer = await identity();
    const bytes = await signedPdf(async (covered) => await handSignedCms({ signer, covered, hash: 'SHA-1' }));
    expect((await onlyVerdict(bytes)).integrity).toBe('valid');
  });

  it.each([
    ['r is short (a leading zero octet)', (raw: Uint8Array) => raw[0] === 0],
    ['s is short (a leading zero octet)', (raw: Uint8Array) => raw[32] === 0],
    [
      'both r and s have their top bit set, so DER pads each with a zero',
      (raw: Uint8Array) => ((raw[0] ?? 0) & 0x80) !== 0 && ((raw[32] ?? 0) & 0x80) !== 0,
    ],
  ])('verifies an ECDSA signature in which %s', async (_title, acceptRaw) => {
    const signer = await identity();
    const bytes = await signedPdf(async (covered) => await handSignedCms({ signer, covered, acceptRaw }));
    expect((await onlyVerdict(bytes)).integrity).toBe('valid');
  });

  it('verifies the product-signed P-521 signature whose r or s starts with two zero octets', async () => {
    // r and s < 2^521 sit in 66 octets each, so a half's first octet is 0 or 1 and about one
    // half in a thousand also has a zero second octet: the integer is then 64 octets, not 65.
    // The product signer used to write it with a redundant 0x00 — not DER — and this verifier
    // rightly read the file as invalid. WebCrypto cannot be told which signature to pick, so
    // the signing is repeated until one half has that shape: about 1 in 512 signatures, so
    // 20 000 attempts miss with odds near e^-39, and the cap fails the test with its own
    // message well inside the timeout even on a slow machine.
    const signer = await identity('P-521');
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    const twoZeros = (raw: Uint8Array, at: number) =>
      raw[at] === 0 && raw[at + 1] === 0 && (raw[at + 2] ?? 0) < 0x80;
    let attempts = 0;
    const spy = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (algorithm, key, data) => {
      for (;;) {
        attempts += 1;
        if (attempts > 20_000) throw new Error('no P-521 signature of the wanted shape in 20000 attempts');
        const signature = await sign(algorithm, key, data);
        const raw = new Uint8Array(signature);
        if (twoZeros(raw, 0) || twoZeros(raw, 66)) return signature;
      }
    });
    let bytes: Uint8Array;
    try {
      bytes = await signedPdf(cmsBy(signer, { digest: 'SHA-512' }));
    } finally {
      spy.mockRestore();
    }
    expect(await onlyVerdict(bytes)).toMatchObject({ integrity: 'valid', signer: 'Ayşe Signer' });
  }, 60_000);

  const R = new Uint8Array(32).fill(0x11);
  it.each([
    ['not a SEQUENCE', () => Uint8Array.of(1, 2, 3)],
    [
      'a SEQUENCE followed by a stray byte',
      () => concat(sequence(integerBytes(R), integerBytes(R)), Uint8Array.of(0)),
    ],
    ['a SEQUENCE of one integer', () => sequence(integerBytes(R))],
    ['a SEQUENCE of three integers', () => sequence(integerBytes(R), integerBytes(R), integerBytes(R))],
    ['an OCTET STRING where r belongs', () => sequence(octetString(R), integerBytes(R))],
    ['an empty integer', () => sequence(integerBytes(new Uint8Array()), integerBytes(R))],
    ['a negative integer', () => sequence(integerBytes(Uint8Array.of(0x80, 0x11)), integerBytes(R))],
    ['a redundant leading zero', () => sequence(integerBytes(concat(Uint8Array.of(0), R)), integerBytes(R))],
    [
      'an integer wider than the curve',
      () => sequence(integerBytes(new Uint8Array(33).fill(1)), integerBytes(R)),
    ],
    ['an all-zero integer', () => sequence(integerBytes(Uint8Array.of(0)), integerBytes(R))],
  ])('reads an ECDSA signature value that is %s as invalid', async (_title, value) => {
    const signer = await identity();
    const bytes = await signedPdf(
      async (covered) => await handSignedCms({ signer, covered, signatureValue: value }),
    );
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'invalid',
      reasonKey: 'props.sig.reason.invalid',
    });
  });

  it('reads a CMS whose messageDigest was recomputed for edited bytes, over the old signature, as invalid', async () => {
    const signer = await identity();
    const original = fromLatin1('the bytes that were signed');
    const bytes = await signedPdf(async (covered) => {
      const honest = await handSignedCms({ signer, covered: original });
      const wanted = await digest('SHA-256', covered);
      const before = await digest('SHA-256', original);
      if (!latin1(honest).includes(latin1(before))) throw new Error('the digest is not in the CMS');
      return fromLatin1(latin1(honest).replace(latin1(before), latin1(wanted)));
    });
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'invalid',
      reasonKey: 'props.sig.reason.invalid',
    });
  });

  it('leaves a signature unchecked when the SignerInfo names an algorithm the certificate key cannot have', async () => {
    const signer = await identity();
    const rsaOnEc = await signedPdf(
      async (covered) => await handSignedCms({ signer, covered, signatureOid: OID.rsaEncryption }),
    );
    expect(await onlyVerdict(rsaOnEc)).toMatchObject({ integrity: 'unchecked', reasonKey: REASON.webcrypto });

    const rsaSigner = await issueCertificate({
      subject: 'RSA Signer',
      keyPair: await generateKey({ kind: 'RSA' }),
    });
    const ecOnRsa = await signedPdf(
      async (covered) => await handSignedCms({ signer: rsaSigner, covered, signatureOid: OID.ecdsaSha256 }),
    );
    expect(await onlyVerdict(ecOnRsa)).toMatchObject({ integrity: 'unchecked', reasonKey: REASON.webcrypto });
  });

  it('leaves a signature unchecked when the RSA public key in the certificate cannot be imported', async () => {
    const signer = await identity();
    const spki = fakeSpki(OID.rsaEncryption, null, new Uint8Array(40).fill(1));
    const bytes = await signedPdf(
      async (covered) =>
        await cmsWith(covered, signer, {
          certificates: [certificateShape({ issuer: commonNameOf('I'), subject: commonNameOf('S'), spki })],
          signatureAlgorithm: algorithmIdentifier(OID.rsaEncryption),
        }),
    );
    expect(await onlyVerdict(bytes)).toMatchObject({ integrity: 'unchecked', reasonKey: REASON.webcrypto });
  });
});

describe('a runtime whose WebCrypto is missing or cannot hash', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('leaves an otherwise intact signature unchecked when the runtime has no WebCrypto at all', async () => {
    const signer = await identity();
    const bytes = await signedPdf(cmsBy(signer));
    vi.stubGlobal('crypto', undefined);
    expect(await onlyVerdict(bytes)).toMatchObject({ integrity: 'unchecked', reasonKey: REASON.webcrypto });
  });

  it('leaves an otherwise intact signature unchecked when the runtime has WebCrypto without a subtle', async () => {
    const signer = await identity();
    const bytes = await signedPdf(cmsBy(signer));
    vi.stubGlobal('crypto', {});
    expect(await onlyVerdict(bytes)).toMatchObject({ integrity: 'unchecked', reasonKey: REASON.webcrypto });
  });

  it('leaves a signature unchecked, not invalid, when the runtime fails to compute the digest', async () => {
    const signer = await identity();
    const bytes = await signedPdf(cmsBy(signer));
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValue(new Error('no such hash here'));
    expect(await onlyVerdict(bytes)).toMatchObject({ integrity: 'unchecked', reasonKey: REASON.digest });
  });
});

const day = (month: number, date: number): Date => new Date(Date.UTC(2026, month - 1, date));

interface Pki {
  readonly root: CertificateFixture;
  readonly intermediate: CertificateFixture;
  readonly other: CertificateFixture;
  readonly leaf: CertificateFixture;
  readonly unsupportedLeaf: CertificateFixture;
  readonly tsa: CertificateFixture;
  readonly tsaUnder: CertificateFixture;
  readonly tsaUnsupported: CertificateFixture;
  readonly tsaSelfSigned: CertificateFixture;
}

let pkiOnce: Promise<Pki> | undefined;

/** One small PKI for the trust cases: a root, an intermediate, leaves under them, and TSAs. */
function pki(): Promise<Pki> {
  pkiOnce ??= (async () => {
    const ca = (subject: string, keyPair: CryptoKeyPair, issuer?: CertificateFixture) =>
      issueCertificate(
        {
          subject,
          keyPair,
          notBefore: day(1, 1),
          notAfter: new Date(Date.UTC(2030, 0, 1)),
          basicConstraints: { cA: true },
          keyUsage: ['keyCertSign', 'cRLSign'],
        },
        issuer,
      );
    const ec = () => generateKey({ kind: 'EC', curve: 'P-256' });
    const root = await ca('Root CA', await ec());
    const intermediate = await ca('Intermediate CA', await ec(), root);
    const other = await ca('Other CA', await ec());
    const end = async (
      subject: string,
      issuer: CertificateFixture | undefined,
      extra: Partial<IssueOptions> = {},
    ) =>
      await issueCertificate(
        {
          subject,
          keyPair: await ec(),
          notBefore: day(1, 1),
          notAfter: day(12, 1),
          basicConstraints: { cA: false },
          keyUsage: ['digitalSignature'],
          ...extra,
        },
        issuer,
      );
    const stamping = { extraExtensions: [extKeyUsageExtension([KP_TIME_STAMPING])] };
    return {
      root,
      intermediate,
      other,
      leaf: await end('Leaf Signer', root),
      unsupportedLeaf: await end('Bad Leaf', root, { signature: { name: 'unsupported' } }),
      tsa: await end('Test TSA', root, stamping),
      tsaUnder: await end('Deep TSA', intermediate, stamping),
      tsaUnsupported: await end('Bad TSA', root, { ...stamping, signature: { name: 'unsupported' } }),
      tsaSelfSigned: await end('Self TSA', undefined, stamping),
    };
  })();
  return pkiOnce;
}

/** A detached signature by `signer`, with `chain` carried in the CMS. */
function cmsCarrying(signer: CertificateFixture, chain: readonly CertificateFixture[]): Produce {
  return async (covered) =>
    (
      await detachedCmsSignature(
        covered,
        {
          certificate: signer.der,
          chain: chain.map((entry) => entry.der),
          privateKey: signer.keyPair.privateKey,
        },
        { signedAt: day(6, 1) },
      )
    ).der;
}

describe('trust, revocation evidence and the time a signature is judged at', () => {
  it('leaves trust not-checked without imported roots and reports the certificate window and the signing time', async () => {
    const { leaf, root } = await pki();
    const verdict = await onlyVerdict(await signedPdf(cmsCarrying(leaf, [root])));
    expect(verdict).toMatchObject({
      integrity: 'valid',
      trust: 'not-checked',
      trustPath: ['Leaf Signer'],
      trustReason: 'no-roots',
      certificateValidity: 'valid',
      certificateNotAfter: '2026-12-01T00:00:00.000Z',
      revocation: 'indeterminate',
      validationTime: '2026-06-01T00:00:00.000Z',
      validationTimeSource: 'signing-time',
      timestamp: null,
    });
    expect(verdict.revocationChecks).toHaveLength(1);
    expect(verdict.revocationChecks[0]).toMatchObject({
      role: 'signer',
      subject: 'Leaf Signer',
      status: 'unknown',
    });
  });

  it('trusts a chain that reaches an imported root, whether or not the CMS carries the root', async () => {
    const { leaf, root } = await pki();
    const carried = await onlyVerdict(await signedPdf(cmsCarrying(leaf, [root])), [root.der]);
    expect(carried).toMatchObject({
      trust: 'trusted',
      trustPath: ['Leaf Signer', 'Root CA'],
      trustReason: null,
    });
    const alone = await onlyVerdict(await signedPdf(cmsCarrying(leaf, [])), [root.der]);
    expect(alone).toMatchObject({ trust: 'trusted', trustPath: ['Leaf Signer', 'Root CA'] });
  });

  it('keeps a tampered copy of the signer certificate out of the signer role and the chain path', async () => {
    const { leaf, root } = await pki();
    const copy = leaf.der.slice();
    copy[copy.length - 2] = (copy[copy.length - 2] ?? 0) ^ 0x01;
    const bytes = await signedPdf(
      async (covered) => await handSignedCms({ signer: leaf, covered, chain: [copy, root.der] }),
    );
    expect(await onlyVerdict(bytes, [root.der])).toMatchObject({
      integrity: 'valid',
      trust: 'trusted',
      trustPath: ['Leaf Signer', 'Root CA'],
    });
  });

  it('calls a chain that reaches no imported root untrusted', async () => {
    const { leaf, root, other } = await pki();
    expect(await onlyVerdict(await signedPdf(cmsCarrying(leaf, [root])), [other.der])).toMatchObject({
      integrity: 'valid',
      trust: 'untrusted',
      trustReason: 'no-issuer',
    });
  });

  it('names a certificate that signed itself self-signed, with or without roots', async () => {
    const { root, other } = await pki();
    const bytes = await signedPdf(cmsCarrying(root, []));
    expect(await onlyVerdict(bytes)).toMatchObject({ trust: 'self-signed', trustReason: 'no-roots' });
    expect(await onlyVerdict(bytes, [other.der])).toMatchObject({
      trust: 'self-signed',
      trustReason: 'no-issuer',
    });
  });

  it('reports a certificate whose issuer used an algorithm this build cannot verify as indeterminate, not untrusted', async () => {
    const { unsupportedLeaf, root } = await pki();
    const bytes = await signedPdf(cmsCarrying(unsupportedLeaf, [root]));
    expect(await onlyVerdict(bytes, [root.der])).toMatchObject({
      integrity: 'valid',
      trust: 'indeterminate',
      trustReason: 'unsupported-signature',
    });
  });

  it('reports a signature with no readable certificate as not-checked trust with an unknown window', async () => {
    const bytes = await signedPdf(() => Uint8Array.of(1, 2, 3));
    expect(await onlyVerdict(bytes)).toMatchObject({
      trust: 'not-checked',
      trustPath: [],
      certificateValidity: 'unknown',
      certificateNotAfter: null,
      trustReason: null,
      revocation: 'indeterminate',
      validationTime: '2026-06-01T12:00:00.000Z',
      validationTimeSource: 'signing-time',
    });
  });
});

/** An indirect stream object of raw bytes. */
/** A stream stored deflated, so a few kilobytes in the file read back as `data`. */
function deflatedObject(number: number, data: Uint8Array): PdfObjectSource {
  const packed = deflateSync(data);
  return {
    number,
    body: `<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n${latin1(packed)}\nendstream`,
  };
}

function streamObject(number: number, data: Uint8Array): PdfObjectSource {
  return { number, body: `<< /Length ${data.length} >>\nstream\n${latin1(data)}\nendstream` };
}

describe('the document security store and imported lists', () => {
  async function revokedLeaf() {
    const { leaf, root } = await pki();
    const crl = await issueCrl({
      issuer: root,
      thisUpdate: day(5, 20),
      nextUpdate: day(7, 1),
      revoked: [{ cert: leaf, at: day(5, 10) }],
    });
    return { leaf, root, crl };
  }

  it('revokes the signer by a CRL the user imported', async () => {
    const { leaf, root, crl } = await revokedLeaf();
    const bytes = await signedPdf(cmsCarrying(leaf, [root]));
    const [verdict] = await verifySignatures(bytes, undefined, { now: NOW, roots: [root.der], crls: [crl] });
    expect(verdict).toMatchObject({ trust: 'trusted', revocation: 'revoked' });
    expect(verdict?.revocationChecks[0]).toMatchObject({
      source: 'crl',
      origin: 'imported',
      status: 'revoked',
    });
  });

  it('revokes the signer by a CRL in the /DSS, and skips entries of the store that are not streams', async () => {
    const { leaf, root, crl } = await revokedLeaf();
    const bytes = await signedPdf(cmsCarrying(leaf, [root]), {
      document: { catalogExtra: ' /DSS 20 0 R' },
      extraObjects: [
        { number: 20, body: '<< /CRLs [null 5 (text) 21 0 R 22 0 R] /Certs 7 /OCSPs [] >>' },
        streamObject(21, crl),
        { number: 22, body: '<< /Foo 1 >>' },
      ],
    });
    const [verdict] = await verifySignatures(bytes, undefined, { now: NOW, roots: [root.der] });
    expect(verdict).toMatchObject({ trust: 'trusted', revocation: 'revoked' });
    expect(verdict?.revocationChecks[0]).toMatchObject({
      source: 'crl',
      origin: 'embedded',
      status: 'revoked',
    });
  });

  it('reads at most 16 MiB of /DSS streams: an entry past the budget, and every one after it, is dropped', async () => {
    const { tsaUnder, intermediate, root } = await pki();
    const filler = new Uint8Array(9 * 1024 * 1024);
    const stamp = async (certs: string) =>
      await signedPdf(
        async (covered) => await issueTimestampToken({ tsa: tsaUnder, covered, genTime: day(3, 1) }),
        {
          dictionary: timestampDictionary(),
          document: { catalogExtra: ' /DSS 6 0 R' },
          extraObjects: [
            { number: 6, body: `<< /Certs [${certs}] >>` },
            deflatedObject(7, filler),
            deflatedObject(8, filler),
            streamObject(9, intermediate.der),
          ],
        },
      );
    // One filler and the certificate fit in the budget: the chain is built.
    expect(await onlyVerdict(await stamp('7 0 R 9 0 R'), [root.der])).toMatchObject({ trust: 'trusted' });
    // Two fillers do not: the second one stops the read, so the certificate after it is never seen.
    expect(await onlyVerdict(await stamp('7 0 R 8 0 R 9 0 R'), [root.der])).toMatchObject({
      trust: 'untrusted',
    });
  });

  it('builds a document timestamp chain from the certificates the /DSS archived', async () => {
    const { tsaUnder, intermediate, root } = await pki();
    const stamp = async (extra: Partial<SignedFile>) =>
      await signedPdf(
        async (covered) => await issueTimestampToken({ tsa: tsaUnder, covered, genTime: day(3, 1) }),
        { dictionary: timestampDictionary(), ...extra },
      );
    expect(await onlyVerdict(await stamp({}), [root.der])).toMatchObject({
      integrity: 'valid',
      trust: 'untrusted',
    });
    const withStore = await stamp({
      document: { catalogExtra: ' /DSS 20 0 R' },
      extraObjects: [{ number: 20, body: '<< /Certs [21 0 R] >>' }, streamObject(21, intermediate.der)],
    });
    expect(await onlyVerdict(withStore, [root.der])).toMatchObject({
      integrity: 'valid',
      trust: 'trusted',
      trustPath: ['Deep TSA', 'Intermediate CA', 'Root CA'],
    });
  });
});

/** `/Contents 5` at the top, and the string the file scan pairs with `/ByteRange` inside a nested dictionary. */
function nestedContentsDictionary(subFilter: string): string {
  return `<< /Type /Sig /SubFilter /${subFilter} /Contents 5 /ByteRange ${BYTE_RANGE_PLACEHOLDER} /Prop << /Contents ${contentsPlaceholder(CAPACITY, 'hex')} >> >>`;
}

function timestampDictionary(options: { readonly capacity?: number } = {}): string {
  return signatureDictionary({
    capacity: options.capacity ?? CAPACITY,
    encoding: 'hex',
    subFilter: 'ETSI.RFC3161',
  });
}

describe('document timestamps (ETSI.RFC3161)', () => {
  const stamped = async (
    tsa: CertificateFixture,
    extra: readonly CertificateFixture[] = [],
    options: SignedFile = {},
  ): Promise<Uint8Array> =>
    await signedPdf(
      async (covered) =>
        await issueTimestampToken({ tsa, covered, genTime: day(3, 1), extraCertificates: extra }),
      { dictionary: timestampDictionary(), ...options },
    );

  it('reads a valid token as an untrusted timestamp until its root is imported', async () => {
    const { tsa, root } = await pki();
    const bytes = await stamped(tsa, [root]);
    const untrusted = await onlyVerdict(bytes);
    expect(untrusted).toMatchObject({
      subFilter: 'ETSI.RFC3161',
      signer: 'Test TSA',
      signedAt: '2026-03-01T00:00:00.000Z',
      integrity: 'valid',
      trust: 'not-checked',
      trustPath: ['Test TSA'],
      trustReason: 'no-roots',
      certificateValidity: 'valid',
      certificateNotAfter: '2026-12-01T00:00:00.000Z',
      coverage: 'covers-whole-document',
      changesAfterSigning: 0,
      reasonKey: 'props.sig.reason.timestamp.valid',
      validationTime: '2026-03-01T00:00:00.000Z',
      validationTimeSource: 'timestamp-untrusted',
    });
    expect(untrusted.timestamp).toMatchObject({ kind: 'document', status: 'valid', trusted: false });

    const trusted = await onlyVerdict(bytes, [root.der]);
    expect(trusted).toMatchObject({
      integrity: 'valid',
      trust: 'trusted',
      trustPath: ['Test TSA', 'Root CA'],
      trustReason: null,
      validationTimeSource: 'timestamp',
    });
    expect(trusted.timestamp?.trusted).toBe(true);
  });

  it('calls a token from a TSA that reaches no imported root untrusted', async () => {
    const { tsa, root, other } = await pki();
    expect(await onlyVerdict(await stamped(tsa, [root]), [other.der])).toMatchObject({
      integrity: 'valid',
      trust: 'untrusted',
      trustReason: 'no-issuer',
      validationTimeSource: 'timestamp-untrusted',
    });
  });

  it('names a self-signed TSA self-signed, and a TSA signed with an unsupported algorithm indeterminate', async () => {
    const { tsaSelfSigned, tsaUnsupported, root } = await pki();
    expect(await onlyVerdict(await stamped(tsaSelfSigned), [])).toMatchObject({
      integrity: 'valid',
      trust: 'self-signed',
      signer: 'Self TSA',
    });
    expect(await onlyVerdict(await stamped(tsaUnsupported, [root]), [root.der])).toMatchObject({
      trust: 'indeterminate',
      trustReason: 'unsupported-signature',
    });
  });

  it('reads a token over other bytes as invalid, with the clock as the time source', async () => {
    const { tsa } = await pki();
    const bytes = await signedPdf(
      async (covered) => await issueTimestampToken({ tsa, covered: covered.slice(1), genTime: day(3, 1) }),
      { dictionary: timestampDictionary() },
    );
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'invalid',
      reasonKey: 'props.sig.reason.timestamp.invalid',
      certificateValidity: 'unknown',
      validationTimeSource: 'clock',
      timestamp: { status: 'invalid', reason: 'imprint-mismatch' },
    });
  });

  it('reads bytes that are no token as unchecked', async () => {
    const bytes = await signedPdf(() => Uint8Array.of(1, 2, 3), { dictionary: timestampDictionary() });
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'unchecked',
      reasonKey: 'props.sig.reason.timestamp.unchecked',
      timestamp: { status: 'unchecked', reason: 'malformed' },
    });
  });

  it('counts the revisions after a document timestamp and reports the range as partial', async () => {
    const { tsa } = await pki();
    const bytes = await signedThenRevised(
      async (covered) => await issueTimestampToken({ tsa, covered, genTime: day(3, 1) }),
      [{}],
      { dictionary: timestampDictionary() },
    );
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'valid',
      coverage: 'covers-partial',
      changesAfterSigning: 1,
    });
  });

  it('leaves a timestamp whose /ByteRange does not match its bytes unchecked, without reading the token', async () => {
    const dictionary = timestampDictionary({ capacity: 16 });
    const bytes = appendRevision(new Uint8Array(), { objects: documentObjects(dictionary), size: 6 }).bytes;
    expect(await onlyVerdict(bytes)).toMatchObject({
      subFilter: 'ETSI.RFC3161',
      integrity: 'unchecked',
      reasonKey: REASON.layout,
      coverage: 'unknown',
      signer: null,
      timestamp: null,
    });
  });

  it('leaves a timestamp whose range runs past the end of the file unchecked', async () => {
    const { tsa } = await pki();
    const bytes = await stamped(tsa, [], { seal: { end: 100_000 } });
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'unchecked',
      reasonKey: REASON.layout,
      coverage: 'unknown',
    });
  });

  it('leaves a timestamp whose /Contents is not a string unchecked', async () => {
    // The dictionary's own /Contents is a number; the only string the file scan finds in the gap
    // belongs to a nested dictionary, so the object graph has no token to verify.
    const dictionary = nestedContentsDictionary('ETSI.RFC3161');
    const bytes = await signedPdf(() => Uint8Array.of(1, 2, 3), { dictionary });
    expect(await onlyVerdict(bytes)).toMatchObject({
      subFilter: 'ETSI.RFC3161',
      integrity: 'unchecked',
      reasonKey: REASON.layout,
      coverage: 'covers-whole-document',
      timestamp: null,
    });
  });
});

describe('a signature dictionary whose /Contents is not a string', () => {
  it('reads a detached signature without a /Contents string as unchecked, with no signer and no trust', async () => {
    const bytes = await signedPdf(() => Uint8Array.of(1, 2, 3), {
      dictionary: nestedContentsDictionary('adbe.pkcs7.detached'),
    });
    expect(await onlyVerdict(bytes)).toMatchObject({
      integrity: 'unchecked',
      reasonKey: REASON.der,
      signer: null,
      trust: 'not-checked',
      trustPath: [],
      coverage: 'covers-whole-document',
    });
  });
});

describe('a cross-reference chain this verifier cannot follow', () => {
  // A decoy `%%EOF` inside the first revision after the signature: the readable chain says 2
  // revisions, a count of %%EOF markers says 3. So the number tells which measurement answered.
  const DECOY: Later = { body: '<< /Note (%%EOF) >>' };

  it.each([
    ['an unterminated string', () => '<< /Size 106 /Root 1 0 R /Info (oops'],
    ['an unterminated hex string', () => '<< /Size 106 /Root 1 0 R /Info <abc'],
    ['a dictionary that never closes', () => '<< /Size 106 /Root 1 0 R'],
    [
      'a /Prev that sits beyond the scan window',
      (previous: number) => `<< /Size 106 /Root 1 0 R${' '.repeat(70_000)} /Prev ${previous} >>`,
    ],
    ['something other than a dictionary after the trailer keyword', () => '[ /Size 106 ]'],
    ['no trailer keyword at all', () => null],
  ])('counts the end-of-file markers when the newest trailer holds %s', async (_title, trailer) => {
    const signer = await identity();
    const bytes = await signedThenRevised(cmsBy(signer), [DECOY, { trailer }]);
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(3);
  });

  it('counts the end-of-file markers when an older revision has no trailer of its own', async () => {
    const signer = await identity();
    const bytes = await signedThenRevised(cmsBy(signer), [{ ...DECOY, trailer: () => null }, {}]);
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(3);
  });

  it('counts the end-of-file markers when startxref points into the middle of nothing', async () => {
    const signer = await identity();
    const bytes = await signedThenRevised(cmsBy(signer), [DECOY, {}]);
    const text = latin1(bytes);
    const eof = text.lastIndexOf('%%EOF');
    const pointed = fromLatin1(text.replace(/startxref\n(\d+)\n%%EOF\n$/, `startxref\n${eof}\n%%EOF\n`));
    expect((await onlyVerdict(pointed)).changesAfterSigning).toBe(3);
  });

  it.each([
    ['a hex string', '/ID [<aa bb> <cc>]'],
    ['a literal string with escaped and nested parentheses', '/Info (a \\) b (c) d)'],
  ])('still follows /Prev when the newest trailer holds %s before it', async (_title, entry) => {
    const signer = await identity();
    const bytes = await signedThenRevised(cmsBy(signer), [
      DECOY,
      { trailer: (previous) => `<< /Size 106 /Root 1 0 R ${entry} /Prev ${previous} >>` },
    ]);
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(2);
  });

  it('counts the end-of-file markers when the last startxref names no offset and the file ends in whitespace', async () => {
    const signer = await identity();
    const revised = await signedThenRevised(cmsBy(signer), [DECOY, {}]);
    const bytes = concat(revised, fromLatin1('\nstartxref\n \r\n'));
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(3);
  });

  it('stops at a /Prev that leads back to a section already read', async () => {
    const signer = await identity();
    // The first revision's own /Prev names the second revision: R3 -> R2 -> R1 -> R2 -> ...
    // Fixed-width offsets keep every byte in place between the probe and the real build.
    const build = async (second: number): Promise<Uint8Array> =>
      await signedThenRevised(cmsBy(signer), [DECOY, {}], {
        revision: { trailer: `<< /Size 6 /Root 1 0 R /Prev ${String(second).padStart(10, '0')} >>` },
      });
    const sections = [...latin1(await build(0)).matchAll(/startxref\n(\d+)\n/g)].map((match) =>
      Number(match[1]),
    );
    expect(sections).toHaveLength(3);
    expect((await onlyVerdict(await build(sections[1] ?? 0))).changesAfterSigning).toBe(2);
  });

  it('reports no revision after a signature that covers the whole of a file with no cross-reference section', async () => {
    const signer = await identity();
    const bare = await signedPdf(cmsBy(signer), { revision: { xref: 'none' } });
    expect(latin1(bare)).not.toContain('startxref');
    expect(await onlyVerdict(bare)).toMatchObject({ integrity: 'valid', changesAfterSigning: 0 });
  });

  it('does not follow a /Prev that sits inside a string or a nested dictionary of the trailer', async () => {
    const signer = await identity();
    const bytes = await signedThenRevised(cmsBy(signer), [
      {},
      {
        trailer: (previous) =>
          `<< /Size 106 /Root 1 0 R /Info (/Prev 9) /Deep << /Prev 9 >> /Previous 9 /Prev ${previous} >>`,
      },
    ]);
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(2);
  });

  it.each([
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
  ])('does not follow a /Prev that is commented out up to %s before the real one', async (_title, eol) => {
    const signer = await identity();
    const bytes = await signedThenRevised(cmsBy(signer), [
      DECOY,
      {
        trailer: (previous) => `<< /Size 106 /Root 1 0 R % /Prev 9${eol} /Prev ${previous} >>`,
      },
    ]);
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(2);
  });

  it('reads the key after a comment that ends the line, not text after it', async () => {
    const signer = await identity();
    const bytes = await signedThenRevised(cmsBy(signer), [
      DECOY,
      { trailer: (previous) => `<< /Size 106 % (\n/Root 1 0 R /Prev ${previous} >>` },
    ]);
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(2);
  });

  it.each([
    [
      'a name value before the key',
      (previous: number) => `<< /Size 106 /Root 1 0 R /Foo /Prev /Prev ${previous} >>`,
    ],
    ['the value of /Type', (previous: number) => `<< /Type /Prev /Size 106 /Root 1 0 R /Prev ${previous} >>`],
    [
      'the value of an entry after an indirect reference',
      (previous: number) => `<< /Root 1 0 R /Foo /Prev /Prev ${previous} >>`,
    ],
  ])('does not take /Prev as the key when it is %s', async (_title, trailer) => {
    const signer = await identity();
    const bytes = await signedThenRevised(cmsBy(signer), [DECOY, { trailer }]);
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(2);
  });

  it.each([
    ['a hex string value', '/Info <aa bb> '],
    ['an array holding a string', '/Arr [ (x) ] '],
    ['an array holding an array', '/Arr [ [ 1 ] 2 ] '],
    ['an array holding a dictionary', '/Arr [ << /A 1 >> ] '],
    ['a dictionary holding a dictionary', '/Deep << /Inner << /A 1 >> >> '],
    ['a stray closing parenthesis', '/Info ) /Foo 1 '],
    ['a number followed by a second number that is no reference', '/Foo 1 0 /Bar 2 '],
    ['a reference marker that runs into more name characters', '/Foo 1 0 Rx '],
    ['an indirect reference closed by a delimiter', '/Foo 1 0 R'],
  ])('follows /Prev past %s in the newest trailer', async (_title, entry) => {
    const signer = await identity();
    const bytes = await signedThenRevised(cmsBy(signer), [
      DECOY,
      { trailer: (previous) => `<< /Size 106 /Root 1 0 R ${entry}/Prev ${previous} >>` },
    ]);
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(2);
  });

  it('reports at most 1024 revisions however many the file holds', async () => {
    const signer = await identity();
    const later = Array.from({ length: 1030 }, () => ({}) satisfies Later);
    const bytes = await signedThenRevised(cmsBy(signer), later);
    expect((await onlyVerdict(bytes)).changesAfterSigning).toBe(1024);
  });
});

describe('how many signed fields an opened document carries', () => {
  const countIn = async (bytes: Uint8Array): Promise<number> => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument(bytes);
    try {
      return countSignedFields(doc);
    } finally {
      doc.destroy();
    }
  };

  it('counts each signature once, however many widgets point at it', async () => {
    const bytes = formFile({
      fields: '[10 0 R 11 0 R 12 0 R]',
      objects: [
        { number: 10, body: '<< /T (first) /FT /Sig /V 20 0 R >>' },
        { number: 11, body: '<< /T (second) /FT /Sig /V 20 0 R >>' },
        { number: 12, body: '<< /T (third) /FT /Sig /V 21 0 R >>' },
        { number: 20, body: SIGNATURE },
        { number: 21, body: SIGNATURE },
      ],
    });
    expect(await countIn(bytes)).toBe(2);
  });

  it('counts none in a form whose only field holds no signature', async () => {
    const bytes = formFile({
      fields: '[10 0 R]',
      objects: [{ number: 10, body: '<< /T (text) /V (hello) >>' }],
    });
    expect(await countIn(bytes)).toBe(0);
  });
});

describe('what stops a verification', () => {
  it('refuses an encrypted document that mentions a /ByteRange, naming the reason', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
    doc
      .getTrailer()
      .get('Root')
      .put('Probe', doc.addObject({ ByteRange: [0, 0, 0, 0] }));
    const bytes = new Uint8Array(
      doc.saveToBuffer('encrypt=aes-256,user-password=secret,owner-password=owner').asUint8Array(),
    );
    doc.destroy();
    expect(latin1(bytes)).toContain('/ByteRange');
    await expect(verifySignatures(bytes)).rejects.toMatchObject({
      code: 'encrypted-unsupported',
      details: { engineMessage: 'verify signatures: the document needs a password to be read' },
    });
  });

  it('answers a document whose bytes never name a /ByteRange with an empty list', async () => {
    const bytes = formFile({ fields: '[]' });
    expect(latin1(bytes)).not.toContain('/ByteRange');
    expect(await verdictsOf(bytes)).toEqual([]);
  });

  it('answers a document with no /Root, and so no signature field, with an empty list', async () => {
    const objects = [
      { number: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { number: 5, body: '<< /ByteRange [0 0 0 0] >>' },
    ];
    const bytes = appendRevision(new Uint8Array(), { objects, size: 6, root: 9 }).bytes;
    expect(await verdictsOf(bytes)).toEqual([]);
  });

  it('maps an engine failure while the document is read to a ToolError instead of leaking it', async () => {
    // /Count promises pages the page tree does not have, so the page walk fails inside MuPDF.
    const objects = [
      {
        number: 1,
        body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [] >> >>',
      },
      { number: 2, body: '<< /Type /Pages /Kids [] /Count 3 >>' },
      { number: 5, body: '<< /ByteRange [0 0 0 0] >>' },
    ];
    const bytes = appendRevision(new Uint8Array(), { objects, size: 6 }).bytes;
    await expect(verdictsOf(bytes)).rejects.toMatchObject({ name: 'ToolError' });
  });

  it('stops with the abort itself, not an engine error, when the signal fires while pages are read', async () => {
    const signer = await identity();
    const bytes = await signedPdf(cmsBy(signer));
    await expect(verifySignatures(bytes, abortsAtRead(1))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops with the abort between two signatures', async () => {
    const signer = await identity();
    const bytes = await signedPdf(cmsBy(signer));
    await expect(verifySignatures(bytes, abortsAtRead(2))).rejects.toMatchObject({ name: 'AbortError' });
    expect(await verifySignatures(bytes, new AbortController().signal, { now: NOW })).toHaveLength(1);
  });
});

const abortsAtRead = (limit: number): AbortSignal => {
  let reads = 0;
  return {
    get aborted() {
      reads += 1;
      return reads >= limit;
    },
  } as AbortSignal;
};
