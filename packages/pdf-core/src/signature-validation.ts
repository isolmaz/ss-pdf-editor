/**
 * Putting the offline evidence together for one signature: its timestamp, the lists that can
 * speak for its certificates, and the moment the signature is judged at.
 *
 * `ops/signature-status.ts` keeps the byte-level facts (digest, signature value, coverage,
 * revisions) and calls this module, lazily, for everything that needs `pkijs`. The order here
 * is the one dependency that matters: the **timestamp comes first**, because a timestamp that
 * verifies replaces the signer's own claimed time as the validation time — and that time is
 * what the certificate path is validated at and what a revocation date is compared with.
 *
 * Which time is used, and how far it is believed:
 *  - `timestamp` — a valid token from a TSA the user imported and whose certificates are not
 *    revoked. The only time a later revocation or an expired certificate can be excused by.
 *  - `timestamp-untrusted` — a valid token from a TSA nobody vouched for. Its time is shown and
 *    used for the comparison, but it excuses nothing: anyone can run such a TSA.
 *  - `signing-time` — the `signingTime` attribute or `/M`: what the signer *says*. Shown, never
 *    believed (it is not later than the clock, though: a claimed future date is clamped).
 *  - `clock` — nothing was claimed; the machine's clock.
 */

import { NO_EVIDENCE, readSignatureEvidence } from './signature-evidence';
import {
  checkRevocation,
  parseRevocationSources,
  type RevocationCertCheck,
  type RevocationSummary,
  summarizeRevocation,
} from './signature-revocation';
import { type TimestampCheck, verifyTimestampToken } from './signature-timestamp';

export type ValidationTimeSource = 'timestamp' | 'timestamp-untrusted' | 'signing-time' | 'clock';

/** What the PDF's `/DSS` carries (`Certs`, `CRLs`, `OCSPs`), DER. */
export interface DssData {
  readonly certs: readonly Uint8Array[];
  readonly crls: readonly Uint8Array[];
  readonly ocsps: readonly Uint8Array[];
}

export const NO_DSS: DssData = { certs: [], crls: [], ocsps: [] };

export interface EvidenceInput {
  /** The signature's `/Contents`. */
  readonly contents: Uint8Array;
  /** The CMS signature value, the data a signature timestamp's imprint covers. */
  readonly signatureValue: Uint8Array | null;
  /** The signer certificate, DER; empty when the CMS carried none. */
  readonly signer: Uint8Array;
  /** The other certificates the CMS carried. */
  readonly chain: readonly Uint8Array[];
  /** `/M` as an ISO date, the fallback claim when the CMS has no `signingTime`. */
  readonly claimedAt: string | null;
  readonly roots: readonly Uint8Array[];
  /** CRLs the user imported (DER). */
  readonly importedCrls: readonly Uint8Array[];
  readonly dss: DssData;
  readonly now: Date;
}

export interface EvidenceOutcome {
  readonly timestamp: TimestampCheck | null;
  readonly revocationChecks: readonly RevocationCertCheck[];
  readonly revocation: RevocationSummary;
  readonly validationTime: Date;
  readonly validationTimeSource: ValidationTimeSource;
  /** The date the signer's certificate path is validated at. */
  readonly trustAt: Date;
}

function claimedTime(attribute: Date | null, pdfDate: string | null, now: Date): Date | null {
  const fromPdf = pdfDate === null ? null : new Date(pdfDate);
  const claimed = attribute ?? (fromPdf !== null && !Number.isNaN(fromPdf.getTime()) ? fromPdf : null);
  if (claimed === null) return null;
  return claimed > now ? now : claimed;
}

/** The timestamps, revocation and validation time of a CMS signature. */
export async function evaluateEvidence(input: EvidenceInput): Promise<EvidenceOutcome> {
  const evidence = readSignatureEvidence(input.contents) ?? NO_EVIDENCE;
  const sources = parseRevocationSources({
    imported: input.importedCrls,
    embeddedCrls: [...evidence.crls, ...input.dss.crls],
    embeddedOcsps: [...evidence.ocspResponses, ...input.dss.ocsps],
  });
  const pool = [...input.chain, ...evidence.certificates, ...input.dss.certs];

  let timestamp: TimestampCheck | null = null;
  if (input.signatureValue !== null) {
    for (const token of evidence.timestampTokens) {
      const checked = await verifyTimestampToken({
        kind: 'signature',
        token,
        covered: input.signatureValue,
        pool,
        roots: input.roots,
        sources,
        now: input.now,
      });
      // The first token that verifies is the one used; a failing one is still reported when
      // none verifies, so a broken timestamp is never silently dropped.
      if (timestamp === null || (timestamp.status !== 'valid' && checked.status === 'valid'))
        timestamp = checked;
    }
  }

  const usable = timestamp !== null && timestamp.status === 'valid' && timestamp.genTime !== null;
  const stamped =
    usable && timestamp !== null && timestamp.genTime !== null ? new Date(timestamp.genTime) : null;
  const claimed = claimedTime(evidence.signingTime, input.claimedAt, input.now);
  const validationTime = stamped ?? claimed ?? input.now;
  const validationTimeSource: ValidationTimeSource =
    stamped !== null
      ? timestamp?.trusted === true
        ? 'timestamp'
        : 'timestamp-untrusted'
      : claimed !== null
        ? 'signing-time'
        : 'clock';

  const revocationChecks =
    input.signer.length === 0
      ? []
      : await checkRevocation({
          leaf: input.signer,
          leafRole: 'signer',
          pool: [...pool, ...input.roots],
          context: { sources, validationTime, now: input.now },
        });
  return {
    timestamp,
    revocationChecks,
    revocation: summarizeRevocation(revocationChecks, validationTimeSource === 'timestamp'),
    validationTime,
    validationTimeSource,
    trustAt: validationTimeSource === 'timestamp' ? validationTime : input.now,
  };
}

export interface DocumentTimestampInput {
  /** The `/Contents` of the `/ETSI.RFC3161` dictionary: the token itself. */
  readonly token: Uint8Array;
  /** The `/ByteRange` bytes, joined: what the token's imprint covers. */
  readonly covered: Uint8Array;
  readonly roots: readonly Uint8Array[];
  readonly importedCrls: readonly Uint8Array[];
  readonly dss: DssData;
  readonly now: Date;
}

/**
 * A document timestamp: the token, and a one-word summary of the revocation of the TSA's own
 * certificates. A document timestamp is judged at its own `genTime`, so a revoked TSA
 * certificate is never excused as "revoked later".
 */
export async function evaluateDocumentTimestamp(
  input: DocumentTimestampInput,
): Promise<{ readonly timestamp: TimestampCheck; readonly revocation: RevocationSummary }> {
  const sources = parseRevocationSources({
    imported: input.importedCrls,
    embeddedCrls: input.dss.crls,
    embeddedOcsps: input.dss.ocsps,
  });
  const timestamp = await verifyTimestampToken({
    kind: 'document',
    token: input.token,
    covered: input.covered,
    pool: input.dss.certs,
    roots: input.roots,
    sources,
    now: input.now,
  });
  return { timestamp, revocation: summarizeRevocation(timestamp.tsaRevocation, false) };
}
