// @vitest-environment happy-dom
/**
 * The home screen's tool grid, rendered with the real tool table: which tools it lists for
 * a set of commands, when a tile is disabled, and how the search narrows the tiles.
 *
 * The translator stub renders the dictionary key, so the markup names what it shows.
 */

import { cleanup, render as mount, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import type { Command } from 'pdf-ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import HomeToolGrid from './HomeToolGrid';

const t = Object.assign((key: string) => key, { locale: 'en' as const }) as never;

function command(id: string, disabled?: boolean, keywords?: readonly string[]): Command {
  return {
    id,
    labelKey: 'tools.all',
    group: 'tools' as never,
    ...(disabled === undefined ? {} : { disabled }),
    ...(keywords === undefined ? {} : { keywords }),
    run: () => undefined,
  };
}

function render(
  commands: readonly Command[],
  activeDocumentName: string | null,
  standalone: ReadonlySet<string> = new Set(),
): string {
  return renderToStaticMarkup(
    <HomeToolGrid
      t={t}
      commands={commands}
      activeDocumentName={activeDocumentName}
      standalone={standalone}
      onRun={() => undefined}
    />,
  );
}

/** Each tile's button, with whether it is disabled. */
function tiles(markup: string): { readonly description: string; readonly disabled: boolean }[] {
  return [
    ...markup.matchAll(/<button type="button"([^>]*)>.*?<span class="mt-0\.5[^>]*>([^<]*)<\/span>/g),
  ].map((match) => ({ description: match[2] ?? '', disabled: (match[1] ?? '').includes(' disabled=""') }));
}

afterEach(cleanup);

describe('HomeToolGrid search', () => {
  const grid = (
    <HomeToolGrid
      t={t}
      commands={[command('tools.ink', undefined, ['stylus']), command('tools.ocr')]}
      activeDocumentName={null}
      standalone={new Set()}
      onRun={() => undefined}
    />
  );
  const listed = () =>
    screen.queryAllByRole('button').map((button) => button.querySelector('span.block + span')?.textContent);

  it('narrows the tiles to the tools whose description matches, ignoring case and padding', async () => {
    const user = userEvent.setup();
    mount(grid);
    expect(listed()).toEqual(['home.tool.ink', 'home.tool.ocr']);

    await user.type(screen.getByRole('searchbox'), '  OCR ');
    expect(listed()).toEqual(['home.tool.ocr']);
  });

  it('matches a command keyword the tile does not show', async () => {
    const user = userEvent.setup();
    mount(grid);

    await user.type(screen.getByRole('searchbox'), 'stylus');
    expect(listed()).toEqual(['home.tool.ink']);
  });

  it('says so when no tool matches', async () => {
    const user = userEvent.setup();
    mount(grid);

    await user.type(screen.getByRole('searchbox'), 'no such tool');
    expect(listed()).toEqual([]);
    expect(screen.getByText('home.tools.empty')).toBeTruthy();
  });
});

describe('HomeToolGrid', () => {
  it('lists only the tools whose command exists, and says so when none does', () => {
    expect(render([], null)).toContain('home.tools.empty');
    const markup = render([command('tools.ink')], null);
    expect(tiles(markup)).toEqual([{ description: 'home.tool.ink', disabled: false }]);
    expect(markup).not.toContain('home.tools.empty');
  });

  it('names the open document and keeps a disabled command disabled for it', () => {
    const open = render([command('tools.ink', true)], 'report.pdf');
    expect(open).toContain('home.tools.activeDocument');
    expect(tiles(open)).toEqual([{ description: 'home.tool.ink', disabled: true }]);
  });

  it('offers a disabled tool anyway with no document open, and a standalone one with a document', () => {
    expect(tiles(render([command('tools.ink', true)], null))).toEqual([
      { description: 'home.tool.ink', disabled: false },
    ]);
    expect(tiles(render([command('tools.ink', true)], 'report.pdf', new Set(['tools.ink'])))).toEqual([
      { description: 'home.tool.ink', disabled: false },
    ]);
  });
});

describe('HomeToolGrid tile titles', () => {
  // "…" marks a menu or palette item that opens a dialog (`cmd.findReplace.label`); the tile
  // shows the command's name, and a tile is not a menu item.
  it.each([
    ['tr', 'Bul ve değiştir…', 'Bul ve değiştir'],
    ['en', 'Find and replace…', 'Find and replace'],
  ] as const)(
    'shows the name of a command whose label ends in an ellipsis without it (%s)',
    (locale, label, shown) => {
      const words = createTranslator(locale);
      expect(words('cmd.findReplace.label')).toBe(label);
      mount(
        <HomeToolGrid
          t={words}
          commands={[{ ...command('edit.find-replace'), labelKey: 'cmd.findReplace.label' }]}
          activeDocumentName={null}
          standalone={new Set()}
          onRun={() => undefined}
        />,
      );
      expect(screen.getByRole('button').querySelector('span.block')?.textContent).toBe(shown);
    },
  );
});

describe('HomeToolGrid shapes tile', () => {
  // The shape tool draws a square, a circle and a line (`ann.tool.shape.*`); the tile must
  // not promise a shape it does not have.
  it.each([
    ['en', /rectangle.*ellipse.*line/i, /arrow/i],
    ['tr', /dikdörtgen.*elips.*çizgi/i, /\bok\b/i],
  ] as const)(
    'describes the rectangle, ellipse and line the tool draws, and no arrow (%s)',
    (locale, drawn, arrow) => {
      const words = createTranslator(locale);
      mount(
        <HomeToolGrid
          t={words}
          commands={[command('tools.shapes')]}
          activeDocumentName={null}
          standalone={new Set()}
          onRun={() => undefined}
        />,
      );
      const description = screen.getByText(words('home.tool.shapes')).textContent ?? '';
      expect(description).toMatch(drawn);
      expect(description).not.toMatch(arrow);
    },
  );
});
