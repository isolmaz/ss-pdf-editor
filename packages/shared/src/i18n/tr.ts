/**
 * Turkish dictionary — the complete locale.
 *
 * Never hardcode user-facing text: components read keys from here through
 * `t()`. The `en` locale is a scaffold with the same key shape; missing keys
 * fall back to `tr` during development and are reported by the i18n helper.
 */

import { a11yPart } from './parts/a11y';
import { annotationsPart } from './parts/annotations';
import { auditPart } from './parts/audit';
import { batchPart } from './parts/batch';
import { boxesPart } from './parts/boxes';
import { commonPart } from './parts/common';
import { comparePart } from './parts/compare';
import { convertPart } from './parts/convert';
import { dialogsPart } from './parts/dialogs';
import { docopsPart } from './parts/docops';
import { enginesPart } from './parts/engines';
import { errorsPart } from './parts/errors';
import { filePart } from './parts/file';
import { findReplacePart } from './parts/findreplace';
import { formsPart } from './parts/forms';
import { homePart } from './parts/home';
import { imposePart } from './parts/impose';
import { measurePart } from './parts/measure';
import { ocrPart } from './parts/ocr';
import { officePart } from './parts/office';
import { optimizePart } from './parts/optimize';
import { pageeditPart } from './parts/pageedit';
import { pageopsPart } from './parts/pageops';
import { pagesPart } from './parts/pages';
import { phase4Part } from './parts/phase4';
import { propertiesPart } from './parts/properties';
import { propsPart } from './parts/props';
import { redactPart } from './parts/redact';
import { reviewPart } from './parts/review';
import { securityPart } from './parts/security';
import { shellPart } from './parts/shell';
import { signaturePart } from './parts/signature';
import { sigValidatePart } from './parts/sigvalidate';
import { stampPart } from './parts/stamp';
import { texteditPart } from './parts/textedit';
import { verifyPart } from './parts/verify';

