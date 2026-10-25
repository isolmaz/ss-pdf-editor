import type { Page } from 'playwright/test';
import { CANVAS, notice, openApp, readDraftManifests, rotateCurrentPage } from './app-helpers';
import { fixturePdf } from './fixture-pdf';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';

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

  test('the start-up sweep keeps the blob only the other tab announces, and sweeps it once that tab is gone', async ({
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

    // Real orphans: stored sources no manifest, no open document and no peer references. One
    // sorts before the keeper's key and one after it, so the sweep has deleted both only once
    // it has walked past the keeper's blob. Without them a sweep that never ran and a sweep
    // that ran look the same from outside.
    const orphans = ['src-0orphan000000000000000.pdf', 'src-zorphan000000000000000.pdf'];
    await sweeper.evaluate(async (names) => {
      const root = await navigator.storage.getDirectory();
      const app = await root.getDirectoryHandle('pdf-editor');
      const sources = await app.getDirectoryHandle('sources', { create: true });
      for (const name of names) {
        const handle = await sources.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(new Uint8Array([37, 80, 68, 70]));
        await writable.close();
      }
    }, orphans);
    for (const orphan of orphans) expect((await readVault(sweeper)).sources).toContain(orphan);

    // Nothing is clicked: the sweep runs when a window starts, after its drafts are back.
    await sweeper.goto('/editor/');
    await expect
      .poll(async () => (await readVault(sweeper)).sources.some((key) => orphans.includes(key)), {
        timeout: 30_000,
      })
      .toBe(false);
    const after = await readVault(sweeper);
    // The keeper never rewrote its manifest, so the peer announcement is what protected it ...
    expect(after.drafts).not.toContain(keeperManifests[0]);
    // ... while the blob only the keeper's announcement protects is still there: losing it
    // is the failure this test exists to catch.
    for (const key of keeperKeys) expect(after.sources, key).toContain(key);

    // Once the keeper is gone, a window that starts has nothing protecting the blob: its
    // sweep removes it.
    await keeper.close();
    await liveWindows(sweeper, 1);
    const third = await context.newPage();
    await openFixture(third, 'third.pdf');
    await settle(third, 2);
    await expect
      .poll(async () => (await readVault(third)).sources.some((key) => keeperKeys.includes(key)), {
        timeout: 30_000,
      })
      .toBe(false);
    // The two windows still open keep the blob they share.
    expect((await readVault(third)).sources.filter((key) => key.startsWith('src-')).length).toBe(1);

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

  test('a second window does not restore the draft the first one is editing, and the first one still can after it closes', async ({
    context,
  }) => {
    const first = await context.newPage();
    await openApp(first, 'owned.pdf', labelledPdf('Owned', 2), { advanced: false });
    await rotateCurrentPage(first);
    // The debounced save has written the manifest that records the rotation.
    await expect
      .poll(async () => {
        const vault = await readVault(first);
        return vault.drafts.filter((name) => name.endsWith('.json')).length;
      })
      .toBe(1);
    const manifestText = async (page: Page): Promise<string> => (await readDraftManifests(page))[0] ?? '';
    await expect.poll(async () => (await manifestText(first)).includes('"dirty":true')).toBe(true);
    const before = await manifestText(first);

    // The first window holds the draft's lock while its tab is open.
    const second = await context.newPage();
    await second.goto('/editor/');
    await expect
      .poll(() =>
        second.evaluate(async () =>
          ((await navigator.locks.query()).held ?? []).some((lock) =>
            lock.name?.startsWith('pdf-editor.vault.draft.'),
          ),
        ),
      )
      .toBe(true);
    // Recovery asks again for a draft it was refused for about 1.25 s before it decides the
    // draft is another window's; `toHaveCount(0)` would pass at once, so wait that out first.
    await second.waitForTimeout(3_000);
    // The second window restored nothing — no notice, no tab of that document — and wrote
    // nothing over the first one's manifest.
    await expect(notice(second, 'draft(s) restored')).toHaveCount(0);
    await expect(second.getByRole('button', { name: 'Back to document (owned.pdf)' })).toHaveCount(0);
    expect(await manifestText(second)).toBe(before);

    // Once the first window is gone, the next start restores it.
    await first.close();
    await second.close();
    // A window that just closed can still hold its locks for a moment: recovery asks again.
    const third = await context.newPage();
    await third.goto('/editor/');
    await expect(notice(third, 'draft(s) restored')).toBeVisible({ timeout: 30_000 });
    // The restored document is on screen, not behind the start screen.
    await expect(third.locator(CANVAS).first()).toBeVisible();
    await expect(third.getByRole('button', { name: 'Back to document (owned.pdf)' })).toHaveCount(0);
    await third.close();
  });
});
