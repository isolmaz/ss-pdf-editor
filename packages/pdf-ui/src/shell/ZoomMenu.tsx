import { Popover } from '@cloudflare/kumo/primitives/popover';
import { formatPercent, parseZoomPercent, type Translator, ZOOM_STOPS } from 'pdf-shared';
import { useId, useState } from 'react';
import { Tooltip } from '../components/Tooltip';

/**
 * The zoom control of the status bar: the percentage on a button, and the menu behind it.
 *
 * The button used to be "fit width" while showing the percentage, which a reader takes for the
 * zoom level. It now opens a small panel with the standard stops, fit width, fit page and a
 * typed value, so the number on the button is the one the menu changes. The panel is a popover
 * (portalled and kept inside the viewport, so the status bar's clipping cannot hide it); Escape
 * and a press outside close it and focus returns to the button.
 */
export type ZoomRequest = number | 'page-width' | 'page-fit';

export interface ZoomMenuProps {
  readonly t: Translator;
  readonly zoom: number;
  readonly onZoomChange: (zoom: ZoomRequest) => void;
}

const ITEM_CLASS =
  'rounded-sm px-1.5 py-1 text-xs tabular-nums text-kumo-default hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-kumo-focus';
const CURRENT_CLASS = 'bg-pdf-accent text-pdf-on-accent hover:bg-pdf-accent';

export function ZoomMenu({ t, zoom, onZoomChange }: ZoomMenuProps) {
  const [open, setOpen] = useState(false);
  const zoomText = formatPercent(zoom, t.locale);
  const choose = (next: ZoomRequest) => {
    onZoomChange(next);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip label={t('nav.zoomMenu')} side="top">
        <Popover.Trigger
          aria-label={`${t('nav.zoomMenu')} (${zoomText})`}
          className="min-w-11 rounded px-1 text-xs font-semibold tabular-nums text-kumo-subtle transition-colors hover:bg-kumo-recessed hover:text-kumo-strong focus-visible:outline-2 focus-visible:outline-kumo-focus"
        >
          {zoomText}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="top" align="center" sideOffset={8} collisionPadding={8} className="z-50">
          <Popover.Popup
            aria-label={t('nav.zoomMenu')}
            className="flex w-48 flex-col gap-1.5 rounded-md border border-kumo-line bg-kumo-base p-1.5 shadow-md"
          >
            <div className="grid grid-cols-3 gap-0.5">
              {ZOOM_STOPS.map((stop) => (
                <button
                  key={stop}
                  type="button"
                  aria-current={Math.abs(stop - zoom) < 0.005 ? 'true' : undefined}
                  onClick={() => choose(stop)}
                  className={`${ITEM_CLASS} ${Math.abs(stop - zoom) < 0.005 ? CURRENT_CLASS : ''}`}
                >
                  {formatPercent(stop, t.locale)}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-0.5 border-t border-kumo-line pt-1.5">
              <button
                type="button"
                onClick={() => choose('page-width')}
                className={`${ITEM_CLASS} text-start`}
              >
                {t('viewer.fitWidth')}
              </button>
              <button type="button" onClick={() => choose('page-fit')} className={`${ITEM_CLASS} text-start`}>
                {t('viewer.fitPage')}
              </button>
            </div>
            <ZoomValue t={t} zoom={zoom} onChoose={choose} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The typed value; it starts as the current percentage each time the panel opens. */
function ZoomValue({
  t,
  zoom,
  onChoose,
}: {
  readonly t: Translator;
  readonly zoom: number;
  readonly onChoose: (zoom: number) => void;
}) {
  const [text, setText] = useState(String(Math.round(zoom * 100)));
  const [invalid, setInvalid] = useState(false);
  const invalidId = useId();
  return (
    <form
      className="flex flex-col gap-1 border-t border-kumo-line pt-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseZoomPercent(text);
        setInvalid(parsed === null);
        if (parsed !== null) onChoose(parsed);
      }}
    >
      <label className="flex items-center gap-1.5 text-xs text-kumo-subtle">
        {t('nav.zoomCustom')}
        <input
          type="text"
          inputMode="numeric"
          value={text}
          aria-invalid={invalid}
          aria-describedby={invalid ? invalidId : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(false);
          }}
          className="h-5 w-14 rounded-sm border border-kumo-line bg-kumo-base px-1 text-end text-xs tabular-nums text-kumo-strong aria-invalid:border-kumo-danger focus:border-pdf-accent focus:outline-hidden"
        />
      </label>
      {invalid ? (
        <span id={invalidId} role="alert" className="text-[11px] text-kumo-danger">
          {t('nav.zoomInvalid')}
        </span>
      ) : null}
    </form>
  );
}
