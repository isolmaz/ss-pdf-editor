/**
 * Reading certificate files into trust roots.
 *
 * It lives beside the panel that offers the action, not in the shell: reading a certificate
 * needs `pkijs` (through `pdf-core/signature-pkcs12`), and the shell is the one place the
 * ASN.1 stack must not be (measured — the entry chunk went from 210.22 to 302.66 KiB gzip
 * against a locked ≤ 250 KiB budget). Everything here is therefore inside the dock-panels
 * chunk, which loads when the properties panel opens.
 *
 * A `.pem`/`.crt` is base64 with headers; a `.der`/`.cer` is the DER itself. A file that
 * carries no certificate is refused by name — never added as an empty entry.
 */

import { fromBase64, type TrustRoot, trustRootFrom } from 'pdf-model';
import type { Translator } from 'pdf-shared';

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
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    const pem = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(text);
    const der = pem === null ? bytes : fromBase64(pem[1] ?? '');
    if (der.length === 0 || der[0] !== 0x30) {
      refused += 1;
      continue;
    }
    try {
      roots.push(trustRootFrom(der, describeCertificate(der).commonName ?? file.name));
    } catch {
      refused += 1;
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
