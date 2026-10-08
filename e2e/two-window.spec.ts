import type { Page } from 'playwright/test';
import { fixturePdf } from './fixture-pdf';
import { useAdvancedMode } from './settings';
import { expect, test } from './test';

/**
 * Two windows on one vault.
 *
 * **Boundary:** these are two real tabs in one browser context, so they share the origin's
 * OPFS, its `BroadcastChannel` and its `navigator.locks` — the mechanisms
 * `apps/web/src/vault-channel.ts` coordinates with. Nothing is stubbed: a bug in the
 * channel, the lock or the reference graph shows up here.
 *
 * A second, isolated context is deliberately **not** used: it would get its own OPFS and
 * prove nothing about coordination.
 */

/** The vault as the page sees it: the manifest names and the blob keys actually stored. */
async function readVault(page: Page): Promise<{ drafts: string[]; sources: string[] }> {
  return await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('pdf-editor');
    const list = async (name: string): Promise<string[]> => {
      const names: string[] = [];
      try {
        const dir = await app.getDirectoryHandle(name);
        for await (const [entry] of (
          dir as unknown as { entries(): AsyncIterable<[string, unknown]> }
        ).entries()) {
          names.push(entry);
        }
      } catch {
        return [];
      }
      return names.sort();
    };
    return { drafts: await list('drafts'), sources: await list('sources') };
  });
}

/**
 * The fixture with its fill colour swapped for another of the same length: still a valid
 * PDF (the cross-reference offsets do not move) with different bytes, hence a different
 * content-addressed source key.
 */
function variantPdf(): Uint8Array {
  const source = Buffer.from(fixturePdf()).toString('latin1');
  expect(source).toContain('0.1 0.2 0.9 rg');
  return Uint8Array.from(Buffer.from(source.replace('0.1 0.2 0.9 rg', '0.9 0.2 0.1 rg'), 'latin1'));
}

/** Open the fixture through the home screen's file input and wait for the canvas. */
async function openFixture(page: Page, name: string, bytes: Uint8Array = fixturePdf()): Promise<void> {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator('.pdfViewer .page canvas').first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Wait until the debounced autosave has put `manifests` manifests and a source blob in the
 * vault — the state itself, not a fixed sleep.
 */
async function settle(page: Page, manifests: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const vault = await readVault(page);
        return (
          vault.drafts.filter((name) => name.endsWith('.json')).length >= manifests &&
          vault.sources.some((key) => key.startsWith('src-'))
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

/**
 * Wait until the lock manager, seen from `page`, lists `count` editor windows. A closed tab's
 * window lock can outlive `page.close()` for a while on a loaded machine; until it goes, a
 * probe rightly counts the tab as a live window that does not answer.
 */
async function liveWindows(page: Page, count: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const snapshot = await navigator.locks.query();
          return (snapshot.held ?? []).filter((lock) => lock.name?.startsWith('pdf-editor.vault.window.'))
            .length;
        }),
      { timeout: 60_000 },
    )
    .toBe(count);
}

/** Run a palette command by name, leaving the simple mode first when it is hidden. */
async function runCommand(page: Page, label: string): Promise<void> {
  // The default mode is simple, and the vault commands are advanced-only. Switching
  // through the settings is the real user path, not a back door.
  await useAdvancedMode(page);
  await page.keyboard.press('Control+k');
  // The palette's own combobox only: "the first text input" is another control (the page
  // field), which silently swallowed the query and ran no command at all.
  await page.getByRole('combobox').fill(label);
  await page.getByRole('option', { name: label, exact: true }).click();
  await expect(page.getByRole('combobox')).toBeHidden();
}

