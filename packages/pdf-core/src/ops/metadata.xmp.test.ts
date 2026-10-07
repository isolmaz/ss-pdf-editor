/**
 * The XMP packet and the Info dictionary as other producers write them: entities, attribute
 * shorthand, default and renamed namespaces, comments, CDATA and truncated markup on the way in;
 * the merge that edits a packet in place (attribute, element, appended property, a self-closing
 * description, a namespace bound to something else) on the way out. Every file is written out
 * object by object, so the packet reaches the reader exactly as typed here.
 */

import { describe, expect, it, vi } from 'vitest';
import { handPdf } from './forms.fixtures';
import { type MetadataPatch, PRODUCER_LINE, readMetadata, writeMetadata } from './metadata';

const run = { signal: new AbortController().signal };

const NS_DC = 'http://purl.org/dc/elements/1.1/';
const NS_XMP = 'http://ns.adobe.com/xap/1.0/';
const NS_PDF = 'http://ns.adobe.com/pdf/1.3/';
const NS_RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/** A one-page file whose `/Metadata` is `packet` (ASCII) and whose trailer `/Info` is `info`. */
function file(options: { readonly packet?: string; readonly info?: string }): Uint8Array {
  const objects: Record<number, string> = {
    1: `<</Type/Catalog/Pages 2 0 R${options.packet === undefined ? '' : '/Metadata 5 0 R'}>>`,
    2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>',
  };
  if (options.packet !== undefined) {
    objects[5] = `<</Type/Metadata/Subtype/XML/Length ${options.packet.length}>>\nstream\n${options.packet}\nendstream`;
  }
  if (options.info !== undefined) objects[6] = options.info;
  const bytes = handPdf(objects);
  if (options.info === undefined) return bytes;
  // The trailer written by `handPdf` has no /Info: name object 6 there.
  return new TextEncoder().encode(
    new TextDecoder().decode(bytes).replace('/Root 1 0 R', '/Root 1 0 R/Info 6 0 R'),
  );
}

const description = (attributes: string, body = '') =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${NS_RDF}"><rdf:Description rdf:about="" xmlns:dc="${NS_DC}" xmlns:xmp="${NS_XMP}" xmlns:pdf="${NS_PDF}"${attributes}>${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

const patchOnly = (patch: Parameters<typeof writeMetadata>[1]['patch']) => ({
  patch,
  clean: false,
  cleanXmp: false,
});

