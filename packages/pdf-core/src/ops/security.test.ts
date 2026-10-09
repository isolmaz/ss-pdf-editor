/**
 * Encryption, inspection and unlocking against the real MuPDF engine. The wrong answers
 * that matter: a file that comes back unprotected or opens with the wrong password, a
 * permission bit that does not match what the user ticked, a re-protection that loses the
 * pages, a wrong old password that ends in a garbage file, and engine option text that a
 * password containing `,` or `=` would corrupt.
 */

import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { generateKey, issueCertificate } from '../signature-trust.fixtures';
import { build, TWO_LINES } from './redact.fixtures';
import {
  ALL_PERMISSIONS,
  inspectProtection,
  type ProtectionPermissions,
  type ProtectOptions,
  permissionsToBits,
  protectDocument,
  unlockDocument,
} from './security';
import { signPdf } from './sign';
import { verifySignatures } from './signature-status';

const run = { signal: new AbortController().signal };

const OPTIONS: ProtectOptions = {
  userPassword: 'kullanıcı',
  ownerPassword: 'sahip',
  permissions: ALL_PERMISSIONS,
};

const NO_COPY: ProtectionPermissions = { ...ALL_PERMISSIONS, copy: false, print: false };

const abortsAtRead = (limit: number): AbortSignal => {
  let reads = 0;
  return {
    get aborted() {
      reads += 1;
      return reads >= limit;
    },
  } as AbortSignal;
};

/** Three pages, so the text sample covers the first, middle and last. */
async function threePages(): Promise<Uint8Array> {
  return build(
    ['Birinci', 'Ikinci', 'Ucuncu'].map((word) => ({ lines: [[`${word} sayfa`, 50, 300]] as const })),
  );
}

/** The same bytes under the engine's own encrypt option string. */
async function lock(bytes: Uint8Array, encrypt: string): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  const locked = new Uint8Array(doc.saveToBuffer(encrypt).asUint8Array());
  doc.destroy();
  return locked;
}

/** Text of page `index` after authenticating with `password`. */
async function textOf(bytes: Uint8Array, index: number, password = ''): Promise<string> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf');
  if (doc.needsPassword()) doc.authenticatePassword(password);
  const page = doc.loadPage(index);
  const text = page.toStructuredText('preserve-whitespace').asText().replace(/\s+/g, ' ').trim();
  page.destroy();
  doc.destroy();
  return text;
}

/** A one-page document carrying a PAdES signature. */
async function signed(): Promise<Uint8Array> {
  const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
  const certificate = await issueCertificate({
    subject: 'İmza Deneme',
    keyPair,
    notBefore: new Date(Date.UTC(2026, 0, 1)),
    notAfter: new Date(Date.UTC(2027, 0, 1)),
    keyUsage: ['digitalSignature'],
  });
  const out = await signPdf(
    await build([TWO_LINES]),
    { identity: { certificate: certificate.der, privateKey: keyPair.privateKey } },
    run,
  );
  return out.bytes;
}

