/**
 * The state every feature of the shell shares: the notice line, the busy gate, the armed
 * canvas tool, the docks and their tabs, the interface mode, and the version counter that says
 * an engine handle was swapped. (The tabs themselves are `SessionStore`'s — `pdf-model` owns
 * them and nothing here duplicates them; the engine handles are `handles.ts`.)
 *
 * **Components** read it with `useCore(selector)`. **Handlers** read it with
 * `coreStore.get()` or `isBusy()` at the moment they run — never from a value captured at
 * render, which is what the `busyRef` / `canvasToolRef` mirrors this replaces were for — and
 * write it through the actions below, which are named for what the user did, not for the field
 * they happen to touch. A write that is one intent but several fields (opening a dock *on* a
 * tab, arming the stamp tool *with* its picture) is one action and one notification.
 */

import type { StampSource } from 'pdf-ui/dialog';
import type { CanvasShapeKind, CanvasToolId } from 'pdf-ui/tools';
import type { DocumentPanelTab } from 'pdf-ui/ui';
import type { InterfaceMode } from '../../commands';
import { readStoredMode, storeMode } from '../../interface-mode';
import { createStore, type Equality, useStore } from '../store';
import { isMarkupTool, type MarkupTool } from './tools';

/** Below this width the docks overlay the canvas instead of sharing the row with it. */
export const COMPACT_VIEW_QUERY = '(max-width: 1023px)';

export interface CoreState {
  /** The status line's message (already in the interface language); `null` for none. */
  readonly notice: string | null;
  /** An operation holds the document: every other gesture is refused until it settles. */
  readonly busy: boolean;
  /** Counts engine-handle swaps, so a component that reads a tab's handle re-renders on one. */
  readonly handleVersion: number;
  /**
   * **The one canvas tool.** Every surface that can arm or stop a tool writes this value and
   * nothing else — the left rail, the menu, the palette, the right rail, the context menu, the
   * text/link/redaction routes and the engine's own mode reset. The id is the armed state;
   * nothing else is. The redaction and text tools are derived from it (`'redact'`, `'text'`).
   */
  readonly canvasTool: CanvasToolId;
  /** The text-markup look the rail's markup button arms: the one used last, from any route. */
  readonly markupTool: MarkupTool;
  /** The picture the `stamp` tool places with the next click on a page. */
  readonly pendingStamp: StampSource | null;
  /** The shape subtype the next shape mark carries. */
  readonly shape: CanvasShapeKind;
  readonly compactViewport: boolean;
  readonly leftDock: boolean;
  readonly rightDock: boolean;
  /** The left dock's visible tab, so a menu or palette command can open a view. */
  readonly leftTab: DocumentPanelTab;
  /** The right dock's visible tab: a panel id (`tools`, `history`, `comments`, …). */
  readonly rightTab: string;
  /** Simple or advanced (`interface-mode.ts`). */
  readonly mode: InterfaceMode;
}

/** Whether the viewport is narrow enough for the docks to overlay the canvas; `false` with no window. */
export function isCompactViewport(): boolean {
  return typeof matchMedia === 'function' && matchMedia(COMPACT_VIEW_QUERY).matches;
}

/**
 * The state a fresh page starts in. Both docks start open on a desktop and closed on a narrow
 * screen, where two of them would leave no canvas; the mode is the one the user last chose.
 */
export function initialCoreState(): CoreState {
  const compact = isCompactViewport();
  return {
    notice: null,
    busy: false,
    handleVersion: 0,
    canvasTool: 'select',
    markupTool: 'highlight',
    pendingStamp: null,
    shape: 'square',
    compactViewport: compact,
    leftDock: !compact,
    rightDock: !compact,
    leftTab: 'pages',
    rightTab: 'history',
    mode: readStoredMode(),
  };
}

export const coreStore = createStore<CoreState>(initialCoreState());

/** The part of the core state a component reads (see `useStore` for the selector rules). */
export function useCore<T>(selector: (state: CoreState) => T, equality?: Equality<T>): T {
  return useStore(coreStore, selector, equality);
}

// ── The notice line ─────────────────────────────────────────────────────────────────────────

/** Say something on the status line, replacing what it said. */
export function showNotice(text: string): void {
  coreStore.set({ notice: text });
}

/**
 * Say it unless the line already says it: a failure that repeats on every change (a full
 * browser store refusing a draft) would otherwise rewrite the same sentence forever.
 */
export function showNoticeOnce(text: string): void {
  coreStore.set((state) => (state.notice?.includes(text) === true ? {} : { notice: text }));
}

/** Say it only when nothing is on the line: a result already showing wins over a footnote. */
export function showNoticeIfEmpty(text: string): void {
  coreStore.set((state) => (state.notice === null ? { notice: text } : {}));
}

/** Clear the line: a new operation starts, or the user dismissed it. */
export function clearNotice(): void {
  coreStore.set({ notice: null });
}

