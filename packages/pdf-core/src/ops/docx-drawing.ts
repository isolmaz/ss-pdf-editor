/**
 * The OOXML pieces the DOCX writers share (`export-office.ts`: flowing text;
 * `docx-pages.ts`: one picture per page): XML escaping, the package's fixed parts (core
 * properties, relationships, content types), the ZIP, the page section, and a picture
 * anchored to the page.
 *
 * Word's limit on a page is 22 inches a side (55.88 cm, 31 680 twips). A PDF page can be
 * larger (a poster, a drawing sheet), so a writer that must state the page size asks
 * `wordPageScale` first and draws everything at that scale.
 */

import JSZip from 'jszip';

/** Twentieths of a point (twips) and English Metric Units per point. */
export const TWIPS = 20;
export const EMU = 12700;

/** Word's largest page side: 22 inches. */
export const WORD_MAX_SIDE_PT = 22 * 72;

/** The text without the control characters XML 1.0 cannot carry. */
export function xmlSafe(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters being removed
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

/** XML text: the five entities, and the control characters XML 1.0 cannot carry dropped. */
export function xml(value: string): string {
  return xmlSafe(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export function corePropertiesXml(title: string): string {
  return (
    `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xml(title)}</dc:title></cp:coreProperties>`
  );
}

/** `_rels/.rels`: the main part and the core properties. */
export const PACKAGE_RELS = (officeDocument: string) =>
  `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${officeDocument}"/>` +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '</Relationships>';

export async function zipped(files: Readonly<Record<string, string | Uint8Array>>): Promise<Uint8Array> {
  const zip = new JSZip();
  // `[Content_Types].xml` first: some readers look for it at the start of the archive.
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/* ------------------------------------------------------------------ *
 * the Word package's fixed parts
 * ------------------------------------------------------------------ */

/** The picture formats a Word package here carries; the file extension is the key. */
export type MediaExtension = 'png' | 'jpeg';

const MEDIA_TYPES: Readonly<Record<MediaExtension, string>> = { png: 'image/png', jpeg: 'image/jpeg' };

/** `[Content_Types].xml` of a Word package with `word/styles.xml` and these picture formats. */
export function contentTypesXml(extensions: readonly MediaExtension[]): string {
  return (
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    extensions.map((ext) => `<Default Extension="${ext}" ContentType="${MEDIA_TYPES[ext]}"/>`).join('') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>'
  );
}

/** The relationship id the `n`-th (1-based) picture of the document is referred to by. */
export function imageRelId(n: number): string {
  return `rIdImage${n}`;
}

/** An external link of the document: the relationship id the text refers to, and where it goes. */
export interface DocumentLink {
  readonly rid: string;
  readonly uri: string;
}

/**
 * `word/_rels/document.xml.rels`: the styles, the files under `word/media/` in order, and the
 * external hyperlinks (`TargetMode="External"`) when there are any.
 */
export function documentRelsXml(mediaNames: readonly string[], links: readonly DocumentLink[] = []): string {
  return (
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    mediaNames
      .map(
        (name, index) =>
          `<Relationship Id="${imageRelId(index + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`,
      )
      .join('') +
    links
      .map(
        (link) =>
          `<Relationship Id="${link.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(link.uri)}" TargetMode="External"/>`,
      )
      .join('') +
    '</Relationships>'
  );
}

/**
 * The extra namespaces of a document that holds Word shapes and text boxes
 * (`docx-layout-shapes.ts`, `docx-layout-text.ts`), each declared once: `wps` for the
 * shape, `mc` for the `mc:AlternateContent` it sits in, `v`, `o` and `w10` for the VML
 * fallback, `w14` for a translucent run's `w14:textFill` (ignorable: readers without it show
 * the run's solid `w:color`). Pass as `wordDocumentXml`'s second argument; a second declaration of a prefix
 * makes the XML invalid.
 */
export const SHAPE_NAMESPACES =
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:w10="urn:schemas-microsoft-com:office:word" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
  'mc:Ignorable="w14"';

/** `word/document.xml` around a body, with the namespaces pictures need (and `extraNamespaces`). */
export function wordDocumentXml(body: string, extraNamespaces = ''): string {
  return (
    `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"${extraNamespaces === '' ? '' : ` ${extraNamespaces}`}><w:body>${body}</w:body></w:document>`
  );
}

/* ------------------------------------------------------------------ *
 * page and picture
 * ------------------------------------------------------------------ */

/**
 * The factor that brings a page inside Word's 22-inch limit: both sides are multiplied by
 * it, so the shape stays. 1 for a page that already fits.
 */
export function wordPageScale(widthPt: number, heightPt: number): number {
  return Math.min(1, WORD_MAX_SIDE_PT / widthPt, WORD_MAX_SIDE_PT / heightPt);
}

/**
 * A section of the given size (points) without any margin, header or footer room, starting
 * on a new page; `w:orient` says landscape when the page is wider than tall.
 */
export function pageSectionXml(widthPt: number, heightPt: number): string {
  const orient = widthPt > heightPt ? ' w:orient="landscape"' : '';
  return (
    '<w:sectPr><w:type w:val="nextPage"/>' +
    `<w:pgSz w:w="${Math.round(widthPt * TWIPS)}" w:h="${Math.round(heightPt * TWIPS)}"${orient}/>` +
    '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>'
  );
}

export interface AnchoredPicture {
  /** Unique among the document's drawings (`wp:docPr`). */
  readonly id: number;
  /** The file name, shown in Word's selection pane. */
  readonly name: string;
  /** Relationship id of the picture (`imageRelId`). */
  readonly rid: string;
  /** Offset of the picture's top-left corner from the page's, in points. */
  readonly x: number;
  readonly y: number;
  /** Size in points. */
  readonly width: number;
  readonly height: number;
  /** Stacking position (`relativeHeight`, larger is on top); the id when absent. */
  readonly relativeHeight?: number;
}

/**
 * The start of a `wp:anchor` placed on the page itself, behind the text, with no wrapping,
 * up to and including `wp:docPr`; the children are in the order the schema fixes. Offsets
 * and extent in EMU. What follows is `wp:cNvGraphicFramePr`, then `a:graphic`, then
 * `</wp:anchor>`.
 */
export function pageAnchorHeadXml(
  id: number,
  name: string,
  relativeHeight: number,
  x: number,
  y: number,
  cx: number,
  cy: number,
): string {
  return (
    `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${relativeHeight}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">` +
    '<wp:simplePos x="0" y="0"/>' +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:wrapNone/>' +
    `<wp:docPr id="${id}" name="${xml(name)}"/>`
  );
}

/**
 * A picture placed on the page itself rather than in the text: positioned from the page's
 * corner, behind the text, with no wrapping, so the text above it lays out as if it were
 * not there. `w:drawing` is the content of a run. The children of `wp:anchor` are in the
 * order the schema fixes; Word refuses a file that has them in another.
 */
export function anchoredPictureXml(picture: AnchoredPicture): string {
  const { id, name, rid } = picture;
  const cx = Math.max(1, Math.round(picture.width * EMU));
  const cy = Math.max(1, Math.round(picture.height * EMU));
  const x = Math.round(picture.x * EMU);
  const y = Math.round(picture.y * EMU);
  return (
    '<w:drawing>' +
    pageAnchorHeadXml(id, name, picture.relativeHeight ?? id, x, y, cx, cy) +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${xml(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic></wp:anchor></w:drawing>'
  );
}
