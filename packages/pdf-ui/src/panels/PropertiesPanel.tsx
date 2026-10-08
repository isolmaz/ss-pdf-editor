/**
 * Document facts ("Document properties panel": font list,
 * embedded files add/remove, security tab, verification status of existing signatures).
 *
 * The panel is **presentational**: every read and every write belongs to an operation
 * in `pdf-core` (fonts, attachments, signature status), and the host hands the results
 * in. It renders the four signature states separately — integrity, trust, revocation
 * evidence and post-signing modification each get their own label and their own
 * sentence — because the product never shows a single "valid" badge. The trust states
 * are shown with the reason the app cannot go further (no network, no trust
 * store), never as an implied verdict.
 *
 * Accessibility: sections are `h3`-rooted regions with `aria-labelledby`, list changes
 * are announced through one polite live region (the pattern the sibling panels use),
 * every control carries a name that includes the attachment it acts on, and each of
 * them is a real `<button>` so the focus ring and keyboard behaviour come from Kumo.
 *
 * `security.permissions` arrives **display-ready** from the host (the operation layer
 * owns the permission vocabulary); this panel never guesses a translation key from a
 * string it was handed.
 */

import type { PdfFontInfo } from 'pdf-core/ops/pdf-fonts';
import type {
  RevocationCertCheck,
  SignatureCoverage,
  SignatureIntegrity,
  SignatureRevocation,
  SignatureTrust,
  SignatureVerification,
  TimestampCheck,
  TrustReason,
  ValidationTimeSource,
} from 'pdf-core/ops/signature-status';
import type { RevocationList, TrustRoot } from 'pdf-model';
import type { MessageKey, Translator } from 'pdf-shared';
import { type ReactElement, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { PanelLoading, PanelMessage } from './PanelParts';
import { importRevocationLists } from './revocation-lists';
import { importTrustRoots } from './trust-roots';

/** One embedded file as the panel lists it; `size` is `null` when its payload cannot be read. */
export interface AttachmentRow {
  readonly name: string;
  readonly description: string;
  readonly size: number | null;
}

export interface PropertiesPanelProps {
  readonly t: Translator;
  readonly fonts: readonly PdfFontInfo[] | null;
  readonly attachments: readonly AttachmentRow[];
  readonly signatures: readonly SignatureVerification[];
  readonly security: { readonly encrypted: boolean; readonly permissions: readonly string[] } | null;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  readonly onRemoveAttachment?: (name: string) => void;
  readonly onAddAttachments?: (files: readonly File[]) => void;
  readonly onReadAttachment?: (name: string) => void;
  /**
   * The certificates the **user** imported (`pdf-model/trust-roots`). They are shown
   * beside the verdicts because a "trusted" line without the root it reached is not
   * something a reader can check; the label is the certificate's own common name.
   */
  readonly trustRoots?: readonly { readonly id: string; readonly label: string }[];
  /**
   * The parsed roots, not the files: reading a certificate needs pkijs, and this panel lives
   * in a **dynamic** chunk while the shell must not carry the ASN.1 stack (measured: it put
   * the entry chunk ~90 KiB gzip over the locked budget when the shell did the parsing).
   */
  readonly onImportTrustRoots?: (roots: readonly TrustRoot[]) => void;
  readonly onRemoveTrustRoot?: (id: string) => void;
  /**
   * The CRLs the user imported (`pdf-model/revocation-lists`). Shown with their dates, because a
   * list is only as good as its `nextUpdate`; the parsed lists come back through
   * `onImportRevocationLists` for the same chunk-size reason as the roots.
   */
  readonly revocationLists?: readonly RevocationList[];
  readonly onImportRevocationLists?: (lists: readonly RevocationList[]) => void;
  readonly onRemoveRevocationList?: (id: string) => void;
}

const INTEGRITY_LABEL: Record<SignatureIntegrity, MessageKey> = {
  valid: 'props.sig.integrity.valid',
  invalid: 'props.sig.integrity.invalid',
  unchecked: 'props.sig.integrity.unchecked',
};

/** Colour never carries the state alone: every tone has its own words beside it. */
const INTEGRITY_TONE: Record<SignatureIntegrity, string> = {
  valid: 'text-kumo-success',
  invalid: 'text-kumo-danger',
  unchecked: 'text-kumo-subtle',
};

const TRUST_LABEL: Record<SignatureTrust, MessageKey> = {
  trusted: 'props.sig.trust.trusted',
  untrusted: 'props.sig.trust.untrusted',
  'self-signed': 'props.sig.trust.selfSigned',
  indeterminate: 'props.sig.trust.indeterminate',
  'not-checked': 'props.sig.trust.notChecked',
};

const TRUST_TONE: Record<SignatureTrust, string> = {
  trusted: 'text-kumo-success',
  untrusted: 'text-kumo-danger',
  'self-signed': 'text-kumo-warning',
  // Not a failure and not a pass: the same neutral tone as "not checked", because a
  // colour that reads as danger would overstate what an unfinished check proved.
  indeterminate: 'text-kumo-subtle',
  'not-checked': 'text-kumo-subtle',
};

/**
 * Which check produced the trust verdict. The verdict says *what* the answer is; the
 * reason says *why*, and a bare "not trusted" without it invites the reader to guess
 * between a broken chain and an unfinished one.
 */
const TRUST_REASON_LABEL: Record<TrustReason, MessageKey> = {
  'no-roots': 'props.sig.trustReason.noRoots',
  'no-issuer': 'props.sig.trustReason.noIssuer',
  'unsupported-signature': 'props.sig.trustReason.unsupportedSignature',
  'unsupported-critical-extension': 'props.sig.trustReason.unsupportedCriticalExtension',
  malformed: 'props.sig.trustReason.malformed',
  'signature-mismatch': 'props.sig.trustReason.signatureMismatch',
  validity: 'props.sig.trustReason.validity',
  'not-a-ca': 'props.sig.trustReason.notACa',
  'key-usage': 'props.sig.trustReason.keyUsage',
  'path-length': 'props.sig.trustReason.pathLength',
  'name-constraint': 'props.sig.trustReason.nameConstraint',
};

const REVOCATION_LABEL: Record<SignatureRevocation, MessageKey> = {
  'not-revoked': 'props.sig.revocation.notRevoked',
  'not-revoked-outdated': 'props.sig.revocation.notRevokedOutdated',
  revoked: 'props.sig.revocation.revoked',
  'revoked-after-signing': 'props.sig.revocation.revokedAfter',
  partial: 'props.sig.revocation.partial',
  indeterminate: 'props.sig.revocation.indeterminate',
};

const REVOCATION_TONE: Record<SignatureRevocation, string> = {
  'not-revoked': 'text-kumo-success',
  // Nothing names the certificate, but the lists are too old to say it was good when it mattered.
  'not-revoked-outdated': 'text-kumo-warning',
  revoked: 'text-kumo-danger',
  // The signature was made while the certificate was good, but the certificate is revoked now.
  'revoked-after-signing': 'text-kumo-warning',
  // Not a failure: part of the chain was cleared, part had no list to ask.
  partial: 'text-kumo-warning',
  indeterminate: 'text-kumo-subtle',
};

const TIMESTAMP_LABEL: Record<TimestampCheck['status'], MessageKey> = {
  valid: 'props.sig.ts.status.valid',
  invalid: 'props.sig.ts.status.invalid',
  unchecked: 'props.sig.ts.status.unchecked',
};

const TIMESTAMP_TONE: Record<TimestampCheck['status'], string> = {
  valid: 'text-kumo-success',
  invalid: 'text-kumo-danger',
  unchecked: 'text-kumo-subtle',
};

const TIMESTAMP_KIND_LABEL: Record<TimestampCheck['kind'], MessageKey> = {
  signature: 'props.sig.ts.kind.signature',
  document: 'props.sig.ts.kind.document',
};

const TIMESTAMP_REASON_LABEL: Record<NonNullable<TimestampCheck['reason']>, MessageKey> = {
  malformed: 'props.sig.ts.reason.malformed',
  'imprint-mismatch': 'props.sig.ts.reason.imprint-mismatch',
  'unsupported-hash': 'props.sig.ts.reason.unsupported-hash',
  'no-tsa-certificate': 'props.sig.ts.reason.no-tsa-certificate',
  'digest-mismatch': 'props.sig.ts.reason.digest-mismatch',
  'bad-signature': 'props.sig.ts.reason.bad-signature',
  'unsupported-signature': 'props.sig.ts.reason.unsupported-signature',
  'tsa-key-usage': 'props.sig.ts.reason.tsa-key-usage',
  'tsa-validity': 'props.sig.ts.reason.tsa-validity',
};

const VALIDATION_TIME_LABEL: Record<ValidationTimeSource, MessageKey> = {
  timestamp: 'props.sig.vt.timestamp',
  'timestamp-untrusted': 'props.sig.vt.timestamp-untrusted',
  'signing-time': 'props.sig.vt.signing-time',
  clock: 'props.sig.vt.clock',
};

const REVOCATION_ROLE_LABEL: Record<RevocationCertCheck['role'], MessageKey> = {
  signer: 'props.sig.rev.role.signer',
  intermediate: 'props.sig.rev.role.intermediate',
  timestamp: 'props.sig.rev.role.timestamp',
};

const REVOCATION_REASON_LABEL: Record<NonNullable<RevocationCertCheck['reason']>, MessageKey> = {
  unspecified: 'props.sig.rev.reason.unspecified',
  keyCompromise: 'props.sig.rev.reason.keyCompromise',
  cACompromise: 'props.sig.rev.reason.cACompromise',
  affiliationChanged: 'props.sig.rev.reason.affiliationChanged',
  superseded: 'props.sig.rev.reason.superseded',
  cessationOfOperation: 'props.sig.rev.reason.cessationOfOperation',
  certificateHold: 'props.sig.rev.reason.certificateHold',
  privilegeWithdrawn: 'props.sig.rev.reason.privilegeWithdrawn',
  aACompromise: 'props.sig.rev.reason.aACompromise',
};

const REVOCATION_WHY_LABEL: Record<NonNullable<RevocationCertCheck['unknownReason']>, MessageKey> = {
  'no-list': 'props.sig.rev.why.noList',
  'no-issuer': 'props.sig.rev.why.noIssuer',
  'invalid-list': 'props.sig.rev.why.invalidList',
  'unsupported-list': 'props.sig.rev.why.unsupportedList',
  'list-scope': 'props.sig.rev.why.listScope',
};

const REVOCATION_SOURCE_LABEL: Record<string, MessageKey> = {
  'crl.imported': 'props.sig.rev.src.crl.imported',
  'crl.embedded': 'props.sig.rev.src.crl.embedded',
  'ocsp.embedded': 'props.sig.rev.src.ocsp.embedded',
  'ocsp.imported': 'props.sig.rev.src.ocsp.imported',
};

/** An instant as `2026-10-06 16:20:11 UTC`: the same words in both languages, no locale guesswork. */
function formatInstant(iso: string): string {
  return `${iso.slice(0, 19).replace('T', ' ')} UTC`;
}

const COVERAGE_LABEL: Record<SignatureCoverage, MessageKey> = {
  'covers-whole-document': 'props.sig.coverage.whole',
  'covers-partial': 'props.sig.coverage.partial',
  unknown: 'props.sig.coverage.unknown',
};

const COVERAGE_TONE: Record<SignatureCoverage, string> = {
  'covers-whole-document': 'text-kumo-success',
  'covers-partial': 'text-kumo-warning',
  unknown: 'text-kumo-subtle',
};

const HEADING_CLASS = 'text-xs font-semibold text-kumo-subtle';
const ROW_CLASS = 'flex flex-col gap-1 rounded-sm border border-kumo-line px-2 py-1.5';
const META_CLASS = 'text-[11px] text-kumo-subtle';
/** The one focus treatment every control in the panel shares (WCAG 2.2 AA). */
const FOCUS_CLASS = 'focus-visible:outline-2 focus-visible:outline-kumo-focus';

/** File sizes as the locale writes them — no unit string of ours to translate. */
const SIZE_FORMATTERS = new Map<string, Intl.NumberFormat>();

function formatSize(bytes: number, locale: string): string {
  let formatter = SIZE_FORMATTERS.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte', unitDisplay: 'short' });
    SIZE_FORMATTERS.set(locale, formatter);
  }
  return formatter.format(bytes);
}

