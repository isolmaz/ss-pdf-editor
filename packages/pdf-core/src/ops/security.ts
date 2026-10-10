/**
 * Encryption and unlocking.
 *
 * **MuPDF is the crypto engine.** It writes AES-256 with a permission bitmask
 * (`encrypt=aes-256,user-password=…`), so no separate qpdf build or npm wrapper is
 * needed.
 *
 * The protection rule is enforced here: output protection
 * is never silently downgraded — a re-protected document must open with the same
 * password and report its permissions, or the operation fails.
 *
 * Everything below was measured against mupdf@1.28.1 (the pinned build, Node-side
 * probe over `/engines/mupdf/mupdf.js`):
 *
 * | permission        | bit     | value |
 * |-------------------|---------|-------|
 * | print             | `1 << 2`| 4     |
 * | modify (`edit`)   | `1 << 3`| 8     |
 * | copy              | `1 << 4`| 16    |
 * | annotate          | `1 << 5`| 32    |
 * | form              | `1 << 8`| 256   |
 * | accessibility     | `1 << 9`| 512   |
 * | assemble          | `1 << 10`| 1024 |
 * | printHighQuality  | `1 << 11`| 2048 |
 *
 * Measured by encrypting one fixture with `permissions=(1 << n)` for n = 0…12 and
 * reading `hasPermission()` back for all eight names after authenticating with the
 * user password: exactly one permission flipped on per bit above, and no bit
 * outside this set grants anything. The PDF spec's reserved bits 7 and 8 (`1 << 6`,
 * `1 << 7`) grant nothing, as expected. The product's "everything allowed" mask is
 * therefore **3900 (`0xf3c`)**.
 *
 * Two further measured facts this file depends on:
 *  - `authenticatePassword()` returns **0** for a wrong password, **2** for the
 *    user password and **4** for the owner password; an owner-authenticated
 *    document reports *all* permissions as granted regardless of the stored bits,
 *    so verification **always authenticates with the user password** (or the empty
 *    string for owner-only encryption, which also returns 2).
 *  - Saving an encrypted document **without authenticating** (or after a failed
 *    authentication) does not fail loudly: MuPDF writes a file whose streams are
 *    undecryptable garbage (measured: two `aes padding out of range` format errors
 *    and an empty text layer on every page). That is why `unlockDocument`
 *    authenticates before writing *and* re-reads the produced pages, and why
 *    `protectDocument` re-opens its own output before returning it.
 */

import type { DocumentPermission, PDFDocument } from 'mupdf';
import { ToolError } from 'pdf-shared';
import {
  loadMupdf,
  MUPDF_FULL_SAVE_OPTIONS,
  type Mupdf,
  mapMupdfError,
  openPdf,
  savePdf,
} from '../engines/mupdf';
import { countSignedFields } from './signature-status';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';

export interface ProtectionPermissions {
  readonly print: boolean;
  readonly printHighQuality: boolean;
  readonly copy: boolean;
  readonly modify: boolean;
  readonly annotate: boolean;
  readonly form: boolean;
  readonly assemble: boolean;
  readonly accessibility: boolean;
}

export interface ProtectOptions {
  /** Open password; empty means "opens freely but is still encrypted". */
  readonly userPassword: string;
  readonly ownerPassword: string;
  readonly permissions: ProtectionPermissions;
  /**
   * The credential the **incoming** bytes carry, when they are password-locked.
   * Re-protecting an unauthenticated document would hand back undecryptable
   * bytes, so the old password is authenticated before any rewrite.
   */
  readonly oldPassword?: string;
}

export interface ProtectionState {
  readonly encrypted: boolean;
  readonly needsPassword: boolean;
  /** Cipher name as reported by the engine (`aes-256`, `rc4-128`, …) or `none`. */
  readonly cipher: string;
  readonly permissions: ProtectionPermissions;
}

export const ALL_PERMISSIONS: ProtectionPermissions = {
  print: true,
  printHighQuality: true,
  copy: true,
  modify: true,
  annotate: true,
  form: true,
  assemble: true,
  accessibility: true,
};

/** Bit values measured on the pinned build (see the table in the file header). */
const PERMISSION_BITS: Readonly<Record<keyof ProtectionPermissions, number>> = {
  print: 1 << 2,
  printHighQuality: 1 << 11,
  copy: 1 << 4,
  modify: 1 << 3,
  annotate: 1 << 5,
  form: 1 << 8,
  assemble: 1 << 10,
  accessibility: 1 << 9,
};

/** MuPDF's own permission names, for `hasPermission()` and the error text. */
const MUPDF_PERMISSION_NAMES: Readonly<Record<keyof ProtectionPermissions, DocumentPermission>> = {
  print: 'print',
  printHighQuality: 'print-hq',
  copy: 'copy',
  modify: 'edit',
  annotate: 'annotate',
  form: 'form',
  assemble: 'assemble',
  accessibility: 'accessibility',
};

