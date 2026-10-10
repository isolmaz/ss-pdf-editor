// @vitest-environment happy-dom
/**
 * The tool strip's place under the header is empty on the home screen and until the editor chunk
 * has arrived, and holds the chunk's strip, given the props the shell wired, once a document shows.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptHandle, dropHandle } from '../core/handles';
import { hideStartScreen, initialOpenState, openStore, showStartScreen } from '../open/open-store';
import { type EditorSurfaces, editorStore, initialEditorState } from './editor-store';
import type { ToolStripProps } from './ToolStrip';
import { ToolStripHost } from './ToolStripHost';

const t = createTranslator('en');
let session: SessionStore;
let tabIds: string[];

const surfaces = {
  ToolStrip: (props: ToolStripProps) => (
    <section aria-label="tool strip" data-session={props.session === session} />
  ),
} as unknown as EditorSurfaces;

function renderHost() {
  const actions = {} as ToolStripProps['actions'];
  return render(<ToolStripHost session={session} tier="desktop" t={t} actions={actions} />);
}

function openTab() {
  const tab = session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 1 });
  tabIds.push(tab.id);
  adoptHandle(tab.id, { id: 'handle' } as unknown as PdfDocumentHandle);
  hideStartScreen();
}

beforeEach(() => {
  editorStore.set({ surfaces, loading: null });
  openStore.set(initialOpenState());
  session = new SessionStore();
  tabIds = [];
});
afterEach(() => {
  cleanup();
  editorStore.set(initialEditorState());
  for (const id of tabIds) dropHandle(id);
});

describe('ToolStripHost', () => {
  it('renders nothing on the home screen', () => {
    renderHost();
    expect(screen.queryByLabelText('tool strip')).toBeNull();
  });

  it('renders the editor chunk’s strip with the shell’s props for the open document', () => {
    openTab();
    renderHost();
    expect(screen.getByLabelText('tool strip').dataset.session).toBe('true');
  });

  it('renders nothing while the start screen is asked for over a document', () => {
    openTab();
    renderHost();
    act(() => showStartScreen());
    expect(screen.queryByLabelText('tool strip')).toBeNull();
  });

  it('renders nothing for an open document until the editor chunk has arrived', () => {
    editorStore.set(initialEditorState());
    openTab();
    renderHost();
    expect(screen.queryByLabelText('tool strip')).toBeNull();
    act(() => editorStore.set({ surfaces }));
    expect(screen.getByLabelText('tool strip')).toBeTruthy();
  });
});
