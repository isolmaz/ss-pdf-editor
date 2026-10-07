/**
 * The command list: each entry must do exactly what its id says (a menu item that opens the
 * wrong dialog is invisible to every other test), be disabled for the states the host
 * reports, and be filtered by the interface mode the way the palette expects.
 */

import type { Translator } from 'pdf-shared';
import type { Command } from 'pdf-ui';
import type { CanvasToolId } from 'pdf-ui/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCommands,
  type CommandHost,
  commandKeywords,
  isCommandVisible,
  SOURCE_URL,
  STANDALONE_COMMAND_IDS,
  visibleCommands,
} from './commands';

type Call = readonly [string, ...unknown[]];

const t = ((key: string) => key) as unknown as Translator;

/** A host whose every callback records its name and arguments; the state is overridable. */
function recordingHost(overrides: Partial<CommandHost> = {}) {
  const calls: Call[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const host: CommandHost = {
    t,
    mode: 'advanced',
    useAdvancedMode: rec('useAdvancedMode'),
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
    rightDock: false,
    openFile: rec('openFile'),
    save: rec('save'),
    exportDocument: rec('exportDocument'),
    print: rec('print'),
    undo: rec('undo'),
    redo: rec('redo'),
    rename: rec('rename'),
    closeTab: rec('closeTab'),
    openDialog: rec('openDialog'),
    openXfaForm: rec('openXfaForm'),
    showShortcuts: rec('showShortcuts'),
    openSettings: rec('openSettings'),
    openBatch: rec('openBatch'),
    openSignature: rec('openSignature'),
    addImage: rec('addImage'),
    measure: rec('measure'),
    measureMode: null,
    showRightTab: rec('showRightTab'),
    detectFormFields: rec('detectFormFields'),
    openLeftTab: rec('openLeftTab'),
    pageAction: rec('pageAction'),
    setZoom: rec('setZoom'),
    setSpread: rec('setSpread'),
    toggleFullscreen: rec('toggleFullscreen'),
    toggleReading: rec('toggleReading'),
    toggleMagnifier: rec('toggleMagnifier'),
    openSnapshot: rec('openSnapshot'),
    toggleLeftDock: rec('toggleLeftDock'),
    toggleRightDock: rec('toggleRightDock'),
    selectAllPages: rec('selectAllPages'),
    clearSelection: rec('clearSelection'),
    palette: rec('palette'),
    activeTool: 'select',
    armTool: rec('armTool'),
    selectedMarkCount: 2,
    deleteMarkSelection: rec('deleteMarkSelection'),
    selectAllMarks: rec('selectAllMarks'),
    showRedactionAudit: rec('showRedactionAudit'),
    theme: 'system',
    setTheme: rec('setTheme'),
    sensitiveSession: false,
    toggleSensitiveSession: rec('toggleSensitiveSession'),
    opfsSave: rec('opfsSave'),
    purgeActiveDocument: rec('purgeActiveDocument'),
    sweepVault: rec('sweepVault'),
    checkOffline: rec('checkOffline'),
    prepareOfflinePackages: rec('prepareOfflinePackages'),
    ...overrides,
  };
  return { host, calls };
}

const dialog = (id: string): Call => ['openDialog', id];
const tool = (id: CanvasToolId): Call => ['armTool', id];

/** What running each command must ask of the host, for a document at 100% zoom with the select tool armed. */
const EXPECTED: Readonly<Record<string, Call>> = {
  'file.new': dialog('new-document'),
  'file.open': ['openFile'],
  'file.merge': dialog('merge-files'),
  'file.convert': dialog('convert-to-pdf'),
  'file.save': ['save'],
  'file.export': ['exportDocument'],
  'file.add': dialog('add-document'),
  'file.batch': ['openBatch'],
  'file.create-images': dialog('images-to-pdf'),
  'file.scan': dialog('scan-camera'),
  'file.print': ['print'],
  'file.close': ['closeTab'],
  'edit.undo': ['undo'],
  'edit.redo': ['redo'],
  'edit.select-all-pages': ['selectAllPages'],
  'edit.clear-selection': ['clearSelection'],
  'edit.delete-mark': ['deleteMarkSelection'],
  'edit.select-all-marks': ['selectAllMarks'],
  'edit.find-replace': dialog('find-replace'),
  'edit.rename': ['rename'],
  'view.zoom-in': ['setZoom', 1.25],
  'view.zoom-out': ['setZoom', 0.75],
  'view.zoom-reset': ['setZoom', 1],
  'view.fit-width': ['setZoom', 'page-width'],
  'view.fit-page': ['setZoom', 'page-fit'],
  'view.single': ['setSpread', 'single'],
  'view.book': ['setSpread', 'book'],
  'view.fullscreen': ['toggleFullscreen'],
  'view.reading': ['toggleReading'],
  'view.magnifier': ['toggleMagnifier'],
  'view.snapshot': ['openSnapshot'],
  'view.layers': ['openLeftTab', 'layers'],
  'view.outline': ['openLeftTab', 'outline'],
  'view.left-dock': ['toggleLeftDock'],
  'view.right-dock': ['toggleRightDock'],
  'page.rotate-left': ['pageAction', { kind: 'rotate', direction: 'left' }],
  'page.rotate-right': ['pageAction', { kind: 'rotate', direction: 'right' }],
  'page.duplicate': ['pageAction', { kind: 'duplicate' }],
  'page.delete': ['pageAction', { kind: 'delete' }],
  'page.extract': dialog('extract-pages'),
  'page.insert': dialog('insert-pages'),
  'page.replace': dialog('replace-pages'),
  'page.split': dialog('split'),
  'page.boxes': dialog('page-boxes'),
  'page.labels': dialog('page-labels'),
  'tools.numbering': dialog('page-numbers'),
  'tools.watermark': dialog('watermark'),
  'tools.optimize': dialog('compress'),
  'tools.redact': dialog('redact'),
  'tools.security': dialog('protect'),
  'tools.unlock': dialog('unlock'),
  'tools.sanitize': dialog('sanitize'),
  'tools.properties': dialog('properties'),
  'tools.export-images': dialog('export-images'),
  'tools.export-text': dialog('export-text'),
  'tools.export-office': dialog('export-office'),
  'tools.pdfa': dialog('pdfa'),
  'tools.pdfa-check': ['showRightTab', 'pdfa'],
  'tools.outline-edit': dialog('outline-edit'),
  'tools.impose': dialog('impose'),
  'tools.ocr': dialog('ocr'),
  'tools.select': tool('select'),
  'tools.hand': tool('hand'),
  'tools.highlight': tool('highlight'),
  'tools.text-edit': tool('text'),
  'tools.underline': tool('underline'),
  'tools.strikeout': tool('strikeout'),
  'tools.squiggly': tool('squiggly'),
  'tools.ink': tool('ink'),
  'tools.shapes': tool('shapes'),
  'tools.note': tool('note'),
  'tools.link': tool('link'),
  'tools.image-edit': dialog('image-edit'),
  'tools.measure-distance': ['measure', 'distance'],
  'tools.measure-perimeter': ['measure', 'perimeter'],
  'tools.measure-area': ['measure', 'area'],
  'tools.compare': ['showRightTab', 'compare'],
  'tools.accessibility': ['showRightTab', 'accessibility'],
  'tools.sign': dialog('sign'),
  'tools.signature-simple': ['openSignature'],
  'tools.image-add': ['addImage'],
  'tools.form-fields': dialog('form-fields'),
  'tools.form-create': dialog('form-create-field'),
  'tools.form-detect': ['detectFormFields'],
  'tools.form-data': dialog('form-data'),
  'tools.xfa-fill': ['openXfaForm'],
  'tools.xfa-remove': dialog('xfa-remove'),
  'tools.xfa-flatten': dialog('xfa-flatten'),
  'tools.xfa-data': dialog('xfa-data'),
  'tools.redaction-audit': ['showRedactionAudit'],
  'settings.open': ['openSettings'],
  'settings.theme.light': ['setTheme', 'light'],
  'settings.theme.dark': ['setTheme', 'dark'],
  'settings.theme.system': ['setTheme', 'system'],
  'settings.sensitive-session': ['toggleSensitiveSession'],
  'settings.opfs-save': ['opfsSave'],
  'settings.purge-document': ['purgeActiveDocument'],
  'settings.sweep-vault': ['sweepVault'],
  'help.palette': ['palette'],
  'help.shortcuts': ['showShortcuts'],
  'help.offline': ['checkOffline'],
  'help.prepare-offline': ['prepareOfflinePackages'],
};

const byId = (commands: readonly Command[], id: string): Command => {
  const found = commands.find((command) => command.id === id);
  if (found === undefined) throw new Error(`no command ${id}`);
  return found;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildCommands', () => {
  it('lists each id once, and exactly the ids this table knows (plus the source link)', () => {
    const ids = buildCommands(recordingHost().host).map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...Object.keys(EXPECTED), 'help.source'].sort());
  });

  it('runs, for every command, exactly the host call its id names', () => {
    for (const [id, expected] of Object.entries(EXPECTED)) {
      const { host, calls } = recordingHost();
      byId(buildCommands(host), id).run();
      expect(calls, id).toEqual([expected]);
    }
  });

  it('opens the source repository in a new tab without handing it the opener', () => {
    const opened: unknown[][] = [];
    vi.stubGlobal('window', { open: (...args: unknown[]) => opened.push(args) });
    byId(buildCommands(recordingHost().host), 'help.source').run();
    expect(opened).toEqual([[SOURCE_URL, '_blank', 'noopener,noreferrer']]);
  });

  it('zooms in and out by a quarter, never past 400% or under 25%', () => {
    const zoomed = (id: string, zoom: number) => {
      const { host, calls } = recordingHost({ zoom });
      byId(buildCommands(host), id).run();
      return calls[0]?.[1];
    };
    expect(zoomed('view.zoom-in', 3.9)).toBe(4);
    expect(zoomed('view.zoom-in', 4)).toBe(4);
    expect(zoomed('view.zoom-out', 0.3)).toBe(0.25);
    expect(zoomed('view.zoom-out', 0.25)).toBe(0.25);
  });

  it('puts an armed tool away when its command runs again, and arms it otherwise', () => {
    for (const [id, name] of [
      ['tools.highlight', 'highlight'],
      ['tools.text-edit', 'text'],
      ['tools.hand', 'hand'],
    ] as const) {
      const armed = recordingHost({ activeTool: name });
      byId(buildCommands(armed.host), id).run();
      expect(armed.calls, id).toEqual([tool('select')]);
      const other = recordingHost({ activeTool: name === 'hand' ? 'ink' : 'hand' });
      byId(buildCommands(other.host), id).run();
      expect(other.calls, id).toEqual([tool(name)]);
    }
  });

  it('answers the optional host callbacks with nothing when the host has none', () => {
    const { host, calls } = recordingHost({ detectFormFields: undefined, openXfaForm: undefined });
    const commands = buildCommands(host);
    byId(commands, 'tools.form-detect').run();
    byId(commands, 'tools.xfa-fill').run();
    expect(calls).toEqual([]);
    expect(byId(commands, 'tools.form-detect').disabled).toBe(true);
  });

  it('disables document commands without a document, and edits when editing is not allowed', () => {
    const none = buildCommands(recordingHost({ hasDocument: false, canEdit: false }).host);
    for (const id of ['file.close', 'view.zoom-in', 'view.outline', 'tools.pdfa-check', 'tools.xfa-fill']) {
      expect(byId(none, id).disabled, id).toBe(true);
    }
    for (const id of ['page.split', 'tools.ocr', 'tools.impose', 'tools.measure-area']) {
      expect(byId(none, id).disabled, id).toBe(true);
    }
    // Starting a document, help and settings never need one.
    for (const id of ['file.new', 'file.open', 'help.shortcuts', 'help.palette', 'settings.open']) {
      expect(byId(none, id).disabled, id).toBeFalsy();
    }

    const viewing = buildCommands(recordingHost({ canEdit: false }).host);
    expect(byId(viewing, 'view.zoom-in').disabled).toBeFalsy();
    expect(byId(viewing, 'tools.ocr').disabled).toBe(true);
  });

  it('follows undo, redo, save and export state, the page selection and the mark selection', () => {
    const idle = buildCommands(
      recordingHost({
        canUndo: false,
        canRedo: false,
        canSave: false,
        canExport: false,
        selectedPages: [],
        selectedMarkCount: 0,
      }).host,
    );
    for (const id of [
      'edit.undo',
      'edit.redo',
      'file.save',
      'file.export',
      'page.rotate-left',
      'edit.delete-mark',
    ]) {
      expect(byId(idle, id).disabled, id).toBe(true);
    }
    const ready = buildCommands(recordingHost().host);
    for (const id of [
      'edit.undo',
      'edit.redo',
      'file.save',
      'file.export',
      'page.rotate-left',
      'edit.delete-mark',
    ]) {
      expect(byId(ready, id).disabled, id).toBeFalsy();
    }
  });

  it('checks the measure, theme and tool entries from the host state', () => {
    const commands = buildCommands(
      recordingHost({ measureMode: 'area', theme: 'dark', activeTool: 'ink' }).host,
    );
    expect(byId(commands, 'tools.measure-area').checked).toBe(true);
    expect(byId(commands, 'tools.measure-perimeter').checked).toBe(false);
    expect(byId(commands, 'settings.theme.dark').checked).toBe(true);
    expect(byId(commands, 'settings.theme.system').checked).toBe(false);
    expect(byId(commands, 'tools.ink').checked).toBe(true);
    const perimeter = buildCommands(recordingHost({ measureMode: 'perimeter', theme: 'system' }).host);
    expect(byId(perimeter, 'tools.measure-perimeter').checked).toBe(true);
    expect(byId(perimeter, 'settings.theme.system').checked).toBe(true);
  });
});

