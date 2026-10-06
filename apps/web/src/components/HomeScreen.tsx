import {
  CloudArrowUp,
  Export,
  FilePdf,
  FilePlus,
  MagnifyingGlass,
  PencilSimple,
  PenNib,
  Star,
  Trash,
} from '@phosphor-icons/react';
import type { Translator } from 'pdf-shared';
import { useId, useState } from 'react';
import {
  clearRecentDocuments,
  loadRecentDocuments,
  type RecentDocumentItem,
  removeRecentDocument,
  toggleStarRecentDocument,
} from '../recent';

export interface HomeScreenProps {
  readonly t?: Translator;
  readonly onOpenFile: (file?: File) => void;
  readonly onSelectRecent?: (item: RecentDocumentItem) => void;
  readonly onOpenAction?: (action: 'edit' | 'sign' | 'export' | 'combine') => void;
  readonly onOpenPalette?: () => void;
  readonly busy?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp: number, locale = 'tr'): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (locale === 'en') {
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'short',
    });
  }

  if (minutes < 1) return 'Az önce';
  if (minutes < 60) return `${minutes} dk önce`;
  if (hours < 24) return `${hours} sa önce`;
  if (days === 1) return 'Dün';
  if (days < 7) return `${days} gün önce`;
  return new Date(timestamp).toLocaleDateString('tr-TR', {
    day: 'numeric',
    month: 'short',
  });
}

