import { inspectProtection } from 'pdf-core/ops/security';
import { describe, expect, it } from 'vitest';
import { mupdfForTests, runContext, runDialog, textPdf } from '../pdf-fixtures';
import { protectDialog, unlockDialog } from './security';

const bytesOf = (result: { files: readonly { bytes: Uint8Array }[] }) =>
  result.files[0]?.bytes ?? new Uint8Array();

async function authenticate(bytes: Uint8Array, password: string): Promise<number> {
  const mupdf = await mupdfForTests();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return doc.authenticatePassword(password);
  } finally {
    doc.destroy();
  }
}

describe('protectDialog', () => {
  it('locks the file with the typed passwords and stores exactly the permissions ticked', async () => {
    const result = await runDialog(
      protectDialog,
      { userPassword: ' open sesame ', ownerPassword: 'boss', permissions: ['print', 'accessibility'] },
      await textPdf([['secret']]),
      { name: 'plan.pdf' },
    );
    expect(result.noticeKey).toBe('security.done');
    expect(result.files[0]?.name).toBe('plan.pdf');
    const bytes = bytesOf(result);
    // The spaces are part of the password.
    expect(await authenticate(bytes, ' open sesame ')).toBeGreaterThan(0);
    expect(await authenticate(bytes, 'open sesame')).toBe(0);
    expect(await inspectProtection(bytes)).toMatchObject({
      encrypted: true,
      needsPassword: true,
      permissions: {
        print: true,
        printHighQuality: false,
        copy: false,
        modify: false,
        annotate: false,
        form: false,
        assemble: false,
        accessibility: true,
      },
    });
  });

  it('grants nothing when the host sends no permission list, and every permission when all are ticked', async () => {
    const locked = await protectDialog.run(
      { userPassword: 'u', ownerPassword: 'o' },
      await runContext(await textPdf([['x']])),
    );
    expect((await inspectProtection(bytesOf(locked))).permissions).toEqual({
      print: false,
      printHighQuality: false,
      copy: false,
      modify: false,
      annotate: false,
      form: false,
      assemble: false,
      accessibility: false,
    });
    const all = await runDialog(
      protectDialog,
      { userPassword: 'u', ownerPassword: 'o' },
      await textPdf([['x']]),
    );
    expect(Object.values((await inspectProtection(bytesOf(all))).permissions).every(Boolean)).toBe(true);
  });

  it('re-locks a locked document with the password it came with', async () => {
    const first = await protectDialog.run(
      { userPassword: 'old', ownerPassword: 'old-owner' },
      await runContext(await textPdf([['x']])),
    );
    const again = await runDialog(
      protectDialog,
      { oldPassword: 'old', userPassword: 'new', ownerPassword: 'new-owner' },
      bytesOf(first),
    );
    expect(await authenticate(bytesOf(again), 'new')).toBeGreaterThan(0);
    expect(await authenticate(bytesOf(again), 'old')).toBe(0);
  });
});

describe('unlockDialog', () => {
  it('removes the password into a new file named after the dictionary suffix', async () => {
    const locked = await protectDialog.run(
      { userPassword: 'pw', ownerPassword: 'ow' },
      await runContext(await textPdf([['x']])),
    );
    const context = await runContext(bytesOf(locked), { name: 'plan.pdf' });
    const result = await unlockDialog.run({ password: 'pw' }, context);
    expect(result.files[0]?.name).toBe(`plan-1-${context.t('security.unlock.suffix')}.pdf`);
    expect((await inspectProtection(bytesOf(result))).encrypted).toBe(false);
  });

  it('refuses a wrong password', async () => {
    const locked = await protectDialog.run(
      { userPassword: 'pw', ownerPassword: 'ow' },
      await runContext(await textPdf([['x']])),
    );
    const run = runDialog(unlockDialog, { password: 'nope' }, bytesOf(locked));
    await expect(run).rejects.toMatchObject({ code: 'wrong-password' });
    const none = unlockDialog.run({}, await runContext(bytesOf(locked)));
    await expect(none).rejects.toMatchObject({ code: 'wrong-password' });
  });
});

describe('protectDialog without passwords', () => {
  it('writes an empty user password when none is sent, so the file is encrypted but opens without one', async () => {
    const result = await protectDialog.run(
      { ownerPassword: 'boss' },
      await runContext(await textPdf([['x']])),
    );
    expect(await inspectProtection(bytesOf(result))).toMatchObject({ encrypted: true, needsPassword: false });
  });

  it('refuses a missing owner password with the password policy, as it does an empty one', async () => {
    const run = protectDialog.run({ userPassword: 'open' }, await runContext(await textPdf([['x']])));
    await expect(run).rejects.toMatchObject({
      code: 'password-policy',
      details: { engineMessage: expect.stringContaining('owner password is required') },
    });
  });
});
