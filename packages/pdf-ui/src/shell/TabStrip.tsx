import { X } from '@phosphor-icons/react';
import type { KeyboardEvent } from 'react';
import { useEffect, useRef } from 'react';

/**
 * Document tab strip.
 *
 * Deliberately **not** an ARIA `tablist`: the strip switches open documents, it
 * is not a tab widget whose tabs own `tabpanel`s, and a close control inside a
 * `tab` is not a legal tablist child (`aria-required-children`, verified with
 * axe). The correct shape for "arrow keys move between these buttons" is a
 * horizontal `toolbar` with roving tabindex, so that is what this is: the active
 * document is marked with `aria-current` and every close button is reachable
 * with Tab.
 */

export interface DocumentTabDescriptor {
  readonly id: string;
  readonly name: string;
  readonly dirty: boolean;
}

export interface TabStripProps {
  readonly tabs: readonly DocumentTabDescriptor[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
  /** Commit a new document name. Absent disables renaming (`A18`). */
  readonly onRename?: (id: string, name: string) => void;
  /** The tab whose name is currently being edited, if any. */
  readonly renamingId?: string | null;
  /** Cancel the inline editor without changing the name (`Escape`). */
  readonly onRenameCancel?: () => void;
  readonly closeLabel: string;
  readonly dirtyLabel: string;
  readonly renameLabel: string;
  readonly stripLabel: string;
}

export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onRename,
  renamingId,
  onRenameCancel,
  closeLabel,
  dirtyLabel,
  renameLabel,
  stripLabel,
}: TabStripProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  /** The in-progress name while the inline editor is open; committed on Enter or blur. */
  const draftName = useRef<string>('');

  // Seed the draft from the tab being renamed so opening the editor on tab B after
  // editing tab A never carries A's text over.
  useEffect(() => {
    draftName.current = tabs.find((tab) => tab.id === renamingId)?.name ?? '';
  }, [renamingId, tabs]);

  const commitRename = (id: string, fallback: string) => {
    if (onRename === undefined) return;
    const name = draftName.current.trim();
    onRename(id, name === '' ? fallback : name);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (
      event.key !== 'ArrowRight' &&
      event.key !== 'ArrowLeft' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    event.preventDefault();
    const last = tabs.length - 1;
    const nextIndex =
      event.key === 'ArrowRight'
        ? Math.min(index + 1, last)
        : event.key === 'ArrowLeft'
          ? Math.max(index - 1, 0)
          : event.key === 'Home'
            ? 0
            : last;
    const target = tabs[nextIndex];
    if (target === undefined) return;
    onSelect(target.id);
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-document-tab]');
    buttons?.[nextIndex]?.focus();
  };

  if (tabs.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="toolbar"
      aria-label={stripLabel}
      aria-orientation="horizontal"
      className="flex h-[var(--spacing-pdf-tabstrip)] items-stretch gap-1 overflow-x-auto border-b border-kumo-line bg-kumo-recessed px-1"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={`group flex items-center rounded-t-md border-x border-t text-xs ${
              selected
                ? 'border-kumo-line bg-kumo-base text-kumo-strong'
                : 'border-transparent text-kumo-subtle hover:bg-kumo-tint'
            }`}
          >
            {renamingId === tab.id && onRename !== undefined ? (
              <input
                // biome-ignore lint/a11y/noAutofocus: the inline editor is opened by an explicit rename command, not on load.
                autoFocus
                type="text"
                defaultValue={tab.name}
                aria-label={renameLabel}
                onChange={(event) => {
                  draftName.current = event.target.value;
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitRename(tab.id, tab.name);
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    onRenameCancel?.();
                  }
                }}
                onBlur={() => commitRename(tab.id, tab.name)}
                className="h-full w-40 bg-transparent px-3 text-xs text-kumo-strong outline-none"
              />
            ) : (
              <button
                type="button"
                data-document-tab={tab.id}
                aria-current={selected ? 'true' : undefined}
                tabIndex={selected ? 0 : -1}
                onClick={() => onSelect(tab.id)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className="flex h-full max-w-56 items-center gap-2 px-3 text-left"
              >
                <span className="truncate">{tab.name}</span>
                {tab.dirty ? (
                  <>
                    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-pdf-accent" />
                    <span className="sr-only">{dirtyLabel}</span>
                  </>
                ) : null}
              </button>
            )}
            <button
              type="button"
              aria-label={`${closeLabel}: ${tab.name}`}
              onClick={() => onClose(tab.id)}
              className="mr-1 grid size-6 place-items-center rounded-sm text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
