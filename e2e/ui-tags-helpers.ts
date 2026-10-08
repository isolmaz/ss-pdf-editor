/**
 * Shared driving code of `ui-tags.spec.ts`: the tagged and untagged documents it opens, the
 * panel's rows as a user reads them, and an independent readback of the produced file's
 * structure tree (MuPDF's object model, walked here, not the editor's own reader).
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Locator, Page } from 'playwright/test';
import { buildTagged, type TNode, tagged } from '../packages/pdf-core/src/ops/tagged.fixtures';
import { expect } from './test';

/** The page box of the fixtures below (points). */
export const TAGS_PAGE = { width: 300, height: 300 } as const;

const line = (mcid: number, tag: string, x: number, y: number, text: string): string =>
  tagged(tag, mcid, `BT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET`);

const picture = (mcid: number, x: number, y: number): string =>
  tagged('Figure', mcid, `q 30 0 0 30 ${x} ${y} cm /Im1 Do Q`);

const FONT = { F1: { dict: { Subtype: 'Type1', BaseFont: 'Helvetica' } } } as const;

/** The first page of the tagged fixture: a heading, two paragraphs, two pictures, a table, a link. */
const PAGE_ONE =
  line(0, 'H1', 20, 270, 'Annual report') +
  line(1, 'P', 20, 245, 'First paragraph') +
  line(2, 'P', 20, 225, 'Second paragraph') +
  picture(3, 20, 180) +
  picture(4, 120, 180) +
  line(5, 'TH', 20, 150, 'Quarter') +
  line(6, 'TH', 110, 150, 'Result') +
  line(7, 'TD', 20, 130, 'Q1') +
  line(8, 'TD', 110, 130, 'Good') +
  line(9, 'P', 20, 105, 'Custom text') +
  line(10, 'P', 20, 85, 'Linked text') +
  line(11, 'P', 20, 65, 'Direct text');

const PAGE_TWO = line(0, 'P', 20, 270, 'Page two text');

/**
 * A tagged two-page document. Document → Sect A (H1, P, P), Sect B (a Figure without a
 * description, a Figure with one, a Table), Sect C on page two (P), then a role the RoleMap
 * maps (`Custom` → P), a role it does not (`Weird`), a P that owns a link annotation, and a
 * direct (non-editable) P.
 */
export async function taggedFixture(
  options: { readonly strayDelimiter?: boolean } = {},
): Promise<Uint8Array> {
  const tree: readonly TNode[] = [
    {
      s: 'Document',
      pg: 0,
      k: [
        {
          s: 'Sect',
          k: [
            { s: 'H1', k: [0] },
            { s: 'P', k: [1] },
            { s: 'P', k: [2] },
          ],
        },
        {
          s: 'Sect',
          k: [
            { s: 'Figure', k: [3] },
            { s: 'Figure', alt: 'Company logo', k: [4] },
            {
              s: 'Table',
              k: [
                {
                  s: 'TR',
                  k: [
                    { s: 'TH', k: [5] },
                    { s: 'TH', k: [6] },
                  ],
                },
                {
                  s: 'TR',
                  k: [
                    { s: 'TD', k: [7] },
                    { s: 'TD', k: [8] },
                  ],
                },
              ],
            },
          ],
        },
        { s: 'Sect', pg: 1, k: [{ s: 'P', k: [0] }] },
        { s: 'Custom', k: [9] },
        { s: 'Weird' },
        { s: 'P', k: [10, { objr: [0, 0] }] },
        { s: 'P', direct: true, k: [11] },
      ],
    },
  ];
  const built = await buildTagged({
    pages: [
      {
        content:
          options.strayDelimiter === true
            ? `${PAGE_ONE}
]
`
            : PAGE_ONE,
        fonts: FONT,
        image: true,
        box: [0, 0, TAGS_PAGE.width, TAGS_PAGE.height],
        annots: [{ subtype: 'Link', extra: { Border: [0, 0, 0] } }],
        structParents: 0,
      },
      { content: PAGE_TWO, fonts: FONT, box: [0, 0, TAGS_PAGE.width, TAGS_PAGE.height] },
    ],
    tree,
    roleMap: { Custom: 'P' },
    parentTree: true,
    markInfo: true,
    lang: 'en-US',
    title: 'Tagged fixture',
  });
  return built.bytes;
}

/** The rows of the tree as a user reads them: one entry per visible element. */
export function treeRows(page: Page): Locator {
  return page.getByRole('tree', { name: 'Structure tree' }).getByRole('treeitem');
}

