/**
 * Fixture writer and reader for the spikes and behaviour harnesses, on MuPDF's object
 * model — throwaway tooling (`PLAN.md §9/K21`), never shipped.
 *
 * The harnesses used to build their documents with pdf-lib. The product no longer carries
 * pdf-lib, so the fixtures are written with the engine the product writes with. The
 * module takes the MuPDF namespace as an argument instead of importing it, so the same
 * code runs in Node (`import * as mupdf from 'mupdf'`) and in the browser spikes (the
 * pinned `/engines/mupdf/mupdf.js`).
 *
 * What a fixture page can carry:
 *   - text in the standard-14 Helvetica (not embedded, WinAnsi, like a producer that
 *     relies on the reader's base fonts) or in an embedded TrueType font (Type0,
 *     Identity-H, with a ToUnicode map), drawn as hex strings so every byte of the
 *     content stream is ASCII;
 *   - filled rectangles and images;
 *   - URI links, a flat outline, single-line text fields, metadata, XMP and attachments.
 *
 * Pages exist from the moment they are added (their objects can be linked to at once);
 * their content streams and field appearances are written by `save()`.
 */

/** @typedef {typeof import('mupdf')} Mupdf */
/** @typedef {import('mupdf').PDFDocument} MupdfPdf */
/** @typedef {import('mupdf').PDFObject} MupdfObject */
/** @typedef {readonly [number, number, number]} Rgb */
/** @typedef {{ readonly key: string, readonly object: MupdfObject, readonly encode: (text: string) => string }} FixtureFont */

/** WinAnsi codes for the characters outside Latin-1 that WinAnsi places in 0x80–0x9F. */
const WIN_ANSI_EXTRA = new Map([
  ['€', 0x80],
  ['‚', 0x82],
  ['ƒ', 0x83],
  ['„', 0x84],
  ['…', 0x85],
  ['†', 0x86],
  ['‡', 0x87],
  ['ˆ', 0x88],
  ['‰', 0x89],
  ['Š', 0x8a],
  ['‹', 0x8b],
  ['Œ', 0x8c],
  ['Ž', 0x8e],
  ['‘', 0x91],
  ['’', 0x92],
  ['“', 0x93],
  ['”', 0x94],
  ['•', 0x95],
  ['–', 0x96],
  ['—', 0x97],
  ['˜', 0x98],
  ['™', 0x99],
  ['š', 0x9a],
  ['›', 0x9b],
  ['œ', 0x9c],
  ['ž', 0x9e],
  ['Ÿ', 0x9f],
]);

const hex = (value, width) => value.toString(16).padStart(width, '0');

/** One WinAnsi byte per character; a character WinAnsi cannot encode is an error, never a `?`. */
function winAnsiHex(text) {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const extra = WIN_ANSI_EXTRA.get(character);
    if (extra !== undefined) out += hex(extra, 2);
    else if ((code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff)) out += hex(code, 2);
    else
      throw new Error(
        `Helvetica (WinAnsi) cannot encode ${JSON.stringify(character)} in ${JSON.stringify(text)}`,
      );
  }
  return out;
}

const num = (value) => String(Math.round(value * 1000) / 1000);
const color = (rgb) => `${rgb.map(num).join(' ')} rg`;

class FixturePage {
  /**
   * @param {FixtureDocument} owner
   * @param {MupdfObject} object
   */
  constructor(owner, object) {
    this.owner = owner;
    /** The page dictionary, usable as a link or outline destination straight away. */
    this.object = object;
    /** @type {string[]} */
    this.ops = [];
    /** Resource category (`Font`, `XObject`, `Properties`, …) → name → object. */
    /** @type {Map<string, Map<string, MupdfObject>>} */
    this.resources = new Map();
  }

  /**
   * Names an object in the page's resources, e.g. `resource('Properties', 'oc1', group)`.
   * @param {string} category
   * @param {string} key
   * @param {MupdfObject} object
   */
  resource(category, key, object) {
    const named = this.resources.get(category) ?? new Map();
    named.set(key, object);
    this.resources.set(category, named);
    return this;
  }

  /** Appends content-stream operators as they are (ASCII only). */
  raw(ops) {
    this.ops.push(ops);
    return this;
  }

  /**
   * @param {string} text
   * @param {{ x: number, y: number, size: number, font?: FixtureFont, color?: Rgb }} options
   */
  text(text, { x, y, size, font = this.owner.helvetica(), color: fill = [0, 0, 0] }) {
    this.resource('Font', font.key, font.object);
    this.ops.push(
      `BT ${color(fill)} /${font.key} ${num(size)} Tf ${num(x)} ${num(y)} Td <${font.encode(text)}> Tj ET`,
    );
    return this;
  }

