/**
 * The command palette ("every operation, panel and setting is
 * searchable by name", `Ctrl+K`).
 *
 * Built on Kumo's `CommandPalette` — unlike the menu bar, a real primitive exists
 * here (its `Root` is a base-ui dialog plus a base-ui autocomplete), and it brings
 * the parts this surface would otherwise hand-roll: the modal focus trap,
 * `ArrowUp`/`ArrowDown` over the results, `Escape` to dismiss, typeahead, and the
 * result list's own `role="listbox"` wiring.
 *
 * Three decisions on top of the primitive:
 *
 *  - **This component filters; the primitive does not.** Kumo's `Panel` documents
 *    its `filter` default as "show all items — the consumer handles filtering", so
 *    the visible list and the live count come from one predicate instead of two
 *    that could disagree. Filtering here also lets the count be a real number
 *    rather than a DOM query.
 *  - **Turkish case folding.** Matching folds both sides with
 *    `toLocaleLowerCase('tr')`: the default locale mapping turns `I` into `i`, so a
 *    Turkish keyboard's `İ` would never match a command beginning with it.
 *  - **`Enter` is handled here.** The primitive's own Enter path selects the
 *    highlighted item into the input, which is a combobox behaviour, not a command
 *    palette's; running the command is what the user asked for.
 */

import { CommandPalette as KumoCommandPalette } from '@cloudflare/kumo/components/command-palette';
import { Check } from '@phosphor-icons/react';
import type { Translator } from 'pdf-shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Command, MENU_GROUP_KEYS } from './types';

export interface CommandPaletteProps {
  readonly t: Translator;
  readonly commands: readonly Command[];
  readonly open: boolean;
  readonly onClose: () => void;
  /** Runs the chosen command. The palette closes itself first. */
  readonly onRun: (command: Command) => void;
  /**
   * How many commands the simple mode is hiding from this list, when it is on.
   *
   * A filter that hides a capability without saying so is indistinguishable from a
   * missing feature. When this is above zero the empty state offers the way out,
   * so a user who searches for something the mode hides learns the mode
   * exists instead of concluding the application cannot do it.
   */
  readonly hiddenByMode?: number;
  /** Leave the simple mode. */
  readonly onUseAdvanced?: () => void;
}

const RECENT_COMMANDS_KEY = 'pdf-editor.recent-commands';

function getRecentCommandIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_COMMANDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((id) => typeof id === 'string');
    }
  } catch {
    // Storage may be blocked
  }
  return [];
}

function recordRecentCommandId(id: string): void {
  try {
    const existing = getRecentCommandIds().filter((existingId) => existingId !== id);
    const updated = [id, ...existing].slice(0, 20);
    window.localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(updated));
  } catch {
    // Storage may be blocked
  }
}

/** Fuzzy match check: characters of query appear sequentially in text. */
function fuzzyMatch(text: string, query: string): boolean {
  let queryIndex = 0;
  for (let i = 0; i < text.length && queryIndex < query.length; i++) {
    if (text[i] === query[queryIndex]) {
      queryIndex++;
    }
  }
  return queryIndex === query.length;
}

/**
 * Score a command against query and recency.
 * Returns > 0 if it matches, 0 if it doesn't.
 */
function scoreCommand(command: Command, query: string, t: Translator, recentIds: readonly string[]): number {
  const needle = query.trim().toLocaleLowerCase('tr');
  const recentIndex = recentIds.indexOf(command.id);
  const recencyBonus = recentIndex >= 0 ? Math.max(0, 25 - recentIndex * 2) : 0;

  if (needle === '') {
    // Empty query: prioritize recently used commands, then retain default list order
    return recencyBonus > 0 ? 100 + recencyBonus : 1;
  }

  const label = t(command.labelKey).toLocaleLowerCase('tr');
  const groupName = t(MENU_GROUP_KEYS[command.group]).toLocaleLowerCase('tr');
  const keywords = (command.keywords ?? []).map((k) => k.toLocaleLowerCase('tr'));

  let score = 0;

  if (label === needle) {
    score += 120;
  } else if (label.startsWith(needle)) {
    score += 90;
  } else if (label.split(/\s+/).some((word) => word.startsWith(needle))) {
    score += 70;
  } else if (label.includes(needle)) {
    score += 50;
  } else if (fuzzyMatch(label, needle)) {
    score += 30;
  }

  // Check keywords
  for (const kw of keywords) {
    if (kw === needle) score = Math.max(score, 80);
    else if (kw.startsWith(needle)) score = Math.max(score, 60);
    else if (kw.includes(needle)) score = Math.max(score, 40);
  }

  // Check group name
  if (groupName.startsWith(needle)) score = Math.max(score, 35);
  else if (groupName.includes(needle)) score = Math.max(score, 25);

  if (score > 0) {
    return score + recencyBonus;
  }
  return 0;
}

