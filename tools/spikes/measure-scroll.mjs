/**
 * Scrolling-performance driver (throwaway tooling, `PLAN.md §9/K21`).
 *
 * Reproduces what the owner reported on a 130-page image-heavy document and measures it:
 * open time, then a full scroll of the document while sampling frame times, the number of
 * live page canvases and the JS heap. Prints one JSON blob so a before/after comparison is
 * arithmetic, not opinion.
 *
 * Usage: node tools/spikes/measure-scroll.mjs [fixture.pdf] [--label before|after]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const fixture =
  args.find((value) => value.endsWith('.pdf')) ??
  'C:/Users/isolm/AppData/Local/Temp/pdf-editor-img/photo-130p.pdf';
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'run';
const dpr = args.includes('--dpr') ? Number(args[args.indexOf('--dpr') + 1]) : 1;
const hidePanel = args.includes('--hide-panel');
const zoom100 = args.includes('--zoom100');
const squeezePanel = args.includes('--squeeze-panel');
const settle = args.includes('--settle') ? Number(args[args.indexOf('--settle') + 1]) : 3000;
const origin = process.env.VERIFY_ORIGIN ?? 'http://localhost:4178';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(),
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 160)));

try {
  const started = Date.now();
  await page.goto(`${origin}/editor/`, { waitUntil: 'load' });
  await page.waitForSelector('input[type="file"]', { state: 'attached' });
  await page.setInputFiles('input[type="file"]', fixture);
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 120_000 });
  const openMs = Date.now() - started;
  await page.waitForTimeout(settle);
  if (squeezePanel) {
    // Panel stays mounted (its observers and React work keep running) but occupies no
    // width, so the viewer gets the roomy geometry. Separates 'panel work' from
    // 'viewer geometry'.
    await page.evaluate(() => {
      const tab = document.querySelector('[role="tab"]');
      const column = tab?.parentElement?.parentElement;
      if (column instanceof HTMLElement) {
        column.style.width = '0px';
        column.style.overflow = 'hidden';
        column.style.borderRightWidth = '0px';
      }
    });
    await page.waitForTimeout(1200);
  }
  if (hidePanel) {
    // Isolation switch: the thumbnail column stops rendering, nothing else changes.
    await page.evaluate(() => {
      const tab = document.querySelector('[role="tab"]');
      const column = tab?.parentElement?.parentElement;
      if (column instanceof HTMLElement) column.style.display = 'none';
    });
    await page.waitForTimeout(1200);
  }

  if (zoom100) {
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '100%')?.click();
    });
    await page.waitForTimeout(2500);
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metricsOf = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  };
  const before = await metricsOf();
  const scrolled = await page.evaluate(async () => {
    const candidates = [...document.querySelectorAll('*')].filter((el) => {
      const overflow = getComputedStyle(el).overflowY;
      return overflow === 'auto' || overflow === 'scroll';
    });
    const container = candidates
      .map((el) => ({ el, range: el.scrollHeight - el.clientHeight }))
      .sort((left, right) => right.range - left.range)[0];
    if (container === undefined || container.range <= 0) throw new Error('no scrollable container');

    const frames = [];
    let last = performance.now();
    let running = true;
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const sample = () => ({
      canvases: document.querySelectorAll('.pdfViewer .page canvas').length,
      renderedPages: document.querySelectorAll(
        '.pdfViewer .page[data-page-number][style*="visible"], .pdfViewer .page canvas',
      ).length,
      heapMB:
        performance.memory === undefined ? null : Math.round(performance.memory.usedJSHeapSize / 1048576),
    });
    const samples = [];
    const target = container.range;
    const startedAt = performance.now();
    // ~60 wheel-sized steps, the way a reader scrolls a long document.
    for (let step = 1; step <= 60; step += 1) {
      container.el.scrollTop = (target * step) / 60;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (step % 10 === 0) samples.push(sample());
    }
    running = false;
    const valid = frames.filter((value) => value > 0 && value < 2000);
    const sorted = [...valid].sort((left, right) => left - right);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return {
      totalMs: Math.round(performance.now() - startedAt),
      frames: valid.length,
      medianMs: Number(at(0.5).toFixed(2)),
      p95Ms: Number(at(0.95).toFixed(2)),
      worstMs: Number((sorted.at(-1) ?? 0).toFixed(1)),
      over25: valid.filter((value) => value > 25).length,
      over33: valid.filter((value) => value > 33).length,
      over100: valid.filter((value) => value > 100).length,
      samples,
      finalCanvas: sample(),
    };
  });

  const after = await metricsOf();
  let profile = null;
  if (args.includes('--profile')) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 300 });
    await cdp.send('Profiler.start');
    await page.evaluate(async () => {
      const container = [...document.querySelectorAll('*')]
        .filter((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY))
        .map((el) => ({ el, range: el.scrollHeight - el.clientHeight }))
        .sort((a, b) => b.range - a.range)[0];
      for (let step = 1; step <= 20; step += 1) {
        container.el.scrollTop = (container.range * step) / 20;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    });
    const stopped = await cdp.send('Profiler.stop');
    const nodes = new Map(stopped.profile.nodes.map((node) => [node.id, node]));
    const self = new Map();
    const intervalMs = 300 / 1000;
    for (const id of stopped.profile.samples ?? []) {
      const node = nodes.get(id);
      const frame = node?.callFrame ?? {};
      const key = `${frame.functionName || '(anonymous)'} @ ${
        String(frame.url || 'vm')
          .split('/')
          .slice(-1)[0]
      }:${(frame.lineNumber ?? 0) + 1}`;
      self.set(key, (self.get(key) ?? 0) + intervalMs);
    }
    profile = [...self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([key, ms]) => ({ key, ms: Math.round(ms) }));
  }
  const delta = (key) => Number(((after[key] ?? 0) - (before[key] ?? 0)).toFixed(3));
  const counters = {
    taskMs: Math.round(delta('TaskDuration') * 1000),
    scriptMs: Math.round(delta('ScriptDuration') * 1000),
    styleMs: Math.round(delta('RecalcStyleDuration') * 1000),
    layoutMs: Math.round(delta('LayoutDuration') * 1000),
    layouts: delta('LayoutCount'),
    styleRecalcs: delta('RecalcStyleCount'),
    nodes: delta('Nodes'),
  };

  // Magnifier stability: drag the pointer across the page and count distinct lenses/errors.
  const magnifier = await page.evaluate(async () => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => (b.getAttribute('aria-label') ?? '').trim() === 'Büyüteç',
    );
    if (button === undefined) return 'no-button';
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const lens = () => document.querySelector('.pdf-magnifier-lens, [class*="magnifier"]');
    const first = lens();
    const box = document.querySelector('.pdfViewer .page canvas')?.getBoundingClientRect();
    const seen = new Set();
    for (let step = 0; step < 24; step += 1) {
      const x = (box?.left ?? 300) + 40 + step * 12;
      const y = (box?.top ?? 200) + 60 + (step % 5) * 20;
      const target = document.elementFromPoint(x, y);
      target?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const node = lens();
      seen.add(node === null ? 'none' : String(node.getBoundingClientRect().width));
    }
    return { opened: first !== null, widths: [...seen].slice(0, 6) };
  });

  console.log(
    JSON.stringify(
      { label, dpr, hidePanel, openMs, scrolled, counters, profile, magnifier, errors },
      null,
      1,
    ),
  );
} finally {
  await browser.close();
}