describe('interface mode filtering', () => {
  const commands = buildCommands(recordingHost().host);

  it('offers everything in the advanced mode', () => {
    expect(visibleCommands(commands, 'advanced')).toHaveLength(commands.length);
  });

  it('keeps the everyday capabilities, the way back to the advanced mode and the source link in the simple mode', () => {
    const simple = visibleCommands(commands, 'simple').map((command) => command.id);
    for (const id of [
      'file.save',
      'edit.undo',
      'tools.sign',
      'help.palette',
      'settings.open',
      'help.source',
    ]) {
      expect(simple, id).toContain(id);
    }
    for (const id of ['tools.redact', 'tools.ocr', 'file.batch', 'tools.measure-area', 'tools.pdfa']) {
      expect(simple, id).not.toContain(id);
    }
    expect(isCommandVisible(byId(commands, 'tools.redact'), 'simple')).toBe(false);
    expect(isCommandVisible(byId(commands, 'tools.redact'), 'advanced')).toBe(true);
  });

  it('names the commands that start a document without one', () => {
    expect([...STANDALONE_COMMAND_IDS].sort()).toEqual([
      'file.batch',
      'file.convert',
      'file.create-images',
      'file.merge',
      'file.new',
      'file.scan',
    ]);
  });
});

describe('commandKeywords', () => {
  it('searches by the id as words, then by the command’s own keywords', () => {
    const commands = buildCommands(recordingHost().host);
    expect(commandKeywords(byId(commands, 'file.new'))).toEqual([
      'file new',
      'new',
      'blank',
      'empty',
      'yeni',
      'bos',
      'belge',
    ]);
    // A command with no keywords of its own still has its id's words.
    expect(commandKeywords(byId(commands, 'file.open'))).toEqual(['file open']);
  });
});