export const tr = {
  ...annotationsPart,
  ...dialogsPart,
  ...pageeditPart,
  ...phase4Part,
  ...batchPart,
  ...a11yPart,
  ...comparePart,
  ...measurePart,
  ...texteditPart,
  ...propsPart,
  ...auditPart,
  ...boxesPart,
  ...formsPart,
  ...commonPart,
  ...docopsPart,
  ...enginesPart,
  ...errorsPart,
  ...filePart,
  ...homePart,
  ...imposePart,
  ...ocrPart,
  ...optimizePart,
  ...pageopsPart,
  ...pagesPart,
  ...propertiesPart,
  ...redactPart,
  ...securityPart,
  ...shellPart,
  ...signaturePart,
  ...convertPart,
  ...officePart,
  ...findReplacePart,
  ...reviewPart,
  ...stampPart,
  ...verifyPart,
  ...sigValidatePart,

  'open.pdfFilter': 'PDF belgesi',
  'open.progress': 'Belge açılıyor…',
  'open.pickerFailed': 'Dosya seçici açılamadı; dosyayı sürükleyip bırakabilirsiniz.',
  'close.title': 'Değişiklikler kaydedilsin mi? — {name}',
  'close.body':
    'Kaydet ve kapat yalnızca dosyaya yazma tamamlandığında belgeyi kapatır. Vazgeç belgeyi ve taslağı korur.',
  'close.exportHint':
    'Dışa aktar indirmeyi başlatır; dosyanın diske kaydedildiğini doğrulayamayız. Belge açık kalır. Dosyayı kontrol ettikten sonra Kaydetmeden kapat ile taslağı silebilirsiniz.',
  'close.discard': 'Kaydetmeden kapat',
  'close.save': 'Kaydet ve kapat',
  'inspection.loading': 'Belge bilgileri inceleniyor…',
  'inspection.failed': 'Belge bilgileri okunamadı. Kaydetme ve dışa aktarma durduruldu; yeniden deneyin.',
  'inspection.retry': 'Yeniden incele',
  'save.done': 'Kaydedildi: {name}',
  'export.explained': 'Yerinde kaydetme yok: belge yeni bir dosya olarak indirildi.',
  'panel.pages': 'Sayfalar',
  'panel.outline': 'İçindekiler',
  'panel.outline.loading': 'İçindekiler okunuyor…',
  'panel.outline.empty': 'Bu belgede içindekiler yok.',
  'panel.goToPage': '{page}. sayfaya git',
  'draft.restored': '{count} taslak geri yüklendi; belge ve değişiklik günlüğü hazır.',
  'draft.corrupt': '{count} taslak dosyası bozulmuş ve okunamadı.',
  'draft.engineValues': '{count} form/not düzenlemesi geri yüklendi. Kaydetmeden kapatırsanız kaybolur.',
  'draft.engineValuesDropped': '{count} düzenleme taslakta taşınamadı; kaydetmek için belgeyi açık tutun.',
  'draft.engineValuesLost':
    'Taslaktan gelen {count} form/not düzenlemesinin hiçbiri geri yüklenemedi; düzenlemeleri belgede yeniden yapın.',
  'viewer.singlePage': 'Tek sayfa',
  'viewer.book': 'Çift sayfa (kitap)',
  'viewer.fullscreen': 'Tam ekran',
  'shell.menu.file': 'Dosya',
  'shell.menu.edit': 'Düzen',
  'shell.menu.view': 'Görünüm',
  'shell.menu.page': 'Sayfa',
  'shell.menu.tools': 'Araçlar',
  'shell.menu.settings': 'Ayarlar',
  'shell.menu.help': 'Yardım',
  'theme.light': 'Açık Tema',
  'theme.dark': 'Koyu Tema',
  'theme.system': 'Sistem Teması',
  'theme.cycle.title': '{current} ({next} moduna geç)',
  'theme.cycle.aria': '{current} tema',
  'setting.theme.light': 'Açık Tema',
  'setting.theme.dark': 'Koyu Tema',
  'setting.theme.system': 'Sistem Teması',
  'setting.sensitiveSession': 'Hassas Oturum (Taslak Kaydetmeyi Aç/Kapat)',
  'setting.opfsSave': 'Tarayıcı Depolamasına Kaydet (OPFS)',
  'setting.opfsSaved': 'Taslak tarayıcı depolamasına (OPFS) kaydedildi.',
  'setting.purgeDocument': 'Bu Belgenin Kayıtlı Kopyalarını Sil',
  'setting.sweepVault': 'Depodaki Artık Kopyaları Temizle',
  'vault.purged':
    'Bu belge için tarayıcı deposundan {count} kayıt silindi. Bu, uygulama deposundaki kaydın kaldırılmasıdır; diske yazılmış baytların üzerine yazılmaz ve indirdiğiniz kopyalar, açtığınız özgün dosya ya da tarayıcı yedekleri bu uygulamanın erişimi dışındadır.',
  'vault.swept': 'Başka hiçbir belgenin başvurmadığı {count} kayıt depodan silindi.',
  'vault.sweepNothing': 'Depoda artık kopya yok; silinecek bir şey bulunamadı.',
  'vault.incomplete':
    'Depo listesi eksiksiz okunamadı; hiçbir şey silinmedi. Yarım bir listeden silmek, başka bir belgenin tek kopyasını yok edebilir.',
  'vault.sweepNoChannel':
    'Bu tarayıcıda pencereler arası bilgi kanalı yok; artık kopya taraması, başka bir pencerede açık belgeleri göremeden çalıştırılmadı.',
  'batch.folder.watch': 'Klasör İzle',
  'batch.folder.watching': 'Klasör izleniyor',
  'batch.folder.stop': 'İzlemeyi Durdur',
  'batch.folder.unsupported': 'Bu tarayıcı klasör izlemeyi desteklemiyor.',
  'batch.folder.scanned': '{count} PDF dosyası kuyruğa eklendi.',
  'shell.open': 'Aç',
  'shell.openTabs': 'Açık belgeler',
  'shell.tasks': 'Görevler',
  'shell.closeTab': 'Sekmeyi kapat',
  'shell.commandPalette': 'Komut ara (Ctrl+K)',
  'shell.commandPaletteShort': 'Komut ara',
  'shell.backToDocument': 'Belgeye Dön',
  'shell.homeTagline': '— Belgeniz cihazınızdan ayrılmaz, %100 yerel ve güvenli.',
  'shell.status.memory': 'Bellek',
  'shell.deviceTier.desktop': 'Masaüstü limitleri',
  'shell.deviceTier.mobile': 'Mobil limitleri',
  'shell.deviceTier.desktopHint':
    'Sayfa ve boyut sınırları bu cihazın belleğine göre masaüstü profilinden seçildi.',
  'shell.deviceTier.mobileHint':
    'Sayfa ve boyut sınırları bu cihazın belleğine göre mobil profilden seçildi.',
  'nav.controls': 'Sayfa ve görünüm denetimleri',
  'shell.save': 'Kaydet',
  'shell.export': 'Dışa aktar',

  'tab.dirty': 'Kaydedilmemiş değişiklikler',

  'viewer.rendering': 'Sayfalar hazırlanıyor…',
  'viewer.find.label': 'Belgede ara',
  'viewer.find.placeholder': 'Ara…',
  'viewer.find.matches': '{current} / {total} eşleşme',
  'viewer.find.noMatches': 'Eşleşme yok',
  'viewer.find.scanning': 'Taranıyor…',
  'viewer.find.previous': 'Önceki eşleşme',
  'viewer.find.next': 'Sonraki eşleşme',
  'viewer.find.close': 'Aramayı kapat',
  'viewer.page': 'Sayfa',
  'viewer.of': '/',
  'viewer.zoom': 'Yakınlaştırma',
  'viewer.fitWidth': 'Genişliğe sığdır',
  'viewer.fitPage': 'Sayfaya sığdır',
  'viewer.privacyNote': 'Belge cihazınızdan ayrılmaz.',

  'limit.warn.pages': 'Belge çok sayfalı: düzenleme yavaşlayabilir.',
  'limit.viewingOnly.pages': 'Bu belge mobil için büyük; düzenleme kapalı, görüntüleme açık.',
  'limit.viewingOnly.bytes': 'Bu belge mobil için büyük; düzenleme kapalı, görüntüleme açık.',
  'limit.blocked.pages': 'Belge sayfa sınırını aşıyor.',
  'limit.blocked.bytes': 'Belge boyut sınırını aşıyor.',

  'error.unsupported.message': 'Bu özellik bu belge için kullanılamıyor.',
  'error.unsupported.hint': 'Belgeyi farklı kaydedip yeniden deneyin.',
  'error.password-required.message': 'Bu belge parola korumalı.',
  'error.password-required.hint': 'Parolayı girip tekrar deneyin.',
  'error.wrong-password.message': 'Parola hatalı.',
  'error.wrong-password.hint': 'Parolayı kontrol edip tekrar deneyin.',
  'error.encrypted-unsupported.message': 'Şifreli belgeler bu işlem için açılamıyor.',
  'error.encrypted-unsupported.hint': 'Önce parolayı kaldırıp yeniden deneyin.',
  'error.corrupt-document.message': 'Belge bozuk görünüyor.',
  'error.corrupt-document.hint': 'Dosyayı başka bir okuyucuda açmayı deneyin.',
  'error.unsupported-format.message': 'Bu dosya biçimi desteklenmiyor.',
  'error.unsupported-format.hint': 'PDF dosyası seçin.',
  'error.file-too-large.message': 'Dosya boyut sınırını aşıyor.',
  'error.file-too-large.hint': 'Dosyayı küçültüp yeniden deneyin.',
  'error.page-limit.message': 'Belge sayfa sınırını aşıyor.',
  'error.page-limit.hint': 'Belgeyi bölerek açın.',
  'error.quota-exceeded.message': 'Tarayıcı depolama alanı doldu.',
  'error.quota-exceeded.hint': 'Yer açın veya dosyayı dışa aktarın.',
  'error.out-of-memory.message': 'Bellek yetersiz kaldı.',
  'error.out-of-memory.hint': 'Diğer sekmeleri kapatıp yeniden deneyin.',
  'error.aborted.message': 'İşlem iptal edildi.',
  'error.aborted.hint': 'İstediğiniz zaman yeniden başlatabilirsiniz.',
  'error.timeout.message': 'İşlem zaman aşımına uğradı.',
  'error.timeout.hint': 'Daha küçük bir aralıkla yeniden deneyin.',
  'error.write-failed.message': 'Dosyaya yazılamadı.',
  'error.write-failed.hint': 'Hedefi kontrol edip Dışa aktar ile yeniden deneyin.',
  'error.redaction-geometry-unknown.message':
    'Eski karartma işaretlerinin koordinatları güvenle yorumlanamıyor.',
  'error.redaction-geometry-unknown.hint':
    'İşaretleri temizleyip belge üzerinde yeniden çizin veya metni yeniden arayın. Belgeniz değiştirilmedi.',
  'error.verification-failed.message': 'Kaydetme doğrulanamadı; özgün dosya korunuyor.',
  'error.verification-failed.hint': 'Belge kirli kaldı; Dışa aktar ile yeni dosya oluşturun.',
  'error.conflict.message': 'Dosya siz açtıktan sonra değişmiş.',
  'error.conflict.hint': 'Üzerine yazın, yeni dosya olarak kaydedin veya vazgeçin.',
  'error.asset-missing.message': 'Gerekli motor paketi indirilmemiş.',
  'error.asset-missing.hint': 'Çevrimdışı hazırlık ekranından paketi indirin.',
  'error.asset-hash-mismatch.message': 'Motor paketi doğrulanamadı.',
  'error.asset-hash-mismatch.hint': 'Paketi yeniden indirin.',
  'error.asset-offline.message': 'Bu özellik için paket indirilmesi gerekiyor.',
  'error.asset-offline.hint': 'İnternete bağlanıp paketi bir kez indirin.',
  'error.font-missing.message': 'Gerekli yazı tipi bulunamadı.',
  'error.font-missing.hint': 'Yazı tipi paketini indirin veya başka bir yazı tipi seçin.',
  'error.ocr-language-missing.message': 'Seçilen OCR dili yüklü değil.',
  'error.ocr-language-missing.hint': 'Dil paketini çevrimdışı hazırlık ekranından indirin.',
  'error.voice-unavailable.message': 'Cihazda yerel Türkçe ses bulunamadı.',
  'error.voice-unavailable.hint': 'İşletim sistemine yerel bir Türkçe ses kurun.',
  'error.permission-denied.message': 'Dosya erişim izni verilmedi.',
  'error.permission-denied.hint': 'İzin verin veya Dışa aktar ile indirin.',
  'error.internal.message': 'Beklenmeyen bir hata oluştu.',
  'error.internal.hint': 'İşlemi yeniden deneyin; sürerse bildirin.',

  'panel.attachments': 'Ekler',
  'panel.attachments.empty': 'Bu belgede ek yok.',
  'panel.attachments.save': 'Eki kaydet',
  'panel.layers': 'Katmanlar',
  'panel.layers.empty': 'Bu belgede katman yok.',
  'panel.signatures': 'İmzalar',
  'panel.signatures.empty': 'Bu belgede imza alanı yok.',
  'panel.signatures.unsigned': 'İmzalanmamış alan',
  'panel.signatures.signed': 'İmzalı',
  'panel.search': 'Sonuçlar',
  'panel.search.empty': 'Eşleşme yok.',
  'panel.search.count': '{count} eşleşme',
  'panel.search.running': 'Aranıyor…',
  'print.title': 'Yazdırma',
  'print.range': 'Sayfa aralığı',
  'print.rangeAll': 'Tüm sayfalar',
  'print.rangeCurrent': 'Geçerli görünüm',
  'print.rangeCustom': 'Aralık',
  'print.rangePlaceholder': 'örn. 1-3, 5, 8-10',
  'print.scale': 'Ölçek',
  'print.scaleFit': 'Sayfaya sığdır',
  'print.scaleActual': 'Gerçek boyut',
  'print.start': 'Yazdır',
  'print.cancel': 'Vazgeç',
  'print.invalidRange': 'Aralık okunamadı: {value}',
  'print.emptyRange': 'Seçilen aralıkta sayfa yok.',
  'print.preparing': 'Sayfalar hazırlanıyor: {done}/{total}',
  'reading.toggle': 'Okuma modu',
  'reading.voice': 'Sesli okuma',
  'reading.play': 'Oku',
  'reading.pause': 'Duraklat',
  'reading.stop': 'Durdur',
  'reading.rate': 'Hız',
  'reading.noLocalVoice': 'Cihazda yerel Türkçe ses yok; sesli okuma kullanılamıyor.',
  'reading.empty': 'Bu sayfada okunacak metin bulunamadı.',
  'reading.page': '{page}. sayfa',
  'tools.snapshot': 'Görüntü al',
  'tools.snapshotCopy': 'Panoya kopyala',
  'tools.snapshotCopied': 'Görüntü panoya kopyalandı.',
  'tools.snapshotDownload': 'PNG indir',
  'tools.snapshotSaved': 'Görüntü kaydedildi: {name}',
  'tools.magnifier': 'Büyüteç',
  'tools.present': 'Sunum modu',
  'tools.presentExit': 'Sunumdan çık',
  'lang.select': 'Dil',

  // Tools Rail
  'tools.backToAll': 'Tüm Araçlara Dön',
  'tools.group.pages': 'Sayfaları Düzenle',
  'tools.rotate': 'Sayfaları Döndür',
  'tools.rotateDesc': 'Sayfaları 90° sağa veya sola çevir',
  'tools.delete': 'Sayfaları Sil',
  'tools.deleteDesc': 'Seçili sayfaları belgeden kaldır',
  'tools.extract': 'Sayfaları Çıkart',
  'tools.extractDesc': 'Belirli sayfaları yeni PDF olarak ayır',
  'tools.split': 'Sayfaları Böl',
  'tools.splitDesc': 'Aralıklara veya sayfa sayısına göre böl',
  'tools.combine': 'Belge Birleştir / Ekle',
  'tools.combineDesc': 'Başka bir PDF dosyasını buraya ekle',
  'tools.group.export': 'PDF Dönüştür & İndir',
  'tools.exportOptions': 'Dışa Aktarma Seçenekleri',
  'tools.exportOptionsDesc': 'PDF, Sıkıştırılmış, Görsel, Metin',
  'tools.compress': 'PDF Boyutunu Sıkıştır',
  'tools.compressDesc': 'Dosya boyutunu kaliteden ödün vermeden küçült',
  'tools.exportImages': 'Sayfaları Görsel Olarak Kaydet',
  'tools.exportImagesDesc': 'PNG veya JPEG resim dosyası olarak aktar',
  'tools.exportText': 'Metin Olarak Dışa Aktar',
  'tools.exportTextDesc': 'Düz TXT formatında metin ayıkla',
  'tools.group.sign': 'Doldur ve İmzala',
  'tools.sign': 'Dijital İmza (PAdES)',
  'tools.signDesc': 'Yerel PKCS#12 sertifikası ile imzala',
  'tools.formFill': 'Form Alanlarını Doldur',
  'tools.formFillDesc': 'Mevcut form kutucuklarını yönet',
  'tools.formCreate': 'Yeni Form Alanı Ekle',
  'tools.formCreateDesc': 'Metin kutusu, onay kutusu veya buton ekle',
  'tools.group.security': 'Güvenlik ve Karartma',
  'tools.protect': 'Parola ile Koru',
  'tools.protectDesc': 'AES-256 şifreleme ve izin kısıtlama',
  'tools.unlock': 'Parolayı Kaldır',
  'tools.unlockDesc': 'Korumalı PDF şifresini çöz',
  'tools.redact': 'Kalıcı Karartma (Sansür)',
  'tools.redactDesc': 'Metin ve görselleri geri getirilemez sil',
  'tools.group.stamp': 'Numaralandırma & Filigran',
  'tools.pageNumbers': 'Sayfa Numaraları Ekle',
  'tools.pageNumbersDesc': 'Başlık ve altbilgiye sayfa numarası bas',
  'tools.watermark': 'Filigran Ekle',
  'tools.watermarkDesc': 'Sayfaların arkasına veya üstüne metin filigranı bas',
  'tools.searchCommands': 'Tüm Komutları Ara (Ctrl+K)',
  'tools.badgeNew': 'YENİ',

  // Export Dialog
  'export.title': 'İndir / Dışa Aktar',
  'export.thisPdf': 'Bu PDF ({size})',
  'export.compressed': 'Sıkıştırılmış PDF',
  'export.fileFormats': 'DOSYA FORMATLARI',
  'export.imageFormat': 'Görsel Formatı',
  'export.textFormat': 'Metin Formatı',
  'export.downloadPdf': 'PDF İndir',
  'export.downloadCompressed': 'Sıkıştırılmış PDF İndir',
  'export.downloadImages': 'Görselleri İndir',
  'export.downloadText': 'Metin Dosyasını İndir',
  'export.levelHigh': 'YÜKSEK',
  'export.levelMedium': 'ORTA',
  'export.levelLow': 'DÜŞÜK',

  // Context Menu
  'context.selection': 'Seçili Metin İşlemleri',
  'context.highlight': 'Vurgula',
  'context.underline': 'Altını Çiz',
  'context.strikeout': 'Üstünü Çiz',
  'context.copy': 'Metni Kopyala',
  'context.redact': 'Seçimi Karart / Sansürle',
  'context.addNote': 'Not Ekle',
  'context.pageAndEdit': 'Sayfa ve Düzenleme',
  'context.rotateCW': 'Saat Yönünde Döndür (90°)',
  'context.rotateCCW': 'Ters Yönde Döndür (-90°)',
  'context.deletePage': 'Mevcut Sayfayı Sil',
  'context.addText': 'Metin Ekle',
  'context.editText': 'Metni Düzenle',
  'context.drawInk': 'Serbest Çizim',
  'context.fitWidth': 'Genişliğe Sığdır',

  // Toolbars & Nav
  'toolbar.hand': 'El / Kaydırma Aracı',

  'update.available': 'Yeni bir güncelleme mevcut. Değişiklikleri uygulamak için yenileyin.',
  'update.refresh': 'Yenile',
} as const;

export type MessageKey = keyof typeof tr;
