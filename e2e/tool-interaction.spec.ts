/**
 * The unified mark tools, as a user meets them.
 *
 * There is no eraser tool here, and no native editor: a mark the user draws — a
 * highlight over selected text, a stroke, a shape — is created by the shell's own
 * controlled creator, and everything afterwards (select, move, turn, delete, undo,
 * redo) is one interaction layer over one page.
 *
 * Two things are asserted the way the user meets them rather than the way the code is
 * wired. The first is the page the marks are painted on: the base canvas is stamped
 * once and checked after every operation the session performs without rewriting the
 * file, so "the document refreshed itself" is a failure and not a redraw to wait out.
 * The second is the file the export produces: geometry that moved is read back out of
 * the produced bytes (`/Rect`, `/QuadPoints`, `/InkList`, the stroke's dash entry), so
 * a mark that moved on screen but not in the file — or a `/Rect` swapped while the
 * geometry underneath stayed put — cannot pass.
 */

import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright/test';
import { useAdvancedMode, useDarkTheme } from './settings';
import { expect, test } from './test';
import {
  FIXTURE_PAGE,
  FORM_FIELD,
  INTERNAL_LINK,
  inkWithin,
  PAGE_ONE_LINES,
  PAGE_TWO_LINE,
  readProducedPageTexts,
  readProducedPdf,
  SAVED_MARKS,
  toolFixturePdf,
} from './tool-fixture';

// Point-driven desktop gestures reach the lower annotation band as well as text.
// The responsive case explicitly switches to its own phone-sized viewport.
test.use({ viewport: { width: 1440, height: 1000 } });

/** The rail's own accessible names, from the shipped English catalogue. */
const RAIL = {
  select: 'Selection Tool',
  hand: 'Hand / Pan Tool',
  // One button for the four text-markup looks; the strip picks the look.
  highlight: 'Mark Up Text (highlight, underline, strike)',
  ink: 'Freehand drawing',
  shapes: 'Draw Shape (Rectangle)',
  note: 'Add comment / Note',
} as const;

/** The comments panel's own words, likewise. */
const KIND = {
  highlight: 'Highlight',
  ink: 'Freehand drawing',
  note: 'Note',
  shape: 'Shape',
} as const;

/** The selection row's own words: the readout, and the actions next to it. */
const SELECTION = {
  status: 'Selection',
  none: 'No marks selected',
  remove: 'Delete selected',
  rotate: 'Rotate 90°',
  moveGroup: 'Move selection',
  moveUp: 'Move up (5 pt)',
  moveDown: 'Move down (5 pt)',
  clear: 'Clear selection',
} as const;

/** What the shell says it did, in its own words. */
const NOTICE = {
  transformed: 'mark(s) moved or rotated.',
  removedOne: '1 mark(s) removed.',
  removedTwo: '2 mark(s) removed.',
} as const;

/** The two badges the panel puts on a row: in the session, or already in the file. */
const PENDING_BADGE = 'unsaved';
const IN_FILE_BADGE = 'in file';

/** The bands this spec's own marks live in, in PDF user space (origin bottom-left). */
const BAND = {
  /** Two strokes in a band of their own. */
  inkLeft: [100, 520, 200, 520] as const,
  inkRight: [300, 520, 400, 520] as const,
  /** The styled stroke, far from every other mark. */
  inkStyled: [400, 300, 520, 340] as const,
  /** The owned note's click point. */
  note: [430, 420] as const,
  /** The owned shape's drag rectangle. */
  shape: [380, 360, 500, 400] as const,
  /** The measurement's two click points. */
  measure: [
    [100, 300],
    [300, 300],
  ] as const,
  /** The pending redaction's rectangle, over the fourth text line. */
  redaction: [72, 574, 320, 594] as const,
} as const;

/**
 * The right end of the saved highlight and its link. The left stroke is rotated
 * later in this case and then reaches the same vertical band at x=180, so the
 * marquee starts to its right rather than accidentally selecting a third mark.
 */
const SAVED_BAND = { from: [230, 736], to: [330, 795] } as const;

/**
 * Case 1's own turn: the file's left stroke lies on the 700 baseline with its bounding
 * box centred at (180, 700), so a clockwise quarter turn about that centre has to come
 * back out of the file as a vertical stroke through the same centre — 216 pt long, the
 * length it had across.
 */
const TURNED_STROKE = { x: 180, y: 700, length: 216 } as const;

/** Case 1's own nudge: the strip's `Move up` is five page points, straight up. */
const NUDGE_POINTS = 5;

/** The colour and width the strip is set to before the styled stroke is drawn. */
const STYLED = { color: '#ff0000', thickness: 12 } as const;

/** What the user types into the form field, unsaved, before anything else happens. */
const EDITED_FORM_VALUE = 'Ada Lovelace';

/** How close two measurements of the same thing have to be. */
const PIXEL = 1.5;

// ---------------------------------------------------------------------------
// driving the shell
// ---------------------------------------------------------------------------

/**
 * Open bytes through the shell's own file input and wait for the document to be the
 * active tab: the panel every case reads is reading *those* bytes from that moment on.
 * The home screen's dropzone input is the one on the page before the first document;
 * once one is open, the shell's own hidden input carries the same handler.
 */
async function openDocument(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page).toHaveTitle(name);
  await expect(page.locator('.pdfViewer[data-active-viewer] .page canvas').first()).toBeVisible({
    timeout: 30_000,
  });
}

/** Open the fixture document and wait for the first page to be painted. */
async function openFixture(page: Page): Promise<void> {
  await page.goto('/editor/');
  await openDocument(page, 'tool-fixture.pdf', toolFixturePdf());
}

/**
 * Read the active stack, not the frozen predecessor retained during byte rewrites.
 * The fieldset is locked until the current mark inventory is ready; the select
 * button itself stays available for read-only navigation and is not that signal.
 * Both capability readiness and its own painted canvas must be present.
 */
async function pageFrame(page: Page): Promise<{ box: { x: number; y: number }; scale: number }> {
  await expect(toolSettings(page)).not.toHaveAttribute('disabled', /.*/);
  await expect(page.locator('.pdfViewer[data-active-viewer] .page canvas').first()).toBeVisible();
  const box = await page
    .locator('.pdfViewer[data-active-viewer] .page')
    .first()
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        x: bounds.x + element.clientLeft,
        y: bounds.y + element.clientTop,
        width: element.clientWidth,
      };
    });
  return { box, scale: box.width / FIXTURE_PAGE.width };
}

/** A page point (PDF user space) as a client point: the page box, then the y flip. */
function toClient(
  frame: { box: { x: number; y: number }; scale: number },
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: frame.box.x + x * frame.scale, y: frame.box.y + (FIXTURE_PAGE.height - y) * frame.scale };
}

/** A press, a travel and a release: the one gesture shape every tool here reads. */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 12,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

/**
 * A drag between two page points, both mapped through one measurement taken as the
 * gesture starts: a document that was written to between two gestures has moved, and a
 * box read before that write is not where the mark now is.
 */
async function dragPage(
  page: Page,
  from: readonly [number, number],
  to: readonly [number, number],
  steps = 12,
): Promise<void> {
  await expect(toolSettings(page)).not.toHaveAttribute('disabled', /.*/);
  // Tool properties can wrap and shrink the visible paper. Bring this gesture's
  // whole vertical band into the scrollport instead of pressing over the status bar.
  await page
    .locator('.pdfViewer[data-active-viewer] .page')
    .first()
    .evaluate(
      (element, band) => {
        const scroller = element.parentElement?.parentElement;
        if (scroller === null || scroller === undefined) throw new Error('missing viewer scrollport');
        const paper = element.getBoundingClientRect();
        const viewport = scroller.getBoundingClientRect();
        const scale = element.clientWidth / band.width;
        const top = paper.top + element.clientTop + (band.height - Math.max(band.from, band.to)) * scale;
        const bottom = paper.top + element.clientTop + (band.height - Math.min(band.from, band.to)) * scale;
        if (top < viewport.top + 20 || bottom > viewport.bottom - 20) {
          scroller.scrollTop += (top + bottom - viewport.top - viewport.bottom) / 2;
        }
      },
      { width: FIXTURE_PAGE.width, height: FIXTURE_PAGE.height, from: from[1], to: to[1] },
    );
  const frame = await pageFrame(page);
  await drag(page, toClient(frame, from[0], from[1]), toClient(frame, to[0], to[1]), steps);
}

