/**
 * The tags view of the accessibility panel: the structure tree of a tagged file as an
 * outline the user selects, folds, reorders (toolbar, keys, drag and drop), retypes and
 * describes, the draft that collects those changes, and the file one **Apply** writes. Every
 * applied edit is checked on the produced bytes, read back with MuPDF's object model; the
 * refusals are checked on the notice the user reads.
 */

import { notice } from './app-helpers';
import { expect, test } from './test';
import { exportBytes, openPdf } from './ui-helpers';
import {
  bigFixture,
  draftCount,
  flatten,
  openTagsView,
  readTags,
  rowOf,
  signature,
  taggedFixture,
  treeRows,
  untaggedFixture,
  viewingOnlyFixture,
} from './ui-tags-helpers';

/** A class list holding one of the `|`-separated utility classes as a whole token, not as the tail of a variant. */
const token = (names: string): RegExp => new RegExp(`(^|\\s)(${names})(\\s|$)`);

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const SECT_B = 'Sect(Figure(#3),Figure(#4),Table(TR(TH(#5),TH(#6)),TR(TD(#7),TD(#8))))';
const TAIL = 'Sect(P(#0)),Custom(#9),Weird,P(#10),P(#11)';

test('the tree opens on the page in view, widens to the whole document and follows a click to another page', async ({
  page,
}) => {
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await openTagsView(page);
  const scope = page.getByLabel('Show');
  await expect(scope).toHaveValue('page');
  await expect(scope.locator('option[value="page"]')).toHaveText('Page 1');
  // The page's own elements only: the Sect that holds page two's paragraph is not listed.
  await expect(rowOf(page, 'P', 'Page two text')).toHaveCount(0);
  await expect(treeRows(page).first()).toHaveAttribute('data-tag-role', 'Document');
  await expect(page.getByText('Select an element to change its type', { exact: false })).toBeVisible();

  await scope.selectOption('all');
  const pageTwo = rowOf(page, 'P', 'Page two text');
  await expect(pageTwo).toBeVisible();
  await expect(pageTwo).toHaveAttribute('aria-selected', 'false');

  // Clicking an element of page two selects it and takes the viewer to that page.
  await pageTwo.click();
  await expect(pageTwo).toHaveAttribute('aria-selected', 'true');
  await expect(scope.locator('option[value="page"]')).toHaveText('Page 2');
  await expect(page.getByRole('textbox', { name: 'Page number' })).toHaveValue('2');
});

test('rows fold and unfold from their caret and from the arrow keys, and carry their level and state', async ({
  page,
}) => {
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await openTagsView(page);
  await expect(treeRows(page).first()).toHaveAttribute('aria-level', '1');
  const table = rowOf(page, 'Table');
  await expect(table).toHaveAttribute('aria-level', '3');
  await expect(table).toHaveAttribute('aria-expanded', 'true');
  await expect(rowOf(page, 'TH', 'Quarter')).toBeVisible();

  // The caret folds the table: its rows leave the outline.
  await table.getByRole('button', { name: 'Collapse' }).click();
  await expect(table).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-tag-role="TR"]')).toHaveCount(0);
  await table.getByRole('button', { name: 'Expand' }).click();
  await expect(table).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-tag-role="TR"]')).toHaveCount(2);

  // The keys do the same on the selected row: Left folds, Right unfolds, Down and Up move.
  await table.click();
  await table.press('ArrowLeft');
  await expect(table).toHaveAttribute('aria-expanded', 'false');
  await table.press('ArrowRight');
  await expect(table).toHaveAttribute('aria-expanded', 'true');
  await table.press('ArrowDown');
  const firstRow = page.locator('[data-tag-role="TR"]').first();
  await expect(firstRow).toHaveAttribute('aria-selected', 'true');
  await expect(table).toHaveAttribute('aria-selected', 'false');
  await firstRow.press('ArrowUp');
  await expect(table).toHaveAttribute('aria-selected', 'true');
  // A leaf cannot be folded, and Up from the first row stays there.
  const heading = rowOf(page, 'H1');
  await heading.click();
  await heading.press('ArrowLeft');
  await expect(heading).not.toHaveAttribute('aria-expanded', /.*/);
  await treeRows(page).first().click();
  await treeRows(page).first().press('ArrowUp');
  await expect(treeRows(page).first()).toHaveAttribute('aria-selected', 'true');
  // Enter and Space select a focused row without a click.
  await rowOf(page, 'P', 'First paragraph').focus();
  await page.keyboard.press('Enter');
  await expect(rowOf(page, 'P', 'First paragraph')).toHaveAttribute('aria-selected', 'true');
  await rowOf(page, 'P', 'Second paragraph').focus();
  await page.keyboard.press('Space');
  await expect(rowOf(page, 'P', 'Second paragraph')).toHaveAttribute('aria-selected', 'true');
  await expect(rowOf(page, 'P', 'First paragraph')).toHaveAttribute('aria-selected', 'false');
});

