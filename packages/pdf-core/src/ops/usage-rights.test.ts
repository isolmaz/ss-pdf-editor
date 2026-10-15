/**
 * `dropUsageRights` on its own, against hand-built catalogs: no catalog, no `/Perms`, a
 * `/Perms` that is not a dictionary, one that holds only a certification, and one that holds
 * usage rights (alone, or next to `/DocMDP`).
 */

import { describe, expect, it } from 'vitest';
import { handPdf } from './forms.fixtures';
import { dropUsageRights } from './usage-rights';
import { permsKeys, withPdf } from './xfa-form.fixtures';

const pages = '<</Type/Pages/Kids[]/Count 0>>';
const catalog = (perms: string) => `<</Type/Catalog/Pages 2 0 R${perms}>>`;
const sig = '<</Type/Sig/Filter/Adobe.PPKLite>>';

const drop = (bytes: Uint8Array) =>
  withPdf(bytes, (doc) => {
    const removed = dropUsageRights(doc);
    return { removed, bytes: new Uint8Array(doc.saveToBuffer('').asUint8Array()) };
  });

describe('dropUsageRights', () => {
  it('removes nothing from a file without a catalog, without /Perms or with a /Perms that is no dictionary', async () => {
    const noCatalog = handPdf({ 2: pages });
    expect((await drop(noCatalog)).removed).toBe(false);
    const noPerms = handPdf({ 1: catalog(''), 2: pages });
    expect((await drop(noPerms)).removed).toBe(false);
    const numberPerms = handPdf({ 1: catalog('/Perms 5'), 2: pages });
    const out = await drop(numberPerms);
    expect(out.removed).toBe(false);
    await withPdf(out.bytes, (doc) => {
      expect(doc.getTrailer().get('Root').get('Perms').asNumber()).toBe(5);
    });
  });

  it('leaves a /Perms that holds only the certification', async () => {
    const certified = handPdf({ 1: catalog('/Perms<</DocMDP 5 0 R>>'), 2: pages, 5: sig });
    const out = await drop(certified);
    expect(out.removed).toBe(false);
    expect(await permsKeys(out.bytes)).toEqual(['DocMDP']);
  });

  it('removes /UR3 and /UR and keeps /DocMDP', async () => {
    const extended = handPdf({
      1: catalog('/Perms<</UR3 5 0 R/UR 5 0 R/DocMDP 5 0 R>>'),
      2: pages,
      5: sig,
    });
    const out = await drop(extended);
    expect(out.removed).toBe(true);
    expect(await permsKeys(out.bytes)).toEqual(['DocMDP']);
  });

  it('removes /Perms itself when the usage rights were all it held', async () => {
    const onlyRights = handPdf({ 1: catalog('/Perms<</UR3 5 0 R>>'), 2: pages, 5: sig });
    const out = await drop(onlyRights);
    expect(out.removed).toBe(true);
    expect(await permsKeys(out.bytes)).toBeNull();
  });
});
