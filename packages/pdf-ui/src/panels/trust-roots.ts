/**
 * Reading certificate files into trust roots.
 *
 * It lives beside the panel that offers the action, not in the shell: reading a certificate
 * needs `pkijs` (through `pdf-core/signature-pkcs12`), and the shell is the one place the
 * ASN.1 stack must not be (it would put the first paint over its locked ≤ 250 KiB gzip
 * budget). Everything here is therefore inside the dock-panels chunk, which loads when the
 * properties panel opens.
 *
 * A `.pem`/`.crt` is base64 with headers and may hold several certificates (a CA bundle); a
 * `.der`/`.cer` is the DER itself. A block or a file that carries no certificate is refused
 * and counted — never added as an empty entry.
 */

import { fromBase64, type TrustRoot, trustRootFrom } from 'pdf-model';
import type { Translator } from 'pdf-shared';

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

/** Every certificate DER of a file: each PEM block (a CA bundle holds several), or the file itself when it has none. */
function certificateBlobs(bytes: Uint8Array): Uint8Array[] {
  const blocks = [...new TextDecoder().decode(bytes).matchAll(PEM_BLOCK)];
  if (blocks.length === 0) return [bytes];
  // The pattern has one group, which always takes part in a match.
  return blocks.map((block) => fromBase64(block[1] as string));
}

export async function importTrustRoots(
  files: readonly File[],
  t: Translator,
  onImported: ((roots: readonly TrustRoot[]) => void) | undefined,
  onError: (message: string | null) => void,
): Promise<void> {
  if (onImported === undefined) return;
  const { describeCertificate } = await import('pdf-core/signature-pkcs12');
  const roots: TrustRoot[] = [];
  let refused = 0;
  for (const file of files) {
    for (const der of certificateBlobs(new Uint8Array(await file.arrayBuffer()))) {
      if (der.length === 0 || der[0] !== 0x30) {
        refused += 1;
        continue;
      }
      try {
        roots.push(await trustRootFrom(der, describeCertificate(der).commonName ?? file.name));
      } catch {
        refused += 1;
      }
    }
  }
  if (roots.length > 0) onImported(roots);
  onError(
    roots.length === 0
      ? t('props.sig.roots.none')
      : refused === 0
        ? null
        : t('props.sig.roots.addedRefused', { count: roots.length, refused }),
  );
}