describe('protectDocument', () => {
  it('encrypts with AES-256 so the file asks for the password and every page survives', async () => {
    const source = await threePages();
    const events: string[] = [];
    const outcome = await protectDocument(source, OPTIONS, {
      signal: run.signal,
      onProgress: (entry) => events.push(`${entry.labelKey}:${entry.done}/${entry.total}`),
    });

    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(outcome.bytes, 'application/pdf');
    expect(doc.needsPassword()).toBe(true);
    expect(doc.authenticatePassword('yanlış')).toBe(0);
    expect(doc.authenticatePassword('kullanıcı')).toBe(2);
    expect(doc.countPages()).toBe(3);
    doc.destroy();
    expect(await textOf(outcome.bytes, 1, 'kullanıcı')).toBe('Ikinci sayfa');

    expect(events).toEqual(['op.progress.encrypt:0/1', 'op.progress.encrypt:1/1']);
    expect(outcome.report).toMatchObject({
      engine: 'mupdf',
      steps: ['open', 'encrypt=aes-256', 'verify'],
      incremental: false,
      pageCount: 3,
      inputBytes: source.byteLength,
      outputBytes: outcome.bytes.byteLength,
    });
    expect(outcome.report.notes).toEqual([
      {
        kind: 'changed',
        key: 'op.note.security.encryptionApplied',
        params: { cipher: 'aes-256', restricted: 0 },
      },
      { kind: 'preserved', key: 'op.note.security.verified' },
    ]);
    expect(await inspectProtection(outcome.bytes)).toEqual({
      encrypted: true,
      needsPassword: true,
      cipher: 'aes-256',
      permissions: ALL_PERMISSIONS,
    });
  });

  it('stores exactly the permissions that were not ticked, one at a time and all together', async () => {
    const source = await build([TWO_LINES]);
    const fields = Object.keys(ALL_PERMISSIONS) as (keyof ProtectionPermissions)[];
    const cases: ProtectionPermissions[] = [
      ...fields.map((field) => ({ ...ALL_PERMISSIONS, [field]: false })),
      Object.fromEntries(fields.map((field) => [field, false])) as unknown as ProtectionPermissions,
    ];
    for (const permissions of cases) {
      const outcome = await protectDocument(source, { ...OPTIONS, permissions }, run);
      expect((await inspectProtection(outcome.bytes)).permissions).toEqual(permissions);
      expect(outcome.report.notes[0]).toEqual({
        kind: 'changed',
        key: 'op.note.security.encryptionApplied',
        params: { cipher: 'aes-256', restricted: fields.filter((field) => !permissions[field]).length },
      });
    }
  });

  it('writes owner-only protection that opens freely and says so', async () => {
    const outcome = await protectDocument(
      await build([TWO_LINES]),
      { ...OPTIONS, userPassword: '', permissions: NO_COPY },
      run,
    );
    const state = await inspectProtection(outcome.bytes);
    expect(state).toMatchObject({ encrypted: true, needsPassword: false, cipher: 'aes-256' });
    expect(state.permissions).toEqual(NO_COPY);
    expect(outcome.report.notes.map((entry) => entry.key)).toEqual([
      'op.note.security.encryptionApplied',
      'op.note.security.opensWithoutPassword',
      'op.note.security.verified',
    ]);
    expect(await textOf(outcome.bytes, 0)).toBe('Public line Secret 4711');
  });

  describe('a signed document', () => {
    const SIGNATURE_NOTE = {
      kind: 'lost',
      key: 'op.note.security.signatureInvalidated',
    };

    it('warns that the signature no longer validates, and still encrypts', async () => {
      const source = await signed();
      expect(await verifySignatures(source, run.signal)).toHaveLength(1);
      const outcome = await protectDocument(source, OPTIONS, run);
      expect(outcome.report.notes).toEqual([
        {
          kind: 'changed',
          key: 'op.note.security.encryptionApplied',
          params: { cipher: 'aes-256', restricted: 0 },
        },
        SIGNATURE_NOTE,
        { kind: 'preserved', key: 'op.note.security.verified' },
      ]);
      expect((await inspectProtection(outcome.bytes)).encrypted).toBe(true);
    });

    it('warns for a password-locked signed input once its old password has opened it', async () => {
      const locked = await lock(await signed(), 'encrypt=aes-256,user-password=eski,owner-password=eski');
      const outcome = await protectDocument(locked, { ...OPTIONS, oldPassword: 'eski' }, run);
      expect(outcome.report.notes).toContainEqual(SIGNATURE_NOTE);
    });

    it('warns for a signature only a page /Annots reaches, as verifySignatures counts it', async () => {
      const mupdf = await loadMupdf();
      const doc = mupdf.PDFDocument.openDocument(await signed(), 'application/pdf').asPDF();
      if (doc === null) throw new Error('not a PDF');
      doc.getTrailer().get('Root').get('AcroForm').put('Fields', []);
      const annotsOnly = new Uint8Array(doc.saveToBuffer('').asUint8Array());
      doc.destroy();
      expect(await verifySignatures(annotsOnly, run.signal)).toHaveLength(1);
      const outcome = await protectDocument(annotsOnly, OPTIONS, run);
      expect(outcome.report.notes).toContainEqual(SIGNATURE_NOTE);
    });

    it('does not warn for an unsigned document or a signature field nobody signed', async () => {
      const plain = await protectDocument(await build([TWO_LINES]), OPTIONS, run);
      expect(plain.report.notes.map((entry) => entry.key)).not.toContain(SIGNATURE_NOTE.key);

      const mupdf = await loadMupdf();
      const doc = new mupdf.PDFDocument();
      const page = doc.addPage([0, 0, 300, 400], 0, {}, '');
      doc.insertPage(0, page);
      const field = doc.addObject({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: doc.newString('Bos') });
      doc
        .getTrailer()
        .get('Root')
        .put('AcroForm', { Fields: [field], SigFlags: 3 });
      const empty = new Uint8Array(doc.saveToBuffer('').asUint8Array());
      doc.destroy();
      const outcome = await protectDocument(empty, OPTIONS, run);
      expect(outcome.report.notes.map((entry) => entry.key)).not.toContain(SIGNATURE_NOTE.key);
    });
  });

  it('refuses an empty owner password and a password the option list would mangle', async () => {
    const source = await build([TWO_LINES]);
    await expect(protectDocument(source, { ...OPTIONS, ownerPassword: '' }, run)).rejects.toMatchObject({
      code: 'password-policy',
      details: { engineMessage: 'owner password is required: an empty owner password is not accepted' },
    });
    for (const bad of [
      { userPassword: 'a,b' },
      { userPassword: 'a=b' },
      { ownerPassword: 'x,y' },
      { ownerPassword: 'x=y' },
    ]) {
      await expect(protectDocument(source, { ...OPTIONS, ...bad }, run)).rejects.toMatchObject({
        code: 'password-policy',
        details: { engineMessage: 'password contains "=" or "," which the engine option list cannot carry' },
      });
    }
  });

  it('re-protects a locked file only with its old password, and moves it to the new passwords', async () => {
    const locked = await lock(
      await threePages(),
      'encrypt=aes-256,user-password=eski,owner-password=eskiSahip',
    );
    await expect(protectDocument(locked, OPTIONS, run)).rejects.toMatchObject({ code: 'wrong-password' });
    await expect(protectDocument(locked, { ...OPTIONS, oldPassword: 'yanlış' }, run)).rejects.toMatchObject({
      code: 'wrong-password',
      details: {
        engineMessage: 'the document is password-locked and the supplied password does not open it',
      },
    });
    const outcome = await protectDocument(locked, { ...OPTIONS, oldPassword: 'eski' }, run);
    expect(outcome.report.pageCount).toBe(3);
    expect(await textOf(outcome.bytes, 2, 'kullanıcı')).toBe('Ucuncu sayfa');
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(outcome.bytes, 'application/pdf');
    expect(doc.authenticatePassword('eski')).toBe(0);
    doc.destroy();
  });

  it('reports a page tree the engine cannot read as a tool error, not a raw engine failure', async () => {
    const damaged = await build([TWO_LINES], (doc) => {
      doc.getTrailer().get('Root').get('Pages').put('Kids', []);
    });
    await expect(protectDocument(damaged, OPTIONS, run)).rejects.toMatchObject({
      name: 'ToolError',
      details: { engine: 'mupdf', engineMessage: expect.stringMatching(/^protect: /) },
    });
  });

  it('refuses bytes that are not a PDF', async () => {
    await expect(protectDocument(new TextEncoder().encode('nope'), OPTIONS, run)).rejects.toMatchObject({
      code: 'corrupt-document',
    });
  });

  it('stops at every checkpoint when the signal is aborted', async () => {
    const source = await build([TWO_LINES]);
    // Reads: entry, after the engine loads, after the save.
    for (const limit of [1, 2, 3]) {
      await expect(protectDocument(source, OPTIONS, { signal: abortsAtRead(limit) })).rejects.toMatchObject({
        name: 'AbortError',
      });
    }
    expect((await protectDocument(source, OPTIONS, { signal: abortsAtRead(99) })).report.pageCount).toBe(1);
  });
});