  /** @param {{ x: number, y: number, width: number, height: number, color?: Rgb }} rect */
  rect({ x, y, width, height, color: fill = [0, 0, 0] }) {
    this.ops.push(`${color(fill)} ${num(x)} ${num(y)} ${num(width)} ${num(height)} re f`);
    return this;
  }

  /**
   * Draws an encoded image (PNG, JPEG — anything MuPDF decodes) into a rectangle.
   * @param {Uint8Array} bytes
   * @param {{ x: number, y: number, width: number, height: number }} rect
   */
  image(bytes, { x, y, width, height }) {
    const key = `Im${(this.resources.get('XObject')?.size ?? 0) + 1}`;
    this.resource('XObject', key, this.owner.doc.addImage(new this.owner.mupdf.Image(bytes)));
    this.ops.push(`q ${num(width)} 0 0 ${num(height)} ${num(x)} ${num(y)} cm /${key} Do Q`);
    return this;
  }

  /** A `/URI` link annotation over `rect` (`[x0, y0, x1, y1]`). */
  link(rect, uri) {
    const { doc } = this.owner;
    this.annotate(
      doc.addObject({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: rect,
        Border: [0, 0, 1],
        A: { Type: 'Action', S: 'URI', URI: doc.newString(uri) },
      }),
    );
    return this;
  }

  /** Appends an annotation dictionary to the page's `/Annots`. */
  annotate(annotation) {
    const existing = this.object.get('Annots');
    if (existing.isArray()) existing.push(annotation);
    else this.object.put('Annots', [annotation]);
    return annotation;
  }

  /**
   * A single-line text field. Its appearance is generated by MuPDF on `save()`, from
   * the value and the `/DA` (Helvetica), the way a reader would draw it.
   *
   * A dotted name (`spike5.note`) is a fully qualified name: a partial name may not
   * contain a period (ISO 32000 §12.7.4.2), so each prefix becomes a parent field and
   * the widget carries only the last part.
   * @param {string} name
   * @param {readonly [number, number, number, number]} rect
   * @param {string} value
   * @param {{ fontSize?: number }} [options]
   */
  textField(name, rect, value, { fontSize = 12 } = {}) {
    const { doc } = this.owner;
    const parts = name.split('.');
    const widget = this.annotate(
      doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        T: doc.newString(parts[parts.length - 1] ?? name),
        DA: doc.newString(`/Helv ${fontSize} Tf 0 g`),
        Rect: rect,
        P: this.object,
        F: 4,
      }),
    );
    this.owner.addField(widget, parts, value);
    return this;
  }

  writeContents() {
    const { doc } = this.owner;
    const resources = this.object.get('Resources');
    for (const [category, named] of this.resources) {
      const dict = doc.newDictionary();
      for (const [key, object] of named) dict.put(key, object);
      resources.put(category, dict);
    }
    this.object.put('Contents', doc.addStream(`${this.ops.join('\n')}\n`, {}));
  }
}

class FixtureDocument {
  /** @param {Mupdf} mupdf */
  constructor(mupdf) {
    this.mupdf = mupdf;
    /** @type {MupdfPdf} */
    this.doc = new mupdf.PDFDocument();
    /** @type {FixturePage[]} */
    this.pages = [];
    /** @type {{ widget: MupdfObject, name: string, value: string }[]} */
    this.fields = [];
    /** Standard-14 fonts by base name. */
    /** @type {Map<string, FixtureFont>} */
    this.standard = new Map();
    this.embeddedCount = 0;
    /** Non-terminal fields by their qualified name. */
    /** @type {Map<string, MupdfObject>} */
    this.parentFields = new Map();
  }

  /** The standard-14 Helvetica, not embedded, WinAnsi-encoded. */
  helvetica() {
    return this.standardFont('Helvetica', 'Helv');
  }

  /**
   * A standard-14 Latin font (`Helvetica-Bold`, `Times-Roman`, …), not embedded,
   * WinAnsi-encoded — the reader supplies the face.
   * @param {string} baseFont
   * @param {string} [key]  the resource name; derived from `baseFont` when omitted
   * @returns {FixtureFont}
   */
  standardFont(baseFont, key = baseFont.replace(/[^A-Za-z0-9]/g, '')) {
    let font = this.standard.get(baseFont);
    if (font === undefined) {
      font = {
        key,
        object: this.doc.addObject({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: baseFont,
          Encoding: 'WinAnsiEncoding',
        }),
        encode: winAnsiHex,
      };
      this.standard.set(baseFont, font);
    }
    return font;
  }

