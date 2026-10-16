// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The page's own motion, run on the real pages (`index.html` has the typing headline and the
 * scroll reveals, `gizlilik.html` neither) with a fake clock and a scroll-reveal observer the
 * test drives.
 */

class Observer {
  static last: Observer;
  readonly targets: Element[] = [];
  readonly unobserved: Element[] = [];
  constructor(readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
    Observer.last = this;
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(target: Element): void {
    this.unobserved.push(target);
  }
}

const root = document.documentElement;

async function load(file: string, { still = false } = {}): Promise<void> {
  const html = readFileSync(resolve('apps/site', file), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  delete root.dataset.mode;
  root.style.colorScheme = '';
  root.className = '';
  vi.stubGlobal('matchMedia', () => ({ matches: still }));
  vi.resetModules();
  await import('./motion');
}

function scrollTo(y: number): void {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  window.dispatchEvent(new Event('scroll'));
}

const nav = (): HTMLElement => document.querySelector('.nav') as HTMLElement;
const toggle = (): HTMLElement => document.querySelector('.theme-toggle') as HTMLElement;
const swap = (): HTMLElement => document.querySelector('.swap') as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'requestAnimationFrame'] });
  vi.stubGlobal('IntersectionObserver', Observer);
  scrollTo(0);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('marks the page as scripted, so the reveals start hidden', async () => {
  await load('gizlilik.html');
  expect(root.classList.contains('js')).toBe(true);
});

it('draws the navigation hairline once the page is scrolled, and drops it back at the top', async () => {
  await load('gizlilik.html');
  expect(nav().classList.contains('scrolled')).toBe(false);
  scrollTo(40);
  expect(nav().classList.contains('scrolled')).toBe(true);
  scrollTo(400);
  expect(nav().classList.contains('scrolled')).toBe(true);
  scrollTo(0);
  expect(nav().classList.contains('scrolled')).toBe(false);
});

it('starts with the hairline when the page opens scrolled', async () => {
  Object.defineProperty(window, 'scrollY', { value: 300, configurable: true });
  await load('gizlilik.html');
  expect(nav().classList.contains('scrolled')).toBe(true);
});

describe('the theme switch', () => {
  it("flips between dark and light and stores the choice under the editor's key", async () => {
    await load('gizlilik.html');
    toggle().click();
    expect([root.dataset.mode, root.style.colorScheme]).toEqual(['dark', 'dark']);
    expect(localStorage.getItem('pdf-editor.theme')).toBe('dark');
    toggle().click();
    expect([root.dataset.mode, root.style.colorScheme]).toEqual(['light', 'light']);
    expect(localStorage.getItem('pdf-editor.theme')).toBe('light');
  });

  it('turns the transitions off for the two frames of the switch', async () => {
    await load('gizlilik.html');
    toggle().click();
    expect(root.classList.contains('theme-switching')).toBe(true);
    await vi.advanceTimersByTimeAsync(16);
    expect(root.classList.contains('theme-switching')).toBe(true);
    await vi.advanceTimersByTimeAsync(16);
    expect(root.classList.contains('theme-switching')).toBe(false);
  });

  it('still switches the page when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    await load('gizlilik.html');
    toggle().click();
    expect(root.dataset.mode).toBe('dark');
  });
});

describe('the typing headline', () => {
  it('deletes the word and types the next one, through all of them and around again', async () => {
    await load('index.html');
    const words = (swap().dataset.words as string).split('|');
    expect(swap().classList.contains('typing')).toBe(true);
    const seen: string[] = [swap().textContent];
    for (let elapsed = 0; elapsed < 60_000 && seen.length <= words.length; elapsed += 20) {
      await vi.advanceTimersByTimeAsync(20);
      const text = swap().textContent;
      if (
        text !== seen.at(-1) &&
        words.includes(text) &&
        !words.some((w) => w !== text && w.startsWith(text))
      ) {
        seen.push(text);
      }
    }
    expect(seen).toEqual([...words, words[0]]);
  });

  it('keeps the word in the HTML with reduced motion or on a narrow screen', async () => {
    await load('index.html', { still: true });
    const word = swap().textContent;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(swap().textContent).toBe(word);
    expect(swap().classList.contains('typing')).toBe(false);
  });
});

it('reveals each section once it scrolls into view, and stops watching it', async () => {
  await load('index.html');
  const observer = Observer.last;
  const sections = [...document.querySelectorAll('.reveal')];
  expect(sections.length).toBeGreaterThan(1);
  expect(observer.targets).toEqual(sections);
  const [first, second] = sections as [Element, Element];
  observer.callback([
    { isIntersecting: false, target: first },
    { isIntersecting: true, target: second },
  ]);
  expect(first.classList.contains('in')).toBe(false);
  expect(second.classList.contains('in')).toBe(true);
  expect(observer.unobserved).toEqual([second]);
});
