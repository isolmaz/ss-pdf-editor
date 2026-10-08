/**
 * The registry the layout writers share: what it numbers, and that the numbers never repeat.
 */

import { describe, expect, it } from 'vitest';
import { DocxRegistry } from './layout-scene';

describe('DocxRegistry', () => {
  it('numbers media from 1 with the extension given, and the relationship id `imageRelId` names', () => {
    const registry = new DocxRegistry();
    const a = new Uint8Array([1]);
    const b = new Uint8Array([2]);
    const c = new Uint8Array([3]);
    expect(registry.addMedia(a, 'png')).toBe('rIdImage1');
    expect(registry.addMedia(b, 'jpeg')).toBe('rIdImage2');
    expect(registry.addMedia(c, 'png')).toBe('rIdImage3');
    expect(registry.media.map((m) => [m.name, m.rid, m.data])).toEqual([
      ['image1.png', 'rIdImage1', a],
      ['image2.jpeg', 'rIdImage2', b],
      ['image3.png', 'rIdImage3', c],
    ]);
  });

  it('gives one relationship per distinct link and the same id back for a repeat', () => {
    const registry = new DocxRegistry();
    const first = registry.addLink('https://a.example/');
    const second = registry.addLink('mailto:x@y.example');
    expect(first).not.toBe(second);
    expect(registry.addLink('https://a.example/')).toBe(first);
    expect(registry.addLink('mailto:x@y.example')).toBe(second);
    expect(registry.links).toEqual([
      { rid: first, uri: 'https://a.example/' },
      { rid: second, uri: 'mailto:x@y.example' },
    ]);
    // Link ids and media ids live apart: a link never takes a picture's id.
    expect(registry.addMedia(new Uint8Array(), 'png')).not.toBe(first);
  });

  it('counts drawing ids and stacking positions up, each independent of the other and of media', () => {
    const registry = new DocxRegistry();
    const ids = [registry.nextDrawingId(), registry.nextDrawingId(), registry.nextDrawingId()];
    expect(ids).toEqual([1, 2, 3]);
    const zs = [registry.nextZ(), registry.nextZ(), registry.nextZ()];
    expect(zs[0]).toBeGreaterThan(0);
    expect(zs[1]).toBeGreaterThan(zs[0] as number);
    expect(zs[2]).toBeGreaterThan(zs[1] as number);
    expect(registry.nextDrawingId()).toBe(4);
    expect(new DocxRegistry().nextDrawingId()).toBe(1);
  });
});