  /**
   * An embedded TrueType/OpenType font (Type0, Identity-H, ToUnicode). `save()` subsets
   * it to the glyphs the fixture drew.
   * @param {string} name
   * @param {Uint8Array} bytes
   * @returns {FixtureFont}
   */
  embedFont(name, bytes) {
    const font = new this.mupdf.Font(name, bytes);
    this.embeddedCount += 1;
    return {
      key: `F${this.embeddedCount}`,
      object: this.doc.addFont(font),
      encode: (text) => {
        let out = '';
        for (const character of text) {
          const glyph = font.encodeCharacter(character.codePointAt(0) ?? 0);
          if (glyph === 0) throw new Error(`${name} has no glyph for ${JSON.stringify(character)}`);
          out += hex(glyph, 4);
        }
        return out;
      },
    };
  }

  /**
   * @param {number} width
   * @param {number} height
   * @param {{ rotate?: 0 | 90 | 180 | 270 }} [options]
   */
  addPage(width, height, { rotate = 0 } = {}) {
    const object = this.doc.addPage([0, 0, width, height], rotate, {}, '');
    this.doc.insertPage(-1, object);
    const page = new FixturePage(this, this.doc.findPage(this.pages.length));
    this.pages.push(page);
    return page;
  }

  /**
   * Registers a terminal field under its parents (created on first use) and the top
   * field in `/AcroForm /Fields`.
   * @param {MupdfObject} widget
   * @param {string[]} parts  the fully qualified name, split at the periods
   * @param {string} value
   */
  addField(widget, parts, value) {
    const root = this.catalog();
    let form = root.get('AcroForm');
    if (!form.isDictionary()) {
      form = this.doc.addObject({ Fields: [], DA: this.doc.newString('/Helv 0 Tf 0 g') });
      form.put('DR', { Font: { Helv: this.helvetica().object } });
      root.put('AcroForm', form);
    }
    let parent = null;
    for (let depth = 1; depth < parts.length; depth += 1) {
      const path = parts.slice(0, depth).join('.');
      let node = this.parentFields.get(path);
      if (node === undefined) {
        node = this.doc.addObject({ T: this.doc.newString(parts[depth - 1] ?? ''), Kids: [] });
        if (parent === null) form.get('Fields').push(node);
        else {
          node.put('Parent', parent);
          parent.get('Kids').push(node);
        }
        this.parentFields.set(path, node);
      }
      parent = node;
    }
    if (parent === null) form.get('Fields').push(widget);
    else {
      widget.put('Parent', parent);
      parent.get('Kids').push(widget);
    }
    this.fields.push({ widget, name: parts.join('.'), value });
  }

  catalog() {
    return this.doc.getTrailer().get('Root');
  }

  /**
   * A flat outline: one entry per item, each opening its page.
   * @param {readonly { title: string, page: FixturePage }[]} items
   */
  outline(items) {
    const { doc } = this;
    const root = doc.addObject({ Type: 'Outlines', Count: items.length });
    const entries = items.map(({ title, page }) =>
      doc.addObject({ Title: doc.newString(title), Parent: root, Dest: [page.object, 'Fit'] }),
    );
    entries.forEach((entry, index) => {
      if (index > 0) entry.put('Prev', entries[index - 1]);
      if (index < entries.length - 1) entry.put('Next', entries[index + 1]);
    });
    if (entries.length > 0) {
      root.put('First', entries[0]);
      root.put('Last', entries[entries.length - 1]);
    }
    this.catalog().put('Outlines', root);
    this.catalog().put('PageMode', 'UseOutlines');
  }

  /** @param {Record<string, string>} info  e.g. `{ Title: '…', Author: '…' }` (the `/Info` keys) */
  info(info) {
    for (const [key, value] of Object.entries(info)) this.doc.setMetaData(`info:${key}`, value);
  }

  /** An uncompressed `/Metadata` XMP stream on the catalog. */
  xmp(packet) {
    this.catalog().put('Metadata', this.doc.addRawStream(packet, { Type: 'Metadata', Subtype: 'XML' }));
  }

  /**
   * @param {string} name
   * @param {Uint8Array} bytes
   * @param {{ mimeType: string, description?: string, date?: Date }} options
   */
  attach(name, bytes, { mimeType, description, date = new Date('2026-09-15T00:00:00Z') }) {
    const spec = this.doc.addEmbeddedFile(name, mimeType, bytes, date, date);
    if (description !== undefined) spec.put('Desc', this.doc.newString(description));
    this.doc.insertEmbeddedFile(name, spec);
  }

