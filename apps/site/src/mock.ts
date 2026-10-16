/**
 * Animated HTML models of the editor for the landing page.
 *
 * Every `<figure data-mock="…">` becomes the same browser window with the editor open in it
 * (800 × 500 design pixels, scaled to the figure): the top bar, the page panel, the tool rail,
 * the page, the right panel and the status bar, in the light and dark look of the editor
 * (`--ed-*` tokens of `site.css`, which follow the page's theme). Each model then plays one
 * short scene and loops while it is on screen. With `prefers-reduced-motion` the scene runs in
 * one go and the finished state stays. The interface text comes from `mock-strings.ts`.
 */
import { APP, type AppKey, type Lang, SITE } from './mock-strings';

const lang: Lang = document.documentElement.lang === 'en' ? 'en' : 'tr';
const T = (key: AppKey): string => APP[lang][key];
const S = SITE[lang];
const fmt = (text: string, values: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));

const W = 800;
const H = 500;

// Geometry of the editor inside the stage, in design pixels.
const BODY_TOP = 70;
const VIEW_LEFT = 184;
const PAPER_X = 225;
const PAPER_Y = 84;
const TOOL_X = 167;
const toolY = (index: number): number => 91 + index * 32;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  html = '',
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  parent?.append(node);
  return node;
}

const esc = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

function place(node: HTMLElement, x: number, y: number, w?: number, hgt?: number): HTMLElement {
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  if (w !== undefined) node.style.width = `${w}px`;
  if (hgt !== undefined) node.style.height = `${hgt}px`;
  return node;
}

/* ---- icons (16 × 16, stroked) ------------------------------------------------------------ */

const ICON: Record<string, string> = {
  home: 'M2.5 7.5 8 3l5.5 4.5V13H10V9.5H6V13H2.5z',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.5 10.5 14 14',
  open: 'M2 4h4l1.5 1.5H14V12H2zM2 7h12',
  save: 'M3 2.5h8l2.5 2.5v8.5h-10.5zM5.5 2.5v3h5v-3M5 13.5V9h6v4.5',
  export: 'M8 2v8M5 7l3 3 3-3M3 12.5h10',
  pages: 'M4 2h6l3 3v9H4zM10 2v3h3',
  bookmark: 'M4.5 2h7v12L8 11l-3.5 3z',
  select: 'M4 2.5v10l2.8-2.6 1.8 4 1.6-.7-1.8-3.9H12z',
  hand: 'M5.5 8V4a1 1 0 0 1 2 0v3.5M7.5 7V3a1 1 0 0 1 2 0v4M9.5 7V4a1 1 0 0 1 2 0v5.5a4 4 0 0 1-4 4h-.5a4 4 0 0 1-3.2-1.6L2.5 9.5a1 1 0 0 1 1.6-1.2L5.5 10',
  text: 'M3 3.5h10M8 3.5V13M6 13h4',
  freetext: 'M2 13 5 4l3 9M3 10h4M10 9.5a1.8 1.8 0 1 1 0 3.5 1.8 1.8 0 0 1 0-3.5zM12 9v4',
  markup: 'M9.5 2.5 13.5 6.5 8 12H4V8zM3 14h10',
  ink: 'M10.5 2.5l3 3L7 12H4V9zM9 4l3 3',
  shapes: 'M2.5 9.5h5v4h-5zM11 2.5l3 5H8z',
  note: 'M2.5 3h11v8H7l-3 2.5V11H2.5z',
  link: 'M6.5 9.5l3-3M5 8 3.8 9.2a2.2 2.2 0 0 0 3 3L8 11M8 5l1.2-1.2a2.2 2.2 0 0 1 3 3L11 8',
  measure: 'M2 10 10 2l4 4-8 8zM5 7l1.5 1.5M7 5l1.5 1.5M9 3l1.5 1.5',
  redact: 'M2 8s2.2-4.5 6-4.5S14 8 14 8s-2.2 4.5-6 4.5S2 8 2 8zM3 13 13 3',
  close: 'M4 4l8 8M12 4l-8 8',
  chevron: 'M4 6l4 4 4-4',
  back: 'M10 4 6 8l4 4',
  rotate: 'M12.5 8A4.5 4.5 0 1 1 11 4.6M11 2v3h3',
  cloud: 'M5 12.5h6.5a3 3 0 0 0 .3-6A4 4 0 0 0 4 7.2a2.7 2.7 0 0 0 1 5.3zM8 10.5v-4M6.5 8 8 6.5 9.5 8',
  check: 'M3.5 8.5l3 3 6-7',
  lock: 'M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2',
};

const icon = (name: string, size = 16): string =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true"><path d="${ICON[name] ?? ''}"/></svg>`;

/* ---- the editor ---------------------------------------------------------------------------- */

const TOOLS = [
  'select',
  'hand',
  'text',
  'freetext',
  'markup',
  'ink',
  'shapes',
  'note',
  'link',
  'measure',
  'redact',
];

