import { readMetadata } from 'pdf-core';
import { describe, expect, it } from 'vitest';
import { runContext, runDialog, textPdf } from '../pdf-fixtures';
import { propertiesDialog } from './properties';

const bytesOf = (result: { files: readonly { bytes: Uint8Array }[] }) =>
  result.files[0]?.bytes ?? new Uint8Array();

describe('propertiesDialog', () => {
  it('writes every filled field and reads them back', async () => {
    const result = await runDialog(
      propertiesDialog,
      {
        title: ' Annual report ',
        author: 'Ada Lovelace',
        subject: 'Numbers',
        keywords: 'alpha, beta,, gamma ',
        creator: 'Writer',
        creationDate: '2020-01-02T03:04:05Z',
        modificationDate: '2021-02-03T04:05:06Z',
      },
      await textPdf([['x']]),
    );
    expect(result.noticeKey).toBe('properties.done');
    expect(result.files[0]?.name).toBe('doc.pdf');
    const meta = await readMetadata(bytesOf(result));
    expect(meta).toMatchObject({
      title: 'Annual report',
      author: 'Ada Lovelace',
      subject: 'Numbers',
      keywords: ['alpha', 'beta', 'gamma'],
      creator: 'Writer',
    });
    expect(meta.creationDate).toBe('D:20200102030405Z');
    expect(meta.modificationDate).toBe('D:20210203040506Z');
  });

  it('writes the XMP packet when asked', async () => {
    const result = await runDialog(
      propertiesDialog,
      { title: 'With XMP', writeXmp: true },
      await textPdf([['x']]),
    );
    expect((await readMetadata(bytesOf(result))).xmp).toContain('With XMP');
  });

  it('leaves the file alone when the fields hold what the document already has', async () => {
    const first = await runDialog(
      propertiesDialog,
      {
        title: 'Same',
        author: 'Same author',
        subject: 'Same subject',
        keywords: 'a, b',
        creator: 'Same creator',
        creationDate: '2020-01-02T03:04:05Z',
        modificationDate: '2021-02-03T04:05:06Z',
      },
      await textPdf([['x']]),
    );
    const bytes = bytesOf(first);
    const current = await readMetadata(bytes);
    const again = await runDialog(
      propertiesDialog,
      {
        title: 'Same',
        author: 'Same author',
        subject: 'Same subject',
        keywords: 'a, b',
        creator: 'Same creator',
        creationDate: current.creationDate ?? '',
        modificationDate: current.modificationDate ?? '',
      },
      bytes,
    );
    expect(again.files).toEqual([]);
    expect(again.noticeKey).toBe('properties.noChange');
    expect(again.report.notes.map((entry) => entry.key)).toEqual(['properties.noChange']);
    expect(again.report.steps).toEqual([]);
    expect(again.report.outputBytes).toBe(bytes.length);
  });

  it('leaves the file alone when no field is filled and nothing is cleaned', async () => {
    const result = await runDialog(propertiesDialog, {}, await textPdf([['x']]));
    expect(result.files).toEqual([]);
    expect(result.noticeKey).toBe('properties.noChange');
  });

  it('treats a host that sends no params at all as nothing to change', async () => {
    const result = await propertiesDialog.run({}, await runContext(await textPdf([['x']])));
    expect(result.files).toEqual([]);
    expect(result.noticeKey).toBe('properties.noChange');
  });

  it('clears the info dictionary and the XMP packet when asked', async () => {
    const written = await runDialog(
      propertiesDialog,
      { title: 'To be cleared', author: 'Someone', writeXmp: true },
      await textPdf([['x']]),
    );
    const cleaned = await runDialog(propertiesDialog, { clean: ['info', 'xmp'] }, bytesOf(written));
    const meta = await readMetadata(bytesOf(cleaned));
    expect(meta.title).toBeUndefined();
    expect(meta.author).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
  });

  it('reads params the host leaves out as empty', async () => {
    const result = await propertiesDialog.run({ clean: ['info'] }, await runContext(await textPdf([['x']])));
    expect(result.noticeKey).toBe('properties.done');
  });
});