test.describe('two windows on one vault', () => {
  test('two tabs that open the same document share one source blob', async ({ context }) => {
    const first = await context.newPage();
    await openFixture(first, 'shared.pdf');
    await settle(first, 1);
    const firstVault = await readVault(first);

    const second = await context.newPage();
    await openFixture(second, 'shared.pdf');
    await settle(second, 2);
    const secondVault = await readVault(second);

    // Both tabs see the same vault — that is what makes coordination necessary at all.
    // Each tab owns its own manifest (the tab id is the document id), so the second tab's
    // listing is a superset: the first tab's manifest must still be there.
    // The loop is vacuous over an empty list, so the first tab must really have a manifest.
    expect(firstVault.drafts.filter((name) => name.endsWith('.json')).length).toBeGreaterThan(0);
    for (const name of firstVault.drafts) expect(secondVault.drafts, name).toContain(name);

    // Content addressing: the same bytes opened twice must not double the storage. The key
    // is derived from the file's SHA-256 (`sourceKeyFor`), so two tabs on one file write
    // the same blob, not two.
    const sources = secondVault.sources.filter((key) => key.startsWith('src-'));
    expect(sources.length).toBe(1);

    await first.close();
    await second.close();
  });

  test('a sweep in one tab keeps the blob only the other tab announces, and sweeps it once that tab is gone', async ({
    context,
  }) => {
    // The keeper opens a document the sweeper never opens: the two tabs hold different
    // content-addressed keys, so a blob protected by the sweeper's own open document cannot
    // hide a sweep that ignores the peer.
    const keeper = await context.newPage();
    await openFixture(keeper, 'keeper.pdf', variantPdf());
    await settle(keeper, 1);
    const before = await readVault(keeper);
    const keeperKeys = before.sources.filter((key) => key.startsWith('src-'));
    expect(keeperKeys.length).toBe(1);
    const keeperManifests = before.drafts.filter((name) => name.endsWith('.json'));
    expect(keeperManifests.length).toBe(1);

    const sweeper = await context.newPage();
    await openFixture(sweeper, 'sweeper.pdf');
    await settle(sweeper, 2);
    expect((await readVault(sweeper)).sources.filter((key) => key.startsWith('src-')).length).toBe(2);

    // The keeper's manifest leaves the vault, so the only thing that still says the keeper
    // holds its blob is the keeper's own announcement to the other windows. Without this
    // the manifest protects the blob and a sweep that ignores its peers passes too.
    await sweeper.evaluate(async (name) => {
      const root = await navigator.storage.getDirectory();
      const app = await root.getDirectoryHandle('pdf-editor');
      const drafts = await app.getDirectoryHandle('drafts');
      await drafts.removeEntry(name);
    }, keeperManifests[0] as string);
    expect((await readVault(sweeper)).drafts).not.toContain(keeperManifests[0]);

    // A real orphan: a stored source no manifest, no open document and no peer references.
    // Without it a sweep that never ran and a sweep that ran look the same from outside.
    const orphan = 'src-orphan0000000000000000.pdf';
    await sweeper.evaluate(async (name) => {
      const root = await navigator.storage.getDirectory();
      const app = await root.getDirectoryHandle('pdf-editor');
      const sources = await app.getDirectoryHandle('sources', { create: true });
      const handle = await sources.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(new Uint8Array([37, 80, 68, 70]));
      await writable.close();
    }, orphan);
    expect((await readVault(sweeper)).sources).toContain(orphan);

    await runCommand(sweeper, 'Clean Up Orphaned Vault Copies');

    // The sweep ran and removed exactly the orphan (the notice counts it) ...
    await expect(
      sweeper.locator('[role="status"]').filter({ hasText: '1 record(s) no other document references' }),
    ).toBeVisible({ timeout: 30_000 });
    const after = await readVault(sweeper);
    expect(after.sources).not.toContain(orphan);
    // The keeper never rewrote its manifest, so the peer announcement is what protected it ...
    expect(after.drafts).not.toContain(keeperManifests[0]);
    // ... while the blob only the keeper's announcement protects is still there: losing it
    // is the failure this test exists to catch.
    for (const key of keeperKeys) expect(after.sources, key).toContain(key);

    // Once the keeper is gone, a window that never heard its announcement has nothing
    // protecting the blob: the next sweep removes it and says so.
    await keeper.close();
    await liveWindows(sweeper, 1);
    const third = await context.newPage();
    await openFixture(third, 'third.pdf');
    await settle(third, 2);
    await runCommand(third, 'Clean Up Orphaned Vault Copies');
    await expect(
      third.locator('[role="status"]').filter({ hasText: '1 record(s) no other document references' }),
    ).toBeVisible({ timeout: 30_000 });
    const last = await readVault(third);
    for (const key of keeperKeys) expect(last.sources, key).not.toContain(key);
    // The two windows still open keep the blob they share.
    expect(last.sources.filter((key) => key.startsWith('src-')).length).toBe(1);

    await sweeper.close();
    await third.close();
  });

  test('two tabs writing at once do not lose either manifest', async ({ context }) => {
    const first = await context.newPage();
    await openFixture(first, 'concurrent-a.pdf');
    const second = await context.newPage();
    await openFixture(second, 'concurrent-b.pdf');

    // Both tabs persist through their own debounced writer. The cross-window lock is what
    // keeps the two writes from interleaving inside one vault directory.
    await settle(first, 1);
    await settle(second, 2);

    const vault = await readVault(second);
    // Two documents, two manifests: neither tab's write removed the other's.
    expect(vault.drafts.length).toBeGreaterThanOrEqual(2);
    expect(vault.drafts.filter((name) => name.endsWith('.json')).length).toBeGreaterThanOrEqual(2);

    await first.close();
    await second.close();
  });
});
