// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP, type Lang, SITE } from './mock-strings';

/**
 * The models run on the landing page's own markup (`index.html`, `en/index.html`), with the
 * observers the page gets from the browser replaced by ones the test drives: a model plays when
 * the test says it is on screen, and the clock is fake, so a scene of several seconds runs in
 * no time. Each scene is checked by the state it leaves, which the reduced-motion version shows
 * at once and the animated version reaches at the end of its run.
 */

class Observer {
  static all: Observer[] = [];
  readonly targets: Element[] = [];
  constructor(readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
    Observer.all.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {}
}
class Intersection extends Observer {}
class Resize extends Observer {}

const SCENES = ['hero', 'edit', 'annotate', 'redact', 'pages', 'sign', 'ocr', 'convert'] as const;
type SceneName = (typeof SCENES)[number];

let lang: Lang = 'tr';

async function load(file: string, { reduced = false, extra = '' } = {}): Promise<void> {
  const html = readFileSync(resolve('apps/site', file), 'utf8');
  lang = file.startsWith('en/') ? 'en' : 'tr';
  document.documentElement.lang = lang;
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')) + extra;
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query.includes('reduce') }));
  vi.resetModules();
  await import('./mock');
}

const figure = (name: string): HTMLElement =>
  document.querySelector(`figure[data-mock="${name}"]`) as HTMLElement;
const $ = (name: string, selector: string): HTMLElement | null => figure(name).querySelector(selector);
const $$ = (name: string, selector: string): string[] =>
  [...figure(name).querySelectorAll(selector)].map((node) => node.textContent);
const caption = (name: string): HTMLElement => figure(name).nextElementSibling as HTMLElement;
const T = (key: keyof (typeof APP)['en']): string => APP[lang][key];
const fill = (text: string, values: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));

function show(name: string, visible: boolean): void {
  const target = figure(name);
  const observer = Observer.all.find(
    (candidate) => candidate instanceof Intersection && candidate.targets.includes(target),
  ) as Observer;
  observer.callback([{ isIntersecting: visible, target }]);
}

/** Runs the clock until the scene has finished and the model starts to fade out. */
async function untilFade(name: string): Promise<void> {
  for (let elapsed = 0; elapsed < 60_000; elapsed += 50) {
    if (figure(name).classList.contains('fade')) return;
    await vi.advanceTimersByTimeAsync(50);
  }
  throw new Error(`the ${name} scene did not finish`);
}

