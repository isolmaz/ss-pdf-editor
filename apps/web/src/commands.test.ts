/**
 * The command list: each entry must do exactly what its id says (a menu item that opens the
 * wrong dialog is invisible to every other test), be disabled for the states the host
 * reports, and be filtered by the interface mode the way the palette expects.
 */

import { createTranslator, loadLocale, type Translator } from 'pdf-shared';
import type { Command } from 'pdf-ui';
import type { CanvasToolId } from 'pdf-ui/tools';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildCommands,
  type CommandHost,
  commandKeywords,
  isCommandVisible,
  MENU_SECTIONS,
  menuCommands,
  SOURCE_URL,
  STANDALONE_COMMAND_IDS,
  visibleCommands,
} from './commands';
import { HOME_TOOLS } from './components/HomeToolGrid';

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
    hasDocument: true,
    canEdit: true,
    canUndo: true,
    canRedo: true,
    canSave: true,
    canExport: true,
    selectedPages: [0],
    zoom: () => 1,
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
    purgeActiveDocument: rec('purgeActiveDocument'),
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
  'view.zoom-in': ['setZoom', 1.1],
  'view.zoom-out': ['setZoom', 0.9],
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
  'page.organize': ['openLeftTab', 'pages'],
  'page.extract': dialog('extract-pages'),
  'page.insert': dialog('insert-pages'),
  'page.replace': dialog('replace-pages'),
  'page.split': dialog('split'),
  'page.reverse': ['pageAction', { kind: 'reverse' }],
  'page.remove-blank': dialog('remove-blank-pages'),
  'page.split-two-up': dialog('split-two-up'),
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
  'settings.purge-document': ['purgeActiveDocument'],
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

  describe('in each language', () => {
    beforeAll(async () => {
      await loadLocale('tr');
      await loadLocale('en');
    });

    it.each(['tr', 'en'] as const)('gives no two commands of a menu the same %s label', (locale) => {
      const translate = createTranslator(locale);
      const commands = buildCommands(recordingHost({ t: translate }).host);
      const seen = new Map<string, string>();
      for (const command of commands) {
        const key = `${command.group}/${translate(command.labelKey)}`;
        expect(seen.get(key), `${command.id} repeats the label of ${seen.get(key)}`).toBeUndefined();
        seen.set(key, command.id);
      }
    });

    it.each(['tr', 'en'] as const)('never prints a command shortcut inside its %s label', (locale) => {
      const translate = createTranslator(locale);
      const commands = buildCommands(recordingHost({ t: translate }).host);
      const withShortcut = commands.filter((command) => command.shortcut !== undefined);
      // The Help menu's palette entry is the one that used to read "Komut ara (Ctrl+K) Ctrl+K".
      expect(withShortcut.map((command) => command.id)).toContain('help.palette');
      for (const command of withShortcut) {
        const label = translate(command.labelKey);
        expect(label, command.id).not.toMatch(/Ctrl|⌘|Alt\+|Shift\+/);
        const shortcut = command.shortcut as string;
        // A single tool letter is a substring of many labels ("Hand"), so for it the printed form
        // that matters is the parenthesised one the rail tooltip uses.
        expect(label, command.id).not.toContain(shortcut.length === 1 ? `(${shortcut})` : shortcut);
      }
      expect(translate(byId(commands, 'help.palette').labelKey)).toBe(
        locale === 'tr' ? 'Komut ara' : 'Search commands',
      );
    });

    it.each(['tr', 'en'] as const)(
      'tells more in a home tile description than its %s title says',
      (locale) => {
        const translate = createTranslator(locale);
        const commands = buildCommands(recordingHost({ t: translate }).host);
        // A description that only repeats its title says nothing: every long word of the title is
        // in it, compared by its first four letters so that "çizim" and "çizin" count as one.
        const stems = (text: string) =>
          text
            .toLocaleLowerCase(locale)
            .split(/[^\p{L}\p{N}]+/u)
            .filter((word) => word.length > 3)
            .map((word) => word.slice(0, 4));
        const repeated = HOME_TOOLS.filter((tool) => {
          const title = stems(translate(byId(commands, tool.id).labelKey));
          const description = new Set(stems(translate(tool.descriptionKey)));
          return title.length > 0 && title.every((stem) => description.has(stem));
        }).map((tool) => tool.id);
        expect(repeated).toEqual([]);
      },
    );

    it('lays out the page panel, merge and batch as home tiles that run their own command', () => {
      const { host, calls } = recordingHost();
      const commands = buildCommands(host);
      const tiles = HOME_TOOLS.filter((tool) =>
        ['page.organize', 'file.merge', 'file.batch'].includes(tool.id),
      );
      expect(tiles.map((tool) => tool.id)).toEqual(['page.organize', 'file.merge', 'file.batch']);
      for (const tool of tiles) byId(commands, tool.id).run();
      expect(calls).toEqual([['openLeftTab', 'pages'], ['openDialog', 'merge-files'], ['openBatch']]);
    });

    it('names the three zoom entries by what each one does', () => {
      const labels = (locale: 'tr' | 'en') => {
        const translate = createTranslator(locale);
        const commands = buildCommands(recordingHost().host);
        return ['view.zoom-in', 'view.zoom-out', 'view.zoom-reset'].map((id) =>
          translate(byId(commands, id).labelKey),
        );
      };
      expect(labels('tr')).toEqual(['Yakınlaştır', 'Uzaklaştır', 'Gerçek boyut (%100)']);
      expect(labels('en')).toEqual(['Zoom in', 'Zoom out', 'Actual size (100%)']);
    });
  });

  it('opens the source repository in a new tab without handing it the opener', () => {
    const opened: unknown[][] = [];
    vi.stubGlobal('window', { open: (...args: unknown[]) => opened.push(args) });
    byId(buildCommands(recordingHost().host), 'help.source').run();
    expect(opened).toEqual([[SOURCE_URL, '_blank', 'noopener,noreferrer']]);
  });

  it('zooms in and out to the standard stops, never past 400% or under 25%', () => {
    const zoomed = (id: string, zoom: number) => {
      const { host, calls } = recordingHost({ zoom: () => zoom });
      byId(buildCommands(host), id).run();
      return calls[0]?.[1];
    };
    expect(zoomed('view.zoom-in', 0.65)).toBe(0.67);
    expect(zoomed('view.zoom-in', 0.9)).toBe(1);
    expect(zoomed('view.zoom-out', 1)).toBe(0.9);
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
    for (const id of [
      'file.close',
      'view.zoom-in',
      'view.outline',
      'page.organize',
      'tools.pdfa-check',
      'tools.xfa-fill',
    ]) {
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
    // Redaction rewrites the file: a protected (read-only) tab refuses it from the palette
    // exactly as the toolbar does.
    expect(byId(viewing, 'tools.redact').disabled).toBe(true);
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
      'edit.delete-mark',
      'edit.clear-selection',
    ]) {
      expect(byId(idle, id).disabled, id).toBe(true);
    }
    const ready = buildCommands(recordingHost().host);
    for (const id of [
      'edit.undo',
      'edit.redo',
      'file.save',
      'file.export',
      'edit.delete-mark',
      'edit.clear-selection',
    ]) {
      expect(byId(ready, id).disabled, id).toBeFalsy();
    }
  });

  it('keeps the page commands available with no page selected, so they act on the page on screen', () => {
    const ids = [
      'page.rotate-left',
      'page.rotate-right',
      'page.duplicate',
      'page.delete',
      'page.extract',
      'page.replace',
      'page.reverse',
      'page.remove-blank',
      'page.split-two-up',
    ];
    const unselected = buildCommands(recordingHost({ selectedPages: [] }).host);
    for (const id of ids) {
      expect(byId(unselected, id).disabled, id).toBeFalsy();
    }
    // Editing not being allowed still turns them off.
    const viewing = buildCommands(recordingHost({ selectedPages: [], canEdit: false }).host);
    for (const id of ids) {
      expect(byId(viewing, id).disabled, id).toBe(true);
    }
    const { host, calls } = recordingHost({ selectedPages: [] });
    byId(buildCommands(host), 'page.rotate-left').run();
    expect(calls).toEqual([['pageAction', { kind: 'rotate', direction: 'left' }]]);
  });

  it('labels the three measurements as commands that say they measure', () => {
    const commands = buildCommands(recordingHost().host);
    expect(
      ['tools.measure-distance', 'tools.measure-perimeter', 'tools.measure-area'].map(
        (id) => byId(commands, id).labelKey,
      ),
    ).toEqual(['cmd.measureDistance.label', 'cmd.measurePerimeter.label', 'cmd.measureArea.label']);
  });

  it('says why a command is unavailable: no document, no right to edit, nothing selected', () => {
    const reason = (commands: readonly Command[], id: string) => byId(commands, id).disabledReason;
    const none = buildCommands(recordingHost({ hasDocument: false, canEdit: false }).host);
    for (const id of [
      'page.organize',
      'page.rotate-left',
      'edit.rename',
      'edit.find-replace',
      'edit.select-all-pages',
    ]) {
      expect(reason(none, id), id).toBe('cmd.reason.noDocument');
    }
    const viewing = buildCommands(recordingHost({ canEdit: false }).host);
    expect(reason(viewing, 'page.delete')).toBe('cmd.reason.cannotEdit');
    expect(reason(viewing, 'edit.find-replace')).toBe('cmd.reason.cannotEdit');
    expect(reason(viewing, 'edit.clear-selection')).toBe('cmd.reason.cannotEdit');
    expect(reason(viewing, 'edit.delete-mark')).toBe('cmd.reason.cannotEdit');
    expect(reason(viewing, 'tools.form-detect')).toBe('cmd.reason.cannotEdit');

    const idle = buildCommands(
      recordingHost({
        canUndo: false,
        canRedo: false,
        selectedPages: [],
        selectedMarkCount: 0,
        activeTool: 'ink',
      }).host,
    );
    expect(reason(idle, 'edit.undo')).toBe('cmd.reason.nothingToUndo');
    expect(reason(idle, 'edit.redo')).toBe('cmd.reason.nothingToRedo');
    expect(reason(idle, 'edit.clear-selection')).toBe('cmd.reason.noPages');
    expect(reason(idle, 'edit.delete-mark')).toBe('cmd.reason.noMarks');
    expect(reason(idle, 'edit.select-all-marks')).toBe('cmd.reason.selectTool');
    expect(reason(none, 'edit.select-all-marks')).toBe('cmd.reason.noDocument');

    // An available command that needs a document or the right to edit carries no reason, and
    // neither does a disabled one with no reason to give.
    const ready = buildCommands(recordingHost().host);
    for (const id of ['edit.undo', 'edit.redo', 'page.delete', 'edit.rename']) {
      expect(reason(ready, id), id).toBeUndefined();
    }
    const noDetect = buildCommands(recordingHost({ detectFormFields: undefined }).host);
    expect(byId(noDetect, 'tools.form-detect').disabled).toBe(true);
    expect(reason(noDetect, 'tools.form-detect')).toBeUndefined();
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

describe('menu layout', () => {
  const commands = buildCommands(recordingHost().host);

  it('places every command in a section, and no section names a command nothing builds', () => {
    const laid = MENU_SECTIONS.flat();
    expect(new Set(laid).size).toBe(laid.length);
    expect([...laid].sort()).toEqual(commands.map((command) => command.id).sort());
    for (const command of commands) {
      expect(command.section, command.id).toBe(MENU_SECTIONS.findIndex((ids) => ids.includes(command.id)));
    }
  });

  it('lists the commands in menu order, one group after another, a section never split', () => {
    expect(commands.map((command) => command.id)).toEqual(MENU_SECTIONS.flat());
    const groups = commands.map((command) => command.group);
    expect(groups).toEqual([...groups].sort((a, b) => groups.indexOf(a) - groups.indexOf(b)));
    for (const ids of MENU_SECTIONS) {
      expect(new Set(ids.map((id) => byId(commands, id).group)).size, ids.join()).toBe(1);
    }
    expect(groups.filter((group, index) => group !== groups[index - 1])).toEqual([
      'file',
      'edit',
      'view',
      'page',
      'tools',
      'settings',
      'help',
    ]);
  });

  it('keeps the settings entry out of the simple mode menu, where the header button is its twin', () => {
    const ids = (mode: 'simple' | 'advanced') => menuCommands(commands, mode).map((command) => command.id);
    expect(ids('simple')).not.toContain('settings.open');
    expect(menuCommands(commands, 'simple').some((command) => command.group === 'settings')).toBe(false);
    // The palette still offers it, and the advanced menu has more in the group.
    expect(visibleCommands(commands, 'simple').map((command) => command.id)).toContain('settings.open');
    expect(ids('advanced')).toContain('settings.open');
    expect(ids('advanced')).toHaveLength(commands.length);
    expect(ids('simple')).toHaveLength(visibleCommands(commands, 'simple').length - 1);
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
    // Bates numbering and watermarks are the `stamp` group, which the simple mode's rail hides
    // (`SIMPLE_MODE_RAIL_GROUPS`): the menus and the palette agree with it.
    for (const id of [
      'tools.redact',
      'tools.ocr',
      'file.batch',
      'tools.measure-area',
      'tools.pdfa',
      'tools.numbering',
      'tools.watermark',
    ]) {
      expect(simple, id).not.toContain(id);
      expect(isCommandVisible(byId(commands, id), 'advanced'), id).toBe(true);
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
