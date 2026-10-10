// @vitest-environment happy-dom
/**
 * The text tool's layer as the user meets it: nothing until the tool is armed on a document whose
 * bytes are frozen, then the block overlay; picking a paragraph hands that block to the dialog,
 * returns to select and asks for the dialog; closing the overlay returns to select.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState, selectTool } from '../core/core-store';
import { TextToolSurface } from './TextToolSurface';
import { initialTextToolState, textToolBytesFrozen, textToolStore } from './text-tool-store';

const layer = vi.hoisted(() => ({ props: vi.fn() }));
// The real layer reads the page with the engine; what is under test is what the shell hands it.
vi.mock('pdf-ui/text-edit', () => ({
  TextLayer: (props: {
    layout: number;
    pageIndex: number;
    bytes: Uint8Array;
    onSelect: (selection: unknown) => void;
    onClose: () => void;
  }) => {
    layer.props(props);
    return (
      <div>
        <p>text layer on page {props.pageIndex}</p>
        <button
          type="button"
          onClick={() =>
            props.onSelect({
              pageIndex: props.pageIndex,
              block: { id: 'b1' },
              model: { id: 'page' },
              fonts: { catalog: {}, metrics: {} },
              editable: true,
            })
          }
        >
          pick block
        </button>
        <button type="button" onClick={props.onClose}>
          close layer
        </button>
      </div>
    );
  },
}));

const t = createTranslator('en');
const viewer = {} as unknown as ViewerApi;
const bytes = new Uint8Array([1, 2]);

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  textToolStore.set(initialTextToolState());
});
afterEach(cleanup);

function arm() {
  act(() => {
    selectTool('text');
    textToolBytesFrozen(bytes);
  });
}

describe('TextToolSurface', () => {
  it('shows nothing while the tool is not armed, without a viewer, or before the bytes are frozen', () => {
    const view = render(
      <TextToolSurface viewer={viewer} layout={0} currentPage={0} t={t} onEdit={vi.fn()} />,
    );
    act(() => textToolBytesFrozen(bytes));
    expect(view.container.innerHTML).toBe('');

    act(() => selectTool('text'));
    view.rerender(<TextToolSurface viewer={null} layout={0} currentPage={0} t={t} onEdit={vi.fn()} />);
    expect(view.container.innerHTML).toBe('');

    act(() => textToolBytesFrozen(null));
    view.rerender(<TextToolSurface viewer={viewer} layout={0} currentPage={0} t={t} onEdit={vi.fn()} />);
    expect(view.container.innerHTML).toBe('');
  });

  it('paints the block overlay for the current page over the frozen bytes once armed', async () => {
    render(<TextToolSurface viewer={viewer} layout={0} currentPage={3} t={t} onEdit={vi.fn()} />);
    arm();
    expect(await screen.findByText('text layer on page 3')).toBeTruthy();
    expect(layer.props).toHaveBeenCalledWith(expect.objectContaining({ bytes, pageIndex: 3 }));
  });

  it('hands a picked paragraph to the dialog: block kept, select tool back, dialog asked for', async () => {
    const onEdit = vi.fn();
    render(<TextToolSurface viewer={viewer} layout={0} currentPage={1} t={t} onEdit={onEdit} />);
    arm();
    await userEvent.click(await screen.findByRole('button', { name: 'pick block' }));
    expect(textToolStore.get().edit).toEqual({
      pageIndex: 1,
      block: { id: 'b1' },
      model: { id: 'page' },
      fonts: { catalog: {}, metrics: {} },
    });
    expect(coreStore.get().canvasTool).toBe('select');
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('hands the layer each layout revision, so its blocks are placed again where the pages now are', () => {
    arm();
    const view = render(
      <TextToolSurface viewer={viewer} layout={0} currentPage={0} t={t} onEdit={vi.fn()} />,
    );
    expect(layer.props.mock.lastCall?.[0].layout).toBe(0);
    view.rerender(<TextToolSurface viewer={viewer} layout={1} currentPage={0} t={t} onEdit={vi.fn()} />);
    expect(layer.props.mock.lastCall?.[0].layout).toBe(1);
  });

  it('returns to select when the overlay is closed, without asking for the dialog', async () => {
    const onEdit = vi.fn();
    render(<TextToolSurface viewer={viewer} layout={0} currentPage={0} t={t} onEdit={onEdit} />);
    arm();
    await userEvent.click(await screen.findByRole('button', { name: 'close layer' }));
    expect(coreStore.get().canvasTool).toBe('select');
    expect(onEdit).not.toHaveBeenCalled();
    expect(textToolStore.get().edit).toBeNull();
  });
});