test('Ctrl and Shift select several siblings, and the type of the selection is named', async ({ page }) => {
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await openTagsView(page);
  await rowOf(page, 'H1').click();
  await rowOf(page, 'P', 'Second paragraph').click({ modifiers: ['Shift'] });
  // The range is the siblings between: H1, both paragraphs.
  await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(3);
  await expect(page.getByText('3 elements selected.')).toBeVisible();
  // Ctrl toggles one out and back in.
  await rowOf(page, 'P', 'First paragraph').click({ modifiers: ['Control'] });
  await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(2);
  await rowOf(page, 'P', 'First paragraph').click({ modifiers: ['Control'] });
  await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(3);
  // A Shift range across parents keeps only the rows that share the clicked row's parent: the two figures.
  await rowOf(page, 'H1').click();
  await rowOf(page, 'Figure', 'Company logo').click({ modifiers: ['Shift'] });
  await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(2);
  await expect(rowOf(page, 'Figure', 'no alt')).toHaveAttribute('aria-selected', 'true');
  await expect(rowOf(page, 'Figure', 'Company logo')).toHaveAttribute('aria-selected', 'true');
  await expect(rowOf(page, 'H1')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByText('2 elements selected.')).toBeVisible();
});

test('Up, Down, Indent and Outdent collect into a draft that Apply writes, and Undo and Discard take it back', async ({
  page,
}) => {
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await openTagsView(page);
  const up = page.getByTestId('tags-up');
  const down = page.getByTestId('tags-down');
  const indent = page.getByTestId('tags-indent');
  const outdent = page.getByTestId('tags-outdent');
  const apply = page.locator('[data-tags-apply]');
  await expect(apply).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Discard', exact: true })).toBeDisabled();
  await expect(page.getByText('No changes yet.')).toBeVisible();
  // Nothing selected: no toolbar button is live.
  for (const button of [up, down, indent, outdent]) await expect(button).toBeDisabled();

  // The first child has no sibling above it; the last has none below it.
  await rowOf(page, 'H1').click();
  await expect(up).toBeDisabled();
  await expect(down).toBeEnabled();
  await expect(indent).toBeDisabled();
  await expect(outdent).toBeEnabled();
  // The root element cannot leave or move.
  await treeRows(page).first().click();
  await expect(outdent).toBeDisabled();
  await expect(up).toBeDisabled();
  await expect(down).toBeDisabled();

  // 1. The second paragraph moves above the first.
  await rowOf(page, 'P', 'Second paragraph').click();
  await up.click();
  await expect(page.getByText('1 change(s) not yet applied.')).toBeVisible();
  expect(
    await page.locator('[data-tag-role="P"]').evaluateAll((rows) => rows.map((row) => row.textContent)),
  ).toEqual(expect.arrayContaining([expect.stringContaining('Second paragraph')]));
  const order = await page
    .locator('[data-tag-role="H1"], [data-tag-role="P"]')
    .evaluateAll((rows) => rows.map((row) => row.textContent?.replace(/^\d+/, '')));
  expect(order.slice(0, 3)).toEqual(['H1Annual report', 'PSecond paragraph', 'PFirst paragraph']);
  // Down from there puts it back; Undo removes that step and the paragraph is above again.
  await down.click();
  await expect(page.getByText('2 change(s) not yet applied.')).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('1 change(s) not yet applied.')).toBeVisible();
  expect(await draftCount(page)).toBe(1);

  // 2. The second Sect moves into the first one, as its last element.
  await page.locator('[data-tag-role="Sect"]').nth(1).click();
  await indent.click();
  await expect(page.getByText('2 change(s) not yet applied.')).toBeVisible();
  // 3. The heading leaves the first Sect for the Document, right after it.
  await rowOf(page, 'H1').click();
  await outdent.click();
  await expect(page.getByText('3 change(s) not yet applied.')).toBeVisible();

  // Discard drops all three; the panel is back at the file as it is.
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByText('No changes yet.')).toBeVisible();
  await expect(apply).toBeDisabled();

  // Do them again and apply.
  await rowOf(page, 'P', 'Second paragraph').click();
  await up.click();
  await page.locator('[data-tag-role="Sect"]').nth(1).click();
  await indent.click();
  await rowOf(page, 'H1').click();
  await outdent.click();
  await expect(page.getByText('3 change(s) not yet applied.')).toBeVisible();
  await apply.click();

  // The shell took the produced file in: the panel is re-mounted on it with an empty draft.
  await expect(notice(page, /Accessibility tagging applied to document/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('No changes yet.')).toBeVisible();
  const produced = await readTags(await exportBytes(page, 'moved.pdf'));
  expect(signature(produced.root)).toBe(`Document(Sect(P(#2),P(#1),${SECT_B}),H1(#0),${TAIL})`);
});