export function HomeScreen({
  t,
  onOpenFile,
  onSelectRecent,
  onOpenAction,
  onOpenPalette,
  busy = false,
}: HomeScreenProps) {
  const [recentItems, setRecentItems] = useState<RecentDocumentItem[]>(() => loadRecentDocuments());
  const [topTab, setTopTab] = useState<'discover' | 'tools'>('discover');
  const [recentTab, setRecentTab] = useState<'recent' | 'starred'>('recent');
  const fileInputId = useId();

  const text_ = (key: string, fallback: string) => (t ? t(key as never) : fallback);

  const displayedItems = recentItems.filter((item) => {
    if (recentTab === 'starred') return item.starred;
    return true;
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onOpenFile(file);
    }
  };

  const handleCardClick = (action: 'edit' | 'sign' | 'export' | 'combine') => {
    if (onOpenAction) {
      onOpenAction(action);
    } else {
      onOpenFile();
    }
  };

  const handleRemove = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = removeRecentDocument(id);
    setRecentItems(updated);
  };

  const handleToggleStar = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = toggleStarRecentDocument(id);
    setRecentItems(updated);
  };

  const handleClearAll = () => {
    const updated = clearRecentDocuments();
    setRecentItems(updated);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-kumo-canvas px-6 py-6 text-kumo-default md:px-12 select-none">
      <input
        id={fileInputId}
        type="file"
        accept="application/pdf"
        className="sr-only"
        onChange={handleFileSelect}
        disabled={busy}
      />

      {/* Top Section: Discover / Tools Tabs */}
      <div className="flex items-center justify-between border-b border-kumo-line pb-2">
        <div className="flex items-center gap-6">
          <button
            type="button"
            className={`pb-2 text-sm font-semibold transition-colors ${
              topTab === 'discover'
                ? 'border-b-2 border-pdf-accent text-kumo-strong'
                : 'text-kumo-subtle hover:text-kumo-default'
            }`}
            onClick={() => setTopTab('discover')}
          >
            {text_('home.discover', 'Keşfet')}
          </button>
          <button
            type="button"
            className={`pb-2 text-sm font-semibold transition-colors ${
              topTab === 'tools'
                ? 'border-b-2 border-pdf-accent text-kumo-strong'
                : 'text-kumo-subtle hover:text-kumo-default'
            }`}
            onClick={() => setTopTab('tools')}
          >
            {text_('home.tools', 'Araçlar')}
          </button>
        </div>
        <div className="flex items-center gap-3">
          {onOpenPalette ? (
            <button
              type="button"
              className="flex items-center gap-1.5 text-xs font-medium text-kumo-strong hover:underline"
              onClick={onOpenPalette}
            >
              <MagnifyingGlass size={14} />
              {text_('home.allTools', 'Tüm araçlar (Ctrl+K)')}
            </button>
          ) : null}
        </div>
      </div>

      {/* Hero Quick Action Cards */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5 text-left">
        {/* Card 1: Edit text & images */}
        <button
          type="button"
          onClick={() => handleCardClick('edit')}
          className="group flex flex-col justify-between rounded-lg border border-kumo-line bg-kumo-base p-4 text-left transition-all hover:border-kumo-contrast hover:bg-kumo-recessed cursor-pointer"
        >
          <div>
            <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-kumo-recessed text-pdf-accent group-hover:scale-105 transition-transform">
              <PencilSimple size={20} weight="duotone" />
            </div>
            <h3 className="text-sm font-semibold text-kumo-strong">
              {text_('home.editCardTitle', 'Metin ve görselleri düzenle')}
            </h3>
            <p className="mt-1.5 text-xs text-kumo-subtle leading-relaxed">
              {text_(
                'home.editCardDesc',
                'Metinleri, görselleri ve sayfa yerleşimlerini doğrudan belgenin üzerinde değiştirin.',
              )}
            </p>
          </div>
          <div className="mt-4 pt-2 border-t border-kumo-line/50 text-[11px] font-medium text-pdf-accent">
            {text_('home.chooseOrDrop', 'Dosya seçin veya sürükleyin →')}
          </div>
        </button>

        {/* Card 2: Fill & sign */}
        <button
          type="button"
          onClick={() => handleCardClick('sign')}
          className="group flex flex-col justify-between rounded-lg border border-kumo-line bg-kumo-base p-4 text-left transition-all hover:border-kumo-contrast hover:bg-kumo-recessed cursor-pointer"
        >
          <div>
            <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-kumo-recessed text-pdf-accent group-hover:scale-105 transition-transform">
              <PenNib size={20} weight="duotone" />
            </div>
            <h3 className="text-sm font-semibold text-kumo-strong">
              {text_('home.signCardTitle', 'Doldur ve imzala')}
            </h3>
            <p className="mt-1.5 text-xs text-kumo-subtle leading-relaxed">
              {text_(
                'home.signCardDesc',
                'Form alanlarını doldurun, görsel damga ekleyin veya yasal PAdES dijital imzanızı atın.',
              )}
            </p>
          </div>
          <div className="mt-4 pt-2 border-t border-kumo-line/50 text-[11px] font-medium text-pdf-accent">
            {text_('home.chooseOrDrop', 'Dosya seçin veya sürükleyin →')}
          </div>
        </button>

        {/* Card 3: Export a PDF */}
        <button
          type="button"
          onClick={() => handleCardClick('export')}
          className="group flex flex-col justify-between rounded-lg border border-kumo-line bg-kumo-base p-4 text-left transition-all hover:border-kumo-contrast hover:bg-kumo-recessed cursor-pointer"
        >
          <div>
            <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-kumo-recessed text-pdf-accent group-hover:scale-105 transition-transform">
              <Export size={20} weight="duotone" />
            </div>
            <h3 className="text-sm font-semibold text-kumo-strong">
              {text_('home.exportCardTitle', 'PDF dışa aktar')}
            </h3>
            <p className="mt-1.5 text-xs text-kumo-subtle leading-relaxed">
              {text_(
                'home.exportCardDesc',
                'Belgenizi yüksek çözünürlüklü görsellere (PNG/JPEG), Markdown veya düz metne dönüştürün.',
              )}
            </p>
          </div>
          <div className="mt-4 pt-2 border-t border-kumo-line/50 text-[11px] font-medium text-pdf-accent">
            {text_('home.chooseOrDrop', 'Dosya seçin veya sürükleyin →')}
          </div>
        </button>

        {/* Card 4: Combine files */}
        <button
          type="button"
          onClick={() => handleCardClick('combine')}
          className="group flex flex-col justify-between rounded-lg border border-kumo-line bg-kumo-base p-4 text-left transition-all hover:border-kumo-contrast hover:bg-kumo-recessed cursor-pointer"
        >
          <div>
            <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-kumo-recessed text-pdf-accent group-hover:scale-105 transition-transform">
              <FilePlus size={20} weight="duotone" />
            </div>
            <h3 className="text-sm font-semibold text-kumo-strong">
              {text_('home.combineCardTitle', 'Dosyaları birleştir')}
            </h3>
            <p className="mt-1.5 text-xs text-kumo-subtle leading-relaxed">
              {text_(
                'home.combineCardDesc',
                'Birden fazla PDF belgesini sayfa yapısını, formlarını ve anahattını koruyarak birleştirin.',
              )}
            </p>
          </div>
          <div className="mt-4 pt-2 border-t border-kumo-line/50 text-[11px] font-medium text-pdf-accent">
            {text_('home.chooseFiles', 'Dosyaları seçin →')}
          </div>
        </button>

        {/* Card 5: Cloud Dropzone */}
        <label
          htmlFor={fileInputId}
          className="group flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-kumo-line bg-kumo-base/50 p-4 text-center transition-all hover:border-pdf-accent hover:bg-kumo-base cursor-pointer"
        >
          <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-kumo-recessed text-pdf-accent group-hover:scale-110 transition-transform">
            <CloudArrowUp size={24} weight="duotone" />
          </div>
          <span className="text-xs font-semibold text-kumo-strong">
            {text_('home.dropzoneTitle', 'PDF dosyasını buraya bırakın')}
          </span>
          <span className="mt-1 text-[11px] text-kumo-subtle">
            {text_('home.dropzoneDesc', 'veya cihazınızdan seçin')}
          </span>
        </label>
      </div>

      {/* Bottom Section: Recent Documents Table */}
      <div className="mt-10 flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-kumo-line pb-2">
          <div className="flex items-center gap-6">
            <button
              type="button"
              className={`pb-2 text-sm font-semibold transition-colors ${
                recentTab === 'recent'
                  ? 'border-b-2 border-pdf-accent text-kumo-strong'
                  : 'text-kumo-subtle hover:text-kumo-default'
              }`}
              onClick={() => setRecentTab('recent')}
            >
              {text_('home.recentTab', 'Son Kullanılanlar')}
            </button>
            <button
              type="button"
              className={`pb-2 text-sm font-semibold transition-colors ${
                recentTab === 'starred'
                  ? 'border-b-2 border-pdf-accent text-kumo-strong'
                  : 'text-kumo-subtle hover:text-kumo-default'
              }`}
              onClick={() => setRecentTab('starred')}
            >
              {text_('home.starredTab', 'Yıldızlı')}
            </button>
          </div>

          {displayedItems.length > 0 ? (
            <button
              type="button"
              className="text-xs text-kumo-subtle hover:text-kumo-danger transition-colors"
              onClick={handleClearAll}
            >
              {text_('home.clearList', 'Listeyi temizle')}
            </button>
          ) : null}
        </div>

        {/* Table Content */}
        {displayedItems.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
            <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-kumo-recessed text-kumo-subtle">
              <FilePdf size={28} weight="duotone" />
            </div>
            <h4 className="text-sm font-medium text-kumo-strong">
              {recentTab === 'starred'
                ? text_('home.noStarred', 'Henüz yıldızlanan bir belge yok.')
                : text_('home.noRecent', 'Son kullanılan belge bulunmuyor.')}
            </h4>
            <p className="mt-1 max-w-sm text-xs text-kumo-subtle">
              {text_(
                'home.privacyNotice',
                'Açtığınız PDF belgeleri tarayıcınızın yerel belleğinde güvenle tutulur. Hiçbir belge dış sunucuya gönderilmez.',
              )}
            </p>
            <label
              htmlFor={fileInputId}
              className="mt-4 inline-flex items-center gap-2 rounded-md bg-pdf-accent px-4 py-2 text-xs font-medium text-pdf-on-accent hover:opacity-90 cursor-pointer"
            >
              <FilePdf size={16} />
              {text_('home.dropzoneDesc', 'Cihazdan PDF Seç')}
            </label>
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs text-kumo-default">
              <thead>
                <tr className="border-b border-kumo-line text-[11px] font-medium uppercase tracking-wider text-kumo-subtle">
                  <th scope="col" className="py-2.5 pl-2 pr-4 w-8">
                    <span className="sr-only">{text_('home.colActions', 'İşlem')}</span>
                  </th>
                  <th scope="col" className="py-2.5 px-4 font-semibold">
                    {text_('home.colName', 'Belge Adı')}
                  </th>
                  <th scope="col" className="py-2.5 px-4 font-semibold hidden sm:table-cell">
                    {text_('home.colPrivacy', 'Gizlilik & Paylaşım')}
                  </th>
                  <th scope="col" className="py-2.5 px-4 font-semibold">
                    {text_('home.colLastOpened', 'Son Açılma')}
                  </th>
                  <th scope="col" className="py-2.5 px-4 font-semibold text-right">
                    {text_('home.colSize', 'Boyut')}
                  </th>
                  <th scope="col" className="py-2.5 pl-4 pr-2 w-10 text-right">
                    <span className="sr-only">{text_('common.actions', 'Eylemler')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-kumo-line/40">
                {displayedItems.map((item) => (
                  <tr
                    key={item.id}
                    tabIndex={0}
                    onClick={() => {
                      if (onSelectRecent) onSelectRecent(item);
                      else onOpenFile();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        if (onSelectRecent) onSelectRecent(item);
                        else onOpenFile();
                      }
                    }}
                    className="group hover:bg-kumo-base/80 cursor-pointer transition-colors"
                  >
                    <td className="py-3 pl-2 pr-4 text-center">
                      <button
                        type="button"
                        aria-label={
                          item.starred
                            ? text_('home.unstar', 'Yıldızı kaldır')
                            : text_('home.star', 'Yıldızla')
                        }
                        onClick={(e) => handleToggleStar(item.id, e)}
                        className={`transition-colors ${
                          item.starred
                            ? 'text-kumo-warning fill-kumo-warning'
                            : 'text-kumo-subtle/50 hover:text-kumo-subtle'
                        }`}
                      >
                        <Star size={16} weight={item.starred ? 'fill' : 'regular'} />
                      </button>
                    </td>
                    <td className="py-3 px-4 font-medium text-kumo-strong">
                      <div className="flex items-center gap-2">
                        <FilePdf size={18} className="shrink-0 text-pdf-accent" />
                        <span className="truncate max-w-[280px]">{item.name}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-kumo-subtle hidden sm:table-cell">
                      <span className="inline-flex items-center rounded bg-kumo-recessed px-2 py-0.5 text-[11px] font-medium text-kumo-strong border border-kumo-line/50">
                        {text_('home.localDevice', 'Yerel Cihaz')}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-kumo-subtle whitespace-nowrap">
                      {formatDate(
                        item.openedAt,
                        t?.locale ?? (typeof document !== 'undefined' ? document.documentElement.lang : 'tr'),
                      )}
                    </td>
                    <td className="py-3 px-4 text-right tabular-nums text-kumo-subtle whitespace-nowrap">
                      {formatBytes(item.sizeBytes)}
                    </td>
                    <td className="py-3 pl-4 pr-2 text-right">
                      <button
                        type="button"
                        aria-label={text_('home.removeFromList', 'Listeden kaldır')}
                        onClick={(e) => handleRemove(item.id, e)}
                        className="rounded p-1 text-kumo-subtle opacity-0 group-hover:opacity-100 hover:bg-kumo-recessed hover:text-kumo-danger transition-all"
                      >
                        <Trash size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
