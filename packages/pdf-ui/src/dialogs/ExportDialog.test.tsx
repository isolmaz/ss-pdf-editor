// @vitest-environment happy-dom
/**
 * The download dialog: which kinds it offers, what each choice sends to the shell, and that the
 * Word layout is only asked for while Word is the chosen format.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportDialog } from './ExportDialog';

const t = createTranslator('en');

function show() {
  const onClose = vi.fn();
  const onExport = vi.fn();
  render(
    <ExportDialog open t={t} fileName="report.pdf" fileSize={2048} onClose={onClose} onExport={onExport} />,
  );
  return { onClose, onExport, user: userEvent.setup() };
}

afterEach(cleanup);

describe('ExportDialog', () => {
  it('offers the document with its size and name and downloads it as a PDF by default', async () => {
    const { onClose, onExport, user } = show();
    expect(screen.getByRole('heading', { name: 'Download / Export' })).toBeTruthy();
    expect(screen.getByText('This PDF (2.0 KB)')).toBeTruthy();
    expect(screen.getByText('report.pdf')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(onExport).toHaveBeenCalledExactlyOnceWith({
      kind: 'pdf',
      compressionLevel: 'medium',
      imageFormat: 'png',
      officeFormat: 'docx',
      officeLayout: 'layout',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('downloads a compressed PDF at the chosen level', async () => {
    const { onExport, user } = show();
    await user.click(screen.getByRole('radio', { name: /Compressed PDF/ }));
    await user.selectOptions(screen.getByDisplayValue('MEDIUM'), 'high');
    await user.click(screen.getByRole('button', { name: 'Download Compressed PDF' }));
    expect(onExport.mock.calls[0]?.[0]).toMatchObject({ kind: 'compressed', compressionLevel: 'high' });
  });

  it('downloads the pages as images in the chosen format', async () => {
    const { onExport, user } = show();
    await user.click(screen.getByRole('radio', { name: /Image Format/ }));
    await user.selectOptions(screen.getByDisplayValue('PNG'), 'jpg');
    await user.click(screen.getByRole('button', { name: 'Download Images' }));
    expect(onExport.mock.calls[0]?.[0]).toMatchObject({ kind: 'images', imageFormat: 'jpg' });
  });

  it('goes back to the PDF after another kind was chosen', async () => {
    const { onExport, user } = show();
    await user.click(screen.getByRole('radio', { name: /Text Format/ }));
    await user.click(screen.getByRole('radio', { name: /This PDF/ }));
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(onExport.mock.calls[0]?.[0]).toMatchObject({ kind: 'pdf' });
  });

  it('downloads the text', async () => {
    const { onExport, user } = show();
    await user.click(screen.getByRole('radio', { name: /Text Format/ }));
    await user.click(screen.getByRole('button', { name: 'Download Text File' }));
    expect(onExport.mock.calls[0]?.[0]).toMatchObject({ kind: 'text' });
  });

  it('asks for the Word layout only while Word is chosen and sends the one picked', async () => {
    const { onExport, user } = show();
    expect(screen.queryByRole('combobox', { name: 'Word layout' })).toBeNull();
    await user.click(screen.getByRole('radio', { name: /Word, Excel or CSV/ }));
    const layout = screen.getByRole('combobox', { name: 'Word layout' });
    expect((layout as HTMLSelectElement).value).toBe('layout');
    await user.selectOptions(layout, 'flow');
    await user.click(screen.getByRole('button', { name: /^Download/ }));
    expect(onExport.mock.calls[0]?.[0]).toMatchObject({
      kind: 'office',
      officeFormat: 'docx',
      officeLayout: 'flow',
    });
  });

  it('drops the Word layout once Excel or CSV is chosen', async () => {
    const { onExport, user } = show();
    await user.click(screen.getByRole('radio', { name: /Word, Excel or CSV/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Format' }), 'xlsx');
    expect(screen.queryByRole('combobox', { name: 'Word layout' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Download/ }));
    expect(onExport.mock.calls[0]?.[0]).toMatchObject({ kind: 'office', officeFormat: 'xlsx' });
  });

  it('closes from the close button and when the popup asks to close', async () => {
    const { onClose, onExport, user } = show();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onExport).not.toHaveBeenCalled();
  });
});