test('dragging a row drops it before, into or after another, and the produced file has that order', async ({
  page,
}) => {
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await openTagsView(page);
  const dropAt = async (
    from: string,
    label: string | undefined,
    onto: string,
    ontoLabel: string | undefined,
    zone: 'before' | 'into' | 'after',
  ) => {
    const source = rowOf(page, from, label);
    const target = rowOf(page, onto, ontoLabel);
    const box = await target.boundingBox();
    if (box === null) throw new Error('the target row is not laid out');
    const y = zone === 'before' ? 2 : zone === 'after' ? box.height - 2 : box.height / 2;
    await source.dragTo(target, { targetPosition: { x: 40, y } });
  };

  // `into`: the heading becomes the last element of the second Sect.
  await dropAt('H1', undefined, 'Table', undefined, 'into');
  await expect(page.getByText('1 change(s) not yet applied.')).toBeVisible();
  // `before`: the first paragraph is placed above the Document's second Sect (the one with the figures).
  await dropAt('P', 'First paragraph', 'Figure', 'no alt', 'before');
  await expect(page.getByText('2 change(s) not yet applied.')).toBeVisible();
  // `after`: the last paragraph of Sect A goes below the Custom element.
  await dropAt('P', 'Second paragraph', 'Custom', undefined, 'after');
  await expect(page.getByText('3 change(s) not yet applied.')).toBeVisible();

  await page.locator('[data-tags-apply]').click();
  await expect(notice(page, /Accessibility tagging applied to document/)).toBeVisible({ timeout: 60_000 });
  const produced = await readTags(await exportBytes(page, 'dragged.pdf'));
  expect(signature(produced.root)).toBe(
    'Document(Sect,Sect(P(#1),Figure(#3),Figure(#4),Table(TR(TH(#5),TH(#6)),TR(TD(#7),TD(#8)),H1(#0))),Sect(P(#0)),Custom(#9),P(#2),Weird,P(#10),P(#11))',
  );
});

