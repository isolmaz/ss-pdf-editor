import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { runDialog, xfaFormPdf } from '../pdf-fixtures';
import { xfaDataDialog, xfaFlattenDialog, xfaRemoveDialog } from './xfa';

const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes ?? new Uint8Array());

describe('xfaRemoveDialog', () => {
  it('strips the XFA from a static form and keeps the file name', async () => {
    const result = await runDialog(xfaRemoveDialog, {}, await xfaFormPdf('static'));
    expect(result.noticeKey).toBe('xfa.remove.done');
    expect(result.files[0]?.name).toBe('doc.pdf');
    expect(result.files[0]?.mime).toBe('application/pdf');
    const again = runDialog(xfaRemoveDialog, {}, result.files[0]?.bytes ?? new Uint8Array());
    await expect(again).rejects.toMatchObject({ code: 'no-xfa' });
  });

  it('refuses a dynamic form, which has no AcroForm to keep', async () => {
    const run = runDialog(xfaRemoveDialog, {}, await xfaFormPdf('dynamic'));
    await expect(run).rejects.toMatchObject({ code: 'xfa-dynamic' });
  });
});

describe('xfaDataDialog', () => {
  it('exports the form data as an XML download', async () => {
    const result = await runDialog(xfaDataDialog, { mode: 'export' }, await xfaFormPdf('static'));
    expect(result.deliver).toBe('download');
    expect(result.files[0]?.name).toBe('xfa-data.xml');
    expect(result.files[0]?.mime).toBe('application/xml');
    expect(decode(result.files[0]?.bytes)).toContain('<Name>Ada</Name>');
    expect(result.noticeKey).toBe('xfa.note.exported');
    expect(result.noticeParams).toEqual({ count: 2 });
    expect(result.report.steps).toEqual(['xfa.export']);
    expect(result.report.outputBytes).toBe(result.files[0]?.bytes.length);
  });

  it('imports an XML data file into the form and reports the number of values', async () => {
    const file = new File(['<form1><Name>Grace</Name><City>Izmir</City></form1>'], 'data.xml');
    const bytes = await xfaFormPdf('static');
    const result = await runDialog(xfaDataDialog, { mode: 'import', file: [file] }, bytes);
    expect(result.noticeKey).toBe('xfa.note.imported');
    expect(result.noticeParams).toEqual({ count: 2 });
    expect(result.files[0]?.name).toBe('doc.pdf');
    const exported = await runDialog(xfaDataDialog, { mode: 'export' }, result.files[0]?.bytes ?? bytes);
    expect(decode(exported.files[0]?.bytes)).toContain('<Name>Grace</Name>');
  });

  it('asks for a data file when importing without one', async () => {
    const run = runDialog(xfaDataDialog, { mode: 'import' }, await xfaFormPdf('static'));
    await expect(run).rejects.toBeInstanceOf(ToolError);
    await expect(run).rejects.toMatchObject({
      code: 'input-missing',
      details: { engineMessage: 'no XFA data file chosen' },
    });
  });

  it('says there is no XFA in a form without one', async () => {
    const run = runDialog(xfaDataDialog, { mode: 'export' }, await xfaFormPdf('none'));
    await expect(run).rejects.toMatchObject({ code: 'no-xfa' });
  });
});

describe('xfaFlattenDialog', () => {
  it('refuses a file without XFA', async () => {
    const run = runDialog(xfaFlattenDialog, {}, await xfaFormPdf('none'));
    await expect(run).rejects.toMatchObject({ code: 'no-xfa' });
  });

  it('refuses a static form, whose pages are already real', async () => {
    const run = runDialog(xfaFlattenDialog, {}, await xfaFormPdf('static'));
    await expect(run).rejects.toMatchObject({ code: 'xfa-static' });
  });
});
