/**
 * Shared driving code of the `ui-attachments`, `ui-properties`, `ui-search` and
 * `ui-snapshots` specs: documents that carry embedded files, and readers of the files the
 * panels hand out. Fixtures are built with MuPDF's object model (resolved through the
 * workspace that declares it); what a spec asserts is read back from the produced bytes.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright/test';
import {
  appendRevision,
  documentObjects,
  latin1,
  seal,
  signatureDictionary,
} from '../packages/pdf-core/src/ops/signature-status.fixtures';
import { mutate } from '../packages/pdf-core/src/ops/tagged.fixtures';
import { detachedCmsSignature } from '../packages/pdf-core/src/signature-cms';
import {
  CRL_REASON,
  deltaIndicatorExtension,
  extKeyUsageExtension,
  issueCrl,
  issueTimestampToken,
  KP_TIME_STAMPING,
  signatureValueOf,
  withUnsigned,
} from '../packages/pdf-core/src/signature-revocation.fixtures';
import {
  type CertificateFixture,
  generateKey,
  type IssueOptions,
  issueCertificate,
} from '../packages/pdf-core/src/signature-trust.fixtures';
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

/* ------------------------------------------------------------------ *
 * Signed documents: real CMS over real byte ranges, built in Node
 * ------------------------------------------------------------------ */

const DAY = 86_400_000;

/** A date `days` from now: the browser judges certificates against its own clock. */
export const fromNow = (days: number): Date => new Date(Math.floor((Date.now() + days * DAY) / 1000) * 1000);

export interface SigningPki {
  readonly root: CertificateFixture;
  readonly leaf: CertificateFixture;
  readonly expiredLeaf: CertificateFixture;
  readonly tsa: CertificateFixture;
  readonly stranger: CertificateFixture;
}

/** One small PKI around the clock of the run: a root, leaves under it, a time-stamping authority. */
let pkiOnce: Promise<SigningPki> | undefined;

/** The same PKI for every caller of one worker: a root imported for one document must be the one that signed it. */
export function signingPki(): Promise<SigningPki> {
  pkiOnce ??= buildPki();
  return pkiOnce;
}

async function buildPki(): Promise<SigningPki> {
  const ec = () => generateKey({ kind: 'EC', curve: 'P-256' });
  const ca = async (subject: string) =>
    issueCertificate({
      subject,
      keyPair: await ec(),
      notBefore: fromNow(-900),
      notAfter: fromNow(900),
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign', 'cRLSign'],
    });
  const root = await ca('Panel Root CA');
  const end = async (subject: string, extra: Partial<IssueOptions> = {}) =>
    issueCertificate(
      {
        subject,
        keyPair: await ec(),
        notBefore: fromNow(-800),
        notAfter: fromNow(800),
        basicConstraints: { cA: false },
        keyUsage: ['digitalSignature'],
        ...extra,
      },
      root,
    );
  return {
    root,
    leaf: await end('Panel Signer'),
    expiredLeaf: await end('Lapsed Signer', { notBefore: fromNow(-700), notAfter: fromNow(-30) }),
    tsa: await end('Panel TSA', { extraExtensions: [extKeyUsageExtension([KP_TIME_STAMPING])] }),
    stranger: await ca('Stranger CA'),
  };
}

/** The product's own detached CMS by `signer`, carrying `chain`, claiming `signedAt`. */
export function cmsBy(
  signer: CertificateFixture,
  chain: readonly CertificateFixture[],
  signedAt: Date,
): (covered: Uint8Array) => Promise<Uint8Array> {
  return async (covered) =>
    (
      await detachedCmsSignature(
        covered,
        {
          certificate: signer.der,
          chain: chain.map((entry) => entry.der),
          privateKey: signer.keyPair.privateKey,
        },
        { signedAt },
      )
    ).der;
}

const CAPACITY = 8192;

export interface SignedOptions {
  /** `ETSI.RFC3161` makes the signature a document timestamp; `null` writes no `/SubFilter`. */
  readonly subFilter?: string | null;
  /** `null` leaves the signature dictionary without a `/M` date. */
  readonly date?: null;
  /** `null` leaves the signature field without a `/T` name. */
  readonly fieldName?: null;
  /** Text added to the catalog (a `/DSS` entry). */
  readonly catalogExtra?: string;
  /** Extra indirect objects (the `/DSS` and its streams); numbers from 20. */
  readonly extraObjects?: readonly { readonly number: number; readonly body: string }[];
  /** Revisions appended after the signature: each adds an object. */
  readonly revisions?: number;
}