test('retype, describe, set a scope, mark as artifact and apply: the file carries each change', async ({
  page,
}) => {
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await openTagsView(page);
  const roleSelect = page.locator('[data-tags-role-select]');
  const altInput = page.locator('[data-tags-alt]');
  const setAlt = page.getByRole('button', { name: 'Set', exact: true });

  // Retype: the paragraph becomes a level-2 heading.
  await rowOf(page, 'P', 'First paragraph').click();
  await expect(roleSelect).toHaveValue('P');
  await roleSelect.selectOption('H2');
  await expect(rowOf(page, 'H2', 'First paragraph')).toBeVisible();
  await expect(page.getByText('1 change(s) not yet applied.')).toBeVisible();
  // A paragraph has no description to give.
  await expect(altInput).toHaveCount(0);

  // A role the RoleMap does not map shows as such: its own name is listed but cannot be chosen.
  await rowOf(page, 'Weird').click();
  await expect(roleSelect.locator('option[value="Weird"]')).toHaveAttribute('disabled', '');
  await roleSelect.selectOption('Div');
  await expect(rowOf(page, 'Div')).toBeVisible();
  await expect(rowOf(page, 'Weird')).toHaveCount(0);

  // A figure without a description is flagged until the draft gives it one.
  const bare = rowOf(page, 'Figure', 'no alt');
  await bare.click();
  await expect(altInput).toHaveValue('');
  await expect(setAlt).toBeDisabled();
  await altInput.fill('   ');
  await expect(setAlt).toBeDisabled();
  await altInput.fill('A bar chart');
  await expect(setAlt).toBeEnabled();
  await setAlt.click();
  await expect(rowOf(page, 'Figure', 'A bar chart')).toBeVisible();
  await expect(page.getByText('no alt', { exact: true })).toHaveCount(0);
  await expect(altInput).toHaveValue('A bar chart');
  await expect(setAlt).toBeDisabled();

  // A figure that has one shows it; setting the same text is not a change, other text is.
  await rowOf(page, 'Figure', 'Company logo').click();
  await expect(altInput).toHaveValue('Company logo');
  await expect(setAlt).toBeDisabled();
  await altInput.fill('Company logo  ');
  await expect(setAlt).toBeDisabled();
  await altInput.fill('Corporate logo');
  await setAlt.click();
  await expect(rowOf(page, 'Figure', 'Corporate logo')).toBeVisible();

  // Table header scope: a value, another value, and back to "not set".
  const scope = page.getByLabel('Scope', { exact: true });
  await expect(scope).toHaveCount(0);
  await rowOf(page, 'TH', 'Quarter').click();
  await expect(scope).toHaveValue('');
  await scope.selectOption('Column');
  await expect(scope).toHaveValue('Column');
  await rowOf(page, 'TH', 'Result').click();
  await scope.selectOption('Both');
  await expect(scope).toHaveValue('Both');
  await scope.selectOption('');
  await expect(scope).toHaveValue('');

  // An artifact leaves the reading order: its row goes.
  await rowOf(page, 'P', 'Second paragraph').click();
  await page.getByRole('button', { name: 'Mark as an artifact: it leaves the reading order' }).click();
  await expect(rowOf(page, 'P', 'Second paragraph')).toHaveCount(0);
  await expect(page.getByText('8 change(s) not yet applied.')).toBeVisible();

  await page.locator('[data-tags-apply]').click();
  await expect(notice(page, /Accessibility tagging applied to document/)).toBeVisible({ timeout: 60_000 });
  const produced = await readTags(await exportBytes(page, 'edited.pdf'));
  expect(signature(produced.root)).toBe(
    `Document(Sect(H1(#0),H2(#1)),${SECT_B},${TAIL.replace('Weird', 'Div')})`,
  );
  const elements = flatten(produced.root);
  expect(elements.filter((entry) => entry.role === 'Figure').map((entry) => entry.alt)).toEqual([
    'A bar chart',
    'Corporate logo',
  ]);
  expect(elements.filter((entry) => entry.role === 'TH').map((entry) => entry.scope)).toEqual([
    'Column',
    null,
  ]);
  // The artifact's marked content is now an artifact in the page itself, and the others are untouched.
  expect(produced.contents[0]).toContain('/Artifact BMC');
  expect(produced.contents[0]).not.toContain('/MCID 2>>');
  expect(produced.contents[0]).toContain('/MCID 1>>');
});

