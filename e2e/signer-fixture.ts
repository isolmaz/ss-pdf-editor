/**
 * A signing identity and an independent signature check for the signing specs.
 *
 * `*.p12` is git-ignored on purpose (a key file is never committed), so the identity is
 * made per run with the `openssl` command line: a fresh P-256 key, a self-signed
 * certificate and a PKCS#12 container around them, the way a user's own tool would make one.
 * The same tool then verifies what the editor wrote — the CMS over the file's `/ByteRange`
 * — so "the signature is valid" is a statement from a second implementation, not from the
 * verifier the product itself ships.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SIGNER = { commonName: 'E2E Signer', password: 'e2e-pass' } as const;

function openssl(args: readonly string[], cwd: string): void {
  try {
    execFileSync('openssl', args, { cwd, stdio: 'pipe' });
  } catch (error) {
    throw new Error(`the signing specs need the \`openssl\` command line on PATH: ${String(error)}`);
  }
}

/** Write a fresh `.p12` (password `SIGNER.password`) into `dir` and return its path. */
export function makeSignerContainer(dir: string): string {
  mkdirSync(dir, { recursive: true });
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'key.pem'], dir);
  openssl(
    [
      'req',
      '-new',
      '-x509',
      '-key',
      'key.pem',
      '-days',
      '30',
      '-subj',
      `/CN=${SIGNER.commonName}`,
      '-addext',
      'keyUsage=digitalSignature',
      '-out',
      'cert.pem',
    ],
    dir,
  );
  openssl(
    [
      'pkcs12',
      '-export',
      '-inkey',
      'key.pem',
      '-in',
      'cert.pem',
      '-name',
      'e2e',
      '-passout',
      `pass:${SIGNER.password}`,
      '-out',
      'signer.p12',
    ],
    dir,
  );
  return join(dir, 'signer.p12');
}

export interface SignatureInFile {
  /** `[start, length, start, length]`, as the file's `/ByteRange` states it. */
  readonly byteRange: readonly number[];
  /** Whether the file's bytes outside `/Contents` are exactly the bytes that were signed. */
  readonly coversWholeFile: boolean;
  /** `openssl cms -verify` accepted the CMS over the covered bytes (certificate trust aside). */
  readonly verifies: boolean;
}

/**
 * Read the last signature of `bytes` and check it with `openssl cms -verify -noverify`:
 * the digest in the CMS must match the covered bytes and the signature must match the
 * certificate's key; chain trust is not part of the question for a self-signed identity.
 * Returns `null` when the file carries no `/ByteRange`.
 */
export function readSignature(bytes: Uint8Array, dir: string): SignatureInFile | null {
  const text = Buffer.from(bytes).toString('latin1');
  const ranges = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  const match = ranges.at(-1);
  if (match === undefined) return null;
  const byteRange = match.slice(1, 5).map(Number);
  const [startA = 0, lengthA = 0, startB = 0, lengthB = 0] = byteRange;
  const covered = Buffer.concat([
    Buffer.from(bytes.subarray(startA, startA + lengthA)),
    Buffer.from(bytes.subarray(startB, startB + lengthB)),
  ]);
  // `/Contents` is the gap between the two ranges: `<hex…>`.
  const gap = Buffer.from(bytes.subarray(startA + lengthA, startB)).toString('latin1');
  const hex = gap.replace(/^\s*</, '').replace(/>\s*$/, '');
  writeFileSync(join(dir, 'covered.bin'), covered);
  writeFileSync(join(dir, 'sig.der'), Buffer.from(hex, 'hex'));
  let verifies = true;
  try {
    openssl(
      [
        'cms',
        '-verify',
        '-inform',
        'DER',
        '-in',
        'sig.der',
        '-content',
        'covered.bin',
        '-binary',
        '-noverify',
        '-out',
        'verified.bin',
      ],
      dir,
    );
  } catch {
    verifies = false;
  }
  return {
    byteRange,
    coversWholeFile: startA === 0 && startB + lengthB === bytes.length,
    verifies,
  };
}

export function fileBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}
