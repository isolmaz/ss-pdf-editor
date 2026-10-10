/**
 * Ghostscript's `pdfwrite` as a PDF/A converter: what to hand the engine and what to read
 * back. No browser API, no worker, no engine import: the module factory is passed in, so the
 * same code runs in the worker (`ghostscript-worker.ts`) and in Node (the unit tests, the
 * behaviour checks).
 *
 * ## Why Ghostscript
 *
 * Producing PDF/A means rewriting colour, fonts and structure, not stamping a flag. The
 * options were measured, not assumed (`docs/architecture.md` §5.9):
 *
 *  - Ghostscript 10.06 (AGPL-3.0, the licence of this project) does it as a mode of its PDF
 *    writer: `-dPDFA=1|2|3` converts every colour to the output intent's space, embeds every
 *    font (a font the file does not carry is replaced by an equivalent from Ghostscript's own
 *    set, which is the only honest way to embed one that is not there), flattens transparency
 *    for part 1, and writes the XMP packet from the Information dictionary. veraPDF 1.30
 *    accepted its output on every fixture the conversion was measured with.
 *  - Writing PDF/A through MuPDF would mean doing all of that ourselves: MuPDF has no colour
 *    conversion on write, cannot embed a font that is not in the file, and cannot flatten
 *    transparency.
 *
 * ## What the engine needs from us
 *
 * Without an output intent Ghostscript writes `DeviceRGB` and no `/OutputIntents`, which part
 * 1, 2 and 3 all reject (veraPDF 6.2.4.3). The intent is described by a PostScript prefix
 * (`PDFA_def.ps`, written here) that embeds an sRGB ICC profile. The profile is **not** a
 * shipped asset: it is the one Ghostscript itself converts with, read out of its read-only
 * file system (`%rom%iccprofiles/default_rgb.icc`) at run time, so the intent describes
 * exactly the colours the engine produced.
 */

export type PdfAPartNumber = 1 | 2 | 3;

/** What of the Information dictionary the output keeps (the XMP packet is built from it). */
export interface PdfaDocumentInfo {
  readonly title: string | null;
  readonly author: string | null;
  readonly subject: string | null;
  readonly keywords: string | null;
  readonly creator: string | null;
  /** A PDF date string (`D:YYYYMMDDHHmmSS…`), or `null` for "now". */
  readonly creationDate: string | null;
  /** `/Lang` of the catalog, or `null`. */
  readonly language: string | null;
}

export interface PdfaRunRequest {
  readonly input: Uint8Array;
  readonly part: PdfAPartNumber;
  readonly info: PdfaDocumentInfo;
}

export interface PdfaRunResult {
  readonly output: Uint8Array;
  readonly exitCode: number;
  /** Ghostscript's own warnings, each once, in the order first seen, with how often it said it. */
  readonly warnings: readonly { readonly text: string; readonly count: number }[];
  readonly pageCount: number;
}

