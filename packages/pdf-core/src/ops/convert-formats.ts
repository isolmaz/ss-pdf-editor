/**
 * Which files the converter to PDF reads (`ops/convert.ts`), by extension — in a module of
 * its own with no dependencies, so the shell can ask "is this a document I can convert?"
 * on every open without loading the converters themselves (JSZip, an XML parser and
 * mammoth stay in their own chunk until a conversion runs).
 */

export type ConvertFormat = 'docx' | 'xlsx' | 'pptx' | 'html' | 'txt' | 'csv' | 'tsv' | 'epub' | 'fb2';

/** File extension → format. Legacy binary Office files (`.doc`, `.xls`, `.ppt`) are not here. */
const EXTENSIONS: Readonly<Record<string, ConvertFormat>> = {
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  txt: 'txt',
  text: 'txt',
  md: 'txt',
  markdown: 'txt',
  log: 'txt',
  csv: 'csv',
  tsv: 'tsv',
  epub: 'epub',
  fb2: 'fb2',
};

/** The picker's `accept` list for every convertible file. */
export const CONVERT_ACCEPT = Object.keys(EXTENSIONS)
  .map((extension) => `.${extension}`)
  .join(',');

/** The display name of a format, for notices ("DOCX"). */
export function formatLabel(format: ConvertFormat): string {
  return format.toUpperCase();
}

/** The format a file name says, or `null` when it is not one this module converts. */
export function convertFormatOf(name: string): ConvertFormat | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The same list as the File System Access picker wants it: a media type → its extensions. */
export const CONVERT_PICKER_ACCEPT: Readonly<Record<`${string}/${string}`, `.${string}`[]>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'text/html': ['.html', '.htm'],
  'application/xhtml+xml': ['.xhtml'],
  'text/plain': ['.txt', '.text', '.md', '.markdown', '.log'],
  'text/csv': ['.csv'],
  'text/tab-separated-values': ['.tsv'],
  'application/epub+zip': ['.epub'],
  'application/x-fictionbook+xml': ['.fb2'],
};

/** The file name a converted document gets: the source's name with `.pdf`. */
export function pdfNameFor(name: string): string {
  const base = name.split(/[/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return `${dot > 0 ? base.slice(0, dot) : base}.pdf`;
}

/** Pictures a drop or an open turns into a PDF through `ops/images.ts`. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff']);

/** Formats people expect to open that no converter here reads: said plainly, not "corrupt". */
const UNSUPPORTED_EXTENSIONS = new Set([
  'doc',
  'xls',
  'ppt',
  'odt',
  'ods',
  'odp',
  'rtf',
  'pages',
  'numbers',
  'key',
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

/** The upper-case extension of a known but unconvertible document (`DOC`), or `null`. */
export function unsupportedDocumentKind(name: string): string | null {
  const extension = extensionOf(name);
  return UNSUPPORTED_EXTENSIONS.has(extension) ? extension.toUpperCase() : null;
}