const PERMISSION_FIELDS = Object.keys(PERMISSION_BITS) as (keyof ProtectionPermissions)[];

/**
 * Encrypt a document. The produced bytes are **re-opened and checked** before
 * they are returned, so a silently unprotected output cannot reach the user.
 */
export async function protectDocument(
  bytes: Uint8Array,
  options: ProtectOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  if (options.ownerPassword.length === 0) {
    throw new ToolError('password-policy', {
      engine: 'mupdf',
      engineMessage: 'owner password is required: an empty owner password is not accepted',
    });
  }
  // MuPDF parses the option list itself, splitting on commas and `=`
  // (`fz_parse_pdf_write_options`); a password containing either would silently
  // produce a different option string, so it is refused instead of mangled.
  if (/[=,]/.test(options.userPassword) || /[=,]/.test(options.ownerPassword)) {
    throw new ToolError('password-policy', {
      engine: 'mupdf',
      engineMessage: 'password contains "=" or "," which the engine option list cannot carry',
    });
  }

  const bits = permissionsToBits(options.permissions);
  const restricted = PERMISSION_FIELDS.filter((field) => !options.permissions[field]).length;
  const encryptOptions = [
    'encrypt=aes-256',
    ...(options.userPassword.length > 0 ? [`user-password=${options.userPassword}`] : []),
    `owner-password=${options.ownerPassword}`,
    `permissions=${bits}`,
  ].join(',');

  const mupdf = await loadMupdf();
  throwIfAborted(context.signal);

  const doc = openPdf(mupdf, bytes);
  let produced: Uint8Array;
  let pageCount: number;
  let before: string[];
  let signed: boolean;
  try {
    // The incoming bytes may already be password-locked. Writing an encrypted
    // document without decrypting it produces streams the engine itself cannot
    // read back (measured: "aes padding out of range"), so authenticate first —
    // and the new passwords are never treated as the old credential.
    if (doc.needsPassword()) {
      const auth = doc.authenticatePassword(options.oldPassword ?? '');
      if (auth === 0) {
        throw new ToolError('wrong-password', {
          engine: 'mupdf',
          engineMessage: 'the document is password-locked and the supplied password does not open it',
        });
      }
    }
    // The authenticated input's own facts, captured while the handle is open:
    // re-protecting must not change what the document carries.
    pageCount = doc.countPages();
    before = samplePageTexts(doc, pageCount);
    // Encryption rewrites every byte the signature's /ByteRange covers.
    signed = countSignedFields(doc) > 0;
    context.onProgress?.({ phase: 'encrypt', labelKey: 'op.progress.encrypt', done: 0, total: 1 });
    produced = savePdf(doc, encryptOptions);
  } catch (error) {
    throw mapMupdfError(error, 'protect');
  } finally {
    doc.destroy();
  }
  throwIfAborted(context.signal);

  verifyProtection(mupdf, produced, options, bits);
  // Authentication is also proven by content: the produced file must still
  // carry the same pages and text sample the authenticated input showed.
  {
    const check = openPdf(mupdf, produced);
    try {
      // Sampling needs decrypted streams: the new user password is the
      // credential verifyProtection just proved (authenticatePassword === 2).
      check.authenticatePassword(options.userPassword);
      if (check.countPages() !== pageCount) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: 'protected output carries a different page count',
        });
      }
      const after = samplePageTexts(check, pageCount);
      for (let index = 0; index < before.length; index += 1) {
        if (before[index] !== after[index]) {
          throw new ToolError('verification-failed', {
            engine: 'mupdf',
            engineMessage: `page sample ${index} text differs after re-protection`,
          });
        }
      }
    } finally {
      check.destroy();
    }
  }
  context.onProgress?.({ phase: 'encrypt', labelKey: 'op.progress.encrypt', done: 1, total: 1 });

  return {
    bytes: produced,
    report: {
      engine: 'mupdf',
      steps: ['open', 'encrypt=aes-256', 'verify'],
      notes: [
        note('changed', 'op.note.security.encryptionApplied', {
          cipher: 'aes-256',
          restricted,
        }),
        ...(options.userPassword.length === 0
          ? [note('warning', 'op.note.security.opensWithoutPassword')]
          : []),
        ...(signed ? [note('lost', 'op.note.security.signatureInvalidated')] : []),
        note('preserved', 'op.note.security.verified'),
      ],
      inputBytes: bytes.byteLength,
      outputBytes: produced.byteLength,
      // Encryption rewrites the trailer with an /Encrypt dictionary; there is no
      // incremental form of it.
      incremental: false,
      pageCount,
    },
  };
}