/** What each scene leaves on the model when it has run to the end. */
const finished: Record<SceneName, (name: SceneName) => void> = {
  hero(name) {
    expect(($(name, '.hl') as HTMLElement).style.width).toBe('220px');
    expect($(name, '.pp-pop span')?.textContent).toBe(SITE[lang].note);
    expect($$(name, '.ed-hlist li')).toEqual([T('ann.tool.highlight'), T('ann.kind.note')]);
    expect($(name, '.ed-hcount')?.textContent).toBe(fill(T('panel.history.undoable'), { count: 2 }));
    expect($(name, '.ed-dirty')?.classList.contains('on')).toBe(false);
    expect($(name, '.ed-status')?.classList.contains('glow')).toBe(true);
  },
  edit(name) {
    expect($$(name, '.pp-p')[0]).toBe(SITE[lang].p1New.join(''));
    expect($(name, '.ed-area')?.textContent).toBe(SITE[lang].p1New.join(' '));
    expect($(name, '.pp')?.classList.contains('blocks')).toBe(false);
    expect($(name, '.ed-toast')?.textContent).toBe(
      fill(T('textedit.done'), { count: SITE[lang].p1New.length }),
    );
  },
  annotate(name) {
    expect($$(name, '.ed-hlist li')).toEqual([
      T('ann.tool.highlight'),
      T('ann.tool.ink'),
      T('ann.kind.note'),
    ]);
    expect($(name, '.pp-ink path')?.style.getPropertyValue('stroke-dashoffset')).toBe('0');
    expect($(name, '.pp-pop span')?.textContent).toBe(SITE[lang].note);
  },
  redact(name) {
    const box = $(name, '.rd') as HTMLElement;
    expect([box.className, box.style.width, box.style.height]).toEqual(['rd done', '228px', '14px']);
    const fee = figure(name).querySelectorAll('.pp-p')[1]?.querySelector('.ln');
    expect(fee?.classList.contains('gone')).toBe(true);
    expect($(name, '.ed-confirm')).toBeNull();
    expect($(name, '.ed-pending')?.textContent).toBe('');
    expect($(name, '.ed-btn.danger')?.classList.contains('dis')).toBe(true);
  },
  pages(name) {
    // Page 5 was moved to the second place, so the thumbnails now read 1, 3, 4, 5, 2, 6.
    expect($$(name, '.ed-thumb em')).toEqual(['1', '3', '4', '5', '2', '6']);
    expect(figure(name).querySelectorAll('.og-cell')[2]?.classList.contains('turned')).toBe(true);
    expect(figure(name).querySelectorAll('.ed-thumb .mp')[2]?.classList.contains('turned')).toBe(true);
    expect($$(name, '.ed-hlist li')).toEqual([
      fill(T('pages.moved'), { count: 1 }),
      fill(T('pages.rotate.done'), { count: 1 }),
    ]);
    expect($(name, '.og-bar span')?.textContent).toBe(fill(T('organize.status'), { selected: 1, total: 6 }));
  },
  sign(name) {
    expect($(name, '.pp-field span')?.textContent).toBe(SITE[lang].clientValue);
    expect($(name, '.pp-sig')?.className).toBe('pp-sig placed');
    expect($(name, '.ed-dialog')).toBeNull();
    expect($(name, '.ed-toast')?.textContent).toBe(fill(T('sig.placed'), { kind: T('sig.role.signature') }));
  },
  ocr(name) {
    expect($(name, '.pp')?.className).toBe('pp scanned layer found');
    expect($(name, '.ed-find span')?.textContent).toBe(SITE[lang].search);
    const hits = $$(name, '.pp .w');
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.toLowerCase()).toBe(SITE[lang].search.toLowerCase());
    expect($(name, '.ed-toast')?.textContent).toBe(fill(T('ocr.done'), { count: 2 }));
  },
  convert(name) {
    expect($(name, '.ed-name span')?.textContent).toBe(SITE[lang].pdfFile);
    expect($(name, '.ed-drop')).toBeNull();
    expect($(name, '.ed-file')).toBeNull();
    expect($(name, '.pp-title')?.textContent).toBe(SITE[lang].proposalTitle);
    expect($(name, '.ed-toast')?.textContent).toBe(fill(T('convert.opened'), { format: 'DOCX' }));
  },
};

beforeEach(() => {
  Observer.all = [];
  vi.stubGlobal('IntersectionObserver', Intersection);
  vi.stubGlobal('ResizeObserver', Resize);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('with reduced motion', () => {
  for (const file of ['index.html', 'en/index.html']) {
    it(`shows every scene of ${file} finished at once, without a cursor or captions`, async () => {
      await load(file, { reduced: true });
      await new Promise((done) => setTimeout(done, 0));
      for (const name of SCENES) {
        expect(figure(name).classList.contains('instant')).toBe(true);
        expect(($(name, '.cur') as HTMLElement).hidden).toBe(true);
        expect(caption(name).classList.contains('on')).toBe(false);
        expect(caption(name).textContent).toBe('');
        finished[name](name);
      }
      expect(Observer.all.filter((observer) => observer instanceof Intersection)).toEqual([]);
    });
  }

  it("draws the editor's interface in the page's language", async () => {
    await load('en/index.html', { reduced: true });
    expect($('hero', '.ed-btn.pr')?.textContent).toBe(APP.en['shell.saveAs']);
    expect($$('hero', '.ed-menus span')).toEqual([
      APP.en['shell.menu.file'],
      APP.en['shell.menu.edit'],
      APP.en['shell.menu.view'],
      APP.en['shell.menu.page'],
      APP.en['shell.menu.tools'],
    ]);
  });

  it('shows the interface text as text, even where it reads like markup', async () => {
    const saveAs = 'Save <b>"as"</b> & close';
    vi.doMock('./mock-strings', () => ({
      APP: { tr: { ...APP.tr, 'shell.saveAs': saveAs }, en: APP.en },
      SITE,
    }));
    try {
      await load('index.html', { reduced: true });
    } finally {
      vi.doUnmock('./mock-strings');
    }
    expect($('hero', '.ed-btn.pr')?.textContent).toBe(saveAs);
    expect($('hero', '.ed-btn.pr b')).toBeNull();
  });

  it('measures the highlighted line when the page has laid it out', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(180);
    await load('index.html', { reduced: true });
    await new Promise((done) => setTimeout(done, 0));
    expect(($('hero', '.hl') as HTMLElement).style.width).toBe('180px');
    expect(($('annotate', '.hl') as HTMLElement).style.width).toBe('180px');
  });

  it('reports an error a scene throws instead of leaving it unhandled', async () => {
    const failure = new Error('layout failed');
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => {
      throw failure;
    });
    const reportError = vi.fn();
    vi.stubGlobal('reportError', reportError);
    await load('index.html', { reduced: true });
    await new Promise((done) => setTimeout(done, 0));
    expect(reportError.mock.calls).toEqual([[failure], [failure]]);
  });
});

