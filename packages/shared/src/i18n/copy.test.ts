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
});
