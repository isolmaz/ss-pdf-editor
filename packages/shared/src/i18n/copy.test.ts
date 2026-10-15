/**
 * The wording rules of the two shipped catalogues, checked on the data rather than on a
 * sample: one name per tool on every surface that names it, Turkish and English labels in
 * sentence case, the Turkish suffix after an abbreviation, and a short opening line for a
 * dialog. A new string that breaks a rule fails here, with the key.
 */

import { describe, expect, it } from 'vitest';
import { en } from './en';
import { tr } from './tr';

type Key = keyof typeof tr;

interface ToolName {
  readonly tr: string;
  readonly en: string;
  /** Every key that names this tool: menu, palette, tile, rail, panel, dialog title, context menu. */
  readonly keys: readonly Key[];
}

/** The one name of each tool, in both languages. */
const TOOL_NAMES: readonly ToolName[] = [
  {
    tr: 'Metni düzenle',
    en: 'Edit text',
    keys: ['cmd.textEdit.label', 'textedit.title', 'toolbar.text', 'context.editText'],
  },
  { tr: 'Metin ekle', en: 'Add text', keys: ['toolbar.freetext', 'context.addText'] },
  { tr: 'Not ekle', en: 'Add note', keys: ['toolbar.comment', 'ann.tool.note', 'context.addNote'] },
  { tr: 'Şekil çiz', en: 'Draw shape', keys: ['toolbar.shape', 'ann.tool.shapes'] },
  {
    tr: 'Serbest çizim',
    en: 'Freehand drawing',
    keys: ['ann.tool.ink', 'context.drawInk'],
  },
  { tr: 'Sağa döndür', en: 'Rotate right', keys: ['pages.rotate.right', 'context.rotateCW', 'nav.rotate'] },
  { tr: 'Sola döndür', en: 'Rotate left', keys: ['pages.rotate.left', 'context.rotateCCW'] },
  { tr: 'Sayfaları sil', en: 'Delete pages', keys: ['pages.delete', 'tools.delete'] },
  { tr: 'Sayfaları ayıkla', en: 'Extract pages', keys: ['pages.extract.title', 'tools.extract'] },
  { tr: 'Belgeyi böl', en: 'Split document', keys: ['split.title', 'tools.split'] },
  { tr: 'Belge ekle', en: 'Add document', keys: ['file.add.title', 'tools.combine'] },
  { tr: 'Sayfa kutuları ve boyut', en: 'Page boxes and size', keys: ['boxes.title', 'boxes.dialog.title'] },
  {
    tr: 'Sayfa numarası ve üst/alt bilgi',
    en: 'Page numbers and headers/footers',
    keys: ['stamp.title', 'tools.pageNumbers'],
  },
  { tr: 'Filigran ekle', en: 'Add watermark', keys: ['watermark.title', 'tools.watermark'] },
  {
    tr: 'Sayfaları görsel olarak dışa aktar',
    en: 'Export pages as images',
    keys: ['export.images.title', 'tools.exportImages'],
  },
  { tr: 'Metni dışa aktar', en: 'Export text', keys: ['export.text.title', 'tools.exportText'] },
  {
    tr: 'Word, Excel ya da CSV olarak dışa aktar',
    en: 'Export to Word, Excel or CSV',
    keys: ['export.office.title', 'tools.exportOffice'],
  },
  { tr: 'PDF/A olarak kaydet', en: 'Save as PDF/A', keys: ['pdfa.title', 'tools.pdfa'] },
  { tr: 'Belgeyi imzala', en: 'Sign document', keys: ['sign.open', 'sign.title', 'tools.sign'] },
  { tr: 'İmza ekle', en: 'Add signature', keys: ['sig.command', 'sig.dialog.title'] },
  {
    tr: 'Form alanlarını doldur',
    en: 'Fill form fields',
    keys: ['form.dialog.fields.title', 'tools.formFill'],
  },
  { tr: 'Form alanı ekle', en: 'Add form field', keys: ['form.dialog.create.title', 'tools.formCreate'] },
  {
    tr: 'Kalıcı karartma',
    en: 'Permanent redaction',
    keys: ['redact.title', 'tools.redact', 'toolbar.redact'],
  },
  { tr: 'Parola ile koru', en: 'Protect with password', keys: ['security.title', 'tools.protect'] },
  { tr: 'Parolayı kaldır', en: 'Remove password', keys: ['security.unlock.title', 'tools.unlock'] },
  { tr: 'Belgeyi temizle', en: 'Sanitize document', keys: ['sanitize.title', 'tools.sanitize'] },
  { tr: 'Dosyayı küçült', en: 'Reduce file size', keys: ['optimize.title', 'tools.compress'] },
  {
    tr: 'Belgeyi PDF’ye dönüştür',
    en: 'Convert document to PDF',
    keys: ['convert.title', 'convert.command'],
  },
  {
    tr: 'Genişliğe sığdır',
    en: 'Fit width',
    keys: ['viewer.fitWidth', 'nav.fitWidth', 'context.fitWidth'],
  },
  { tr: 'Okuma modu', en: 'Reading mode', keys: ['reading.toggle', 'nav.readingMode'] },
  { tr: 'Belgede ara', en: 'Find in document', keys: ['viewer.find.label', 'shell.search'] },
  { tr: 'Dışa aktarma seçenekleri', en: 'Export options', keys: ['export.title', 'tools.exportOptions'] },
];