test('Group in, Make list and Dissolve restructure the tree and the file keeps the new elements', async ({
  page,
}) => {
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await openTagsView(page);
  const groupIn = page.getByRole('button', { name: 'Group in', exact: true });
  const groupRole = page.getByLabel('Type of the new group');

  // One element can be wrapped in a group of its own.
  await rowOf(page, 'Custom').click();
  await expect(groupRole).toHaveValue('Sect');
  await groupIn.click();
  await expect(page.getByText('1 change(s) not yet applied.')).toBeVisible();
  // The new Sect now holds it: the Custom row is one level deeper.
  await expect(rowOf(page, 'Custom')).toHaveAttribute('aria-level', '3');

  // Two paragraphs are grouped into a Div, then turned into a list.
  await rowOf(page, 'P', 'First paragraph').click();
  await rowOf(page, 'P', 'Second paragraph').click({ modifiers: ['Control'] });
  await expect(page.getByText('2 elements selected.')).toBeVisible();
  await groupRole.selectOption('Div');
  await groupIn.click();
  await expect(rowOf(page, 'Div')).toBeVisible();
  await page.locator('[data-tags-list]').click();
  await expect(page.getByText('7 change(s) not yet applied.')).toBeVisible();
  await expect(page.locator('[data-tag-role="L"]')).toHaveCount(1);
  await expect(page.locator('[data-tag-role="LI"]')).toHaveCount(2);
  await expect(page.locator('[data-tag-role="LBody"]')).toHaveCount(2);

  // The element that holds content cannot be dissolved; one that only holds elements can.
  const dissolve = page.getByRole('button', { name: 'Dissolve', exact: true });
  await rowOf(page, 'H1').click();
  await expect(dissolve).toBeDisabled();
  await page.locator('[data-tag-role="Sect"]').nth(1).click();
  await expect(dissolve).toBeEnabled();
  await dissolve.click();
  await expect(page.getByText('8 change(s) not yet applied.')).toBeVisible();
  await expect(page.locator('[data-tag-role="Sect"]')).toHaveCount(2);

  await page.locator('[data-tags-apply]').click();
  await expect(notice(page, /Accessibility tagging applied to document/)).toBeVisible({ timeout: 60_000 });
  const produced = await readTags(await exportBytes(page, 'grouped.pdf'));
  expect(signature(produced.root)).toBe(
    'Document(Sect(H1(#0),Div(L(LI(LBody(P(#1))),LI(LBody(P(#2)))))),Figure(#3),Figure(#4),Table(TR(TH(#5),TH(#6)),TR(TD(#7),TD(#8))),Sect(P(#0)),Sect(Custom(#9)),Weird,P(#10),P(#11))',
  );
});

test('a change the tree cannot take is refused with its reason and the draft stays as it was', async ({
  page,
}) => {
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await openTagsView(page);
  const none = page.getByText('No changes yet.');
  await expect(none).toBeVisible();

  // An element cannot be dropped into its own child.
  const sect = page.locator('[data-tag-role="Sect"]').first();
  const heading = rowOf(page, 'H1');
  await sect.dragTo(heading, { targetPosition: { x: 40, y: 10 } });
  await expect(notice(page, 'An element cannot be moved into itself.')).toBeVisible();
  await expect(none).toBeVisible();

  // Nothing goes above the document element.
  const document = treeRows(page).first();
  await sect.dragTo(document, { targetPosition: { x: 40, y: 2 } });
  await expect(notice(page, 'The document element cannot be moved, grouped or removed.')).toBeVisible();
  await expect(none).toBeVisible();

  // Elements with different parents cannot be grouped.
  await heading.click();
  await rowOf(page, 'Figure', 'no alt').click({ modifiers: ['Control'] });
  await expect(page.getByText('2 elements selected.')).toBeVisible();
  await page.getByRole('button', { name: 'Group in', exact: true }).click();
  await expect(notice(page, 'Only elements with the same parent can be grouped.')).toBeVisible();
  await expect(none).toBeVisible();

  // A paragraph that holds a link cannot become an artifact: the link would lose its place.
  await rowOf(page, 'P', 'Linked text').click();
  await page.getByRole('button', { name: 'Mark as an artifact: it leaves the reading order' }).click();
  await expect(
    notice(page, 'That element holds a link, a field or an annotation and cannot become an artifact.'),
  ).toBeVisible();
  await expect(none).toBeVisible();
  await expect(rowOf(page, 'P', 'Linked text')).toBeVisible();
});

