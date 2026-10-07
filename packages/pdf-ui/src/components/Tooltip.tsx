import { Tooltip as BaseTooltip } from '@cloudflare/kumo/primitives/tooltip';
import type { ReactElement, ReactNode } from 'react';

/**
 * The shell's one tooltip: Kumo's tooltip primitive (base-ui), wrapped so
 * the three things the hand-rolled chips got wrong cannot come back.
 *
 * 1. **It portals.** The popup is appended to `document.body` and positioned
 *    against the viewport, so the `overflow-hidden` viewer, a scrolling tool rail
 *    or a dock panel can no longer clip it. Collisions flip and shift the chip
 *    back inside the viewport (`collisionPadding` keeps 8px of daylight).
 * 2. **It is a chip, not a title.** `bg-kumo-contrast` / `text-kumo-inverse` are
 *    the pair Kumo declares for the highest-contrast surface — near-black on
 *    light, near-white on dark, inverted text on both. The chips this replaces
 *    named a "strong" background that Kumo's theme never declares, so every tip
 *    compiled to a transparent chip with white text: invisible over paper in
 *    light mode.
 * 3. **It never takes the pointer.** `pointer-events-none` means the tip cannot
 *    interrupt the hover that opened it, so moving along a tool rail cannot
 *    flicker a tip on and off.
 *
 * Hover opens it after `delay`; keyboard focus opens it at once — base-ui asks the
 * browser for `:focus-visible`, so a pointer-driven focus stays quiet — and Escape
 * closes it through base-ui's own document listener. The caller supplies the trigger
 * element, which keeps its own classes, its `aria-pressed` and its disabled state —
 * nothing is cloned away.
 *
 * **The role is the wrapper's job.** base-ui's `<Tooltip.Popup>` renders an
 * anonymous `<div>`: the primitive declares neither `role` nor `aria-describedby`
 * for it, because its own guidelines call a tooltip a visual label for sighted users
 * and put the words on the trigger's `aria-label` — which is why every call site
 * hands the same sentence to the chip and to the button. An anonymous chip is not a
 * tooltip to `getByRole('tooltip')`, nor to assistive tech, so the role is declared
 * here, once, for every tip in the shell. The words stay on the trigger: an
 * `aria-describedby` would only make a screen reader read the sentence twice.
 */

/** Which side of its trigger the tip prefers; base-ui flips it when the viewport is in the way. */
export type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

export interface TooltipProps {
  /** The tip's copy. Wraps inside a bounded chip instead of running off the viewport. */
  readonly label: ReactNode;
  /** The trigger element — a button, a tab, a link. */
  readonly children: ReactElement<{ readonly id?: string }>;
  readonly side?: TooltipSide;
  readonly align?: 'start' | 'center' | 'end';
  /** Milliseconds of hover before the tip appears. Keyboard focus ignores it. */
  readonly delay?: number;
  readonly disabled?: boolean;
}

/** A rail is crossed in a few hundred milliseconds; the tip waits for the pointer to settle. */
const HOVER_DELAY_MS = 250;

/**
 * The chip. Bounded at 15rem so a long label wraps instead of becoming a streak
 * across the page, and opaque at the frame it mounts: the hover delay is the whole
 * motion budget, while a chip that faded in would spend its first frames half
 * transparent over the page it has to be readable against.
 */
const POPUP_CLASS = [
  'pointer-events-none z-50 max-w-[15rem] text-pretty rounded-md px-2 py-1',
  'bg-kumo-contrast text-[11px] font-medium leading-snug text-kumo-inverse shadow-md',
].join(' ');

export function Tooltip({
  label,
  children,
  side = 'top',
  align = 'center',
  delay = HOVER_DELAY_MS,
  disabled,
}: TooltipProps) {
  return (
    <BaseTooltip.Root disabled={disabled ?? false}>
      {/* The caller's `id` is a contract other elements point at (a tabpanel's
          `aria-labelledby`), so it is handed to the primitive explicitly instead
          of racing the id it would otherwise generate for the trigger. */}
      <BaseTooltip.Trigger
        id={typeof children.props.id === 'string' ? children.props.id : undefined}
        render={children}
        delay={delay}
      />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={8}
          className="z-50"
        >
          {/* `role="tooltip"` is ours to declare: base-ui's popup is an anonymous
              div, and the chip has to be findable and announceable as a tooltip. */}
          <BaseTooltip.Popup role="tooltip" className={POPUP_CLASS}>
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
