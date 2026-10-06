import type { Icon } from '@phosphor-icons/react';
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ChatCenteredText,
  Copy,
  EyeSlash,
  Highlighter,
  MagnifyingGlassPlus,
  PencilSimple,
  TextAa,
  TextStrikethrough,
  TextT,
  TextUnderline,
  Trash,
} from '@phosphor-icons/react';
import type { MessageKey, Translator } from 'pdf-shared';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The document's right-click menu.
 *
 * Every entry is an intent the shell already has a route for — the same armed tool the
 * rail sets, the same page action the page panel runs — so the menu adds no second way
 * of doing anything. With text selected, the markup entries mark **that selection** (the
 * annotation layer commits a selection that is already there when a text tool is
 * armed), and "redact" turns it into pending redaction areas.
 *
 * Entries that write are disabled while the document cannot be edited, instead of
 * running into a refusal nobody sees; page actions act on the page panel's selection,
 * or on the page on screen when nothing is selected.
 */
export interface ContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly t: Translator;
  readonly hasSelection: boolean;
  readonly selectedText?: string;
  /** The document can be edited; the writing entries are disabled otherwise. */
  readonly canEdit: boolean;
  readonly onHighlight?: () => void;
  readonly onUnderline?: () => void;
  readonly onStrikeout?: () => void;
  readonly onCopy?: () => void;
  readonly onRedact?: () => void;
  readonly onAddNote?: () => void;
  readonly onRotateRight?: () => void;
  readonly onRotateLeft?: () => void;
  readonly onDeletePage?: () => void;
  readonly onAddText?: () => void;
  readonly onEditText?: () => void;
  readonly onDrawInk?: () => void;
  readonly onFitWidth?: () => void;
  readonly onClose: () => void;
}

interface Entry {
  readonly key: MessageKey;
  readonly icon: Icon;
  readonly run: (() => void) | undefined;
  /** Writes to the document. */
  readonly writes: boolean;
  readonly danger?: boolean;
}

interface Section {
  readonly title: MessageKey;
  readonly entries: readonly Entry[];
}

const ITEM_CLASS =
  'flex items-center gap-2 rounded px-2 py-1.5 text-start transition-colors disabled:cursor-not-allowed disabled:opacity-40';
const EDGE = 8;

export function ContextMenu({
  x,
  y,
  t,
  hasSelection,
  canEdit,
  onHighlight,
  onUnderline,
  onStrikeout,
  onCopy,
  onRedact,
  onAddNote,
  onRotateRight,
  onRotateLeft,
  onDeletePage,
  onAddText,
  onEditText,
  onDrawInk,
  onFitWidth,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Kept inside the viewport by its **measured** size: a fixed guess let the longer
  // menu (with the selection block) run past the bottom edge.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE)),
    });
  }, [x, y]);

  useEffect(() => {
    const handleOutside = (event: PointerEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', handleOutside, true);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', handleOutside, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose]);

  const sections: Section[] = [];
  if (hasSelection) {
    sections.push({
      title: 'context.selection',
      entries: [
        { key: 'context.highlight', icon: Highlighter, run: onHighlight, writes: true },
        { key: 'context.underline', icon: TextUnderline, run: onUnderline, writes: true },
        { key: 'context.strikeout', icon: TextStrikethrough, run: onStrikeout, writes: true },
        { key: 'context.copy', icon: Copy, run: onCopy, writes: false },
        { key: 'context.redact', icon: EyeSlash, run: onRedact, writes: true, danger: true },
        { key: 'context.addNote', icon: ChatCenteredText, run: onAddNote, writes: true },
      ],
    });
  }
  sections.push({
    title: 'context.pageAndEdit',
    entries: [
      { key: 'context.rotateCW', icon: ArrowClockwise, run: onRotateRight, writes: true },
      { key: 'context.rotateCCW', icon: ArrowCounterClockwise, run: onRotateLeft, writes: true },
      { key: 'context.deletePage', icon: Trash, run: onDeletePage, writes: true, danger: true },
      { key: 'context.addText', icon: TextAa, run: onAddText, writes: true },
      { key: 'context.editText', icon: TextT, run: onEditText, writes: true },
      { key: 'context.drawInk', icon: PencilSimple, run: onDrawInk, writes: true },
      { key: 'context.fitWidth', icon: MagnifyingGlassPlus, run: onFitWidth, writes: false },
    ],
  });

  return (
    <div
      ref={menuRef}
      role="menu"
      style={position}
      className="pdf-floating-shadow fixed z-50 flex min-w-[200px] flex-col rounded-lg border border-kumo-line bg-kumo-base p-1 text-xs select-none"
    >
      {sections.map((section, index) => (
        <Fragment key={section.title}>
          {index > 0 ? <span aria-hidden="true" className="my-1 h-px w-full bg-kumo-line/60" /> : null}
          <div className="px-2 py-1 text-[11px] font-bold tracking-wider text-kumo-subtle uppercase">
            {t(section.title)}
          </div>
          {section.entries
            .filter((entry) => entry.run !== undefined)
            .map(({ key, icon: Glyph, run, writes, danger }) => (
              <button
                key={key}
                type="button"
                role="menuitem"
                disabled={writes && !canEdit}
                onClick={() => {
                  run?.();
                  onClose();
                }}
                className={`${ITEM_CLASS} ${
                  danger === true
                    ? 'text-kumo-danger hover:bg-kumo-danger-tint'
                    : 'text-kumo-default hover:bg-kumo-recessed hover:text-kumo-strong'
                }`}
              >
                <Glyph size={14} aria-hidden="true" />
                <span>{t(key)}</span>
              </button>
            ))}
        </Fragment>
      ))}
    </div>
  );
}
