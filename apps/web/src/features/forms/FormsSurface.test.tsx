// @vitest-environment happy-dom
/**
 * The forms feature's markup as the user meets it: the XFA banner and what each button does,
 * the review frames on the pages, the forms tab with the detector and the field list, and the
 * dialog that fills a dynamic XFA form.
 */

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FormFieldInfo } from 'pdf-core';
import type { FormDetection } from 'pdf-core/ops/form-detect';
import { SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { FieldCandidateHost, FormsPanel, XfaBanner, XfaFormDialogHost } from './FormsSurface';
import {
  detectFinished,
  detectStarted,
  formInventoryRead,
  formsStore,
  initialFormsState,
  xfaFormOpened,
} from './forms-store';

const ui = vi.hoisted(() => ({ downloadFiles: vi.fn() }));
vi.mock('../../operations', () => ({ downloadFiles: ui.downloadFiles }));
// The XFA dialog renders pdf.js's XFA viewer; what is under test is what the host hands it.
vi.mock('pdf-ui/dialog', () => ({
  XfaFormDialog: (props: {
    bytes: Uint8Array;
    onClose: () => void;
    onSave: (outcome: never) => Promise<void>;
    onExport: (file: { name: string; bytes: Uint8Array; mime: string; values: number }) => void;
  }) => (
    <section aria-label="XFA form dialog">
      <p>{`${props.bytes.byteLength} bytes`}</p>
      <button type="button" onClick={props.onClose}>
        Close
      </button>
      <button type="button" onClick={() => void props.onSave({ changed: 1 } as never)}>
        Save
      </button>
      <button
        type="button"
        onClick={() =>
          props.onExport({ name: 'data.xml', bytes: new Uint8Array([1]), mime: 'text/xml', values: 4 })
        }
      >
        Export
      </button>
    </section>
  ),
}));

const t = createTranslator('en');
const bytes = new Uint8Array([1, 2, 3]);
const viewer = {
  pageGeometry: () => ({ rotation: 0, x: 0, y: 0, width: 600, height: 800 }),
  pageRect: () => ({ x: 0, y: 0, width: 600, height: 800 }),
  containerRect: () => ({ x: 0, y: 0, width: 600, height: 800 }),
} as unknown as ViewerApi;

let store: SessionStore;
let tab: SessionTab;

function candidate(id: string, pageIndex = 0) {
  return {
    id,
    name: `Field ${id}`,
    kind: 'text',
    source: 'line',
    confidence: 'high',
    pageIndex,
    rect: [50, 50, 150, 70],
  };
}

function detection(...ids: string[]): FormDetection {
  return {
    candidates: ids.map((id, index) => candidate(id, index)),
    needsOcr: [],
    rasterPages: [],
    alreadyFields: 0,
    truncated: false,
  } as unknown as FormDetection;
}

function field(name: string, over: Partial<FormFieldInfo> = {}): FormFieldInfo {
  return {
    name,
    kind: 'text',
    value: '',
    readOnly: false,
    required: false,
    maxLength: null,
    options: null,
    pageIndex: 2,
    ...over,
  };
}

function readInventory(extra: { fields?: readonly FormFieldInfo[]; xfa?: { kind: string } | null } = {}) {
  act(() =>
    formInventoryRead({ tabId: tab.id, version: tab.working.id, ...extra } as Parameters<
      typeof formInventoryRead
    >[0]),
  );
}

function review(...ids: string[]) {
  act(() => {
    detectStarted(tab.id, tab.working.id);
    detectFinished(tab.id, tab.working.id, detection(...ids));
  });
}

// The panels and the dialog are dynamic chunks: load them once so no test waits on the import.
beforeAll(async () => {
  await import('pdf-ui/panels');
}, 60_000);
beforeEach(() => {
  coreStore.set(initialCoreState());
  formsStore.set(initialFormsState());
  vi.clearAllMocks();
  store = new SessionStore();
  tab = store.openDocument({ name: 'a.pdf', bytes, sha256: 'a', pageCount: 3 });
});
afterEach(cleanup);

describe('XfaBanner', () => {
  function banner(over: { canEdit?: boolean } = {}) {
    const handlers = { onFill: vi.fn(), onOpenDialog: vi.fn() };
    render(<XfaBanner t={t} tab={tab} canEdit={over.canEdit ?? true} {...handlers} />);
    return handlers;
  }

  it('says nothing for a form without XFA, or before the inventory is read', () => {
    const { container } = render(
      <XfaBanner t={t} tab={tab} canEdit onFill={vi.fn()} onOpenDialog={vi.fn()} />,
    );
    expect(container.textContent).toBe('');
    readInventory({ fields: [], xfa: null });
    expect(container.textContent).toBe('');
  });

  it('offers to fill, flatten or export a dynamic form, and each button does only that', async () => {
    readInventory({ xfa: { kind: 'dynamic' } });
    const user = userEvent.setup();
    const { onFill, onOpenDialog } = banner();
    expect(screen.getByTestId('xfa-banner').textContent).toContain(t('xfa.banner.dynamic'));

    await user.click(screen.getByRole('button', { name: t('xfa.banner.fill') }));
    expect(onFill).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: t('xfa.banner.flatten') }));
    await user.click(screen.getByRole('button', { name: t('xfa.banner.data') }));
    expect(onOpenDialog.mock.calls).toEqual([['xfa-flatten'], ['xfa-data']]);
    expect(screen.queryByRole('button', { name: t('xfa.banner.remove') })).toBeNull();
  });

  it('offers to remove the XFA of a static form, which cannot be filled', async () => {
    readInventory({ xfa: { kind: 'static' } });
    const user = userEvent.setup();
    const { onOpenDialog } = banner();
    expect(screen.getByTestId('xfa-banner').textContent).toContain(t('xfa.banner.static'));
    expect(screen.queryByRole('button', { name: t('xfa.banner.fill') })).toBeNull();

    await user.click(screen.getByRole('button', { name: t('xfa.banner.remove') }));
    await user.click(screen.getByRole('button', { name: t('xfa.banner.data') }));
    expect(onOpenDialog.mock.calls).toEqual([['xfa-remove'], ['xfa-data']]);
  });

  it('shows what is supported only while the details are open', async () => {
    readInventory({ xfa: { kind: 'dynamic' } });
    const user = userEvent.setup();
    banner();
    const more = screen.getByRole('button', { name: t('xfa.banner.more') });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(t('xfa.banner.supported'))).toBeNull();

    await user.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(t('xfa.banner.supported'))).toBeTruthy();
    await user.click(more);
    expect(screen.queryByText(t('xfa.banner.supported'))).toBeNull();
  });

  it('disables filling while busy and the edits on a read-only document', () => {
    readInventory({ xfa: { kind: 'dynamic' } });
    coreStore.set({ busy: true });
    banner({ canEdit: false });
    const disabled = (name: string) => (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;
    expect(disabled(t('xfa.banner.fill'))).toBe(true);
    expect(disabled(t('xfa.banner.flatten'))).toBe(true);
    expect(disabled(t('xfa.banner.data'))).toBe(true);
  });

  it('enables filling again once the document is free', () => {
    readInventory({ xfa: { kind: 'dynamic' } });
    banner();
    expect((screen.getByRole('button', { name: t('xfa.banner.fill') }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    act(() => coreStore.set({ busy: true }));
    expect((screen.getByRole('button', { name: t('xfa.banner.fill') }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('FieldCandidateHost', () => {
  function hosted(over: { viewer?: ViewerApi | null; layout?: number; canEdit?: boolean } = {}) {
    return (
      <FieldCandidateHost
        t={t}
        tab={tab}
        viewer={over.viewer === undefined ? viewer : over.viewer}
        layout={over.layout ?? 0}
        canEdit={over.canEdit ?? true}
      />
    );
  }
  function host(over: { viewer?: ViewerApi | null; layout?: number; canEdit?: boolean } = {}) {
    return render(hosted(over));
  }

  it('draws one frame per candidate while they are under review, and nothing before', () => {
    const { container } = host();
    expect(container.querySelector('[data-field-candidates]')).toBeNull();
    act(() => detectStarted(tab.id, tab.working.id));
    expect(container.querySelector('[data-field-candidates]')).toBeNull();

    review('a', 'b');
    expect(container.querySelectorAll('[data-field-candidate]').length).toBe(2);
  });

  it('places the frames again at a new layout, on the same mounted layer, where the viewer now puts the page', () => {
    let page = { x: 0, y: 0, width: 600, height: 800 };
    const moving = { ...viewer, pageRect: () => page } as unknown as ViewerApi;
    review('a');
    const view = host({ viewer: moving, layout: 0 });
    const frame = () =>
      view.container.querySelector('[data-field-candidate="a"]')?.parentElement as
        | HTMLElement
        | null
        | undefined;
    const first = frame();
    expect(first?.style.left).toBe('50px');
    expect(first?.style.width).toBe('100px');

    // The page is laid out at twice the size, beside the scrolled content's origin.
    page = { x: 50, y: 0, width: 1200, height: 1600 };
    view.rerender(hosted({ viewer: moving, layout: 1 }));
    expect(frame()).toBe(first);
    expect(first?.style.left).toBe('150px');
    expect(first?.style.width).toBe('200px');
  });

  it('draws nothing without a viewer or on a read-only document', () => {
    review('a');
    expect(host({ viewer: null }).container.querySelector('[data-field-candidates]')).toBeNull();
    cleanup();
    expect(host({ canEdit: false }).container.querySelector('[data-field-candidates]')).toBeNull();
  });

  it('selects a frame on click and takes one out with its ✕, which the review remembers', async () => {
    review('a', 'b');
    const user = userEvent.setup();
    const { container } = host();

    await user.click(container.querySelector('[data-field-candidate="b"]') as HTMLElement);
    expect(formsStore.get().formDetect?.selectedId).toBe('b');

    await user.click(container.querySelector('[data-field-candidate-remove="a"]') as HTMLElement);
    expect(container.querySelector('[data-field-candidate="a"]')).toBeNull();
    expect(container.querySelector('[data-field-candidate="b"]')).not.toBeNull();
    expect(formsStore.get().formDetect?.removed).toEqual(new Set(['a']));
  });
});

describe('FormsPanel', () => {
  function panel(over: { canEdit?: boolean } = {}) {
    const handlers = {
      goToPage: vi.fn(),
      onDetect: vi.fn(),
      onApply: vi.fn(),
      onFill: vi.fn(),
    };
    render(<FormsPanel t={t} tab={tab} canEdit={over.canEdit ?? true} {...handlers} />);
    return handlers;
  }

  it('says what detecting fields does, once the panel has loaded', async () => {
    panel();
    expect(await screen.findByText(t('formDetect.panel.intro'))).toBeTruthy();
    expect(screen.queryByText(t('panel.forms'))).toBeNull();
  });

  it('starts the detector from the button, unless the document cannot be edited', async () => {
    const user = userEvent.setup();
    const { onDetect } = panel();
    await user.click(await screen.findByRole('button', { name: t('formDetect.panel.start') }));
    expect(onDetect).toHaveBeenCalledOnce();
    cleanup();

    const readOnly = panel({ canEdit: false });
    const start = (await screen.findByRole('button', {
      name: t('formDetect.panel.start'),
    })) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(readOnly.onDetect).not.toHaveBeenCalled();
  });

  it('shows the scan in progress', async () => {
    act(() => detectStarted(tab.id, tab.working.id));
    panel();
    expect(await screen.findByText(t('formDetect.panel.scanning'))).toBeTruthy();
  });

  it('lists the candidates; picking one selects it and walks the viewer to its page', async () => {
    review('a', 'b');
    const user = userEvent.setup();
    const { goToPage } = panel();
    const list = await screen.findByRole('list', { name: t('formDetect.panel.list') });

    await user.click(within(list).getByText('Field b'));
    expect(formsStore.get().formDetect?.selectedId).toBe('b');
    expect(goToPage).toHaveBeenCalledWith(1);
  });

  it('takes a candidate out, restores them all, applies the rest and cancels the review', async () => {
    review('a', 'b');
    const user = userEvent.setup();
    const { onApply } = panel();

    await user.click(
      await screen.findByRole('button', { name: t('formDetect.remove', { name: 'Field a' }) }),
    );
    expect(formsStore.get().formDetect?.removed).toEqual(new Set(['a']));
    await user.click(screen.getByRole('button', { name: t('formDetect.panel.restore') }));
    expect(formsStore.get().formDetect?.removed).toEqual(new Set());

    await user.click(screen.getByRole('button', { name: t('formDetect.panel.create', { count: 2 }) }));
    expect(onApply).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: t('formDetect.panel.cancel') }));
    expect(formsStore.get().formDetect).toBeNull();
  });

  it('says the field list is loading, then that the document has no fields', async () => {
    const { container } = render(
      <FormsPanel
        t={t}
        tab={tab}
        canEdit
        goToPage={vi.fn()}
        onDetect={vi.fn()}
        onApply={vi.fn()}
        onFill={vi.fn()}
      />,
    );
    await screen.findByText(t('formDetect.panel.intro'));
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    readInventory({ fields: [] });
    expect(await screen.findByText(t('form.panel.empty'))).toBeTruthy();
  });

  it('lists the fields; picking one remembers it and walks the viewer to its page', async () => {
    readInventory({ fields: [field('Name'), field('Floating', { pageIndex: null })] });
    const user = userEvent.setup();
    const { goToPage } = panel();
    const rows = await screen.findByRole('list', { name: t('panel.forms') });

    await user.click(within(rows).getByText('Name'));
    expect(formsStore.get().selectedField).toBe('Name');
    expect(goToPage).toHaveBeenCalledWith(2);

    await user.click(within(rows).getByText('Floating'));
    expect(formsStore.get().selectedField).toBe('Floating');
    expect(goToPage).toHaveBeenCalledTimes(1);
  });

  it('hands a committed value to the shell', async () => {
    readInventory({ fields: [field('Agree', { kind: 'checkbox', value: false })] });
    const user = userEvent.setup();
    const { onFill } = panel();
    await user.click(await screen.findByRole('checkbox'));
    expect(onFill).toHaveBeenCalledWith('Agree', true);
  });

  it('shows why the inventory could not be read and reads it again on retry', async () => {
    const error = new ToolError('internal', { engine: 'model' });
    act(() => formInventoryRead({ tabId: tab.id, version: tab.working.id, error }));
    const user = userEvent.setup();
    panel();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t(error.messageKey));
    expect(alert.textContent).toContain(t(error.hintKey));
    expect(screen.queryByRole('list', { name: t('panel.forms') })).toBeNull();

    await user.click(screen.getByRole('button', { name: t('inspection.retry') }));
    expect(formsStore.get().inspectionRevision).toBe(1);
  });
});

describe('XfaFormDialogHost', () => {
  it('shows nothing until a form is opened', () => {
    const { container } = render(<XfaFormDialogHost t={t} onSave={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('opens on the frozen bytes, saves through the shell, exports a download and closes', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<XfaFormDialogHost t={t} onSave={onSave} />);
    act(() => xfaFormOpened({ tab, bytes }));

    const dialog = await screen.findByRole('region', { name: 'XFA form dialog' });
    expect(within(dialog).getByText('3 bytes')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ changed: 1 });

    await user.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(ui.downloadFiles).toHaveBeenCalledWith([
      { name: 'data.xml', bytes: new Uint8Array([1]), mime: 'text/xml' },
    ]);

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(formsStore.get().xfaForm).toBeNull();
    expect(screen.queryByRole('region', { name: 'XFA form dialog' })).toBeNull();
  });
});