/** A stream object body of raw bytes. */
export const streamBody = (data: Uint8Array): string =>
  `<< /Length ${data.length} >>\nstream\n${latin1(data)}\nendstream`;

/** A one-page document with one signature field, sealed over its whole first revision. */
export async function signedDocument(
  produce: (covered: Uint8Array) => Promise<Uint8Array> | Uint8Array,
  options: SignedOptions = {},
): Promise<Uint8Array> {
  const dictionary = signatureDictionary({
    capacity: CAPACITY,
    encoding: 'hex',
    ...(options.subFilter === undefined ? {} : { subFilter: options.subFilter }),
    ...(options.date === null ? { date: null } : {}),
  });
  const extra = options.extraObjects ?? [];
  const written = appendRevision(new Uint8Array(), {
    objects: [
      ...documentObjects(dictionary, {
        ...(options.catalogExtra === undefined ? {} : { catalogExtra: options.catalogExtra }),
        ...(options.fieldName === null ? { fieldName: null } : {}),
      }),
      ...extra,
    ],
    size: 6 + extra.length + 20,
  });
  let bytes = await seal(
    written.bytes,
    { capacity: CAPACITY, encoding: 'hex', from: written.offsets.get(5) ?? 0 },
    produce,
  );
  let previous = [...latin1(bytes).matchAll(/startxref\n(\d+)\n/g)].at(-1)?.[1];
  for (let index = 0; index < (options.revisions ?? 0); index += 1) {
    const number = 100 + index;
    const next = appendRevision(bytes, {
      objects: [{ number, body: `<< /Note (revision ${index + 1}) >>` }],
      size: number + 1,
      prev: Number(previous),
    });
    bytes = next.bytes;
    previous = String(next.xrefAt);
  }
  return bytes;
}