/**
 * Re-open the produced bytes and assert the protection the user asked for.
 * A mismatch throws `verification-failed`: the caller keeps the original file and
 * the session stays dirty.
 */
function verifyProtection(mupdf: Mupdf, produced: Uint8Array, options: ProtectOptions, bits: number): void {
  const doc = openPdf(mupdf, produced);
  try {
    const cipher = cipherFromEngine(doc.getMetaData(mupdf.Document.META_ENCRYPTION));
    if (cipher !== 'aes-256') {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: `expected aes-256 output, engine reports "${cipher}"`,
      });
    }
    const needsPassword = doc.needsPassword();
    if (options.userPassword.length > 0 && !needsPassword) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: 'output opens without the user password it was encrypted with',
      });
    }
    if (options.userPassword.length === 0 && needsPassword) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: 'owner-only encryption produced a document that demands a password',
      });
    }
    // User-level authentication: the owner password unlocks every permission in
    // MuPDF and would hide a wrong bitmask.
    const auth = doc.authenticatePassword(options.userPassword);
    if (auth !== 2) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: `authenticatePassword(user) returned ${auth}, expected 2`,
      });
    }
    if (options.userPassword.length > 0 && doc.authenticatePassword('') !== 0) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: 'an empty password authenticates the output',
      });
    }
    const actual = readPermissions(doc);
    for (const field of PERMISSION_FIELDS) {
      const expected = (bits & PERMISSION_BITS[field]) !== 0;
      if (actual[field] !== expected) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `permission "${MUPDF_PERMISSION_NAMES[field]}" is ${actual[field]}, requested ${expected} (permissions=${bits})`,
        });
      }
    }
  } catch (error) {
    throw mapMupdfError(error, 'verify-protection');
  } finally {
    doc.destroy();
  }
}

/** Whether an opened document carries an `/Encrypt` dictionary, for a caller that already holds it. */
export function isEncrypted(mupdf: Mupdf, doc: PDFDocument): boolean {
  return cipherFromEngine(doc.getMetaData(mupdf.Document.META_ENCRYPTION)) !== 'none';
}

/** Read the protection state without changing the document or writing anything. */
export async function inspectProtection(bytes: Uint8Array): Promise<ProtectionState> {
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  try {
    const cipher = cipherFromEngine(doc.getMetaData(mupdf.Document.META_ENCRYPTION));
    return {
      encrypted: cipher !== 'none',
      needsPassword: doc.needsPassword(),
      cipher,
      // `hasPermission` reports the stored bitmask even before authentication
      // (measured: an unauthenticated document with all bits set answers `true` for
      // every name, one with `permissions=0` answers `false`), which is exactly what
      // the properties panel needs: what the file *stores*.
      permissions: readPermissions(doc),
    };
  } catch (error) {
    throw mapMupdfError(error, 'inspect-protection');
  } finally {
    doc.destroy();
  }
}

/**
 * Decrypt with the user password. A wrong password raises `wrong-password`
 * (Turkish text via the error contract), never a raw engine string.
 */
export async function unlockDocument(
  bytes: Uint8Array,
  password: string,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);

  let pageCount: number;
  let before: readonly string[];
  let produced: Uint8Array;
  let signed: boolean;
  try {
    const cipher = cipherFromEngine(doc.getMetaData(mupdf.Document.META_ENCRYPTION));
    if (cipher === 'none' && !doc.needsPassword()) {
      // Nothing to remove: returning the input untouched is the honest outcome, and
      // it keeps the "no unnecessary writer step" rule.
      return {
        bytes: bytes.slice(),
        report: {
          engine: 'mupdf',
          steps: ['inspect'],
          notes: [note('warning', 'op.note.security.alreadyUnprotected')],
          inputBytes: bytes.byteLength,
          outputBytes: bytes.byteLength,
          incremental: true,
          pageCount: doc.countPages(),
        },
      };
    }
    // Measured: without authentication MuPDF still writes a file, but every stream
    // in it is undecryptable garbage. Refuse here, before anything is written.
    const auth = doc.authenticatePassword(password);
    if (auth === 0) {
      throw new ToolError('wrong-password', {
        engine: 'mupdf',
        engineMessage: 'authenticatePassword returned 0',
      });
    }
    pageCount = doc.countPages();
    before = samplePageTexts(doc, pageCount);
    // Dropping the encryption rewrites every byte a signature's /ByteRange covers.
    signed = countSignedFields(doc) > 0;
    throwIfAborted(context.signal);
    context.onProgress?.({ phase: 'decrypt', labelKey: 'op.progress.decrypt', done: 0, total: 1 });
    // `encrypt=none` is the documented way to drop the /Encrypt dictionary (the
    // `decrypt` option still works but the engine warns it is deprecated:
    // "the decrypt write option is deprecated, use encrypt=none instead").
    // Measured: `garbage=compact,compress,clean` **alone keeps the encryption** —
    // an "unlock" that only changes the garbage level would hand back a file that
    // still asks for the password.
    produced = savePdf(doc, `${MUPDF_FULL_SAVE_OPTIONS},encrypt=none`);
  } catch (error) {
    throw mapMupdfError(error, 'unlock');
  } finally {
    doc.destroy();
  }
  throwIfAborted(context.signal);

  verifyUnlocked(mupdf, produced, pageCount, before);
  context.onProgress?.({ phase: 'decrypt', labelKey: 'op.progress.decrypt', done: 1, total: 1 });

  return {
    bytes: produced,
    report: {
      engine: 'mupdf',
      steps: ['open', 'authenticate', 'save(encrypt=none)', 'verify'],
      notes: [
        note('changed', 'op.note.security.protectionRemoved'),
        ...(signed ? [note('lost', 'op.note.security.signatureInvalidatedUnlock')] : []),
        note('preserved', 'op.note.security.verified'),
      ],
      inputBytes: bytes.byteLength,
      outputBytes: produced.byteLength,
      incremental: false,
      pageCount,
    },
  };
}

