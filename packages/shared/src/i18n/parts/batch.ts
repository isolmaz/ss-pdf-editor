/**
 * Batch processing (“queue, rule sets, … templates”).
 *
 * The dialog's own words only: every step name and every step parameter is the
 * operation's own key (`optimize.*`, `ocr.*`, `security.*` …), because a batch is a
 * sequence of the operations that already exist — a second vocabulary for the same
 * action is how the two drift apart.
 *
 * The report on a failed file is deliberately built out of the *operation's* mapped error
 * keys (`error.<code>.message` / `.hint`), so a batch failure says the same sentence a
 * single-document failure says.
 */

export const batchPart = {
  'batch.title': 'Toplu işlem',
  'batch.intro':
    'Birden çok PDF seçin, uygulanacak adımları işaretleyin ve kural kümesini her dosyaya sırayla uygulayın. Adımlar bağımlılık sırasına göre çalışır: sıkıştırma damgadan önce, üst veri son yazımdan sonra, şifreleme en sonda. Bir dosya başarısız olursa yalnızca o dosya raporlanır, kalanlar işlenmeye devam eder.',
  'batch.queue': 'Dosya kuyruğu',
  'batch.queue.hint': 'Her dosya kendi başına işlenir; belge bu cihazdan ayrılmaz.',
  'batch.name': 'Kural kümesi adı',
  'batch.steps': 'Adımlar',
  'batch.steps.hint':
    'İşaretlenen adımlar sırayla uygulanır. Sayfa alanı boş bırakılırsa dosyanın bütün sayfalarına uygulanır.',
  'batch.template.save': 'Kural kümesini kaydet (JSON)',
  'batch.template.load': 'Kural kümesi yükle',
  'batch.template.loaded': 'Yüklenen kural kümesi {count} adım içeriyor; çalıştırma bu kümele yapılır.',
  'batch.template.clear': 'Yüklenen kümeyi bırak',
  'batch.run': 'Çalıştır',
  'batch.cancel': 'Vazgeç',
  'batch.close': 'Kapat',
  'batch.download': 'Biten dosyaları indir',
  'batch.progress': 'İşleniyor',
  'batch.report': 'Dosya raporu',
  'batch.report.completed': '{before} → {after} bayt, {pages} sayfa',
  'batch.report.failed': '{step} adımında başarısız:',
  'batch.report.skipped': 'İşlenmedi (çalıştırma durduruldu).',
  'batch.report.cancelled': 'Çalıştırma iptal edildi. Tamamlanan dosyalar: {names}',
  'batch.report.summary': '{completed} tamamlandı, {failed} başarısız, {skipped} atlandı',
  'batch.error.queue': 'Adım ayarları okunamadı.',
  'batch.error.steps': 'En az bir adım işaretleyin.',
  'batch.error.template': 'Kural kümesi dosyası okunamadı.',
} as const;
