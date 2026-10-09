import { Dialog } from '@cloudflare/kumo/components/dialog';
import type { MessageKey, Translator } from 'pdf-shared';
import type { ReactNode } from 'react';
import { Button } from '../components/Button';
import { LanguageSelector } from '../components/LanguageSelector';
import { ThemeSelector } from '../components/ThemeSelector';

/**
 * Settings, in one place.
 *
 * Language, theme and the interface mode, the privacy switches and offline preparation
 * are gathered here, each with the sentence that says what it changes; the header keeps
 * one button.
 *
 * The interface mode is a **choice between two named options**, not a toggle labelled
 * with the current state — "Simple mode" on a button read as "switch to simple mode", and
 * nothing said that an advanced mode existed.
 */
/** The interface mode; `apps/web/src/interface-mode.ts` owns its storage and its change event. */
export type InterfaceMode = 'simple' | 'advanced';

export interface SettingsDialogProps {
  readonly t: Translator;
  readonly onClose: () => void;
  readonly mode: InterfaceMode;
  readonly onModeChange: (mode: InterfaceMode) => void;
  /** The open document's privacy state; `null` when nothing is open. */
  readonly sensitive: boolean | null;
  readonly onToggleSensitive: () => void;
  readonly onSaveDraft: () => void;
  readonly onPurgeDocument: () => void;
  readonly onSweepVault: () => void;
  readonly onPrepareOffline: () => void;
  readonly onCheckOffline: () => void;
  readonly onShowShortcuts: () => void;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold tracking-wider text-kumo-subtle uppercase">{title}</h3>
      <div className="flex flex-col divide-y divide-kumo-line rounded-md border border-kumo-line">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-medium text-kumo-default">{label}</span>
        {hint === undefined ? null : <span className="text-[11px] text-kumo-subtle">{hint}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

const MODES: readonly {
  readonly value: InterfaceMode;
  readonly label: MessageKey;
  readonly hint: MessageKey;
}[] = [
  { value: 'simple', label: 'setting.mode.simple', hint: 'setting.mode.simple.hint' },
  { value: 'advanced', label: 'setting.mode.advanced', hint: 'setting.mode.advanced.hint' },
];

export function SettingsDialog({
  t,
  onClose,
  mode,
  onModeChange,
  sensitive,
  onToggleSensitive,
  onSaveDraft,
  onPurgeDocument,
  onSweepVault,
  onPrepareOffline,
  onCheckOffline,
  onShowShortcuts,
}: SettingsDialogProps) {
  return (
    <Dialog.Root
      open
      // The shell opens the dialog (it has no trigger), so the popup only ever asks to close.
      onOpenChange={(_open, details) => {
        details.cancel();
        onClose();
      }}
    >
      <Dialog size="lg" className="pdf-floating-shadow flex max-h-[85vh] w-full flex-col gap-4 p-5">
        <div className="flex shrink-0 items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <Dialog.Title className="text-sm font-semibold text-kumo-strong">
              {t('settings.title')}
            </Dialog.Title>
            <Dialog.Description className="text-xs text-kumo-subtle">
              {t('settings.intro')}
            </Dialog.Description>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pe-1">
          <Section title={t('settings.section.appearance')}>
            <Row label={t('settings.language')}>
              <LanguageSelector t={t} />
            </Row>
            <Row label={t('settings.theme')}>
              <ThemeSelector t={t} />
            </Row>
          </Section>

          <Section title={t('settings.section.interface')}>
            <fieldset className="m-0 grid grid-cols-1 gap-2 border-0 p-3 sm:grid-cols-2">
              <legend className="sr-only">{t('setting.mode.switch')}</legend>
              {MODES.map((option) => {
                const selected = mode === option.value;
                return (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 text-xs transition-colors ${
                      selected
                        ? 'border-pdf-accent bg-pdf-accent/10 text-kumo-strong'
                        : 'border-kumo-line text-kumo-default hover:bg-kumo-tint'
                    }`}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <input
                        type="radio"
                        name="interface-mode"
                        value={option.value}
                        checked={selected}
                        onChange={() => onModeChange(option.value)}
                        className="accent-current"
                      />
                      {t(option.label)}
                    </span>
                    <span className="ps-5 text-[11px] text-kumo-subtle">{t(option.hint)}</span>
                  </label>
                );
              })}
            </fieldset>
          </Section>

          <Section title={t('settings.section.privacy')}>
            <Row label={t('settings.sensitive')} hint={t('settings.sensitive.hint')}>
              <input
                type="checkbox"
                role="switch"
                aria-checked={sensitive === true}
                aria-label={t('settings.sensitive')}
                checked={sensitive === true}
                disabled={sensitive === null}
                onChange={onToggleSensitive}
                className="size-4 accent-current"
              />
            </Row>
            <Row label={t('settings.saveDraft')} hint={t('settings.saveDraft.hint')}>
              <Button size="sm" disabled={sensitive === null || sensitive} onClick={onSaveDraft}>
                {t('settings.saveDraft.action')}
              </Button>
            </Row>
            <Row label={t('setting.purgeDocument')} hint={t('settings.purge.hint')}>
              <Button
                size="sm"
                variant="secondary-destructive"
                disabled={sensitive === null}
                onClick={onPurgeDocument}
              >
                {t('settings.purge.action')}
              </Button>
            </Row>
            <Row label={t('setting.sweepVault')} hint={t('settings.sweep.hint')}>
              <Button size="sm" onClick={onSweepVault}>
                {t('settings.sweep.action')}
              </Button>
            </Row>
          </Section>

          <Section title={t('settings.section.offline')}>
            <Row label={t('settings.offline')} hint={t('settings.offline.hint')}>
              <Button size="sm" onClick={onCheckOffline}>
                {t('settings.offline.check')}
              </Button>
              <Button size="sm" variant="primary" onClick={onPrepareOffline}>
                {t('settings.offline.prepare')}
              </Button>
            </Row>
          </Section>

          <Section title={t('settings.section.help')}>
            <Row label={t('shell.shortcuts.title')}>
              <Button size="sm" onClick={onShowShortcuts}>
                {t('settings.shortcuts.open')}
              </Button>
            </Row>
          </Section>
        </div>

        <div className="flex shrink-0 justify-end border-t border-kumo-line/40 pt-2">
          <Button variant="primary" onClick={onClose}>
            {t('op.close')}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
