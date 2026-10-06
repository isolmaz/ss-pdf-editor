import type { Page } from 'playwright/test';
import { expect, test } from 'playwright/test';

/**
 * Flows of the marketing site (`apps/site`, served at `/` and `/en/`). The editor itself
 * (`/editor/`) is covered by the other specs; here it is only the CTA's target.
 */

/** Wait until the page is at `target` (path plus optional hash) on this origin. */
const at = (page: Page, target: string) => page.waitForURL((url) => url.pathname + url.hash === target);

/** The six real pages: [path, html lang, its translation's path]. */
const PAGES = [
  ['/', 'tr', '/en/'],
  ['/gizlilik', 'tr', '/en/privacy'],
  ['/kosullar', 'tr', '/en/terms'],
  ['/en/', 'en', '/'],
  ['/en/privacy', 'en', '/gizlilik'],
  ['/en/terms', 'en', '/kosullar'],
] as const;

test('every page is well-formed: links and anchors resolve, language and SEO metadata agree', async ({
  page,
}) => {
  await page.goto('/');
  // One crawl in the page itself (same origin, so it is the production header policy that
  // answers): fetch each page and report every defect as a readable line.
  const problems = await page.evaluate(
    async (pages: string[]) => {
      const out: string[] = [];
      const docs: Record<string, Document> = {};
      const get = async (path: string) => {
        const response = await fetch(path);
        return { status: response.status, text: await response.text() };
      };
      for (const path of pages) {
        const { status, text } = await get(path);
        if (status !== 200) out.push(`${path}: status ${status}`);
        docs[path] = new DOMParser().parseFromString(text, 'text/html');
      }
      const origin = location.origin;
      const sitemap = (await get('/sitemap.xml')).text;
      const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? '');
      for (const path of pages) {
        const doc = docs[path] as Document;
        const lang = doc.documentElement.lang;
        const inEnglishTree = path.startsWith('/en/');
        if (lang !== (inEnglishTree ? 'en' : 'tr')) out.push(`${path}: lang="${lang}"`);
        if (doc.querySelectorAll('h1').length !== 1) out.push(`${path}: needs exactly one h1`);
        if (doc.querySelectorAll('main').length !== 1) out.push(`${path}: needs exactly one main`);
        if (!doc.querySelector('meta[name="description"]')) out.push(`${path}: no description`);
        const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
        if (canonical !== `https://pdf.isolmaz.com${path}`) out.push(`${path}: canonical ${canonical}`);
        if (!locs.includes(`https://pdf.isolmaz.com${path}`)) out.push(`${path}: missing from sitemap.xml`);
        const alternates = [...doc.querySelectorAll('link[rel="alternate"][hreflang]')].map(
          (link) => `${link.getAttribute('hreflang')}=${link.getAttribute('href')}`,
        );
        if (alternates.length !== 3 || !alternates.includes(`${lang}=${canonical}`)) {
          out.push(`${path}: hreflang set ${alternates.join(',')}`);
        }
        const skip = doc.querySelector('a[href^="#"]');
        if (!doc.getElementById((skip?.getAttribute('href') ?? '#').slice(1)))
          out.push(`${path}: skip link target`);
        for (const a of doc.querySelectorAll('a[href]')) {
          const href = a.getAttribute('href') ?? '';
          const visible = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
          const label = a.getAttribute('aria-label') ?? '';
          if (!visible && !label) out.push(`${path}: link ${href} has no accessible name`);
          if (visible && label && !label.toLowerCase().includes(visible.toLowerCase())) {
            out.push(`${path}: link ${href} aria-label "${label}" drops its visible text "${visible}"`);
          }
          if (/^(mailto:|https?:)/.test(href)) continue;
          const url = new URL(href, origin + path);
          if (url.origin !== origin) continue;
          if (url.pathname === '/editor/') continue;
          const target = docs[url.pathname];
          if (!target) {
            out.push(`${path}: link ${href} leaves the site map`);
          } else if (url.hash && !target.getElementById(decodeURIComponent(url.hash.slice(1)))) {
            out.push(`${path}: link ${href} has no anchor`);
          } else if (inEnglishTree && !a.hasAttribute('hreflang') && !url.pathname.startsWith('/en/')) {
            out.push(`${path}: English page links to Turkish ${href}`);
          }
        }
      }
      for (const loc of locs) {
        const path = loc.replace('https://pdf.isolmaz.com', '');
        if (path !== '/editor/' && !(path in docs)) out.push(`sitemap lists unknown ${loc}`);
      }
      const robots = (await get('/robots.txt')).text;
      if (!robots.includes('https://pdf.isolmaz.com/sitemap.xml')) out.push('robots.txt: no sitemap');
      return out;
    },
    PAGES.map(([path]) => path),
  );
  expect(problems).toEqual([]);
});

