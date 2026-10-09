// @vitest-environment happy-dom
/**
 * The reading pane on a fake engine page and a fake Web Speech: what the column shows while the page
 * loads, when it fails, when it is empty and when it has text; the paging buttons and keys; the
 * read-aloud controls and their explanation when no local voice exists.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadingPane, type ReadingPaneProps } from './ReadingPane';
import type { ReadingViewer } from './useReadingText';

const t = createTranslator('en');

const run = (str: string, y: number, size = 12) => ({
  str,
  transform: [size, 0, 0, size, 72, y],
  width: 100,
  height: size,
});

/** A heading, a four-line paragraph, a list item and a caption, top to bottom. */
const PAGE_ITEMS = [
  run('Chapter One', 750, 20),
  run('Alpha beta.', 700),
  run('Gamma delta.', 686),
  run('Epsilon zeta.', 672),
  run('Eta theta.', 658),
  run('• First item', 620),
  run('Figure 1', 590, 9),
];

function viewerOf(getPage: (page: number) => Promise<unknown>): ReadingViewer {
  return { document: { raw: { getPage } } } as unknown as ReadingViewer;
}

const pageViewer = () => viewerOf(async () => ({ getTextContent: async () => ({ items: PAGE_ITEMS }) }));

class FakeUtterance {
  voice: unknown = null;
  lang = '';
  rate = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

class FakeSynthesis extends EventTarget {
  voices: Array<{ lang: string; localService: boolean }> = [];
  speaking = false;
  log: string[] = [];
  queue: FakeUtterance[] = [];
  getVoices() {
    return this.voices;
  }
  speak(utterance: FakeUtterance) {
    this.log.push(`speak:${utterance.text}`);
    this.queue.push(utterance);
    this.speaking = true;
  }
  cancel() {
    this.log.push('cancel');
    this.queue = [];
    this.speaking = false;
  }
  pause() {
    this.log.push('pause');
  }
  resume() {
    this.log.push('resume');
  }
}

let synthesis: FakeSynthesis;
let original: PropertyDescriptor | undefined;

beforeEach(() => {
  synthesis = new FakeSynthesis();
  original = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});

afterEach(() => {
  cleanup();
  if (original === undefined) Reflect.deleteProperty(window, 'speechSynthesis');
  else Object.defineProperty(window, 'speechSynthesis', original);
  vi.unstubAllGlobals();
});

function props(overrides: Partial<ReadingPaneProps> = {}): ReadingPaneProps {
  return {
    viewer: pageViewer(),
    open: true,
    onClose: vi.fn(),
    t,
    lang: 'de',
    pageNumber: 0,
    onPageChange: vi.fn(),
    ...overrides,
  };
}

async function opened(overrides: Partial<ReadingPaneProps> = {}) {
  const given = props(overrides);
  const view = render(<ReadingPane {...given} />);
  await screen.findByText('Chapter One');
  return { given, view };
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('ReadingPane column', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<ReadingPane {...props({ open: false })} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the page as blocks by kind, under a named region that has the focus', async () => {
    await opened({ pageNumber: 2 });
    const region = screen.getByRole('region', { name: 'Reading mode' });
    expect(region.contains(document.activeElement)).toBe(true);
    expect(screen.getByText('Page 3')).toBeTruthy();
    const heading = screen.getByRole('heading', { name: 'Chapter One' });
    expect(heading.tagName).toBe('H2');
    const paragraph = screen.getByText('Alpha beta. Gamma delta. Epsilon zeta. Eta theta.');
    expect(paragraph.tagName).toBe('P');
    expect(paragraph.className).toContain('pdf-reading-block-paragraph');
    expect(screen.getByText('• First item').className).toContain('pdf-reading-block-list-item');
    expect(screen.getByText('Figure 1').className).toContain('pdf-reading-block-caption');
  });

  it('shows a skeleton, not text, while the page is being read', () => {
    const never = Promise.withResolvers<never>();
    const { container } = render(<ReadingPane {...props({ viewer: viewerOf(() => never.promise) })} />);
    expect(container.querySelector('.pdf-reading-scroll')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelectorAll('.pdf-reading-skeleton-line')).toHaveLength(6);
    expect(screen.queryByText('No readable text was found on this page.')).toBeNull();
  });

  it('waits the same way before the viewer exists', () => {
    const { container } = render(<ReadingPane {...props({ viewer: null })} />);
    expect(container.querySelectorAll('.pdf-reading-skeleton-line')).toHaveLength(6);
  });

  it('says so when the page has no readable text', async () => {
    const viewer = viewerOf(async () => ({ getTextContent: async () => ({ items: [] }) }));
    render(<ReadingPane {...props({ viewer })} />);
    expect(await screen.findByText('No readable text was found on this page.')).toBeTruthy();
  });

  it('shows a failure in the pane and in the shell notice', async () => {
    const onNotice = vi.fn();
    const viewer = viewerOf(async () =>
      Promise.reject(new ToolError('corrupt-document', { engine: 'pdfjs' })),
    );
    render(<ReadingPane {...props({ viewer, onNotice })} />);
    expect(await screen.findByText('The document looks damaged.')).toBeTruthy();
    expect(onNotice).toHaveBeenCalledWith('The document looks damaged.');
  });

  it('shows a failure in the pane alone when the shell offers no notice channel', async () => {
    const viewer = { document: undefined } as unknown as ReadingViewer;
    render(<ReadingPane {...props({ viewer })} />);
    expect(await screen.findByText('Something unexpected went wrong.')).toBeTruthy();
  });
});