describe('tool names', () => {
  it.each(TOOL_NAMES)('$en is one name on every surface', ({ tr: turkish, en: english, keys }) => {
    expect(keys.map((key) => tr[key])).toEqual(keys.map(() => turkish));
    expect(keys.map((key) => en[key])).toEqual(keys.map(() => english));
  });

  it('names the three measurements as commands after the tool they arm', () => {
    expect([
      tr['cmd.measureDistance.label'],
      tr['cmd.measurePerimeter.label'],
      tr['cmd.measureArea.label'],
    ]).toEqual(['Mesafe ölç', 'Çevre ölç', 'Alan ölç']);
    expect(tr['toolbar.measure']).toBe('Ölç');
  });

  it('names the quick-export compression levels by what they give, not by a grade', () => {
    const levels = ['export.levelHigh', 'export.levelMedium', 'export.levelLow'] as const;
    expect(levels.map((key) => tr[key])).toEqual(['Daha küçük dosya', 'Dengeli', 'Daha yüksek kalite']);
    expect(levels.map((key) => en[key])).toEqual(['Smaller file', 'Balanced', 'Higher quality']);
  });
});

/**
 * Keys another change is rewriting at the same time (the settings dialog, the tool strips and
 * the home screen); their wording is theirs to fix, so these checks leave them out until that lands.
 */
const IN_FLIGHT = [/^setting\./, /^theme\./, /^toolbar\.select$/, /^home\.start\./];

/** Capitalised words that are names, not title case: products, keyboard keys, PDF terms, languages. */
const NAMES = new Set([
  'Word',
  'Excel',
  'Markdown',
  'Noto',
  'Sans',
  'Info',
  'Unicode',
  'Crypt',
  'Launch',
  'Sound',
  'Movie',
  'Enter',
  'Esc',
  'Ctrl+K',
  'Türkçesi',
  'Kurmancî',
  'Kurmanji',
  'Simplified',
  'Traditional',
  'Tags',
  'Etiketler',
]);

/** A label is a short string that is not a sentence: no sentence punctuation inside. */
function isLabel(text: string): boolean {
  return text.length <= 70 && !/[.!?:;]/.test(text.replace(/\d\.\d/g, ''));
}