describe('permissionsToBits', () => {
  it('sets the PDF permission bit of each allowed capability and no other', () => {
    const none = Object.fromEntries(
      Object.keys(ALL_PERMISSIONS).map((field) => [field, false]),
    ) as unknown as ProtectionPermissions;
    expect(permissionsToBits(none)).toBe(0);
    expect(permissionsToBits({ ...none, print: true })).toBe(1 << 2);
    expect(permissionsToBits({ ...none, modify: true })).toBe(1 << 3);
    expect(permissionsToBits({ ...none, copy: true })).toBe(1 << 4);
    expect(permissionsToBits({ ...none, annotate: true })).toBe(1 << 5);
    expect(permissionsToBits({ ...none, form: true })).toBe(1 << 8);
    expect(permissionsToBits({ ...none, accessibility: true })).toBe(1 << 9);
    expect(permissionsToBits({ ...none, assemble: true })).toBe(1 << 10);
    expect(permissionsToBits({ ...none, printHighQuality: true })).toBe(1 << 11);
    expect(permissionsToBits(ALL_PERMISSIONS)).toBe(3900);
  });
});

describe('inspectProtection', () => {
  it('reports an unprotected file as none', async () => {
    expect(await inspectProtection(await build([TWO_LINES]))).toEqual({
      encrypted: false,
      needsPassword: false,
      cipher: 'none',
      permissions: ALL_PERMISSIONS,
    });
  });

  it('names each cipher the engine can write', async () => {
    const source = await build([TWO_LINES]);
    for (const [option, cipher] of [
      ['aes-256', 'aes-256'],
      ['aes-128', 'aes-128'],
      ['rc4-128', 'rc4-128'],
      ['rc4-40', 'rc4-40'],
    ] as const) {
      const locked = await lock(source, `encrypt=${option},user-password=u,owner-password=o`);
      expect(await inspectProtection(locked), option).toMatchObject({
        encrypted: true,
        needsPassword: true,
        cipher,
      });
    }
  });

  it('passes an engine description it has no name for through verbatim', async () => {
    const locked = await lock(await build([TWO_LINES]), 'encrypt=rc4-128,user-password=u,owner-password=o');
    const text = new TextDecoder('latin1').decode(locked);
    expect(text).toContain('/Length 128');
    const odd = new Uint8Array(
      Uint8Array.from(text.replace('/Length 128', '/Length 112'), (c) => c.charCodeAt(0)),
    );
    const state = await inspectProtection(odd);
    expect(state.encrypted).toBe(true);
    expect(state.cipher).toBe('Standard V2 R3 112-bit RC4');
  });

  it('refuses bytes that are not a PDF', async () => {
    await expect(inspectProtection(new TextEncoder().encode('nope'))).rejects.toMatchObject({
      code: 'corrupt-document',
    });
  });
});