test('an element that is a direct object is listed but cannot be changed or dragged', async ({ page }) => {
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await openTagsView(page);
  const direct = rowOf(page, 'P', 'Direct text');
  await expect(direct).toHaveAttribute('draggable', 'false');
  await expect(rowOf(page, 'P', 'Linked text')).toHaveAttribute('draggable', 'true');
  await direct.click();
  await expect(page.locator('[data-tags-role-select]')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Mark as an artifact: it leaves the reading order' }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Group in', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Dissolve', exact: true })).toBeDisabled();
  await expect(page.getByTestId('tags-up')).toBeDisabled();
  await expect(page.getByTestId('tags-down')).toBeDisabled();
  await expect(page.getByTestId('tags-indent')).toBeDisabled();
  // Nothing can be dropped into it either: its /K cannot be rewritten. Before, the drop was
  // taken into the draft and Apply then failed with an unrelated "Select pages first.".
  await rowOf(page, 'H1').dragTo(direct, { targetPosition: { x: 40, y: 10 } });
  await expect(notice(page, 'That element cannot be changed here.')).toBeVisible();
  expect(await draftCount(page)).toBe(0);
});

test('a page whose content cannot be rewritten fails the Apply with a reason and keeps the draft; a change that needs no rewrite still goes through', async ({
  page,
}) => {
  // The first page's content ends in a stray `]`: it is drawn, but its marked content cannot be located safely.
  await openPdf(page, 'tagged.pdf', await taggedFixture({ strayDelimiter: true }));
  await openTagsView(page);
  // No text of the page can be placed, so its rows have no label and its page carries no boxes.
  await expect(rowOf(page, 'H1')).toHaveText(/^1H1$/);
  await expect(page.locator('[data-order-box][data-order-page="0"]')).toHaveCount(0);

  const apply = page.locator('[data-tags-apply]');
  await rowOf(page, 'H1').click();
  await page.getByRole('button', { name: 'Mark as an artifact: it leaves the reading order' }).click();
  await expect(rowOf(page, 'H1')).toHaveCount(0);
  await apply.click();
  await expect(notice(page, 'This feature is not available for this document.')).toBeVisible({
    timeout: 60_000,
  });
  // The panel names the failure, still holds the draft, and can be used again.
  await expect(
    page.locator('[data-tags-mode]').getByText('This feature is not available for this document.'),
  ).toBeVisible();
  await expect(page.getByText('1 change(s) not yet applied.')).toBeVisible();
  await expect(apply).toBeEnabled();

  // Taking the artifact back and retyping the heading instead needs no content rewrite.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await rowOf(page, 'H1').click();
  await page.locator('[data-tags-role-select]').selectOption('H3');
  await apply.click();
  await expect(notice(page, /Accessibility tagging applied to document/)).toBeVisible({ timeout: 60_000 });
  const produced = await readTags(await exportBytes(page, 'retyped.pdf'));
  expect(signature(produced.root)).toBe(`Document(Sect(H3(#0),P(#1),P(#2)),${SECT_B},${TAIL})`);
  // Nothing of the failed attempt reached the file: the stray delimiter and every sequence are still there.
  expect(produced.contents[0]).toContain('/MCID 0>>');
});

test('the numbered boxes on the page follow the draft, and a click on a box selects its element', async ({
  page,
}) => {
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await openTagsView(page);
  const boxes = page.locator('[data-order-box][data-order-page="0"]');
  await expect(boxes).toHaveCount(12);
  const numbers = await boxes.evaluateAll((items) =>
    items.map((item) => item.getAttribute('data-order-number')),
  );
  expect(numbers).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
  // Page two's one block is box 1 of that page.
  await expect(page.locator('[data-order-box][data-order-page="1"]')).toHaveCount(1);
  await expect(boxes.first()).toHaveAccessibleName('1: H1');

  // A click on box 3 selects the second paragraph's row; Ctrl adds the box before it.
  await boxes.nth(2).click();
  await expect(rowOf(page, 'P', 'Second paragraph')).toHaveAttribute('aria-selected', 'true');
  await expect(boxes.nth(2)).toHaveAttribute('aria-pressed', 'true');
  await boxes.nth(1).click({ modifiers: ['Control'] });
  await expect(rowOf(page, 'P', 'First paragraph')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('2 elements selected.')).toBeVisible();
  await boxes.nth(1).click({ modifiers: ['Control'] });
  await expect(rowOf(page, 'P', 'First paragraph')).toHaveAttribute('aria-selected', 'false');
  await expect(boxes.nth(1)).toHaveAttribute('aria-pressed', 'false');

  // Moving the second paragraph above the first renumbers the boxes: its box is now number 2.
  const secondKey = await rowOf(page, 'P', 'Second paragraph').getAttribute('data-tag-key');
  expect(secondKey).not.toBeNull();
  await page.getByTestId('tags-up').click();
  await expect(page.locator(`[data-order-box="${secondKey}"]`)).toHaveAttribute('data-order-number', '2');
  await expect(page.locator(`[data-order-box="${secondKey}"]`)).toHaveAccessibleName('2: P');
});

test('a big tree starts folded below its second level and is cut at 800 rows; the PDF/UA view opens an element inside a folded branch', async ({
  page,
}) => {
  await openPdf(page, 'big.pdf', await bigFixture());
  await openTagsView(page);
  const more = page.getByText(/more rows are hidden\. Narrow the view to one page\./);
  // On the page in view, the branch of the page-two figure (a Sect and its Div) is not listed: 820 rows, cut at 800.
  await expect(more).toHaveText('20 more rows are hidden. Narrow the view to one page.');
  await page.getByLabel('Show').selectOption('all');
  await expect(more).toHaveText('22 more rows are hidden. Narrow the view to one page.');
  await expect(treeRows(page)).toHaveCount(800);

  // Below the second level everything starts folded: the Divs show a closed caret and no paragraph under them.
  const firstDiv = page.locator('[data-tag-role="Div"]').first();
  await expect(firstDiv).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-tag-role="P"]')).toHaveCount(1);
  await firstDiv.getByRole('button', { name: 'Expand' }).click();
  await expect(page.locator('[data-tag-role="P"]')).toHaveCount(2);

  // The PDF/UA view lists the figure without a description; its "open" button shows it in the tree.
  await page.locator('[data-a11y-tab="ua"]').click();
  await expect(page.locator('[data-ua-rule="figure-alt"]')).toHaveAttribute('data-ua-state', 'fail', {
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Open this element in the Tags view' }).click();
  const figure = rowOf(page, 'Figure');
  await expect(figure).toBeVisible({ timeout: 60_000 });
  await expect(figure).toHaveAttribute('aria-selected', 'true');
  // Its folded parents were opened on the way, the whole document is shown and the viewer is on its page.
  await expect(page.locator('[data-tag-role="Div"]').nth(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Show')).toHaveValue('all');
  await expect(page.getByRole('textbox', { name: 'Page number' })).toHaveValue('2');
  await expect(page.locator('[data-order-box][data-order-page="1"]')).toHaveCount(1);
});

test.describe('a document opened for viewing only', () => {
  // The shell's phone-class tier opens a document of more than 300 pages for viewing only.
  test.use({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  });

  test('shows the tree and selects, but every editing control is off and nothing can be dragged', async ({
    page,
  }) => {
    await openPdf(page, 'long.pdf', await viewingOnlyFixture());
    await openTagsView(page);
    const heading = rowOf(page, 'H1');
    await expect(heading).toBeVisible();
    await expect(heading).toHaveAttribute('draggable', 'false');
    await heading.click();
    await expect(heading).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-tags-role-select]')).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Mark as an artifact: it leaves the reading order' }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Group in', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Type of the new group')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Dissolve', exact: true })).toBeDisabled();
    for (const id of ['tags-up', 'tags-down', 'tags-indent', 'tags-outdent']) {
      await expect(page.getByTestId(id)).toBeDisabled();
    }
    // The keys that move an element do nothing either.
    await heading.press('Alt+ArrowDown');
    await expect(page.getByText('No changes yet.')).toBeVisible();
    await expect(page.locator('[data-tags-apply]')).toBeDisabled();

    // A figure shows its description field, switched off; several selected elements cannot be grouped.
    await rowOf(page, 'Figure').click();
    await expect(page.locator('[data-tags-alt]')).toBeDisabled();
    await heading.click({ modifiers: ['Control'] });
    await expect(page.getByText('2 elements selected.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Group in', exact: true })).toBeDisabled();
    await expect(page.locator('[data-tags-list]')).toBeDisabled();

    // Something dragged over a row from outside the page gets no drop target.
    await rowOf(page, 'Figure').dispatchEvent('dragover');
    await expect(rowOf(page, 'Figure')).not.toHaveClass(token('ring-1|border-t-2|border-b-2'));
  });
});