/** A click on a page point, measured the same way. */
async function clickPage(page: Page, x: number, y: number): Promise<void> {
  const frame = await pageFrame(page);
  const point = toClient(frame, x, y);
  await page.mouse.click(point.x, point.y);
}

/** A rail button, by the name the rail itself gives it. */
function rail(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** A right-dock tab, by its own label. */
async function openDockTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** The comments panel's rows: the one inventory both the session's and the file's marks land in. */
function commentRows(page: Page) {
  return page.locator('ul[aria-label="Comments"] > li');
}

/** The rows the session holds — the panel's own `unsaved` badge is what says so. */
function pendingRows(page: Page) {
  return commentRows(page).filter({ hasText: PENDING_BADGE });
}

/** The session's own rows of one kind, never the file's marks of the same kind. */
function pendingOfKind(page: Page, kind: string) {
  return pendingRows(page).filter({ hasText: kind });
}

/** A command from a menu, by the menu's and the command's own labels. */
async function runMenuCommand(page: Page, menu: string, command: string): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: menu, exact: true }).first().click();
  const item = page
    .getByRole('menu')
    .getByRole('menuitem', { name: command, exact: true })
    .or(page.getByRole('menu').getByRole('menuitemcheckbox', { name: command, exact: true }))
    .first();
  await item.waitFor({ state: 'visible', timeout: 10_000 });
  await item.click();
  await expect(page.getByRole('menu')).toBeHidden();
}

/** Whether the open menu marks a command as the active one — the toggle's own state. */
async function menuCommandChecked(page: Page, menu: string, command: string): Promise<boolean> {
  await page.getByRole('menubar').getByRole('menuitem', { name: menu, exact: true }).first().click();
  const item = page.getByRole('menu').getByRole('menuitemcheckbox', { name: command, exact: true }).first();
  await item.waitFor({ state: 'visible', timeout: 10_000 });
  const checked = (await item.getAttribute('aria-checked')) === 'true';
  // Escape is the menu's own key (`MenuBar` closes and hands focus back to its trigger);
  // nothing in the shell rebinds it.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  return checked;
}

/**
 * Export through the shell's own Export control and hand back the produced bytes.
 *
 * The toolbar button is the real route (`saveActive` needs an in-place handle this
 * browser session does not have). The download is the bytes; the notice line the shell
 * puts up afterwards is its own statement of what happened, and it is asserted here
 * rather than skipped, so a "download without a word" cannot pass for a working export.
 */
async function exportPdf(page: Page, name: string): Promise<Uint8Array> {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await download;
  const path = test.info().outputPath(name);
  await file.saveAs(path);
  await expect(page.locator('[role="status"]').filter({ hasText: 'downloaded as a new file' })).toBeVisible();
  return new Uint8Array(readFileSync(path));
}

/**
 * The status bar's own page reading — where the window is, as the user reads it: the
 * page-number field of the bar's navigation and the "/ total" beside it.
 */
async function statusPage(page: Page, expected: string): Promise<void> {
  const match = /Page (\d+) of (\d+)/.exec(expected);
  if (match === null) throw new Error(`not a page reading: ${expected}`);
  const footer = page.getByRole('contentinfo');
  await expect(footer.getByRole('textbox', { name: 'Page number' })).toHaveValue(match[1] ?? '');
  await expect(footer).toContainText(`/ ${match[2]}`);
}

/** The tool settings fieldset: the strip the armed tool's own controls live in. */
function toolSettings(page: Page) {
  return page.getByRole('group', { name: 'Tool settings' }).first();
}

/** The selection row's readout — the live region that says how many marks are selected. */
function selectionStatus(page: Page) {
  return page.getByRole('status', { name: SELECTION.status });
}

/** The four directional nudges, as the one named group the strip puts them in. */
function moveGroup(page: Page) {
  return page.getByRole('group', { name: SELECTION.moveGroup });
}

/** A notice the shell has posted, by the words it is showing. */
function notice(page: Page, words: string) {
  return page.locator('[role="status"]').filter({ hasText: words });
}

/** The rendered form field of page 1, by the name the file's own widget carries. */
function formFieldInput(page: Page) {
  return page.locator(`.annotationLayer input[name="${FORM_FIELD.name}"]`);
}

// ---------------------------------------------------------------------------
// the page under the marks
// ---------------------------------------------------------------------------

/**
 * Stamp the base canvas with a private token and hand it back.
 *
 * The element is the observable: a viewer that reloaded, remounted or rebuilt its
 * canvas answers `null` here afterwards, while a page that simply keeps being the same
 * page — marks appearing over it, a mark moving, one undo — keeps the token. Nothing in
 * the shell reads or writes this property; it is the spec's own witness.
 */
async function stampBaseCanvas(page: Page): Promise<number> {
  const token = Date.now() + Math.floor(Math.random() * 1_000);
  await page
    .locator('.pdfViewer[data-active-viewer] .page canvas')
    .first()
    .evaluate((node, value) => {
      (node as HTMLElement & { __canvasToken?: number }).__canvasToken = value;
    }, token);
  return token;
}

/** The same canvas element, still on screen: the first page the user is looking at. */
async function expectSameBaseCanvas(page: Page, token: number): Promise<void> {
  const canvas = page.locator('.pdfViewer[data-active-viewer] .page canvas').first();
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () =>
      canvas.evaluate((node) => (node as HTMLElement & { __canvasToken?: number }).__canvasToken ?? null),
    )
    .toBe(token);
}

// ---------------------------------------------------------------------------
// the selection chrome, and the strokes under it
// ---------------------------------------------------------------------------

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A selected mark's chrome on screen: the bounds the layer drew around it, in client pixels. */
async function selectionChrome(page: Page, family: string): Promise<Box> {
  const box = await page.locator(`[data-mark-selection="${family}"]`).first().boundingBox();
  if (box === null) throw new Error(`the ${family} selection rendered no box`);
  return box;
}

/** How far one dimension has to move for two readings of it to be the same reading. */
function expectClose(actual: number, expected: number, tolerance: number, what: string): void {
  expect(Math.abs(actual - expected), what).toBeLessThanOrEqual(tolerance);
}

/**
 * The outline straddles the mark by two pixels on every side (a hairline still gets a
 * box the user can see), so the mark's own size is the chrome's minus that frame.
 */
function outlinedSize(box: Box): { readonly width: number; readonly height: number } {
  return { width: box.width - 4, height: box.height - 4 };
}

/**
 * A drawn stroke's own geometry, read from the points it paints: the extent it spans and
 * how many samples make it up. A stroke that came back dotted, or as a two-point stub,
 * fails on both readings at once.
 */
async function strokeGeometry(
  stroke: Locator,
): Promise<{ readonly width: number; readonly height: number; readonly count: number }> {
  return stroke.evaluate((node) => {
    const pairs = (node.getAttribute('points') ?? '')
      .trim()
      .split(/\s+/)
      .filter((pair) => pair.length > 0)
      .map((pair) => pair.split(',').map(Number));
    const xs = pairs.map(([x]) => x ?? 0);
    const ys = pairs.map(([, y]) => y ?? 0);
    return {
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      count: pairs.length,
    };
  });
}