interface Counts {
  readonly fonts: number | null;
  readonly attachments: number;
  readonly signatures: number;
}

/**
 * One sentence when a list changes size. The panels are re-rendered with fresh props
 * by the shell, so the previous counts live in a ref and only a real change speaks.
 *
 * The font list is `null` while the shell re-reads it after every change to the document,
 * so a font change is two renders apart with a `null` between: the last count that was
 * not `null` is the one the next one is compared with.
 */
function useListAnnouncement(counts: Counts, t: Translator): string {
  const [message, setMessage] = useState('');
  const previous = useRef<Counts>(counts);
  const lastFonts = useRef<number | null>(counts.fonts);
  useEffect(() => {
    const before = previous.current;
    previous.current = counts;
    const fontsBefore = lastFonts.current;
    if (counts.fonts !== null) lastFonts.current = counts.fonts;
    // One sentence, the weightiest change first: opening another document changes every
    // list, and its signatures are what the reader most needs to hear about.
    if (counts.signatures !== before.signatures) {
      setMessage(t('props.live.signatures', { count: counts.signatures }));
    } else if (counts.attachments !== before.attachments) {
      setMessage(t('props.live.attachments', { count: counts.attachments }));
    } else if (counts.fonts !== null && fontsBefore !== null && counts.fonts !== fontsBefore) {
      setMessage(t('props.live.fonts', { count: counts.fonts }));
    }
  }, [counts, t]);
  return message;
}