test('a drag that carries no element, or the element itself, changes nothing; the row under a drag shows where it would land', async ({
  page,
}) => {
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await openTagsView(page);
  const target = rowOf(page, 'P', 'First paragraph');
  const box = await target.boundingBox();
  if (box === null) throw new Error('the row is not laid out');
  const at = (ratio: number) => ({ clientY: box.y + box.height * ratio });

  // The three zones of the row, as the highlight the user sees: above, inside, below.
  await target.dispatchEvent('dragover', at(0.1));
  await expect(target).toHaveClass(token('border-t-2'));
  await target.dispatchEvent('dragover', at(0.5));
  await expect(target).toHaveClass(token('ring-1'));
  await expect(target).not.toHaveClass(token('border-t-2'));
  await target.dispatchEvent('dragover', at(0.9));
  await expect(target).toHaveClass(token('border-b-2'));
  await target.dispatchEvent('dragleave');
  await expect(target).not.toHaveClass(token('border-b-2|ring-1|border-t-2'));

  // A drop of something that is no tree element (a file dragged in) is ignored.
  const empty = await page.evaluateHandle(() => new DataTransfer());
  await target.dispatchEvent('drop', { dataTransfer: empty });
  // So is a drop of an element on itself.
  const ownKey = await target.getAttribute('data-tag-key');
  if (ownKey === null) throw new Error('the row has no key');
  const own = await page.evaluateHandle((key) => {
    const transfer = new DataTransfer();
    transfer.setData('text/x-tag-key', key);
    return transfer;
  }, ownKey);
  await target.dispatchEvent('drop', { dataTransfer: own });
  await expect(page.getByText('No changes yet.')).toBeVisible();
});