/** The words after the first that start with a capital and are neither a name nor an identifier. */
function titleCased(text: string): string[] {
  const words = text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\/[A-Za-z]+/g, '')
    .split(/[\s/()·,–—-]+/)
    .map((word) => word.split('’')[0] ?? '')
    .filter((word) => /[A-Za-zÇĞİÖŞÜçğıöşü]/.test(word));
  return words
    .slice(1)
    .filter(
      (word) => /^[A-ZÇĞİÖŞÜ][a-zçğıöşüâîû]/.test(word) && !/[a-z][A-Z]/.test(word) && !NAMES.has(word),
    );
}

describe.each([
  ['Turkish', tr],
  ['English', en],
] as const)('%s labels', (_name, catalogue) => {
  const labels = (Object.entries(catalogue) as [Key, string][]).filter(
    ([key, text]) => isLabel(text) && !IN_FLIGHT.some((skip) => skip.test(key)),
  );

  it('are written in sentence case, not Title Case', () => {
    expect(
      labels.filter(([, text]) => titleCased(text).length > 0).map(([key, text]) => `${key}: ${text}`),
    ).toEqual([]);
  });

  it('are not shouted in capitals', () => {
    const shouted = labels.filter(([, text]) => /^[A-ZÇĞİÖŞÜ\s]{5,}$/.test(text)).map(([key]) => key);
    expect(shouted).toEqual(['watermark.defaultText']);
  });
});

describe('Turkish suffixes after an abbreviation', () => {
  it('follow how PDF is said ("pe-de-fe", ending in a vowel): PDF’ye, PDF’yi, PDF’nin, PDF’de, PDF’den', () => {
    const wrong = (Object.entries(tr) as [Key, string][])
      .filter(([key]) => !IN_FLIGHT.some((skip) => skip.test(key)))
      .filter(([, text]) => /PDF’(e|i|in|te|teki|ten)(?![a-zçğıöşüâ])/.test(text));
    expect(wrong.map(([key, text]) => `${key}: ${text}`)).toEqual([]);
  });
});

describe('the ellipsis', () => {
  const keys = Object.keys(tr) as Key[];

  it('ends the same strings in both languages', () => {
    expect(keys.filter((key) => tr[key].endsWith('…') !== en[key].endsWith('…'))).toEqual([]);
  });

  it('is not on a title, a heading or the label of a field', () => {
    const heading = /(\.title|^home\.cat\.[a-z]+|^tools\.group\.[a-z]+|^panel\.[a-z0-9]+|^pages\.moveTo)$/;
    const wrong = keys.filter((key) => heading.test(key) && (tr[key].endsWith('…') || en[key].endsWith('…')));
    expect(wrong).toEqual([]);
  });
});

describe('the copy people read before they decide', () => {
  const entries = (Object.keys(tr) as Key[]).flatMap((key) => [
    ['tr', key, tr[key]] as const,
    ['en', key, en[key]] as const,
  ]);

  it('keeps a dialog intro or hint to 160 characters and every message to 200', () => {
    const short = /(\.intro|[hH]int)$/;
    const tooLong = entries
      .filter(([, key, text]) => text.length > (short.test(key) ? 160 : 200))
      .map(([locale, key, text]) => `${locale} ${key}: ${text.length}`);
    expect(tooLong).toEqual([]);
  });

  it('does not name the libraries or the storage behind a feature', () => {
    // The settings dialog's own text is being rewritten by another change.
    const named = entries
      .filter(([, key]) => !/^settings?\./.test(key))
      .filter(([, , text]) =>
        /Ghostscript|MuPDF|pdf\.js|pdfjs|\bmotor|\bengine|katalog|\bcatalog|\bOCG\b|\bOPFS\b|AcroForm|\/ByteRange/i.test(
          text,
        ),
      )
      .map(([locale, key, text]) => `${locale} ${key}: ${text}`);
    expect(named).toEqual([]);
  });

  it('leaves the CMS container to the signature details that are about it', () => {
    const named = entries
      .filter(([, , text]) => /\bCMS\b/.test(text))
      .map(([, key]) => key)
      .filter((key) => !key.startsWith('props.sig.'));
    expect(named).toEqual([]);
  });
});
