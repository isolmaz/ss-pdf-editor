// @vitest-environment happy-dom
/**
 * The document properties panel: fonts, attachments and their controls, the security summary,
 * and every signature with its integrity, trust, revocation, timestamp and coverage stated
 * apart, each with its own sentence. Trust roots and revocation lists are imported through real
 * certificate and CRL files; the list changes are announced once, weightiest change first.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfFontInfo } from 'pdf-core/ops/pdf-fonts';
import type {
  RevocationCertCheck,
  SignatureVerification,
  TimestampCheck,
} from 'pdf-core/ops/signature-status';
import type { RevocationList } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueCrl } from '../../../pdf-core/src/signature-revocation.fixtures';
import { generateKey, issueCertificate } from '../../../pdf-core/src/signature-trust.fixtures';
import { PropertiesPanel, type PropertiesPanelProps } from './PropertiesPanel';

afterEach(cleanup);

const t = createTranslator('en');

const font = (overrides: Partial<PdfFontInfo> = {}): PdfFontInfo => ({
  baseFont: 'Helvetica',
  subtype: 'Type1',
  embedded: true,
  encoding: 'WinAnsiEncoding',
  subset: false,
  pages: [0, 1],
  ...overrides,
});

const check = (overrides: Partial<RevocationCertCheck> = {}): RevocationCertCheck => ({
  role: 'signer',
  subject: 'Alice',
  status: 'good',
  source: 'crl',
  origin: 'imported',
  thisUpdate: '2026-06-01T08:30:00.000Z',
  nextUpdate: null,
  coversValidationTime: true,
  stale: false,
  revokedAt: null,
  reason: null,
  timing: null,
  unknownReason: null,
  ...overrides,
});

const stamp = (overrides: Partial<TimestampCheck> = {}): TimestampCheck => ({
  kind: 'signature',
  status: 'valid',
  reason: null,
  genTime: '2026-05-01T10:00:00.000Z',
  tsa: 'Test TSA',
  hashAlgorithm: 'SHA-256',
  tsaTrust: 'trusted',
  tsaTrustReason: null,
  tsaPath: [],
  tsaNotBefore: null,
  tsaNotAfter: null,
  tsaSelfSigned: false,
  tsaRevocation: [],
  trusted: true,
  ...overrides,
});

const signature = (overrides: Partial<SignatureVerification> = {}): SignatureVerification => ({
  fieldName: 'Sig1',
  subFilter: 'adbe.pkcs7.detached',
  signer: 'Alice',
  signedAt: '2026-05-01',
  integrity: 'valid',
  trust: 'trusted',
  revocation: 'not-revoked',
  coverage: 'covers-whole-document',
  changesAfterSigning: 0,
  trustPath: [],
  certificateValidity: 'valid',
  certificateNotBefore: null,
  certificateNotAfter: '2099-01-01T00:00:00.000Z',
  trustReason: null,
  reasonKey: 'props.sig.reason.valid',
  timestamp: null,
  revocationChecks: [],
  validationTime: null,
  validationTimeSource: 'clock',
  ...overrides,
});

const baseProps: PropertiesPanelProps = {
  t,
  fonts: [],
  attachments: [],
  signatures: [],
  security: null,
};

const show = (props: Partial<PropertiesPanelProps> = {}) =>
  render(<PropertiesPanel {...baseProps} {...props} />);

const regionOf = (name: string) => screen.getByRole('region', { name });
const rowOf = (fieldName: string) => screen.getByText(fieldName).closest('li') as HTMLElement;
const liveRegion = (container: HTMLElement) => container.querySelector('[aria-live="polite"]');

describe('PropertiesPanel while loading', () => {
  it('shows only the skeleton', () => {
    const { container } = show({ loading: true, fonts: [font()] });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('region', { name: t('props.title') })).toBeNull();
    expect(screen.queryByText('Helvetica')).toBeNull();
  });
});

describe('PropertiesPanel fonts', () => {
  it('says when the font list is not read yet or empty', () => {
    const { rerender } = show({ fonts: null });
    expect(within(regionOf('Fonts')).getByText('No font resources found in document.')).toBeTruthy();
    rerender(<PropertiesPanel {...baseProps} fonts={[]} />);
    expect(within(regionOf('Fonts')).getByText('No font resources found in document.')).toBeTruthy();
  });

  it('lists each font with its subtype, pages, embedding, subset flag and encoding', () => {
    show({
      fonts: [
        font(),
        font({ baseFont: 'ABCDEF+Garamond', subtype: 'TrueType', subset: true, pages: [3], encoding: null }),
        font({ baseFont: '', subtype: 'Type3', embedded: false, pages: [], encoding: 'Identity-H' }),
      ],
    });
    const [helvetica, garamond, unnamed] = within(screen.getByRole('list', { name: 'Fonts' })).getAllByRole(
      'listitem',
    );

    expect(helvetica?.textContent).toBe('HelveticaType12 page(s)EmbeddedEncoding: WinAnsiEncoding');
    expect(garamond?.textContent).toBe('ABCDEF+GaramondTrueType1 page(s)EmbeddedSubset');
    expect(unnamed?.textContent).toBe('Type3Type30 page(s)Not embeddedEncoding: Identity-H');
    expect(within(helvetica as HTMLElement).getByText('Embedded').className).toContain('text-kumo-success');
    expect(within(unnamed as HTMLElement).getByText('Not embedded').className).toContain('text-kumo-warning');
  });
});

describe('PropertiesPanel attachments', () => {
  it('says when there are none', () => {
    show();
    expect(within(regionOf('Attachments')).getByText('No attachments in document.')).toBeTruthy();
  });

  it('lists each attachment with its size and description, and says when the size cannot be read', () => {
    show({
      attachments: [
        { name: 'report.txt', description: '', size: 1024 },
        { name: 'notes.txt', description: 'Meeting notes', size: 12 },
        { name: 'broken.bin', description: '', size: null },
      ],
    });
    const [report, notes, broken] = within(screen.getByRole('list', { name: 'Attachments' })).getAllByRole(
      'listitem',
    );
    expect(report?.textContent).toBe('report.txt1,024 byteOpenRemove');
    expect(notes?.textContent).toBe('notes.txt12 byte · Meeting notesOpenRemove');
    expect(broken?.textContent).toBe('broken.binSize unreadableOpenRemove');
  });

  it('opens or removes the attachment the row names', async () => {
    const onReadAttachment = vi.fn();
    const onRemoveAttachment = vi.fn();
    show({
      attachments: [
        { name: 'a.txt', description: '', size: 1 },
        { name: 'b.txt', description: '', size: 2 },
      ],
      onReadAttachment,
      onRemoveAttachment,
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open attachment b.txt' }));
    await user.click(screen.getByRole('button', { name: 'Remove attachment a.txt' }));
    expect(onReadAttachment).toHaveBeenCalledExactlyOnceWith('b.txt');
    expect(onRemoveAttachment).toHaveBeenCalledExactlyOnceWith('a.txt');
  });

  it('disables every attachment control when the host is busy or gave no handler', () => {
    const { rerender } = show({
      attachments: [{ name: 'a.txt', description: '', size: 1 }],
      disabled: true,
      onAddAttachments: () => {},
      onReadAttachment: () => {},
      onRemoveAttachment: () => {},
    });
    const controls = () => [
      screen.getByRole('button', { name: 'Add file' }),
      screen.getByRole('button', { name: 'Open attachment a.txt' }),
      screen.getByRole('button', { name: 'Remove attachment a.txt' }),
    ];
    expect(controls().map((button) => button.hasAttribute('disabled'))).toEqual([true, true, true]);

    rerender(<PropertiesPanel {...baseProps} attachments={[{ name: 'a.txt', description: '', size: 1 }]} />);
    expect(controls().map((button) => button.hasAttribute('disabled'))).toEqual([true, true, true]);

    rerender(
      <PropertiesPanel
        {...baseProps}
        attachments={[{ name: 'a.txt', description: '', size: 1 }]}
        onAddAttachments={() => {}}
        onReadAttachment={() => {}}
        onRemoveAttachment={() => {}}
      />,
    );
    expect(controls().map((button) => button.hasAttribute('disabled'))).toEqual([false, false, false]);
  });

  const attachmentPicker = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>(
      'input[type="file"][multiple][tabindex="-1"]',
    ) as HTMLInputElement;

  it('opens the file picker from "Add file"', async () => {
    const { container } = show({ onAddAttachments: () => {} });
    const opened = vi.fn();
    attachmentPicker(container).addEventListener('click', opened);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add file' }));
    expect(opened).toHaveBeenCalledOnce();
  });

  it('hands the picked files to the host, and nothing when the picker closes empty', async () => {
    const onAddAttachments = vi.fn();
    const { container } = show({ onAddAttachments });
    const one = new File(['one'], 'one.txt', { type: 'text/plain' });
    const two = new File(['two'], 'two.txt', { type: 'text/plain' });
    await userEvent.setup().upload(attachmentPicker(container), [one, two]);
    expect(onAddAttachments).toHaveBeenCalledExactlyOnceWith([one, two]);

    fireEvent.change(attachmentPicker(container), { target: { files: [] } });
    expect(onAddAttachments).toHaveBeenCalledOnce();
  });

  it('takes a pick without a handler as nothing to do', () => {
    const { container } = show();
    fireEvent.change(attachmentPicker(container), {
      target: { files: [new File(['one'], 'one.txt', { type: 'text/plain' })] },
    });
    expect(screen.getByText('No attachments in document.')).toBeTruthy();
  });
});

describe('PropertiesPanel security', () => {
  it('says the security information could not be read', () => {
    show({ security: null });
    expect(within(regionOf('Security')).getByText('Security information could not be read.')).toBeTruthy();
  });

  it('shows an encrypted document with its permissions and the note', () => {
    show({ security: { encrypted: true, permissions: ['Printing', 'Copying'] } });
    const region = regionOf('Security');
    expect(within(region).getByText('Encrypted').className).toContain('text-kumo-success');
    expect(
      within(region)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Printing', 'Copying']);
    expect(within(region).getByText(t('props.security.note'))).toBeTruthy();
  });

  it('shows an unencrypted document without restrictions and without the note', () => {
    show({ security: { encrypted: false, permissions: [] } });
    const region = regionOf('Security');
    expect(within(region).getByText('Unencrypted').className).toContain('text-kumo-subtle');
    expect(within(region).getByText('No restrictions declared.')).toBeTruthy();
    expect(within(region).queryByText(t('props.security.note'))).toBeNull();
  });
});

describe('PropertiesPanel signatures', () => {
  it('says when there are no signature fields', () => {
    show();
    expect(within(regionOf('Digital signatures')).getByText('No signature fields in document.')).toBeTruthy();
  });

  it('states integrity, trust, revocation and coverage apart, with the signer and the reason', () => {
    show({
      signatures: [
        signature({
          signedAt: null,
          signer: null,
          integrity: 'invalid',
          trust: 'self-signed',
          revocation: 'partial',
          coverage: 'covers-partial',
          changesAfterSigning: 2,
          trustReason: 'no-roots',
          reasonKey: 'props.sig.reason.invalid',
        }),
      ],
    });
    const row = rowOf('Sig1');
    const states = within(row)
      .getAllByRole('term')
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(states).toEqual([
      ['Cryptographic integrity', 'Invalid'],
      ['Certificate trust', 'Self-signed'],
      ['Revocation status', t('props.sig.revocation.partial')],
      ['Modifications after signing', 'Covers partial document'],
    ]);
    expect(within(row).getByText('adbe.pkcs7.detached')).toBeTruthy();
    expect(
      within(row).getByText('Signer: could not read from certificate · Signed date: unspecified'),
    ).toBeTruthy();
    expect(within(row).getByText(t('props.sig.trustReason.noRoots'))).toBeTruthy();
    expect(within(row).getByText('2 incremental update(s) after signing')).toBeTruthy();
    expect(within(row).getByText(t('props.sig.reason.invalid'))).toBeTruthy();
    expect(within(row).getByText('Invalid').className).toContain('text-kumo-danger');
  });

  it('names an unnamed field and an unspecified format, and shows a clean signature plainly', () => {
    show({ signatures: [signature({ fieldName: '', subFilter: '' })] });
    const row = screen.getByText('Unnamed signature').closest('li') as HTMLElement;
    expect(within(row).getByText('Signer: Alice · Signed date: 2026-05-01')).toBeTruthy();
    expect(within(row).getByText('No incremental updates after signing')).toBeTruthy();
    expect(within(row).getByText('Verified with imported root')).toBeTruthy();
    expect(within(row).getByText('Valid').className).toContain('text-kumo-success');
    expect(within(row).queryByText('adbe.pkcs7.detached')).toBeNull();
    expect(within(row).queryByText(/^Chain:/)).toBeNull();
    expect(within(row).queryByText(/Judged at/)).toBeNull();
    expect(within(row).queryByRole('list')).toBeNull();
  });

  it('shows the chain only when it has more than one certificate', () => {
    show({
      signatures: [
        signature({ fieldName: 'Single', trustPath: ['Root'] }),
        signature({ fieldName: 'Chained', trustPath: ['Alice', 'Issuing CA', 'Root'] }),
      ],
    });
    expect(within(rowOf('Single')).queryByText(/^Chain:/)).toBeNull();
    const chain = within(rowOf('Chained')).getByText('Chain: Alice → Issuing CA → Root');
    expect(chain.getAttribute('title')).toBe('Alice → Issuing CA → Root');
  });

  it('says what instant the signature is judged at, and on what authority', () => {
    show({
      signatures: [
        signature({ validationTime: '2026-05-01T10:00:00.123Z', validationTimeSource: 'signing-time' }),
      ],
    });
    expect(
      within(rowOf('Sig1')).getByText(
        'Judged at: 2026-05-01 10:00:00 UTC — time claimed by the signer, not proven.',
      ),
    ).toBeTruthy();
  });

  describe('certificate dates', () => {
    it('says a certificate that has expired, with the day it expired', () => {
      show({
        signatures: [
          signature({ certificateValidity: 'expired', certificateNotAfter: '2020-03-04T00:00:00.000Z' }),
        ],
      });
      const line = within(rowOf('Sig1')).getByText('Certificate expired on 2020-03-04.');
      expect(line.className).toContain('text-kumo-danger');
    });

    it('says a certificate that is not valid yet, with the day it starts', () => {
      show({
        signatures: [
          signature({
            certificateValidity: 'not-yet-valid',
            certificateNotBefore: '2090-07-08T00:00:00.000Z',
            certificateNotAfter: '2095-01-01T00:00:00.000Z',
          }),
        ],
      });
      expect(within(rowOf('Sig1')).getByText('Certificate is not valid until 2090-07-08.')).toBeTruthy();
    });

    it('says a certificate is valid until its last day', () => {
      show({ signatures: [signature({ certificateNotAfter: '2099-12-31T23:00:00.000Z' })] });
      expect(within(rowOf('Sig1')).getByText('Certificate valid until: 2099-12-31')).toBeTruthy();
    });

    it('says a certificate that has since expired was valid when a trusted timestamp was issued', () => {
      show({
        signatures: [
          signature({
            certificateNotAfter: '2021-02-03T00:00:00.000Z',
            validationTimeSource: 'timestamp',
          }),
        ],
      });
      expect(
        within(rowOf('Sig1')).getByText(t('props.sig.certValidAtTimestamp', { date: '2021-02-03' })),
      ).toBeTruthy();
    });

    it('does not make that claim for a timestamp-judged certificate that is still valid', () => {
      show({
        signatures: [
          signature({ certificateNotAfter: '2099-02-03T00:00:00.000Z', validationTimeSource: 'timestamp' }),
        ],
      });
      expect(within(rowOf('Sig1')).getByText('Certificate valid until: 2099-02-03')).toBeTruthy();
    });

    it('does not make that claim when the time is not a trusted timestamp', () => {
      show({
        signatures: [
          signature({
            certificateNotAfter: '2021-02-03T00:00:00.000Z',
            validationTimeSource: 'signing-time',
          }),
        ],
      });
      expect(within(rowOf('Sig1')).getByText('Certificate valid until: 2021-02-03')).toBeTruthy();
    });

    it('says nothing about dates the certificate did not carry', () => {
      show({ signatures: [signature({ certificateNotAfter: null })] });
      expect(within(rowOf('Sig1')).queryByText(/^Certificate (valid|expired|is not)/)).toBeNull();
    });
  });

  describe('timestamps', () => {
    it('states a valid trusted signature timestamp with who issued it and when', () => {
      show({ signatures: [signature({ timestamp: stamp() })] });
      const row = rowOf('Sig1');
      expect(within(row).getByText('Timestamp').nextElementSibling?.textContent).toBe('Valid');
      expect(
        within(row).getByText('Signature timestamp: 2026-05-01 10:00:00 UTC, issued by Test TSA (SHA-256).'),
      ).toBeTruthy();
      expect(within(row).getByText(t('props.sig.ts.trust.trusted'))).toBeTruthy();
    });

    it('says a valid timestamp is not relied on when its authority is not trusted', () => {
      show({ signatures: [signature({ timestamp: stamp({ trusted: false }) })] });
      expect(within(rowOf('Sig1')).getByText(t('props.sig.ts.trust.untrusted'))).toBeTruthy();
    });

    it('gives the reason an invalid timestamp failed, and no trust sentence', () => {
      show({
        signatures: [
          signature({
            timestamp: stamp({
              kind: 'document',
              status: 'invalid',
              reason: 'imprint-mismatch',
              tsa: null,
              hashAlgorithm: null,
              trusted: false,
            }),
          }),
        ],
      });
      const row = rowOf('Sig1');
      expect(within(row).getByText('Timestamp').nextElementSibling?.textContent).toBe('Invalid');
      expect(
        within(row).getByText('Document timestamp: 2026-05-01 10:00:00 UTC, issued by unknown (—).'),
      ).toBeTruthy();
      expect(within(row).getByText(t('props.sig.ts.reason.imprint-mismatch')).className).toContain(
        'text-kumo-danger',
      );
      expect(within(row).queryByText(t('props.sig.ts.trust.untrusted'))).toBeNull();
    });

    it('says nothing of a time the token never gave', () => {
      show({
        signatures: [signature({ timestamp: stamp({ status: 'unchecked', genTime: null, trusted: false }) })],
      });
      const row = rowOf('Sig1');
      expect(within(row).getByText('Timestamp').nextElementSibling?.textContent).toBe('Not checked');
      expect(within(row).queryByText(/issued by/)).toBeNull();
    });

    it("lists the timestamp authority's revocation answers for a signature timestamp", () => {
      show({
        signatures: [
          signature({
            timestamp: stamp({
              tsaRevocation: [check({ role: 'timestamp', subject: 'Test TSA' })],
            }),
          }),
        ],
      });
      const tsa = rowOf('Sig1').querySelector('[data-timestamp-status] [data-revocation-status]');
      expect(tsa?.textContent).toBe(
        'Timestamp authority certificate “Test TSA”: not revoked (imported CRL, 2026-06-01 08:30:00 UTC).',
      );
    });

    it('does not list revocation answers for a document timestamp', () => {
      show({
        signatures: [
          signature({
            timestamp: stamp({ kind: 'document', tsaRevocation: [check({ role: 'timestamp' })] }),
          }),
        ],
      });
      expect(rowOf('Sig1').querySelector('[data-revocation-status]')).toBeNull();
    });
  });

  describe('revocation details', () => {
    const lineOf = (status: string) =>
      rowOf('Sig1').querySelector(`[data-revocation-status="${status}"]`) as HTMLElement;

    it('describes a certificate cleared by a list, with where the list came from', () => {
      show({
        signatures: [
          signature({
            revocationChecks: [
              check(),
              check({ role: 'intermediate', subject: 'Issuing CA', source: 'ocsp', origin: 'embedded' }),
            ],
          }),
        ],
      });
      const list = within(rowOf('Sig1')).getByRole('list', { name: t('props.sig.rev.title') });
      expect(
        within(list)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        'Signer certificate “Alice”: not revoked (imported CRL, 2026-06-01 08:30:00 UTC).',
        'Intermediate certificate “Issuing CA”: not revoked (OCSP response embedded in the PDF, 2026-06-01 08:30:00 UTC).',
      ]);
    });

    it('says a cleared certificate has no date when the list gave none, and when the list predates the signature', () => {
      show({
        signatures: [
          signature({ revocationChecks: [check({ thisUpdate: null, coversValidationTime: false })] }),
        ],
      });
      expect(lineOf('good').textContent).toBe(
        `Signer certificate “Alice”: not revoked (imported CRL, —).${t('props.sig.rev.noteBefore')}`,
      );
    });

    it('notes a list that is past its next update, with the date', () => {
      show({
        signatures: [
          signature({ revocationChecks: [check({ stale: true, nextUpdate: '2026-07-01T00:00:00.000Z' })] }),
        ],
      });
      expect(
        within(lineOf('good')).getByText(t('props.sig.rev.noteStale', { date: '2026-07-01 00:00:00 UTC' })),
      ).toBeTruthy();
    });

    it('does not note a stale list that names no next update', () => {
      show({ signatures: [signature({ revocationChecks: [check({ stale: true, nextUpdate: null })] })] });
      expect(lineOf('good').children).toHaveLength(1);
    });

    it('does not note a list that is still current', () => {
      show({
        signatures: [
          signature({ revocationChecks: [check({ stale: false, nextUpdate: '2099-07-01T00:00:00.000Z' })] }),
        ],
      });
      expect(lineOf('good').children).toHaveLength(1);
    });

    it('describes a revoked certificate with its date and reason, in danger tone', () => {
      show({
        signatures: [
          signature({
            revocationChecks: [
              check({
                status: 'revoked',
                revokedAt: '2026-05-02T09:00:00.000Z',
                reason: 'keyCompromise',
                timing: 'before-signing',
                coversValidationTime: null,
              }),
            ],
          }),
        ],
      });
      const line = lineOf('revoked');
      expect(line.textContent).toBe(
        `Signer certificate “Alice”: revoked on 2026-05-02 09:00:00 UTC (key compromise).${t('props.sig.rev.timingBefore')}`,
      );
      expect(line.firstElementChild?.className).toContain('text-kumo-danger');
    });

    it('states a revocation after signing as harmless only against a trusted timestamp', () => {
      show({
        signatures: [
          signature({
            fieldName: 'Stamped',
            validationTimeSource: 'timestamp',
            revocationChecks: [
              check({ status: 'revoked', revokedAt: '2026-08-01T00:00:00.000Z', timing: 'after-signing' }),
            ],
          }),
          signature({
            fieldName: 'Claimed',
            validationTimeSource: 'signing-time',
            revocationChecks: [
              check({ status: 'revoked', revokedAt: '2026-08-01T00:00:00.000Z', timing: 'after-signing' }),
            ],
          }),
        ],
      });
      expect(within(rowOf('Stamped')).getByText(t('props.sig.rev.timingAfter'))).toBeTruthy();
      expect(within(rowOf('Claimed')).getByText(t('props.sig.rev.timingAfterClaimed'))).toBeTruthy();
    });

    it('describes a revoked certificate whose date and reason the list left out', () => {
      show({
        signatures: [
          signature({
            revocationChecks: [check({ status: 'revoked', revokedAt: null, reason: null, timing: null })],
          }),
        ],
      });
      expect(lineOf('revoked').textContent).toBe(
        'Signer certificate “Alice”: revoked on — (no reason given).',
      );
    });

    it('says why nothing is known about a certificate', () => {
      show({
        signatures: [
          signature({
            revocationChecks: [
              check({
                status: 'unknown',
                source: null,
                origin: null,
                thisUpdate: null,
                unknownReason: 'no-issuer',
              }),
              check({
                role: 'intermediate',
                subject: 'Issuing CA',
                status: 'unknown',
                source: null,
                origin: null,
                thisUpdate: null,
                unknownReason: null,
              }),
            ],
          }),
        ],
      });
      expect(
        within(rowOf('Sig1'))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        'Signer certificate “Alice”: unknown — the issuer certificate is not available.',
        'Intermediate certificate “Issuing CA”: unknown — no CRL or OCSP response for this issuer.',
      ]);
    });
  });
});

describe('PropertiesPanel trust roots', () => {
  it('says no root has been imported, and lists the ones that have, each with its own remove button', async () => {
    const { rerender } = show();
    expect(screen.getByText(t('props.sig.roots.empty'))).toBeTruthy();

    const onRemoveTrustRoot = vi.fn();
    rerender(
      <PropertiesPanel
        {...baseProps}
        trustRoots={[
          { id: 'root-a', label: 'Root A' },
          { id: 'root-b', label: 'Root B' },
        ]}
        onRemoveTrustRoot={onRemoveTrustRoot}
      />,
    );
    expect(screen.queryByText(t('props.sig.roots.empty'))).toBeNull();
    const root = screen.getByText('Root B');
    expect(root.getAttribute('title')).toBe('Root B');
    await userEvent
      .setup()
      .click(within(root.closest('li') as HTMLElement).getByRole('button', { name: 'Remove' }));
    expect(onRemoveTrustRoot).toHaveBeenCalledExactlyOnceWith('root-b');
  });

  it('removes nothing without a handler', async () => {
    show({ trustRoots: [{ id: 'root-a', label: 'Root A' }] });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Root A')).toBeTruthy();
  });

  const rootPicker = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>('input[accept*=".crt"]') as HTMLInputElement;

  const certificate = async (subject: string) => {
    const issued = await issueCertificate({
      subject,
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign'],
    });
    return new Uint8Array(issued.der);
  };

  it('opens the certificate picker from the import button', async () => {
    const { container } = show();
    const opened = vi.fn();
    rootPicker(container).addEventListener('click', opened);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Import certificate' }));
    expect(opened).toHaveBeenCalledOnce();
  });

  it('hands the roots read from the picked certificate files to the host, and shows no error', async () => {
    const onImportTrustRoots = vi.fn();
    const { container } = show({ onImportTrustRoots });
    const der = await certificate('Imported Root CA');
    await userEvent.setup().upload(rootPicker(container), new File([der], 'root.der'));
    await waitFor(() => expect(onImportTrustRoots).toHaveBeenCalledOnce());
    expect(onImportTrustRoots).toHaveBeenCalledWith([expect.objectContaining({ label: 'Imported Root CA' })]);
    expect(screen.queryByText(t('props.sig.roots.none'))).toBeNull();
  });

  it('says so when no picked file holds a certificate, and hands nothing over', async () => {
    const onImportTrustRoots = vi.fn();
    const { container } = show({ onImportTrustRoots });
    await userEvent.setup().upload(rootPicker(container), new File(['not a certificate'], 'notes.pem'));
    expect(await screen.findByText('No readable certificate found in selected files.')).toBeTruthy();
    expect(onImportTrustRoots).not.toHaveBeenCalled();
  });

  it('reports the files it refused beside the roots it added', async () => {
    const onImportTrustRoots = vi.fn();
    const { container } = show({ onImportTrustRoots });
    const der = await certificate('Good Root');
    await userEvent
      .setup()
      .upload(rootPicker(container), [
        new File([der], 'root.der'),
        new File(['not a certificate'], 'notes.pem'),
      ]);
    expect(await screen.findByText(t('props.sig.roots.addedRefused', { count: 1, refused: 1 }))).toBeTruthy();
    expect(onImportTrustRoots).toHaveBeenCalledOnce();
  });

  it('ignores a picker that closed without a file', () => {
    const onImportTrustRoots = vi.fn();
    const { container } = show({ onImportTrustRoots });
    fireEvent.change(rootPicker(container), { target: { files: [] } });
    expect(onImportTrustRoots).not.toHaveBeenCalled();
  });
});

describe('PropertiesPanel revocation lists', () => {
  const list = (overrides: Partial<RevocationList> = {}): RevocationList => ({
    id: 'crl-1',
    label: 'Test CA',
    derBase64: '',
    addedAt: 0,
    thisUpdate: '2026-05-01T00:00:00.000Z',
    nextUpdate: '2099-06-01T00:00:00.000Z',
    revokedCount: 3,
    delta: false,
    ...overrides,
  });

  it('says no list was imported', () => {
    show();
    expect(screen.getByText(t('props.sig.crls.empty'))).toBeTruthy();
    expect(screen.queryByRole('list', { name: t('props.sig.crls.title') })).toBeNull();
  });

  it('lists each CRL with the dates the verifier holds it to', () => {
    show({
      revocationLists: [
        list(),
        list({
          id: 'crl-2',
          label: 'Delta CA',
          delta: true,
          nextUpdate: null,
          thisUpdate: null,
          revokedCount: 0,
        }),
        list({ id: 'crl-3', label: 'Old CA', nextUpdate: '2020-01-01T00:00:00.000Z' }),
      ],
    });
    const items = within(screen.getByRole('list', { name: t('props.sig.crls.title') })).getAllByRole(
      'listitem',
    );
    expect(items.map((item) => item.textContent)).toEqual([
      'Test CA · issued 2026-05-01 · next 2099-06-01 · 3 revokedRemove',
      'Delta CA · issued — · next not stated · 0 revoked · delta CRLRemove',
      'Old CA · issued 2026-05-01 · next 2020-01-01 · 3 revoked · past its next updateRemove',
    ]);
  });

  it('removes the list the button names', async () => {
    const onRemoveRevocationList = vi.fn();
    show({
      revocationLists: [list(), list({ id: 'crl-2', label: 'Other CA' })],
      onRemoveRevocationList,
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove CRL Other CA' }));
    expect(onRemoveRevocationList).toHaveBeenCalledExactlyOnceWith('crl-2');
  });

  it('removes nothing without a handler', async () => {
    show({ revocationLists: [list()] });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove CRL Test CA' }));
    expect(screen.getByText(/^Test CA/)).toBeTruthy();
  });

  const crlPicker = () => screen.getByLabelText('Import CRL', { selector: 'input' }) as HTMLInputElement;

  const crlFile = async (subject: string) => {
    const ca = await issueCertificate({
      subject,
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign', 'cRLSign'],
    });
    return new Uint8Array(
      await issueCrl({
        issuer: ca,
        thisUpdate: new Date(Date.UTC(2026, 4, 1)),
        nextUpdate: new Date(Date.UTC(2099, 6, 1)),
      }),
    );
  };

  it('opens the CRL picker from the import button', async () => {
    show();
    const opened = vi.fn();
    crlPicker().addEventListener('click', opened);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Import CRL' }));
    expect(opened).toHaveBeenCalledOnce();
  });

  it('hands the CRLs read from the picked files to the host', async () => {
    const onImportRevocationLists = vi.fn();
    show({ onImportRevocationLists });
    await userEvent.setup().upload(crlPicker(), new File([await crlFile('Imported CA')], 'ca.crl'));
    await waitFor(() => expect(onImportRevocationLists).toHaveBeenCalledOnce());
    expect(onImportRevocationLists).toHaveBeenCalledWith([
      expect.objectContaining({ label: 'Imported CA', revokedCount: 0, delta: false }),
    ]);
  });

  it('says so when no picked file holds a CRL', async () => {
    const onImportRevocationLists = vi.fn();
    show({ onImportRevocationLists });
    await userEvent.setup().upload(crlPicker(), new File(['not a crl'], 'notes.crl'));
    expect(await screen.findByText(t('props.sig.crls.none'))).toBeTruthy();
    expect(onImportRevocationLists).not.toHaveBeenCalled();
  });

  it('ignores a picker that closed without a file', () => {
    const onImportRevocationLists = vi.fn();
    show({ onImportRevocationLists });
    fireEvent.change(crlPicker(), { target: { files: [] } });
    expect(onImportRevocationLists).not.toHaveBeenCalled();
  });
});

describe('PropertiesPanel announcements', () => {
  it('says nothing until a list changes size', () => {
    const { container, rerender } = show({ attachments: [{ name: 'a', description: '', size: 1 }] });
    expect(liveRegion(container)?.textContent).toBe('');
    rerender(<PropertiesPanel {...baseProps} attachments={[{ name: 'a', description: '', size: 1 }]} />);
    expect(liveRegion(container)?.textContent).toBe('');
  });

  it('announces a changed signature list, ahead of attachments and fonts changed with it', () => {
    const { container, rerender } = show();
    rerender(
      <PropertiesPanel
        {...baseProps}
        signatures={[signature()]}
        attachments={[{ name: 'a', description: '', size: 1 }]}
        fonts={[font()]}
      />,
    );
    expect(liveRegion(container)?.textContent).toBe('Signature list updated: 1');
  });

  it('announces a changed attachment list, ahead of fonts changed with it', () => {
    const { container, rerender } = show();
    rerender(
      <PropertiesPanel
        {...baseProps}
        attachments={[{ name: 'a', description: '', size: 1 }]}
        fonts={[font()]}
      />,
    );
    expect(liveRegion(container)?.textContent).toBe('Attachment list updated: 1');
  });

  it('announces a changed font list, comparing across the moment the list was being re-read', () => {
    const { container, rerender } = show({ fonts: [font()] });
    rerender(<PropertiesPanel {...baseProps} fonts={null} />);
    expect(liveRegion(container)?.textContent).toBe('');
    rerender(<PropertiesPanel {...baseProps} fonts={[font(), font({ baseFont: 'Courier' })]} />);
    expect(liveRegion(container)?.textContent).toBe('Font list updated: 2');
  });

  it('does not announce the first font list, which has nothing to be compared with', () => {
    const { container, rerender } = show({ fonts: null });
    rerender(<PropertiesPanel {...baseProps} fonts={[font()]} />);
    expect(liveRegion(container)?.textContent).toBe('');
  });

  it('does not announce a font list of the same size', () => {
    const { container, rerender } = show({ fonts: [font()] });
    rerender(<PropertiesPanel {...baseProps} fonts={[font({ baseFont: 'Courier' })]} />);
    expect(liveRegion(container)?.textContent).toBe('');
  });
});