function FontRow({ font, t }: { readonly font: PdfFontInfo; readonly t: Translator }) {
  return (
    <li className={ROW_CLASS}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-kumo-default" title={font.baseFont}>
          {font.baseFont === '' ? font.subtype : font.baseFont}
        </span>
        <span className={`shrink-0 ${META_CLASS}`}>{font.subtype}</span>
      </div>
      <div className={`flex flex-wrap items-center gap-x-2 ${META_CLASS}`}>
        <span>{t('props.font.pages', { count: font.pages.length })}</span>
        <span className={font.embedded ? 'text-kumo-success' : 'text-kumo-warning'}>
          {t(font.embedded ? 'props.font.embedded' : 'props.font.notEmbedded')}
        </span>
        {font.subset ? <span>{t('props.font.subset')}</span> : null}
        {font.encoding === null ? null : <span>{t('props.font.encoding', { encoding: font.encoding })}</span>}
      </div>
    </li>
  );
}

function SignatureState({
  labelKey,
  valueKey,
  tone,
  t,
}: {
  readonly labelKey: MessageKey;
  readonly valueKey: MessageKey;
  readonly tone: string;
  readonly t: Translator;
}) {
  return (
    <>
      <dt className={META_CLASS}>{t(labelKey)}</dt>
      <dd className={tone}>{t(valueKey)}</dd>
    </>
  );
}