// ── The busy gate ───────────────────────────────────────────────────────────────────────────

/** An operation took (`true`) or released (`false`) the document. */
export function setBusy(busy: boolean): void {
  coreStore.set({ busy });
}

/** Whether an operation holds the document **now** — the synchronous half of the gate. */
export function isBusy(): boolean {
  return coreStore.get().busy;
}

/** An engine handle was swapped (`handles.ts`): components that read it render again. */
export function bumpHandleVersion(): void {
  coreStore.set((state) => ({ handleVersion: state.handleVersion + 1 }));
}

// ── Tools ───────────────────────────────────────────────────────────────────────────────────

/**
 * What arming `tool` changes. Two things follow a change of tool, from whichever route made
 * it: the stamp's picture belongs to the armed stamp tool, so any other tool drops it; and a
 * markup look becomes the one the rail's markup button arms next. Choosing the tool already
 * armed changes nothing.
 */
function armedTool(state: CoreState, tool: CanvasToolId): Partial<CoreState> {
  return tool === state.canvasTool
    ? {}
    : {
        canvasTool: tool,
        pendingStamp: tool === 'stamp' ? state.pendingStamp : null,
        markupTool: isMarkupTool(tool) ? tool : state.markupTool,
      };
}

/** Arm `tool` (or put the pointer back in `select`). */
export function selectTool(tool: CanvasToolId): void {
  coreStore.set((state) => armedTool(state, tool));
}

/**
 * Arm `tool`, or put the pointer back in `select` when it is the one already armed: the
 * second press of a toggle button (the header's text editing, the redaction panel's start/stop).
 */
export function toggleTool(tool: CanvasToolId): void {
  coreStore.set((state) => armedTool(state, state.canvasTool === tool ? 'select' : tool));
}

/**
 * A tool picked from a surface (the rail, the context menu). It writes the canonical tool and
 * nothing beside it, so "which button is pressed" and "which tool owns the pointer" cannot
 * disagree. The note is the one with a second half: its marks are comments, so arming it opens
 * the comment dock the user will edit them in.
 */
export function pickTool(tool: CanvasToolId): void {
  coreStore.set((state) =>
    tool === 'note'
      ? { ...armedTool(state, tool), rightDock: true, rightTab: 'comments' }
      : armedTool(state, tool),
  );
}

/** Arm the `stamp` tool with a picture; the next click on a page places it. */
export function armStampTool(source: StampSource): void {
  coreStore.set({ canvasTool: 'stamp', pendingStamp: source });
}

export function selectShape(shape: CanvasShapeKind): void {
  coreStore.set({ shape });
}

// ── Docks, tabs, mode ───────────────────────────────────────────────────────────────────────

export function showLeftDock(): void {
  coreStore.set({ leftDock: true });
}

export function hideLeftDock(): void {
  coreStore.set({ leftDock: false });
}

export function toggleLeftDock(): void {
  coreStore.set((state) => ({ leftDock: !state.leftDock }));
}

export function showRightDock(): void {
  coreStore.set({ rightDock: true });
}

export function hideRightDock(): void {
  coreStore.set({ rightDock: false });
}

export function toggleRightDock(): void {
  coreStore.set((state) => ({ rightDock: !state.rightDock }));
}

/** Switch the left dock's view without touching whether the dock is open. */
export function selectLeftTab(tab: DocumentPanelTab): void {
  coreStore.set({ leftTab: tab });
}

/** Switch the right dock's view without touching whether the dock is open. */
export function selectRightTab(tab: string): void {
  coreStore.set({ rightTab: tab });
}

/** Open the left dock on `tab`. */
export function openLeftPanel(tab: DocumentPanelTab): void {
  coreStore.set({ leftDock: true, leftTab: tab });
}

/** Open the right dock on `tab`. */
export function openRightPanel(tab: string): void {
  coreStore.set({ rightDock: true, rightTab: tab });
}

/**
 * A header toggle for one right-dock panel: it is either what the dock shows or it is not,
 * so a second press closes the dock rather than re-selecting the tab.
 */
export function toggleRightPanel(tab: string): void {
  coreStore.set((state) =>
    state.rightDock && state.rightTab === tab ? { rightDock: false } : { rightDock: true, rightTab: tab },
  );
}

/** The user chose simple or advanced: remembered across visits, and applied now. */
export function setInterfaceMode(mode: InterfaceMode): void {
  storeMode(mode);
  coreStore.set({ mode });
}

/**
 * The viewport crossed the compact breakpoint. Two desktop docks otherwise leave no canvas on
 * a narrow screen, hiding the tools beneath them, so narrowing closes both; widening leaves
 * them as the user has them.
 */
export function compactViewportChanged(compact: boolean): void {
  coreStore.set(
    compact ? { compactViewport: true, leftDock: false, rightDock: false } : { compactViewport: false },
  );
}