  /**
   * Writes the content streams and field appearances, subsets the embedded fonts and
   * returns the file.
   * @param {string} [options]  MuPDF save options; `compress` by default, `''` keeps every
   *   stream readable in the raw bytes.
   */
  save(options = 'compress') {
    for (const page of this.pages) page.writeContents();
    for (let index = 0; this.fields.length > 0 && index < this.pages.length; index += 1) {
      for (const widget of this.doc.loadPage(index).getWidgets()) {
        const field = this.fields.find((candidate) => candidate.name === widget.getName());
        if (field === undefined) continue;
        widget.setTextValue(field.value);
        widget.update();
      }
    }
    if (this.embeddedCount > 0) this.doc.subsetFonts();
    return new Uint8Array(this.doc.saveToBuffer(options).asUint8Array());
  }
}

/** @param {Mupdf} mupdf */
export function createFixture(mupdf) {
  return new FixtureDocument(mupdf);
}

/**
 * Draws over an existing page of an opened document: a text line in the standard-14
 * Helvetica and/or an image. The page's own content is wrapped in `q … Q`, so the
 * overlay starts from the default graphics state whatever the page left behind.
 * @param {Mupdf} mupdf
 * @param {MupdfPdf} doc
 * @param {number} pageIndex
 * @param {{ text?: { value: string, x: number, y: number, size: number, color?: Rgb },
 *           image?: { bytes: Uint8Array, x: number, y: number, width: number, height: number } }} overlay
 */
export function overlayPage(mupdf, doc, pageIndex, { text, image }) {
  const page = doc.findPage(pageIndex);
  const inherited = page.getInheritable('Resources');
  const resources = inherited.isDictionary() ? inherited : doc.newDictionary();
  page.put('Resources', resources);
  const named = (category, key, object) => {
    let dict = resources.get(category);
    if (!dict.isDictionary()) {
      dict = doc.newDictionary();
      resources.put(category, dict);
    }
    dict.put(key, object);
  };
  const ops = [];
  if (text !== undefined) {
    named(
      'Font',
      'FixtureOverlayHelv',
      doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }),
    );
    ops.push(
      `BT ${color(text.color ?? [0, 0, 0])} /FixtureOverlayHelv ${num(text.size)} Tf ${num(text.x)} ${num(text.y)} Td <${winAnsiHex(text.value)}> Tj ET`,
    );
  }
  if (image !== undefined) {
    named('XObject', 'FixtureOverlayIm', doc.addImage(new mupdf.Image(image.bytes)));
    ops.push(
      `q ${num(image.width)} 0 0 ${num(image.height)} ${num(image.x)} ${num(image.y)} cm /FixtureOverlayIm Do Q`,
    );
  }
  const existing = page.get('Contents');
  const streams = [doc.addStream('q\n', {})];
  if (existing.isArray())
    for (let index = 0; index < existing.length; index += 1) streams.push(existing.get(index));
  else if (!existing.isNull()) streams.push(existing);
  streams.push(doc.addStream(`Q\n${ops.join('\n')}\n`, {}));
  page.put('Contents', streams);
}

/**
 * The facts the harnesses read back from an exported file, through MuPDF's object model
 * (the raw dictionaries, as a reader sees them — not through the product's own readers).
 * @param {Mupdf} mupdf
 * @param {Uint8Array} bytes
 */
export function readFixture(mupdf, bytes) {
  const doc = /** @type {MupdfPdf} */ (mupdf.Document.openDocument(bytes, 'application/pdf'));
  const pageCount = doc.countPages();
  return {
    doc,
    pageCount,
    /** Every annotation dictionary on a page: its subtype, `/Contents` and whether it has a `/Measure`. */
    annotations(pageIndex) {
      const annots = doc.findPage(pageIndex).get('Annots');
      const out = [];
      if (!annots.isArray()) return out;
      for (let at = 0; at < annots.length; at += 1) {
        const dict = annots.get(at).resolve();
        const subtype = dict.get('Subtype');
        const contents = dict.get('Contents');
        out.push({
          subtype: subtype.isName() ? subtype.asName() : '?',
          contents: contents.isString() ? contents.asString() : '',
          hasMeasure: !dict.get('Measure').isNull(),
        });
      }
      return out;
    },
    /** The page's effective `/Rotate`, inherited from the page tree when the page has none. */
    rotation(pageIndex) {
      const value = doc.findPage(pageIndex).getInheritable('Rotate');
      return value.isNumber() ? ((value.asNumber() % 360) + 360) % 360 : 0;
    },
    /** A form field's value by its name, or `null` when no widget carries that name. */
    fieldValue(name) {
      for (let index = 0; index < pageCount; index += 1) {
        for (const widget of doc.loadPage(index).getWidgets()) {
          if (widget.getName() === name) return widget.getValue();
        }
      }
      return null;
    },
    /** The top-level outline titles, in order. */
    outlineTitles() {
      return (doc.loadOutline() ?? []).map((item) => item.title ?? '');
    },
  };
}