describe('ReadingPane paging', () => {
  it('pages with the buttons, named after the page they go to', async () => {
    const { given } = await opened({ pageNumber: 4 });
    fireEvent.click(button('Go to page 4'));
    expect(given.onPageChange).toHaveBeenLastCalledWith(3);
    fireEvent.click(button('Go to page 6'));
    expect(given.onPageChange).toHaveBeenLastCalledWith(5);
  });

  it('cannot go before the first page', async () => {
    await opened({ pageNumber: 0 });
    expect(button('Go to page 1').disabled).toBe(true);
    expect(button('Go to page 2').disabled).toBe(false);
  });

  it.each([
    ['PageDown', 6],
    ['ArrowDown', 6],
    ['ArrowRight', 6],
    ['PageUp', 4],
    ['ArrowUp', 4],
    ['ArrowLeft', 4],
  ])('%s moves to page index %i and is consumed', async (key, expected) => {
    const { given } = await opened({ pageNumber: 5 });
    expect(fireEvent.keyDown(document.body, { key })).toBe(false);
    expect(given.onPageChange).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it('stops at the first page when paging back by key', async () => {
    const { given } = await opened({ pageNumber: 0 });
    fireEvent.keyDown(document.body, { key: 'PageUp' });
    expect(given.onPageChange).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('closes on Escape', async () => {
    const { given } = await opened();
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(false);
    expect(given.onClose).toHaveBeenCalledTimes(1);
    expect(given.onPageChange).not.toHaveBeenCalled();
  });

  it('leaves other keys, modified keys and form controls alone', async () => {
    const { given } = await opened();
    expect(fireEvent.keyDown(document.body, { key: 'a' })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: 'ArrowDown', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: 'ArrowDown', altKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: 'ArrowDown', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(screen.getByRole('slider', { name: 'Rate' }), { key: 'ArrowRight' })).toBe(true);
    const editable = document.body.appendChild(document.createElement('div'));
    editable.setAttribute('contenteditable', 'true');
    expect(fireEvent.keyDown(editable, { key: 'ArrowRight' })).toBe(true);
    expect(given.onPageChange).not.toHaveBeenCalled();
  });

  it('pages on a key that was not pressed on an element', async () => {
    const { given } = await opened({ pageNumber: 1 });
    expect(fireEvent.keyDown(window, { key: 'PageDown' })).toBe(false);
    expect(given.onPageChange).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('closes from the close button', async () => {
    const { given } = await opened();
    await userEvent.click(button('Reading mode'));
    expect(given.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ReadingPane read-aloud', () => {
  it('explains a missing local voice by the language name and disables the controls', async () => {
    synthesis.voices = [{ lang: 'de-DE', localService: false }];
    await opened();
    expect(
      screen.getByText('There is no local German voice on this device; read-aloud is unavailable.'),
    ).toBeTruthy();
    expect(button('Read').disabled).toBe(true);
    expect(button('Stop').disabled).toBe(true);
    expect((screen.getByRole('slider', { name: 'Rate' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('names a language the platform cannot name as it was given', async () => {
    await opened({ lang: 'not a tag' });
    expect(
      screen.getByText('There is no local not a tag voice on this device; read-aloud is unavailable.'),
    ).toBeTruthy();
  });

  it('plays, pauses, resumes and stops with the controls following the engine', async () => {
    synthesis.voices = [{ lang: 'de-DE', localService: true }];
    await opened();
    expect(screen.queryByText(/no local/)).toBeNull();
    expect(button('Stop').disabled).toBe(true);

    fireEvent.click(button('Read'));
    expect(synthesis.queue.map((utterance) => utterance.text)).toEqual([
      'Chapter One Alpha beta.',
      'Gamma delta.',
      'Epsilon zeta.',
      'Eta theta.',
      '• First item Figure 1',
    ]);
    act(() => synthesis.queue[0]?.onstart?.());
    expect(button('Stop').disabled).toBe(false);

    fireEvent.click(button('Pause'));
    expect(synthesis.log.at(-1)).toBe('pause');
    expect(button('Read')).toBeTruthy();
    expect(button('Stop').disabled).toBe(false);

    fireEvent.click(button('Read'));
    expect(synthesis.log.at(-1)).toBe('resume');
    expect(button('Pause')).toBeTruthy();

    fireEvent.click(button('Stop'));
    expect(synthesis.log.at(-1)).toBe('cancel');
    expect(button('Read').disabled).toBe(false);
    expect(button('Stop').disabled).toBe(true);
  });

  it('shows the rate and hands a changed rate to the next reading', async () => {
    synthesis.voices = [{ lang: 'de-DE', localService: true }];
    await opened();
    const slider = screen.getByRole('slider', { name: 'Rate' }) as HTMLInputElement;
    expect(screen.getByText('1.00×')).toBeTruthy();
    fireEvent.change(slider, { target: { value: '1.5' } });
    expect(screen.getByText('1.50×')).toBeTruthy();
    fireEvent.click(button('Read'));
    expect(synthesis.queue.map((utterance) => utterance.rate)).toEqual([1.5, 1.5, 1.5, 1.5, 1.5]);
  });

  it('stops talking when the pane closes', async () => {
    synthesis.voices = [{ lang: 'de-DE', localService: true }];
    const { given, view } = await opened();
    fireEvent.click(button('Read'));
    expect(synthesis.speaking).toBe(true);
    view.rerender(<ReadingPane {...given} open={false} />);
    expect(synthesis.speaking).toBe(false);
  });
});
