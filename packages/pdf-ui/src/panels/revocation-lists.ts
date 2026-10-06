/**
 * Reading CRL files into imported revocation lists.
 *
 * It lives beside the panel that offers the action, not in the shell, for the reason
 * `trust-roots.ts` gives: reading a CRL needs `pkijs` (through `pdf-core/signature-revocation`),
 * and the shell must not carry the ASN.1 stack. A `.crl`/`.der` is the DER itself; a `.pem` is
 * base64 between `BEGIN X509 CRL` lines and may hold several. A file that carries no CRL is
 * refused — never stored as an empty entry — and the reader never fetches anything.
 */

import { fromBase64, type RevocationList, revocationListFrom } from 'pdf-model';
import type { Translator } from 'pdf-shared';

const PEM_BLOCK = /-----BEGIN X509 CRL-----([\s\S]*?)-----END X509 CRL-----/g;

/** Every CRL DER in a file: each PEM block, or the file itself when it is binary. */
function crlBlobs(bytes: Uint8Array): Uint8Array[] {
  const text = new TextDecoder('latin1').decode(bytes);
  const blocks = [...text.matchAll(PEM_BLOCK)];
  if (blocks.length === 0) return [bytes];
  return blocks
    .map((block) => fromBase64(block[1] ?? ''))
    .filter((der): der is Uint8Array => der !== null && der.length > 0);
}

export async function importRevocationLists(
  files: readonly File[],
  t: Translator,
  onImported: ((lists: readonly RevocationList[]) => void) | undefined,
  onError: (message: string | null) => void,
): Promise<void> {
  if (onImported === undefined) return;
  const { describeCrl } = await import('pdf-core/signature-revocation');
  const lists: RevocationList[] = [];
  let refused = 0;
  for (const file of files) {
    const blobs = crlBlobs(new Uint8Array(await file.arrayBuffer()));
    let found = 0;
    for (const der of blobs) {
      const described = describeCrl(der);
      if (described === null) continue;
      found += 1;
      lists.push(
        revocationListFrom(der, described.issuer ?? file.name, {
          thisUpdate: described.thisUpdate,
          nextUpdate: described.nextUpdate,
          revokedCount: described.revokedCount,
          delta: described.delta,
        }),
      );
    }
    if (found === 0) refused += 1;
  }
  if (lists.length > 0) onImported(lists);
  onError(
    lists.length === 0
      ? t('props.sig.crls.none')
      : refused === 0
        ? null
        : t('props.sig.crls.addedRefused', { count: lists.length, refused }),
  );
}