describe('reading an XMP packet', () => {
  it('decodes named, decimal and hexadecimal entities and keeps what it cannot decode', async () => {
    const read = await readMetadata(
      file({
        packet: description(
          '',
          '<dc:title>a &amp; b &lt;&gt; &quot;q&quot; &apos; &#252; &#xFC; &#X41; &#99999999; &#xFFFFFFFFFFFFF; &nope; &</dc:title>',
        ),
      }),
    );
    expect(read.title).toBe('a & b <> "q" \' ü ü &#X41; &#99999999; &#xFFFFFFFFFFFFF; &nope; &');
  });

  it('reads the attribute shorthand with either quote, whatever the spacing', async () => {
    const read = await readMetadata(
      file({
        packet: description(
          ` dc:title = 'Short &amp; sweet' xmp:CreatorTool="Tool" pdf:Keywords="a; b" xmp:CreateDate="2024-01-02T03:04:05Z" xmp:ModifyDate="2024-02-03"`,
        ),
      }),
    );
    expect(read).toMatchObject({
      title: 'Short & sweet',
      creator: 'Tool',
      keywords: ['a', 'b'],
      creationDate: '2024-01-02T03:04:05Z',
      modificationDate: '2024-02-03',
    });
  });

  it('prefers the x-default alternative, else the first, and joins nothing from an empty list', async () => {
    const alt = (items: string) => `<dc:title><rdf:Alt>${items}</rdf:Alt></dc:title>`;
    const title = async (items: string) =>
      (await readMetadata(file({ packet: description('', alt(items)) }))).title;
    expect(
      await title('<rdf:li xml:lang="tr">Başlık</rdf:li><rdf:li xml:lang="x-default"> Default </rdf:li>'),
    ).toBe('Default');
    expect(await title('<rdf:li xml:lang="tr">Birinci</rdf:li><rdf:li>İkinci</rdf:li>')).toBe('Birinci');
    expect(await title('<rdf:li>Plain</rdf:li>')).toBe('Plain');
    // An alternative list with nothing in it is an empty title, not a missing one.
    expect(await title('')).toBe('');
  });

  it('matches properties by namespace, not prefix: renamed prefixes and default namespaces', async () => {
    const renamed = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${NS_RDF}"><rdf:Description rdf:about="" xmlns:d="${NS_DC}" xmlns:t="${NS_XMP}" d:subject="ignored"><d:title>Renamed</d:title><t:CreatorTool>Renamed tool</t:CreatorTool></rdf:Description></rdf:RDF></x:xmpmeta>`;
    expect(await readMetadata(file({ packet: renamed }))).toMatchObject({
      title: 'Renamed',
      creator: 'Renamed tool',
    });

    const defaulted = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${NS_RDF}"><rdf:Description rdf:about=""><CreatorTool xmlns="${NS_XMP}">Default ns tool</CreatorTool></rdf:Description></rdf:RDF></x:xmpmeta>`;
    expect((await readMetadata(file({ packet: defaulted }))).creator).toBe('Default ns tool');

    // A property of the right local name in another namespace is not ours.
    const foreign = description(
      '',
      '<other:title xmlns:other="urn:other">Foreign</other:title><other:CreatorTool xmlns:other="urn:other">x</other:CreatorTool>',
    );
    const read = await readMetadata(file({ packet: foreign }));
    expect([read.title, read.creator]).toEqual([undefined, undefined]);
    // An attribute under an undeclared prefix, and an empty element, read as nothing.
    const undeclared = description(' zz:title="no" xml:title="no" xml:lang="en"', '<dc:description/>');
    const none = await readMetadata(file({ packet: undeclared }));
    expect([none.title, none.subject]).toEqual([undefined, undefined]);
  });

  it('skips comments, processing instructions, doctypes and CDATA, and reads CDATA as text', async () => {
    const packet = description(
      '',
      '<!-- c --><?pi data?><!DOCTYPE x><dc:title>A<![CDATA[ <b> ]]>B<!-- unterminated... ',
    );
    expect((await readMetadata(file({ packet }))).title).toBe('A <b> B');
    const tail = description('', '<dc:title>T</dc:title><!-- never closed');
    expect((await readMetadata(file({ packet: tail }))).title).toBe('T');
  });

  it('survives truncated and malformed markup without throwing', async () => {
    for (const packet of [
      '',
      'no markup at all',
      '<?xpacket begin="" id="x"',
      '<!DOCTYPE broken',
      '<1 not an element>',
      '<a',
      '<a b',
      '<a b=',
      '<a b="open',
      '<a b=unquoted c="d">text',
      '<a "junk" b="1">text</a>',
      '<a "junk',
      `<rdf:Description xmlns:dc="${NS_DC}"><dc:title>cut`,
      `<rdf:Description xmlns:dc="${NS_DC}"><dc:title>x<![CDATA[never closed`,
      `<rdf:Description xmlns:dc="${NS_DC}"><dc:title>x<?pi never closed`,
      `<rdf:Description xmlns:dc="${NS_DC}"><dc:title>a < b <1> c</dc:title></rdf:Description>`,
      '<a/><b/>',
      `<rdf:Description xmlns:dc="${NS_DC}"><dc:title>x</dc:title`,
      `<rdf:Description xmlns:dc="${NS_DC}"><dc:title>x<`,
    ]) {
      await expect(readMetadata(file({ packet }))).resolves.toBeDefined();
    }
    const read = await readMetadata(
      file({
        packet: `<rdf:Description xmlns:dc="${NS_DC}"><dc:title>a < b <1> c</dc:title></rdf:Description>`,
      }),
    );
    expect(read.title).toBe('a  b 1> c');
  });

  it('reads nothing from a /Metadata entry that is not a stream', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R/Metadata 7>>',
      2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>',
    });
    expect((await readMetadata(bytes)).xmp).toBeUndefined();
  });
});

