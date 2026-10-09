/**
 * The simple/advanced split (`commands.ts`).
 *
 * The split is a discovery filter, so the tests answer two questions and nothing else:
 * does the simple mode keep the capabilities a free reader carries, and does it hide the
 * ones that belong to an advanced tool? A regression in either direction is a real bug —
 * hiding signing makes the mode less capable than the software it is measured against,
 * and leaving redaction in makes "simple" meaningless.
 */

import type { Command } from 'pdf-ui';
import { describe, expect, it, vi } from 'vitest';
import type { CommandHost, InterfaceMode } from './commands';
import {
  buildCommands,
  isCommandVisible,
  SIMPLE_MODE_DOCK_TABS,
  SOURCE_URL,
  visibleCommands,
} from './commands';

/** The smallest host every command builder accepts; every capability is available. */
function host(overrides: Partial<CommandHost> = {}): CommandHost {
  const noop = () => undefined;
  return {
    t: ((key: string) => key) as CommandHost['t'],
    mode: 'advanced',
    hasDocument: true,
    canEdit: true,
    canUndo: true,
    canRedo: true,
    canSave: true,
    canExport: true,
    selectedPages: [0],
    zoom: 1,
    magnifier: false,
    reading: false,
    leftDock: true,
    rightDock: true,
    openFile: noop,
    save: noop,
    exportDocument: noop,
    print: noop,
    undo: noop,
    redo: noop,
    rename: noop,
    closeTab: noop,
    openDialog: noop,
    showShortcuts: noop,
    openSettings: noop,
    openBatch: noop,
    openSignature: noop,
    addImage: noop,
    measure: noop,
    measureMode: null,
    showRightTab: noop,
    openLeftTab: noop,
    pageAction: noop,
    setZoom: noop,
    setSpread: noop,
    toggleFullscreen: noop,
    toggleReading: noop,
    toggleLeftDock: noop,
    toggleRightDock: noop,
    toggleMagnifier: noop,
    openSnapshot: noop,
    selectAllPages: noop,
    clearSelection: noop,
    palette: noop,
    activeTool: 'select',
    armTool: noop,
    selectedMarkCount: 0,
    deleteMarkSelection: noop,
    selectAllMarks: noop,
    showRedactionAudit: noop,
    theme: 'system',
    setTheme: noop,
    sensitiveSession: false,
    toggleSensitiveSession: noop,
    opfsSave: noop,
    purgeActiveDocument: noop,
    sweepVault: noop,
    checkOffline: noop,
    prepareOfflinePackages: noop,
    ...overrides,
  };
}

const ALL = buildCommands(host());

function ids(mode: InterfaceMode): readonly string[] {
  return visibleCommands(ALL, mode).map((command) => command.id);
}

describe('the simple mode keeps what a free reader carries', () => {
  it.each([
    'file.save',
    'file.export',
    'file.print',
    'edit.undo',
    'edit.redo',
    'view.fit-page',
    'view.reading',
    'page.rotate-right',
    'page.delete',
    'page.extract',
    'tools.highlight',
    'tools.text-edit',
    'tools.note',
    'tools.sign',
    'tools.form-fields',
    'help.source',
  ])('offers %s', (id) => {
    expect(ids('simple')).toContain(id);
  });

  it('does not offer the capabilities the reference readers put behind a paid tier', () => {
    const advanced = new Set(ids('advanced'));
    for (const id of [
      'tools.redact',
      'tools.redaction-audit',
      'tools.security',
      'tools.unlock',
      'tools.optimize',
      'file.batch',
      'tools.compare',
      'tools.accessibility',
      'tools.measure-distance',
      'view.layers',
      'tools.outline-edit',
      'settings.purge-document',
      'settings.sweep-vault',
      'help.prepare-offline',
    ]) {
      // Absent from a mode proves nothing for an id the builder never produces.
      expect(advanced.has(id), `${id} is a command the advanced mode offers`).toBe(true);
      expect(ids('simple'), id).not.toContain(id);
    }
  });
});

describe('the advanced mode hides nothing', () => {
  it('offers every command the builder produced', () => {
    expect(new Set(ids('advanced'))).toEqual(new Set(ALL.map((command) => command.id)));
  });
});

describe('isCommandVisible', () => {
  const command = {
    id: 'tools.redact',
    labelKey: 'redact.title',
    group: 'tools',
    run: () => undefined,
  } as Command;

  it('filters only in the simple mode', () => {
    expect(isCommandVisible(command, 'simple')).toBe(false);
    expect(isCommandVisible(command, 'advanced')).toBe(true);
  });
});

describe('the simple mode dock tabs', () => {
  // Tab ids are a TypeScript union (`DocumentPanelTab`), so a misspelt one does not compile;
  // the rail groups, which are plain strings, are rendered in `simple-mode-surface.test.tsx`.
  it('keeps the tabs that answer "what is in this document" and nothing advanced', () => {
    expect([...SIMPLE_MODE_DOCK_TABS]).toEqual(['pages', 'outline', 'search']);
  });
});

describe('the source-code command', () => {
  it('opens the public repository in a new tab, detached from the app', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    try {
      const source = ALL.find((command) => command.id === 'help.source');
      source?.run();
      expect(open).toHaveBeenCalledWith(SOURCE_URL, '_blank', 'noopener,noreferrer');
      expect(SOURCE_URL).toBe('https://github.com/isolmaz/ss-pdf-editor');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