/**
 * One certificate's revocation answer, in a sentence, with the notes that qualify it: a list
 * issued before the signature cannot rule out a later revocation, and a revocation is only
 * called harmless when the time it is compared with is a trusted timestamp.
 */
function RevocationLine({
  check,
  source,
  t,
}: {
  readonly check: RevocationCertCheck;
  readonly source: ValidationTimeSource;
  readonly t: Translator;
}) {
  const role = t(REVOCATION_ROLE_LABEL[check.role]);
  const notes: string[] = [];
  let line: string;
  let tone = META_CLASS;
  if (check.status === 'revoked') {
    tone = 'text-[11px] text-kumo-danger';
    line = t('props.sig.rev.revoked', {
      role,
      subject: check.subject,
      date: check.revokedAt === null ? '—' : formatInstant(check.revokedAt),
      reason: t(REVOCATION_REASON_LABEL[check.reason ?? 'unspecified']),
    });
    if (check.timing === 'before-signing') notes.push(t('props.sig.rev.timingBefore'));
    else if (check.timing === 'after-signing') {
      notes.push(
        t(source === 'timestamp' ? 'props.sig.rev.timingAfter' : 'props.sig.rev.timingAfterClaimed'),
      );
    }
  } else if (check.status === 'good') {
    tone = 'text-[11px] text-kumo-success';
    line = t('props.sig.rev.good', {
      role,
      subject: check.subject,
      source: t(
        REVOCATION_SOURCE_LABEL[`${check.source}.${check.origin}`] ?? 'props.sig.rev.src.ocsp.imported',
      ),
      date: check.thisUpdate === null ? '—' : formatInstant(check.thisUpdate),
    });
    if (check.coversValidationTime === false) notes.push(t('props.sig.rev.noteBefore'));
  } else {
    line = t('props.sig.rev.unknown', {
      role,
      subject: check.subject,
      why: t(REVOCATION_WHY_LABEL[check.unknownReason ?? 'no-list']),
    });
  }
  if (check.stale && check.nextUpdate !== null) {
    notes.push(t('props.sig.rev.noteStale', { date: formatInstant(check.nextUpdate) }));
  }
  return (
    <li className="flex flex-col gap-0.5" data-revocation-status={check.status}>
      <span className={tone}>{line}</span>
      {notes.map((note) => (
        <span key={note} className={`${META_CLASS} ps-2`}>
          {note}
        </span>
      ))}
    </li>
  );
}