describe('reading the Info dictionary', () => {
  it('falls back from Info to XMP per field, and reads odd values as absent', async () => {
    const bytes = file({
      info: '<</Title()/Author/Name/Subject 5/Keywords(one two  three)/Creator(Info creator)/CreationDate(D:20200102030405Z)/ModDate(x)>>',
      packet: description(
        '',
        '<dc:title>Xmp title</dc:title><dc:creator><rdf:Seq><rdf:li>Xmp author</rdf:li></rdf:Seq></dc:creator><dc:description>Xmp subject</dc:description><xmp:ModifyDate>2025-01-01</xmp:ModifyDate>',
      ),
    });
    const read = await readMetadata(bytes);
    expect(read).toMatchObject({
      title: 'Xmp title',
      author: 'Xmp author',
      subject: 'Xmp subject',
      keywords: ['one', 'two', 'three'],
      creator: 'Info creator',
      creationDate: 'D:20200102030405Z',
      modificationDate: 'x',
    });
  });

  it('reads a file with no Info and no XMP as empty, and an Info that is not a dictionary as none', async () => {
    const empty = await readMetadata(file({}));
    expect({ ...empty }).toEqual({
      title: undefined,
      author: undefined,
      subject: undefined,
      keywords: undefined,
      creator: undefined,
      producer: undefined,
      creationDate: undefined,
      modificationDate: undefined,
    });
    const notDictionary = await readMetadata(file({ info: '[1 2]' }));
    expect(notDictionary.title).toBeUndefined();
  });

  it('splits keywords on commas, semicolons or white space and keeps none from blanks', async () => {
    const keywords = async (value: string) =>
      (await readMetadata(file({ info: `<</Keywords(${value})>>` }))).keywords;
    expect(await keywords('a, b ,, c')).toEqual(['a', 'b', 'c']);
    expect(await keywords('x;y')).toEqual(['x', 'y']);
    expect(await keywords(' , ; ')).toBeUndefined();
    expect(await keywords('   ')).toBeUndefined();
  });
});

