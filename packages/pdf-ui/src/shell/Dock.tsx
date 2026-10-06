/**
 * Adobe Acrobat style Dock host: a slim vertical icon rail paired with an active content panel.
 * Clean, compact, zero-wrapping, strictly accessible.
 */

import {
  Bookmarks,
  CaretDoubleLeft,
  CaretDoubleRight,
  ChatCenteredText,
  CheckSquare,
  ClockCounterClockwise,
  EyeSlash,
  Files,
  GitDiff,
  Info,
  MagnifyingGlass,
  Paperclip,
  ShieldCheck,
  ShieldWarning,
  Stack,
  Wheelchair,
  Wrench,
} from '@phosphor-icons/react';
import type { MessageKey, Translator } from 'pdf-shared';
import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';
import { Tooltip } from '../components/Tooltip';

export interface DockTab {
  readonly id: string;
  /** Dictionary key, so a tab can never carry an invented name. */
  readonly label: MessageKey;
  readonly icon?: React.ElementType;
}

export interface DockProps {
  readonly t: Translator;
  readonly side: 'left' | 'right';
  readonly tabs: readonly DockTab[];
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
  /** Collapse control; the app re-opens the dock from the menu, edge handle or shortcuts. */
  readonly onToggle: () => void;
  /** The active tab's content. */
  readonly children: ReactNode;
}

const DEFAULT_ICONS: Record<string, React.ElementType> = {
  pages: Files,
  outline: Bookmarks,
  attachments: Paperclip,
  layers: Stack,
  signatures: ShieldCheck,
  search: MagnifyingGlass,
  tools: Wrench,
  comments: ChatCenteredText,
  history: ClockCounterClockwise,
  forms: CheckSquare,
  properties: Info,
  redaction: EyeSlash,
  'redaction-audit': ShieldWarning,
  compare: GitDiff,
  accessibility: Wheelchair,
};

export function Dock({ t, side, tabs, activeId, onSelect, onToggle, children }: DockProps) {
  const id = useId();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  if (tabs.length === 0) return null;

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  if (active === undefined) return null;

  const panelId = `${id}-panel`;
  const tabDomId = (tabId: string) => `${id}-tab-${tabId}`;

  const focusTabAt = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length];
    if (next === undefined) return;
    tabRefs.current.get(next.id)?.focus();
    onSelect(next.id);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusTabAt(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        focusTabAt(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusTabAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusTabAt(tabs.length - 1);
        break;
      default:
        break;
    }
  };

  const iconStrip = (
    <div
      role="tablist"
      aria-label={t(side === 'left' ? 'dock.left' : 'dock.right')}
      className="flex w-11 shrink-0 flex-col items-center gap-1.5 bg-kumo-base py-2 select-none"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === active.id;
        const Icon = tab.icon ?? DEFAULT_ICONS[tab.id] ?? Files;
        return (
          <Tooltip key={tab.id} label={t(tab.label)} side={side === 'left' ? 'right' : 'left'}>
            <button
              type="button"
              role="tab"
              id={tabDomId(tab.id)}
              aria-label={t(tab.label)}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              ref={(element) => {
                if (element === null) tabRefs.current.delete(tab.id);
                else tabRefs.current.set(tab.id, element);
              }}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              className={`flex size-8 items-center justify-center rounded-md transition-colors ${
                selected
                  ? 'bg-pdf-accent text-pdf-on-accent shadow-xs'
                  : 'text-kumo-default hover:bg-kumo-recessed hover:text-kumo-strong'
              }`}
            >
              <Icon size={18} weight={selected ? 'fill' : 'regular'} aria-hidden="true" />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );

  const panelContent = (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-kumo-base">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-kumo-line px-3 select-none">
        <span className="text-xs font-bold uppercase tracking-wider text-kumo-strong">{t(active.label)}</span>
        <button
          type="button"
          onClick={onToggle}
          title={t(side === 'left' ? 'dock.toggleLeft' : 'dock.toggleRight')}
          aria-label={t(side === 'left' ? 'dock.toggleLeft' : 'dock.toggleRight')}
          className="flex size-6 items-center justify-center rounded text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-strong transition-colors"
        >
          {side === 'left' ? <CaretDoubleLeft size={14} /> : <CaretDoubleRight size={14} />}
        </button>
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabDomId(active.id)}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {children}
      </div>
    </div>
  );

  return (
    <div
      className={`flex h-full shrink-0 border-kumo-line bg-kumo-base ${
        side === 'left' ? 'w-72 border-r' : 'w-80 border-l'
      }`}
    >
      {side === 'left' ? (
        <>
          {iconStrip}
          <div className="w-px shrink-0 bg-kumo-line" />
          {panelContent}
        </>
      ) : (
        <>
          {panelContent}
          <div className="w-px shrink-0 bg-kumo-line" />
          {iconStrip}
        </>
      )}
    </div>
  );
}