/** The timestamp token's own facts: when, by whom, and whether its time may be relied on. */
function TimestampDetails({
  timestamp,
  source,
  t,
}: {
  readonly timestamp: TimestampCheck;
  readonly source: ValidationTimeSource;
  readonly t: Translator;
}) {
  return (
    <div className="flex flex-col gap-0.5" data-timestamp-status={timestamp.status}>
      {timestamp.genTime === null ? null : (
        <p className={META_CLASS}>
          {t('props.sig.ts.detail', {
            kind: t(TIMESTAMP_KIND_LABEL[timestamp.kind]),
            time: formatInstant(timestamp.genTime),
            tsa: timestamp.tsa ?? t('props.sig.ts.tsaUnknown'),
            hash: timestamp.hashAlgorithm ?? '—',
          })}
        </p>
      )}
      {timestamp.reason === null ? null : (
        <p className="text-[11px] text-kumo-danger">{t(TIMESTAMP_REASON_LABEL[timestamp.reason])}</p>
      )}
      {timestamp.status !== 'valid' ? null : (
        <p className={META_CLASS}>
          {t(timestamp.trusted ? 'props.sig.ts.trust.trusted' : 'props.sig.ts.trust.untrusted')}
        </p>
      )}
      {timestamp.kind === 'signature' && timestamp.tsaRevocation.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {timestamp.tsaRevocation.map((check) => (
            <RevocationLine key={`${check.role}|${check.subject}`} check={check} source={source} t={t} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SignatureRow({
  signature,
  t,
}: {
  readonly signature: SignatureVerification;
  readonly t: Translator;
}) {
  // A certificate not yet valid becomes valid on its first day; any other is valid until its last.
  const certificateDate =
    signature.certificateValidity === 'not-yet-valid'
      ? signature.certificateNotBefore
      : signature.certificateNotAfter;
  return (
    <li className={ROW_CLASS}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-kumo-default" title={signature.fieldName}>
          {signature.fieldName === '' ? t('props.sig.unnamed') : signature.fieldName}
        </span>
        {signature.subFilter === '' ? null : (
          <span className={`shrink-0 ${META_CLASS}`}>{signature.subFilter}</span>
        )}
      </div>
      <p className={META_CLASS}>
        {t('props.sig.signer', {
          name: signature.signer ?? t('props.sig.signerUnknown'),
        })}
        {' · '}
        {t('props.sig.signedAt', {
          date: signature.signedAt ?? t('props.sig.dateUnknown'),
        })}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        <SignatureState
          labelKey="props.sig.field.integrity"
          valueKey={INTEGRITY_LABEL[signature.integrity]}
          tone={INTEGRITY_TONE[signature.integrity]}
          t={t}
        />
        <SignatureState
          labelKey="props.sig.field.trust"
          valueKey={TRUST_LABEL[signature.trust]}
          tone={TRUST_TONE[signature.trust]}
          t={t}
        />
        <SignatureState
          labelKey="props.sig.field.revocation"
          valueKey={REVOCATION_LABEL[signature.revocation]}
          tone={REVOCATION_TONE[signature.revocation]}
          t={t}
        />
        {signature.timestamp === null ? null : (
          <SignatureState
            labelKey="props.sig.field.timestamp"
            valueKey={TIMESTAMP_LABEL[signature.timestamp.status]}
            tone={TIMESTAMP_TONE[signature.timestamp.status]}
            t={t}
          />
        )}
        <SignatureState
          labelKey="props.sig.field.coverage"
          valueKey={COVERAGE_LABEL[signature.coverage]}
          tone={COVERAGE_TONE[signature.coverage]}
          t={t}
        />
      </dl>
      {signature.timestamp === null ? null : (
        <TimestampDetails timestamp={signature.timestamp} source={signature.validationTimeSource} t={t} />
      )}
      {signature.revocationChecks.length === 0 ? null : (
        <ul aria-label={t('props.sig.rev.title')} className="flex flex-col gap-0.5">
          {signature.revocationChecks.map((check) => (
            <RevocationLine
              key={`${check.role}|${check.subject}`}
              check={check}
              source={signature.validationTimeSource}
              t={t}
            />
          ))}
        </ul>
      )}
      {signature.validationTime === null ? null : (
        <p className={META_CLASS}>
          {t('props.sig.validationTime', {
            time: formatInstant(signature.validationTime),
            source: t(VALIDATION_TIME_LABEL[signature.validationTimeSource]),
          })}
        </p>
      )}
      {signature.trustReason === null ? null : (
        <p className={META_CLASS}>{t(TRUST_REASON_LABEL[signature.trustReason])}</p>
      )}
      {signature.trustPath.length > 1 ? (
        <p className={META_CLASS} title={signature.trustPath.join(' → ')}>
          {t('props.sig.chain', { path: signature.trustPath.join(' → ') })}
        </p>
      ) : null}
      {certificateDate === null ? null : (
        <p
          className={
            signature.certificateValidity === 'expired' ? 'text-[11px] text-kumo-danger' : META_CLASS
          }
        >
          {t(
            signature.certificateValidity === 'expired'
              ? 'props.sig.certExpired'
              : signature.certificateValidity === 'not-yet-valid'
                ? 'props.sig.certNotYet'
                : // Judged at a trusted timestamp, a certificate that has since expired was still
                  // valid when the signature was made: say so rather than "valid until <past>".
                  signature.validationTimeSource === 'timestamp' && new Date(certificateDate) < new Date()
                  ? 'props.sig.certValidAtTimestamp'
                  : 'props.sig.certValidUntil',
            { date: certificateDate.slice(0, 10) },
          )}
        </p>
      )}
      <p className={META_CLASS}>
        {signature.changesAfterSigning === 0
          ? t('props.sig.changesNone')
          : t('props.sig.changes', { count: signature.changesAfterSigning })}
      </p>
      <p className="text-[11px] text-kumo-default">{t(signature.reasonKey)}</p>
    </li>
  );
}

export function PropertiesPanel({
  t,
  fonts,
  attachments,
  signatures,
  security,
  loading,
  disabled,
  onRemoveAttachment,
  onAddAttachments,
  onReadAttachment,
  trustRoots = [],
  onImportTrustRoots,
  onRemoveTrustRoot,
  revocationLists = [],
  onImportRevocationLists,
  onRemoveRevocationList,
}: PropertiesPanelProps): ReactElement {
  const ids = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const rootInput = useRef<HTMLInputElement>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const crlInput = useRef<HTMLInputElement>(null);
  const [crlError, setCrlError] = useState<string | null>(null);
  const announcement = useListAnnouncement(
    { fonts: fonts?.length ?? null, attachments: attachments.length, signatures: signatures.length },
    t,
  );

  if (loading === true) return <PanelLoading />;

  return (
    <section aria-label={t('props.title')} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <section aria-labelledby={`${ids}-fonts`} className="flex flex-col gap-1">
        <h3 id={`${ids}-fonts`} className={HEADING_CLASS}>
          {t('props.font.title')}
        </h3>
        {fonts === null || fonts.length === 0 ? (
          <PanelMessage text={t('props.font.empty')} />
        ) : (
          <ul aria-label={t('props.font.title')} className="flex flex-col gap-1">
            {fonts.map((font) => (
              <FontRow key={font.baseFont} font={font} t={t} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${ids}-attachments`} className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h3 id={`${ids}-attachments`} className={HEADING_CLASS}>
            {t('props.attach.title')}
          </h3>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled === true || onAddAttachments === undefined}
            className={FOCUS_CLASS}
            onClick={() => fileInput.current?.click()}
          >
            {t('props.attach.add')}
          </Button>
          {/*
            A file input cannot be controlled and its value must be cleared after every
            pick, or choosing the same file twice fires nothing. It is display-hidden and
            out of the tab order: the labelled button above is the control a keyboard or
            screen-reader user operates.
          */}
          <input
            ref={fileInput}
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              if (files.length > 0) onAddAttachments?.(files);
            }}
          />
        </div>
        {attachments.length === 0 ? (
          <PanelMessage text={t('props.attach.empty')} />
        ) : (
          <ul aria-label={t('props.attach.title')} className="flex flex-col gap-0.5">
            {attachments.map((attachment) => (
              <li
                key={attachment.name}
                className="flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-kumo-tint"
              >
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-kumo-default" title={attachment.name}>
                    {attachment.name}
                  </span>
                  <span className={`block ${META_CLASS}`}>
                    {attachment.size === null
                      ? t('props.attach.noSize')
                      : formatSize(attachment.size, t.locale)}
                    {attachment.description === '' ? '' : ` · ${attachment.description}`}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disabled === true || onReadAttachment === undefined}
                  className={FOCUS_CLASS}
                  aria-label={t('props.attach.readNamed', { name: attachment.name })}
                  onClick={() => onReadAttachment?.(attachment.name)}
                >
                  {t('props.attach.read')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary-destructive"
                  disabled={disabled === true || onRemoveAttachment === undefined}
                  className={FOCUS_CLASS}
                  aria-label={t('props.attach.removeNamed', { name: attachment.name })}
                  onClick={() => onRemoveAttachment?.(attachment.name)}
                >
                  {t('props.attach.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${ids}-security`} className="flex flex-col gap-1">
        <h3 id={`${ids}-security`} className={HEADING_CLASS}>
          {t('props.security.title')}
        </h3>
        {security === null ? (
          <PanelMessage text={t('props.security.empty')} />
        ) : (
          <div className="flex flex-col gap-1.5 rounded-sm border border-kumo-line bg-kumo-base px-2 py-1.5">
            <p className="text-xs text-kumo-default">
              <span className={security.encrypted ? 'text-kumo-success' : 'text-kumo-subtle'}>
                {t(security.encrypted ? 'props.security.encrypted' : 'props.security.plain')}
              </span>
            </p>
            <div className="flex flex-col gap-1">
              <h4 className={META_CLASS}>{t('props.security.permissions')}</h4>
              {security.permissions.length === 0 ? (
                <p className={META_CLASS}>{t('props.security.noPermissions')}</p>
              ) : (
                <ul className="flex flex-wrap gap-1">
                  {security.permissions.map((permission) => (
                    <li
                      key={permission}
                      className="rounded-sm bg-kumo-tint px-1.5 py-0.5 text-[11px] text-kumo-default"
                    >
                      {permission}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {security.encrypted ? <p className={META_CLASS}>{t('props.security.note')}</p> : null}
          </div>
        )}
      </section>

      <section aria-labelledby={`${ids}-signatures`} className="flex flex-col gap-1">
        <h3 id={`${ids}-signatures`} className={HEADING_CLASS}>
          {t('props.sig.title')}
        </h3>
        {signatures.length === 0 ? (
          <PanelMessage text={t('props.sig.empty')} />
        ) : (
          <ul aria-label={t('props.sig.title')} className="flex flex-col gap-1.5">
            {signatures.map((signature) => (
              // The field name, the format and the signing date are what make a
              // signature distinguishable inside one document; an array index would
              // silently rebind a row when the list is re-read.
              <SignatureRow
                key={`${signature.fieldName}|${signature.subFilter}|${signature.signedAt ?? ''}`}
                signature={signature}
                t={t}
              />
            ))}
          </ul>
        )}
        <p className={META_CLASS}>{t('props.sig.revocation.note')}</p>
        <p className={META_CLASS}>{t('props.sig.trust.note')}</p>

        {/* The roots are the user's own decision, so they are listed with the control that
            removes them: a root that cannot be taken back is not a trust decision. */}
        <div className="flex flex-col gap-1 border-t border-kumo-line pt-1.5">
          <p className="text-[11px] text-kumo-subtle">{t('props.sig.roots.title')}</p>
          {trustRoots.length === 0 ? (
            <p className={META_CLASS}>{t('props.sig.roots.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {trustRoots.map((root) => (
                <li key={root.id} className="flex items-center gap-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate text-kumo-default" title={root.label}>
                    {root.label}
                  </span>
                  <Button variant="outline" onClick={() => onRemoveTrustRoot?.(root.id)}>
                    {t('props.sig.roots.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => rootInput.current?.click()}>
              {t('props.sig.roots.import')}
            </Button>
            {rootError === null ? null : <span className="text-[11px] text-kumo-danger">{rootError}</span>}
          </div>
          <input
            ref={rootInput}
            type="file"
            accept=".crt,.cer,.pem,.der,application/x-x509-ca-cert"
            multiple
            className="sr-only"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              if (files.length > 0) void importTrustRoots(files, t, onImportTrustRoots, setRootError);
            }}
          />
        </div>

        {/* Imported CRLs: the only revocation evidence the user supplies. Each is listed with the
            dates the verifier will hold it to, and removable, like the roots above. */}
        <div className="flex flex-col gap-1 border-t border-kumo-line pt-1.5">
          <p className="text-[11px] text-kumo-subtle">{t('props.sig.crls.title')}</p>
          {revocationLists.length === 0 ? (
            <p className={META_CLASS}>{t('props.sig.crls.empty')}</p>
          ) : (
            <ul aria-label={t('props.sig.crls.title')} className="flex flex-col gap-1">
              {revocationLists.map((list) => (
                <li key={list.id} className="flex items-center gap-2 text-[11px]">
                  <span className="min-w-0 flex-1 text-kumo-default">
                    {t('props.sig.crls.item', {
                      issuer: list.label,
                      thisUpdate: list.thisUpdate === null ? '—' : list.thisUpdate.slice(0, 10),
                      nextUpdate:
                        list.nextUpdate === null ? t('props.sig.crls.noNext') : list.nextUpdate.slice(0, 10),
                      count: list.revokedCount,
                    })}
                    {list.delta ? ` · ${t('props.sig.crls.delta')}` : ''}
                    {list.nextUpdate !== null && new Date(list.nextUpdate) < new Date() ? (
                      <span className="text-kumo-warning"> · {t('props.sig.crls.expired')}</span>
                    ) : null}
                  </span>
                  <Button
                    variant="outline"
                    aria-label={t('props.sig.crls.removeNamed', { name: list.label })}
                    onClick={() => onRemoveRevocationList?.(list.id)}
                  >
                    {t('props.sig.crls.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className={META_CLASS}>{t('props.sig.crls.note')}</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => crlInput.current?.click()}>
              {t('props.sig.crls.import')}
            </Button>
            {crlError === null ? null : <span className="text-[11px] text-kumo-danger">{crlError}</span>}
          </div>
          <input
            ref={crlInput}
            type="file"
            accept=".crl,.pem,.der,application/pkix-crl"
            multiple
            aria-label={t('props.sig.crls.import')}
            className="sr-only"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              if (files.length > 0)
                void importRevocationLists(files, t, onImportRevocationLists, setCrlError);
            }}
          />
        </div>
      </section>
    </section>
  );
}
