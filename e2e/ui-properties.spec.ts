/**
 * The document-information panel of the right dock: the font inventory, the embedded files
 * (sizes, open, add, remove), the security state and the verdicts on existing signatures.
 * What the panel says is read on screen; what its actions do is read back from the produced
 * and downloaded bytes.
 */

import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright/test';
import { notice } from './app-helpers';
import { makeSignerContainer, SIGNER } from './signer-fixture';
import { expect, test } from './test';
import { readProducedPdf } from './tool-fixture';
import { exportBytes, openDockTab, openPdf } from './ui-helpers';
import {
  cmsBy,
  cmsWithTimestamp,
  crlBy,
  dssWithCrls,
  fromNow,
  importCrlFiles,
  importRootFiles,
  issueTimestampToken,
  ownerProtected,
  pem,
  signedDocument,
  signingPki,
  utf8,
  withEmbedded,
  withFonts,
} from './ui-panels9-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

/** The panel, once its tab is open. */
async function openProperties(page: Page): Promise<Locator> {
  await openDockTab(page, 'Document information');
  const panel = page.getByRole('region', { name: 'Document information' });
  await expect(panel).toBeVisible();
  return panel;
}

const section = (panel: Locator, name: string): Locator => panel.getByRole('region', { name });

test('fonts are listed with their kind, page count, embedding, subset tag and encoding', async ({ page }) => {
  await openPdf(page, 'fonts.pdf', await withFonts());
  const panel = await openProperties(page);
  const fonts = section(panel, 'Fonts').getByRole('list', { name: 'Fonts' }).getByRole('listitem');
  await expect(fonts).toHaveCount(3);

  // The page's own base-14 font: not embedded, used on both pages.
  const helvetica = fonts.filter({ hasText: 'Helvetica' });
  await expect(helvetica).toContainText('Type1');
  await expect(helvetica).toContainText('2 page(s)');
  await expect(helvetica).toContainText('Not embedded');
  await expect(helvetica).toContainText('Encoding: WinAnsiEncoding');
  await expect(helvetica).not.toContainText('Subset');

  const subset = fonts.filter({ hasText: 'ABCDEF+Embedded' });
  await expect(subset).toContainText('TrueType');
  await expect(subset).toContainText('1 page(s)');
  await expect(subset).toContainText('Embedded');
  await expect(subset).not.toContainText('Not embedded');
  await expect(subset).toContainText('Subset');
  await expect(subset).toContainText('Encoding: MacRomanEncoding');

  // A font with no base name is shown by its kind, and an encoding that is only a list of
  // differences has no name to show.
  const nameless = fonts.filter({ hasNotText: /Helvetica|ABCDEF/ });
  await expect(nameless).toHaveCount(1);
  await expect(nameless).toContainText('Type1');
  await expect(nameless).toContainText('Not embedded');
  await expect(nameless).not.toContainText('Encoding');
});

const attachmentRow = (panel: Locator, name: string): Locator =>
  section(panel, 'Attachments').getByRole('listitem').filter({ hasText: name });

/** The panel's polite live region, the sentence a screen reader is given when a list changes. */
const announcement = (panel: Locator): Locator => panel.locator('[aria-live="polite"]');

/** Click `button` and read the file the browser was asked to download. */
async function downloaded(page: Page, button: Locator, name: string) {
  const event = page.waitForEvent('download');
  await button.click();
  const file = await event;
  const path = test.info().outputPath(name);
  await file.saveAs(path);
  return { suggested: file.suggestedFilename(), bytes: new Uint8Array(readFileSync(path)) };
}

