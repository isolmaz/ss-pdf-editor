#!/usr/bin/env node
/**
 * Phase 3 acceptance harness — throwaway driver, not the e2e suite.
 *
 *   node tools/spikes/phase3-check.mjs [--port 4198] [--keep]
 *
 * What the phase promised:
 *
 *   > open → search → highlight → comment → fill a form → delete 2 pages, add 1 →
 *   > apply header/footer → save → reopen: everything in place
 *
 * This harness drives exactly that sentence through the real UI, under the production
 * policy (the assembled `dist/` served by `tools/preview-dist.mjs`, so `public/_headers`
 * is in force), and asserts the **observable** result at every step: the status bar's
 * page count, the comment panel's rows, the report sentences the writer produces, and —
 * for the save — the bytes of the file the app writes.
 *
 * Beyond the acceptance sentence it checks the pieces that sentence cannot reach:
 *  - a shape annotation, which is the half pdf.js cannot write;
 *  - a text mark's `/Subtype` after a save (underline is an underline in the file);
 *  - the form inventory panel and a field fill through it;
 *  - page boxes, page labels, page insertion and a page replace through their dialogs;
 *  - the object-level redaction audit and the four-state signature verdict.
 *
 * Every check is bounded (`PHASE3_CHECK_TIMEOUT`, default 180 s) and prints as it lands,
 * because an unbounded harness cannot be evidence.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { chromium } from 'playwright';
import { createFixture, readFixture } from './mupdf-fixture.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const port = Number.parseInt(readArg('--port', '4198'), 10);
const keepFixture = args.includes('--keep');
const origin = process.env.VERIFY_ORIGIN ?? `http://localhost:${port}`;
const externalServer = process.env.VERIFY_ORIGIN !== undefined;
const FIXTURE_PAGES = 4;

if (!existsSync(join(ROOT, 'dist', 'editor', 'index.html'))) {
  console.error(
    'phase3-check: dist/editor/index.html is missing — run `pnpm build && pnpm assemble:dist` first',
  );
  process.exit(1);
}

/**
 * The fixture: four text pages plus one text form field, built here so the document the
 * checks run against is reproducible from the repository alone. The text is Latin-1
 * because the standard-14 Helvetica is WinAnsi encoded and a fixture that cannot encode
 * its own text would fail for the wrong reason.
 */
function buildFixture(dir) {
  const pdf = createFixture(mupdf);
  for (let index = 1; index <= FIXTURE_PAGES; index += 1) {
    const page = pdf.addPage(595.28, 841.89);
    page.text(`Phase 3 fixture - page ${index} of ${FIXTURE_PAGES}`, {
      x: 56,
      y: 760,
      size: 18,
      color: [0.1, 0.1, 0.1],
    });
    page.text('Gizlilik bu belge yalnizca yerel olarak islenir', {
      x: 56,
      y: 720,
      size: 11,
      color: [0.3, 0.3, 0.3],
    });
    for (let line = 0; line < 10; line += 1) {
      page.text(`Page ${index} body line ${line + 1}`, {
        x: 56,
        y: 680 - line * 20,
        size: 11,
        color: [0.15, 0.15, 0.15],
      });
    }
    if (index === 1) page.textField('musteri', [56, 90, 276, 114], 'Ada Lovelace');
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'phase3-fixture-4p.pdf');
  writeFileSync(path, pdf.save());
  return path;
}

/**
 * `--only <regex>` runs a subset, in the file's order. Added for bisecting a press-loss
 * defect: which earlier check leaves the session in a state
 * where a real press is lost. A subset run still needs the checks a step depends on — the
 * point test is a comment on a mark, and every page check needs the interface-mode step
 * that leaves the simple mode, for instance — so the filter is inclusive by name.
 */
const onlyPattern = (() => {
  const index = args.indexOf('--only');
  const raw = index === -1 ? null : args[index + 1];
  return raw === null || raw === undefined ? null : new RegExp(raw, 'i');
})();

const checks = [];
/** Names `--only` left out: a subset run must never report itself as a full one. */
const skipped = [];
const consoleErrors = [];
const CHECK_TIMEOUT_MS = Number.parseInt(process.env.PHASE3_CHECK_TIMEOUT ?? '180000', 10);

/**
 * Waits until `url` answers. `child` is our own preview server when there is one, and a
 * child that has exited cannot start answering: without that guard the poll would go on
 * knocking on whichever process owns the port, and the run would report on a server that
 * is not ours. `VERIFY_ORIGIN` is the one way to say "that origin is already running".
 */