/**
 * The box a flat `[x, y, …]` run spans, as the file holds it: its centre and its
 * extents. Pairing the numbers two at a time is what makes this work for a `/Rect`
 * (two corners) and for a stroke's points alike.
 */
function runBox(run: readonly number[]): { x: number; y: number; width: number; height: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index + 1 < run.length; index += 2) {
    xs.push(run[index] ?? 0);
    ys.push(run[index + 1] ?? 0);
  }
  if (xs.length === 0 || ys.length === 0) return null;
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: (minX + Math.max(...xs)) / 2,
    y: (minY + Math.max(...ys)) / 2,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

// ---------------------------------------------------------------------------
// 1 — the file's own annotations, the page's own content, one history, one export
// ---------------------------------------------------------------------------

test.describe('saved annotations and the page they sit on', () => {
  test("selecting, moving, turning and deleting the file's own marks is one history, and the export carries exactly those edits", async ({
    page,
  }) => {
    await openFixture(page);
    await openDockTab(page, 'Comments');

    // The canvas the page is painted on, stamped before the first gesture. Everything
    // below that does not rewrite the document has to leave this element in place; the
    // steps that do rewrite it are the two transforms and the delete, and they are read
    // back out of the produced file instead.
    const canvas = await stampBaseCanvas(page);

    // The file's annotations are in the inventory: five of them, each marked as belonging
    // to the file rather than to the session, and each labelled by its own kind. The
    // second page's highlight is listed too — one inventory, both pages.
    await expect(commentRows(page)).toHaveCount(5);
    await expect(commentRows(page).filter({ hasText: IN_FILE_BADGE })).toHaveCount(5);
    await expect(commentRows(page).filter({ hasText: PENDING_BADGE })).toHaveCount(0);
    await expect(commentRows(page).filter({ hasText: SAVED_MARKS.highlight.contents })).toHaveCount(1);
    await expect(commentRows(page).filter({ hasText: SAVED_MARKS.inkLeft.contents })).toHaveCount(1);
    await expect(commentRows(page).filter({ hasText: SAVED_MARKS.inkRight.contents })).toHaveCount(1);
    await expect(commentRows(page).filter({ hasText: SAVED_MARKS.sourceNote.contents })).toHaveCount(1);
    await expect(commentRows(page).first()).toContainText(IN_FILE_BADGE);
    // A form field is not a comment: the widget never becomes a row, and neither does the
    // link — five rows is the whole file.

    // A form edit the user has typed and not saved. The field's own input takes the
    // keystrokes — a mark tool must never swallow a press inside a form field — and the
    // value is live in the engine, which is exactly the state every later step has to
    // carry through: two transforms, a deletion, the undo and redo around it, and the
    // export.
    const frame = await pageFrame(page);
    const fieldCentre = toClient(
      frame,
      (FORM_FIELD.rect[0] + FORM_FIELD.rect[2]) / 2,
      (FORM_FIELD.rect[1] + FORM_FIELD.rect[3]) / 2,
    );
    await page.mouse.click(fieldCentre.x, fieldCentre.y);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName ?? ''))
      .toMatch(/^(INPUT|TEXTAREA)$/);
    await page.keyboard.press('Control+a');
    await page.keyboard.type(EDITED_FORM_VALUE);
    await expect(formFieldInput(page)).toHaveValue(EDITED_FORM_VALUE);
    const fieldInput = formFieldInput(page);

    // Text selection outside marks is still the text layer's, with the select tool armed
    // by default: a drag across the third line selects its words. The release lands
    // *inside* the run — a quarter of a pixel short of its right edge — because that is
    // where Chromium's own text selection ends the run.
    const line = PAGE_ONE_LINES[2];
    const lineBox = await page
      .locator('.textLayer span')
      .filter({ hasText: line.text })
      .first()
      .boundingBox();
    if (lineBox === null) throw new Error('the fixture text layer produced no line to select');
    await drag(
      page,
      { x: lineBox.x + 2, y: lineBox.y + lineBox.height / 2 },
      { x: lineBox.x + lineBox.width - 0.25, y: lineBox.y + lineBox.height / 2 },
    );
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain(line.text);

    // Typing into a form field and selecting text in the page are not mark operations:
    // the page keeps its canvas and nothing ends up selected.
    await expect(page.locator('[data-mark-selection]')).toHaveCount(0);
    await expectSameBaseCanvas(page, canvas);

    // A click on a saved mark selects it, the strip says how many are selected, and the
    // strip offers what can be done with them. The layer arms itself once the file's own
    // inventory is in hand, so the press is retried until the mark answers.
    await expect(async () => {
      await clickPage(page, 200, 773);
      await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(1);
    }).toPass({ timeout: 15_000 });
    await expect(selectionStatus(page)).toHaveText('1 mark(s) selected');
    await expect(page.getByRole('button', { name: SELECTION.remove, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: SELECTION.rotate, exact: true })).toBeVisible();
    await expect(moveGroup(page)).toBeVisible();
    await expectSameBaseCanvas(page, canvas);

    // An empty click clears the selection again, and the row goes back to being a readout:
    // with nothing selected there is nothing to delete, turn or move.
    await clickPage(page, 20, 830);
    await expect(page.locator('[data-mark-selection]')).toHaveCount(0);
    await expect(selectionStatus(page)).toHaveText(SELECTION.none);
    await expect(page.getByRole('button', { name: SELECTION.remove, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: SELECTION.rotate, exact: true })).toHaveCount(0);

    // Arming a creator and setting its style is a strip change, not a document change:
    // the typed form value and the page's canvas both stay exactly as they were.
    await rail(page, RAIL.ink).click();
    await page.locator('input[type="color"][aria-label="Color"]').fill(STYLED.color);
    await expect(fieldInput).toHaveValue(EDITED_FORM_VALUE);
    await expectSameBaseCanvas(page, canvas);
    await rail(page, RAIL.select).click();

    // --- one turn and one nudge, each its own write to the file ----------------------
    //
    // The turn is 90° about the mark's own centre, so the file's left stroke has to come
    // back out of the document vertical, on the same centre (read back below). The nudge
    // is one press of the strip's own arrow: five page points, straight up.
    await clickPage(page, SAVED_MARKS.inkLeft.stroke[0] + 108, SAVED_MARKS.inkLeft.stroke[1]);
    await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(1);
    await expect(selectionStatus(page)).toHaveText('1 mark(s) selected');
    await page.getByRole('button', { name: SELECTION.rotate, exact: true }).click();
    await expect(notice(page, NOTICE.transformed)).toBeVisible();
    await expect(fieldInput).toHaveValue(EDITED_FORM_VALUE);

    // The document was rewritten a moment ago, and the layer arms itself against the
    // inventory the new bytes carry: the press is retried until the mark it aims at
    // answers, which is the moment the new page is interactive rather than a guess.
    await expect(async () => {
      await clickPage(page, SAVED_MARKS.inkRight.stroke[0] + 108, SAVED_MARKS.inkRight.stroke[1]);
      await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(1);
      const selected = await selectionChrome(page, 'existing');
      const target = toClient(await pageFrame(page), SAVED_MARKS.inkRight.stroke[0] + 108, 700);
      expect(selected.x).toBeLessThan(target.x);
      expect(selected.x + selected.width).toBeGreaterThan(target.x);
    }).toPass({ timeout: 15_000 });
    await moveGroup(page).getByRole('button', { name: SELECTION.moveUp, exact: true }).click();
    await expect(notice(page, NOTICE.transformed)).toBeVisible();
    await expect(fieldInput).toHaveValue(EDITED_FORM_VALUE);

    // --- one marquee, two marks, one Delete ------------------------------------------
    //
    // The top band holds the file's highlight and the link that shares its rectangle, and
    // nothing else: one gesture takes both, and one Delete answers for both as one intent.
    // The document moved a moment ago, so the gesture is retried until both marks answer.
    await expect(async () => {
      await dragPage(page, SAVED_BAND.from, SAVED_BAND.to);
      await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(2);
    }).toPass({ timeout: 15_000 });
    await expect(selectionStatus(page)).toHaveText('2 mark(s) selected');
    await page.getByRole('button', { name: SELECTION.remove, exact: true }).click();
    await expect(notice(page, NOTICE.removedTwo)).toBeVisible();
    await expect(commentRows(page)).toHaveCount(4);
    await expect(commentRows(page).filter({ hasText: SAVED_MARKS.highlight.contents })).toHaveCount(0);
    await expect(page.locator('[data-mark-selection]')).toHaveCount(0);

    // The typed form value is not collateral of any of this: it survives the turn, the
    // nudge, the deletion, and one undo of that deletion — which has to bring the marks
    // back without restoring a stale form state.
    await expect(fieldInput).toHaveValue(EDITED_FORM_VALUE);
    await page.keyboard.press('Control+z');
    await expect(commentRows(page)).toHaveCount(5);
    await expect(commentRows(page).filter({ hasText: SAVED_MARKS.highlight.contents })).toHaveCount(1);
    await expect(fieldInput).toHaveValue(EDITED_FORM_VALUE);
    await page.keyboard.press('Control+y');
    await expect(commentRows(page)).toHaveCount(4);
    await expect(commentRows(page).filter({ hasText: SAVED_MARKS.highlight.contents })).toHaveCount(0);
    await expect(fieldInput).toHaveValue(EDITED_FORM_VALUE);

    // --- the produced file is the reader's answer ------------------------------------
    const produced = await exportPdf(page, 'edited-saved-marks.pdf');
    const read = await readProducedPdf(produced);
    const pageOne = read.annotations.filter((annotation) => annotation.pageIndex === 0);
    const contents = pageOne.map((annotation) => annotation.contents);
    expect(contents).not.toContain(SAVED_MARKS.highlight.contents);
    expect(pageOne.some((annotation) => annotation.subtype === 'Link')).toBe(false);
    expect(contents).toContain(SAVED_MARKS.inkLeft.contents);
    expect(contents).toContain(SAVED_MARKS.inkRight.contents);
    expect(contents).toContain(SAVED_MARKS.sourceNote.contents);
    expect(pageOne.filter((annotation) => annotation.subtype === 'Widget')).toHaveLength(1);
    expect(read.annotations.filter((annotation) => annotation.pageIndex === 1)).toHaveLength(1);
    // The field carries what the user typed, not the value the file arrived with.
    expect(read.formValue).toBe(EDITED_FORM_VALUE);
    expect(read.pageCount).toBe(2);

    // The turned stroke, as the file holds it: the same centre the user saw, the axis
    // swapped for the other — and the `/Rect` around it is the box of *that* stroke, so a
    // rectangle swapped on its own while the stroke underneath stayed put cannot pass.
    const turned = pageOne.find((annotation) => annotation.contents === SAVED_MARKS.inkLeft.contents);
    expect(turned?.subtype).toBe('Ink');
    expect(turned?.inkLists).toHaveLength(1);
    const turnedStroke = runBox(turned?.inkLists[0] ?? []);
    expect(turnedStroke).not.toBeNull();
    expectClose(turnedStroke?.x ?? 0, TURNED_STROKE.x, 0.5, 'the turned stroke kept its centre in x');
    expectClose(turnedStroke?.y ?? 0, TURNED_STROKE.y, 0.5, 'the turned stroke kept its centre in y');
    expect(turnedStroke?.width ?? 999).toBeLessThan(1);
    expectClose(
      turnedStroke?.height ?? 0,
      TURNED_STROKE.length,
      0.5,
      'the turned stroke is as long as it was wide',
    );
    const turnedRect = runBox(turned?.rect ?? []);
    expectClose(turnedRect?.x ?? 0, TURNED_STROKE.x, 0.5, 'the turned annotation is centred on its stroke');
    expectClose(turnedRect?.y ?? 0, TURNED_STROKE.y, 0.5, 'the turned annotation is centred on its stroke');
    expectClose(turnedRect?.height ?? 0, TURNED_STROKE.length, 0.5, 'the rect spans the turned stroke');
    // The stroke is drawn, not dotted: its style carries no dash pattern.
    expect(turned?.dashPattern ?? []).toHaveLength(0);

    // The nudged stroke: five points up the page, exactly as the strip promised, with the
    // extent it always had.
    const nudged = pageOne.find((annotation) => annotation.contents === SAVED_MARKS.inkRight.contents);
    const nudgedStroke = runBox(nudged?.inkLists[0] ?? []);
    expect(nudgedStroke).not.toBeNull();
    expectClose(
      nudgedStroke?.x ?? 0,
      (SAVED_MARKS.inkRight.stroke[0] + SAVED_MARKS.inkRight.stroke[2]) / 2,
      0.5,
      'the nudge did not move the stroke sideways',
    );
    expectClose(
      nudgedStroke?.y ?? 0,
      SAVED_MARKS.inkRight.stroke[1] + NUDGE_POINTS,
      0.5,
      'one nudge carried the stroke five page points up',
    );
    expectClose(nudgedStroke?.width ?? 0, 216, 0.5, 'the nudged stroke kept its length');
    expect(nudgedStroke?.height ?? 999).toBeLessThan(1);
    expect(nudged?.dashPattern ?? []).toHaveLength(0);

    // The page's own text is untouched by any of it.
    const texts = await readProducedPageTexts(produced);
    expect(texts[0]).toContain(PAGE_ONE_LINES[0].text);
    expect(texts[0]).toContain(PAGE_ONE_LINES[2].text);
    expect(texts[1]).toContain(PAGE_TWO_LINE.text);

    // Reopening the produced file shows the same inventory the bytes do: the four marks
    // left, every one of them the file's own, and the deleted pair gone for good.
    await openDocument(page, 'edited-saved-marks.pdf', produced);
    await openDockTab(page, 'Comments');
    await expect(commentRows(page)).toHaveCount(4);
    await expect(commentRows(page).filter({ hasText: IN_FILE_BADGE })).toHaveCount(4);
    await expect(commentRows(page).filter({ hasText: SAVED_MARKS.highlight.contents })).toHaveCount(0);
    await expect(commentRows(page).filter({ hasText: SAVED_MARKS.inkLeft.contents })).toHaveCount(1);
    await expect(commentRows(page).filter({ hasText: SAVED_MARKS.inkRight.contents })).toHaveCount(1);
    await expect(commentRows(page).filter({ hasText: SAVED_MARKS.sourceNote.contents })).toHaveCount(1);
    await expect(commentRows(page).filter({ hasText: 'Second page highlight' })).toHaveCount(1);

    // And the reopened document's form field holds the typed value, read through the
    // panel's own field control rather than from the app's memory of it.
    await openDockTab(page, 'Form fields');
    const fieldRow = page.locator('ul[aria-label="Form fields"] > li').first();
    await fieldRow.getByRole('button').first().click();
    await expect(page.locator('ul[aria-label="Form fields"] input[type="text"]').first()).toHaveValue(
      EDITED_FORM_VALUE,
    );
  });
});