test('an embedded file is listed with its description and can be written out; one whose payload is gone says so', async ({
  page,
}) => {
  await openPdf(
    page,
    'files.pdf',
    await withEmbedded([
      { name: 'a.txt', bytes: utf8('hello'), description: 'A greeting' },
      { name: 'b.txt', bytes: utf8('lost'), withoutStream: true },
    ]),
  );
  const panel = await openProperties(page);
  const a = attachmentRow(panel, 'a.txt');
  await expect(a).toContainText('A greeting');
  // No description: the line carries the size alone, with no separator left over.
  await expect(attachmentRow(panel, 'b.txt')).toHaveText(/^b\.txtSize unreadableOpenRemove$/);

  const opened = await downloaded(page, a.getByRole('button', { name: 'Open attachment a.txt' }), 'a.txt');
  expect(opened.suggested).toBe('a.txt');
  expect(new TextDecoder().decode(opened.bytes)).toBe('hello');
  await expect(page.getByText('Open attachment a.txt', { exact: true }).first()).toBeVisible();

  await attachmentRow(panel, 'b.txt').getByRole('button', { name: 'Open attachment b.txt' }).click();
  await expect(page.getByText(/The document looks damaged\./)).toBeVisible();
});

test('the size of an embedded file is measured from its payload', async ({ page }) => {
  await openPdf(
    page,
    'sizes.pdf',
    await withEmbedded([
      { name: 'a.txt', bytes: utf8('hello'), description: 'A greeting' },
      { name: 'b.bin', bytes: new Uint8Array(3000).map((_, index) => (index * 7919) % 251) },
      { name: 'c.txt', bytes: utf8('lost'), withoutStream: true },
    ]),
  );
  const panel = await openProperties(page);
  await expect(attachmentRow(panel, 'a.txt')).toContainText('5 byte · A greeting');
  await expect(attachmentRow(panel, 'b.bin')).toContainText('3,000 byte');
  await expect(attachmentRow(panel, 'c.txt')).toContainText('Size unreadable');
});

