// @vitest-environment happy-dom
/**
 * The strip under the header shows what the armed tool offers (or the protected-copy notice) and
 * the XFA banner. The tool settings and the ruler's strip are pdf-ui's and the measure feature's
 * own; here they are stand-ins that expose the props the shell wires. The XFA banner is real.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { annotationsStore, initialAnnotationsState } from '../annotations/annotations-store';
import { coreStore, initialCoreState, selectTool } from '../core/core-store';
import { adoptHandle } from '../core/handles';
import {
  existingInventoryRead,
  formInventoryRead,
  formsStore,
  initialFormsState,
} from '../forms/forms-store';
import { writeRedactions } from '../marks/redaction';
import { armMeasure, initialMeasureState, measureStore } from '../measure/measure-store';
import { hideStartScreen, initialOpenState, lockTab, openStore } from '../open/open-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import { initialSelectionState, selectionStore, selectMarks } from '../selection/selection-store';
import { ToolStrip } from './ToolStrip';

vi.mock('pdf-ui/tools', async (original) => {
  const { createElement } = await import('react');
  type Handler<A extends unknown[] = []> = (...args: A) => void;
  return {
    ...(await original<typeof import('pdf-ui/tools')>()),
    ToolProperties: (props: {
      tool: string;
      color: string;
      opacity: number;
      thickness: number;
      author: string;
      shape: string;
      textColor: string;
      fontSize: number;
      redactionCount: number;
      selectedCount: number;
      disabled: boolean;
      onApplyRedaction: Handler;
      onTool: Handler<[string]>;
      onColor: Handler<[string]>;
      onOpacity: Handler<[number]>;
      onThickness: Handler<[number]>;
      onAuthor: Handler<[string]>;
      onTextColor: Handler<[string]>;
      onFontSize: Handler<[number]>;
      onShape: Handler<[string]>;
      onDeleteSelection: Handler;
      onRotateSelection: Handler;
      onMoveSelection: Handler<[number, number]>;
      onClearSelection: Handler;
    }) =>
      createElement(
        'section',
        {
          'aria-label': 'tool properties',
          'data-tool': props.tool,
          'data-color': props.color,
          'data-opacity': String(props.opacity),
          'data-thickness': String(props.thickness),
          'data-author': props.author,
          'data-shape': props.shape,
          'data-text-color': props.textColor,
          'data-font-size': String(props.fontSize),
          'data-redactions': String(props.redactionCount),
          'data-selected': String(props.selectedCount),
          'data-disabled': String(props.disabled),
        },
        createElement('button', { type: 'button', onClick: props.onApplyRedaction }, 'apply redaction'),
        createElement('button', { type: 'button', onClick: () => props.onTool('ink') }, 'tool ink'),
        createElement('button', { type: 'button', onClick: () => props.onColor('#112233') }, 'color'),
        createElement('button', { type: 'button', onClick: () => props.onOpacity(0.7) }, 'opacity'),
        createElement('button', { type: 'button', onClick: () => props.onThickness(5) }, 'thickness'),
        createElement('button', { type: 'button', onClick: () => props.onAuthor('Ann') }, 'author'),
        createElement(
          'button',
          { type: 'button', onClick: () => props.onTextColor('#445566') },
          'text color',
        ),
        createElement('button', { type: 'button', onClick: () => props.onFontSize(18) }, 'font size'),
        createElement('button', { type: 'button', onClick: () => props.onShape('circle') }, 'shape'),
        createElement('button', { type: 'button', onClick: props.onDeleteSelection }, 'delete selection'),
        createElement('button', { type: 'button', onClick: props.onRotateSelection }, 'rotate selection'),
        createElement(
          'button',
          { type: 'button', onClick: () => props.onMoveSelection(5, 6) },
          'move selection',
        ),
        createElement('button', { type: 'button', onClick: props.onClearSelection }, 'clear selection'),
      ),
  };
});
vi.mock('../measure/MeasureSettingsStrip', async () => {
  const { createElement } = await import('react');
  return {
    MeasureSettingsStrip: (props: {
      color: string;
      opacity: number;
      thickness: number;
      author: string;
      onColor: (color: string) => void;
      onOpacity: (opacity: number) => void;
      onThickness: (thickness: number) => void;
      onAuthor: (author: string) => void;
    }) =>
      createElement(
        'section',
        {
          'aria-label': 'measure settings',
          'data-color': props.color,
          'data-opacity': String(props.opacity),
          'data-thickness': String(props.thickness),
          'data-author': props.author,
        },
        createElement('button', { type: 'button', onClick: () => props.onColor('#aabbcc') }, 'measure color'),
        createElement('button', { type: 'button', onClick: () => props.onOpacity(0.9) }, 'measure opacity'),
        createElement('button', { type: 'button', onClick: () => props.onThickness(7) }, 'measure thickness'),
        createElement('button', { type: 'button', onClick: () => props.onAuthor('Bob') }, 'measure author'),
      ),
  };
});

const t = createTranslator('en');
const handle = { id: 'h' } as unknown as PdfDocumentHandle;
const viewer = { document: handle } as unknown as ViewerApi;
let session: SessionStore;
let actions: {
  openDialog: Mock;
  openXfaForm: Mock;
  unlockActiveCopy: Mock;
  removeTargets: Mock;
  transformTargets: Mock;
};

function openTab() {
  const tab = session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 2 });
  adoptHandle(tab.id, handle);
  hideStartScreen();
  return tab;
}

function mount() {
  return render(<ToolStrip session={session} tier="desktop" t={t} actions={actions} />);
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  openStore.set(initialOpenState());
  formsStore.set(initialFormsState());
  annotationsStore.set(initialAnnotationsState());
  measureStore.set(initialMeasureState());
  selectionStore.set(initialSelectionState());
  session = new SessionStore();
  actions = {
    openDialog: vi.fn(),
    openXfaForm: vi.fn(),
    unlockActiveCopy: vi.fn(async () => undefined),
    removeTargets: vi.fn(async () => undefined),
    transformTargets: vi.fn(async () => undefined),
  };
});

describe('ToolStrip', () => {
  it('shows nothing with no document, behind the start screen or before the engine has opened it', () => {
    mount();
    expect(screen.queryByLabelText('tool properties')).toBeNull();
    cleanup();
    session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 2 });
    hideStartScreen();
    mount();
    expect(screen.queryByLabelText('tool properties')).toBeNull();
    cleanup();
    openTab();
    openStore.set({ showHomeScreen: true });
    mount();
    expect(screen.queryByLabelText('tool properties')).toBeNull();
  });

  it('shows the armed tool, the annotation style, the shape and the counts', () => {
    openTab();
    coreStore.set({ canvasTool: 'ink', shape: 'line' });
    annotationsStore.set({
      style: {
        color: '#abcdef',
        textColor: '#123456',
        fontSize: 14,
        opacity: 0.5,
        thickness: 3,
        author: 'Zed',
      },
    });
    selectMarks(['a', 'b']);
    writeRedactions(session, [{ id: 'r1', mark: { page: 0, x: 0, y: 0, width: 1, height: 1 } } as never]);
    mount();
    const properties = screen.getByLabelText('tool properties');
    expect(properties.getAttribute('data-tool')).toBe('ink');
    expect(properties.getAttribute('data-shape')).toBe('line');
    expect(properties.getAttribute('data-color')).toBe('#abcdef');
    expect(properties.getAttribute('data-text-color')).toBe('#123456');
    expect(properties.getAttribute('data-font-size')).toBe('14');
    expect(properties.getAttribute('data-opacity')).toBe('0.5');
    expect(properties.getAttribute('data-thickness')).toBe('3');
    expect(properties.getAttribute('data-author')).toBe('Zed');
    expect(properties.getAttribute('data-selected')).toBe('2');
    expect(properties.getAttribute('data-redactions')).toBe('1');
  });

  it('writes the tool settings through to the annotation style and the core store', async () => {
    const user = userEvent.setup();
    openTab();
    mount();
    await user.click(screen.getByRole('button', { name: 'color' }));
    await user.click(screen.getByRole('button', { name: 'opacity' }));
    await user.click(screen.getByRole('button', { name: 'thickness' }));
    await user.click(screen.getByRole('button', { name: 'author' }));
    await user.click(screen.getByRole('button', { name: 'text color' }));
    await user.click(screen.getByRole('button', { name: 'font size' }));
    expect(annotationsStore.get().style).toEqual({
      color: '#112233',
      opacity: 0.7,
      thickness: 5,
      author: 'Ann',
      textColor: '#445566',
      fontSize: 18,
    });
    await user.click(screen.getByRole('button', { name: 'shape' }));
    expect(coreStore.get().shape).toBe('circle');
    await user.click(screen.getByRole('button', { name: 'tool ink' }));
    expect(coreStore.get().canvasTool).toBe('ink');
  });

  it('opens the redaction dialog and routes the selection actions to the marks', async () => {
    const user = userEvent.setup();
    openTab();
    selectMarks(['a', 'b']);
    mount();
    await user.click(screen.getByRole('button', { name: 'apply redaction' }));
    expect(actions.openDialog).toHaveBeenCalledWith('redact');
    await user.click(screen.getByRole('button', { name: 'delete selection' }));
    expect(actions.removeTargets).toHaveBeenCalledWith(['a', 'b']);
    await user.click(screen.getByRole('button', { name: 'rotate selection' }));
    expect(actions.transformTargets).toHaveBeenLastCalledWith(['a', 'b'], { dx: 0, dy: 0, rotation: 90 });
    await user.click(screen.getByRole('button', { name: 'move selection' }));
    expect(actions.transformTargets).toHaveBeenLastCalledWith(['a', 'b'], { dx: 5, dy: 6, rotation: 0 });
    await user.click(screen.getByRole('button', { name: 'clear selection' }));
    expect(selectionStore.get().selectedKeys).toEqual([]);
    expect(screen.getByLabelText('tool properties').getAttribute('data-selected')).toBe('0');
  });

  it('disables the settings until the document can be edited and, in select, its annotations are read', () => {
    const tab = openTab();
    mount();
    // No viewer yet: the document cannot be edited.
    expect(screen.getByLabelText('tool properties').getAttribute('data-disabled')).toBe('true');
    act(() => viewerChanged(viewer));
    // Editable, but the select tool needs the file's annotation inventory.
    expect(screen.getByLabelText('tool properties').getAttribute('data-disabled')).toBe('true');
    act(() => selectTool('ink'));
    expect(screen.getByLabelText('tool properties').getAttribute('data-disabled')).toBe('false');
    act(() => selectTool('select'));
    expect(screen.getByLabelText('tool properties').getAttribute('data-disabled')).toBe('true');
    act(() => existingInventoryRead({ tabId: tab.id, bytesKey: 'source', annotations: [] }));
    expect(screen.getByLabelText('tool properties').getAttribute('data-disabled')).toBe('false');
    act(() => coreStore.set({ busy: true }));
    expect(screen.getByLabelText('tool properties').getAttribute('data-disabled')).toBe('true');
  });

  it('offers the ruler its own settings, which edit the shared annotation style', async () => {
    const user = userEvent.setup();
    openTab();
    viewerChanged(viewer);
    armMeasure('area');
    mount();
    expect(screen.queryByLabelText('tool properties')).toBeNull();
    expect(screen.getByLabelText('measure settings').getAttribute('data-color')).toBe('#ffd400');
    await user.click(screen.getByRole('button', { name: 'measure color' }));
    await user.click(screen.getByRole('button', { name: 'measure opacity' }));
    await user.click(screen.getByRole('button', { name: 'measure thickness' }));
    await user.click(screen.getByRole('button', { name: 'measure author' }));
    expect(annotationsStore.get().style).toMatchObject({
      color: '#aabbcc',
      opacity: 0.9,
      thickness: 7,
      author: 'Bob',
    });
    const settings = screen.getByLabelText('measure settings');
    expect(settings.getAttribute('data-color')).toBe('#aabbcc');
    expect(settings.getAttribute('data-author')).toBe('Bob');
  });

  it('keeps the tool settings while the ruler has no viewer to measure on', () => {
    openTab();
    armMeasure('distance');
    mount();
    expect(screen.queryByLabelText('measure settings')).toBeNull();
    expect(screen.getByLabelText('tool properties').getAttribute('data-tool')).toBe('measure');
  });

  it('says a protected copy is read-only and offers to unlock a copy, unless an operation runs', async () => {
    const user = userEvent.setup();
    const tab = openTab();
    viewerChanged(viewer);
    armMeasure('area');
    lockTab(tab.id, 'secret');
    mount();
    expect(screen.getByRole('status').textContent).toContain(t('locked.banner'));
    expect(screen.queryByLabelText('tool properties')).toBeNull();
    expect(screen.queryByLabelText('measure settings')).toBeNull();
    const unlock = screen.getByRole('button', { name: t('locked.unlockCopy') });
    await user.click(unlock);
    expect(actions.unlockActiveCopy).toHaveBeenCalledTimes(1);
    act(() => coreStore.set({ busy: true }));
    expect((screen.getByRole('button', { name: t('locked.unlockCopy') }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('wires the XFA banner to the form opener and the operation dialogs', async () => {
    const user = userEvent.setup();
    const tab = openTab();
    viewerChanged(viewer);
    formInventoryRead({
      tabId: tab.id,
      version: tab.working.id,
      fields: [],
      xfa: { kind: 'dynamic' },
    } as never);
    mount();
    expect(screen.getByTestId('xfa-banner')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('xfa.banner.fill') }));
    expect(actions.openXfaForm).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: t('xfa.banner.flatten') }));
    expect(actions.openDialog).toHaveBeenLastCalledWith('xfa-flatten');
    await user.click(screen.getByRole('button', { name: t('xfa.banner.data') }));
    expect(actions.openDialog).toHaveBeenLastCalledWith('xfa-data');
    // Only an editable document may change the XFA form.
    act(() => coreStore.set({ busy: true }));
    expect(
      (screen.getByRole('button', { name: t('xfa.banner.flatten') }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows no XFA banner for a form without XFA', () => {
    const tab = openTab();
    formInventoryRead({ tabId: tab.id, version: tab.working.id, fields: [] } as never);
    mount();
    expect(screen.queryByTestId('xfa-banner')).toBeNull();
  });
});
