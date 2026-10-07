/**
 * The keyboard shortcut list, the surface the Help menu and the
 * palette open.
 *
 * Help is **not a document operation**: it answers with no tab open and in either
 * interface mode, so it is a bespoke dialog rather than an `OperationDialogSpec`
 * (there are no frozen bytes to run it against). It reuses the dialog boundary's own
 * primitives — Kumo's `Dialog`, which brings the modal focus trap, the accessible
 * name from `Dialog.Title`, `Escape` to dismiss and the focus return to the element
 * that opened it — and the same `Button` every other dialog uses.
 *
 * The rows are **not written here**. `apps/web/src/useShortcuts.ts` owns the bindings
 * and hands them over as groups of `{ id, labelKey, keys }`, so the list cannot show a
 * chord that nothing listens for and the handler cannot implement one the list hides.
 */

import { Dialog } from '@cloudflare/kumo/components/dialog';
import type { MessageKey, Translator } from 'pdf-shared';
import { MENU_GROUP_KEYS, type MenuGroup } from '../commands/types';
import { Button } from '../components/Button';

export interface ShortcutsDialogRow {
  /** The binding's id (`useShortcuts.ts`); the row's key, never shown. */
  readonly id: string;
  readonly labelKey: MessageKey;
  /** The printed chord(s), e.g. `Ctrl+Shift+S` or `Delete / Backspace`. */
  readonly keys: string;
}

export interface ShortcutsDialogGroup {
  readonly group: MenuGroup;
  readonly rows: readonly ShortcutsDialogRow[];
}

export interface ShortcutsDialogProps {
  readonly t: Translator;
  /** Mounted only while it is open, like every other dialog behind the boundary. */
  readonly open: boolean;
  /** The shell's bindings, grouped in the order they are read. */
  readonly groups: readonly ShortcutsDialogGroup[];
  readonly onClose: () => void;
}

export function ShortcutsDialog({ t, open, groups, onClose }: ShortcutsDialogProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(_open, details) => {
        // The shell owns the open state (it also owns the focus return; there is no
        // trigger), so the popup only ever asks to close: its own close is cancelled and
        // the unmount comes from the state — the same contract `CloseDocumentDialog` follows.
        details.cancel();
        onClose();
      }}
    >
      <Dialog
        size="lg"
        // The popup is fixed near the top of the viewport, so the height has to stop
        // before the viewport does and the list itself scrolls: on a laptop the list
        // is taller than the window, and a dialog whose bottom is off-screen has no
        // way to reach its own Close button.
        className="flex max-h-[calc(100dvh-4rem)] flex-col gap-3 p-4 sm:max-h-[calc(100dvh-8rem)]"
      >
        <Dialog.Title className="text-sm font-semibold text-kumo-strong">
          {t('shell.shortcuts.title')}
        </Dialog.Title>
        <Dialog.Description className="text-xs text-kumo-subtle">
          {t('shell.shortcuts.hint')}
        </Dialog.Description>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pe-1">
          {groups.map((section) => (
            <section key={section.group} className="flex flex-col gap-1.5">
              <h3 className="text-[11px] font-medium tracking-wide text-kumo-subtle uppercase">
                {t(MENU_GROUP_KEYS[section.group])}
              </h3>
              <dl className="flex flex-col gap-1">
                {section.rows.map((row) => (
                  <div key={row.id} className="flex items-baseline justify-between gap-4">
                    <dt className="min-w-0 text-xs text-kumo-default">{t(row.labelKey)}</dt>
                    <dd className="shrink-0">
                      <kbd className="rounded border border-kumo-line/60 bg-kumo-recessed px-1.5 py-0.5 font-sans text-[11px] font-medium text-kumo-subtle tabular-nums">
                        {row.keys}
                      </kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            {t('op.close')}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