test('adding and removing embedded files changes the document and is announced', async ({ page }) => {
  await openPdf(page, 'files.pdf', await withEmbedded([{ name: 'a.txt', bytes: utf8('hello') }]));
  const panel = await openProperties(page);
  const picker = section(panel, 'Attachments').locator('input[type="file"]');
  await expect(attachmentRow(panel, 'a.txt')).toBeVisible();

  // Nothing picked, nothing written.
  await picker.setInputFiles([]);
  await expect(attachmentRow(panel, 'a.txt')).toBeVisible();
  await expect(section(panel, 'Attachments').getByRole('listitem')).toHaveCount(1);
  await expect(announcement(panel)).toHaveText('');

  await picker.setInputFiles([
    { name: 'şube.txt', mimeType: 'text/plain', buffer: Buffer.from('merhaba') },
    { name: 'data.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2, 3]) },
  ]);
  await expect(attachmentRow(panel, 'şube.txt')).toBeVisible({ timeout: 60_000 });
  await expect(attachmentRow(panel, 'data.bin')).toBeVisible();
  await expect(announcement(panel)).toHaveText('Attachment list updated: 3');
  expect((await readProducedPdf(await exportBytes(page, 'added.pdf'))).attachmentNames).toEqual([
    'a.txt',
    'data.bin',
    'şube.txt',
  ]);

  await attachmentRow(panel, 'a.txt').getByRole('button', { name: 'Remove attachment a.txt' }).click();
  await expect(attachmentRow(panel, 'a.txt')).toHaveCount(0, { timeout: 60_000 });
  await expect(announcement(panel)).toHaveText('Attachment list updated: 2');
  expect((await readProducedPdf(await exportBytes(page, 'removed.pdf'))).attachmentNames).toEqual([
    'data.bin',
    'şube.txt',
  ]);
});

test('security: a document with no restriction says so, and an owner-protected one lists what it grants', async ({
  page,
}) => {
  await openPdf(page, 'plain.pdf');
  const plain = section(await openProperties(page), 'Security');
  await expect(plain).toContainText('Unencrypted');
  await expect(plain.getByRole('listitem')).toHaveCount(8);
  await expect(plain).not.toContainText('Encrypted');

  // Everything but printing and accessibility is withheld.
  await openPdf(page, 'limited.pdf', await ownerProtected(-3904 | 0x4 | 0x200));
  const limited = section(await openProperties(page), 'Security');
  await expect(limited).toContainText('Encrypted');
  await expect(limited.getByRole('listitem')).toHaveText(['print', 'accessibility']);
  await expect(limited.getByText(/./).last()).toBeVisible();

  // Nothing granted at all.
  await openPdf(page, 'locked.pdf', await ownerProtected(-3904));
  const locked = section(await openProperties(page), 'Security');
  await expect(locked).toContainText('Encrypted');
  await expect(locked.getByText('No restrictions declared.')).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * Digital signatures
 * ------------------------------------------------------------------ */

const SIGNATURES = 'Digital signatures';

/** The signature rows the panel lists (not the revocation lines nested in them). */
const signatureRows = (page: Page): Locator =>
  page.getByRole('list', { name: SIGNATURES }).locator(':scope > li');

/** The answer a signature row gives to one of its four or five questions. */
const fact = (row: Locator, label: string): Locator =>
  row.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');

/** An instant as the panel writes it. */
const utc = (date: Date): string => `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
const day = (date: Date): string => date.toISOString().slice(0, 10);

const REASON_VALID =
  'Digest of covered bytes matches messageDigest in CMS structure and signature was verified with public key.';

/** Open a document and its panel, and wait for the signature rows. */
async function openSigned(page: Page, bytes: Uint8Array, rows = 1): Promise<Locator> {
  await openPdf(page, 'signed.pdf', bytes);
  await openProperties(page);
  await expect(signatureRows(page)).toHaveCount(rows);
  return signatureRows(page).first();
}

test('a signature is described by integrity, trust, revocation and coverage, each with its own words', async ({
  page,
}) => {
  const { root, leaf } = await signingPki();
  const signedAt = fromNow(-100);
  const row = await openSigned(page, await signedDocument(cmsBy(leaf, [root], signedAt)));
  await expect(row).toContainText('Sig1');
  await expect(row).toContainText('adbe.pkcs7.detached');
  await expect(row).toContainText('Signer: Panel Signer · Signed date: 2026-06-01T12:00:00Z');
  await expect(fact(row, 'Cryptographic integrity')).toHaveText('Valid');
  await expect(fact(row, 'Certificate trust')).toHaveText('Not checked');
  await expect(fact(row, 'Revocation status')).toHaveText('Indeterminate');
  await expect(fact(row, 'Modifications after signing')).toHaveText('Covers whole document');
  await expect(row.getByText('Timestamp', { exact: true })).toHaveCount(0);
  await expect(
    row.getByRole('list', { name: 'Certificate revocation details' }).getByRole('listitem'),
  ).toHaveText(['Signer certificate “Panel Signer”: unknown — no CRL or OCSP response for this issuer.']);
  await expect(row).toContainText(`Judged at: ${utc(signedAt)} — time claimed by the signer, not proven.`);
  await expect(row).toContainText('No trust root has been imported, so there is nothing to compare against.');
  // One name in the path is no chain to show.
  await expect(row).not.toContainText('Chain:');
  await expect(row).toContainText(`Certificate valid until: ${day(leaf.parsed.notAfter.value)}`);
  await expect(row).toContainText('No incremental updates after signing');
  await expect(row).toContainText(REASON_VALID);
});

test('revisions after the signature are counted and the range reads as partial', async ({ page }) => {
  const { root, leaf } = await signingPki();
  const row = await openSigned(
    page,
    await signedDocument(cmsBy(leaf, [root], fromNow(-100)), { revisions: 2 }),
  );
  await expect(fact(row, 'Modifications after signing')).toHaveText('Covers partial document');
  await expect(row).toContainText('2 incremental update(s) after signing');
});

test('a signature with no name, no date and no readable certificate says what it could not read', async ({
  page,
}) => {
  const row = await openSigned(
    page,
    await signedDocument(() => Uint8Array.of(1, 2, 3), { fieldName: null, date: null, subFilter: null }),
  );
  await expect(row).toContainText('Unnamed signature');
  await expect(row).toContainText('Signer: could not read from certificate · Signed date: unspecified');
  await expect(fact(row, 'Cryptographic integrity')).toHaveText('Not checked');
  await expect(fact(row, 'Certificate trust')).toHaveText('Not checked');
  await expect(row).not.toContainText('adbe.pkcs7.detached');
  await expect(row).not.toContainText('Certificate valid until');
});

test('a certificate that has expired is called expired', async ({ page }) => {
  const { root, expiredLeaf } = await signingPki();
  const row = await openSigned(page, await signedDocument(cmsBy(expiredLeaf, [root], fromNow(-100))));
  await expect(row).toContainText(`Certificate expired on ${day(expiredLeaf.parsed.notAfter.value)}.`);
  await expect(row).not.toContainText('Certificate valid until');
});

/** Open a signed document, import the root through the panel and wait for the verdict that follows. */
async function openTrusted(page: Page, bytes: Uint8Array): Promise<Locator> {
  const { root } = await signingPki();
  const row = await openSigned(page, bytes);
  await importRootFiles(page, [{ name: 'root.cer', buffer: Buffer.from(root.der) }]);
  await expect(fact(row, 'Certificate trust')).toHaveText('Verified with imported root');
  return row;
}

test('an imported root makes the chain trusted, is kept across sessions, and is taken back with Remove', async ({
  page,
}) => {
  const { root, leaf } = await signingPki();
  const bytes = await signedDocument(cmsBy(leaf, [root], fromNow(-100)));
  const row = await openSigned(page, bytes);
  await expect(
    page.getByText('No trust roots imported yet; certificate trust is therefore shown as "not checked".'),
  ).toBeVisible();

  await importRootFiles(page, [{ name: 'root.cer', buffer: Buffer.from(root.der) }]);
  await expect(fact(row, 'Certificate trust')).toHaveText('Verified with imported root');
  await expect(row).toContainText('Chain: Panel Signer → Panel Root CA');
  await expect(row).not.toContainText('No trust root has been imported');
  await expect(page.getByText('Panel Root CA', { exact: true })).toBeVisible();
  await expect(page.getByText('No trust roots imported yet')).toHaveCount(0);

  // Stored: a new session of the editor still has it.
  const again = await openSigned(page, bytes);
  await expect(page.getByText('Panel Root CA', { exact: true })).toBeVisible();
  await expect(fact(again, 'Certificate trust')).toHaveText('Verified with imported root');

  await page
    .getByText('Panel Root CA', { exact: true })
    .locator('xpath=..')
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByText('No trust roots imported yet')).toBeVisible();
  await expect(fact(again, 'Certificate trust')).toHaveText('Not checked');
  const afterRemoval = await openSigned(page, bytes);
  await expect(fact(afterRemoval, 'Certificate trust')).toHaveText('Not checked');
  await expect(page.getByText('No trust roots imported yet')).toBeVisible();
});

test('a root that is not the signer’s issuer leaves the chain untrusted, with the reason', async ({
  page,
}) => {
  const { root, leaf, stranger } = await signingPki();
  const row = await openSigned(page, await signedDocument(cmsBy(leaf, [root], fromNow(-100))));
  await importRootFiles(page, [
    { name: 'stranger.pem', buffer: Buffer.from(pem('CERTIFICATE', stranger.der)) },
  ]);
  await expect(
    page.getByText('Panel Stranger CA', { exact: true }).or(page.getByText('Stranger CA', { exact: true })),
  ).toBeVisible();
  await expect(fact(row, 'Certificate trust')).toHaveText('Chain did not reach an imported root');
  await expect(row).toContainText('No certificate in the pool names itself the issuer of this one.');
});

test('certificate files that hold no certificate are refused, by name and by count', async ({ page }) => {
  const { root, leaf } = await signingPki();
  await openSigned(page, await signedDocument(cmsBy(leaf, [root], fromNow(-100))));
  const roots = page.locator('input[type="file"][accept*=".crt"]');
  const refusal = (text: string) => page.getByText(text, { exact: true });

  await importRootFiles(page, [{ name: 'notes.txt', buffer: Buffer.from('not a certificate') }]);
  await expect(refusal('No readable certificate found in selected files.')).toBeVisible();
  await expect(page.getByText('No trust roots imported yet')).toBeVisible();

  // Empty, DER-shaped but undecodable, and one real certificate in PEM.
  await importRootFiles(page, [
    { name: 'empty.cer', buffer: Buffer.alloc(0) },
    { name: 'broken.der', buffer: Buffer.from([0x30, 0x03, 0x01, 0x02, 0x03]) },
    { name: 'root.pem', buffer: Buffer.from(pem('CERTIFICATE', root.der)) },
  ]);
  await expect(refusal('1 trust root(s) added; 2 file(s) could not be read as certificate.')).toBeVisible();
  await expect(page.getByText('Panel Root CA', { exact: true })).toBeVisible();

  // A cancelled picker changes nothing; a clean import clears the line.
  await roots.setInputFiles([]);
  await expect(refusal('1 trust root(s) added; 2 file(s) could not be read as certificate.')).toBeVisible();
  await importRootFiles(page, [{ name: 'root.cer', buffer: Buffer.from(root.der) }]);
  await expect(page.getByText(/could not be read as certificate/)).toHaveCount(0);
});

const revocationLines = (row: Locator): Locator =>
  row.getByRole('list', { name: 'Certificate revocation details' }).getByRole('listitem');

test('a CRL archived in the file that names the signer decides the revocation line, and when it was made decides the note', async ({
  page,
}) => {
  const { root, leaf } = await signingPki();
  const signedAt = fromNow(-100);
  const signed = (crl: Uint8Array) => signedDocument(cmsBy(leaf, [root], signedAt), dssWithCrls([crl]));

  // Revoked before the signature was made.
  const before = fromNow(-150);
  let row = await openTrusted(
    page,
    await signed(await crlBy(root, fromNow(-50), fromNow(30), [{ cert: leaf, at: before }])),
  );
  await expect(fact(row, 'Revocation status')).toHaveText('Revoked');
  await expect(revocationLines(row)).toContainText([
    `Signer certificate “Panel Signer”: revoked on ${utc(before)} (key compromise).`,
  ]);
  await expect(revocationLines(row)).toContainText([
    'The revocation is dated at or before the signing time: the signature was made after it.',
  ]);
  await expect(row).toContainText(`Judged at: ${utc(signedAt)} — time claimed by the signer, not proven.`);

  // Revoked after a time the signer only claims: still treated as revoked.
  const after = fromNow(-50);
  row = await openTrusted(
    page,
    await signed(await crlBy(root, fromNow(-20), fromNow(30), [{ cert: leaf, at: after }])),
  );
  await expect(fact(row, 'Revocation status')).toHaveText('Revoked');
  await expect(revocationLines(row)).toContainText([`revoked on ${utc(after)} (key compromise).`]);
  await expect(revocationLines(row)).toContainText([
    'The revocation is dated after the time the signer claims, but that time is not proven: treat it as revoked.',
  ]);
});

test('a CRL that does not name the signer clears it, and an old one says it cannot rule out more', async ({
  page,
}) => {
  const { root, leaf } = await signingPki();
  const signed = (crl: Uint8Array) => signedDocument(cmsBy(leaf, [root], fromNow(-100)), dssWithCrls([crl]));

  const issued = fromNow(-50);
  let row = await openTrusted(page, await signed(await crlBy(root, issued, fromNow(30))));
  await expect(fact(row, 'Revocation status')).toHaveText('Not revoked');
  await expect(revocationLines(row)).toHaveText([
    `Signer certificate “Panel Signer”: not revoked (CRL embedded in the PDF, ${utc(issued)}).`,
  ]);

  // Issued before the signature and past its next update: two reasons not to rely on it.
  const old = fromNow(-300);
  const lapsed = fromNow(-5);
  row = await openTrusted(page, await signed(await crlBy(root, old, lapsed)));
  await expect(fact(row, 'Revocation status')).toHaveText(
    'Not listed as revoked, but the lists are too old to rule it out',
  );
  await expect(revocationLines(row)).toContainText([`not revoked (CRL embedded in the PDF, ${utc(old)}).`]);
  await expect(revocationLines(row)).toContainText([
    'The list was issued before the signature, so it cannot rule out a later revocation.',
  ]);
  await expect(revocationLines(row)).toContainText([
    `The list is past its next-update date (${utc(lapsed)}).`,
  ]);
});

test('a trusted timestamp is the time a signature is judged at, and shows its authority and the revocation of both certificates', async ({
  page,
}) => {
  const { root, leaf, tsa } = await signingPki();
  const issued = fromNow(-100);
  const revokedAt = fromNow(-50);
  const crl = await crlBy(root, fromNow(-20), fromNow(30), [{ cert: leaf, at: revokedAt }]);
  const row = await openTrusted(
    page,
    await signedDocument(cmsWithTimestamp(leaf, [root], issued, tsa, issued), dssWithCrls([crl])),
  );
  await expect(fact(row, 'Revocation status')).toHaveText('Revoked after signing');
  await expect(fact(row, 'Timestamp')).toHaveText('Valid');
  await expect(row).toContainText(`Signature timestamp: ${utc(issued)}, issued by Panel TSA (SHA-256).`);
  await expect(row).toContainText(
    'The time-stamping authority chains to an imported root and none of its certificates is revoked: its time was used to judge this signature.',
  );
  await expect(row).toContainText(`Judged at: ${utc(issued)} — trusted timestamp.`);
  // The authority's own certificate is checked against the same list; the signer's revocation is
  // dated after the timestamp, so the certificate was good when the signature was made.
  await expect(row.getByText(/Timestamp authority certificate “Panel TSA”: not revoked/)).toBeVisible();
  await expect(row).toContainText(`revoked on ${utc(revokedAt)} (key compromise).`);
  await expect(row).toContainText(
    'The revocation is dated after the trusted timestamp: the certificate was good when the signature was made.',
  );
});

test('a certificate that expired after a trusted timestamp is said to have been valid at it', async ({
  page,
}) => {
  const { root, expiredLeaf, tsa } = await signingPki();
  const issued = fromNow(-100);
  const row = await openTrusted(
    page,
    await signedDocument(cmsWithTimestamp(expiredLeaf, [root], issued, tsa, issued)),
  );
  await expect(row).toContainText(
    `The certificate expired on ${day(expiredLeaf.parsed.notAfter.value)}, but it was valid when the trusted timestamp was issued.`,
  );
});

test('an authority that chains to no imported root has its time shown but not relied on', async ({
  page,
}) => {
  const { root, leaf, tsa } = await signingPki();
  const issued = fromNow(-100);
  const row = await openSigned(
    page,
    await signedDocument(cmsWithTimestamp(leaf, [root], issued, tsa, issued)),
  );
  await expect(fact(row, 'Timestamp')).toHaveText('Valid');
  await expect(row).toContainText(
    'The time-stamping authority does not chain to an imported root, or one of its certificates is revoked: the time is shown but not relied on, since anyone can run a timestamp server.',
  );
  await expect(row).toContainText(`Judged at: ${utc(issued)} — untrusted timestamp.`);
});

test('a document timestamp is a signature of its own; one over other bytes is invalid, with the cause', async ({
  page,
}) => {
  const { tsa } = await signingPki();
  const genTime = fromNow(-10);
  const stamp = (covered: Uint8Array) => issueTimestampToken({ tsa, covered, genTime });
  let row = await openTrusted(page, await signedDocument(stamp, { subFilter: 'ETSI.RFC3161' }));
  await expect(row).toContainText('ETSI.RFC3161');
  await expect(row).toContainText('Signer: Panel TSA');
  await expect(fact(row, 'Timestamp')).toHaveText('Valid');
  await expect(row).toContainText(`Document timestamp: ${utc(genTime)}, issued by Panel TSA (SHA-256).`);
  await expect(row).toContainText('Chain: Panel TSA → Panel Root CA');
  await expect(row).toContainText(
    'The timestamp token is valid: its hash, its signature and the authority certificate were verified.',
  );
  // A document timestamp has no revocation list of its own to show beside the signer's.
  await expect(row.getByText(/Timestamp authority certificate/)).toHaveCount(1);

  row = await openSigned(
    page,
    await signedDocument((covered) => stamp(covered.slice(1)), { subFilter: 'ETSI.RFC3161' }),
  );
  await expect(fact(row, 'Cryptographic integrity')).toHaveText('Invalid');
  await expect(fact(row, 'Timestamp')).toHaveText('Invalid');
  await expect(row).toContainText(
    'The hash in the token does not match the data it should stamp: the data may have changed after the timestamp.',
  );
  await expect(row).toContainText("— today's date.");
  await expect(row).toContainText('issued by unknown (SHA-256).');
});

const crlList = (page: Page): Locator =>
  page.getByRole('list', { name: 'Imported revocation lists (CRL)' }).getByRole('listitem');

test('imported CRLs are listed with their dates and kind, decide the signer’s revocation, are kept, and are removed one by one', async ({
  page,
}) => {
  const { root, leaf } = await signingPki();
  const signedAt = fromNow(-100);
  const bytes = await signedDocument(cmsBy(leaf, [root], signedAt));
  const row = await openTrusted(page, bytes);
  await expect(
    page.getByText('No CRL imported yet; revocation is read only from lists embedded in the PDF.'),
  ).toBeVisible();

  const revokedAt = fromNow(-150);
  const issued = fromNow(-50);
  const next = fromNow(30);
  const full = await crlBy(root, issued, next, [{ cert: leaf, at: revokedAt }]);
  const delta = await crlBy(root, fromNow(-40), undefined, [], { delta: true });
  const lapsed = await crlBy(root, fromNow(-300), fromNow(-5));
  // One PEM file holds two lists; the third is a binary DER file.
  await importCrlFiles(page, [
    { name: 'lists.pem', buffer: Buffer.from(pem('X509 CRL', full) + pem('X509 CRL', delta)) },
    { name: 'old.crl', buffer: Buffer.from(lapsed) },
  ]);
  await expect(crlList(page)).toHaveCount(3);
  await expect(crlList(page).nth(0)).toContainText(
    `Panel Root CA · issued ${day(issued)} · next ${day(next)} · 1 revoked`,
  );
  await expect(crlList(page).nth(0)).not.toContainText('delta CRL');
  await expect(crlList(page).nth(1)).toContainText(
    `issued ${day(fromNow(-40))} · next not stated · 0 revoked · delta CRL`,
  );
  await expect(crlList(page).nth(2)).toContainText(
    `issued ${day(fromNow(-300))} · next ${day(fromNow(-5))} · 0 revoked`,
  );
  await expect(crlList(page).nth(2)).toContainText('past its next update');
  await expect(crlList(page).nth(0)).not.toContainText('past its next update');

  await expect(fact(row, 'Revocation status')).toHaveText('Revoked');
  await expect(revocationLines(row)).toContainText([`revoked on ${utc(revokedAt)} (key compromise).`]);
  await expect(revocationLines(row)).toContainText([
    'The revocation is dated at or before the signing time: the signature was made after it.',
  ]);

  // Stored: a new session still lists all three.
  const again = await openSigned(page, bytes);
  await expect(crlList(page)).toHaveCount(3);
  await expect(fact(again, 'Revocation status')).toHaveText('Revoked');

  // Taking back the list that names the signer clears the verdict; the others stay.
  await page.getByRole('button', { name: 'Remove CRL Panel Root CA' }).first().click();
  await expect(crlList(page)).toHaveCount(2);
  await expect(fact(again, 'Revocation status')).not.toHaveText('Revoked');
  await expect(crlList(page).nth(0)).toContainText('delta CRL');
  await page.getByRole('button', { name: 'Remove CRL Panel Root CA' }).first().click();
  await page.getByRole('button', { name: 'Remove CRL Panel Root CA' }).first().click();
  await expect(page.getByText('No CRL imported yet')).toBeVisible();
  await expect(fact(again, 'Revocation status')).toHaveText('Indeterminate');
  await openSigned(page, bytes);
  await expect(page.getByText('No CRL imported yet')).toBeVisible();
});

test('files that hold no CRL are refused and counted', async ({ page }) => {
  const { root, leaf } = await signingPki();
  await openSigned(page, await signedDocument(cmsBy(leaf, [root], fromNow(-100))));
  const crls = page.locator('input[type="file"][accept*=".crl"]');
  const line = (text: string) => page.getByText(text, { exact: true });

  await importCrlFiles(page, [
    { name: 'notes.txt', buffer: Buffer.from('nothing here') },
    { name: 'blank.pem', buffer: Buffer.from('-----BEGIN X509 CRL-----\n-----END X509 CRL-----\n') },
  ]);
  await expect(line('No readable CRL found in the selected files (DER or PEM expected).')).toBeVisible();
  await expect(page.getByText('No CRL imported yet')).toBeVisible();

  const good = await crlBy(root, fromNow(-50), fromNow(30));
  await importCrlFiles(page, [
    { name: 'good.crl', buffer: Buffer.from(good) },
    { name: 'junk.crl', buffer: Buffer.from('junk') },
  ]);
  await expect(line('1 CRL(s) added; 1 file(s) could not be read as a CRL.')).toBeVisible();
  await expect(crlList(page)).toHaveCount(1);

  await crls.setInputFiles([]);
  await expect(crlList(page)).toHaveCount(1);
  await expect(line('1 CRL(s) added; 1 file(s) could not be read as a CRL.')).toBeVisible();
  await importCrlFiles(page, [{ name: 'good.crl', buffer: Buffer.from(good) }]);
  await expect(page.getByText(/could not be read as a CRL/)).toHaveCount(0);
});

test('signing the open document adds a row that says self-signed', async ({ page }) => {
  await openPdf(page, 'sign.pdf');
  await openProperties(page);
  await expect(signatureRows(page)).toHaveCount(0);
  await expect(page.getByText('No signature fields in document.')).toBeVisible();

  const container = makeSignerContainer(test.info().outputPath('signer'));
  await page.getByRole('menuitem', { name: 'Tools', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign document' }).click();
  const form = page.getByRole('region', { name: /Sign Document/ });
  await form.locator('input[type="file"]').setInputFiles(container);
  await form.getByRole('textbox', { name: 'PKCS#12 password' }).fill(SIGNER.password);
  await form.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(notice(page, `Signature applied (${SIGNER.commonName})`)).toBeVisible({ timeout: 60_000 });

  // The signing form took the dock's place; the panel reads the signed file when it is back.
  await openProperties(page);
  await expect(signatureRows(page)).toHaveCount(1, { timeout: 30_000 });
  const row = signatureRows(page).first();
  await expect(row).toContainText(`Signer: ${SIGNER.commonName}`);
  await expect(fact(row, 'Cryptographic integrity')).toHaveText('Valid');
  await expect(fact(row, 'Certificate trust')).toHaveText('Self-signed');
  await expect(fact(row, 'Modifications after signing')).toHaveText('Covers whole document');
});

test('opening a signed document while the panel is shown announces the new signature list', async ({
  page,
}) => {
  const { root, leaf } = await signingPki();
  await openPdf(page, 'plain.pdf');
  const panel = await openProperties(page);
  await expect(signatureRows(page)).toHaveCount(0);
  await openPdf(page, 'signed.pdf', await signedDocument(cmsBy(leaf, [root], fromNow(-100))), {
    navigate: false,
    advanced: false,
  });
  await expect(signatureRows(page)).toHaveCount(1);
  await expect(announcement(panel)).toHaveText('Signature list updated: 1');
});