/**
 * The output must open without a password **and still carry the document**: the
 * measured failure mode of a mis-authenticated save is an empty text layer, not an
 * exception, so page count and a text sample are compared against the input.
 */
function verifyUnlocked(
  mupdf: Mupdf,
  produced: Uint8Array,
  pageCount: number,
  before: readonly string[],
): void {
  const doc = openPdf(mupdf, produced);
  try {
    if (doc.needsPassword()) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: 'unlocked output still needs a password',
      });
    }
    const cipher = cipherFromEngine(doc.getMetaData(mupdf.Document.META_ENCRYPTION));
    if (cipher !== 'none') {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: `unlocked output still reports encryption "${cipher}"`,
      });
    }
    const actualCount = doc.countPages();
    if (actualCount !== pageCount) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: `page count changed: ${pageCount} -> ${actualCount}`,
      });
    }
    const after = samplePageTexts(doc, pageCount);
    for (let index = 0; index < before.length; index += 1) {
      if (before[index] !== after[index]) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `page sample ${index} text differs after decryption`,
        });
      }
    }
  } catch (error) {
    throw mapMupdfError(error, 'verify-unlock');
  } finally {
    doc.destroy();
  }
}

/** Normalise a permission set for the encrypt option's integer bitmask. */
export function permissionsToBits(permissions: ProtectionPermissions): number {
  let bits = 0;
  for (const field of PERMISSION_FIELDS) {
    if (permissions[field]) bits |= PERMISSION_BITS[field];
  }
  return bits;
}

function readPermissions(doc: PDFDocument): ProtectionPermissions {
  const read = (field: keyof ProtectionPermissions): boolean =>
    doc.hasPermission(MUPDF_PERMISSION_NAMES[field]);
  return {
    print: read('print'),
    printHighQuality: read('printHighQuality'),
    copy: read('copy'),
    modify: read('modify'),
    annotate: read('annotate'),
    form: read('form'),
    assemble: read('assemble'),
    accessibility: read('accessibility'),
  };
}

/**
 * `getMetaData(META_ENCRYPTION)` answers "Standard V5 R6 256-bit AES" and friends
 * (measured for all four option strings). The product's vocabulary is the cipher
 * name only; anything the engine names differently is passed through verbatim
 * rather than guessed at.
 */
function cipherFromEngine(encryption: string | undefined): string {
  if (encryption === undefined || encryption === 'None' || encryption.length === 0) return 'none';
  if (/256-bit AES/i.test(encryption)) return 'aes-256';
  if (/128-bit AES/i.test(encryption)) return 'aes-128';
  if (/128-bit RC4/i.test(encryption)) return 'rc4-128';
  if (/40-bit RC4/i.test(encryption)) return 'rc4-40';
  return encryption;
}

/**
 * Text of up to three pages (first, middle, last) — the verification sampling
 * ("text-extraction sampling **including middle pages**"). Pages
 * without text (scans) compare as empty strings, which is why the page count is
 * checked as well.
 */
function samplePageTexts(doc: PDFDocument, pageCount: number): string[] {
  const indices = [...new Set([0, Math.floor(pageCount / 2), pageCount - 1])].filter(
    (index) => index >= 0 && index < pageCount,
  );
  return indices.map((index) => {
    const page = doc.loadPage(index);
    try {
      const text = page.toStructuredText('preserve-whitespace');
      try {
        let out = '';
        text.walk({
          onChar(c: string) {
            out += c;
          },
        });
        return out.replace(/\s+/g, ' ').trim();
      } finally {
        text.destroy();
      }
    } finally {
      page.destroy();
    }
  });
}