/** One row by the element's role and the text it shows (a prefix of the label). */
export function rowOf(page: Page, role: string, label?: string): Locator {
  const rows = page.locator(`[role="treeitem"][data-tag-role="${role}"]`);
  return label === undefined ? rows.first() : rows.filter({ hasText: label }).first();
}

/** Open the Accessibility tab's Tags view and wait for the tree. */
export async function openTagsView(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Accessibility', exact: true }).click();
  await page.locator('[data-a11y-tab="tags"]').click();
  await expect(page.locator('[data-tags-mode]')).toBeVisible({ timeout: 60_000 });
}

/** The draft counter the panel shows. */
export const draftCount = async (page: Page): Promise<number> =>
  Number(await page.locator('[data-tags-draft]').getAttribute('data-tags-draft'));

/* ------------------------------------------------------------------ *
 * Readback
 * ------------------------------------------------------------------ */

const coreRequire = createRequire(new URL('../packages/pdf-core/package.json', import.meta.url));

interface PdfObjectLike {
  isNull(): boolean;
  isArray(): boolean;
  isDictionary(): boolean;
  isName(): boolean;
  isString(): boolean;
  isNumber(): boolean;
  isStream(): boolean;
  asName(): string;
  asString(): string;
  asNumber(): number;
  asIndirect(): number;
  readStream(): { asString(): string };
  resolve(): PdfObjectLike;
  get(...path: (string | number)[]): PdfObjectLike;
  readonly length: number;
}

interface PdfReadLike {
  getTrailer(): PdfObjectLike;
  countPages(): number;
  findPage(index: number): PdfObjectLike;
  destroy(): void;
}

interface MupdfReadLike {
  PDFDocument: {
    openDocument(bytes: Uint8Array, magic: string): { asPDF(): PdfReadLike | null };
  };
}

/** An element of the produced file's structure tree. */
export interface ReadElement {
  readonly role: string;
  readonly alt: string | null;
  readonly scope: string | null;
  /** The page index of the element's own `/Pg`, `null` without one. */
  readonly page: number | null;
  /** Marked-content ids the element owns directly. */
  readonly mcids: readonly number[];
  readonly kids: readonly ReadElement[];
}

export interface ReadTags {
  readonly root: ReadElement;
  /** The page content streams, one string per page (every stream of `/Contents` joined). */
  readonly contents: readonly string[];
  readonly lang: string | null;
}

function textOf(value: PdfObjectLike): string | null {
  if (value.isNull()) return null;
  const target = value.resolve();
  if (target.isString()) return target.asString();
  if (target.isName()) return target.asName();
  return null;
}

/** Read the structure tree and the page contents of `bytes` with MuPDF's object model. */
export async function readTags(bytes: Uint8Array): Promise<ReadTags> {
  const mupdf = (await import(pathToFileURL(coreRequire.resolve('mupdf')).href)) as MupdfReadLike;
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('the produced file is not a PDF');
  try {
    const pageNumbers = new Map<number, number>();
    for (let index = 0; index < doc.countPages(); index += 1) {
      pageNumbers.set(doc.findPage(index).asIndirect(), index);
    }
    const walk = (element: PdfObjectLike, inheritedPage: number | null): ReadElement => {
      const pg = element.get('Pg');
      const page = pg.isNull() ? inheritedPage : (pageNumbers.get(pg.asIndirect()) ?? inheritedPage);
      const attrs = element.get('A');
      const kids: ReadElement[] = [];
      const mcids: number[] = [];
      const entry = element.get('K');
      const list: PdfObjectLike[] = [];
      if (!entry.isNull()) {
        const resolved = entry.resolve();
        if (resolved.isArray()) for (let i = 0; i < resolved.length; i += 1) list.push(resolved.get(i));
        else list.push(entry);
      }
      for (const kid of list) {
        const target = kid.resolve();
        if (target.isNumber()) mcids.push(target.asNumber());
        else if (target.isDictionary() && target.get('S').isName()) kids.push(walk(target, page));
        else if (target.isDictionary() && !target.get('MCID').isNull()) {
          mcids.push(target.get('MCID').resolve().asNumber());
        }
      }
      return {
        role: textOf(element.get('S')) ?? '',
        alt: textOf(element.get('Alt')),
        scope: attrs.isNull() ? null : textOf(attrs.resolve().get('Scope')),
        page,
        mcids,
        kids,
      };
    };
    const root = doc.getTrailer().get('Root');
    const treeRoot = root.get('StructTreeRoot').resolve();
    const top = treeRoot.get('K').resolve();
    const first = top.isArray() ? top.get(0) : top;
    const contents: string[] = [];
    for (let index = 0; index < doc.countPages(); index += 1) {
      const entry = doc.findPage(index).get('Contents');
      const streams: PdfObjectLike[] = [];
      const list = entry.resolve();
      if (list.isArray()) for (let i = 0; i < list.length; i += 1) streams.push(list.get(i));
      else streams.push(entry);
      contents.push(
        streams
          .map((stream) => (stream.isStream() ? stream : stream.resolve()).readStream().asString())
          .join('\n'),
      );
    }
    return { root: walk(first.resolve(), null), contents, lang: textOf(root.get('Lang')) };
  } finally {
    doc.destroy();
  }
}