describe('unlockDocument', () => {
  it('removes the protection, keeps every page and says what changed', async () => {
    const locked = await lock(await threePages(), 'encrypt=aes-256,user-password=gizli,owner-password=sahip');
    const events: string[] = [];
    const outcome = await unlockDocument(locked, 'gizli', {
      signal: run.signal,
      onProgress: (entry) => events.push(`${entry.labelKey}:${entry.done}/${entry.total}`),
    });
    expect(await inspectProtection(outcome.bytes)).toMatchObject({
      encrypted: false,
      needsPassword: false,
      cipher: 'none',
    });
    expect(await textOf(outcome.bytes, 1)).toBe('Ikinci sayfa');
    expect(events).toEqual(['op.progress.decrypt:0/1', 'op.progress.decrypt:1/1']);
    expect(outcome.report).toMatchObject({
      steps: ['open', 'authenticate', 'save(encrypt=none)', 'verify'],
      pageCount: 3,
      incremental: false,
    });
    expect(outcome.report.notes).toEqual([
      { kind: 'changed', key: 'op.note.security.protectionRemoved' },
      { kind: 'preserved', key: 'op.note.security.verified' },
    ]);
  });

  it('warns that the signature no longer validates when it removes the password from a signed file', async () => {
    const locked = await lock(await signed(), 'encrypt=aes-256,user-password=gizli,owner-password=sahip');
    const outcome = await unlockDocument(locked, 'gizli', run);
    expect(outcome.report.notes).toEqual([
      { kind: 'changed', key: 'op.note.security.protectionRemoved' },
      { kind: 'lost', key: 'op.note.security.signatureInvalidatedUnlock' },
      { kind: 'preserved', key: 'op.note.security.verified' },
    ]);
    expect((await inspectProtection(outcome.bytes)).encrypted).toBe(false);
  });

  it('does not warn when it unlocks an unsigned file', async () => {
    const locked = await lock(
      await build([TWO_LINES]),
      'encrypt=aes-256,user-password=gizli,owner-password=sahip',
    );
    const outcome = await unlockDocument(locked, 'gizli', run);
    expect(outcome.report.notes.map((entry) => entry.key)).not.toContain(
      'op.note.security.signatureInvalidatedUnlock',
    );
  });

  it('opens an owner-only file without a password', async () => {
    const locked = await lock(await build([TWO_LINES]), 'encrypt=aes-256,owner-password=sahip');
    const outcome = await unlockDocument(locked, '', run);
    expect((await inspectProtection(outcome.bytes)).encrypted).toBe(false);
  });

  it('returns a file that was never protected as a copy, and says so', async () => {
    const source = await build([TWO_LINES, TWO_LINES]);
    const outcome = await unlockDocument(source, 'anything', run);
    expect(outcome.bytes).toEqual(source);
    expect(outcome.bytes).not.toBe(source);
    expect(outcome.report).toMatchObject({
      steps: ['inspect'],
      incremental: true,
      pageCount: 2,
      inputBytes: source.byteLength,
      outputBytes: source.byteLength,
    });
    expect(outcome.report.notes).toEqual([{ kind: 'warning', key: 'op.note.security.alreadyUnprotected' }]);
  });

  it('refuses a wrong password before anything is written', async () => {
    const locked = await lock(
      await build([TWO_LINES]),
      'encrypt=aes-256,user-password=gizli,owner-password=sahip',
    );
    await expect(unlockDocument(locked, 'yanlış', run)).rejects.toMatchObject({
      code: 'wrong-password',
      details: { engineMessage: 'authenticatePassword returned 0' },
    });
  });

  it('refuses bytes that are not a PDF', async () => {
    await expect(unlockDocument(new TextEncoder().encode('nope'), '', run)).rejects.toMatchObject({
      code: 'corrupt-document',
    });
  });

  it('stops at every checkpoint when the signal is aborted', async () => {
    const locked = await lock(
      await build([TWO_LINES]),
      'encrypt=aes-256,user-password=gizli,owner-password=sahip',
    );
    // Reads: entry, after the document was read, after the save. The middle one is inside the
    // engine's try block and surfaces as the mapped `aborted` error.
    const outcomes = { 1: 'AbortError', 2: 'ToolError', 3: 'AbortError' };
    for (const [limit, name] of Object.entries(outcomes)) {
      await expect(
        unlockDocument(locked, 'gizli', { signal: abortsAtRead(Number(limit)) }),
      ).rejects.toMatchObject({
        name,
      });
    }
  });
});
