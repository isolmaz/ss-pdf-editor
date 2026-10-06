/**
 * Recent documents storage manager (`localStorage`).
 * Fully local, zero-network, stores metadata only (never user bytes).
 */

export interface RecentDocumentItem {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly openedAt: number;
  readonly pageCount?: number;
  readonly starred?: boolean;
}

const STORAGE_KEY = 'pdf_editor_recent_docs_v1';
const MAX_RECENT_ITEMS = 25;

export function loadRecentDocuments(): RecentDocumentItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RecentDocumentItem =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.sizeBytes === 'number' &&
        typeof item.openedAt === 'number',
    );
  } catch {
    return [];
  }
}

export function saveRecentDocuments(items: readonly RecentDocumentItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_RECENT_ITEMS)));
  } catch {
    // quota error tolerated
  }
}

export function addRecentDocument(
  doc: Omit<RecentDocumentItem, 'openedAt'> & { openedAt?: number },
): RecentDocumentItem[] {
  const current = loadRecentDocuments();
  const filtered = current.filter((item) => item.id !== doc.id && item.name !== doc.name);
  const updated: RecentDocumentItem[] = [
    {
      id: doc.id,
      name: doc.name,
      sizeBytes: doc.sizeBytes,
      openedAt: doc.openedAt ?? Date.now(),
      pageCount: doc.pageCount,
      starred: doc.starred ?? false,
    },
    ...filtered,
  ].slice(0, MAX_RECENT_ITEMS);
  saveRecentDocuments(updated);
  return updated;
}

export function removeRecentDocument(id: string): RecentDocumentItem[] {
  const current = loadRecentDocuments();
  const updated = current.filter((item) => item.id !== id);
  saveRecentDocuments(updated);
  return updated;
}

export function toggleStarRecentDocument(id: string): RecentDocumentItem[] {
  const current = loadRecentDocuments();
  const updated = current.map((item) => (item.id === id ? { ...item, starred: !item.starred } : item));
  saveRecentDocuments(updated);
  return updated;
}

export function clearRecentDocuments(): RecentDocumentItem[] {
  saveRecentDocuments([]);
  return [];
}