/** The slice of the Emscripten module the conversion uses. */
export interface GhostscriptModule {
  callMain(args: string[]): number;
  readonly FS: {
    writeFile(path: string, data: string | Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
}

export interface GhostscriptFactoryOptions {
  readonly print: (text: string) => void;
  readonly printErr: (text: string) => void;
}

export type GhostscriptFactory = (options: GhostscriptFactoryOptions) => Promise<GhostscriptModule>;

/**
 * The factory over the emscripten loader at `js` (a URL the runtime can import) with its
 * `wasm` beside it. The loader is imported at runtime, never bundled: it is the pinned
 * artefact, byte for byte, served from our own origin.
 */
export function ghostscriptFactory(js: string, wasm: string): GhostscriptFactory {
  return async ({ print, printErr }) => {
    const loader = (await import(/* @vite-ignore */ js)) as {
      default: (options: {
        locateFile: (name: string) => string;
        print: (text: string) => void;
        printErr: (text: string) => void;
      }) => Promise<GhostscriptModule>;
    };
    return loader.default({
      locateFile: (name) => (name.endsWith('.wasm') ? wasm : name),
      print,
      printErr,
    });
  };
}

const INPUT = '/tmp/input.pdf';
const OUTPUT = '/tmp/output.pdf';
const PROFILE = '/tmp/srgb.icc';
const DEFINITION = '/tmp/PDFA_def.ps';
const PROFILE_COPY = '/tmp/profile-copy.ps';

/** Ghostscript's own copy of its default RGB profile, in its read-only file system. */
const ROM_PROFILE = '%rom%iccprofiles/default_rgb.icc';

/** What the output intent calls the profile (the registry name of the sRGB colour space). */
export const OUTPUT_CONDITION = 'sRGB IEC61966-2.1';

/**
 * A PDF text string as PostScript: a literal when it is plain ASCII, otherwise UTF-16BE with
 * a byte-order mark as a hex string — the two encodings a PDF text string may use.
 */
export function postScriptString(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return `(${value.replace(/[\\()]/g, (character) => `\\${character}`)})`;
  let hex = 'FEFF';
  for (let index = 0; index < value.length; index += 1) {
    hex += value.charCodeAt(index).toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

/**
 * The `PDFA_def.ps` prefix: the Information dictionary, the document language and one output
 * intent carrying the sRGB profile. `PROFILE` is read by Ghostscript when the prefix runs.
 */
export function pdfaDefinition(info: PdfaDocumentInfo): string {
  const entries: string[] = [];
  const add = (key: string, value: string | null): void => {
    if (value !== null && value !== '') entries.push(`  /${key} ${postScriptString(value)}`);
  };
  add('Title', info.title);
  add('Author', info.author);
  add('Subject', info.subject);
  add('Keywords', info.keywords);
  add('Creator', info.creator);
  add('CreationDate', info.creationDate);
  return [
    '%!',
    '% PDF/A definition for pdfwrite: document information, language and an sRGB output intent.',
    '[',
    ...entries,
    '  /DOCINFO pdfmark',
    ...(info.language === null || info.language === ''
      ? []
      : [`[{Catalog} <</Lang ${postScriptString(info.language)}>> /PUT pdfmark`]),
    '[/_objdef {icc_PDFA} /type /stream /OBJ pdfmark',
    '[{icc_PDFA} <</N 3>> /PUT pdfmark',
    `[{icc_PDFA} (${PROFILE}) (r) file /PUT pdfmark`,
    '[/_objdef {OutputIntent_PDFA} /type /dict /OBJ pdfmark',
    '[{OutputIntent_PDFA} <<',
    '  /Type /OutputIntent',
    '  /S /GTS_PDFA1',
    '  /DestOutputProfile {icc_PDFA}',
    `  /OutputConditionIdentifier (${OUTPUT_CONDITION})`,
    `  /Info (${OUTPUT_CONDITION})`,
    '  /RegistryName (http://www.color.org)',
    '>> /PUT pdfmark',
    '[{Catalog} <</OutputIntents [ {OutputIntent_PDFA} ]>> /PUT pdfmark',
    '',
  ].join('\n');
}

/** PostScript that copies Ghostscript's sRGB profile out of its ROM into the working file system. */
const PROFILE_COPY_SOURCE = `%!
/buffer 65536 string def
/source (${ROM_PROFILE}) (r) file def
/target (${PROFILE}) (w) file def
{ source buffer readstring { target exch writestring } { target exch writestring exit } ifelse } loop
target closefile
source closefile
`;

/**
 * The command line of the conversion.
 *
 *  - `-dPDFACompatibilityPolicy=1`: where the input has something the part forbids, drop it and
 *    say so (the warnings are reported) instead of stopping, because a conversion that stops on
 *    the first non-printing annotation converts nothing. The result is checked afterwards.
 *  - `-sColorConversionStrategy=RGB`: every colour goes to the intent's space.
 *  - `-dAutoRotatePages=/None`: the default would turn pages by the direction of their text.
 *  - `-dUseCropBox`: the converter reads the media box by default; the page the user sees is
 *    the crop box, and part 1 and 2 files carry one box in practice.
 *  - No downsampling and no image recompression beyond what colour conversion requires.
 */
export function ghostscriptArguments(part: PdfAPartNumber): string[] {
  return [
    '-dBATCH',
    '-dNOPAUSE',
    '-sDEVICE=pdfwrite',
    `-sOutputFile=${OUTPUT}`,
    `--permit-file-read=${PROFILE}`,
    `-dPDFA=${part}`,
    '-dPDFACompatibilityPolicy=1',
    '-sColorConversionStrategy=RGB',
    '-dAutoRotatePages=/None',
    '-dUseCropBox',
    '-dDownsampleColorImages=false',
    '-dDownsampleGrayImages=false',
    '-dDownsampleMonoImages=false',
    '-dEmbedAllFonts=true',
    DEFINITION,
    INPUT,
  ];
}

/**
 * Ghostscript writes a warning as `GPL Ghostscript 10.06.0: <first line>,` and continues it on
 * lines that begin with a space or a tab. Rejoin them and drop the prefix.
 */
export function collectWarnings(lines: readonly string[]): { text: string; count: number }[] {
  const messages: string[] = [];
  for (const line of lines) {
    if (/^GPL Ghostscript [\d.]+:/.test(line)) messages.push(line.replace(/^GPL Ghostscript [\d.]+:\s*/, ''));
    else if (/^[ \t]/.test(line) && messages.length > 0) messages[messages.length - 1] += ` ${line.trim()}`;
    else if (line.trim() !== '') messages.push(line.trim());
  }
  const counts = new Map<string, number>();
  for (const message of messages) {
    const text = message.replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
    if (text !== '') counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts].map(([text, count]) => ({ text, count }));
}

function exitStatus(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

/**
 * Run the conversion on a fresh module instance. Throws when the engine produced no output;
 * a non-zero exit with an output is returned (`exitCode`) and left to the caller's checks.
 */
export async function runPdfaConversion(
  factory: GhostscriptFactory,
  request: PdfaRunRequest,
  onPage?: (page: number, total: number) => void,
): Promise<PdfaRunResult> {
  const errors: string[] = [];
  let total = 0;
  let pages = 0;
  const gs = await factory({
    print: (text) => {
      const range = /^Processing pages \d+ through (\d+)/.exec(text);
      if (range !== null) total = Number(range[1]);
      const page = /^Page (\d+)$/.exec(text);
      if (page !== null) {
        pages = Number(page[1]);
        onPage?.(pages, total);
      }
    },
    printErr: (text) => {
      errors.push(text);
    },
  });
  gs.FS.writeFile(PROFILE_COPY, PROFILE_COPY_SOURCE);
  gs.callMain([
    '-dBATCH',
    '-dNOPAUSE',
    '-dQUIET',
    `--permit-file-read=${ROM_PROFILE.replace(/[^/]*$/, '')}`,
    `--permit-file-write=${PROFILE}`,
    PROFILE_COPY,
  ]);
  gs.FS.writeFile(DEFINITION, pdfaDefinition(request.info));
  gs.FS.writeFile(INPUT, request.input);

  let exitCode = 0;
  try {
    exitCode = gs.callMain(ghostscriptArguments(request.part));
  } catch (error) {
    // Emscripten reports the exit status of `main` as a thrown value when the program exits.
    const status = exitStatus(error);
    if (status === null) throw error;
    exitCode = status;
  }
  let output: Uint8Array;
  try {
    output = gs.FS.readFile(OUTPUT);
  } catch {
    output = new Uint8Array(0);
  }
  for (const path of [INPUT, OUTPUT, DEFINITION, PROFILE, PROFILE_COPY]) {
    try {
      gs.FS.unlink(path);
    } catch {
      // Already gone; the module is dropped right after anyway.
    }
  }
  return { output, exitCode, warnings: collectWarnings(errors), pageCount: pages };
}