test('the language switch leads to the translation and back', async ({ page }) => {
  for (const [path, lang, other] of PAGES) {
    await page.goto(path);
    const switchTo = page.getByRole('link', { name: lang === 'tr' ? 'EN' : 'TR', exact: true });
    await expect(switchTo).toHaveAttribute('href', other);
    await switchTo.click();
    await at(page, other);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe(lang === 'tr' ? 'en' : 'tr');
  }
});

test('the English pages contain no Turkish copy', async ({ page }) => {
  for (const path of ['/en/', '/en/privacy', '/en/terms']) {
    await page.goto(path);
    // Turkish-only letters never occur in the English text (the "TR" switch title is an attribute).
    const leaked = await page.evaluate(() => document.body.innerText.match(/[ğşıİ]/g)?.length ?? 0);
    expect(leaked, `${path} shows Turkish letters`).toBe(0);
  }
});

test('the header CTA opens the editor from both languages', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Düzenleyiciyi Aç', exact: true }).click();
  await at(page, '/editor/');
  await page.goto('/en/');
  await page.getByRole('link', { name: 'Open Editor', exact: true }).click();
  await at(page, '/editor/');
});

test('section anchors scroll to their section and the FAQ expands', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Karşılaştırma', exact: true }).first().click();
  await at(page, '/#karsilastirma');
  await expect(
    page.getByRole('heading', { name: 'Ücretli PDF programları ile karşılaştırın', exact: true }),
  ).toBeVisible();
  const question = page.getByText('Bu hizmet neden %100 ücretsiz?', { exact: true });
  await question.scrollIntoViewIfNeeded();
  await question.click();
  await expect(page.getByText('Tüm belge işleme gücü')).toBeVisible();
});

test('an unknown path gets the styled 404 page with working exits', async ({ page }) => {
  await page.goto('/boyle-bir-sayfa-yok');
  expect(await page.evaluate(async () => (await fetch('/boyle-bir-sayfa-yok')).status)).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sayfa Bulunamadı');
  await page.getByRole('link', { name: 'Ana Sayfaya Dön', exact: true }).click();
  await at(page, '/');
  await page.goto('/boyle-bir-sayfa-yok');
  await page.getByRole('link', { name: 'PDF Düzenleyiciyi Başlat', exact: true }).click();
  await at(page, '/editor/');
});

test('the stored theme applies before first paint and survives a reload', async ({ page }) => {
  const canvases: string[] = [];
  for (const mode of ['dark', 'light']) {
    await page.addInitScript((value: string) => window.localStorage.setItem('pdf-editor.theme', value), mode);
    await page.goto('/');
    // theme-boot.js is a plain synchronous script in <head>, so data-mode is set before the body exists.
    const early = await page.evaluate(() => {
      const script = document.querySelector('head script[src="/theme-boot.js"]');
      return script !== null && !script.hasAttribute('defer') && !script.hasAttribute('async');
    });
    expect(early).toBe(true);
    await page.reload();
    const state = await page.evaluate(() => ({
      mode: document.documentElement.dataset.mode ?? '',
      scheme: document.documentElement.style.colorScheme,
      canvas: getComputedStyle(document.body).backgroundColor,
    }));
    expect(state.mode).toBe(mode);
    expect(state.scheme).toBe(mode);
    canvases.push(state.canvas);
  }
  // The Kumo tokens follow data-mode: the two themes paint different canvases.
  expect(canvases[0]).not.toBe(canvases[1]);
});

test('pages load fonts and images with no CSP violation or failed resource', async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __problems: string[] }).__problems = seen;
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`CSP ${e.violatedDirective} ${e.blockedURI}`),
    );
    window.addEventListener(
      'error',
      (e) => seen.push(`error ${(e.target as { src?: string }).src ?? e.message}`),
      true,
    );
  });
  for (const [path] of PAGES) {
    await page.goto(path);
    const report = await page.evaluate(async () => {
      await document.fonts.ready;
      const failed = [...document.fonts].filter((f) => f.status === 'error').map((f) => `font ${f.family}`);
      const images = [...document.images]
        .filter((i) => !i.complete || i.naturalWidth === 0)
        .map((i) => i.src);
      const bg = await fetch('/footer_bg.jpg');
      const sheets = [...document.styleSheets].length;
      return [
        ...(window as unknown as { __problems: string[] }).__problems,
        ...failed,
        ...images,
        ...(bg.ok && bg.headers.get('content-type')?.startsWith('image/') ? [] : ['footer_bg.jpg']),
        ...(sheets > 0 ? [] : ['no stylesheet']),
      ];
    });
    expect(report, path).toEqual([]);
  }
});

test('the skip link is the first tab stop; no page scrolls sideways on a phone', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Ana içeriğe atla', exact: true })).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path] of PAGES) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} overflows horizontally`).toBeLessThanOrEqual(0);
    await expect(page.getByRole('link', { name: /Düzenleyiciyi Aç|Open Editor/ }).first()).toBeVisible();
  }
});