interface Editor {
  root: HTMLElement;
  file: HTMLElement;
  dirty: HTMLElement;
  saveAs: HTMLElement;
  pages: HTMLElement;
  thumbs: HTMLElement[];
  tools: Record<string, HTMLElement>;
  view: HTMLElement;
  panel: HTMLElement;
  status: HTMLElement;
  hint: HTMLElement;
  toast: HTMLElement;
}

function editor(stage: HTMLElement, fileName: string, thumbCount = 3): Editor {
  const browser = h('div', 'brw', '', stage);
  h(
    'div',
    'brw-bar',
    `<i></i><i></i><i></i><span class="brw-addr">${icon('lock', 11)}pdf.isolmaz.com/editor/</span>`,
    browser,
  );
  const root = h('div', 'ed', '', browser);

  const top = h('div', 'ed-top', '', root);
  h('span', 'ed-logo', 'PDF', top);
  h('span', 'ed-ib', icon('home'), top);
  const menus = h('nav', 'ed-menus', '', top);
  for (const key of [
    'shell.menu.file',
    'shell.menu.edit',
    'shell.menu.view',
    'shell.menu.page',
    'shell.menu.tools',
  ] as const) {
    h('span', '', esc(T(key)), menus);
  }
  const name = h('span', 'ed-name', '', top);
  const file = h('span', '', esc(fileName), name);
  const dirty = h('i', 'ed-dirty', '', name);
  name.insertAdjacentHTML('beforeend', icon('chevron', 12));
  const actions = h('div', 'ed-actions', '', top);
  h('span', 'ed-ib', icon('search'), actions);
  h('span', 'ed-btn', `${icon('open', 13)}${esc(T('shell.open'))}`, actions);
  const saveAs = h('span', 'ed-btn pr', `${icon('save', 13)}${esc(T('shell.saveAs'))}`, actions);
  h('span', 'ed-btn', `${icon('export', 13)}${esc(T('shell.export'))}`, actions);

  const rail = h('div', 'ed-rail', '', root);
  h('span', 'ed-ib on', icon('pages'), rail);
  h('span', 'ed-ib', icon('bookmark'), rail);
  h('span', 'ed-ib', icon('search'), rail);

  const pages = h('div', 'ed-pages', `<b>${esc(T('panel.pages'))}</b>`, root);
  const thumbs: HTMLElement[] = [];
  for (let i = 0; i < thumbCount; i++) {
    const thumb = h('div', `ed-thumb${i === 0 ? ' on' : ''}`, `${miniPage(i)}<em>${i + 1}</em>`, pages);
    thumb.style.transform = `translateY(${i * 124}px)`;
    thumbs.push(thumb);
  }

  const toolRail = h('div', 'ed-tools', '', root);
  const tools: Record<string, HTMLElement> = {};
  TOOLS.forEach((tool, index) => {
    tools[tool] = place(
      h('span', `ed-ib${tool === 'select' ? ' on' : ''}`, icon(tool), toolRail),
      4,
      8 + index * 32,
    );
  });

  const view = h('div', 'ed-view', '', root);
  const panel = h('div', 'ed-panel', '', root);
  const status = h(
    'div',
    'ed-status',
    `<span>‹ <b>1</b> / ${thumbCount} ›</span><span>− 100% +</span><span class="ed-pill">${esc(
      T('shell.deviceTier.desktop'),
    )}</span><span class="ed-privacy">${esc(T('viewer.privacyNote'))}</span>`,
    root,
  );
  const hint = h('div', 'ed-hint', '', view);
  const toast = h('div', 'ed-toast', '', view);
  return { root, file, dirty, saveAs, pages, thumbs, tools, view, panel, status, hint, toast };
}

/** A thumbnail's page: the band, a title and lines, a little different per page. */
function miniPage(index: number): string {
  const lines = [
    [70, 58, 64, 40, 0, 66, 52],
    [60, 66, 50, 0, 62, 58, 30],
    [48, 0, 64, 60, 44, 0, 36],
    [66, 54, 0, 60, 64, 48, 20],
    [52, 64, 58, 0, 40, 62, 50],
    [64, 40, 0, 58, 66, 0, 46],
  ][index % 6] as number[];
  return `<span class="mp"><i class="mp-band"></i><i class="mp-title" style="width:${30 + ((index * 7) % 16)}px"></i>${lines
    .map((w) => (w ? `<i style="width:${w}%"></i>` : '<i class="gap"></i>'))
    .join('')}</span>`;
}

function selectTool(ed: Editor, tool: string): void {
  for (const [name, node] of Object.entries(ed.tools)) node.classList.toggle('on', name === tool);
}

function panelHead(ed: Editor, title: string, intro: string): void {
  ed.panel.innerHTML = `<b class="ed-ph">${esc(T('mode.tools'))}</b><span class="ed-back">${icon('back', 12)}${esc(
    T('mode.tools'),
  )}</span><h4>${esc(title)}</h4><p>${esc(intro)}</p>`;
}

