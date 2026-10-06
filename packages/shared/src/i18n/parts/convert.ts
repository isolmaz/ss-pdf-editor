/**
 * Other documents to PDF (`pdf-core/ops/convert.ts`): Word, Excel, PowerPoint, HTML,
 * text, CSV, EPUB and FB2.
 */

export const convertPart = {
  'convert.title': 'Belgeyi PDF’e dönüştür',
  'convert.intro':
    'Word, Excel, PowerPoint, HTML, metin, CSV, EPUB ya da FB2 dosyasını bu tarayıcıda PDF’e dönüştürün. Birden çok dosya seçerseniz listedeki sırayla tek bir PDF olur.',
  'convert.files': 'Dosyalar',
  'convert.hint':
    'DOCX, XLSX, PPTX, HTML, TXT, MD, CSV, TSV, EPUB, FB2. Eski DOC, XLS ve PPT biçimleri desteklenmez.',
  'convert.pageSize': 'Sayfa boyutu',
  'convert.margin': 'Kenar boşluğu (mm)',
  'convert.command': 'Belgeyi PDF’e dönüştür (Word, Excel, PowerPoint…)',
  'convert.converting': '{name} PDF’e dönüştürülüyor…',
  'convert.opened': '{format} dosyası PDF’e dönüştürülüp yeni sekmede açıldı.',
  'convert.unsupported':
    '{kind} dosyaları dönüştürülemiyor. Desteklenen biçimler: DOCX, XLSX, PPTX, HTML, TXT, MD, CSV, TSV, EPUB, FB2. Dosyayı bunlardan birinde kaydedip yeniden deneyin.',
  'convert.imageOpened': 'Görsel, PDF sayfası olarak yeni sekmede açıldı.',
  'open.anyFilter': 'PDF ve dönüştürülebilir belgeler',

  'op.progress.convert.read': 'Belge okunuyor',
  'op.progress.convert.write': 'Sayfalar yerleştiriliyor ve PDF yazılıyor',
  'op.note.convert.done': '{name}: {format} dosyası {pages} sayfalık PDF’e dönüştürüldü.',
  'op.note.convert.docxApproximate':
    'Word belgesinin metni, başlıkları, listeleri, tabloları, bağlantıları ve görselleri aktarıldı; sayfa düzeni, yazı tipleri, üst/alt bilgiler ve dipnot yerleşimi birebir korunmaz.',
  'op.note.convert.xlsxApproximate':
    'Her sayfa, dolu hücre aralığıyla bir tablo olarak aktarıldı; formüllerin yalnızca kayıtlı sonuçları gösterilir. Grafikler, hücre biçimleri ve sütun genişlikleri aktarılmaz.',
  'op.note.convert.xlsxTruncated':
    'Tablolar {rows} satır ve {columns} sütunla sınırlandı; {cells} hücre dışarıda kaldı.',
  'op.note.convert.pptxApproximate':
    'Her slayt kendi boyutunda bir sayfa oldu; metinleri, tabloları ve görselleri okuma sırasıyla aktarıldı. Slayt tasarımı (konumlar, arka planlar, temalar) birebir korunmaz.',
  'op.note.convert.xmlDamaged':
    'Dosyanın bazı bölümleri hasarlı ({parts}); okunabilen kısım dönüştürüldü, içerik eksik olabilir.',
  'op.note.convert.imagesSkipped':
    '{count} görsel, desteklenmeyen biçimde (EMF, WMF, SVG gibi) olduğu için aktarılamadı.',
  'op.note.convert.csvTruncated': 'Tablo {rows} satırla sınırlandı; dosyada {total} satır vardı.',
  'op.note.convert.encoding': 'Dosya UTF-8 değildi; {encoding} olarak okundu.',
  'op.note.convert.remoteSkipped':
    'Sayfanın internetten yüklenen stil ya da görselleri alınmadı: bu uygulama ağa bağlanmaz.',
  'op.note.convert.linksSkipped':
    '{count} bağlantı, güvenli olmayan bir adres şeması taşıdığı için eklenmedi.',

  'home.start.convert.title': 'PDF’e dönüştür',
  'home.start.convert.desc': 'Word, Excel, PowerPoint, HTML ya da metin dosyasını PDF yapın.',
  'home.tool.convert': 'Word, Excel, PowerPoint, HTML, metin ve e-kitapları PDF’e dönüştürün.',
} as const;