describe('animated', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'requestAnimationFrame', 'performance'] });
  });

  for (const file of ['index.html', 'en/index.html']) {
    it(`plays every scene of ${file} to its end once the model is on screen`, async () => {
      await load(file);
      for (const name of SCENES) {
        expect($(name, '.ed')).toBeNull();
        show(name, true);
        expect($(name, '.ed')).not.toBeNull();
        expect($(name, '.cur')?.hidden).toBe(false);
        await untilFade(name);
        expect(figure(name).classList.contains('instant')).toBe(false);
        finished[name](name);
        show(name, false);
      }
    });
  }

  it('captions each step, with its shortcut when it has one', async () => {
    await load('index.html');
    show('hero', true);
    await vi.advanceTimersByTimeAsync(600);
    expect(caption('hero').classList.contains('on')).toBe(true);
    expect(caption('hero').textContent).toBe(`${T('toolbar.markup')}·U`);
    await untilFade('hero');
    expect(caption('hero').textContent).toBe(T('viewer.privacyNote'));
    expect(caption('hero').querySelector('kbd')).toBeNull();
  });

  it('starts the scene again after the fade, from an empty document', async () => {
    await load('index.html');
    show('hero', true);
    await untilFade('hero');
    await vi.advanceTimersByTimeAsync(500);
    expect(figure('hero').classList.contains('fade')).toBe(false);
    expect($('hero', '.pp-pop')).toBeNull();
    expect($$('hero', '.ed-hlist li')).toEqual([]);
    await untilFade('hero');
    finished.hero('hero');
  });

  it('stops while it waits once the model leaves the screen, and drops the caption', async () => {
    await load('index.html');
    show('hero', true);
    await vi.advanceTimersByTimeAsync(600);
    show('hero', false);
    expect(caption('hero').classList.contains('on')).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect($('hero', '.ed-tools .on')).toBe($('hero', '.ed-tools .ed-ib'));
    expect(figure('hero').classList.contains('fade')).toBe(false);
  });

  it('stops in the middle of a drawn stroke once the model leaves the screen', async () => {
    await load('index.html');
    show('hero', true);
    // 500 ms wait, the move to the tool and the click, the move to the line and a pause: 2390 ms,
    // then the highlight takes 900 ms.
    await vi.advanceTimersByTimeAsync(2700);
    const mark = $('hero', '.hl') as HTMLElement;
    const width = Number.parseFloat(mark.style.width);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(220);
    show('hero', false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Number.parseFloat(mark.style.width)).toBeLessThan(220);
    expect($$('hero', '.ed-hlist li')).toEqual([]);
  });

  it('keeps the last state when it leaves the screen during the fade', async () => {
    await load('index.html');
    show('hero', true);
    await untilFade('hero');
    show('hero', false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(figure('hero').classList.contains('fade')).toBe(true);
    finished.hero('hero');
  });

  it('plays from the start when it comes back on screen', async () => {
    await load('index.html');
    show('edit', true);
    await vi.advanceTimersByTimeAsync(3000);
    show('edit', false);
    show('edit', true);
    expect($('edit', '.pp')?.classList.contains('blocks')).toBe(false);
    expect(caption('edit').classList.contains('on')).toBe(false);
    await untilFade('edit');
    finished.edit('edit');
  });
});

describe('the stage', () => {
  it("scales the 800-pixel design to the model's width, and again when it is resized", async () => {
    let width = 400;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    await load('index.html', { reduced: true });
    const stage = $('hero', '.stage') as HTMLElement;
    expect(stage.style.getPropertyValue('--s')).toBe('0.5');
    width = 600;
    const resize = Observer.all.find(
      (observer) => observer instanceof Resize && observer.targets.includes(figure('hero')),
    ) as Observer;
    resize.callback([]);
    expect(stage.style.getPropertyValue('--s')).toBe('0.75');
  });

  it('leaves a figure that names no scene alone', async () => {
    await load('index.html', { reduced: true, extra: '<figure data-mock="nope"></figure><div></div>' });
    expect(figure('nope').children).toHaveLength(0);
  });
});