function history(ed: Editor): (label: string) => void {
  ed.panel.innerHTML = `<b class="ed-ph">${esc(T('panel.history'))}</b><div class="ed-hbtns"><span class="ed-btn">${esc(
    T('op.undo'),
  )}</span><span class="ed-btn dis">${esc(T('op.redo'))}</span></div>`;
  const count = h('p', 'ed-hcount', '', ed.panel);
  const list = h('ol', 'ed-hlist', '', ed.panel);
  let steps = 0;
  const update = (): void => {
    count.textContent = fmt(T('panel.history.undoable'), { count: steps });
  };
  update();
  return (label) => {
    steps++;
    h('li', '', esc(label), list);
    update();
  };
}

/* ---- the sample page ------------------------------------------------------------------------ */

interface Paper {
  el: HTMLElement;
  p1: HTMLElement;
  p2: HTMLElement;
  field: HTMLElement;
  fieldText: HTMLElement;
}

const lines = (texts: readonly string[], mark?: string): string =>
  texts
    .map((line) => {
      const html = esc(line);
      return `<span class="ln">${
        mark ? html.replace(new RegExp(`(${mark})`, 'giu'), '<span class="w">$1</span>') : html
      }</span>`;
    })
    .join('');

function paper(view: HTMLElement, mark?: string): Paper {
  const el = place(h('div', 'pp', '', view), PAPER_X - VIEW_LEFT, PAPER_Y - BODY_TOP, 330, 467);
  h('div', 'pp-band', `<span>${S.studio}</span><span>${esc(S.pageOf)}</span>`, el);
  place(h('div', 'pp-title', esc(S.title), el), 24, 44);
  place(h('div', 'pp-meta', esc(S.meta), el), 24, 72);
  place(h('div', 'pp-h', esc(S.h1), el), 24, 94);
  const p1 = place(h('div', 'pp-p', lines(S.p1), el), 24, 110, 290);
  place(h('div', 'pp-h', esc(S.h2), el), 24, 160);
  const p2 = place(h('div', 'pp-p', lines(S.p2, mark), el), 24, 176, 290);
  place(h('div', 'pp-h', esc(S.h3), el), 24, 210);
  place(h('div', 'pp-label', esc(S.client), el), 24, 228);
  const field = place(h('div', 'pp-field', '', el), 24, 240, 160, 18);
  const fieldText = h('span', '', '', field);
  place(h('div', 'pp-line', '', el), 24, 300, 160);
  place(h('div', 'pp-label', esc(S.signLine), el), 24, 305);
  return { el, p1, p2, field, fieldText };
}

/* ---- playing a scene ------------------------------------------------------------------------ */

class Cancelled extends Error {}

interface Ctx {
  readonly instant: boolean;
  wait(ms: number): Promise<void>;
  move(x: number, y: number, ms?: number): Promise<void>;
  at(x: number, y: number): void;
  click(): Promise<void>;
  ibeam(on: boolean): void;
  tween(ms: number, step: (t: number) => void): Promise<void>;
  type(text: string, set: (value: string) => void, perChar?: number): Promise<void>;
  cap(text: string, key?: string): void;
  toast(ed: Editor, text: string): void;
}

type Scene = (stage: HTMLElement, ctx: Ctx) => Promise<void>;

const ease = (t: number): number => 1 - (1 - t) ** 3;

