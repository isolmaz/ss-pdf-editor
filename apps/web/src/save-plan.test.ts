/**
 * The byte facts a save is planned on. The wrong answers that matter: a signed file
 * reported as "the signature will break" when the save writes exactly the signed bytes
 * (the warning every export of a just-signed document showed), and an appended revision
 * or a rewrite reported as harmless.
 */

import { SessionStore } from 'pdf-model';
import { describe, expect, it } from 'vitest';
import { extendsBytes, planSaveExecution, signatureWarning, signedBytesFate } from './save-plan';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('extendsBytes', () => {
  it('holds for an identical file and for one with bytes appended', () => {
    expect(extendsBytes(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true);
    expect(extendsBytes(bytes(1, 2, 3, 4), bytes(1, 2, 3))).toBe(true);
  });

  it('fails for a shorter output and for a changed byte anywhere in the prefix', () => {
    expect(extendsBytes(bytes(1, 2), bytes(1, 2, 3))).toBe(false);
    expect(extendsBytes(bytes(9, 2, 3, 4), bytes(1, 2, 3))).toBe(false);
    expect(extendsBytes(bytes(1, 2, 9, 4), bytes(1, 2, 3))).toBe(false);
  });
});

describe('signedBytesFate', () => {
  const signed = bytes(37, 80, 68, 70, 1, 2, 3);

  it('calls the signed file itself unchanged — nothing to warn about', () => {
    expect(signedBytesFate(signed.slice(), signed)).toBe('unchanged');
  });

  it('calls a revision after the signed bytes appended — the signature stays valid', () => {
    expect(signedBytesFate(bytes(...signed, 10, 11), signed)).toBe('appended');
  });

  it('calls anything that does not keep the signed bytes rewritten — the signature breaks', () => {
    expect(signedBytesFate(bytes(37, 80, 68, 70, 1, 2, 9), signed)).toBe('rewritten');
    expect(signedBytesFate(bytes(37, 80, 68), signed)).toBe('rewritten');
  });

  it('compares with the signed bytes, not the file the session opened', () => {
    // A signing rewrites the file: the signed version does not extend the original, and
    // saving it unchanged must still read as unchanged.
    const original = bytes(37, 80, 68, 70, 5, 5);
    expect(extendsBytes(signed, original)).toBe(false);
    expect(signedBytesFate(signed.slice(), signed)).toBe('unchanged');
  });
});

describe('signatureWarning', () => {
  const opened = bytes(37, 80, 68, 70, 1, 1);
  const signedInSession = bytes(37, 80, 68, 70, 2, 2, 2);
  /** Signatures per file, by identity: the verifier the save path passes in. */
  const verifier = (signed: readonly Uint8Array[]) => {
    const asked: Uint8Array[] = [];
    const verify = async (file: Uint8Array) => {
      asked.push(file);
      return signed.includes(file) ? ['signature'] : [];
    };
    return { verify, asked };
  };

  it('warns when an edit already rewrote a signed opened file, even if the save writes that edit as is', async () => {
    // The reviewed defect: the edited version is the output, so comparing with it alone
    // said "unchanged" and the broken signature of the opened file went unannounced.
    const edited = bytes(37, 80, 68, 70, 9, 9);
    const { verify } = verifier([opened]);
    expect(await signatureWarning(edited.slice(), opened, edited, verify)).toEqual({
      fate: 'rewritten',
      signatures: ['signature'],
    });
  });

  it('stays silent when the export is exactly the file the session signed', async () => {
    const { verify } = verifier([signedInSession]);
    expect(await signatureWarning(signedInSession.slice(), opened, signedInSession, verify)).toBeNull();
  });

  it('announces a revision after a signature the session wrote', async () => {
    const { verify } = verifier([signedInSession]);
    const output = bytes(...signedInSession, 10);
    expect(await signatureWarning(output, opened, signedInSession, verify)).toEqual({
      fate: 'appended',
      signatures: ['signature'],
    });
  });

  it('warns when a later edit rewrote a file the session signed, the edit being the output', async () => {
    // Sign, then rotate: the newest version is the rewritten file, so the signed one is
    // only in the history before it.
    const edited = bytes(37, 80, 68, 70, 7, 7, 7, 7);
    const { verify } = verifier([signedInSession]);
    expect(await signatureWarning(edited.slice(), opened, edited, verify, [signedInSession])).toEqual({
      fate: 'rewritten',
      signatures: ['signature'],
    });
  });

  it('lets a rewrite win over an append when both files are signed', async () => {
    const { verify } = verifier([opened, signedInSession]);
    const output = bytes(...signedInSession, 10);
    expect((await signatureWarning(output, opened, signedInSession, verify))?.fate).toBe('rewritten');
  });

  it('lets a rewrite win over an append whichever file reports it', async () => {
    // The opened file is kept (the output only appends to it) while the file the session
    // produced is not: the produced file's rewrite has to override the earlier append.
    const output = bytes(...opened, 7);
    const verify = async (file: Uint8Array) => (file === opened ? ['opened'] : ['produced']);
    expect(await signatureWarning(output, opened, signedInSession, verify)).toEqual({
      fate: 'rewritten',
      signatures: ['produced'],
    });
  });

  it('stops asking once a rewrite is certain', async () => {
    const { verify, asked } = verifier([opened, signedInSession]);
    await signatureWarning(bytes(9, 9), opened, signedInSession, verify);
    expect(asked).toEqual([opened]);
  });

  it('never asks the verifier about a file the output keeps unchanged', async () => {
    const { verify, asked } = verifier([opened]);
    expect(await signatureWarning(opened.slice(), opened, null, verify)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('says nothing about a rewrite of an unsigned document', async () => {
    const { verify } = verifier([]);
    expect(await signatureWarning(bytes(1, 2), opened, null, verify)).toBeNull();
  });
});

describe('planSaveExecution', () => {
  const master = bytes(37, 80, 68, 70, 1, 2, 3);
  const tabOf = () =>
    new SessionStore().openDocument({ name: 'a.pdf', bytes: master, sha256: 'hash', pageCount: 1 });
  const input = (baseBytes: Uint8Array, extra: { engineDirty?: boolean } = {}) => ({
    tab: tabOf(),
    engineDirty: extra.engineDirty ?? false,
    annotations: [],
    baseBytes,
    encryptedOutput: false,
    executedSteps: [{ id: 'pdfjs.saveDocument', engine: 'pdfjs', note: 'engine save' }],
  });

  it('calls a save incremental only when the output keeps every byte of the opened file', () => {
    expect(planSaveExecution(input(bytes(...master, 9))).plan.incremental).toBe(true);
    expect(planSaveExecution(input(bytes(37, 80, 68, 70, 9, 9, 9, 9))).plan.incremental).toBe(false);
  });

  it('reports the steps this run executed and the encryption of the output', () => {
    const plan = planSaveExecution({ ...input(master), encryptedOutput: true });
    expect(plan.steps.map((step) => step.id)).toEqual(['pdfjs.saveDocument']);
    expect(plan.plan.encrypted).toBe(true);
  });

  it('marks annotations and forms changed when the engine holds unsaved values', () => {
    expect(planSaveExecution(input(master)).changeSet.forms).toBe(false);
    const dirty = planSaveExecution(input(master, { engineDirty: true })).changeSet;
    expect(dirty.forms).toBe(true);
    expect(dirty.annotations).toBe(true);
  });
});
