// @vitest-environment happy-dom
/**
 * The dialogs store: what each action writes, and that a component reading one field renders
 * for that field only.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import type { OperationDialogSpec } from 'pdf-ui/ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeBatchDialog,
  closeStartDialog,
  type DialogInput,
  dialogsStore,
  dismissOperationDialog,
  initialDialogsState,
  openBatchDialog,
  operationDialogOpened,
  shortcutsClosed,
  shortcutsOpened,
  startDialogOpened,
  useDialogs,
} from './dialogs-store';

const spec = { id: 'compress' } as unknown as OperationDialogSpec;
const other = { id: 'merge' } as unknown as OperationDialogSpec;
const input: DialogInput = {
  tabId: 'tab-1',
  workingId: 'work-1',
  name: 'a.pdf',
  pageCount: 3,
  bytes: new Uint8Array([1, 2, 3]),
};

beforeEach(() => dialogsStore.set(initialDialogsState()));
afterEach(cleanup);

describe('the dialogs store', () => {
  it('starts with every dialog closed', () => {
    expect(dialogsStore.get()).toEqual({
      batchOpen: false,
      dialogSpec: null,
      dialogInput: null,
      startSpec: null,
      shortcutsOpen: false,
      shortcutsTrigger: null,
    });
  });

  it('opens and closes the batch dialog', () => {
    openBatchDialog();
    expect(dialogsStore.get().batchOpen).toBe(true);
    closeBatchDialog();
    expect(dialogsStore.get().batchOpen).toBe(false);
  });

  it('holds the operation dialog and its frozen input together until it is dismissed', () => {
    operationDialogOpened(input, spec);
    expect(dialogsStore.get()).toMatchObject({ dialogInput: input, dialogSpec: spec });
    dismissOperationDialog();
    expect(dialogsStore.get()).toMatchObject({ dialogInput: null, dialogSpec: null });
  });

  it('keeps the standalone operation apart from the operation dialog', () => {
    operationDialogOpened(input, spec);
    startDialogOpened(other);
    expect(dialogsStore.get()).toMatchObject({ dialogSpec: spec, startSpec: other });
    dismissOperationDialog();
    expect(dialogsStore.get().startSpec).toBe(other);
    closeStartDialog();
    expect(dialogsStore.get().startSpec).toBeNull();
  });

  it('remembers what had the focus when the shortcut list opened, and keeps it once closed', () => {
    const opener = document.createElement('button');
    shortcutsOpened(opener);
    expect(dialogsStore.get()).toMatchObject({ shortcutsOpen: true, shortcutsTrigger: opener });
    shortcutsClosed();
    expect(dialogsStore.get()).toMatchObject({ shortcutsOpen: false, shortcutsTrigger: opener });
  });

  it('re-renders a component for the field it reads and for no other', () => {
    let renders = 0;
    function Probe() {
      const batchOpen = useDialogs((state) => state.batchOpen);
      renders += 1;
      return <p>{batchOpen ? 'batch open' : 'batch closed'}</p>;
    }
    render(<Probe />);
    expect(screen.getByText('batch closed')).toBeTruthy();
    const before = renders;

    act(() => startDialogOpened(spec));
    act(() => shortcutsOpened(null));
    expect(renders).toBe(before);

    act(() => openBatchDialog());
    expect(screen.getByText('batch open')).toBeTruthy();
  });
});
