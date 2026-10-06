/** PDF to Word, Excel and CSV (`pdf-core/ops/export-office.ts`). */

export const officePart = {
  'export.office.title': 'Word, Excel ya da CSV olarak dışa aktar',
  'export.office.intro':
    'Sayfaların metnini, tablolarını ve görsellerini düzenlenebilir bir Word belgesine ya da tablolarını bir Excel çalışma kitabına veya CSV dosyasına aktarın. Her şey bu tarayıcıda yapılır.',
  'export.office.format': 'Biçim',
  'export.office.format.docx': 'Word (DOCX)',
  'export.office.format.docxHint':
    'Paragraflar, başlıklar, tablolar ve görseller; metin akar ve düzenlenebilir.',
  'export.office.format.xlsx': 'Excel (XLSX)',
  'export.office.format.xlsxHint': 'Her çizgili tablo bir sayfa; tablosuz sayfalar satır satır.',
  'export.office.format.csv': 'CSV',
  'export.office.format.csvHint': 'Tablolar tek dosyada, aralarında boş satırla.',
  'export.office.delimiter': 'Ayırıcı',
  'export.office.delimiter.comma': 'Virgül (,)',
  'export.office.delimiter.semicolon': 'Noktalı virgül (;) — Türkçe Excel bunu bekler',
  'export.office.done': 'Dışa aktarıldı: {name}',
  'export.office.sheet.table': 'Tablo {n}',
  'export.office.sheet.page': 'Sayfa {n}',
  'export.office.option': 'Word, Excel ya da CSV',
  'export.office.download': 'Word, Excel ya da CSV olarak indir',
  'tools.exportOffice': 'Word, Excel ya da CSV Olarak Dışa Aktar',
  'tools.exportOfficeDesc': 'PDF’i Word, Excel ya da CSV dosyasına aktarın',
  'home.tool.exportOffice':
    'PDF’i düzenlenebilir Word belgesine, tablolarını Excel ya da CSV dosyasına aktarın.',

  'op.progress.exportOffice.read': 'Sayfa düzeni okunuyor',
  'op.progress.exportOffice.write': 'Dosya yazılıyor',
  'op.note.exportOffice.done':
    '{pages} sayfa {format} dosyasına aktarıldı ve dosya yeniden okunarak doğrulandı.',
  'op.note.exportOffice.docxApproximate':
    'Metin akan paragraflar olarak aktarıldı: sayfadaki birebir konumlar, çok sütunlu akış, çizimler, form alanları ve açıklamalar aktarılmaz. Yazı tipleri adlarıyla aktarılır; bilgisayarda yoksa Word benzerini kullanır.',
  'op.note.exportOffice.tables': '{count} çizgili tablo, birleşik hücreleriyle tablo olarak aktarıldı.',
  'op.note.exportOffice.streamTables':
    'Çizgisiz {count} tablo, metnin aralıklarından tanınıp kenarlıksız tablo olarak aktarıldı; sütunlarını kontrol edin.',
  'op.note.exportOffice.pictures': '{count} görsel aktarıldı.',
  'op.note.exportOffice.sheets': 'Çalışma kitabında {count} sayfa var.',
  'op.note.exportOffice.numbers':
    '{count} hücre sayı olarak yazıldı. Tek anlamlı olmayan değerler (ör. 1.234: bin mi, bir virgül iki yüz otuz dört mü) metin olarak bırakıldı.',
  'op.note.exportOffice.csvRows': '{tables} tablodan {rows} satır yazıldı.',
  'op.note.exportOffice.csvFormulas':
    "{count} hücre =, +, - veya @ ile başlıyordu ve bir tablolama programında formül olarak çalışırdı; metin olarak açılmaları için başlarına ' eklendi.",
  'op.note.exportOffice.outsideText':
    'Tablo içeren sayfalarda tabloların dışındaki metin (başlıklar, açıklamalar) aktarılmadı.',
  'op.note.exportOffice.unruled':
    'Şu sayfalarda çizgili tablo bulunamadı; metin, aralıklarına göre sütunlara bölündü, sütunları kontrol edin: {pages}.',
  'op.note.exportOffice.noText':
    'Şu sayfalarda okunabilir metin yok (taranmış görünüyor); düzenlenebilir metin için önce OCR uygulayın: {pages}.',
  'op.note.exportOffice.unreadable':
    '{count} karakterin Unicode karşılığı belgede tanımlı değil; bu karakterler aktarılamadı (� olarak görünür).',
} as const;