export function CommandPalette({
  t,
  commands,
  open,
  onClose,
  onRun,
  hiddenByMode,
  onUseAdvanced,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  /** The item the primitive is highlighting; Enter runs this one. */
  const [highlighted, setHighlighted] = useState<Command | undefined>(undefined);
  const [recentIds, setRecentIds] = useState<readonly string[]>(() => getRecentCommandIds());

  const results = useMemo(() => {
    const scored: { command: Command; score: number }[] = [];
    for (const command of commands) {
      const score = scoreCommand(command, query, t, recentIds);
      if (score > 0) {
        scored.push({ command, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((item) => item.command);
  }, [commands, query, t, recentIds]);

  /**
   * One command per opening. Enter reaches both the input's own handler and the
   * primitive's item activation, so a command chosen with the keyboard ran twice — the
   * second run of an operation was refused as "another operation is running" while the
   * first one opened (measured through the palette only; the menu and the header were
   * clean).
   */
  const ran = useRef(false);
  useEffect(() => {
    if (open) ran.current = false;
  }, [open]);

  const runCommand = useCallback(
    (command: Command) => {
      if (ran.current) return;
      ran.current = true;
      recordRecentCommandId(command.id);
      setRecentIds(getRecentCommandIds());
      // Close first: a command may open a dialog or replace the document, and the
      // palette must not still be on screen while that happens.
      onClose();
      onRun(command);
    },
    [onClose, onRun],
  );

  return (
    <KumoCommandPalette.Root
      open={open}
      // The palette is opened by `open` alone (no trigger), so the primitive only ever reports a dismissal.
      onOpenChange={() => onClose()}
      items={results}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={(command) => t(command.labelKey)}
      onItemHighlighted={(item) => setHighlighted(item)}
    >
      <KumoCommandPalette.Input
        // The input is focused on mount by the primitive.
        aria-label={t('palette.title')}
        placeholder={t('palette.placeholder')}
        className="text-xs"
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          // The primitive does not report a cleared highlight when the query filters
          // every item out, so the last one it named may no longer be on the list; the
          // list is matched by id because a re-render rebuilds the command objects.
          const command = results.find((item) => item.id === highlighted?.id);
          if (command === undefined || command.disabled === true) return;
          // Also stops the primitive from writing the label into the input.
          event.preventDefault();
          runCommand(command);
        }}
      />
      <KumoCommandPalette.List>
        <KumoCommandPalette.Results>
          {(command: Command) => (
            <KumoCommandPalette.Item
              key={command.id}
              value={command}
              disabled={command.disabled === true}
              // 12 px: the palette is shell chrome, and Kumo's item default is the
              // 16 px body step this product does not use in the app.
              className="text-xs"
              // A disabled item receives no click: the primitive withholds it.
              onClick={() => runCommand(command)}
            >
              {command.icon === undefined ? null : (
                <span aria-hidden="true" className="shrink-0 text-kumo-subtle">
                  {command.icon}
                </span>
              )}
              <span
                className={`min-w-0 flex-1 truncate ${
                  command.danger === true ? 'text-kumo-danger' : 'text-kumo-default'
                }`}
              >
                {t(command.labelKey)}
              </span>
              <span
                aria-hidden="true"
                className="shrink-0 rounded border border-kumo-line/60 bg-kumo-recessed px-1.5 py-0.5 text-[11px] font-medium text-kumo-subtle"
              >
                {t(MENU_GROUP_KEYS[command.group])}
              </span>
              {command.checked === true ? (
                <Check aria-hidden="true" className="size-3 shrink-0 text-kumo-strong" />
              ) : null}
              {command.shortcut === undefined ? null : (
                <span className="shrink-0 text-[11px] tabular-nums text-kumo-subtle">{command.shortcut}</span>
              )}
            </KumoCommandPalette.Item>
          )}
        </KumoCommandPalette.Results>
        <KumoCommandPalette.Empty>
          <span className="flex flex-col items-center gap-2 text-center">
            <span>{t('palette.empty')}</span>
            {hiddenByMode !== undefined && hiddenByMode > 0 ? (
              <>
                <span className="text-xs text-kumo-subtle">
                  {t('palette.modeHidden', { count: hiddenByMode })}
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    // The button leaves with the empty state, and focus with it: back to
                    // the input, where Enter and the arrows work. (Kumo's input takes no ref.)
                    const input = event.currentTarget
                      .closest('[role="dialog"]')
                      ?.querySelector<HTMLInputElement>('[role="combobox"]');
                    onUseAdvanced?.();
                    input?.focus();
                  }}
                  className="rounded-md border border-kumo-line px-2 py-1 text-xs font-medium text-kumo-strong hover:bg-kumo-recessed"
                >
                  {t('setting.mode.advanced')}
                </button>
              </>
            ) : null}
          </span>
        </KumoCommandPalette.Empty>
      </KumoCommandPalette.List>
      <KumoCommandPalette.Footer>
        {/* A live region: the count is the answer to every keystroke, and a screen
            reader should hear it without leaving the input. */}
        <span aria-live="polite">{t('palette.results', { count: results.length })}</span>
        <span>{t('palette.hint')}</span>
      </KumoCommandPalette.Footer>
    </KumoCommandPalette.Root>
  );
}
