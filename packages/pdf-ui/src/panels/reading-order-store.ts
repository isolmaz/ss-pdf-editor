/**
 * The meeting point of the tags panel and the reading-order overlay.
 *
 * The panel knows the structure (which element is number 3 on page 2, which one the user
 * selected); the overlay lives inside the viewer's scroll container, three components away,
 * and only has to draw boxes. A tiny external store between them keeps `App.tsx` out of it:
 * the panel writes what to draw, the layer reads it, and a click on a box writes the
 * selection back the other way.
 *
 * It also remembers which of the accessibility panel's three views was open. The panel is
 * re-mounted for every new revision of the document (`key={working.id}`), so a view kept in
 * component state would jump back to the report after every edit the user applied.
 */

import { useSyncExternalStore } from 'react';

/** `[x0, y0, x1, y1]`, page-relative, top-left origin, unrotated points. */
export type OverlayRect = readonly [number, number, number, number];

export interface OverlayItem {
  /** The structure element's key, or the candidate id of an untagged block. */
  readonly key: string;
  /** The reading-order number on this page (1-based). */
  readonly number: number;
  /** The element's type as written (`H1`, `Figure`, …), shown beside the number. */
  readonly role: string;
  readonly rect: OverlayRect;
}

export interface OverlayPage {
  readonly pageIndex: number;
  /** The visible page box, unrotated. */
  readonly width: number;
  readonly height: number;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly items: readonly OverlayItem[];
}

export type AccessibilityView = 'report' | 'ua' | 'tags';

interface State {
  readonly pages: readonly OverlayPage[];
  readonly selectedKeys: readonly string[];
  readonly view: AccessibilityView;
  /** A request to open an element in the tags view (from a PDF/UA row), consumed once. */
  readonly focus: { readonly key: string; readonly pageIndex: number | null } | null;
}

let state: State = { pages: [], selectedKeys: [], view: 'report', focus: null };
const listeners = new Set<() => void>();

function emit(next: State): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const readingOrderStore = {
  setPages(pages: readonly OverlayPage[]): void {
    emit({ ...state, pages });
  },
  clear(): void {
    emit({ ...state, pages: [], selectedKeys: [] });
  },
  setSelected(keys: readonly string[]): void {
    emit({ ...state, selectedKeys: keys });
  },
  setView(view: AccessibilityView): void {
    emit({ ...state, view });
  },
  focusElement(key: string, pageIndex: number | null): void {
    emit({ ...state, view: 'tags', focus: { key, pageIndex } });
  },
  takeFocus(): State['focus'] {
    const focus = state.focus;
    if (focus !== null) emit({ ...state, focus: null });
    return focus;
  },
  snapshot(): State {
    return state;
  },
};

export function useReadingOrder(): State {
  return useSyncExternalStore(subscribe, readingOrderStore.snapshot, readingOrderStore.snapshot);
}