test.describe('a file with no tags', () => {
  // The second page's content cannot be delimited: the engine says so on the console, and the panel says so too.
  test.use({ allowedErrors: [/syntax error|encountered syntax/] });

  test('lists the blocks in drawing order, takes a type, an order and a description, and tags the document', async ({
    page,
  }) => {
    await openPdf(page, 'untagged.pdf', await untaggedFixture());
    await openTagsView(page);
    await expect(page.locator('[data-tags-mode="untagged"]')).toBeVisible();
    await expect(page.getByText('This file has no tags.')).toBeVisible();
    await expect(page.getByText('Page 1 of 2')).toBeVisible();
    await expect(page.getByText('Language en is written when the file has none.')).toBeVisible();
    await expect(page.getByText(/Page 2 not tagged: content stream unreadable/)).toBeVisible();
    const items = page.locator('[data-plan-id]');
    await expect(items).toHaveCount(4);
    const texts = () =>
      items.evaluateAll((rows) => rows.map((row) => row.querySelector('button')?.textContent));
    expect(await texts()).toEqual(['Annual report', 'First body line', 'Second body line', '[image]']);
    await expect(page.locator('[data-order-box][data-order-page="0"]')).toHaveCount(4);

    // The first block becomes a heading; it is the first in the list so it cannot move up.
    const first = items.nth(0);
    await expect(first.getByTestId('plan-up')).toBeDisabled();
    await first.getByLabel('Type').selectOption('H1');
    await expect(first.getByLabel('Type')).toHaveValue('H1');
    // The last block moves up one place, and the second body line goes down again by drag.
    await expect(items.nth(3).getByTestId('plan-down')).toBeDisabled();
    await items.nth(3).getByTestId('plan-up').click();
    expect(await texts()).toEqual(['Annual report', 'First body line', '[image]', 'Second body line']);
    await items.nth(2).getByTestId('plan-down').click();
    expect(await texts()).toEqual(['Annual report', 'First body line', 'Second body line', '[image]']);
    // Drag the second body line above the first.
    await items.nth(2).locator('button[draggable]').dragTo(items.nth(1));
    expect(await texts()).toEqual(['Annual report', 'Second body line', 'First body line', '[image]']);
    // A block can be left out of the order as an artifact: it loses its number.
    await items.nth(2).getByLabel('Type').selectOption('Artifact');
    await expect(items.nth(2).locator('span').first()).toHaveText('–');
    await expect(page.locator('[data-order-box][data-order-page="0"]')).toHaveCount(3);

    // The picture takes a description.
    const picture = items.nth(3);
    await picture.getByPlaceholder('Alternative text').fill('A bar chart');
    await page.getByLabel('Mark drawn lines and backgrounds as artifacts').uncheck();

    await page.locator('[data-tags-apply]').click();
    await expect(notice(page, /Accessibility tagging applied to document/)).toBeVisible({ timeout: 60_000 });
    const produced = await readTags(await exportBytes(page, 'tagged.pdf'));
    // The interface's language: the document had none.
    expect(produced.lang).toBe('en');
    const roles = flatten(produced.root).map((entry) => entry.role);
    expect(roles).toEqual(['Document', 'H1', 'P', 'Figure']);
    expect(flatten(produced.root).find((entry) => entry.role === 'Figure')?.alt).toBe('A bar chart');
    expect(produced.contents[0]).toContain('/Artifact BMC');
  });
});
