import { describe, expect, it } from 'vitest';
import { nextZoomStop, parseZoomPercent, ZOOM_MAX, ZOOM_MIN, ZOOM_STOPS } from './zoom';

describe('nextZoomStop', () => {
  it('walks the stops, not quarters: 65 % in goes to 67 %, 90 % in to 100 %, 100 % out to 90 %', () => {
    expect(nextZoomStop(0.65, 'in')).toBe(0.67);
    expect(nextZoomStop(0.9, 'in')).toBe(1);
    expect(nextZoomStop(1, 'in')).toBe(1.1);
    expect(nextZoomStop(1, 'out')).toBe(0.9);
    expect(nextZoomStop(1.15, 'out')).toBe(1.1);
    expect(nextZoomStop(0.4, 'out')).toBe(0.33);
  });

  it('steps off a zoom that is on a stop, however the stop is rounded', () => {
    expect(nextZoomStop(0.3333, 'in')).toBe(0.5);
    expect(nextZoomStop(0.3333, 'out')).toBe(0.25);
    expect(nextZoomStop(0.6667, 'in')).toBe(0.75);
  });

  it('stays at the ends of the range', () => {
    expect(nextZoomStop(4, 'in')).toBe(ZOOM_MAX);
    expect(nextZoomStop(3.8, 'in')).toBe(ZOOM_MAX);
    expect(nextZoomStop(0.25, 'out')).toBe(ZOOM_MIN);
    expect(nextZoomStop(0.27, 'out')).toBe(ZOOM_MIN);
  });

  it('has stops in ascending order inside the range', () => {
    expect(ZOOM_STOPS[0]).toBe(ZOOM_MIN);
    expect(ZOOM_STOPS.at(-1)).toBe(ZOOM_MAX);
    expect([...ZOOM_STOPS].sort((a, b) => a - b)).toEqual(ZOOM_STOPS);
  });
});

describe('parseZoomPercent', () => {
  it.each([
    ['150', 1.5],
    [' 150 ', 1.5],
    ['150%', 1.5],
    ['%150', 1.5],
    ['87,5', 0.88],
    ['87.4', 0.87],
    ['25', 0.25],
    ['400', 4],
  ])('reads %j as %d', (text, fraction) => {
    expect(parseZoomPercent(text)).toBe(fraction);
  });

  it.each(['', 'abc', '12abc', '24', '401', '-50', '1e2', '%', '1 5'])('refuses %j', (text) => {
    expect(parseZoomPercent(text)).toBeNull();
  });
});
