/**
 * The zoom levels a step lands on. Zoom in and out walk these stops, the way the other PDF
 * readers do, instead of adding a quarter each time (65 % to 90 % to 115 %): 100 % is always
 * one step from 90 % and 110 %, whatever fit width had left the page at.
 */
export const ZOOM_STOPS: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
];

/** The smallest and the largest zoom: the viewer's own range. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

/** A stop shown as 33 % may be held as 0.3333; within this of a stop, the zoom is on it. */
const SLACK = 0.005;

/** The stop above `current` for zoom in, below it for zoom out; the range's end when there is none. */
export function nextZoomStop(current: number, direction: 'in' | 'out'): number {
  return direction === 'in'
    ? (ZOOM_STOPS.find((stop) => stop > current + SLACK) ?? ZOOM_MAX)
    : (ZOOM_STOPS.findLast((stop) => stop < current - SLACK) ?? ZOOM_MIN);
}

/**
 * A zoom typed as a percent — `150`, `150%`, `%150`, `87,5` — as the fraction the viewer takes, in
 * whole percents; `null` when it is not a number or lies outside the viewer's 25–400 %.
 */
export function parseZoomPercent(text: string): number | null {
  const match = /^%?\s*(\d+(?:[.,]\d+)?)\s*%?$/.exec(text.trim());
  if (match === null) return null;
  const percent = Math.round(Number((match[1] as string).replace(',', '.')));
  return percent >= ZOOM_MIN * 100 && percent <= ZOOM_MAX * 100 ? percent / 100 : null;
}
