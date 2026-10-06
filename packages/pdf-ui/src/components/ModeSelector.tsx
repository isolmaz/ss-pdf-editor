import { Gear, Sliders } from '@phosphor-icons/react';
import type { Translator } from 'pdf-shared';
import { useCallback, useEffect, useState } from 'react';

export type InterfaceMode = 'simple' | 'advanced';

/** The event this switch and the shell both use; `interface-mode.ts` owns the storage. */
const MODE_CHANGE_EVENT = 'pdf-mode-change';
const STORAGE_KEY = 'pdf_editor_interface_mode_v1';

function read(): InterfaceMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'advanced' ? 'advanced' : 'simple';
  } catch {
    return 'simple';
  }
}

function write(mode: InterfaceMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage may be blocked; the session keeps the choice in memory.
  }
  window.dispatchEvent(new CustomEvent<{ mode: InterfaceMode }>(MODE_CHANGE_EVENT, { detail: { mode } }));
}

export interface ModeSelectorProps {
  readonly t?: Translator;
  readonly className?: string;
}

/**
 * The simple/advanced switch, beside the theme and language selectors.
 *
 * It reads the same key and dispatches the same event as `apps/web/src/interface-mode.ts`
 * rather than importing it, for the same reason `ThemeSelector` owns its own storage: the
 * UI package must not depend on the shell, and the two sides are kept in step by the
 * event, not by a shared module. The shell is the single writer through `changeMode`; this
 * component only reflects and announces, so a mode change always passes through the one
 * place that also closes a dialog the new mode would hide.
 *
 * Two states, so it is a toggle and not a menu: a segmented pair would suggest more
 * options than exist, and a tooltip carries the difference between them.
 */
export function ModeSelector({ t, className = '' }: ModeSelectorProps) {
  const [mode, setMode] = useState<InterfaceMode>(read);

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: InterfaceMode }>).detail;
      if (detail?.mode === 'simple' || detail?.mode === 'advanced') setMode(detail.mode);
    };
    window.addEventListener(MODE_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(MODE_CHANGE_EVENT, onChange);
  }, []);

  const label = (value: InterfaceMode) =>
    value === 'advanced'
      ? (t?.('setting.mode.advanced') ?? 'Gelişmiş mod')
      : (t?.('setting.mode.simple') ?? 'Basit mod');

  const hint = (value: InterfaceMode) =>
    value === 'advanced'
      ? (t?.('setting.mode.advanced.hint') ?? 'Tüm araçlar ve ayrıntılı seçenekler')
      : (t?.('setting.mode.simple.hint') ?? 'En çok kullanılan özellikler');

  const toggle = useCallback(() => {
    setMode((current) => {
      const next: InterfaceMode = current === 'simple' ? 'advanced' : 'simple';
      write(next);
      return next;
    });
  }, []);

  const next: InterfaceMode = mode === 'simple' ? 'advanced' : 'simple';
  const Icon = mode === 'advanced' ? Sliders : Gear;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={mode === 'advanced'}
      aria-label={t?.('setting.mode.switch') ?? 'Arayüz modu'}
      title={`${label(mode)} — ${hint(mode)} · ${label(next)}`}
      className={`flex h-8 items-center gap-1.5 rounded-md border border-kumo-line px-2 text-xs font-medium text-kumo-default hover:bg-kumo-recessed hover:text-kumo-strong ${className}`}
    >
      <Icon size={14} weight={mode === 'advanced' ? 'fill' : 'regular'} aria-hidden="true" />
      <span className="hidden sm:inline">{label(mode)}</span>
    </button>
  );
}
