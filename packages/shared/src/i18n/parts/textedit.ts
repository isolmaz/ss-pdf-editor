/**
 * Text editing (`PLAN.md §5/Phase 4a-4f`).
 *
 * Two vocabulary decisions worth keeping:
 *
 *  - **"blok" is used for what the engine reports as a text block**, because that is
 *    the unit the user really edits: a paragraph reflows inside its own box, and the
 *    surrounding page is untouched. Calling it "metin kutusu" would promise an
 *    object model the PDF does not have.
 *  - **The substitution sentence is a promise, not an apology.** A subset font does
 *    not carry the glyphs for characters that were never in the original document,
 *    so the edited block is re-rendered with an embedded substitute. Acrobat works
 *    under the same limit; saying so before the edit is the honest version.
 */
export const texteditPart = {
  'textedit.title': 'Metni düzenle',
  'textedit.intro':
    'Düzenlemek istediğiniz paragrafa tıklayın. Metin kendi kutusu içinde yeniden akıtılır; sayfanın geri kalanı değişmez.',
  'textedit.field.text': 'Metin',
  'textedit.field.textHint': 'Boş bırakırsanız paragraf tamamen silinir.',
  'textedit.field.align': 'Hizalama',
  'textedit.field.fontSize': 'Yazı boyutu',
  'textedit.field.leading': 'Satır aralığı',
  'textedit.field.font': 'Yazı tipi',
  'textedit.field.color': 'Renk',
  'textedit.field.hyphenate': 'Heceleme ile böl',
  'textedit.align.left': 'Sola',
  'textedit.align.center': 'Ortaya',
  'textedit.align.right': 'Sağa',
  'textedit.align.justify': 'İki yana yasla',
  'textedit.font.auto': 'Özgün yazı tipine en yakın',
  'textedit.font.notoSans': 'Noto Sans (gömülür)',
  'textedit.font.notoSansSemibold': 'Noto Sans Kalın (gömülür)',
  'textedit.unit.pt': 'pt',
  'textedit.done': 'Metin güncellendi: {count} satır yeniden yazıldı.',
  'textedit.readFailed': 'Bu sayfanın metni okunamadı; düzenleme kapatıldı.',
  'textedit.reason.ok': 'Düzenlenebilir',
  'textedit.reason.embedded-font':
    'Gömülü yazı tipi — düzenlenebilir, yeni karakterler için yazı tipi değiştirilir',
  'textedit.reason.standard-font': 'Standart yazı tipi — düzenlenebilir, yazı tipi gömülerek değiştirilir',
  'textedit.reason.type3': 'Type3 yazı tipi — düzenlenemez',
  'textedit.reason.no-glyphs': 'Yazı tipinde glif yok — düzenlenemez',
  'textedit.reason.rotated': 'Döndürülmüş metin — düzenlenemez',
  'textedit.reason.skewed': 'Eğik dönüşüm — düzenlenemez',
  'textedit.reason.scanned': 'Taranmış sayfa — metin katmanı yok',
  'textedit.reason.image-only': 'Yalnızca görüntü — düzenlenebilir metin yok',
  'op.progress.textEdit.layout': 'Yeni satır düzeni hesaplanıyor',
  'cmd.textEdit.label': 'Metni düzenle',
} as const;
