/**
 * Shared driving code of the `ui-attachments`, `ui-properties`, `ui-search` and
 * `ui-snapshots` specs: documents that carry embedded files, and readers of the files the
 * panels hand out. Fixtures are built with MuPDF's object model (resolved through the
 * workspace that declares it); what a spec asserts is read back from the produced bytes.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright/test';
import { mutate } from '../packages/pdf-core/src/ops/tagged.fixtures';
import { toolFixturePdf } from './tool-fixture';

export interface EmbeddedSpec {
  /** The key of the name tree and the file name the specification carries. */
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly description?: string;
  /** Drop the `/EF` stream of the specification: a payload no reader can produce. */
  readonly withoutStream?: boolean;
}

/** UTF-8 bytes of a string. */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * The tool fixture with embedded files in its name tree, in the order given (a name tree
 * is sorted by key, so callers pass them sorted).
 */
export async function withEmbedded(
  files: readonly EmbeddedSpec[],
  base: Uint8Array = toolFixturePdf(),
): Promise<Uint8Array> {
  return mutate(base, (doc) => {
    const pairs = doc.newArray();
    for (const file of files) {
      const spec = doc.addEmbeddedFile(
        file.name,
        'application/octet-stream',
        file.bytes,
        new Date(0),
        new Date(0),
      );
      const resolved = spec.resolve();
      if (file.description !== undefined) resolved.put('Desc', doc.newString(file.description));
      if (file.withoutStream === true) resolved.delete('EF');
      pairs.push(doc.newString(file.name));
      pairs.push(spec);
    }
    const tree = doc.newDictionary();
    tree.put('Names', pairs);
    const names = doc.newDictionary();
    names.put('EmbeddedFiles', tree);
    doc.getTrailer().get('Root').resolve().put('Names', names);
  });
}

/**
 * Record every blob URL the page revokes (`URL.revokeObjectURL` still runs): a blob URL
 * cannot be fetched back under the shell's Content-Security-Policy, so the revocation
 * itself is what a spec observes. Call before the page loads.
 */
export async function trackRevocations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const revoked: string[] = [];
    Reflect.set(window, 'revokedUrls', revoked);
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      original(url);
    };
  });
}

/** The blob URLs revoked so far in the page. */
export function revokedUrls(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const revoked: unknown = Reflect.get(window, 'revokedUrls');
    return Array.isArray(revoked) ? revoked.map(String) : [];
  });
}

/**
 * Click the named left-dock tabs back to back inside one task, so the second click lands
 * before anything the first one started has answered.
 */
export async function clickTabsTogether(page: Page, names: readonly string[]): Promise<void> {
  await page.evaluate((labels) => {
    for (const label of labels) {
      const tab = document.querySelector<HTMLElement>(`[role="tab"][aria-label="${label}"]`);
      if (tab === null) throw new Error(`no ${label} tab`);
      tab.click();
    }
  }, names);
}

/** `mupdf` is a dependency of `packages/pdf-core`, not of the repository root. */
const coreRequire = createRequire(new URL('../packages/pdf-core/package.json', import.meta.url));

/** The tool fixture's fonts (one base-14 Helvetica) plus an embedded subset and a nameless font. */
export async function withFonts(base: Uint8Array = toolFixturePdf()): Promise<Uint8Array> {
  return mutate(base, (doc) => {
    const fonts = doc.findPage(0).getInheritable('Resources').get('Font');
    const dictionary = (entries: Record<string, string>) => {
      const created = doc.newDictionary();
      for (const [key, value] of Object.entries(entries)) created.put(key, doc.newName(value));
      return created;
    };

    // An embedded TrueType subset: a font file reachable from the descriptor.
    const descriptor = dictionary({ Type: 'FontDescriptor', FontName: 'ABCDEF+Embedded' });
    descriptor.put('FontFile2', doc.addStream(new Uint8Array([0, 1, 0, 0]), doc.newDictionary()));
    const embedded = dictionary({
      Type: 'Font',
      Subtype: 'TrueType',
      BaseFont: 'ABCDEF+Embedded',
      Encoding: 'MacRomanEncoding',
    });
    embedded.put('FontDescriptor', doc.addObject(descriptor));
    fonts.put('F2', doc.addObject(embedded));

    // A font whose base name is the empty name, with an encoding that is only a difference list.
    const nameless = dictionary({ Type: 'Font', Subtype: 'Type1', BaseFont: '' });
    const encoding = dictionary({ Type: 'Encoding' });
    const differences = doc.newArray();
    differences.push(doc.newInteger(65));
    differences.push(doc.newName('Aacute'));
    encoding.put('Differences', differences);
    nameless.put('Encoding', encoding);
    fonts.put('F3', doc.addObject(nameless));
  });
}

/**
 * The tool fixture saved with an owner password only, so it opens without asking for one:
 * `permissions` is the file's `/P` word (all bits set grants everything, `0xfffff0c0` nothing).
 */
export async function ownerProtected(permissions: number): Promise<Uint8Array> {
  interface Saver {
    openDocument(
      bytes: Uint8Array,
      magic: string,
    ): { saveToBuffer(options: string): { asUint8Array(): Uint8Array }; destroy(): void };
  }
  const mupdf: { readonly PDFDocument: Saver } = await import(
    pathToFileURL(coreRequire.resolve('mupdf')).href
  );
  const doc = mupdf.PDFDocument.openDocument(toolFixturePdf().slice(), 'application/pdf');
  try {
    return new Uint8Array(
      doc
        .saveToBuffer(`encrypt=aes-128,owner-password=owner,user-password=,permissions=${permissions}`)
        .asUint8Array(),
    );
  } finally {
    doc.destroy();
  }
}
