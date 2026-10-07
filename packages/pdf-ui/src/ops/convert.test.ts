import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pageCountOf,
  pageTextsOf,
  removeFontOrigin,
  runContext,
  runDialog,
  useFontOrigin,
} from '../pdf-fixtures';
import { convertDialog } from './convert';

const file = (name: string, text: string): File => new File([text], name);
const nothing = new Uint8Array();

describe('convertDialog', () => {
  beforeEach(useFontOrigin);
  afterEach(removeFontOrigin);

  it('converts one text file to a PDF named after it, with its words on the page', async () => {
    const result = await runDialog(
      convertDialog,
      { files: [file('notes.txt', 'Quarterly plan\nSecond line')] },
      nothing,
      { pageCount: 0 },
    );
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.name).toBe('notes.pdf');
    expect(result.files[0]?.mime).toBe('application/pdf');
    const bytes = result.files[0]?.bytes ?? nothing;
    expect(await pageCountOf(bytes)).toBe(1);
    const text = (await pageTextsOf(bytes))[0] ?? '';
    expect(text).toContain('Quarterly plan');
    expect(text).toContain('Second line');
  });

  it('joins several files into one document in the order of the list', async () => {
    const result = await runDialog(
      convertDialog,
      {
        files: [file('first.txt', 'Alpha page'), file('second.html', '<p>Beta page</p>')],
        pageSize: 'letter',
        orientation: 'landscape',
        marginMm: 10,
      },
      nothing,
      { pageCount: 0 },
    );
    expect(result.files[0]?.name).toBe('first.pdf');
    const texts = await pageTextsOf(result.files[0]?.bytes ?? nothing);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('Alpha page');
    expect(texts[1]).toContain('Beta page');
    expect(result.report.inputBytes).toBe('Alpha page'.length + '<p>Beta page</p>'.length);
    expect(result.report.notes.length).toBeGreaterThan(0);
  });

  it('refuses a run with no file picked', async () => {
    const context = await runContext(nothing, { pageCount: 0 });
    const error = await convertDialog.run({ files: [] }, context).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe('input-missing');
    expect((error as ToolError).details.engineMessage).toBe('convert-to-pdf: no file picked');
    const missing = await convertDialog.run({}, context).catch((reason: unknown) => reason);
    expect((missing as ToolError).code).toBe('input-missing');
  });
});