describe('writing metadata into an existing packet', () => {
  const packetOf = async (bytes: Uint8Array) => (await readMetadata(bytes)).xmp ?? '';
  const merge = async (packet: string, patch: Omit<MetadataPatch, 'writeXmp'>) => {
    const out = await writeMetadata(file({ packet }), patchOnly({ ...patch, writeXmp: true }), run);
    return { out, xmp: await packetOf(out.bytes) };
  };

  it('replaces an attribute in place, whichever quote it uses, and escapes what it writes', async () => {
    const { xmp } = await merge(description(` dc:title='Old' xmp:CreatorTool="Old tool"`), {
      title: 'New "t" & <b> \u0001\u0007',
      creator: "It's",
    });
    expect(xmp).toContain(`dc:title='New &quot;t&quot; &amp; &lt;b&gt; '`);
    expect(xmp).toContain('xmp:CreatorTool="It&apos;s"');
    expect(xmp.split('<rdf:Description').length).toBe(2);
    // What the packet did not mention is added; the producer is always written.
    expect(xmp).toContain(`<pdf:Producer>${PRODUCER_LINE}</pdf:Producer>`);
  });

  it('replaces a property element and keeps what it does not own byte for byte', async () => {
    const original = description(
      '',
      '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Old</rdf:li></rdf:Alt></dc:title><dc:format>application/pdf</dc:format><xmp:CreateDate>2000-01-01</xmp:CreateDate>',
    );
    const { xmp } = await merge(original, {
      title: 'Yeni',
      subject: 'Özet',
      author: 'Yazar',
      keywords: ['a', 'b'],
      creationDate: 'D:20240102030405Z',
      modificationDate: '2024-05-06',
    });
    expect(xmp).toContain('<rdf:li xml:lang="x-default">Yeni</rdf:li>');
    expect(xmp).toContain('<dc:format>application/pdf</dc:format>');
    expect(xmp).toContain('<xmp:CreateDate>2024-01-02T03:04:05Z</xmp:CreateDate>');
    expect(xmp).toContain('<xmp:ModifyDate>2024-05-06</xmp:ModifyDate>');
    expect(xmp).toContain('<pdf:Keywords>a, b</pdf:Keywords>');
    expect(xmp).toContain('<rdf:li>Yazar</rdf:li>');
    expect(xmp).toContain('<rdf:li xml:lang="x-default">Özet</rdf:li>');
    expect(xmp).not.toContain('Old');
    expect(xmp).not.toContain('2000-01-01');
  });

  it('adds missing properties, and the namespace declarations the packet lacks, to an open description', async () => {
    const bare = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${NS_RDF}"><rdf:Description rdf:about="" xmlns:dc="${NS_DC}"></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const { xmp } = await merge(bare, { title: 'T', creator: 'Tool' });
    expect(xmp).toContain(`xmlns:xmp="${NS_XMP}"`);
    expect(xmp).toContain(`xmlns:pdf="${NS_PDF}"`);
    expect(xmp.match(/xmlns:dc=/g)).toHaveLength(1);
    expect((await readMetadata(await Promise.resolve(file({ packet: xmp })))).creator).toBe('Tool');
    // No rdf prefix anywhere: the description is `<Description>` in a default namespace.
    const noRdf = '<xmpmeta><Description></Description></xmpmeta>';
    const withRdf = (await merge(noRdf, { title: 'T' })).xmp;
    expect(withRdf).toContain(`xmlns:rdf="${NS_RDF}"`);
    expect(withRdf).toContain(`xmlns:dc="${NS_DC}"`);
  });

  it('gives a self-closing description a body, with rdf:about when it had none', async () => {
    const closed = (about: string) =>
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${NS_RDF}"><rdf:Description${about} xmlns:dc="${NS_DC}"/></rdf:RDF></x:xmpmeta>`;
    const withAbout = (await merge(closed(' rdf:about=""'), { title: 'T' })).xmp;
    expect(withAbout).toContain('</rdf:Description>');
    expect(withAbout.match(/rdf:about/g)).toHaveLength(1);
    const without = (await merge(closed(''), { title: 'T' })).xmp;
    expect(without).toContain('rdf:about=""');
    expect((await readMetadata(file({ packet: without }))).title).toBe('T');
  });

  it('rebuilds a packet it cannot edit: no markup, no description, or a prefix bound to another namespace', async () => {
    for (const packet of [
      'not xml',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>',
      description('').replace(`xmlns:dc="${NS_DC}"`, 'xmlns:dc="urn:something-else"'),
    ]) {
      const { xmp, out } = await merge(packet, { title: 'Rebuilt' });
      expect(xmp).toContain(`xmlns:dc="${NS_DC}"`);
      expect(xmp).toContain('Rebuilt');
      expect(xmp.split('<x:xmpmeta').length).toBe(2);
      expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.metadata.xmpMerged');
    }
  });

  it('edits the element, not an unprefixed look-alike attribute, and adds nothing when every property is there', async () => {
    const complete = description(
      ` title="unprefixed" xmp:CreatorTool="Old"`,
      `<pdf:Producer>Old producer</pdf:Producer><dc:title>Old title</dc:title>`,
    );
    const { xmp } = await merge(complete, { title: 'New title', creator: 'New tool' });
    expect(xmp).toContain(' title="unprefixed"');
    expect(xmp).toContain('<dc:title>');
    expect(xmp).toContain('xmp:CreatorTool="New tool"');
    expect(xmp).toContain(`<pdf:Producer>${PRODUCER_LINE}</pdf:Producer>`);
    expect(xmp).not.toContain('Old producer');
    expect(xmp.split('<pdf:Producer>').length).toBe(2);
    expect(xmp).not.toContain('</rdf:Description>\n');
  });

  it('ignores a malformed attribute without a value when it looks for one to edit', async () => {
    const { xmp } = await merge(description(' dc:title'), { title: 'Added' });
    expect(xmp).toContain('<dc:title>');
    expect((await readMetadata(file({ packet: xmp }))).title).toBe('Added');
  });
});