function context(figure: HTMLElement, stage: HTMLElement, instant: boolean, alive: () => boolean): Ctx {
  const caption = figure.nextElementSibling?.classList.contains('mock-cap')
    ? (figure.nextElementSibling as HTMLElement)
    : null;
  const cursor = h(
    'div',
    'cur',
    '<svg class="arr" width="18" height="24" viewBox="0 0 18 24"><path d="M1 1v18l4.6-4.3 3.2 7.3 3-1.3-3.2-7.1H15z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg><svg class="ibm" width="10" height="20" viewBox="0 0 10 20"><path d="M2 1.5h6M2 18.5h6M5 1.5v17" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    stage,
  );
  let x = W - 40;
  let y = H - 30;
  const set = (ms: number): void => {
    cursor.style.transitionDuration = `${ms}ms`;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  };
  set(0);
  if (instant) cursor.hidden = true;
  caption?.classList.remove('on');
  const check = (): void => {
    if (!alive()) throw new Cancelled();
  };
  const wait = (ms: number): Promise<void> => {
    check();
    if (instant) return Promise.resolve();
    return new Promise((resolve, reject) =>
      setTimeout(() => (alive() ? resolve() : reject(new Cancelled())), ms),
    );
  };
  return {
    instant,
    wait,
    async move(nx, ny, ms = 700) {
      x = nx;
      y = ny;
      set(instant ? 0 : ms);
      await wait(ms);
    },
    at(nx, ny) {
      x = nx;
      y = ny;
      set(0);
    },
    async click() {
      cursor.classList.add('down');
      await wait(140);
      cursor.classList.remove('down');
    },
    ibeam(on) {
      cursor.classList.toggle('beam', on);
    },
    async tween(ms, step) {
      check();
      if (instant) {
        step(1);
        return;
      }
      const start = performance.now();
      await new Promise<void>((resolve, reject) => {
        const frame = (now: number): void => {
          if (!alive()) {
            reject(new Cancelled());
            return;
          }
          const t = Math.min(1, (now - start) / ms);
          step(t);
          if (t < 1) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
    },
    async type(text, setValue, perChar = 45) {
      if (instant) {
        setValue(text);
        return;
      }
      for (let i = 1; i <= text.length; i++) {
        setValue(text.slice(0, i));
        await wait(perChar);
      }
    },
    cap(text, key) {
      if (!caption || instant) return;
      caption.innerHTML = `<span>${esc(text)}</span>${key ? `<span class="dot">·</span><kbd>${esc(key)}</kbd>` : ''}`;
      caption.classList.add('on');
    },
    toast(ed, text) {
      ed.toast.innerHTML = `<span>${esc(text)}</span>${icon('close', 11)}`;
      ed.toast.classList.add('in');
    },
  };
}

/* ---- the scenes ----------------------------------------------------------------------------- */

const SCENES: Record<string, Scene> = {
  // The hero: a line is highlighted, a note is left in the margin and the document is saved.
  async hero(stage, ctx) {
    const ed = editor(stage, S.file);
    const page = paper(ed.view);
    const log = history(ed);
    await ctx.wait(500);
    ctx.cap(T('toolbar.markup'), 'U');
    await ctx.move(TOOL_X, toolY(4), 900);
    await ctx.click();
    selectTool(ed, 'markup');
    ed.hint.textContent = T('tool.hint.highlight');
    ed.hint.classList.add('in');
    const line = page.p1.children[1] as HTMLElement;
    const mark = place(h('i', 'hl', '', line), 0, 0, 0, 12);
    ctx.ibeam(true);
    await ctx.move(PAPER_X + 24, PAPER_Y + 126, 700);
    await ctx.wait(150);
    const width = line.offsetWidth || 220;
    await ctx.tween(900, (t) => {
      mark.style.width = `${width * ease(t)}px`;
      ctx.at(PAPER_X + 24 + width * ease(t), PAPER_Y + 126);
    });
    ctx.ibeam(false);
    ed.dirty.classList.add('on');
    log(T('ann.tool.highlight'));
    await ctx.wait(500);
    ctx.cap(T('toolbar.comment'), 'N');
    await ctx.move(TOOL_X, toolY(7), 800);
    await ctx.click();
    selectTool(ed, 'note');
    ed.hint.textContent = T('tool.hint.note');
    await ctx.move(PAPER_X + 300, PAPER_Y + 112, 800);
    await ctx.click();
    place(h('i', 'pp-note', icon('note', 12), page.el), 293, 104);
    const pop = place(h('div', 'pp-pop', `<b>${esc(S.who)}</b>`, page.el), 168, 124, 150);
    const body = h('span', '', '', pop);
    await ctx.type(S.note, (value) => {
      body.textContent = value;
    });
    log(T('ann.kind.note'));
    ed.hint.classList.remove('in');
    await ctx.wait(700);
    ctx.cap(T('shell.saveAs'), 'Ctrl+S');
    await ctx.move(623, 50, 900);
    await ctx.click();
    ed.saveAs.classList.add('down');
    await ctx.wait(220);
    ed.saveAs.classList.remove('down');
    ed.dirty.classList.remove('on');
    ed.status.classList.add('glow');
    ctx.cap(T('viewer.privacyNote'));
    await ctx.move(700, 440, 900);
    await ctx.wait(2200);
  },

  // Text is edited in place: the paragraph is picked, rewritten in the panel and applied.
  async edit(stage, ctx) {
    const ed = editor(stage, S.file);
    const page = paper(ed.view);
    panelHead(ed, T('textedit.title'), T('textedit.intro'));
    const field = h('label', 'ed-field', `<span>${esc(T('textedit.field.text'))}</span>`, ed.panel);
    const area = h('div', 'ed-area', '', field);
    h(
      'div',
      'ed-row',
      `<label class="ed-field"><span>${esc(T('textedit.field.align'))}</span><span class="ed-sel">${esc(
        T('textedit.align.left'),
      )}${icon('chevron', 10)}</span></label><label class="ed-field"><span>${esc(
        T('textedit.field.fontSize'),
      )}</span><span class="ed-in">8</span></label>`,
      ed.panel,
    );
    const buttons = h(
      'div',
      'ed-foot',
      `<span class="ed-btn">${esc(T('op.cancel'))}</span><span class="ed-btn pr">${esc(T('op.apply'))}</span>`,
      ed.panel,
    );
    await ctx.wait(400);
    ctx.cap(T('toolbar.text'), 'E');
    await ctx.move(TOOL_X, toolY(2), 900);
    await ctx.click();
    selectTool(ed, 'text');
    ed.hint.textContent = T('tool.hint.text');
    ed.hint.classList.add('in');
    page.el.classList.add('blocks');
    await ctx.move(PAPER_X + 150, PAPER_Y + 124, 900);
    await ctx.click();
    page.p1.classList.add('picked');
    ed.hint.classList.remove('in');
    area.textContent = S.p1.join(' ');
    await ctx.wait(500);
    await ctx.move(700, 210, 800);
    await ctx.click();
    area.classList.add('focus', 'sel');
    await ctx.wait(400);
    area.classList.remove('sel');
    await ctx.type(
      S.p1New.join(' '),
      (value) => {
        area.textContent = value;
      },
      22,
    );
    await ctx.wait(400);
    const apply = buttons.lastElementChild as HTMLElement;
    ctx.cap(T('op.apply'));
    await ctx.move(762, 448, 800);
    await ctx.click();
    apply.classList.add('down');
    page.p1.classList.add('swap');
    await ctx.wait(260);
    page.p1.innerHTML = lines(S.p1New);
    page.p1.classList.remove('swap', 'picked');
    page.el.classList.remove('blocks');
    apply.classList.remove('down');
    area.classList.remove('focus');
    ed.dirty.classList.add('on');
    ctx.toast(ed, fmt(T('textedit.done'), { count: S.p1New.length }));
    await ctx.move(700, 400, 900);
    await ctx.wait(2400);
  },

  // A highlight, a freehand stroke and a note, each one a step in the history.
  async annotate(stage, ctx) {
    const ed = editor(stage, S.file);
    const page = paper(ed.view);
    const log = history(ed);
    await ctx.wait(400);
    ctx.cap(T('toolbar.markup'), 'U');
    await ctx.move(TOOL_X, toolY(4), 900);
    await ctx.click();
    selectTool(ed, 'markup');
    const line = page.p2.children[0] as HTMLElement;
    const mark = place(h('i', 'hl', '', line), 0, 0, 0, 12);
    ctx.ibeam(true);
    await ctx.move(PAPER_X + 24, PAPER_Y + 182, 700);
    const width = line.offsetWidth || 220;
    await ctx.tween(800, (t) => {
      mark.style.width = `${width * ease(t)}px`;
      ctx.at(PAPER_X + 24 + width * ease(t), PAPER_Y + 182);
    });
    ctx.ibeam(false);
    log(T('ann.tool.highlight'));
    await ctx.wait(400);
    ctx.cap(T('ann.tool.ink'), 'D');
    await ctx.move(TOOL_X, toolY(5), 800);
    await ctx.click();
    selectTool(ed, 'ink');
    const svg = h(
      'div',
      'pp-ink',
      '<svg width="200" height="20" viewBox="0 0 200 20"><path pathLength="1" d="M4 10c14-8 22 8 36 0s22 8 36 0 22 8 36 0 22 8 36 0 22 8 40 0"/></svg>',
      page.el,
    );
    place(svg, 22, 141);
    const path = svg.querySelector('path');
    await ctx.move(PAPER_X + 26, PAPER_Y + 151, 700);
    await ctx.tween(1300, (t) => {
      path?.style.setProperty('stroke-dashoffset', String(1 - t));
      ctx.at(PAPER_X + 26 + 196 * t, PAPER_Y + 151 + Math.sin(t * Math.PI * 10) * 3);
    });
    log(T('ann.tool.ink'));
    await ctx.wait(400);
    ctx.cap(T('toolbar.comment'), 'N');
    await ctx.move(TOOL_X, toolY(7), 800);
    await ctx.click();
    selectTool(ed, 'note');
    await ctx.move(PAPER_X + 300, PAPER_Y + 168, 800);
    await ctx.click();
    place(h('i', 'pp-note', icon('note', 12), page.el), 293, 160);
    const pop = place(h('div', 'pp-pop', `<b>${esc(S.who)}</b>`, page.el), 168, 180, 150);
    const body = h('span', '', '', pop);
    await ctx.type(S.note, (value) => {
      body.textContent = value;
    });
    log(T('ann.kind.note'));
    ed.dirty.classList.add('on');
    await ctx.move(700, 420, 900);
    await ctx.wait(2400);
  },

  // A box is drawn over the fee, applied after the confirmation, and the text under it is gone.
  async redact(stage, ctx) {
    const ed = editor(stage, S.file);
    const page = paper(ed.view);
    panelHead(ed, T('redact.title'), T('redact.intro'));
    h(
      'div',
      'ed-radios',
      `<b>${esc(T('redact.imageMethod'))}</b>${(
        ['redact.imageMethod.none', 'redact.imageMethod.remove', 'redact.imageMethod.pixels'] as const
      )
        .map((key, i) => `<span><i class="${i === 0 ? 'dot-on' : ''}"></i>${esc(T(key))}</span>`)
        .join('')}`,
      ed.panel,
    );
    const pending = h('p', 'ed-pending', '', ed.panel);
    const foot = h('div', 'ed-foot', '', ed.panel);
    const apply = h('span', 'ed-btn danger dis', esc(T('tool.redact.apply')), foot);
    await ctx.wait(400);
    ctx.cap(T('toolbar.redact'), 'X');
    await ctx.move(TOOL_X, toolY(10), 900);
    await ctx.click();
    selectTool(ed, 'redact');
    ed.hint.textContent = T('tool.hint.redact');
    ed.hint.classList.add('in');
    const box = place(h('i', 'rd', '', page.el), 21, 174, 0, 0);
    await ctx.move(PAPER_X + 21, PAPER_Y + 174, 800);
    await ctx.tween(900, (t) => {
      const e = ease(t);
      box.style.width = `${228 * e}px`;
      box.style.height = `${14 * e}px`;
      ctx.at(PAPER_X + 21 + 228 * e, PAPER_Y + 174 + 14 * e);
    });
    pending.textContent = fmt(T('tool.redact.pending'), { count: 1 });
    apply.classList.remove('dis');
    await ctx.wait(500);
    ctx.cap(T('tool.redact.apply'));
    await ctx.move(740, 448, 900);
    await ctx.click();
    const confirm = h(
      'div',
      'ed-confirm',
      `<p>${esc(T('op.result.confirmDestructive'))}</p><div><span class="ed-btn">${esc(
        T('op.cancel'),
      )}</span><span class="ed-btn danger">${esc(T('dialog.confirm.continue'))}</span></div>`,
      ed.panel,
    );
    await ctx.wait(700);
    await ctx.move(758, 404, 700);
    await ctx.click();
    confirm.remove();
    ed.hint.classList.remove('in');
    box.classList.add('done');
    (page.p2.children[0] as HTMLElement).classList.add('gone');
    pending.textContent = '';
    apply.classList.add('dis');
    ed.dirty.classList.add('on');
    await ctx.move(700, 330, 900);
    await ctx.wait(2400);
  },

  // The page panel: a page is dragged to another place and one is turned.
  async pages(stage, ctx) {
    const ed = editor(stage, S.file, 6);
    const log = history(ed);
    const grid = h('div', 'og', '', ed.view);
    const bar = h('div', 'og-bar', '', ed.view);
    const statusText = h('span', '', '', bar);
    h('span', 'ed-btn', esc(T('organize.close')), bar);
    const order = [0, 1, 2, 3, 4, 5];
    const cells = order.map((page) => h('div', 'og-cell', `${miniPage(page)}<em>${page + 1}</em>`, grid));
    const cellAt = (slot: number): [number, number] => [
      40 + (slot % 3) * 120,
      44 + Math.floor(slot / 3) * 156,
    ];
    const layout = (): void => {
      order.forEach((page, slot) => {
        const [x, y] = cellAt(slot);
        const cell = cells[page] as HTMLElement;
        cell.style.transform = `translate(${x}px, ${y}px)`;
        const thumb = ed.thumbs[page] as HTMLElement;
        thumb.style.transform = `translateY(${slot * 124}px)`;
        const label = thumb.querySelector('em');
        if (label) label.textContent = String(slot + 1);
      });
    };
    const status = (selected: number): void => {
      statusText.textContent = fmt(T('organize.status'), { selected, total: 6 });
    };
    layout();
    status(0);
    await ctx.wait(500);
    const fifth = cells[4] as HTMLElement;
    const [fx, fy] = cellAt(4);
    ctx.cap(T('panel.pages'));
    await ctx.move(VIEW_LEFT + fx + 46, BODY_TOP + fy + 60, 900);
    await ctx.click();
    fifth.classList.add('on', 'lift');
    status(1);
    await ctx.wait(300);
    const [tx, ty] = cellAt(1);
    await ctx.tween(1000, (t) => {
      const e = ease(t);
      const x = fx + (tx - 30 - fx) * e;
      const y = fy + (ty - fy) * e;
      fifth.style.transform = `translate(${x}px, ${y}px) rotate(-2deg)`;
      ctx.at(VIEW_LEFT + x + 46, BODY_TOP + y + 60);
    });
    order.splice(4, 1);
    order.splice(1, 0, 4);
    fifth.classList.remove('lift');
    layout();
    ctx.toast(ed, fmt(T('pages.moved'), { count: 1 }));
    log(fmt(T('pages.moved'), { count: 1 }));
    await ctx.wait(1200);
    const third = cells[2] as HTMLElement;
    const [rx, ry] = cellAt(order.indexOf(2));
    third.classList.add('hover');
    await ctx.move(VIEW_LEFT + rx + 77, BODY_TOP + ry + 15, 900);
    ctx.cap(T('pages.rotate.right'));
    await ctx.click();
    third.classList.add('turned');
    ctx.toast(ed, fmt(T('pages.rotate.done'), { count: 1 }));
    log(fmt(T('pages.rotate.done'), { count: 1 }));
    const thumb = ed.thumbs[2]?.querySelector('.mp') as HTMLElement | null;
    thumb?.classList.add('turned');
    await ctx.wait(400);
    third.classList.remove('hover');
    await ctx.move(560, 430, 900);
    await ctx.wait(2400);
  },

  // A form field is filled, a signature is drawn and placed on the line.
  async sign(stage, ctx) {
    const ed = editor(stage, S.file);
    const page = paper(ed.view);
    const log = history(ed);
    await ctx.wait(400);
    await ctx.move(PAPER_X + 90, PAPER_Y + 249, 900);
    await ctx.click();
    page.field.classList.add('focus');
    await ctx.type(S.clientValue, (value) => {
      page.fieldText.textContent = value;
    });
    page.field.classList.remove('focus');
    ed.dirty.classList.add('on');
    await ctx.wait(400);
    ctx.cap(T('sig.dialog.title'));
    const dialog = h(
      'div',
      'ed-dialog',
      `<b>${esc(T('sig.dialog.title'))}</b><div class="ed-tabs"><span class="on">${esc(
        T('sig.tab.draw'),
      )}</span><span>${esc(T('sig.tab.type'))}</span><span>${esc(
        T('sig.tab.upload'),
      )}</span></div><div class="ed-pad"><svg width="260" height="70" viewBox="0 0 260 70"><path pathLength="1" d="M20 48c10-30 18-34 20-20s-6 26 2 18 12-30 18-18-2 22 6 16 10-18 16-10 4 12 12 6 16-14 24-10 6 10 16 4 24-6 40-8"/></svg></div><p>${esc(
        T('sig.draw.hint'),
      )}</p><div class="ed-foot"><span class="ed-btn">${esc(T('sig.cancel'))}</span><span class="ed-btn pr">${esc(
        T('sig.place'),
      )}</span></div>`,
      ed.view,
    );
    const stroke = dialog.querySelector('.ed-pad path') as SVGPathElement | null;
    await ctx.wait(500);
    await ctx.move(VIEW_LEFT + 96, BODY_TOP + 160, 800);
    await ctx.tween(1600, (t) => {
      stroke?.style.setProperty('stroke-dashoffset', String(1 - t));
      ctx.at(VIEW_LEFT + 96 + 220 * t, BODY_TOP + 150 + Math.sin(t * Math.PI * 7) * 12);
    });
    await ctx.wait(300);
    await ctx.move(VIEW_LEFT + 330, BODY_TOP + 246, 800);
    await ctx.click();
    dialog.remove();
    ed.hint.textContent = T('sig.placing');
    ed.hint.classList.add('in');
    const sig = h(
      'div',
      'pp-sig',
      '<svg width="130" height="35" viewBox="0 0 260 70"><path d="M20 48c10-30 18-34 20-20s-6 26 2 18 12-30 18-18-2 22 6 16 10-18 16-10 4 12 12 6 16-14 24-10 6 10 16 4 24-6 40-8"/></svg>',
      page.el,
    );
    sig.classList.add('ghost');
    place(sig, 140, 200);
    await ctx.tween(1000, (t) => {
      const e = ease(t);
      place(sig, 140 - 110 * e, 200 + 68 * e);
      ctx.at(PAPER_X + 205 - 110 * e, PAPER_Y + 226 + 68 * e);
    });
    await ctx.click();
    sig.classList.remove('ghost');
    sig.classList.add('placed');
    ed.hint.classList.remove('in');
    log(T('sig.role.signature'));
    ctx.toast(ed, fmt(T('sig.placed'), { kind: T('sig.role.signature') }));
    await ctx.move(560, 420, 900);
    await ctx.wait(2400);
  },

  // A scanned page gets a text layer and can then be searched.
  async ocr(stage, ctx) {
    const ed = editor(stage, S.scanFile, 2);
    ed.root.classList.add('scan');
    const page = paper(ed.view, S.search);
    page.el.classList.add('scanned');
    panelHead(ed, T('ocr.title'), T('ocr.intro'));
    h(
      'div',
      'ed-chips',
      `<b>${esc(T('ocr.languages'))}</b><span class="on">${icon('check', 10)}${esc(
        T('ocr.language.tr'),
      )}</span><span class="on">${icon('check', 10)}${esc(T('ocr.language.en'))}</span><span>${esc(
        T('ocr.language.deu'),
      )}</span>`,
      ed.panel,
    );
    const progress = h('div', 'ed-progress', '<span></span><i><b></b></i>', ed.panel);
    const progressText = progress.firstElementChild as HTMLElement;
    const progressBar = progress.querySelector('b') as HTMLElement;
    const foot = h('div', 'ed-foot', '', ed.panel);
    const apply = h('span', 'ed-btn pr', esc(T('op.apply')), foot);
    await ctx.wait(500);
    ctx.cap(T('ocr.title'));
    await ctx.move(770, 448, 1000);
    await ctx.click();
    apply.classList.add('dis');
    progress.classList.add('in');
    for (const pageNumber of [1, 2]) {
      progressText.textContent = fmt(T('ocr.running'), { page: pageNumber, total: 2 });
      await ctx.tween(1100, (t) => {
        progressBar.style.transform = `scaleX(${(pageNumber - 1 + t) / 2})`;
      });
    }
    progress.classList.remove('in');
    apply.classList.remove('dis');
    page.el.classList.add('layer');
    ed.dirty.classList.add('on');
    ctx.toast(ed, fmt(T('ocr.done'), { count: 2 }));
    await ctx.wait(1000);
    ctx.cap(T('shell.search'), 'Ctrl+F');
    const find = h('div', 'ed-find', `${icon('search', 12)}<span></span>`, ed.view);
    const findText = find.lastElementChild as HTMLElement;
    await ctx.move(VIEW_LEFT + 200, BODY_TOP + 20, 800);
    await ctx.click();
    find.classList.add('in');
    await ctx.type(
      S.search,
      (value) => {
        findText.textContent = value;
      },
      90,
    );
    page.el.classList.add('found');
    await ctx.move(560, 430, 900);
    await ctx.wait(2600);
  },

  // A Word file is dropped on the home screen and opens as a PDF.
  async convert(stage, ctx) {
    const ed = editor(stage, '', 1);
    ed.root.classList.add('home');
    ed.file.parentElement?.classList.add('off');
    const zone = h(
      'div',
      'ed-drop',
      `${icon('cloud', 22)}<b>${esc(T('home.drop.title'))}</b><span>${esc(T('home.drop.desc'))}</span>`,
      ed.view,
    );
    const card = place(h('div', 'ed-file', `<i>W</i><span>${esc(S.docxFile)}</span>`, stage), 560, 330);
    await ctx.wait(500);
    ctx.cap(T('home.drop.title'));
    await ctx.move(600, 350, 800);
    await ctx.click();
    await ctx.tween(1200, (t) => {
      const e = ease(t);
      place(card, 560 - 250 * e, 330 - 120 * e);
      ctx.at(600 - 250 * e, 350 - 120 * e);
    });
    zone.classList.add('over');
    await ctx.wait(300);
    card.remove();
    zone.classList.add('busy');
    await ctx.wait(1300);
    ed.root.classList.remove('home');
    ed.file.textContent = S.pdfFile;
    ed.file.parentElement?.classList.remove('off');
    zone.remove();
    const doc = place(h('div', 'pp', '', ed.view), PAPER_X - VIEW_LEFT, PAPER_Y - BODY_TOP, 330, 467);
    h('div', 'pp-band', `<span>${S.studio}</span><span>1</span>`, doc);
    place(h('div', 'pp-title', esc(S.proposalTitle), doc), 24, 44);
    place(h('div', 'pp-p', lines(S.proposalLines), doc), 24, 76, 290);
    place(h('div', 'pp-chart', '<i></i><i></i><i></i><i></i><i></i>', doc), 24, 120, 282, 110);
    place(h('div', 'pp-p', lines(S.p2), doc), 24, 248, 290);
    doc.classList.add('arrive');
    ctx.toast(ed, fmt(T('convert.opened'), { format: 'DOCX' }));
    await ctx.move(560, 420, 900);
    await ctx.wait(2600);
  },
};

/* ---- wiring --------------------------------------------------------------------------------- */

const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

for (const figure of document.querySelectorAll<HTMLElement>('figure[data-mock]')) {
  const scene = SCENES[figure.dataset.mock ?? ''];
  if (!scene) continue;
  const stage = h('div', 'stage', '', figure);
  const fit = (): void => {
    stage.style.setProperty('--s', String(figure.clientWidth / W));
  };
  fit();
  new ResizeObserver(fit).observe(figure);

  let run = 0;
  const play = async (instant: boolean): Promise<void> => {
    const id = ++run;
    const alive = (): boolean => id === run;
    figure.classList.toggle('instant', instant);
    try {
      do {
        stage.replaceChildren();
        figure.classList.remove('fade');
        await scene(stage, context(figure, stage, instant, alive));
        if (instant) return;
        figure.classList.add('fade');
        await new Promise((resolve) => setTimeout(resolve, 450));
      } while (alive());
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
    }
  };

  if (still) {
    void play(true);
    continue;
  }
  new IntersectionObserver(
    ([entry]) => {
      if (entry?.isIntersecting) void play(false);
      else {
        run++;
        figure.nextElementSibling?.classList.remove('on');
      }
    },
    { threshold: 0.35 },
  ).observe(figure);
}