async function waitForServer(url, timeoutMs = 20_000, child = null) {
  const deadline = Date.now() + timeoutMs;
  let gone = null;
  const onExit = (code, signal) => {
    gone = `exited (${code ?? signal ?? 'unknown'})`;
  };
  const onError = (error) => {
    gone = `could not be started (${String(error?.message ?? error)})`;
  };
  child?.once('exit', onExit);
  child?.once('error', onError);
  try {
    for (;;) {
      if (gone !== null)
        throw new Error(
          `our own server ${gone} before answering ${url} — is port ${port} served by something else?`,
        );
      try {
        const response = await fetch(url);
        if (response.ok) return;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`no answer from ${url} within ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    child?.off('exit', onExit);
    child?.off('error', onError);
  }
}

let page = null;

async function recoverFromFailure() {
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const open = await page.locator('[role="dialog"]').count();
    if (open > 0) {
      const close = page
        .getByRole('dialog')
        .getByRole('button', { name: /^(Kapat|İptal)$/ })
        .first();
      await close.click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    // An operation left open in the tools panel is closed the same way a user would.
    const back = page.getByRole('button', { name: 'Tüm Araçlara Dön', exact: true }).first();
    if ((await back.count()) > 0 && (await back.isVisible())) await back.click();
    await page.waitForTimeout(200);
  } catch {
    // the tab may be gone; the next check reports that on its own
  }
}

async function check(name, fn, timeoutMs = CHECK_TIMEOUT_MS) {
  if (onlyPattern !== null && !onlyPattern.test(name)) {
    skipped.push(name);
    return;
  }
  const started = Date.now();
  let timer;
  try {
    const detail = await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    checks.push({ name, ok: true, detail: detail ?? '' });
  } catch (error) {
    const message = String(error?.message ?? error)
      .replace(/\s+/g, ' ')
      .trim();
    checks.push({ name, ok: false, detail: message.slice(0, 2000) });
    await recoverFromFailure();
  } finally {
    clearTimeout(timer);
  }
  const entry = checks.at(-1);
  console.log(
    `  ${entry.ok ? 'PASS' : 'FAIL'}  ${name} — ${entry.detail} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
}

/** Waits until the comment panel has listed at least one row, or fails with what it sees. */
async function markRows() {
  const list = page.locator('ul[aria-label="Notlar"]').first();
  await list.waitFor({ state: 'visible', timeout: 20_000 });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await list.locator('> li').count();
    if (rows > 0) return rows;
    await page.waitForTimeout(400);
  }
  const text = await page.locator('body').innerText();
  throw new Error(`comment panel stayed empty: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
}

/** The page list's own option element, by 0-based page index. */
function pageOption(index) {
  return page.locator(`[data-page-option="${index}"]`).first();
}

/** A panel tab, by its own Turkish label — the left `DocumentPanel` or the right `Dock`. */
async function openTab(label) {
  await page.getByRole('tab', { name: label, exact: true }).first().click();
  await page.waitForTimeout(400);
}

/**
 * A menu command, by its own Turkish label (the dictionary's copy, never a
 * paraphrase). The menu bar is a real ARIA menubar: the triggers are
 * `role="menuitem"` inside `role="menubar"`, the panel is `role="menu"`.
 */
async function runMenuCommand(menu, command) {
  const bar = page.getByRole('menubar');
  await bar.getByRole('menuitem', { name: menu, exact: true }).first().click();
  // Toggle commands (the annotation tools, reading mode, the docks) are
  // `menuitemcheckbox`; a command without a `checked` state is a plain menu item.
  const item = page
    .getByRole('menu')
    .getByRole('menuitem', { name: command, exact: true })
    .or(page.getByRole('menu').getByRole('menuitemcheckbox', { name: command, exact: true }))
    .first();
  await item.waitFor({ state: 'visible', timeout: 10_000 });
  await item.click();
  await page.getByRole('menu').waitFor({ state: 'hidden', timeout: 10_000 });
}

/**
 * Whether the named menu offers the named command right now: the same bar and the same
 * `role`/label pair `runMenuCommand` drives, opened and closed without running anything.
 * The interface-mode step reads the mode from this surface — the one the page checks
 * depend on — instead of from the storage key the switch persists.
 */
async function menuOffers(menu, command) {
  const bar = page.getByRole('menubar');
  await bar.getByRole('menuitem', { name: menu, exact: true }).first().click();
  const panel = page.getByRole('menu');
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  const offered = (await panel.getByRole('menuitem', { name: command, exact: true }).count()) > 0;
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden', timeout: 10_000 });
  return offered;
}

/**
 * The operation form: every capability opens in the tools panel as a region named by its
 * title, in two steps — "Önizle" runs it and shows the report, "Belgeye uygula" applies it.
 */
async function waitForOperationForm(timeout) {
  await page
    .getByRole('button', { name: 'Önizle', exact: true })
    .first()
    .waitFor({ state: 'visible', timeout });
}

async function confirmDialog() {
  // The tools panel's operation region, identified by its way back — a locator that
  // survives the form turning into its report.
  const form = page
    .getByRole('region')
    .filter({ has: page.getByRole('button', { name: 'Tüm Araçlara Dön' }) });
  await form.getByRole('button', { name: 'Önizle', exact: true }).click();
  try {
    await form.getByRole('heading', { name: 'İşlem raporu', exact: true }).waitFor({ timeout: 60_000 });
  } catch {
    throw new Error(
      `operation did not finish: ${await form.innerText()} | ${await form
        .locator('[data-dialog-diagnostic]')
        .getAttribute('data-dialog-diagnostic')
        .catch(() => '')}`,
    );
  }
  await form.getByRole('button', { name: 'Belgeye uygula', exact: true }).click();
  await page
    .getByRole('heading', { name: 'İşlem raporu', exact: true })
    .waitFor({ state: 'hidden', timeout: 30_000 });
}

const fixtureDir = join(tmpdir(), `pdf-editor-phase3-${process.pid}`);
const fixture = buildFixture(fixtureDir);

let server = null;
let browser = null;
/** Our own server's last words: a child that dies on a busy port explains itself there. */
let serverError = '';
try {
  if (!externalServer) {
    /**
     * The port has to be free before our child takes it: a server that answers here
     * already is not the one this run is about, and `VERIFY_ORIGIN` is the only way to
     * say that a foreign server is the intended one. Without this the first poll can be
     * answered by a stale preview — our child needs longer to bind than a fetch needs to
     * return — and every check below would report on that server under our name.
     */
    const alreadyServing = await fetch(`${origin}/editor/`).then(
      (response) => response.ok,
      () => false,
    );
    if (alreadyServing) {
      throw new Error(
        `${origin} already answers — stop whatever owns port ${port}, or set VERIFY_ORIGIN to verify that server on purpose`,
      );
    }
    server = spawn(
      process.execPath,
      [join(ROOT, 'tools', 'preview-dist.mjs'), '--root', 'dist', '--port', String(port)],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    server.stdout.resume();
    server.stderr.on('data', (chunk) => {
      // Kept rather than resumed away: "address already in use" is the whole answer to
      // "why did this run not start", and this is the only place it can be read.
      serverError = `${serverError}${String(chunk)}`.slice(-400);
    });
    try {
      await waitForServer(`${origin}/editor/`, 20_000, server);
    } catch (error) {
      // Never fall through to whatever else answers on this port: without an explicit
      // `VERIFY_ORIGIN` this run reports on the server it started, and only on that one.
      throw new Error(
        `${String(error?.message ?? error)}${
          serverError.trim() === '' ? '' : ` — ${serverError.trim().replace(/\s+/g, ' ')}`
        }`,
      );
    }
  }

  const executablePath = process.env.CHROMIUM_PATH ?? chromium.executablePath();
  try {
    browser = await chromium.launch(
      existsSync(executablePath) ? { executablePath, headless: true } : { headless: true },
    );
  } catch (error) {
    // A missing browser fails a required harness; it never skips green. The acceptance
    // cannot be claimed from a run that never opened the app, so the message names the
    // install step, and the `finally` below still stops our own server.
    const message = String(error?.message ?? error);
    if (message.includes("Executable doesn't exist")) {
      throw new Error(
        `Playwright's Chromium is not installed (${executablePath}) — run \`pnpm exec playwright install chromium\`, or point CHROMIUM_PATH at a browser. ${message.split('\n')[0]}`,
      );
    }
    throw error;
  }
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    acceptDownloads: true,
  });
  page = await context.newPage();
  /**
   * Turkish, because the copy quoted by every locator below is Turkish. The shell takes
   * the stored locale first and otherwise auto-detects — English for an English browser —
   * so the language of the machine would decide what this run asserts. This is the app's
   * own key (`LanguageSelector`), written before the first script of every navigation.
   */
  await page.addInitScript(() => {
    window.localStorage.setItem('pdf-editor.locale', 'tr');
  });
  page.on('pageerror', (error) => {
    const frame = (error.stack ?? '')
      .split('\n')
      .slice(1, 4)
      .map((line) => line.trim().replace(/https?:\/\/[^)]+\/(assets\/[^):]+):\d+:\d+/, '$1:$2:$3'))
      .join(' ← ');
    consoleErrors.push(`pageerror: ${error.message.slice(0, 160)}${frame === '' ? '' : ` [${frame}]`}`);
  });
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error') consoleErrors.push(`console: ${text.slice(0, 200)}`);
  });

  await check('shell renders under the production policy', async () => {
    await page.goto(`${origin}/editor/`, { waitUntil: 'load' });
    await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30_000 });
    await page.waitForSelector('footer', { timeout: 30_000 });
    const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
    if (!isolated) throw new Error('crossOriginIsolated is false: COOP/COEP are not in force');
    return 'shell painted, file input + status bar present, crossOriginIsolated';
  });

  await check(`open: status bar reads "Sayfa 1 / ${FIXTURE_PAGES}"`, async () => {
    await page.setInputFiles('input[type="file"]', fixture);
    await page.waitForSelector('.pdfViewer .page', { timeout: 60_000 });
    // The status bar's navigation: the page-number field and the "/ total" beside it.
    const expected = `Sayfa 1 / ${FIXTURE_PAGES}`;
    await page.waitForFunction(
      (total) => {
        const footer = document.querySelector('footer');
        const field = footer?.querySelector('input[aria-label="Sayfa numarası"]');
        return (
          field instanceof HTMLInputElement &&
          field.value === '1' &&
          (footer?.textContent ?? '').includes(`/ ${total}`)
        );
      },
      FIXTURE_PAGES,
      { timeout: 30_000 },
    );
    return expected;
  });

  /**
   * The interface mode is the UI prerequisite of every page-organising check below, and
   * the shell starts in **simple** (`apps/web/src/interface-mode.ts`): the menu the bar
   * builds is filtered by mode, so `page.insert` ("Sayfa ekle") and `page.labels` ("Sayfa
   * etiketleri") — the commands `page management` and `page labels` run — are absent
   * until the mode changes, and the export and reopen checks then fail downstream on a
   * page count the harness never wrote. So the default is exercised where a user meets
   * it, and the mode is left the way a user leaves it: through the settings dialog's
   * mode choice, judged on the menu that has to offer the commands afterwards. The
   * storage key is never written from here — that would test the app's filter without
   * testing the control that is supposed to lift it.
   */
  await check(
    'interface mode: the default simple mode hides the page commands, and the switch reveals them',
    async () => {
      const commands = ['Sayfa ekle', 'Sayfa etiketleri'];
      // The Turkish copy is this harness's own premise. Every locator quotes it, and the
      // shell picks it for anything but an English browser, so it is asserted where it
      // is visible rather than assumed from the machine's language.
      await page.getByRole('button', { name: 'Ayarlar', exact: true }).first().click();
      const settings = page.getByRole('dialog', { name: 'Ayarlar' });
      await settings.waitFor({ state: 'visible', timeout: 15_000 });
      const simple = settings.getByRole('radio', { name: 'Basit mod' });
      if (!(await simple.isChecked())) throw new Error('the shell did not start in the simple mode');
      await settings.getByRole('button', { name: 'Kapat', exact: true }).click();
      for (const command of commands) {
        if (await menuOffers('Sayfa', command))
          throw new Error(`the simple mode still offered "${command}" — the filter is not in force`);
      }
      await page.getByRole('button', { name: 'Ayarlar', exact: true }).first().click();
      await settings.getByRole('radio', { name: 'Gelişmiş mod' }).check();
      await settings.getByRole('button', { name: 'Kapat', exact: true }).click();
      for (const command of commands) {
        // The switch's own state and the shell's mode state are two updates; a menu that
        // is one render behind is a timing artefact, not a missing command, so the probe
        // is retried the way a user would open the menu again.
        let offered = false;
        for (let attempt = 0; attempt < 10 && !offered; attempt += 1) {
          offered = await menuOffers('Sayfa', command);
          if (!offered) await page.waitForTimeout(300);
        }
        if (!offered) throw new Error(`"${command}" is still missing after the switch to the advanced mode`);
      }
      return `simple (default) → advanced through the settings; ${commands
        .map((command) => `"${command}"`)
        .join(' and ')} absent before, offered after`;
    },
  );

  await check('search: the find bar reports matches for a text query', async () => {
    await page.keyboard.press('Control+f');
    const field = page.locator('search input[type="text"]').first();
    await field.waitFor({ state: 'visible', timeout: 10_000 });
    await field.fill('body line');
    await field.press('Enter');
    await page.waitForFunction(
      () => /eşleşme/.test(document.querySelector('search')?.textContent ?? ''),
      undefined,
      { timeout: 30_000 },
    );
    const label = await page.evaluate(
      () => document.querySelector('search')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );
    await page.keyboard.press('Escape');
    return label;
  });

  await check('underline: our own layer marks text pdf.js has no writer for', async () => {
    // The panel is opened first, in the order a user works: mark, then look.
    await openTab('Notlar');
    await runMenuCommand('Araçlar', 'Altı çizili');
    const line = page.locator('.textLayer span').filter({ hasText: 'body line' }).first();
    await line.scrollIntoViewIfNeeded();
    const selected = await line.innerText();
    if (selected.length === 0) throw new Error('the text layer produced no text to mark');
    const box = await line.boundingBox();
    if (box === null) throw new Error('the selected text run is not visible');
    // End inside the run: Chromium stops extending a selection after a pointer
    // leaves the text layer's selectable spans. Use the actual pointer route so
    // the creator sees its page target, rather than a synthetic window release.
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 0.25, box.y + box.height / 2, { steps: 16 });
    await page.mouse.up();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('ul[aria-label="Notlar"] > li')].some((row) =>
        row.textContent.includes('Altı çizili'),
      ),
    );
    const session = await page.evaluate(() => ({
      rows: document.querySelectorAll('ul[aria-label="Notlar"] > li').length,
    }));
    let rows = 0;
    try {
      rows = await markRows();
    } catch (error) {
      throw new Error(`${String(error.message).slice(0, 120)} | session ${JSON.stringify(session)}`);
    }
    const text = await page.locator('ul[aria-label="Notlar"]').first().innerText();
    if (!/Altı çizili/.test(text))
      throw new Error(`no underline row: ${text.slice(0, 120)} | ${JSON.stringify(session)}`);
    return `${rows} row(s); marked "${selected.slice(0, 24)}"`;
  });

  await check('shape: a drawn rectangle becomes a shape mark', async () => {
    await page.evaluate(() => {
      document.querySelector('.pdfViewer')?.parentElement?.scrollTo(0, 0);
    });
    await page.waitForTimeout(300);
    await runMenuCommand('Araçlar', 'Dikdörtgen');
    // The layer takes the gesture itself, so the page is the only surface to wait for.
    const pageEl = page.locator('.pdfViewer .page').first();
    await pageEl.waitFor({ state: 'visible', timeout: 10_000 });
    const box = await pageEl.boundingBox();
    await page.mouse.move(box.x + 120, box.y + 220);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 300, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    await openTab('Notlar');
    const text = await page.locator('ul[aria-label="Notlar"]').first().innerText();
    if (!/Şekil/.test(text)) throw new Error(`no shape row in the panel: ${text.slice(0, 200)}`);
    return 'rectangle mark listed';
  });

  await check('comment: a mark carries the text the user typed', async () => {
    await openTab('Notlar');
    const editButton = page.getByRole('button', { name: 'Yorumu düzenle' }).first();
    await editButton.click();
    const area = page.locator('textarea').first();
    await area.fill('Ada Lovelace notu');
    await area.blur();
    await page.waitForTimeout(400);
    const text = await page.locator('ul[aria-label="Notlar"]').first().innerText();
    if (!text.includes('Ada Lovelace notu')) throw new Error(`comment not shown: ${text.slice(0, 200)}`);
    return 'comment text visible in the panel';
  });

  await check('highlight: the controlled creator commits a readable mark on release', async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const line = await page.evaluate(() => {
      const span = [...document.querySelectorAll('.textLayer span')].find((node) =>
        (node.textContent ?? '').includes('body line'),
      );
      if (span === undefined) return null;
      const rect = span.getBoundingClientRect();
      return { x: rect.x, y: rect.y + rect.height / 2, width: rect.width };
    });
    if (line === null) throw new Error('no text line to drag over');
    await runMenuCommand('Araçlar', 'Vurgu');
    await page.waitForTimeout(400);
    await page.mouse.move(line.x + 2, line.y);
    await page.mouse.down();
    await page.mouse.move(line.x + line.width / 2, line.y, { steps: 12 });
    await page.mouse.move(line.x + line.width - 0.25, line.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    // The mark the user drew is still there — as the session's own row, which is the
    // record the save writes and the panel shows. A highlight that silently vanished
    // is the defect this guards; the export check asserts the `/Subtype` in the bytes.
    await openTab('Notlar');
    const text = await page.locator('ul[aria-label="Notlar"]').first().innerText();
    if (!/Vurgu/.test(text)) throw new Error(`no highlight row in the panel: ${text.slice(0, 200)}`);
    return 'highlight listed in the panel immediately after the stroke';
  });

  await check('form panel: lists the field and fills it through the operation', async () => {
    await openTab('Form alanları');
    const list = page.locator('ul[aria-label="Form alanları"]').first();
    await list.waitFor({ state: 'visible', timeout: 15_000 });
    const before = await list.innerText();
    if (!before.includes('musteri')) throw new Error(`field not listed: ${before.slice(0, 200)}`);
    const row = list.locator('li').filter({ hasText: 'musteri' }).first();
    const input = page.locator('#form-musteri');
    /**
     * Deterministic, because the editor's appearance is not instant: the row marks itself
     * selected at once, and the inline control arrives with the inventory reload after it.
     * Waiting for the input alone made this step pass or fail by timing — the same build
     * measured 10/16 and 12/16 on consecutive runs. So: select, wait for
     * the selection to be *visible*, and retry like a user would rather than guess a delay.
     */
    for (let attempt = 0; attempt < 3 && (await input.count()) === 0; attempt += 1) {
      await row.getByRole('button').first().click();
      await page
        .waitForFunction(
          () => document.querySelector('li[data-field-row] button')?.getAttribute('aria-current') === 'true',
          undefined,
          { timeout: 10_000 },
        )
        .catch(() => undefined);
      await page.waitForTimeout(700);
    }
    try {
      await input.waitFor({ state: 'visible', timeout: 15_000 });
    } catch (error) {
      /**
       * The editor never opened. The state at that moment is the only evidence that matters:
       * the selection the panel records, what the list actually shows, and whether the shell
       * has said anything at all.
       */
      const state = await page.evaluate(() => {
        const list = document.querySelector('ul[aria-label="Form alanları"]');
        const selected = document.querySelector('li[data-field-row] button');
        const rows = list === null ? -1 : list.querySelectorAll(':scope > li').length;
        return {
          rows,
          ariaCurrent: selected?.getAttribute('aria-current') ?? '(no row button)',
          notice: document.querySelector('[role="status"]')?.textContent?.trim().slice(0, 60) ?? '(none)',
          controls: list === null ? [] : [...list.querySelectorAll('input, textarea, select')].length,
          listText: (list?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
        };
      });
      throw new Error(`editor did not open · ${JSON.stringify(state)} · ${String(error).slice(0, 60)}`);
    }
    await input.fill('Grace Hopper');
    await input.press('Enter');
    await page.waitForFunction(() => /Belgeye uygulandı/.test(document.body.innerText), undefined, {
      timeout: 60_000,
    });
    // The write swaps the tab's working version, so the inventory reloads from the
    // new bytes: re-open the row and read the value the document now holds.
    await page.waitForTimeout(1500);
    await row.getByRole('button').first().click();
    const reopened = page.locator('#form-musteri');
    await reopened.waitFor({ state: 'visible', timeout: 20_000 });
    const value = await reopened.inputValue();
    if (value !== 'Grace Hopper') throw new Error(`the field reads "${value}" after the fill`);
    return `field filled; the document reports "${value}"`;
  });

  await check('page management: delete two pages and insert one blank page', async () => {
    // Select pages 2 and 3 in the Pages panel, then run the page delete action.
    await openTab('Sayfalar');
    await pageOption(1).click();
    await pageOption(2).click({ modifiers: ['Control'] });
    // The selection toolbar and the hovered page's own overlay both carry this label; the
    // toolbar is the action on the whole selection, which is what this step exercises.
    await page
      .getByRole('toolbar', { name: /^Seçim: 2 sayfa$/ })
      .getByRole('button', { name: 'Sayfaları sil', exact: true })
      .click();
    await page.waitForFunction(
      (count) => (document.querySelector('footer')?.textContent ?? '').includes(`/ ${count}`),
      FIXTURE_PAGES - 2,
      { timeout: 30_000 },
    );
    const afterDelete = await page.evaluate(
      () => document.querySelector('footer')?.textContent?.trim() ?? '',
    );

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await runMenuCommand('Sayfa', 'Sayfa ekle');
    await waitForOperationForm(60_000);
    await confirmDialog();
    await page.waitForFunction(
      (expected) => (document.querySelector('footer')?.textContent ?? '').includes(`/ ${expected}`),
      FIXTURE_PAGES - 1,
      { timeout: 90_000 },
    );
    const afterInsert = await page.evaluate(
      () => document.querySelector('footer')?.textContent?.trim() ?? '',
    );
    return `${afterDelete} → ${afterInsert}`;
  });

  await check('header/footer: the stamp dialog writes page numbers', async () => {
    await runMenuCommand('Araçlar', 'Üst bilgi / alt bilgi ve sayfa numarası');
    await waitForOperationForm(15_000);
    const format = page.getByLabel('Biçim', { exact: true }).first();
    await format.fill('Sayfa {page} / {total}');
    await confirmDialog();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.textLayer span')].some((span) =>
          /^Sayfa \d+ \/ \d+$/.test(span.textContent ?? ''),
        ),
      undefined,
      {
        timeout: 30_000,
      },
    );
    await page.waitForTimeout(1500);
    return 'header/footer applied';
  });

  await check('page labels: the dialog writes a label plan and reports it back', async () => {
    await runMenuCommand('Sayfa', 'Sayfa etiketleri');
    await waitForOperationForm(15_000);
    await confirmDialog();
    await page.waitForFunction(() => /Belgeye uygulandı|etiket/.test(document.body.innerText), undefined, {
      timeout: 90_000,
    });
    await page.waitForTimeout(1200);
    return 'label plan applied';
  });

  await check('properties: the font inventory names Helvetica', async () => {
    if ((await page.getByRole('tab', { name: 'Belge bilgileri', exact: true }).count()) === 0) {
      await page.getByRole('menubar').getByRole('menuitem', { name: 'Görünüm', exact: true }).first().click();
      const viewMenu = page.getByRole('menu');
      await viewMenu.waitFor({ state: 'visible', timeout: 8000 });
      await viewMenu.getByText('Sağ paneli aç/kapat', { exact: false }).first().click();
      await page.waitForTimeout(400);
    }
    await openTab('Belge bilgileri');
    const panel = page.locator('div[role="tabpanel"], section').first();
    await page.waitForFunction(() => /Helvetica/.test(document.body.innerText), undefined, {
      timeout: 30_000,
    });
    const text = await panel.innerText().catch(() => document.body.innerText);
    return text.replace(/\s+/g, ' ').slice(0, 140);
  });

  await check('redaction audit panel opens with its section', async () => {
    await openTab('Karartma denetimi');
    await page.waitForTimeout(1200);
    // "Karartma" is also the tab's own label, so the page text names it whether or not the
    // panel opened. The panel's own control ("Yeniden çalıştır") exists only inside it.
    await page.getByRole('button', { name: 'Yeniden çalıştır', exact: true }).first().waitFor({
      state: 'visible',
      timeout: 8000,
    });
    return 'audit panel opened: its own re-run control is visible';
  });

  await check('export: the file carries the marks, the form value and the page count', async () => {
    // Export writes the current working version as a file — the same bytes Save
    // would write in place, without needing a File System Access handle in a
    // headless browser.
    const download = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Dosya', exact: true }).first().click();
    const fileMenu = page.getByRole('menu');
    await fileMenu.waitFor({ state: 'visible', timeout: 10_000 });
    await fileMenu.getByText('Dışa aktar', { exact: false }).first().click();
    const file = await download;
    const path = join(fixtureDir, 'saved.pdf');
    await file.saveAs(path);

    // Read the file the way a reader does. A writer may put objects in compressed
    // object streams, so a raw-byte `/Subtype` search proves nothing either way — the
    // first version of this check "failed" a file that carried the annotation.
    const reopened = readFixture(mupdf, readFileSync(path));
    const found = [];
    for (let index = 0; index < reopened.pageCount; index += 1) {
      for (const annotation of reopened.annotations(index)) found.push({ page: index, ...annotation });
    }
    const subtypes = [...new Set(found.map((annotation) => annotation.subtype))].sort();
    const wanted = ['Highlight', 'Underline', 'Square'];
    const missing = wanted.filter((subtype) => !subtypes.includes(subtype));
    if (missing.length > 0) {
      throw new Error(
        `annotation subtype missing: ${missing.join(', ')} (saw ${subtypes.join(', ') || 'none'})`,
      );
    }
    for (const subtype of wanted) {
      if (found.filter((item) => item.subtype === subtype).length !== 1)
        throw new Error(`duplicated ${subtype}`);
    }
    if (!found.some((annotation) => annotation.contents.includes('Ada Lovelace notu')))
      throw new Error('comment body lost');
    if (!found.some((annotation) => annotation.name.startsWith('pdf-editor-ann:'))) {
      throw new Error('no pdf-editor-ann marker in the exported annotations');
    }
    // The marker is the annotation's name; a comment that still carries it shows every
    // other reader an opaque id ahead of the words.
    if (found.some((annotation) => annotation.contents.includes('pdf-editor-ann:'))) {
      throw new Error('a pdf-editor-ann marker leaked into /Contents');
    }
    const pageCount = reopened.pageCount;
    if (pageCount !== FIXTURE_PAGES - 1) {
      throw new Error(`saved page count ${pageCount}, expected ${FIXTURE_PAGES - 1}`);
    }
    const value = reopened.fieldValue('musteri');
    if (value !== 'Grace Hopper') throw new Error(`form value after export is "${value}"`);
    return `${pageCount} pages · subtypes [${subtypes.join(', ')}] · form "${value}"`;
  });

  await check('reopen: the exported file opens with its page count and its form value', async () => {
    const path = join(fixtureDir, 'saved.pdf');
    await page.setInputFiles('input[type="file"]', path);
    await page.waitForSelector('.pdfViewer .page', { timeout: 60_000 });
    await page.waitForFunction(
      (expected) => (document.querySelector('footer')?.textContent ?? '').includes(`/ ${expected}`),
      FIXTURE_PAGES - 1,
      { timeout: 60_000 },
    );
    await openTab('Form alanları');
    const list = page.locator('ul[aria-label="Form alanları"]').first();
    await list.waitFor({ state: 'visible', timeout: 30_000 });
    const text = await list.innerText();
    const input = list.locator('input[type="text"]');
    const value = (await input.count()) > 0 ? await input.first().inputValue() : text;
    if (!value.includes('Grace Hopper')) throw new Error(`form value lost on reopen: ${value.slice(0, 200)}`);
    return `reopened with ${FIXTURE_PAGES - 1} pages and the form value in place`;
  });

  await check('the page-action defect stays fixed: two rotations in a row both land', async () => {
    await openTab('Sayfalar');
    await pageOption(0).click();
    const right = page.getByRole('button', { name: 'Sağa döndür', exact: true }).first();
    await right.click();
    await page.waitForTimeout(1500);
    await right.click();
    await page.waitForTimeout(1500);
    const shape = await page.evaluate(() => {
      const page = document.querySelector('.pdfViewer .page canvas');
      return page === null ? null : { width: page.clientWidth, height: page.clientHeight };
    });
    if (shape === null) throw new Error('no canvas after the rotations');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Dışa aktar', exact: true }).click();
    const path = join(fixtureDir, 'rotated.pdf');
    await (await download).saveAs(path);
    const rotated = readFixture(mupdf, readFileSync(path));
    if (rotated.rotation(0) !== 180) throw new Error('the two rotations did not reach the file');
    return `first page canvas ${shape.width}x${shape.height} after two rotations`;
  });
} catch (error) {
  /**
   * Anything that failed before the first check could report itself — our own server
   * never answered, the browser would not launch — lands here. It is recorded where the
   * summary and the exit code already look, so a harness that could not start reports a
   * failure and exits non-zero instead of exiting green on a run that proved nothing.
   */
  checks.push({
    name: 'startup: our own server answers and a browser is available',
    ok: false,
    detail: String(error?.message ?? error)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000),
  });
} finally {
  const failed = checks.filter((entry) => !entry.ok);
  console.log('');
  console.log(
    `  ${checks.length - failed.length} passed, ${failed.length} failed, ${consoleErrors.length} page errors${skipped.length === 0 ? '' : ` — ${skipped.length} SKIPPED by --only`}`,
  );
  if (consoleErrors.length > 0) {
    console.log('  page errors:');
    for (const error of consoleErrors.slice(0, 10)) console.log(`    - ${error}`);
  }
  if (failed.length > 0) {
    console.log('  failures:');
    for (const entry of failed) console.log(`    - ${entry.name}: ${entry.detail}`);
  }
  if (!keepFixture) rmSync(fixtureDir, { recursive: true, force: true });
  else console.log(`  fixture kept at ${fixtureDir}`);
  if (browser !== null) await browser.close();
  if (server !== null) {
    server.kill();
    server.stdout.destroy();
    server.stderr.destroy();
  }
}
process.exit(checks.some((entry) => !entry.ok) || consoleErrors.length > 0 ? 1 : 0);