// ---------------------------------------------------------------------------
// 2 — every family the tools create, one selection, and one page under all of it
// ---------------------------------------------------------------------------

test.describe('the marks the tools create', () => {
  test("one selection drives the session's marks through move, turn, delete and undo, and the page keeps its canvas", async ({
    page,
  }) => {
    await openFixture(page);
    await openDockTab(page, 'Comments');

    // The canvas the whole case is drawn over. Every step that only touches the session's
    // own marks has to leave this element in place — the page does not refresh itself
    // when a mark appears, moves, turns or comes back from an undo.
    const canvas = await stampBaseCanvas(page);

    // The select tool is armed by default and nothing is selected yet: the row is a
    // readout, and every action it could offer is absent rather than disabled.
    await expect(selectionStatus(page)).toHaveText(SELECTION.none);
    await expect(page.getByRole('button', { name: SELECTION.remove, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: SELECTION.rotate, exact: true })).toHaveCount(0);
    await expect(moveGroup(page)).toHaveCount(0);

    // --- a highlight over the text layer, undone while its own tool is still armed ----
    const line = PAGE_ONE_LINES[2];
    await rail(page, RAIL.highlight).click();
    const lineBox = await page
      .locator('.textLayer span')
      .filter({ hasText: line.text })
      .first()
      .boundingBox();
    if (lineBox === null) throw new Error('the fixture text layer produced no line to mark');
    await drag(
      page,
      { x: lineBox.x + 2, y: lineBox.y + lineBox.height / 2 },
      { x: lineBox.x + lineBox.width - 0.25, y: lineBox.y + lineBox.height / 2 },
      16,
    );
    // The session owns the mark the moment the gesture ends: the panel lists it as its
    // own, so the shell's own undo is what a Ctrl+Z has to reach.
    await expect(pendingOfKind(page, KIND.highlight)).toHaveCount(1);
    await expectSameBaseCanvas(page, canvas);
    await page.keyboard.press('Control+z');
    await expect(pendingOfKind(page, KIND.highlight)).toHaveCount(0);
    await expectSameBaseCanvas(page, canvas);
    await page.keyboard.press('Control+y');
    await expect(pendingOfKind(page, KIND.highlight)).toHaveCount(1);
    await expectSameBaseCanvas(page, canvas);

    // --- two strokes, and a third with the strip's own style --------------------------
    await rail(page, RAIL.ink).click();
    await dragPage(page, [BAND.inkLeft[0], BAND.inkLeft[1]], [BAND.inkLeft[2], BAND.inkLeft[3]]);
    await expect(pendingOfKind(page, KIND.ink)).toHaveCount(1);
    await expectSameBaseCanvas(page, canvas);
    await page.keyboard.press('Control+z');
    await expect(pendingOfKind(page, KIND.ink)).toHaveCount(0);
    await page.keyboard.press('Control+y');
    await expect(pendingOfKind(page, KIND.ink)).toHaveCount(1);
    await expectSameBaseCanvas(page, canvas);
    await dragPage(page, [BAND.inkRight[0], BAND.inkRight[1]], [BAND.inkRight[2], BAND.inkRight[3]]);
    await expect(pendingOfKind(page, KIND.ink)).toHaveCount(2);

    // The strip's own controls: colour and thickness before the third stroke, so the mark
    // the user gets is the mark the strip promised.
    await expect(toolSettings(page)).toBeVisible();
    await page.locator('input[type="color"][aria-label="Color"]').fill(STYLED.color);
    await page.getByRole('spinbutton', { name: 'Thickness' }).fill(String(STYLED.thickness));
    await dragPage(page, [BAND.inkStyled[0], BAND.inkStyled[1]], [BAND.inkStyled[2], BAND.inkStyled[3]]);
    await expect(pendingOfKind(page, KIND.ink)).toHaveCount(3);
    const strokes = page.locator('[data-ann] polyline');
    await expect(strokes).toHaveCount(3);
    const styledStroke = strokes.nth(2);
    expect(await styledStroke.getAttribute('stroke')).toBe(STYLED.color);
    const styledWidth = Number(await styledStroke.getAttribute('stroke-width'));
    const defaultWidth = Number(await strokes.nth(0).getAttribute('stroke-width'));
    expect(styledWidth).toBeGreaterThan(defaultWidth);
    await expectSameBaseCanvas(page, canvas);

    // The stroke the user drew reached the page whole: the points it was sampled from are
    // all there, its paint carries no dash pattern, and it spans the travel of the gesture
    // rather than a box around it. A line that came back dotted — or as a two-point stub —
    // would fail exactly these readings.
    const drawnStroke = await strokeGeometry(styledStroke);
    expect(drawnStroke.count).toBeGreaterThan(4);
    // The paint, not the source: a dashed stroke would carry a dash pattern here.
    await expect(styledStroke).toHaveCSS('stroke-dasharray', 'none');
    const frame = await pageFrame(page);
    expectClose(drawnStroke.width, 120 * frame.scale, PIXEL, 'the stroke spans the travel it was drawn over');
    expectClose(drawnStroke.height, 40 * frame.scale, PIXEL, 'the stroke spans the travel it was drawn over');

    // --- the strip's actions answer for a mark the session owns -----------------------
    await rail(page, RAIL.select).click();
    await clickPage(
      page,
      (BAND.inkStyled[0] + BAND.inkStyled[2]) / 2,
      (BAND.inkStyled[1] + BAND.inkStyled[3]) / 2,
    );
    await expect(page.locator('[data-mark-selection="annotation"]')).toHaveCount(1);
    await expect(selectionStatus(page)).toHaveText('1 mark(s) selected');
    await expect(page.getByRole('button', { name: SELECTION.remove, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: SELECTION.rotate, exact: true })).toBeVisible();
    await expect(moveGroup(page).getByRole('button', { name: SELECTION.moveUp, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: SELECTION.clear, exact: true })).toBeVisible();
    await expectSameBaseCanvas(page, canvas);

    // A drag on a selected mark carries the whole selection and commits once, on release:
    // the mark follows the pointer, and it is still the same stroke — the geometry moved,
    // it was not redrawn.
    const beforeMove = await selectionChrome(page, 'annotation');
    const grab = { x: beforeMove.x + beforeMove.width / 2, y: beforeMove.y + beforeMove.height / 2 };
    const travel = { x: 40 * frame.scale, y: -20 * frame.scale };
    await drag(page, grab, { x: grab.x + travel.x, y: grab.y + travel.y }, 16);
    await expect(selectionStatus(page)).toHaveText('1 mark(s) selected');
    const afterMove = await selectionChrome(page, 'annotation');
    expectClose(afterMove.x - beforeMove.x, travel.x, 2, 'the dragged mark followed the pointer in x');
    expectClose(afterMove.y - beforeMove.y, travel.y, 2, 'the dragged mark followed the pointer in y');
    const movedStroke = await strokeGeometry(styledStroke);
    expectClose(
      movedStroke.width,
      drawnStroke.width,
      PIXEL,
      'a move carried the stroke, it did not redraw it',
    );
    expectClose(
      movedStroke.height,
      drawnStroke.height,
      PIXEL,
      'a move carried the stroke, it did not redraw it',
    );
    await expectSameBaseCanvas(page, canvas);

    // One press of the strip's own arrow is five page points — points, not pixels.
    await moveGroup(page).getByRole('button', { name: SELECTION.moveDown, exact: true }).click();
    const afterNudge = await selectionChrome(page, 'annotation');
    expectClose(
      afterNudge.y - afterMove.y,
      5 * frame.scale,
      PIXEL,
      'one nudge carried the mark five points down',
    );
    expectClose(afterNudge.x - afterMove.x, 0, 1, 'a vertical nudge did not move the mark sideways');
    await expectSameBaseCanvas(page, canvas);

    // A 90° turn about the mark's own centre: what the user sees swaps its width for its
    // height and stays exactly where the mark was.
    await page.getByRole('button', { name: SELECTION.rotate, exact: true }).click();
    const afterTurn = await selectionChrome(page, 'annotation');
    expectClose(
      outlinedSize(afterTurn).width,
      outlinedSize(afterNudge).height,
      3,
      'the turned mark is as deep as it was wide',
    );
    expectClose(
      outlinedSize(afterTurn).height,
      outlinedSize(afterNudge).width,
      3,
      'the turned mark is as wide as it was deep',
    );
    expectClose(
      afterTurn.x + afterTurn.width / 2,
      afterNudge.x + afterNudge.width / 2,
      2,
      'the turn kept the mark where it was',
    );
    await expectSameBaseCanvas(page, canvas);

    // Undo and redo walk the turn both ways, over the same page.
    await page.keyboard.press('Control+z');
    const turnedBack = await selectionChrome(page, 'annotation');
    expectClose(
      outlinedSize(turnedBack).height,
      outlinedSize(afterNudge).height,
      3,
      'undo took the turn back',
    );
    expectClose(outlinedSize(turnedBack).width, outlinedSize(afterNudge).width, 3, 'undo took the turn back');
    await expectSameBaseCanvas(page, canvas);
    await page.keyboard.press('Control+y');
    const turnedAgain = await selectionChrome(page, 'annotation');
    expectClose(
      outlinedSize(turnedAgain).height,
      outlinedSize(afterTurn).height,
      3,
      'redo put the turn back',
    );
    await expectSameBaseCanvas(page, canvas);
    // A drag the window's focus interrupts commits nothing: the outline preview is gone
    // with the gesture, the mark has not moved, and the journal has not gained a step —
    // the very next Ctrl+Z still steps on the turn.
    const beforeCancel = await selectionChrome(page, 'annotation');
    const cancelGrab = {
      x: beforeCancel.x + beforeCancel.width / 2,
      y: beforeCancel.y + beforeCancel.height / 2,
    };
    await page.mouse.move(cancelGrab.x, cancelGrab.y);
    await page.mouse.down();
    await page.mouse.move(cancelGrab.x + 30, cancelGrab.y + 30, { steps: 12 });
    await expect(page.locator('[data-mark-move-preview]')).toHaveCount(1);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('[data-mark-move-preview]')).toHaveCount(0);
    await page.mouse.up();
    const afterCancel = await selectionChrome(page, 'annotation');
    expectClose(afterCancel.x, beforeCancel.x, 0.5, 'an interrupted drag moved nothing');
    expectClose(afterCancel.y, beforeCancel.y, 0.5, 'an interrupted drag moved nothing');
    expectClose(afterCancel.width, beforeCancel.width, 0.5, 'an interrupted drag resized nothing');
    expectClose(afterCancel.height, beforeCancel.height, 0.5, 'an interrupted drag resized nothing');
    await page.keyboard.press('Control+z');
    const afterCancelUndo = await selectionChrome(page, 'annotation');
    expectClose(
      outlinedSize(afterCancelUndo).height,
      outlinedSize(afterNudge).height,
      3,
      'the undo after the interrupted drag reached the turn, not an invisible move',
    );
    await expectSameBaseCanvas(page, canvas);
    // The turn stays taken back from here on, so the export below reads this stroke where
    // the user left it: carried, nudged, and drawn with the extent the gesture had.

    // Delete takes the whole selection, and undo brings it back — one row fewer in the
    // inventory meanwhile, and the same page under both.
    await page.getByRole('button', { name: SELECTION.remove, exact: true }).click();
    await expect(notice(page, NOTICE.removedOne)).toBeVisible();
    await expect(pendingOfKind(page, KIND.ink)).toHaveCount(2);
    await expect(page.locator('[data-mark-selection]')).toHaveCount(0);
    await expectSameBaseCanvas(page, canvas);
    await page.keyboard.press('Control+z');
    await expect(pendingOfKind(page, KIND.ink)).toHaveCount(3);
    await expectSameBaseCanvas(page, canvas);

    // --- one active tool, whichever surface arms it ----------------------------------
    expect(await menuCommandChecked(page, 'Tools', KIND.highlight)).toBe(false);
    await runMenuCommand(page, 'Tools', KIND.highlight);
    await expect(rail(page, RAIL.highlight)).toHaveAttribute('aria-pressed', 'true');

    // --- a press inside the form field is never swallowed ----------------------------
    await rail(page, RAIL.select).click();
    const fieldCentre = toClient(
      await pageFrame(page),
      (FORM_FIELD.rect[0] + FORM_FIELD.rect[2]) / 2,
      (FORM_FIELD.rect[1] + FORM_FIELD.rect[3]) / 2,
    );
    await page.mouse.click(fieldCentre.x, fieldCentre.y);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName ?? ''))
      .toMatch(/^(INPUT|TEXTAREA)$/);
    await expect(page.locator('[data-mark-selection]')).toHaveCount(0);

    // --- a link inside a mark: select consumes the click, hand still navigates --------
    const linkCentreX = (INTERNAL_LINK.rect[0] + INTERNAL_LINK.rect[2]) / 2;
    const linkCentreY = (INTERNAL_LINK.rect[1] + INTERNAL_LINK.rect[3]) / 2;
    await rail(page, RAIL.hand).click();
    await clickPage(page, linkCentreX, linkCentreY);
    await statusPage(page, 'Page 2 of 2');
    await page.getByRole('button', { name: 'Previous Page', exact: true }).click();
    await statusPage(page, 'Page 1 of 2');
    await rail(page, RAIL.select).click();
    await clickPage(page, linkCentreX, linkCentreY);
    await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(1);
    await statusPage(page, 'Page 1 of 2');
    await page.getByRole('button', { name: SELECTION.clear, exact: true }).click();
    await expect(page.locator('[data-mark-selection]')).toHaveCount(0);

    // --- the owned note, shape, measurement and pending redaction ---------------------
    await rail(page, RAIL.note).click();
    await clickPage(page, BAND.note[0], BAND.note[1]);
    await expect(pendingOfKind(page, KIND.note)).toHaveCount(1);
    await pendingOfKind(page, KIND.note).first().getByRole('button', { name: 'Edit comment' }).click();
    const noteEditor = page.getByLabel('Comment text').first();
    await noteEditor.fill('Round trip note');
    await noteEditor.blur();
    await expect(commentRows(page).filter({ hasText: 'Round trip note' })).toHaveCount(1);

    await rail(page, RAIL.shapes).click();
    await dragPage(page, [BAND.shape[0], BAND.shape[1]], [BAND.shape[2], BAND.shape[3]]);
    await expect(pendingOfKind(page, KIND.shape)).toHaveCount(1);

    // One selection, two families: the shape the session has just drawn and the note the
    // file already carries. The strip's actions answer for the whole selection, wherever
    // each mark came from.
    await rail(page, RAIL.select).click();
    await clickPage(page, (BAND.shape[0] + BAND.shape[2]) / 2, (BAND.shape[1] + BAND.shape[3]) / 2);
    await expect(page.locator('[data-mark-selection="annotation"]')).toHaveCount(1);
    await page.keyboard.down('Shift');
    await clickPage(
      page,
      (SAVED_MARKS.sourceNote.rect[0] + SAVED_MARKS.sourceNote.rect[2]) / 2,
      (SAVED_MARKS.sourceNote.rect[1] + SAVED_MARKS.sourceNote.rect[3]) / 2,
    );
    await page.keyboard.up('Shift');
    await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(1);
    await expect(page.locator('[data-mark-selection="annotation"]')).toHaveCount(1);
    await expect(selectionStatus(page)).toHaveText('2 mark(s) selected');
    await expect(page.getByRole('button', { name: SELECTION.remove, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: SELECTION.rotate, exact: true })).toBeVisible();
    await expect(moveGroup(page).getByRole('button', { name: SELECTION.moveUp, exact: true })).toBeVisible();
    await page.getByRole('button', { name: SELECTION.clear, exact: true }).click();
    await expect(page.locator('[data-mark-selection]')).toHaveCount(0);

    // The ruler's commands are the advanced mode's (the simple mode keeps the markup
    // verbs), so the settings' mode choice is the user's way to them.
    await useAdvancedMode(page);
    await runMenuCommand(page, 'Tools', 'Distance');
    await expect(page.getByRole('application', { name: 'Measure', exact: true })).toBeVisible();
    await clickPage(page, BAND.measure[0][0], BAND.measure[0][1]);
    await clickPage(page, BAND.measure[1][0], BAND.measure[1][1]);
    await page.keyboard.press('Enter');
    const measures = page.locator('button[data-measure]');
    await expect(measures).toHaveCount(1);
    await rail(page, RAIL.select).click();
    await clickPage(page, (BAND.measure[0][0] + BAND.measure[1][0]) / 2, BAND.measure[0][1]);
    await expect(page.locator('[data-mark-selection="measure"]')).toHaveCount(1);
    await expect(selectionStatus(page)).toHaveText('1 mark(s) selected');
    await page.keyboard.press('Delete');
    await expect(measures).toHaveCount(0);

    // A pending redaction is drawn on the page whatever tool is armed, and Delete takes
    // the intent — never the page's own content.
    await openDockTab(page, 'Redaction');
    await page.getByRole('button', { name: 'Open redaction tool', exact: true }).click();
    await dragPage(page, [BAND.redaction[0], BAND.redaction[3]], [BAND.redaction[2], BAND.redaction[1]]);
    const redactionRects = page.locator('[data-mark-family="redaction"]');
    await expect(redactionRects).toHaveCount(1);
    await rail(page, RAIL.select).click();
    await expect(redactionRects).toHaveCount(1);
    await clickPage(
      page,
      (BAND.redaction[0] + BAND.redaction[2]) / 2,
      (BAND.redaction[1] + BAND.redaction[3]) / 2,
    );
    await expect(page.locator('[data-mark-selection="redaction"]')).toHaveCount(1);
    await page.keyboard.press('Delete');
    await expect(redactionRects).toHaveCount(0);
    // The text under it is still the page's text: the pending mark was removed, not applied.
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText(
      PAGE_ONE_LINES[3].text,
    );

    // --- the pending highlight, turned: the file has to carry turned quads ------------
    //
    // The highlight covers the third line, and a quarter turn makes it a narrow bar: the
    // export below reads back the quads it was marked with and the rectangle around them.
    // The line is measured again here: the window went to the second page and back a
    // moment ago, so a box read before that trip is not where the text is now.
    await rail(page, RAIL.select).click();
    const highlightLine = await page
      .locator('.textLayer span')
      .filter({ hasText: line.text })
      .first()
      .boundingBox();
    if (highlightLine === null) throw new Error('the fixture text layer produced no line to mark');
    await page.mouse.click(
      highlightLine.x + highlightLine.width / 2,
      highlightLine.y + highlightLine.height / 2,
    );
    await expect(page.locator('[data-mark-selection="annotation"]')).toHaveCount(1);
    const highlightBefore = await selectionChrome(page, 'annotation');
    // Zoom/navigation above legitimately rerasterized the page. The pending turn
    // must retain this canvas, not the canvas from before those explicit view changes.
    const beforeHighlightTurn = await stampBaseCanvas(page);
    await page.getByRole('button', { name: SELECTION.rotate, exact: true }).click();
    const highlightAfter = await selectionChrome(page, 'annotation');
    expectClose(
      outlinedSize(highlightAfter).height,
      outlinedSize(highlightBefore).width,
      3,
      'the turned highlight is as deep as the line was wide',
    );
    expectClose(
      outlinedSize(highlightAfter).width,
      outlinedSize(highlightBefore).height,
      3,
      'the turned highlight is as wide as the line was deep',
    );
    await expectSameBaseCanvas(page, beforeHighlightTurn);

    // --- everything created is what the produced file carries ------------------------
    const produced = await exportPdf(page, 'created.pdf');
    const read = await readProducedPdf(produced);
    const kinds = read.annotations.map((annotation) => annotation.subtype);
    expect(kinds).toContain('Highlight');
    // Three strokes this session drew, plus the file's own two.
    expect(kinds.filter((subtype) => subtype === 'Ink').length).toBe(5);
    // The session's own note reaches the file as a sticky note carrying the comment the user typed; the fixture's FreeText
    // note (a different body) is not what this reads.
    const roundTripNote = read.annotations.filter((annotation) => annotation.contents === 'Round trip note');
    expect(roundTripNote.map((annotation) => annotation.subtype)).toEqual(['Text']);
    expect(kinds).toContain('Square');
    expect(kinds.filter((subtype) => subtype === 'Measure').length).toBe(0);

    // The styled stroke arrived whole: the sampled points, no dash pattern, and the extent
    // the user dragged. The DOM assertion above pins the thickness, whose dictionary key
    // the engine writer chooses.
    const styledInk = read.annotations.find(
      (annotation) => annotation.subtype === 'Ink' && annotation.color[0] === 1 && annotation.color[1] === 0,
    );
    expect(styledInk).toBeDefined();
    expect((styledInk?.inkLists[0] ?? []).length / 2).toBeGreaterThan(4);
    expect(styledInk?.dashPattern ?? []).toHaveLength(0);
    const styledBox = runBox(styledInk?.inkLists[0] ?? []);
    expectClose(styledBox?.width ?? 0, 120, 1, 'the produced stroke spans the width it was drawn over');
    expectClose(styledBox?.height ?? 0, 40, 1, 'the produced stroke spans the height it was drawn over');

    // The turned highlight: the quads it was marked with are turned, and the `/Rect` the
    // file carries is the box around those quads — a rectangle swapped on its own while
    // the quads stayed put would fail this pair of readings.
    const ownHighlights = read.annotations.filter(
      (annotation) =>
        annotation.pageIndex === 0 &&
        annotation.subtype === 'Highlight' &&
        annotation.contents !== SAVED_MARKS.highlight.contents,
    );
    expect(ownHighlights).toHaveLength(1);
    const ownQuads = runBox(ownHighlights[0]?.quadPoints ?? []);
    const ownRect = runBox(ownHighlights[0]?.rect ?? []);
    if (ownQuads === null || ownRect === null) throw new Error('the exported highlight has no geometry');
    expect(ownQuads.height).toBeGreaterThan(ownQuads.width);
    // An appearance may include bleed beyond its quads. The public contract is
    // containment and correct placement, not the engine's exact padding amount.
    expect(ownRect.x).toBeLessThanOrEqual(ownQuads.x);
    expect(ownRect.y).toBeLessThanOrEqual(ownQuads.y);
    expect(ownRect.x + ownRect.width).toBeGreaterThanOrEqual(ownQuads.x + ownQuads.width);
    expect(ownRect.y + ownRect.height).toBeGreaterThanOrEqual(ownQuads.y + ownQuads.height);
    expectClose(
      ownRect.x + ownRect.width / 2,
      ownQuads.x + ownQuads.width / 2,
      PIXEL,
      'the rect stays centred on the turned quads',
    );
    expectClose(
      ownRect.y + ownRect.height / 2,
      ownQuads.y + ownQuads.height / 2,
      PIXEL,
      'the rect stays centred on the turned quads',
    );

    // The redaction intent is not applied: its text is in the produced file.
    const texts = await readProducedPageTexts(produced);
    expect(texts[0]).toContain(PAGE_ONE_LINES[3].text);
    // The file's own marks and its form value are still there, alongside the new work.
    expect(read.annotations.map((annotation) => annotation.contents)).toContain(
      SAVED_MARKS.highlight.contents,
    );
    expect(read.formValue).toBe(FORM_FIELD.value);
    expect(read.annotations.some((annotation) => annotation.subtype === 'Link')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3 — a note the user writes, through the file and back
// ---------------------------------------------------------------------------

test.describe('a note written by the note tool', () => {
  test('survives export and reopening as a findable, selectable annotation, and a selection Delete takes it again', async ({
    page,
  }) => {
    await openFixture(page);
    await openDockTab(page, 'Comments');

    await rail(page, RAIL.note).click();
    await clickPage(page, BAND.note[0], BAND.note[1]);
    // The file carries a note of its own, so the session's row is the one with the badge.
    const noteRow = pendingOfKind(page, KIND.note).first();
    await expect(noteRow).toHaveCount(1);
    await noteRow.getByRole('button', { name: 'Edit comment' }).click();
    const editor = page.getByLabel('Comment text').first();
    await editor.fill('Note that must survive the file');
    await editor.blur();
    await expect(commentRows(page).filter({ hasText: 'Note that must survive the file' })).toHaveCount(1);

    // The note reaches the file as a sticky note (`/Text`) whose comment is the body the
    // user typed, and another reader paints it: an empty `/FreeText` whose appearance
    // drew nothing would make the note vanish everywhere but in this session.
    const produced = await exportPdf(page, 'note.pdf');
    const written = await readProducedPdf(produced);
    const writtenNote = written.annotations.find(
      (annotation) =>
        annotation.subtype === 'Text' && annotation.contents.includes('Note that must survive the file'),
    );
    expect(writtenNote).toBeDefined();
    // `/Contents` is what every reader prints: the words alone, never this app's
    // `pdf-editor-ann:<id>` identity, which is the annotation's name.
    expect(writtenNote?.contents).toBe('Note that must survive the file');
    expect(
      written.annotations.filter((annotation) => annotation.contents.includes('pdf-editor-ann:')),
    ).toEqual([]);
    const [left = 0, bottom = 0, right = 0, top = 0] = writtenNote?.rect ?? [];
    expect(
      await inkWithin(produced, writtenNote?.pageIndex ?? 0, [left, bottom, right, top]),
    ).toBeGreaterThan(0.3);
    // The file's own source note is still there too: a save does not replace the inventory.
    expect(written.annotations.map((annotation) => annotation.contents)).toContain(
      SAVED_MARKS.sourceNote.contents,
    );

    // Reopened, the note is a row in the inventory with its body, and its own page's text
    // is untouched.
    await openDocument(page, 'note.pdf', produced);
    await openDockTab(page, 'Comments');
    const reopened = commentRows(page).filter({ hasText: 'Note that must survive the file' });
    await expect(reopened).toHaveCount(1);
    await expect(reopened.first()).toContainText(IN_FILE_BADGE);

    // It is selectable on the page, and the selection's own Delete takes it — as the
    // file's annotation, not as a session copy.
    await rail(page, RAIL.select).click();
    await clickPage(page, BAND.note[0], BAND.note[1]);
    await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(1);
    await expect(selectionStatus(page)).toHaveText('1 mark(s) selected');
    await page.keyboard.press('Delete');
    await expect(commentRows(page).filter({ hasText: 'Note that must survive the file' })).toHaveCount(0);

    // And the second export proves it left the file, with the page's text still in place.
    const afterDelete = await exportPdf(page, 'note-deleted.pdf');
    const read = await readProducedPdf(afterDelete);
    expect(
      read.annotations.some((annotation) => annotation.contents.includes('Note that must survive the file')),
    ).toBe(false);
    expect(read.annotations.map((annotation) => annotation.contents)).toContain(
      SAVED_MARKS.sourceNote.contents,
    );
    const texts = await readProducedPageTexts(afterDelete);
    expect(texts[0]).toContain(PAGE_ONE_LINES[0].text);
    expect(texts[0]).toContain(PAGE_ONE_LINES[2].text);
  });
});

// ---------------------------------------------------------------------------
// 4 — the tooltips: content, focus, and the viewport they have to stay inside
// ---------------------------------------------------------------------------

/** The chip a control opened, by its own words. */
function chip(page: Page, label: string) {
  return page.getByRole('tooltip').filter({ hasText: label });
}

/**
 * The chip's resolved paint: its own opacity, its background's alpha, and the contrast
 * between its text and that background.
 *
 * The colours are resolved by the browser itself — a one-pixel canvas returns the sRGB
 * bytes the engine actually paints, whatever syntax the theme authored (`oklch`, `lab`,
 * `color-mix`) — so no colour-string parsing stands in for the real conversion.
 */
async function tipPaint(tip: Locator): Promise<{ opacity: number; alpha: number; contrast: number }> {
  return await tip.evaluate((node) => {
    const style = getComputedStyle(node);
    const context = document.createElement('canvas').getContext('2d');
    const channels = (value: string): number[] => {
      if (context === null) return [0, 0, 0, 0];
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (rgba: readonly number[]): number => {
      const channel = (value: number): number => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(rgba[0] ?? 0) + 0.7152 * channel(rgba[1] ?? 0) + 0.0722 * channel(rgba[2] ?? 0);
    };
    const background = channels(style.backgroundColor);
    const text = channels(style.color);
    const lighter = Math.max(luminance(background), luminance(text));
    const darker = Math.min(luminance(background), luminance(text));
    return {
      opacity: Number(style.opacity),
      alpha: (background[3] ?? 0) / 255,
      contrast: (lighter + 0.05) / (darker + 0.05),
    };
  });
}

/** Pointer and focus away from every trigger, so the tips close between two checks. */
async function hideTips(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

test.describe('tooltips', () => {
  test('carry the tool words, open on hover and focus, and stay inside the viewport in light, dark and phone width', async ({
    page,
  }) => {
    await openFixture(page);

    /** The chip's own geometry and paint: inside the viewport, opaque, legible. */
    const assertChip = async (label: string): Promise<void> => {
      const tip = chip(page, label);
      // One chip carries these words: a second one is a defect, not an ambiguity.
      await expect(tip).toHaveCount(1);
      await expect(tip).toBeVisible();
      await expect(tip).toHaveText(label);
      const box = await tip.boundingBox();
      const viewport = page.viewportSize();
      if (box === null || viewport === null) throw new Error('the tooltip rendered no box');
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      // The paint, not the source: an opaque chip whose text contrasts with it. The
      // entrance is a fade, so the settled opacity is what is measured.
      await expect.poll(async () => (await tipPaint(tip)).opacity).toBeGreaterThan(0.95);
      const paint = await tipPaint(tip);
      expect(paint.alpha).toBeGreaterThan(0.95);
      expect(paint.contrast).toBeGreaterThan(4.5);
      // The next check starts from nothing open: a tip that outlives its trigger is the
      // failure this catches, and a stale chip must not answer the next hover.
      await hideTips(page);
      await expect(tip).toBeHidden();
    };

    // Hover, at the rail's own edge: the chip names the tool the pointer is over.
    await rail(page, RAIL.note).hover();
    await assertChip(RAIL.note);

    // Keyboard focus opens it without a pointer at all. Focus arrives from the button
    // beside it on the keyboard's own route — a scripted `focus()` is not what the
    // browser treats as keyboard navigation, and the tip is the keyboard case.
    await rail(page, RAIL.hand).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(rail(page, RAIL.select)).toBeFocused();
    await assertChip(RAIL.select);

    // The page and view controls sit in the status bar at the bottom edge; their tips have to
    // flip or shift rather than run off it.
    await page.getByRole('button', { name: 'Zoom In (+)', exact: true }).hover();
    await assertChip('Zoom In (+)');

    // Dark mode: the same chip, still opaque and legible.
    await useDarkTheme(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mode)).toBe('dark');
    await rail(page, RAIL.ink).hover();
    await assertChip(RAIL.ink);

    // Phone width: the rail is a scrollable column at the left edge and the tips still
    // stay inside the viewport.
    await page.setViewportSize({ width: 390, height: 780 });
    await rail(page, RAIL.shapes).hover();
    await assertChip(RAIL.shapes);
    await page
      .getByRole('group', { name: 'Page and view controls', exact: true })
      .getByRole('button', { name: 'Page Panel', exact: true })
      .hover();
    await assertChip('Page Panel');
  });
});