/** A depth-first listing of roles as `Role(kid,kid)`, for exact comparison. */
export function signature(element: ReadElement): string {
  const own = element.mcids.map((mcid) => `#${String(mcid)}`);
  const kids = element.kids.map(signature);
  const inside = [...own, ...kids].join(',');
  return inside === '' ? element.role : `${element.role}(${inside})`;
}

/** Every element of the tree, depth first, the root included. */
export function flatten(element: ReadElement): readonly ReadElement[] {
  return [element, ...element.kids.flatMap(flatten)];
}

/** Sects in the big document: with a Div and a Paragraph each, they pass the folding and the row limit. */
export const BIG_SECTS = 410;

/**
 * Two pages, a Document of 410 Sects (each: Div → P) with a Figure (page two) in the second: more than 300
 * elements (the deep levels start folded) and more than 800 rows (the list is cut).
 */
export async function bigFixture(): Promise<Uint8Array> {
  const sects: TNode[] = [];
  for (let index = 0; index < BIG_SECTS; index += 1) {
    sects.push({
      s: 'Sect',
      k: [{ s: 'Div', k: [index === 1 ? { s: 'Figure', pg: 1, k: [0] } : { s: 'P' }] }],
    });
  }
  const built = await buildTagged({
    pages: [
      {
        content: line(0, 'P', 20, 270, 'Opening line'),
        fonts: FONT,
        box: [0, 0, TAGS_PAGE.width, TAGS_PAGE.height],
      },
      { content: picture(0, 20, 180), image: true, box: [0, 0, TAGS_PAGE.width, TAGS_PAGE.height] },
    ],
    tree: [{ s: 'Document', pg: 0, k: [{ s: 'P', k: [0] }, ...sects] }],
    parentTree: true,
    markInfo: true,
    lang: 'en-US',
    title: 'Big tree',
  });
  return built.bytes;
}

/** Pages in the viewing-only document: above the 300 a phone-class device edits. */
export const VIEWING_ONLY_PAGES = 301;

/** A tagged document of 301 pages: with a mobile user agent the shell opens it for viewing only. */
export async function viewingOnlyFixture(): Promise<Uint8Array> {
  const pages = Array.from({ length: VIEWING_ONLY_PAGES }, (_, index) =>
    index === 0
      ? {
          content: line(0, 'H1', 20, 270, 'Heading') + picture(1, 20, 180),
          fonts: FONT,
          image: true as const,
        }
      : { content: '' },
  );
  const built = await buildTagged({
    pages,
    tree: [
      {
        s: 'Document',
        pg: 0,
        k: [
          { s: 'H1', k: [0] },
          { s: 'Figure', k: [1] },
        ],
      },
    ],
    parentTree: true,
    markInfo: true,
    lang: 'en-US',
    title: 'Long document',
  });
  return built.bytes;
}

/**
 * An untagged two-page document. Page one: a large line, two lines of body text and a picture;
 * page two: content a tagger cannot delimit (a stray `]`), so the page is left out with a note.
 */
export async function untaggedFixture(): Promise<Uint8Array> {
  const built = await buildTagged({
    pages: [
      {
        content: `BT /F1 24 Tf 20 260 Td (Annual report) Tj ET\nBT /F1 11 Tf 20 230 Td (First body line) Tj ET\nBT /F1 11 Tf 20 200 Td (Second body line) Tj ET\nq 40 0 0 40 20 120 cm /Im1 Do Q\n`,
        fonts: FONT,
        image: true,
        box: [0, 0, TAGS_PAGE.width, TAGS_PAGE.height],
      },
      {
        content: `BT /F1 11 Tf 20 230 Td (Unreadable page) Tj ET\n]\n`,
        fonts: FONT,
        box: [0, 0, TAGS_PAGE.width, TAGS_PAGE.height],
      },
    ],
    title: 'Untagged fixture',
  });
  return built.bytes;
}
