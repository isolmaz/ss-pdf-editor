// @vitest-environment happy-dom
/**
 * The layers panel: the optional content groups as a tree of checkboxes, labels from the
 * document's own order as headings, a checkbox that applies what the engine answers (never
 * what was clicked), and the button that hands the state on screen to the shell as a write
 * request. The layer reader has its own suite, so it answers here with what its contract
 * describes.
 */

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { PdfLayerGroup, PdfLayerNode } from 'pdf-core/layers';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayersPanel, type LayersPanelProps } from './LayersPanel';

const { listPdfLayers, setPdfLayerVisibility } = vi.hoisted(() => ({
  listPdfLayers: vi.fn(),
  setPdfLayerVisibility: vi.fn(),
}));
vi.mock('pdf-core/layers', () => ({ listPdfLayers, setPdfLayerVisibility }));

const t = createTranslator('en');
const doc = (name: string) => ({ name }) as unknown as PdfDocumentHandle;
const OPEN = doc('open');

beforeEach(() => {
  listPdfLayers.mockReset();
  setPdfLayerVisibility.mockReset();
});
afterEach(cleanup);

const group = (id: string, visible = true, children: readonly PdfLayerNode[] = []): PdfLayerGroup => ({
  kind: 'group',
  id,
  name: `Layer ${id}`,
  visible,
  children,
});
const label = (name: string | null, children: readonly PdfLayerNode[]): PdfLayerNode => ({
  kind: 'label',
  name,
  children,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function show(props: Partial<LayersPanelProps> = {}) {
  const view = render(<LayersPanel document={OPEN} t={t} {...props} />);
  return { ...view, user: userEvent.setup() };
}

const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;

describe('LayersPanel: the tree', () => {
  it('shows a loading state until the engine answers', async () => {
    const pending = deferred<PdfLayerNode[]>();
    listPdfLayers.mockReturnValue(pending.promise);
    const { container } = show();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    pending.resolve([]);
    expect(await screen.findByText('This document has no layers.')).toBeTruthy();
  });

  it('shows groups with their visibility, nested groups under their parent and labels as headings', async () => {
    listPdfLayers.mockResolvedValue([
      group('A', true, [group('A1', false)]),
      label('Extras', [group('B', false)]),
      label(null, [group('C')]),
    ]);
    show();

    const fieldset = await screen.findByRole('group', { name: 'Layers' });
    expect(
      within(fieldset)
        .getAllByRole('checkbox')
        .map((input) => [input.closest('label')?.textContent, (input as HTMLInputElement).checked]),
    ).toEqual([
      ['Layer A', true],
      ['Layer A1', false],
      ['Layer B', false],
      ['Layer C', true],
    ]);
    expect(screen.getByText('Extras')).toBeTruthy();
    const nested = box('Layer A1').closest('ul');
    expect(nested?.parentElement?.querySelector('label')?.textContent).toBe('Layer A');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says the document has no layers', async () => {
    listPdfLayers.mockResolvedValue([]);
    show();
    expect(await screen.findByText('This document has no layers.')).toBeTruthy();
  });

  it('says what failed and tells the shell when the layers cannot be read', async () => {
    listPdfLayers.mockImplementation(async () => {
      throw new ToolError('internal', { engine: 'pdfjs' });
    });
    const onNotice = vi.fn();
    show({ onNotice });
    const failure = new ToolError('internal', { engine: 'pdfjs' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey));
  });

  it('shows a failure even when the shell takes no notices', async () => {
    listPdfLayers.mockImplementation(async () => {
      throw new Error('boom');
    });
    show();
    const failure = new ToolError('internal', { engine: 'ui' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
  });

  it('keeps the open document tree when an earlier document answers late', async () => {
    const first = deferred<PdfLayerNode[]>();
    listPdfLayers.mockReturnValueOnce(first.promise).mockResolvedValueOnce([group('current')]);
    const { rerender } = show();
    rerender(<LayersPanel document={doc('b')} t={t} />);
    expect(await screen.findByRole('checkbox', { name: 'Layer current' })).toBeTruthy();

    await act(async () => {
      first.resolve([group('stale')]);
      await first.promise;
    });
    expect(screen.queryByRole('checkbox', { name: 'Layer stale' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Layer current' })).toBeTruthy();
  });

  it('does not report a failure of an earlier document once another is open', async () => {
    const first = deferred<PdfLayerNode[]>();
    listPdfLayers.mockReturnValueOnce(first.promise).mockResolvedValueOnce([group('current')]);
    const onNotice = vi.fn();
    const { rerender } = show({ onNotice });
    rerender(<LayersPanel document={doc('b')} t={t} onNotice={onNotice} />);
    expect(await screen.findByRole('checkbox', { name: 'Layer current' })).toBeTruthy();

    await act(async () => {
      first.reject(new Error('late failure'));
      await first.promise.catch(() => undefined);
    });
    expect(onNotice).not.toHaveBeenCalled();
  });
});

describe('LayersPanel: toggling', () => {
  it('applies what the engine answers, tells the viewer, and holds the checkbox while the write runs', async () => {
    listPdfLayers.mockResolvedValue([group('A', true), group('B', true)]);
    const write = deferred<PdfLayerNode[]>();
    setPdfLayerVisibility.mockReturnValue(write.promise);
    const onLayersChanged = vi.fn();
    const { user } = show({ onLayersChanged });
    await screen.findByRole('checkbox', { name: 'Layer A' });

    await user.click(box('Layer A'));
    expect(setPdfLayerVisibility).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'A', false);
    expect(box('Layer A').disabled).toBe(true);
    expect(box('Layer B').disabled).toBe(false);
    // The box shows the document's state, not the click's: nothing was written yet.
    expect(box('Layer A').checked).toBe(true);
    expect(onLayersChanged).not.toHaveBeenCalled();

    // The engine answers with a different state than the one requested, and that is shown.
    write.resolve([group('A', false), group('B', false)]);
    await waitFor(() => expect(box('Layer A').disabled).toBe(false));
    expect(box('Layer A').checked).toBe(false);
    expect(box('Layer B').checked).toBe(false);
    expect(onLayersChanged).toHaveBeenCalledOnce();
  });

  it('tells the current viewer hook, not the one from the first render', async () => {
    listPdfLayers.mockResolvedValue([group('A', true)]);
    setPdfLayerVisibility.mockResolvedValue([group('A', false)]);
    const first = vi.fn();
    const second = vi.fn();
    const { user, rerender } = show({ onLayersChanged: first });
    await screen.findByRole('checkbox', { name: 'Layer A' });
    rerender(<LayersPanel document={OPEN} t={t} onLayersChanged={second} />);

    await user.click(box('Layer A'));
    await waitFor(() => expect(second).toHaveBeenCalledOnce());
    expect(first).not.toHaveBeenCalled();
  });

  it('toggles without a viewer hook', async () => {
    listPdfLayers.mockResolvedValue([group('A', true)]);
    setPdfLayerVisibility.mockResolvedValue([group('A', false)]);
    const { user } = show();
    await user.click(await screen.findByRole('checkbox', { name: 'Layer A' }));
    await waitFor(() => expect(box('Layer A').checked).toBe(false));
  });

  it('keeps the shown state and tells the shell when the engine refuses the change', async () => {
    listPdfLayers.mockResolvedValue([group('A', true)]);
    setPdfLayerVisibility.mockImplementation(async () => {
      throw new ToolError('internal', { engine: 'pdfjs' });
    });
    const onNotice = vi.fn();
    const onLayersChanged = vi.fn();
    const { user } = show({ onNotice, onLayersChanged });
    await user.click(await screen.findByRole('checkbox', { name: 'Layer A' }));

    const failure = new ToolError('internal', { engine: 'pdfjs' });
    await waitFor(() => expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey)));
    expect(box('Layer A').checked).toBe(true);
    expect(box('Layer A').disabled).toBe(false);
    expect(onLayersChanged).not.toHaveBeenCalled();
  });
});

describe('LayersPanel: writing the state into the file', () => {
  it('offers no write without a shell that writes', async () => {
    listPdfLayers.mockResolvedValue([group('A')]);
    show();
    await screen.findByRole('checkbox', { name: 'Layer A' });
    expect(screen.queryByRole('button', { name: 'Write layer state to the document' })).toBeNull();
  });

  it('hands the state on screen to the shell: groups in reading order, labels left out', async () => {
    listPdfLayers.mockResolvedValue([
      group('A', true, [group('A1', false)]),
      label('Extras', [group('B', false)]),
      label(null, [group('C', true)]),
    ]);
    const onWriteDocument = vi.fn();
    const { user } = show({ onWriteDocument });

    await user.click(await screen.findByRole('button', { name: 'Write layer state to the document' }));
    expect(onWriteDocument).toHaveBeenCalledExactlyOnceWith({
      states: [
        { name: 'Layer A', visible: true },
        { name: 'Layer A1', visible: false },
        { name: 'Layer B', visible: false },
        { name: 'Layer C', visible: true },
      ],
      order: ['Layer A', 'Layer A1', 'Layer B', 'Layer C'],
    });
  });

  it('stops responding while the host takes no writes or a toggle is in flight', async () => {
    listPdfLayers.mockResolvedValue([group('A')]);
    const write = deferred<PdfLayerNode[]>();
    setPdfLayerVisibility.mockReturnValue(write.promise);
    const { user, rerender } = show({ onWriteDocument: vi.fn(), disabled: true });
    const button = () =>
      screen.getByRole('button', { name: 'Write layer state to the document' }) as HTMLButtonElement;
    await screen.findByRole('button', { name: 'Write layer state to the document' });
    expect(button().disabled).toBe(true);

    rerender(<LayersPanel document={OPEN} t={t} onWriteDocument={vi.fn()} />);
    expect(button().disabled).toBe(false);
    await user.click(box('Layer A'));
    expect(button().disabled).toBe(true);
    write.resolve([group('A', false)]);
    await waitFor(() => expect(button().disabled).toBe(false));
  });
});