/** A DER certificate or CRL as a PEM file's text. */
export function pem(label: string, der: Uint8Array): string {
  const lines =
    Buffer.from(der)
      .toString('base64')
      .match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** A signature carrying a timestamp token by `tsa` over its own value, issued at `genTime`. */
export function cmsWithTimestamp(
  signer: CertificateFixture,
  chain: readonly CertificateFixture[],
  signedAt: Date,
  tsa: CertificateFixture,
  genTime: Date,
): (covered: Uint8Array) => Promise<Uint8Array> {
  return async (covered) => {
    const cms = await cmsBy(signer, chain, signedAt)(covered);
    const token = await issueTimestampToken({
      tsa,
      covered: signatureValueOf(cms),
      genTime,
      extraCertificates: chain,
    });
    return withUnsigned(cms, { timestampToken: token });
  };
}

/** A CRL by `issuer` listing `revoked` (keyCompromise), valid from `thisUpdate` to `nextUpdate`. */
export function crlBy(
  issuer: CertificateFixture,
  thisUpdate: Date,
  nextUpdate: Date | undefined,
  revoked: readonly { readonly cert: CertificateFixture; readonly at: Date }[] = [],
  options: { readonly delta?: boolean } = {},
): Promise<Uint8Array> {
  return issueCrl({
    issuer,
    thisUpdate,
    ...(nextUpdate === undefined ? {} : { nextUpdate }),
    revoked: revoked.map((entry) => ({ ...entry, reason: CRL_REASON.keyCompromise })),
    ...(options.delta === true ? { extensions: [deltaIndicatorExtension()] } : {}),
  });
}

/** The /DSS of a document archiving CRLs: the catalog entry and the objects it names. */
export function dssWithCrls(
  crls: readonly Uint8Array[],
): Pick<SignedOptions, 'catalogExtra' | 'extraObjects'> {
  return {
    catalogExtra: ' /DSS 20 0 R',
    extraObjects: [
      { number: 20, body: `<< /CRLs [${crls.map((_, index) => `${21 + index} 0 R`).join(' ')}] >>` },
      ...crls.map((crl, index) => ({ number: 21 + index, body: streamBody(crl) })),
    ],
  };
}

/** Import a certificate file through the panel's "Import certificate" control. */
export async function importRootFiles(
  page: Page,
  files: readonly { readonly name: string; readonly buffer: Buffer }[],
): Promise<void> {
  await page
    .locator('input[type="file"][accept*=".crt"]')
    .setInputFiles(files.map((file) => ({ ...file, mimeType: 'application/octet-stream' })));
}

/** Import CRL files through the panel's "Import CRL" control. */
export async function importCrlFiles(
  page: Page,
  files: readonly { readonly name: string; readonly buffer: Buffer }[],
): Promise<void> {
  await page
    .locator('input[type="file"][accept*=".crl"]')
    .setInputFiles(files.map((file) => ({ ...file, mimeType: 'application/octet-stream' })));
}

export { issueTimestampToken };

export interface LabelRange {
  /** The 0-based page the numbering starts on. */
  readonly from: number;
  /** `D` decimal, `r` lower roman, `A` upper letters… */
  readonly style?: string;
  readonly prefix?: string;
}

/** `base` with a `/PageLabels` number tree: the labels other readers show for its pages. */
export async function withPageLabels(base: Uint8Array, ranges: readonly LabelRange[]): Promise<Uint8Array> {
  return mutate(base, (doc) => {
    const numbers = doc.newArray();
    for (const range of ranges) {
      numbers.push(doc.newInteger(range.from));
      const entry = doc.newDictionary();
      if (range.style !== undefined) entry.put('S', doc.newName(range.style));
      if (range.prefix !== undefined) entry.put('P', doc.newString(range.prefix));
      numbers.push(entry);
    }
    const labels = doc.newDictionary();
    labels.put('Nums', numbers);
    doc.getTrailer().get('Root').resolve().put('PageLabels', labels);
  });
}

export interface OutlineSpec {
  readonly title: string;
  /** 1-based page the entry goes to; `null` leaves it without a destination. */
  readonly page: number | null;
  readonly children?: readonly OutlineSpec[];
}

/** `base` with a bookmark tree, written with MuPDF's outline iterator. */
export async function withOutline(base: Uint8Array, entries: readonly OutlineSpec[]): Promise<Uint8Array> {
  return mutate(base, (doc) => {
    const iterator = doc.outlineIterator();
    const write = (level: readonly OutlineSpec[]): void => {
      for (const entry of level) {
        iterator.insert({
          title: entry.title,
          open: true,
          uri: entry.page === null ? undefined : `#page=${entry.page}`,
        });
        if (entry.children !== undefined && entry.children.length > 0) {
          iterator.prev();
          iterator.down();
          write(entry.children);
          iterator.up();
          iterator.next();
        }
      }
    };
    write(entries);
  });
}

/** `base` with the given page boxes (`[width, height]` per page, origin zero). */
export async function withPageSizes(
  base: Uint8Array,
  sizes: readonly (readonly [number, number])[],
): Promise<Uint8Array> {
  return mutate(base, (doc) => {
    for (const [index, [width, height]] of sizes.entries()) {
      const box = doc.newArray();
      for (const value of [0, 0, width, height]) box.push(doc.newInteger(value));
      doc.findPage(index).put('MediaBox', box);
    }
  });
}

export interface PrintedSheet {
  /** The inline CSS size the sheet pins (`''` when the stylesheet decides, as in "fit"). */
  readonly styleWidth: string;
  readonly styleHeight: string;
  /** The raster the page was drawn into. */
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

/**
 * Stand in for the browser's print dialog, which no automated browser can show: `window.print`
 * records the sheets in the document at that moment and then reports the job as over
 * (`afterprint`), as a closed dialog does. Everything before that call is the editor's own.
 * Call before the page loads.
 */
export async function spyOnPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const jobs: unknown[] = [];
    Reflect.set(window, 'printJobs', jobs);
    window.print = () => {
      const sheets = [...document.querySelectorAll<HTMLImageElement>('.pdf-print-root img')].map((image) => ({
        styleWidth: image.style.width,
        styleHeight: image.style.height,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      }));
      jobs.push(sheets);
      setTimeout(() => window.dispatchEvent(new Event('afterprint')), 0);
    };
  });
}

/** The sheets of every print job so far, one list per `window.print()` call. */
export function printedJobs(page: Page): Promise<readonly (readonly PrintedSheet[])[]> {
  return page.evaluate(() => {
    const jobs: unknown = Reflect.get(window, 'printJobs');
    return Array.isArray(jobs) ? jobs : [];
  });
}