describe('writing metadata: Info, XMP flags, dates and progress', () => {
  it('creates the Info dictionary of a file that has none, with or without cleaning', async () => {
    for (const clean of [false, true]) {
      const out = await writeMetadata(
        file({}),
        { patch: { title: 'T', writeXmp: false }, clean, cleanXmp: false },
        run,
      );
      expect(await readMetadata(out.bytes)).toMatchObject({ title: 'T', producer: PRODUCER_LINE });
    }
  });

  it('writes every field, converts dates, and drops then re-creates the packet when both flags ask', async () => {
    const out = await writeMetadata(
      file({ packet: description(' dc:title="Old"') }),
      {
        patch: {
          title: 'T',
          author: 'A',
          subject: 'S',
          keywords: ['k1', 'k2'],
          creator: 'C',
          creationDate: '2024-03-05T06:07:08Z',
          modificationDate: 'D:2024',
          writeXmp: true,
        },
        clean: false,
        cleanXmp: true,
      },
      run,
    );
    const read = await readMetadata(out.bytes);
    expect(read).toMatchObject({
      title: 'T',
      author: 'A',
      subject: 'S',
      keywords: ['k1', 'k2'],
      creator: 'C',
    });
    expect(read.creationDate?.startsWith('D:20240305060708')).toBe(true);
    expect(read.modificationDate?.startsWith('D:20240101000000')).toBe(true);
    expect(out.report.notes.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['op.note.metadata.xmpDropped', 'op.note.metadata.xmpCreated']),
    );
    expect(out.report.steps).toEqual(['load', 'metadata', 'producer', 'xmp', 'save']);
    expect(read.xmp).toContain('<xmp:CreateDate>2024-03-05T06:07:08Z</xmp:CreateDate>');
    expect(read.xmp).toContain('<xmp:ModifyDate>2024-01-01T00:00:00Z</xmp:ModifyDate>');
    expect(read.xmp).not.toContain('Old');
  });

  it('leaves an existing packet untouched when neither flag asks, and says so', async () => {
    const packet = description(' dc:title="Kept"');
    const out = await writeMetadata(
      file({ packet }),
      patchOnly({ title: 'Info only', writeXmp: false }),
      run,
    );
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.metadata.xmpUntouched');
    expect(out.report.steps).toEqual(['load', 'metadata', 'producer', 'save']);
    expect((await readMetadata(out.bytes)).xmp).toContain('dc:title="Kept"');
  });

  it('cleans an Info that carries a producer: every key goes, and the producer line is the one written', async () => {
    const out = await writeMetadata(
      file({ info: '<</Producer(Old producer)/Author(Old author)/Title(Old title)>>' }),
      { patch: { creator: 'C', writeXmp: false }, clean: true, cleanXmp: false },
      run,
    );
    expect(await readMetadata(out.bytes)).toMatchObject({
      title: undefined,
      author: undefined,
      creator: 'C',
      producer: PRODUCER_LINE,
    });
  });

  it('refuses a modification date that is not a date, naming the field and the text', async () => {
    await expect(
      writeMetadata(file({}), patchOnly({ modificationDate: 'not a date', writeXmp: false }), run),
    ).rejects.toMatchObject({
      code: 'range-invalid',
      details: { engineMessage: 'modificationDate is not a date', path: 'not a date' },
    });
  });

  it('reports progress at the start and the end, and stops on an aborted signal', async () => {
    const onProgress = vi.fn();
    await writeMetadata(file({}), patchOnly({ title: 'T', writeXmp: false }), {
      signal: run.signal,
      onProgress,
    });
    const event = (done: number) => [{ phase: 'metadata', labelKey: 'op.progress.metadata', done, total: 1 }];
    expect(onProgress.mock.calls).toEqual([event(0), event(1)]);
    await expect(
      writeMetadata(file({}), patchOnly({ writeXmp: false }), { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