export interface SpeechVoiceSpec {
  readonly name: string;
  readonly lang: string;
  readonly localService: boolean;
}

export interface SpokenUtterance {
  readonly text: string;
  readonly rate: number;
  readonly voice: string | null;
  readonly lang: string;
}

/**
 * Stand in for the platform's speech engine, which an automated browser has no voices for: a
 * `speechSynthesis` with the given voices that records every utterance (text, rate, voice,
 * language) and every `cancel`/`pause`/`resume`, and speaks one utterance at a time until the
 * test says it is done (`finishSpeaking`) or has failed (`failSpeaking`). Call before the page loads.
 */
export async function stubSpeech(page: Page, voices: readonly SpeechVoiceSpec[]): Promise<void> {
  await page.addInitScript((installed) => {
    interface Fake {
      text: string;
      voice: { name: string } | null;
      lang: string;
      rate: number;
      onstart: (() => void) | null;
      onend: (() => void) | null;
      onerror: (() => void) | null;
    }
    const log = { utterances: [] as unknown[], events: [] as string[] };
    Reflect.set(window, 'speechLog', log);
    const queue: Fake[] = [];
    let current: Fake | null = null;
    let paused = false;
    const next = () => {
      if (current !== null || paused) return;
      const upcoming = queue.shift();
      if (upcoming === undefined) return;
      current = upcoming;
      upcoming.onstart?.();
    };
    class Utterance {
      voice: { name: string } | null = null;
      lang = '';
      rate = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    const voiceObjects = installed.map((voice) => ({ ...voice, default: false, voiceURI: voice.name }));
    const synthesis = {
      getVoices: () => voiceObjects,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      get speaking() {
        return current !== null;
      },
      get paused() {
        return paused;
      },
      speak(utterance: Fake) {
        log.utterances.push({
          text: utterance.text,
          rate: utterance.rate,
          voice: utterance.voice?.name ?? null,
          lang: utterance.lang,
        });
        queue.push(utterance);
        setTimeout(next, 0);
      },
      cancel() {
        log.events.push('cancel');
        queue.length = 0;
        current = null;
        paused = false;
      },
      pause() {
        log.events.push('pause');
        paused = true;
      },
      resume() {
        log.events.push('resume');
        paused = false;
        setTimeout(next, 0);
      },
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synthesis, configurable: true });
    Reflect.set(window, 'SpeechSynthesisUtterance', Utterance);
    Reflect.set(window, 'engineSpeaking', () => current !== null);
    Reflect.set(window, 'finishSpeaking', () => {
      const done = current;
      current = null;
      done?.onend?.();
      next();
    });
    Reflect.set(window, 'failSpeaking', () => {
      const failed = current;
      current = null;
      failed?.onerror?.();
    });
  }, voices);
}

/** What the stubbed engine was asked to speak, in order, and the controls it was given. */
export function speechLog(
  page: Page,
): Promise<{ utterances: readonly SpokenUtterance[]; events: readonly string[] }> {
  return page.evaluate(() => {
    const log: unknown = Reflect.get(window, 'speechLog');
    return typeof log === 'object' && log !== null
      ? (log as { utterances: SpokenUtterance[]; events: string[] })
      : { utterances: [], events: [] };
  });
}

/**
 * Resolves once the stubbed engine has started an utterance. The stub starts the queue on a timer
 * after `speak`, as the platform engine does, so a click that queues a reading returns before
 * anything is being spoken, and again after every restart that cancels the queue and queues it anew.
 */
export async function untilSpeaking(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const speaking: unknown = Reflect.get(window, 'engineSpeaking');
    return typeof speaking === 'function' && speaking() === true;
  });
}

/**
 * The current utterance ends (`end`) or fails (`error`), as the engine would report it. An engine
 * with nothing started has nothing to end, so this waits for the utterance first.
 */
export async function endUtterance(page: Page, how: 'end' | 'error' = 'end'): Promise<void> {
  await untilSpeaking(page);
  await page.evaluate((outcome) => {
    const action: unknown = Reflect.get(window, outcome === 'end' ? 'finishSpeaking' : 'failSpeaking');
    if (typeof action === 'function') action();
  }, how);
}
